//! Chaos (D-034): clients increment counters with compare-and-set while
//! nodes are partitioned, healed and crash-restarted at random. Afterwards
//! every counter must equal the increments acknowledged, plus at most the
//! increments whose outcome was unknown, and every replica must agree.
//!
//! The run is seeded; a failure prints the seed. Replay it with
//! `CELERIS_CHAOS_SEED=<seed> cargo test -p celeris-server --test chaos`.

use std::net::SocketAddr;
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use celeris_server::config::SyncSetting;
use celeris_server::{Config, Node, serve};
use serde_json::Value;
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::TcpListener;
use tokio::task::JoinHandle;

const VOTERS: [&str; 3] = ["xa", "xb", "xc"];
const COUNTERS: usize = 3;
const CLIENTS: usize = 3;
const ROUNDS: usize = 8;

/// xorshift64*: small, seedable, good enough to pick faults.
struct Rng(u64);

impl Rng {
    fn next(&mut self) -> u64 {
        self.0 ^= self.0 >> 12;
        self.0 ^= self.0 << 25;
        self.0 ^= self.0 >> 27;
        self.0.wrapping_mul(0x2545_F491_4F6C_DD1D)
    }

    fn below(&mut self, n: usize) -> usize {
        (self.next() % n as u64) as usize
    }
}

struct Running {
    node: Arc<Node>,
    http: SocketAddr,
    cluster: SocketAddr,
    task: JoinHandle<anyhow::Result<()>>,
    dir: tempfile::TempDir,
}

fn config(id: &str, seed: Option<SocketAddr>) -> Config {
    let mut config = Config::default();
    config.node.id = Some(id.into());
    config.storage.sync = SyncSetting::Never;
    config.cluster.listen = Some("127.0.0.1:0".into());
    config.cluster.seeds = seed.map(|s| s.to_string()).into_iter().collect();
    config.cluster.heartbeat_interval_ms = 50;
    config.cluster.suspect_after_ms = 300;
    config.cluster.suspicion_timeout_ms = 600;
    config.cluster.voters = VOTERS.iter().map(|v| (*v).to_owned()).collect();
    config.cluster.raft_election_timeout_ms = 150;
    config.cluster.raft_heartbeat_ms = 30;
    config.cluster.replication_factor = 3;
    config
}

async fn launch(
    dir: tempfile::TempDir,
    mut config: Config,
    http: TcpListener,
    cluster: TcpListener,
) -> Running {
    config.node.data_dir = dir.path().to_path_buf();
    let http_addr = http.local_addr().expect("addr");
    let cluster_addr = cluster.local_addr().expect("addr");
    // A crashed instance may need a moment to release its storage lock.
    let deadline = Instant::now() + Duration::from_secs(10);
    let node = loop {
        let config = config.clone();
        let opened = tokio::task::spawn_blocking(move || {
            Node::open(&config, http_addr.to_string(), Some(cluster_addr))
        })
        .await
        .expect("join");
        match opened {
            Ok(node) => break Arc::new(node),
            Err(_) if Instant::now() < deadline => {
                tokio::time::sleep(Duration::from_millis(100)).await;
            }
            Err(e) => panic!("open: {e:#}"),
        }
    };
    let task = tokio::spawn(serve(
        Arc::clone(&node),
        http,
        Some(cluster),
        std::future::pending(),
    ));
    Running {
        node,
        http: http_addr,
        cluster: cluster_addr,
        task,
        dir,
    }
}

async fn bind(addr: SocketAddr) -> TcpListener {
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
}

async fn crash_and_restart(n: Running, config: Config) -> Running {
    n.task.abort();
    let _ = n.task.await;
    drop(n.node);
    let http = bind(n.http).await;
    let cluster = bind(n.cluster).await;
    launch(n.dir, config, http, cluster).await
}

enum Reply {
    /// Answered with this status and body.
    Status(u16, Value),
    /// Never connected: nothing was sent.
    NotSent,
    /// Sent, but no complete answer in time.
    Lost,
}

