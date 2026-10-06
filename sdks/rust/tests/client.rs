//! The client against a real in-process node.

use std::net::SocketAddr;
use std::sync::Arc;
use std::time::Duration;

use celeris_client::{
    BatchOp, Client, DeleteOptions, Error, MutationStatus, Outcome, PutOptions, ScanOptions,
    WatchEvent, WriteOptions,
};
use celeris_server::config::SyncSetting;
use celeris_server::{Config, Node, serve};
use serde_json::{Value, json};
use tokio::net::TcpListener;

struct TestNode {
    url: String,
    task: tokio::task::JoinHandle<anyhow::Result<()>>,
    _dir: tempfile::TempDir,
}

impl Drop for TestNode {
    fn drop(&mut self) {
        self.task.abort();
    }
}

async fn start() -> TestNode {
    start_with(|_| {}).await
}

async fn start_with(customize: impl FnOnce(&mut Node) + Send + 'static) -> TestNode {
    let dir = tempfile::tempdir().expect("tempdir");
    let mut config = Config::default();
    config.node.data_dir = dir.path().to_path_buf();
    config.storage.sync = SyncSetting::Never;
    let listener = TcpListener::bind("127.0.0.1:0").await.expect("bind");
    let addr: SocketAddr = listener.local_addr().expect("addr");
    let node = tokio::task::spawn_blocking(move || {
        let mut node = Node::open(&config, addr.to_string(), None).expect("open");
        customize(&mut node);
        node
    })
    .await
    .expect("join");
    let task = tokio::spawn(serve(
        Arc::new(node),
        listener,
        None,
        std::future::pending(),
    ));
    TestNode {
        url: format!("http://{addr}"),
        task,
        _dir: dir,
    }
}

#[tokio::test]
async fn key_value_round_trip() {
    let node = start().await;
    let db = Client::new(&node.url).expect("client");

    let written = db
        .put("users/1", &json!({"name": "Ada"}))
        .await
        .expect("put");
    assert_eq!(written.key.as_deref(), Some("users/1"));
    assert!(written.version.is_some_and(|v| v > 0));
    assert!(written.replicated && !written.deduplicated);

    let item = db
        .get::<Value>("users/1")
        .await
        .expect("get")
        .expect("present");
    assert_eq!(item.value, json!({"name": "Ada"}));
    assert_eq!(Some(item.version), written.version);
    assert_eq!(item.consistency, "strict");

    #[derive(serde::Deserialize, Debug, PartialEq)]
    struct User {
        name: String,
    }
    let typed = db
        .get::<User>("users/1")
        .await
        .expect("get")
        .expect("present");
    assert_eq!(typed.value, User { name: "Ada".into() });

    db.delete("users/1").await.expect("delete");
    assert!(db.get::<Value>("users/1").await.expect("get").is_none());

    let key = "docs/hello world/ünï?#%";
    db.put(key, &1).await.expect("put");
    assert_eq!(
        db.get::<i64>(key).await.expect("get").map(|i| i.value),
        Some(1)
    );
}

#[tokio::test]
async fn conditions_and_idempotence() {
    let node = start().await;
    let db = Client::new(&node.url).expect("client");

    let first = db
        .put_with(
            "cas",
            &"a",
            PutOptions {
                if_absent: true,
                ..Default::default()
            },
        )
        .await
        .expect("create");
    let err = db
        .put_with(
            "cas",
            &"b",
            PutOptions {
                if_absent: true,
                ..Default::default()
            },
        )
        .await
        .expect_err("exists");
    assert_eq!(
        (err.status(), err.code()),
        (Some(409), Some("condition_failed"))
    );
    let second = db
        .put_with(
            "cas",
            &"b",
            PutOptions {
                if_version: first.version,
                ..Default::default()
            },
        )
        .await
        .expect("cas");
    assert!(second.version > first.version);
    let stale = db
        .delete_with(
            "cas",
            DeleteOptions {
                if_version: first.version,
                ..Default::default()
            },
        )
        .await
        .expect_err("stale");
    assert_eq!(stale.code(), Some("condition_failed"));

    let id = uuid::Uuid::new_v4().to_string();
    let options = PutOptions {
        mutation_id: Some(id.clone()),
        ..Default::default()
    };
    let a = db.put_with("idem", &1, options.clone()).await.expect("put");
    let b = db.put_with("idem", &1, options).await.expect("retry");
    assert!(b.deduplicated);
    assert_eq!(a.version, b.version);
    assert_eq!(
        db.mutation_status(&id).await.expect("status"),
        MutationStatus::Committed { version: a.version }
    );
    assert_eq!(
        db.mutation_status(&uuid::Uuid::new_v4().to_string())
            .await
            .expect("status"),
        MutationStatus::Unknown
    );
}

