//! Mutual TLS on the cluster port (D-033): three nodes with certificates
//! from one CA form a cluster and replicate; nodes with a foreign CA or no
//! TLS at all cannot join.

use std::net::SocketAddr;
use std::path::Path;
use std::sync::Arc;
use std::time::{Duration, Instant};

use celeris_server::config::{ClusterTlsConfig, SyncSetting};
use celeris_server::{Config, Node, serve};
use rcgen::{BasicConstraints, CertificateParams, IsCa, KeyPair};
use serde_json::Value;
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::TcpListener;
use tokio::task::JoinHandle;

struct Ca {
    cert: rcgen::Certificate,
    key: KeyPair,
}

fn ca() -> Ca {
    let mut params = CertificateParams::new(Vec::<String>::new()).expect("params");
    params.is_ca = IsCa::Ca(BasicConstraints::Unconstrained);
    let key = KeyPair::generate().expect("key");
    let cert = params.self_signed(&key).expect("ca");
    Ca { cert, key }
}

/// Writes a node certificate for 127.0.0.1 signed by `signer`, plus the CA
/// to trust, into `dir`, and returns the config that uses them.
fn node_tls(dir: &Path, signer: &Ca, trust: &Ca) -> ClusterTlsConfig {
    let params = CertificateParams::new(vec!["127.0.0.1".to_owned()]).expect("params");
    let key = KeyPair::generate().expect("key");
    let cert = params
        .signed_by(&key, &signer.cert, &signer.key)
        .expect("leaf");
    let files = ClusterTlsConfig {
        cert_file: dir.join("node.crt"),
        key_file: dir.join("node.key"),
        ca_file: dir.join("ca.crt"),
    };
    std::fs::write(&files.cert_file, cert.pem()).expect("write");
    std::fs::write(&files.key_file, key.serialize_pem()).expect("write");
    std::fs::write(&files.ca_file, trust.cert.pem()).expect("write");
    files
}

struct Running {
    http: SocketAddr,
    cluster: SocketAddr,
    task: JoinHandle<anyhow::Result<()>>,
    _dirs: (tempfile::TempDir, tempfile::TempDir),
}

async fn start(id: &str, seed: Option<SocketAddr>, tls: Option<(&Ca, &Ca)>) -> Running {
    let data = tempfile::tempdir().expect("tempdir");
    let certs = tempfile::tempdir().expect("tempdir");
    let mut config = Config::default();
    config.node.id = Some(id.into());
    config.node.data_dir = data.path().to_path_buf();
    config.storage.sync = SyncSetting::Never;
    config.cluster.listen = Some("127.0.0.1:0".into());
    config.cluster.seeds = seed.map(|s| s.to_string()).into_iter().collect();
    config.cluster.heartbeat_interval_ms = 50;
    config.cluster.suspect_after_ms = 300;
    config.cluster.suspicion_timeout_ms = 600;
    config.cluster.voters = vec!["ta".into(), "tb".into(), "tc".into()];
    config.cluster.raft_election_timeout_ms = 150;
    config.cluster.raft_heartbeat_ms = 30;
    config.cluster.replication_factor = 3;
    config.cluster.tls = tls.map(|(signer, trust)| node_tls(certs.path(), signer, trust));
    config.validate().expect("config");
    let http_listener = TcpListener::bind("127.0.0.1:0").await.expect("bind");
    let cluster_listener = TcpListener::bind("127.0.0.1:0").await.expect("bind");
    let http = http_listener.local_addr().expect("addr");
    let cluster = cluster_listener.local_addr().expect("addr");
    let node =
        tokio::task::spawn_blocking(move || Node::open(&config, http.to_string(), Some(cluster)))
            .await
            .expect("join")
            .expect("open");
    let task = tokio::spawn(serve(
        Arc::new(node),
        http_listener,
        Some(cluster_listener),
        std::future::pending(),
    ));
    Running {
        http,
        cluster,
        task,
        _dirs: (data, certs),
    }
}