async fn request(addr: SocketAddr, method: &str, path: &str, body: &str) -> Reply {
    let Ok(Ok(mut stream)) = tokio::time::timeout(
        Duration::from_millis(500),
        tokio::net::TcpStream::connect(addr),
    )
    .await
    else {
        return Reply::NotSent;
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
    match tokio::time::timeout(Duration::from_secs(3), exchange).await {
        Ok(Ok(raw)) => {
            let Some(status) = raw.split_whitespace().nth(1).and_then(|s| s.parse().ok()) else {
                return Reply::Lost;
            };
            let body = raw.split_once("\r\n\r\n").map_or("", |(_, b)| b);
            Reply::Status(status, serde_json::from_str(body).unwrap_or(Value::Null))
        }
        _ => Reply::Lost,
    }
}

/// Acknowledged and unknown-outcome increments per counter.
#[derive(Default)]
struct Tally {
    acked: [AtomicU64; COUNTERS],
    unknown: [AtomicU64; COUNTERS],
}

/// One client: read a counter, then compare-and-set it one higher.
async fn client(
    nodes: Arc<Mutex<Vec<SocketAddr>>>,
    tally: Arc<Tally>,
    stop: Arc<AtomicBool>,
    seed: u64,
) {
    let mut rng = Rng(seed | 1);
    while !stop.load(Ordering::Relaxed) {
        let c = rng.below(COUNTERS);
        let addr = {
            let nodes = nodes.lock().expect("nodes");
            nodes[rng.below(nodes.len())]
        };
        let key = format!("chaos/c{c}");
        let current = match request(addr, "GET", &format!("/v1/kv/{key}"), "").await {
            Reply::Status(200, body) => Some((
                body["value"].as_u64().unwrap_or(0),
                body["version"].as_u64(),
            )),
            Reply::Status(404, _) => None,
            _ => {
                tokio::time::sleep(Duration::from_millis(20)).await;
                continue;
            }
        };
        let (value, condition) = match current {
            Some((v, Some(version))) => (v, format!("if_version={version}")),
            Some((_, None)) => continue,
            None => (0, "if_absent=true".to_owned()),
        };
        let path = format!("/v1/kv/{key}?{condition}");
        match request(addr, "PUT", &path, &(value + 1).to_string()).await {
            Reply::Status(200, _) => {
                tally.acked[c].fetch_add(1, Ordering::Relaxed);
            }
            Reply::Status(_, body) if body["error"]["outcome"] == "unknown" => {
                tally.unknown[c].fetch_add(1, Ordering::Relaxed);
            }
            Reply::Lost => {
                tally.unknown[c].fetch_add(1, Ordering::Relaxed);
            }
            // Conflicts, redirects and refusals: nothing was applied.
            Reply::Status(..) | Reply::NotSent => {}
        }
    }
}

fn isolate(nodes: &[Running], victim: usize) {
    let addrs: Vec<String> = nodes.iter().map(|n| n.cluster.to_string()).collect();
    for (i, n) in nodes.iter().enumerate() {
        if i == victim {
            n.node.isolate_from(
                addrs
                    .iter()
                    .enumerate()
                    .filter(|(j, _)| *j != victim)
                    .map(|(_, a)| a.clone()),
            );
        } else {
            n.node.isolate_from([addrs[victim].clone()]);
        }
    }
}

fn heal(nodes: &[Running]) {
    for n in nodes {
        n.node.isolate_from([]);
    }
}

async fn wait_until(what: &str, limit: Duration, mut check: impl AsyncFnMut() -> bool) {
    let deadline = Instant::now() + limit;
    while Instant::now() < deadline {
        if check().await {
            return;
        }
        tokio::time::sleep(Duration::from_millis(100)).await;
    }
    panic!("timed out waiting for: {what}");
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn counters_survive_partitions_and_crashes() {
    let seed = std::env::var("CELERIS_CHAOS_SEED")
        .ok()
        .and_then(|s| s.parse().ok())
        .unwrap_or_else(|| {
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .map(|d| d.as_nanos() as u64)
                .unwrap_or(42)
        });
    eprintln!("chaos seed: {seed}");
    let mut rng = Rng(seed | 1);

    let mut nodes: Vec<Running> = Vec::new();
    for id in VOTERS {
        let seed_addr = nodes.first().map(|n| n.cluster);
        let http = TcpListener::bind("127.0.0.1:0").await.expect("bind");
        let cluster = TcpListener::bind("127.0.0.1:0").await.expect("bind");
        let dir = tempfile::tempdir().expect("tempdir");
        nodes.push(launch(dir, config(id, seed_addr), http, cluster).await);
    }
    let seeds: Vec<Option<SocketAddr>> = (0..nodes.len())
        .map(|i| (i > 0).then(|| nodes[0].cluster))
        .collect();
    let https: Vec<SocketAddr> = nodes.iter().map(|n| n.http).collect();
    wait_until(
        "the first write commits",
        Duration::from_secs(30),
        async || {
            for &n in &https {
                if let Reply::Status(200, _) = request(n, "PUT", "/v1/kv/chaos/ready", "1").await {
                    return true;
                }
            }
            false
        },
    )
    .await;

    let shared = Arc::new(Mutex::new(https.clone()));
    let tally = Arc::new(Tally::default());
    let stop = Arc::new(AtomicBool::new(false));
    let clients: Vec<JoinHandle<()>> = (0..CLIENTS)
        .map(|i| {
            tokio::spawn(client(
                Arc::clone(&shared),
                Arc::clone(&tally),
                Arc::clone(&stop),
                seed.wrapping_add(i as u64 * 7919),
            ))
        })
        .collect();

    for round in 0..ROUNDS {
        let victim = rng.below(nodes.len());
        match rng.below(3) {
            0 => {
                eprintln!("round {round}: isolate {}", VOTERS[victim]);
                isolate(&nodes, victim);
                tokio::time::sleep(Duration::from_millis(1_500 + rng.below(1_000) as u64)).await;
                heal(&nodes);
            }
            1 => {
                eprintln!("round {round}: crash and restart {}", VOTERS[victim]);
                let n = nodes.remove(victim);
                let restarted = crash_and_restart(n, config(VOTERS[victim], seeds[victim])).await;
                nodes.insert(victim, restarted);
            }
            _ => eprintln!("round {round}: calm"),
        }
        tokio::time::sleep(Duration::from_millis(800)).await;
    }
    heal(&nodes);
    // Let the cluster settle under load, then stop the clients.
    tokio::time::sleep(Duration::from_secs(2)).await;
    stop.store(true, Ordering::Relaxed);
    for c in clients {
        let _ = c.await;
    }

    for c in 0..COUNTERS {
        let acked = tally.acked[c].load(Ordering::Relaxed);
        let unknown = tally.unknown[c].load(Ordering::Relaxed);
        let key = format!("chaos/c{c}");
        let mut final_value = None;
        wait_until(
            "a strict read succeeds",
            Duration::from_secs(30),
            async || {
                for &n in &https {
                    if let Reply::Status(code, body) =
                        request(n, "GET", &format!("/v1/kv/{key}"), "").await
                    {
                        match code {
                            200 => final_value = body["value"].as_u64(),
                            404 => final_value = Some(0),
                            _ => continue,
                        }
                        return true;
                    }
                }
                false
            },
        )
        .await;
        let value = final_value.expect("value");
        eprintln!("counter {c}: value {value}, acked {acked}, unknown {unknown}");
        assert!(
            acked <= value && value <= acked + unknown,
            "seed {seed}: counter {c} is {value}, but {acked} increments were acknowledged and {unknown} were unknown"
        );
        assert!(
            acked > 0,
            "seed {seed}: no increment of counter {c} succeeded"
        );
        for &n in &https {
            wait_until("replicas converge", Duration::from_secs(30), async || {
                matches!(
                    request(n, "GET", &format!("/v1/kv/{key}?consistency=eventual"), "").await,
                    Reply::Status(200, ref body) if body["value"].as_u64() == Some(value)
                )
            })
            .await;
        }
    }
    for n in nodes {
        n.task.abort();
    }
}