#[tokio::test]
async fn batches_are_atomic() {
    let node = start().await;
    let db = Client::new(&node.url).expect("client");
    db.put("acct/b", &5).await.expect("put");
    db.batch(
        vec![BatchOp::put("acct/a", json!(1)), BatchOp::delete("acct/b")],
        WriteOptions::default(),
    )
    .await
    .expect("batch");
    assert!(db.get::<Value>("acct/b").await.expect("get").is_none());

    let err = db
        .batch(
            vec![
                BatchOp::put("acct/c", json!(1)),
                BatchOp::Put {
                    key: "acct/a".into(),
                    value: json!(2),
                    ttl_ms: None,
                    if_version: None,
                    if_absent: true,
                },
            ],
            WriteOptions::default(),
        )
        .await
        .expect_err("condition");
    assert_eq!(err.code(), Some("condition_failed"));
    assert!(db.get::<Value>("acct/c").await.expect("get").is_none());
}

#[tokio::test]
async fn scans_page_in_order() {
    let node = start().await;
    let db = Client::new(&node.url).expect("client");
    for i in 0..25 {
        db.put(&format!("scan/{i:02}"), &i).await.expect("put");
    }
    db.put("scan0", &"outside").await.expect("put");
    let options = ScanOptions {
        prefix: Some("scan/".into()),
        limit: Some(10),
        ..Default::default()
    };
    let page = db.scan_page::<i64>(&options, None).await.expect("page");
    assert_eq!(page.items.len(), 10);
    assert_eq!(page.next_cursor.as_deref(), Some("scan/09"));
    let all = db.scan_all::<i64>(&options).await.expect("scan");
    assert_eq!(
        all.iter().map(|i| i.value).collect::<Vec<_>>(),
        (0..25).collect::<Vec<_>>()
    );
}

#[tokio::test]
async fn watch_streams_matching_changes() {
    let node = start().await;
    let db = Client::new(&node.url).expect("client");
    let mut watch = db.watch("live/").await.expect("watch");
    assert!(!watch.partial());

    db.put("live/a", &json!({"v": 1})).await.expect("put");
    db.put("other/a", &1).await.expect("put");
    db.delete("live/a").await.expect("delete");

    let mut events = Vec::new();
    while events.len() < 2 {
        match tokio::time::timeout(Duration::from_secs(5), watch.next())
            .await
            .expect("in time")
            .expect("ok")
        {
            Some(WatchEvent::Change(e)) => events.push((e.key, e.kind, e.value)),
            Some(WatchEvent::Lagged(_)) => panic!("lagged"),
            None => panic!("closed"),
        }
    }
    assert_eq!(
        events,
        vec![
            ("live/a".into(), "put".into(), json!({"v": 1})),
            ("live/a".into(), "delete".into(), Value::Null),
        ]
    );
    watch.close().await;
}

#[tokio::test]
async fn unreachable_nodes_are_skipped_and_reported() {
    let node = start().await;
    // Nothing listens on port 1, so connections are refused (or time out).
    let db = Client::builder()
        .nodes(["http://127.0.0.1:1", node.url.as_str()])
        .timeout(Duration::from_secs(5))
        .build()
        .expect("client");
    db.put("failover", &1)
        .await
        .expect("put via the second node");
    assert!(db.get::<i64>("failover").await.expect("get").is_some());

    let dead = Client::builder()
        .node("http://127.0.0.1:1")
        .attempts(2)
        .timeout(Duration::from_secs(5))
        .build()
        .expect("client");
    match dead.put("x", &1).await {
        Err(Error::Unreachable(_)) => {}
        other => panic!("a write that never connected is not applied: {other:?}"),
    }
}

#[tokio::test]
async fn server_errors_carry_outcomes() {
    let node = start().await;
    let db = Client::new(&node.url).expect("client");
    // An invalid TTL is rejected before anything is applied.
    let err = db
        .put_with(
            "bad",
            &1,
            PutOptions {
                ttl_ms: Some(0),
                ..Default::default()
            },
        )
        .await
        .expect_err("invalid ttl");
    assert_eq!(err.status(), Some(400));
    if let Error::Api { outcome, .. } = &err {
        assert_ne!(*outcome, Some(Outcome::Unknown));
    }
    assert!(db.status().await.expect("status").is_object());
}

#[tokio::test]
async fn tokens_authorize_requests_and_watches() {
    use celeris_server::auth::{Authenticator, Scope, TokenConfig, generate_token, hash_token};
    let token = generate_token();
    let sha256 = hash_token(&token);
    let node = start_with(move |n| {
        n.set_auth(
            Authenticator::new(&[TokenConfig {
                name: "sdk".into(),
                sha256,
                scopes: vec![Scope::Read, Scope::Write],
            }])
            .expect("auth"),
        );
    })
    .await;

    let anonymous = Client::builder()
        .node(&node.url)
        .attempts(1)
        .build()
        .expect("client");
    let err = anonymous.get::<Value>("a").await.expect_err("401");
    assert_eq!((err.status(), err.code()), (Some(401), Some("unauthorized")));

    let db = Client::builder()
        .node(&node.url)
        .token(token)
        .build()
        .expect("client");
    db.put("auth/a", &1).await.expect("put");
    let mut watch = db.watch("auth/").await.expect("watch");
    db.put("auth/b", &2).await.expect("put");
    match tokio::time::timeout(Duration::from_secs(5), watch.next())
        .await
        .expect("in time")
        .expect("ok")
    {
        Some(WatchEvent::Change(e)) => assert_eq!(e.key, "auth/b"),
        other => panic!("unexpected {other:?}"),
    }
}
