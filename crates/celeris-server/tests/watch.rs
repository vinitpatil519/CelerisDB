//! `GET /v1/watch`: a real WebSocket against a real node.

use std::io::{Read, Write};
use std::net::SocketAddr;
use std::sync::Arc;
use std::time::Duration;

use celeris_server::config::SyncSetting;
use celeris_server::{Config, Node, serve};
use serde_json::Value;
use tokio::net::TcpListener;

async fn start() -> (
    SocketAddr,
    tokio::task::JoinHandle<anyhow::Result<()>>,
    tempfile::TempDir,
) {
    let dir = tempfile::tempdir().expect("tempdir");
    let mut config = Config::default();
    config.node.data_dir = dir.path().to_path_buf();
    config.storage.sync = SyncSetting::Never;
    let listener = TcpListener::bind("127.0.0.1:0").await.expect("bind");
    let addr = listener.local_addr().expect("addr");
    let node = tokio::task::spawn_blocking(move || Node::open(&config, addr.to_string(), None))
        .await
        .expect("join")
        .expect("open");
    let task = tokio::spawn(serve(
        Arc::new(node),
        listener,
        None,
        std::future::pending(),
    ));
    (addr, task, dir)
}

/// A minimal blocking HTTP exchange (keeps the test free of HTTP clients).
fn http(addr: SocketAddr, request: &str) -> String {
    let mut s = std::net::TcpStream::connect(addr).expect("connect");
    s.write_all(request.as_bytes()).expect("send");
    let mut out = String::new();
    s.read_to_string(&mut out).expect("read");
    out
}

fn put(addr: SocketAddr, key: &str, body: &str) {
    let reply = http(
        addr,
        &format!(
            "PUT /v1/kv/{key} HTTP/1.1\r\nHost: x\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}",
            body.len()
        ),
    );
    assert!(reply.starts_with("HTTP/1.1 200"), "{reply}");
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn watchers_receive_matching_changes() {
    let (addr, task, _dir) = start().await;
    let watcher = tokio::task::spawn_blocking(move || {
        let (mut socket, _) =
            tungstenite::connect(format!("ws://{addr}/v1/watch?prefix=users/")).expect("connect");
        let mut messages = Vec::new();
        while messages.len() < 3 {
            if let tungstenite::Message::Text(text) = socket.read().expect("read") {
                messages.push(serde_json::from_str::<Value>(&text).expect("json"));
            }
        }
        messages
    });
    // Give the watcher a moment to subscribe before writing.
    tokio::time::sleep(Duration::from_millis(300)).await;
    tokio::task::spawn_blocking(move || {
        put(addr, "orders/1", "1"); // filtered out by the prefix
        put(addr, "users/1", r#"{"name":"ada"}"#);
        put(addr, "users/2", "2");
    })
    .await
    .expect("writes");
    let messages = tokio::time::timeout(Duration::from_secs(10), watcher)
        .await
        .expect("watcher finishes")
        .expect("join");
    assert_eq!(messages[0]["type"], "hello");
    assert_eq!(messages[0]["prefix"], "users/");
    assert_eq!(messages[1]["type"], "change");
    assert_eq!(messages[1]["key"], "users/1");
    assert_eq!(messages[1]["kind"], "put");
    assert_eq!(messages[1]["value"]["name"], "ada");
    assert!(messages[1]["version"].as_u64().is_some_and(|v| v > 0));
    assert_eq!(messages[2]["key"], "users/2");
    task.abort();
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn plain_http_requests_to_watch_are_refused() {
    let (addr, task, _dir) = start().await;
    let reply = tokio::task::spawn_blocking(move || {
        http(
            addr,
            "GET /v1/watch HTTP/1.1\r\nHost: x\r\nConnection: close\r\n\r\n",
        )
    })
    .await
    .expect("join");
    assert!(reply.starts_with("HTTP/1.1 400"), "{reply}");
    assert!(reply.contains("websocket_required"));
    task.abort();
}