async fn request(addr: SocketAddr, method: &str, path: &str, body: &str) -> (u16, Value) {
    let mut stream = tokio::net::TcpStream::connect(addr).await.expect("connect");
    let head = format!(
        "{method} {path} HTTP/1.1\r\nHost: x\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}",
        body.len()
    );
    stream.write_all(head.as_bytes()).await.expect("send");
    let mut raw = String::new();
    stream.read_to_string(&mut raw).await.expect("read");
    let status = raw
        .split_whitespace()
        .nth(1)
        .and_then(|s| s.parse().ok())
        .expect("status");
    let body = raw.split_once("\r\n\r\n").map_or("", |(_, b)| b);
    (status, serde_json::from_str(body).unwrap_or(Value::Null))
}

/// Cluster addresses `observer` sees as alive.
async fn alive(observer: SocketAddr) -> Vec<String> {
    let (_, s) = request(observer, "GET", "/v1/status", "").await;
    let mut out: Vec<String> = s["cluster"]["nodes"]
        .as_array()
        .cloned()
        .unwrap_or_default()
        .iter()
        .filter(|n| n["state"] == "alive")
        .filter_map(|n| n["address"].as_str().map(str::to_owned))
        .collect();
    out.sort();
    out
}

async fn wait_until(what: &str, mut check: impl AsyncFnMut() -> bool) {
    let deadline = Instant::now() + Duration::from_secs(20);
    while Instant::now() < deadline {
        if check().await {
            return;
        }
        tokio::time::sleep(Duration::from_millis(50)).await;
    }
    panic!("timed out waiting for: {what}");
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn nodes_with_the_cluster_ca_replicate_and_others_are_refused() {
    let cluster_ca = ca();
    let other_ca = ca();
    let a = start("ta", None, Some((&cluster_ca, &cluster_ca))).await;
    let b = start("tb", Some(a.cluster), Some((&cluster_ca, &cluster_ca))).await;
    let c = start("tc", Some(a.cluster), Some((&cluster_ca, &cluster_ca))).await;
    let mut expected = vec![
        a.cluster.to_string(),
        b.cluster.to_string(),
        c.cluster.to_string(),
    ];
    expected.sort();
    for n in [a.http, b.http, c.http] {
        wait_until("the TLS cluster forms", async || alive(n).await == expected).await;
    }
    // Replication runs over TLS: a strict write anywhere, read everywhere.
    wait_until("a write commits", async || {
        for n in [a.http, b.http, c.http] {
            if request(n, "PUT", "/v1/kv/secure/1", r#"{"v":1}"#).await.0 == 200 {
                return true;
            }
        }
        false
    })
    .await;
    for n in [a.http, b.http, c.http] {
        wait_until("every replica has the write", async || {
            let (code, body) = request(n, "GET", "/v1/kv/secure/1?consistency=eventual", "").await;
            code == 200 && body["value"]["v"] == 1
        })
        .await;
    }

    // A node signed by another CA, and a node without TLS, try to join.
    let rogue = start("rogue", Some(a.cluster), Some((&other_ca, &cluster_ca))).await;
    let plain = start("plain", Some(a.cluster), None).await;
    tokio::time::sleep(Duration::from_secs(2)).await;
    assert_eq!(alive(a.http).await, expected, "outsiders must not join");
    assert!(
        !alive(rogue.http).await.contains(&a.cluster.to_string()),
        "the rogue node must not see the cluster"
    );
    for n in [a, b, c, rogue, plain] {
        n.task.abort();
    }
}

#[test]
fn bad_tls_files_are_rejected() {
    let dir = tempfile::tempdir().expect("tempdir");
    let ca = ca();
    let files = node_tls(dir.path(), &ca, &ca);
    std::fs::write(&files.ca_file, "not a certificate").expect("write");
    let err = celeris_server::cluster_tls::ClusterTls::from_files(
        &files.cert_file,
        &files.key_file,
        &files.ca_file,
    )
    .expect_err("empty CA");
    assert!(err.to_string().contains("CA"), "{err:#}");
}
