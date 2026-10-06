//! Three real nodes over loopback sockets: gossip join, graceful leave, and
//! crash detection, observed through each node's `/v1/status`.

use std::net::SocketAddr;
use std::sync::Arc;
use std::time::{Duration, Instant};

use celeris_server::config::SyncSetting;
use celeris_server::{Config, Node, serve};
use serde_json::{Value, json};
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::TcpListener;
use tokio::sync::oneshot;
use tokio::task::JoinHandle;

/// Each test runs three or more nodes with tight timeouts; running every
/// test at once overloads small machines and CI runners, so at most a few
/// run concurrently.
static SLOTS: tokio::sync::Semaphore = tokio::sync::Semaphore::const_new(3);

struct RunningNode {
    http: SocketAddr,
    cluster: SocketAddr,
    stop: Option<oneshot::Sender<()>>,
    task: JoinHandle<anyhow::Result<()>>,
    _dir: tempfile::TempDir,
}

async fn start(seed: Option<SocketAddr>) -> RunningNode {
    start_voter(seed, None, &[]).await
}

async fn start_voter(seed: Option<SocketAddr>, id: Option<&str>, voters: &[&str]) -> RunningNode {
    start_with(test_config(seed, id, voters)).await
}

async fn start_with(config: Config) -> RunningNode {
    let http_listener = TcpListener::bind("127.0.0.1:0").await.expect("bind http");
    let cluster_listener = TcpListener::bind("127.0.0.1:0")
        .await
        .expect("bind cluster");
    launch(
        tempfile::tempdir().expect("tempdir"),
        config,
        http_listener,
        cluster_listener,
    )
    .await
}

fn test_config(seed: Option<SocketAddr>, id: Option<&str>, voters: &[&str]) -> Config {
    let mut config = Config::default();
    config.node.id = id.map(String::from);
    config.storage.sync = SyncSetting::Never;
    config.cluster.listen = Some("127.0.0.1:0".into());
    config.cluster.seeds = seed.map(|s| s.to_string()).into_iter().collect();
    config.cluster.heartbeat_interval_ms = 50;
    config.cluster.suspect_after_ms = 300;
    config.cluster.suspicion_timeout_ms = 600;
    config.cluster.voters = voters.iter().map(|v| (*v).to_owned()).collect();
    config.cluster.raft_election_timeout_ms = 150;
    config.cluster.raft_heartbeat_ms = 30;
    // Tests place partitions explicitly unless they test the bootstrap.
    config.cluster.replication_factor = 0;
    config
}

async fn launch(
    dir: tempfile::TempDir,
    mut config: Config,
    http_listener: TcpListener,
    cluster_listener: TcpListener,
) -> RunningNode {
    config.node.data_dir = dir.path().to_path_buf();
    config.validate().expect("valid config");
    let http = http_listener.local_addr().expect("addr");
    let cluster = cluster_listener.local_addr().expect("addr");
    // After a simulated crash the previous instance may take a moment to
    // release its storage locks.
    let deadline = Instant::now() + Duration::from_secs(10);
    let node = loop {
        let config = config.clone();
        let opened = tokio::task::spawn_blocking(move || {
            Node::open(&config, http.to_string(), Some(cluster))
        })
        .await
        .expect("join");
        match opened {
            Ok(node) => break node,
            Err(e) if Instant::now() < deadline => {
                let _ = e;
                tokio::time::sleep(Duration::from_millis(100)).await;
            }
            Err(e) => panic!("open: {e:#}"),
        }
    };
    let (stop, stopped) = oneshot::channel::<()>();
    let task = tokio::spawn(serve(
        Arc::new(node),
        http_listener,
        Some(cluster_listener),
        async {
            let _ = stopped.await;
        },
    ));
    RunningNode {
        http,
        cluster,
        stop: Some(stop),
        task,
        _dir: dir,
    }
}

async fn get(addr: SocketAddr, path: &str) -> String {
    let mut stream = tokio::net::TcpStream::connect(addr).await.expect("connect");
    let request = format!("GET {path} HTTP/1.1\r\nHost: x\r\nConnection: close\r\n\r\n");
    stream.write_all(request.as_bytes()).await.expect("send");
    let mut raw = String::new();
    stream.read_to_string(&mut raw).await.expect("read");
    raw.split("\r\n\r\n").nth(1).expect("body").to_owned()
}

async fn status(addr: SocketAddr) -> Value {
    serde_json::from_str(&get(addr, "/v1/status").await).expect("json")
}

/// (cluster address, state) of every member in `observer`'s view, sorted.
async fn view(observer: SocketAddr) -> Vec<(String, String)> {
    let s = status(observer).await;
    let mut v: Vec<(String, String)> = s["cluster"]["nodes"]
        .as_array()
        .expect("nodes")
        .iter()
        .map(|n| {
            (
                n["address"].as_str().expect("addr").to_owned(),
                n["state"].as_str().expect("state").to_owned(),
            )
        })
        .collect();
    v.sort();
    v
}

async fn wait_until(what: &str, check: impl AsyncFnMut() -> bool) {
    wait_up_to(Duration::from_secs(15), what, check).await;
}

async fn wait_up_to(limit: Duration, what: &str, mut check: impl AsyncFnMut() -> bool) {
    let deadline = Instant::now() + limit;
    while Instant::now() < deadline {
        if check().await {
            return;
        }
        tokio::time::sleep(Duration::from_millis(50)).await;
    }
    panic!("timed out waiting for: {what}");
}

