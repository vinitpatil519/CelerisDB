//! HTTPS on the client API: a real TLS handshake against a self-signed
//! certificate, requests over it, and plain HTTP refused.

use std::sync::Arc;

use celeris_server::config::SyncSetting;
use celeris_server::{Config, Node, serve_with_tls, tls};
use rustls::pki_types::ServerName;
use rustls::{ClientConfig, RootCertStore};
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::{TcpListener, TcpStream};
use tokio_rustls::TlsConnector;

struct Running {
    addr: std::net::SocketAddr,
    cert_der: Vec<u8>,
    task: tokio::task::JoinHandle<anyhow::Result<()>>,
    _dir: tempfile::TempDir,
}

async fn start() -> Running {
    let cert = rcgen::generate_simple_self_signed(vec!["localhost".into(), "127.0.0.1".into()])
        .expect("cert");
    let acceptor = tls::acceptor_from_pem(
        cert.cert.pem().as_bytes(),
        cert.key_pair.serialize_pem().as_bytes(),
    )
    .expect("acceptor");
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
    let task = tokio::spawn(serve_with_tls(
        Arc::new(node),
        listener,
        None,
        Some(acceptor),
        std::future::pending(),
    ));
    Running {
        addr,
        cert_der: cert.cert.der().to_vec(),
        task,
        _dir: dir,
    }
}

async fn https(node: &Running, request: &str) -> String {
    let mut roots = RootCertStore::empty();
    roots.add(node.cert_der.clone().into()).expect("root");
    let config =
        ClientConfig::builder_with_provider(Arc::new(rustls::crypto::ring::default_provider()))
            .with_safe_default_protocol_versions()
            .expect("versions")
            .with_root_certificates(roots)
            .with_no_client_auth();
    let connector = TlsConnector::from(Arc::new(config));
    let tcp = TcpStream::connect(node.addr).await.expect("connect");
    let mut stream = connector
        .connect(ServerName::try_from("localhost").expect("name"), tcp)
        .await
        .expect("TLS handshake");
    stream.write_all(request.as_bytes()).await.expect("send");
    let mut out = Vec::new();
    stream.read_to_end(&mut out).await.ok();
    String::from_utf8_lossy(&out).into_owned()
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn requests_work_over_https() {
    let node = start().await;
    let put = https(
        &node,
        "PUT /v1/kv/secure/1 HTTP/1.1\r\nHost: localhost\r\nContent-Length: 7\r\nConnection: close\r\n\r\n{\"a\":1}",
    )
    .await;
    assert!(put.starts_with("HTTP/1.1 200"), "{put}");
    let get = https(
        &node,
        "GET /v1/kv/secure/1 HTTP/1.1\r\nHost: localhost\r\nConnection: close\r\n\r\n",
    )
    .await;
    assert!(get.starts_with("HTTP/1.1 200"), "{get}");
    assert!(get.contains(r#""value":{"a":1}"#), "{get}");
    node.task.abort();
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn plain_http_is_refused() {
    let node = start().await;
    let mut tcp = TcpStream::connect(node.addr).await.expect("connect");
    tcp.write_all(b"GET /health HTTP/1.1\r\nHost: x\r\nConnection: close\r\n\r\n")
        .await
        .expect("send");
    let mut out = Vec::new();
    let _ =
        tokio::time::timeout(std::time::Duration::from_secs(5), tcp.read_to_end(&mut out)).await;
    assert!(
        !String::from_utf8_lossy(&out).starts_with("HTTP/1.1 200"),
        "a plain HTTP request must not be served on the HTTPS port"
    );
    node.task.abort();
}

#[test]
fn mismatched_or_empty_pem_is_rejected() {
    let a = rcgen::generate_simple_self_signed(vec!["a".into()]).expect("cert");
    let b = rcgen::generate_simple_self_signed(vec!["b".into()]).expect("cert");
    assert!(
        tls::acceptor_from_pem(
            a.cert.pem().as_bytes(),
            b.key_pair.serialize_pem().as_bytes()
        )
        .is_err()
    );
    assert!(tls::acceptor_from_pem(b"", a.key_pair.serialize_pem().as_bytes()).is_err());
}