fn states(entries: &[(&RunningNode, &str)]) -> Vec<(String, String)> {
    let mut v: Vec<(String, String)> = entries
        .iter()
        .map(|(n, s)| (n.cluster.to_string(), (*s).to_owned()))
        .collect();
    v.sort();
    v
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn three_nodes_join_leave_and_detect_a_crash() {
    let _slot = SLOTS.acquire().await.expect("test slots");
    let a = start(None).await;
    let mut b = start(Some(a.cluster)).await;
    let c = start(Some(a.cluster)).await;

    let all_alive = states(&[(&a, "alive"), (&b, "alive"), (&c, "alive")]);
    for observer in [a.http, b.http, c.http] {
        wait_until("every node sees three alive members", async || {
            view(observer).await == all_alive
        })
        .await;
    }
    let s = status(a.http).await;
    assert_eq!(s["cluster"]["mode"], "gossip");
    let selves = s["cluster"]["nodes"]
        .as_array()
        .map(|n| n.iter().filter(|m| m["self"] == true).count());
    assert_eq!(selves, Some(1));

    // Graceful leave: b announces its departure while shutting down.
    if let Some(stop) = b.stop.take() {
        let _ = stop.send(());
    }
    tokio::time::timeout(Duration::from_secs(10), &mut b.task)
        .await
        .expect("b stops")
        .expect("join")
        .expect("serve ok");
    let after_leave = states(&[(&a, "alive"), (&b, "left"), (&c, "alive")]);
    for observer in [a.http, c.http] {
        wait_until("survivors see b as left", async || {
            view(observer).await == after_leave
        })
        .await;
    }

    // Crash: c stops abruptly without leaving. Silence becomes suspicion,
    // then unreachable; it is never reported as left.
    c.task.abort();
    let after_crash = states(&[(&a, "alive"), (&b, "left"), (&c, "unreachable")]);
    wait_until("a marks c unreachable", async || {
        view(a.http).await == after_crash
    })
    .await;
    let metrics = get(a.http, "/metrics").await;
    assert!(
        metrics.contains("celeris_cluster_members{state=\"unreachable\"} 1"),
        "{metrics}"
    );
    assert!(metrics.contains("celeris_cluster_members{state=\"left\"} 1"));
    a.task.abort();
}

async fn post(addr: SocketAddr, path: &str, body: &str) -> (u16, Value) {
    let mut stream = tokio::net::TcpStream::connect(addr).await.expect("connect");
    let request = format!(
        "POST {path} HTTP/1.1\r\nHost: x\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}",
        body.len()
    );
    stream.write_all(request.as_bytes()).await.expect("send");
    let mut raw = String::new();
    stream.read_to_string(&mut raw).await.expect("read");
    let status = raw
        .split_whitespace()
        .nth(1)
        .and_then(|s| s.parse().ok())
        .expect("status");
    let body = raw.split("\r\n\r\n").nth(1).unwrap_or("null");
    (status, serde_json::from_str(body).unwrap_or(Value::Null))
}

/// Sends a request; returns (status, JSON body, raw response head).
async fn request(
    addr: SocketAddr,
    method: &str,
    path: &str,
    headers: &[(&str, &str)],
    body: &str,
) -> (u16, Value, String) {
    let mut stream = tokio::net::TcpStream::connect(addr).await.expect("connect");
    let mut head = format!(
        "{method} {path} HTTP/1.1\r\nHost: x\r\nContent-Length: {}\r\nConnection: close\r\n",
        body.len()
    );
    for (k, v) in headers {
        head.push_str(&format!("{k}: {v}\r\n"));
    }
    stream
        .write_all(format!("{head}\r\n{body}").as_bytes())
        .await
        .expect("send");
    let mut raw = String::new();
    stream.read_to_string(&mut raw).await.expect("read");
    let status = raw
        .split_whitespace()
        .nth(1)
        .and_then(|s| s.parse().ok())
        .expect("status");
    let (head, body) = raw.split_once("\r\n\r\n").unwrap_or((&raw, ""));
    (
        status,
        serde_json::from_str(body).unwrap_or(Value::Null),
        head.to_lowercase(),
    )
}

fn header(head: &str, name: &str) -> Option<String> {
    head.lines()
        .find_map(|l| l.strip_prefix(&format!("{name}: ")).map(str::to_owned))
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn replicated_writes_survive_leader_failure() {
    let _slot = SLOTS.acquire().await.expect("test slots");
    let voters = ["ra", "rb", "rc"];
    let a = start_voter(None, Some("ra"), &voters).await;
    let b = start_voter(Some(a.cluster), Some("rb"), &voters).await;
    let c = start_voter(Some(a.cluster), Some("rc"), &voters).await;
    let nodes = [&a, &b, &c];
    let all_alive = states(&[(&a, "alive"), (&b, "alive"), (&c, "alive")]);
    for n in nodes {
        wait_until("membership converges", async || {
            view(n.http).await == all_alive
        })
        .await;
    }

    // Before a map is committed, cluster data requests are refused.
    let (code, body, _) = request(a.http, "PUT", "/v1/kv/early", &[], "1").await;
    assert_eq!(code, 503, "{body}");
    assert_eq!(body["error"]["code"], "no_partition_map");

    // Commit an RF=3 map through the control-plane leader.
    wait_until("a control leader accepts the rebalance", async || {
        for n in nodes {
            if post(n.http, "/v1/admin/rebalance", r#"{"replication_factor":3}"#)
                .await
                .0
                == 202
            {
                return true;
            }
        }
        false
    })
    .await;

    // Exactly one node (the group leader) accepts writes; others redirect.
    let mut leader_http = None;
    let mut session = String::new();
    let mut version = Value::Null;
    wait_until("the group leader accepts a write", async || {
        for n in nodes {
            let (code, body, head) = request(
                n.http,
                "PUT",
                "/v1/kv/users/1",
                &[(
                    "celeris-mutation-id",
                    "7a3b0c3e-5d55-4c11-9f0e-2a7b9f000001",
                )],
                r#"{"v":1}"#,
            )
            .await;
            if code == 200 {
                leader_http = Some(n.http);
                session = header(&head, "celeris-session-index").expect("session header");
                version = body["version"].clone();
                return true;
            }
        }
        false
    })
    .await;
    let leader_http = leader_http.expect("leader");

    for n in nodes {
        // Eventual reads converge on every replica, with identical versions.
        wait_until("replica applies the write", async || {
            let (code, body, _) = request(
                n.http,
                "GET",
                "/v1/kv/users/1?consistency=eventual",
                &[],
                "",
            )
            .await;
            code == 200 && body["value"]["v"] == 1 && body["version"] == version
        })
        .await;
        // Session reads honour the token.
        let (code, _, _) = request(
            n.http,
            "GET",
            "/v1/kv/users/1?consistency=session",
            &[("celeris-session-index", &session)],
            "",
        )
        .await;
        assert_eq!(code, 200);
        if n.http != leader_http {
            let (code, body, _) = request(n.http, "GET", "/v1/kv/users/1", &[], "").await;
            assert_eq!(code, 421, "strict reads only on the leader: {body}");
            assert_eq!(body["error"]["code"], "not_leader");
        }
    }
    let (code, body, _) = request(leader_http, "GET", "/v1/kv/users/1", &[], "").await;
    assert_eq!((code, body["value"]["v"].clone()), (200, Value::from(1)));

    // Kill the leader: a new one is elected and the committed write survives.
    let old = nodes
        .iter()
        .find(|n| n.http == leader_http)
        .expect("leader node");
    old.task.abort();
    let survivors: Vec<&&RunningNode> = nodes.iter().filter(|n| n.http != leader_http).collect();
    let mut new_leader = None;
    wait_until("a surviving replica becomes leader", async || {
        for n in &survivors {
            let (code, _, _) = request(n.http, "GET", "/v1/kv/users/1", &[], "").await;
            if code == 200 {
                new_leader = Some(n.http);
                return true;
            }
        }
        false
    })
    .await;
    let new_leader = new_leader.expect("new leader");
    let (code, body, _) = request(new_leader, "GET", "/v1/kv/users/1", &[], "").await;
    assert_eq!(
        (code, body["value"]["v"].clone(), body["version"].clone()),
        (200, Value::from(1), version)
    );
    // A retry of the original mutation is deduplicated by the new leader.
    let (code, body, _) = request(
        new_leader,
        "PUT",
        "/v1/kv/users/1",
        &[(
            "celeris-mutation-id",
            "7a3b0c3e-5d55-4c11-9f0e-2a7b9f000001",
        )],
        r#"{"v":1}"#,
    )
    .await;
    assert_eq!(code, 200, "{body}");
    assert_eq!(body["deduplicated"], true);
    for n in survivors {
        n.task.abort();
    }
}

/// Writes through whichever node leads the key's group, retrying like a
/// client would on redirects and on proposals that were not applied.
async fn put_anywhere(nodes: &[SocketAddr], key: &str, body: &str) -> (SocketAddr, Value) {
    let deadline = Instant::now() + Duration::from_secs(15);
    // One mutation ID for all attempts, so a retry after an unknown
    // outcome can never apply the write twice.
    let id = uuid::Uuid::new_v4().to_string();
    loop {
        for &n in nodes {
            let (code, resp, _) = request(
                n,
                "PUT",
                &format!("/v1/kv/{key}"),
                &[("celeris-mutation-id", &id)],
                body,
            )
            .await;
            match code {
                200 => return (n, resp),
                421 | 503 => {}
                _ if resp["error"]["code"] == "outcome_unknown" => {}
                _ => panic!("write to {key}: {code} {resp}"),
            }
        }
        assert!(
            Instant::now() < deadline,
            "no node accepted the write to {key}"
        );
        tokio::time::sleep(Duration::from_millis(50)).await;
    }
}

/// Crashes `node` (no graceful leave) and starts it again on the same
/// addresses and data directory.
async fn crash_and_restart(node: RunningNode, config: Config) -> RunningNode {
    node.task.abort();
    let _ = node.task.await;
    let bind = async |addr: SocketAddr| {
        let deadline = Instant::now() + Duration::from_secs(10);
        loop {
            match TcpListener::bind(addr).await {
                Ok(l) => return l,
                Err(e) if Instant::now() < deadline => {
                    let _ = e;
                    tokio::time::sleep(Duration::from_millis(100)).await;
                }
                Err(e) => panic!("rebinding {addr}: {e}"),
            }
        }
    };
    let http = bind(node.http).await;
    let cluster = bind(node.cluster).await;
    launch(node._dir, config, http, cluster).await
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn a_lagging_replica_catches_up_from_a_snapshot() {
    let _slot = SLOTS.acquire().await.expect("test slots");
    let _ = tracing_subscriber::fmt()
        .with_test_writer()
        .with_max_level(tracing::Level::WARN)
        .try_init();
    let voters = ["sa", "sb", "sc"];
    let config = |seed: Option<SocketAddr>, id: &str| {
        let mut c = test_config(seed, Some(id), &voters);
        c.cluster.snapshot_threshold = 8;
        c
    };
    let launch_new = async |seed: Option<SocketAddr>, id: &str| {
        let http = TcpListener::bind("127.0.0.1:0").await.expect("bind");
        let cluster = TcpListener::bind("127.0.0.1:0").await.expect("bind");
        launch(
            tempfile::tempdir().expect("tempdir"),
            config(seed, id),
            http,
            cluster,
        )
        .await
    };
    let a = launch_new(None, "sa").await;
    let b = launch_new(Some(a.cluster), "sb").await;
    let c = launch_new(Some(a.cluster), "sc").await;
    let all_alive = states(&[(&a, "alive"), (&b, "alive"), (&c, "alive")]);
    for n in [&a, &b, &c] {
        wait_until("membership converges", async || {
            view(n.http).await == all_alive
        })
        .await;
    }
    wait_until("a control leader accepts the rebalance", async || {
        for n in [&a, &b, &c] {
            if post(n.http, "/v1/admin/rebalance", r#"{"replication_factor":3}"#)
                .await
                .0
                == 202
            {
                return true;
            }
        }
        false
    })
    .await;
    let all = [a.http, b.http, c.http];
    put_anywhere(&all, "k0", "0").await;
    // A value near the 4 MiB limit replicates (its Raft append is larger
    // than the value itself).
    let big = format!("\"{}\"", "x".repeat(4 * 1024 * 1024 - 16));
    let (leader_http, _) = put_anywhere(&all, "big", &big).await;

    // Crash a follower, then commit enough writes that the leader compacts
    // away the entries the follower is missing.
    let mut nodes = vec![("sa", a), ("sb", b), ("sc", c)];
    let lagging_at = nodes
        .iter()
        .position(|(_, n)| n.http != leader_http)
        .expect("follower");
    let (lagging_id, lagging) = nodes.remove(lagging_at);
    lagging.task.abort();
    let survivors: Vec<SocketAddr> = nodes.iter().map(|(_, n)| n.http).collect();
    let mut version = Value::Null;
    for i in 1..=30 {
        let (_, body) = put_anywhere(&survivors, &format!("k{i}"), &i.to_string()).await;
        version = body["version"].clone();
    }

    let restarted = crash_and_restart(lagging, config(Some(nodes[0].1.cluster), lagging_id)).await;
    wait_up_to(
        Duration::from_secs(40),
        "the restarted replica catches up",
        async || {
            let (code, body, _) = request(
                restarted.http,
                "GET",
                "/v1/kv/k30?consistency=eventual",
                &[],
                "",
            )
            .await;
            code == 200 && body["value"] == 30 && body["version"] == version
        },
    )
    .await;
    let (code, body, _) = request(
        restarted.http,
        "GET",
        "/v1/kv/k0?consistency=eventual",
        &[],
        "",
    )
    .await;
    assert_eq!(
        (code, body["value"].clone()),
        (200, Value::from(0)),
        "{body}"
    );
    let (code, body, _) = request(
        restarted.http,
        "GET",
        "/v1/kv/big?consistency=eventual",
        &[],
        "",
    )
    .await;
    assert_eq!(code, 200);
    assert_eq!(
        body["value"].as_str().map(str::len),
        Some(4 * 1024 * 1024 - 16)
    );
    assert!(
        restarted
            ._dir
            .path()
            .join("groups")
            .join("sa+sb+sc")
            .join("ACTIVE_STORAGE")
            .exists(),
        "caught up by installing a snapshot, not by replaying the log"
    );
    restarted.task.abort();
    for (_, n) in nodes {
        n.task.abort();
    }
}

/// Strict read through whichever node serves the key, retrying redirects
/// and transient unavailability. Returns (status, body).
async fn get_anywhere(nodes: &[SocketAddr], key: &str) -> (u16, Value) {
    let deadline = Instant::now() + Duration::from_secs(15);
    loop {
        for &n in nodes {
            let (code, body, _) = request(n, "GET", &format!("/v1/kv/{key}"), &[], "").await;
            if code != 421 && code != 503 {
                return (code, body);
            }
        }
        assert!(Instant::now() < deadline, "no node served {key}");
        tokio::time::sleep(Duration::from_millis(50)).await;
    }
}

async fn running_migrations(n: SocketAddr) -> u64 {
    status(n).await["control"]["migrations"]["running"]
        .as_u64()
        .unwrap_or(u64::MAX)
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn partitions_move_with_their_data_when_placement_changes() {
    let _slot = SLOTS.acquire().await.expect("test slots");
    let voters = ["ma", "mb", "mc"];
    let a = start_voter(None, Some("ma"), &voters).await;
    let b = start_voter(Some(a.cluster), Some("mb"), &voters).await;
    let c = start_voter(Some(a.cluster), Some("mc"), &voters).await;
    let all = [a.http, b.http, c.http];
    let alive = states(&[(&a, "alive"), (&b, "alive"), (&c, "alive")]);
    for n in all {
        wait_until("membership converges", async || view(n).await == alive).await;
    }
    let rebalance = async |rf: u8| {
        wait_until("a control leader accepts the rebalance", async || {
            for n in all {
                let body = format!(r#"{{"replication_factor":{rf}}}"#);
                if post(n, "/v1/admin/rebalance", &body).await.0 == 202 {
                    return true;
                }
            }
            false
        })
        .await;
    };

    // RF=2: three groups of two. Spread keys over all of them.
    rebalance(2).await;
    for i in 0..40 {
        put_anywhere(&all, &format!("m{i}"), &i.to_string()).await;
    }
    // Each node holds two of the three groups; scans gather from all.
    for n in all {
        let (code, body, _) = request(n, "GET", "/v1/scan?prefix=m&limit=1000", &[], "").await;
        assert_eq!(code, 200, "{body}");
        assert_eq!(body["items"].as_array().map(Vec::len), Some(40), "{body}");
        assert_eq!(body["partial"], false);
    }
    // Filtered queries run on every group. A tiny scan budget makes groups
    // stop at different keys; paging must still return every match once.
    for i in 0..40 {
        let doc = format!(r#"{{"n":{i},"even":{}}}"#, i % 2 == 0);
        put_anywhere(&all, &format!("q{i:02}"), &doc).await;
    }
    let mut found = Vec::new();
    let mut after: Option<String> = None;
    let mut pages = 0;
    loop {
        let mut body = json!({
            "prefix": "q",
            "where": {"even": true, "n": {"$gte": 4}},
            "fields": ["n"],
            "limit": 3,
            "max_scanned": 5,
        });
        if let Some(a) = &after {
            body["after"] = json!(a);
        }
        let (code, page, _) = request(
            c.http,
            "POST",
            "/v1/query",
            &[("content-type", "application/json")],
            &body.to_string(),
        )
        .await;
        assert_eq!(code, 200, "{page}");
        assert_eq!(page["partial"], false);
        for item in page["items"].as_array().expect("items") {
            assert_eq!(item["value"].as_object().map(|o| o.len()), Some(1));
            found.push(item["key"].as_str().expect("key").to_owned());
        }
        pages += 1;
        assert!(pages < 200, "query paging does not terminate");
        match page["next_cursor"].as_str() {
            Some(cursor) => after = Some(cursor.to_owned()),
            None => break,
        }
    }
    let expected: Vec<String> = (4..40).step_by(2).map(|i| format!("q{i:02}")).collect();
    assert_eq!(found, expected);

    // RF=3 changes every replica set, so every partition migrates into the
    // single three-node group. Writes during the move are retried by the
    // client until they land.
    rebalance(3).await;
    for i in 40..50 {
        put_anywhere(&all, &format!("m{i}"), &i.to_string()).await;
    }
    for n in all {
        wait_up_to(Duration::from_secs(40), "migrations finish", async || {
            running_migrations(n).await == 0
        })
        .await;
    }
    for i in 0..50 {
        let (code, body) = get_anywhere(&all, &format!("m{i}")).await;
        assert_eq!((code, body["value"].clone()), (200, Value::from(i)), "m{i}");
    }
    // Now every node holds every key.
    for n in all {
        let (code, body, _) = request(n, "GET", "/v1/kv/m7?consistency=eventual", &[], "").await;
        assert_eq!((code, body["value"].clone()), (200, Value::from(7)));
    }
    // A cluster-wide scan pages through every group's data in key order.
    let mut keys = Vec::new();
    let mut after: Option<String> = None;
    loop {
        let path = match &after {
            Some(a) => format!("/v1/scan?prefix=m&limit=20&after={a}"),
            None => "/v1/scan?prefix=m&limit=20".to_owned(),
        };
        let (code, body, _) = request(b.http, "GET", &path, &[], "").await;
        assert_eq!(code, 200, "{body}");
        assert_eq!(body["partial"], false);
        for item in body["items"].as_array().expect("items") {
            keys.push(item["key"].as_str().expect("key").to_owned());
        }
        match body["next_cursor"].as_str() {
            Some(c) => after = Some(c.to_owned()),
            None => break,
        }
    }
    let mut expected: Vec<String> = (0..50).map(|i| format!("m{i}")).collect();
    expected.sort();
    assert_eq!(keys, expected);
    let (code, body, _) = request(
        c.http,
        "GET",
        "/v1/scan?prefix=m&limit=500&consistency=eventual",
        &[],
        "",
    )
    .await;
    assert_eq!(code, 200, "{body}");
    assert_eq!(body["items"].as_array().map(Vec::len), Some(50));

    // And the next placement change is accepted again.
    let (code, body) = post(a.http, "/v1/admin/rebalance", r#"{"replication_factor":3}"#).await;
    assert!(code == 202 || code == 409, "{code} {body}");
    assert_ne!(body["error"]["code"], "migrations_pending");
    for n in [a, b, c] {
        n.task.abort();
    }
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn a_lost_node_is_rebalanced_away_automatically_without_losing_data() {
    let _slot = SLOTS.acquire().await.expect("test slots");
    let voters = ["xa", "xb", "xc"];
    let launch_new = async |seed: Option<SocketAddr>, id: &str| {
        let mut config = test_config(seed, Some(id), &voters);
        config.cluster.auto_rebalance_after_ms = 1_000;
        let http = TcpListener::bind("127.0.0.1:0").await.expect("bind");
        let cluster = TcpListener::bind("127.0.0.1:0").await.expect("bind");
        launch(tempfile::tempdir().expect("tempdir"), config, http, cluster).await
    };
    let a = launch_new(None, "xa").await;
    let b = launch_new(Some(a.cluster), "xb").await;
    let c = launch_new(Some(a.cluster), "xc").await;
    let all = [a.http, b.http, c.http];
    let alive = states(&[(&a, "alive"), (&b, "alive"), (&c, "alive")]);
    for n in all {
        wait_until("membership converges", async || view(n).await == alive).await;
    }
    wait_until("a control leader accepts the rebalance", async || {
        for n in all {
            if post(n, "/v1/admin/rebalance", r#"{"replication_factor":3}"#)
                .await
                .0
                == 202
            {
                return true;
            }
        }
        false
    })
    .await;
    for i in 0..20 {
        put_anywhere(&all, &format!("x{i}"), &i.to_string()).await;
    }

    // c dies. Once it is unreachable and stays so, the control leader
    // places everything on a and b (RF capped at 2) and the data follows.
    c.task.abort();
    let survivors = [a.http, b.http];
    wait_up_to(
        Duration::from_secs(40),
        "automatic rebalance to two nodes",
        async || {
            let p: Value =
                serde_json::from_str(&get(a.http, "/v1/partitions").await).expect("json");
            p["nodes"].as_array().map(Vec::len) == Some(2)
        },
    )
    .await;
    for n in survivors {
        wait_up_to(Duration::from_secs(40), "migrations finish", async || {
            running_migrations(n).await == 0
        })
        .await;
    }
    for i in 0..20 {
        let (code, body) = get_anywhere(&survivors, &format!("x{i}")).await;
        assert_eq!((code, body["value"].clone()), (200, Value::from(i)), "x{i}");
    }
    put_anywhere(&survivors, "after", "1").await;
    for n in [a, b] {
        n.task.abort();
    }
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn available_writes_survive_quorum_loss_and_conflicts_are_surfaced() {
    let _slot = SLOTS.acquire().await.expect("test slots");
    let voters = ["va1", "va2", "va3"];
    let mut nodes = Vec::new();
    for id in voters {
        let seed = nodes.first().map(|(_, n): &(&str, RunningNode)| n.cluster);
        nodes.push((id, start_voter(seed, Some(id), &voters).await));
    }
    let all: Vec<SocketAddr> = nodes.iter().map(|(_, n)| n.http).collect();
    let refs: Vec<(&RunningNode, &str)> = nodes.iter().map(|(_, n)| (n, "alive")).collect();
    let alive = states(&refs);
    for &n in &all {
        wait_until("membership converges", async || view(n).await == alive).await;
    }
    wait_until("a control leader accepts the rebalance", async || {
        for &n in &all {
            if post(n, "/v1/admin/rebalance", r#"{"replication_factor":3}"#)
                .await
                .0
                == 202
            {
                return true;
            }
        }
        false
    })
    .await;
    let (leader_http, _) = put_anywhere(&all, "warmup", "0").await;
    let followers: Vec<SocketAddr> = all.iter().copied().filter(|n| *n != leader_http).collect();

    // A follower accepts an available write at once (202), and it reaches
    // the group shortly after.
    let (code, body, head) = request(
        followers[0],
        "PUT",
        "/v1/kv/av?consistency=available",
        &[],
        "1",
    )
    .await;
    assert_eq!(code, 202, "{body}");
    assert_eq!(
        (body["accepted"].clone(), body["replicated"].clone()),
        (Value::Bool(true), Value::Bool(false))
    );
    assert!(head.contains("celeris-consistency: available"));
    wait_until("the available write is reconciled", async || {
        let (code, body) = get_anywhere(&all, "av").await;
        code == 200 && body["value"] == 1
    })
    .await;

    // Two followers accept concurrent writes to one key. One wins by
    // (timestamp, mutation ID); the other is recorded, not lost.
    let (c1, b1, _) = request(
        followers[0],
        "PUT",
        "/v1/kv/cv?consistency=available",
        &[],
        "\"first\"",
    )
    .await;
    let (c2, b2, _) = request(
        followers[1],
        "PUT",
        "/v1/kv/cv?consistency=available",
        &[],
        "\"second\"",
    )
    .await;
    assert_eq!((c1, c2), (202, 202), "{b1} {b2}");
    wait_up_to(
        Duration::from_secs(20),
        "the conflict is recorded",
        async || {
            let (code, body, _) =
                request(leader_http, "GET", "/v1/conflicts?prefix=cv", &[], "").await;
            code == 200 && body["conflicts"].as_array().map(Vec::len) == Some(1)
        },
    )
    .await;
    let (_, conflicts, _) = request(leader_http, "GET", "/v1/conflicts?prefix=cv", &[], "").await;
    let loser = conflicts["conflicts"][0]["value"]
        .as_str()
        .expect("loser")
        .to_owned();
    let (code, body) = get_anywhere(&all, "cv").await;
    assert_eq!(code, 200);
    let winner = body["value"].as_str().expect("winner").to_owned();
    let mut both = [format!("\"{winner}\""), loser.clone()];
    both.sort();
    assert_eq!(
        both,
        ["\"first\"".to_owned(), "\"second\"".to_owned()],
        "one wins, one is kept"
    );
    let (code, _, _) = request(followers[0], "DELETE", "/v1/conflicts/cv", &[], "").await;
    assert!(code == 200 || code == 421);

    // Lose the quorum: only one follower survives. Strict writes cannot be
    // served (honestly refused), available writes are still accepted.
    let survivor_http = followers[0];
    let mut remaining = Vec::new();
    for (id, n) in nodes {
        if n.http == survivor_http {
            remaining.push((id, n));
        } else {
            n.task.abort();
            remaining.push((id, n));
        }
    }
    let (code, body, _) = request(survivor_http, "PUT", "/v1/kv/q", &[], "1").await;
    assert_ne!(code, 200, "a strict write needs a quorum: {body}");
    let (code, body, _) = request(
        survivor_http,
        "PUT",
        "/v1/kv/q?consistency=available",
        &[],
        "7",
    )
    .await;
    assert_eq!(code, 202, "{body}");

    // Bring one node back: the quorum returns and the pending write lands.
    let survivor_cluster = remaining
        .iter()
        .find(|(_, n)| n.http == survivor_http)
        .map(|(_, n)| n.cluster)
        .expect("survivor");
    let mut back = None;
    let mut keep = Vec::new();
    for (id, n) in remaining {
        if back.is_none() && n.http != survivor_http {
            let config = test_config(Some(survivor_cluster), Some(id), &voters);
            back = Some(crash_and_restart(n, config).await);
        } else {
            keep.push(n);
        }
    }
    let back = back.expect("restarted");
    let live = [survivor_http, back.http];
    wait_up_to(
        Duration::from_secs(40),
        "the pending write is committed",
        async || {
            let (code, body, _) = request(
                survivor_http,
                "GET",
                "/v1/kv/q?consistency=eventual",
                &[],
                "",
            )
            .await;
            code == 200 && body["value"] == 7
        },
    )
    .await;
    let (code, body) = get_anywhere(&live, "q").await;
    assert_eq!((code, body["value"].clone()), (200, Value::from(7)));
    back.task.abort();
    for n in keep {
        n.task.abort();
    }
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn anti_entropy_compares_every_replica() {
    let _slot = SLOTS.acquire().await.expect("test slots");
    let voters = ["ea", "eb", "ec"];
    let mut nodes = Vec::new();
    for id in voters {
        let seed = nodes.first().map(|n: &RunningNode| n.cluster);
        let mut config = test_config(seed, Some(id), &voters);
        config.cluster.anti_entropy_interval_ms = 300;
        let http = TcpListener::bind("127.0.0.1:0").await.expect("bind");
        let cluster = TcpListener::bind("127.0.0.1:0").await.expect("bind");
        nodes.push(launch(tempfile::tempdir().expect("tempdir"), config, http, cluster).await);
    }
    let all: Vec<SocketAddr> = nodes.iter().map(|n| n.http).collect();
    let refs: Vec<(&RunningNode, &str)> = nodes.iter().map(|n| (n, "alive")).collect();
    let alive = states(&refs);
    for &n in &all {
        wait_until("membership converges", async || view(n).await == alive).await;
    }
    wait_until("a control leader accepts the rebalance", async || {
        for &n in &all {
            if post(n, "/v1/admin/rebalance", r#"{"replication_factor":3}"#)
                .await
                .0
                == 202
            {
                return true;
            }
        }
        false
    })
    .await;
    for i in 0..10 {
        put_anywhere(&all, &format!("e{i}"), &i.to_string()).await;
    }
    wait_up_to(
        Duration::from_secs(20),
        "a clean anti-entropy report",
        async || {
            for &n in &all {
                let s = status(n).await;
                if let Some(reports) = s["control"]["anti_entropy"].as_object() {
                    for report in reports.values() {
                        if report["compared"].as_array().map(Vec::len) == Some(3)
                            && report["diverged"].as_array().is_some_and(Vec::is_empty)
                            && report["leader_diverged"] == false
                        {
                            return true;
                        }
                    }
                }
            }
            false
        },
    )
    .await;
    for n in nodes {
        n.task.abort();
    }
}

/// How a client request ended, for history recording.
enum Outcome {
    /// The server answered.
    Answered(u16, Value),
    /// The request never reached a server: certainly not applied.
    NotSent,
    /// The connection failed after sending: the outcome is unknown.
    Lost,
}

async fn try_request(addr: SocketAddr, method: &str, path: &str, body: &str) -> Outcome {
    let Ok(Ok(mut stream)) =
        tokio::time::timeout(Duration::from_secs(1), tokio::net::TcpStream::connect(addr)).await
    else {
        return Outcome::NotSent;
    };
    let head = format!(
        "{method} {path} HTTP/1.1\r\nHost: x\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}",
        body.len()
    );
    let exchange = async {
        stream.write_all(head.as_bytes()).await?;
        let mut raw = String::new();
        stream.read_to_string(&mut raw).await?;
        Ok::<_, std::io::Error>(raw)
    };
    match tokio::time::timeout(Duration::from_secs(8), exchange).await {
        Ok(Ok(raw)) if !raw.is_empty() => {
            let status = raw
                .split_whitespace()
                .nth(1)
                .and_then(|s| s.parse().ok())
                .unwrap_or(0);
            let body = raw.split_once("\r\n\r\n").map_or("", |(_, b)| b);
            Outcome::Answered(status, serde_json::from_str(body).unwrap_or(Value::Null))
        }
        _ => Outcome::Lost,
    }
}

/// Concurrent clients write and strictly read a few keys while the group
/// leader is killed. Every key's history of acknowledged (and unknown)
/// operations must be linearizable.
#[tokio::test(flavor = "multi_thread", worker_threads = 6)]
async fn strict_operations_stay_linearizable_across_leader_failure() {
    let _slot = SLOTS.acquire().await.expect("test slots");
    use celeris_testkit::linearizability::{Event, Op, check};
    use std::collections::BTreeMap;
    use std::sync::Mutex;

    let voters = ["la", "lb", "lc"];
    let a = start_voter(None, Some("la"), &voters).await;
    let b = start_voter(Some(a.cluster), Some("lb"), &voters).await;
    let c = start_voter(Some(a.cluster), Some("lc"), &voters).await;
    let all = [a.http, b.http, c.http];
    let alive = states(&[(&a, "alive"), (&b, "alive"), (&c, "alive")]);
    for n in all {
        wait_until("membership converges", async || view(n).await == alive).await;
    }
    wait_until("a control leader accepts the rebalance", async || {
        for n in all {
            if post(n, "/v1/admin/rebalance", r#"{"replication_factor":3}"#)
                .await
                .0
                == 202
            {
                return true;
            }
        }
        false
    })
    .await;
    let (leader_http, _) = put_anywhere(&all, "warmup", "0").await;

    let epoch = Instant::now();
    let clock = move || u64::try_from(epoch.elapsed().as_micros()).unwrap_or(u64::MAX);
    let histories: Arc<Mutex<BTreeMap<String, Vec<Event>>>> = Arc::default();
    let completed = Arc::new(std::sync::atomic::AtomicUsize::new(0));
    let mut clients = Vec::new();
    for client in 0..4i64 {
        let (histories, completed) = (Arc::clone(&histories), Arc::clone(&completed));
        clients.push(tokio::spawn(async move {
            for seq in 0..30i64 {
                let key = format!("lin{}", (client + seq) % 3);
                let write = (client * 7 + seq) % 2 == 0;
                let value = client * 1_000 + seq;
                let mut invoke = clock();
                // Try nodes in turn: a redirect or refusal was not applied,
                // so moving on to the next node is a fresh attempt.
                let mut outcome = Outcome::NotSent;
                for attempt in 0..3 {
                    let node = all[((client + seq + attempt) % 3) as usize];
                    invoke = clock();
                    outcome = if write {
                        try_request(node, "PUT", &format!("/v1/kv/{key}"), &value.to_string()).await
                    } else {
                        try_request(node, "GET", &format!("/v1/kv/{key}"), "").await
                    };
                    let refused = match &outcome {
                        Outcome::NotSent => true,
                        Outcome::Answered(421, _) => true,
                        Outcome::Answered(503, body) => body["error"]["outcome"] != "unknown",
                        _ => false,
                    };
                    if !refused {
                        break;
                    }
                }
                let response = clock();
                let event = match (write, outcome) {
                    (true, Outcome::Answered(200, _)) => Some(Event {
                        invoke,
                        response: Some(response),
                        op: Op::Write(value),
                    }),
                    (true, Outcome::Answered(_, body)) if body["error"]["outcome"] == "unknown" => {
                        Some(Event {
                            invoke,
                            response: None,
                            op: Op::Write(value),
                        })
                    }
                    (true, Outcome::Lost) => Some(Event {
                        invoke,
                        response: None,
                        op: Op::Write(value),
                    }),
                    (false, Outcome::Answered(200, body)) => Some(Event {
                        invoke,
                        response: Some(response),
                        op: Op::Read(body["value"].as_i64()),
                    }),
                    (false, Outcome::Answered(404, _)) => Some(Event {
                        invoke,
                        response: Some(response),
                        op: Op::Read(None),
                    }),
                    // Redirects and refusals were not applied.
                    _ => None,
                };
                if let Some(event) = event {
                    histories
                        .lock()
                        .expect("lock")
                        .entry(key)
                        .or_default()
                        .push(event);
                }
                completed.fetch_add(1, std::sync::atomic::Ordering::Relaxed);
                tokio::time::sleep(Duration::from_millis(15)).await;
            }
        }));
    }
    // Kill the group leader part-way through.
    while completed.load(std::sync::atomic::Ordering::Relaxed) < 40 {
        tokio::time::sleep(Duration::from_millis(10)).await;
    }
    let mut nodes = vec![a, b, c];
    let leader_at = nodes
        .iter()
        .position(|n| n.http == leader_http)
        .expect("leader");
    let killed = nodes.remove(leader_at);
    killed.task.abort();
    for client in clients {
        client.await.expect("client");
    }

    let histories = histories.lock().expect("lock").clone();
    let mut acknowledged = 0;
    for (key, history) in &histories {
        acknowledged += history.iter().filter(|e| e.response.is_some()).count();
        if let Err(e) = check(history) {
            panic!("{key}: {e}\nhistory: {history:#?}");
        }
    }
    assert!(
        acknowledged >= 40,
        "the test exercised the cluster ({acknowledged} acknowledged)"
    );
    for n in nodes {
        n.task.abort();
    }
}

async fn raft_role(n: &RunningNode) -> String {
    status(n.http).await["control"]["raft"]["role"]
        .as_str()
        .unwrap_or("none")
        .to_owned()
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn control_plane_elects_a_leader_and_commits_partition_maps() {
    let _slot = SLOTS.acquire().await.expect("test slots");
    let voters = ["va", "vb", "vc"];
    let a = start_voter(None, Some("va"), &voters).await;
    let b = start_voter(Some(a.cluster), Some("vb"), &voters).await;
    let c = start_voter(Some(a.cluster), Some("vc"), &voters).await;
    let nodes = [&a, &b, &c];

    let all_alive = states(&[(&a, "alive"), (&b, "alive"), (&c, "alive")]);
    for n in nodes {
        wait_until("membership converges", async || {
            view(n.http).await == all_alive
        })
        .await;
    }
    wait_until("exactly one raft leader", async || {
        let mut leaders = 0;
        for n in nodes {
            if raft_role(n).await == "leader" {
                leaders += 1;
            }
        }
        leaders == 1
    })
    .await;
    let mut leader = None;
    let mut follower = None;
    for n in nodes {
        if raft_role(n).await == "leader" {
            leader = Some(n);
        } else {
            follower = Some(n);
        }
    }
    let (leader, follower) = (leader.expect("leader"), follower.expect("follower"));
    assert_eq!(raft_role(leader).await, "leader");

    // A follower forwards the request to the leader.
    wait_until("the follower forwards the rebalance", async || {
        let (code, body) = post(
            follower.http,
            "/v1/admin/rebalance",
            r#"{"replication_factor":2}"#,
        )
        .await;
        code == 202 && body["status"] == "forwarded"
    })
    .await;

    for n in nodes {
        wait_until("every node applies the committed map", async || {
            let p: Value =
                serde_json::from_str(&get(n.http, "/v1/partitions").await).expect("json");
            p["replication_factor"] == 2 && p["nodes"].as_array().map(Vec::len) == Some(3)
        })
        .await;
        assert!(
            n._dir.path().join("raft").join("state.json").exists(),
            "raft state persisted"
        );
    }
    let route = get(b.http, "/v1/partitions/key/users/42").await;
    let route: Value = serde_json::from_str(&route).expect("json");
    assert_eq!(route["replicas"].as_array().map(Vec::len), Some(2));
    for n in nodes {
        n.task.abort();
    }
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn the_leader_places_partitions_once_every_voter_is_up() {
    let _slot = SLOTS.acquire().await.expect("test slots");
    let voters = ["ba", "bb", "bc"];
    let config = |seed, id| {
        let mut config = test_config(seed, Some(id), &voters);
        config.cluster.replication_factor = 3;
        config
    };
    let a = start_with(config(None, "ba")).await;
    // Two of three voters form a quorum but must not place partitions yet:
    // the third would start with no replicas.
    let b = start_with(config(Some(a.cluster), "bb")).await;
    tokio::time::sleep(Duration::from_millis(1_500)).await;
    let p: Value = serde_json::from_str(&get(a.http, "/v1/partitions").await).expect("json");
    assert_ne!(p["nodes"].as_array().map(Vec::len), Some(2), "{p}");

    let c = start_with(config(Some(a.cluster), "bc")).await;
    for n in [&a, &b, &c] {
        wait_until("every node applies the automatic placement", async || {
            let p: Value =
                serde_json::from_str(&get(n.http, "/v1/partitions").await).expect("json");
            p["replication_factor"] == 3 && p["nodes"].as_array().map(Vec::len) == Some(3)
        })
        .await;
    }
    let nodes = [a.http, b.http, c.http];
    let (_, body) = put_anywhere(&nodes, "boot/1", r#"{"ok":true}"#).await;
    assert!(body["version"].as_u64().is_some(), "{body}");
    for n in [a, b, c] {
        n.task.abort();
    }
}
