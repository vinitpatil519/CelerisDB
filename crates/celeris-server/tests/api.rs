//! HTTP API contract tests (in-process, no network) plus one real-socket
//! graceful-shutdown test.

use std::net::SocketAddr;
use std::sync::Arc;
use std::time::Duration;

use axum::Router;
use axum::body::Body;
use axum::extract::connect_info::MockConnectInfo;
use axum::http::{HeaderMap, Request, StatusCode};
use celeris_core::partition::{NodeId, NodeInfo, PartitionMap, partition_for};
use celeris_server::{Config, Node, api, serve};
use celeris_storage::{Clock, Engine, ManualClock, Options, SyncMode, SystemClock};
use http_body_util::BodyExt;
use serde_json::{Value, json};
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tower::ServiceExt;

struct TestNode {
    app: Router,
    node: Arc<Node>,
    _dir: tempfile::TempDir,
}

fn node_with(clock: Arc<dyn Clock>, cors: Vec<String>) -> TestNode {
    let dir = tempfile::tempdir().expect("tempdir");
    let options = Options {
        sync: SyncMode::Never,
        background_work: false,
        ..Options::default()
    };
    let engine = Engine::open_with_clock(dir.path(), options, clock).expect("engine");
    let node = Arc::new(Node::new(
        engine,
        NodeId::new("node-test").expect("node id"),
        "127.0.0.1:0".into(),
        cors,
    ));
    TestNode {
        app: api::router(Arc::clone(&node)),
        node,
        _dir: dir,
    }
}

fn test_node() -> TestNode {
    node_with(Arc::new(SystemClock), Vec::new())
}

struct Resp {
    status: StatusCode,
    headers: HeaderMap,
    body: Value,
}

async fn call(
    app: &Router,
    method: &str,
    uri: &str,
    headers: &[(&str, &str)],
    body: Option<&str>,
) -> Resp {
    let mut req = Request::builder().method(method).uri(uri);
    for (k, v) in headers {
        req = req.header(*k, *v);
    }
    let req = req
        .body(body.map_or_else(Body::empty, |b| Body::from(b.to_owned())))
        .expect("request");
    let resp = app.clone().oneshot(req).await.expect("infallible");
    let status = resp.status();
    let headers = resp.headers().clone();
    let bytes = resp.into_body().collect().await.expect("body").to_bytes();
    let body = serde_json::from_slice(&bytes)
        .unwrap_or_else(|_| Value::String(String::from_utf8_lossy(&bytes).into_owned()));
    Resp {
        status,
        headers,
        body,
    }
}

async fn put(app: &Router, uri: &str, body: &str) -> Resp {
    call(app, "PUT", uri, &[], Some(body)).await
}

async fn get(app: &Router, uri: &str) -> Resp {
    call(app, "GET", uri, &[], None).await
}

const JSON: (&str, &str) = ("content-type", "application/json");

#[tokio::test]
async fn put_then_get_round_trips_json_documents() {
    let n = test_node();
    let doc = json!({"name": "Vinit", "tags": ["a", "b"], "n": 1.5, "nested": {"ok": true}});
    let w = put(&n.app, "/v1/kv/users/42", &doc.to_string()).await;
    assert_eq!(w.status, StatusCode::OK, "{:?}", w.body);
    let version = w.body["version"].as_u64().expect("version");
    assert_eq!(w.body["key"], "users/42");
    assert_eq!(w.body["consistency"], "strict");
    assert_eq!(w.body["deduplicated"], false);
    assert_eq!(w.headers["celeris-version"], version.to_string().as_str());
    assert_eq!(w.headers["celeris-consistency"], "strict");
    assert!(w.headers.contains_key("celeris-mutation-id"));

    let r = get(&n.app, "/v1/kv/users/42").await;
    assert_eq!(r.status, StatusCode::OK);
    assert_eq!(r.body["value"], doc);
    assert_eq!(r.body["version"], version);
    assert_eq!(r.body["mutation_id"], w.body["mutation_id"]);
    assert!(r.body["expires_at_ms"].is_null());
}

#[tokio::test]
async fn keys_are_percent_decoded_and_may_contain_slashes() {
    let n = test_node();
    assert_eq!(
        put(&n.app, "/v1/kv/a%20b/c%3Fd", "1").await.status,
        StatusCode::OK
    );
    let r = get(&n.app, "/v1/kv/a%20b/c%3Fd").await;
    assert_eq!(r.body["key"], "a b/c?d");
    let s = get(&n.app, "/v1/scan").await;
    assert_eq!(s.body["items"][0]["key"], "a b/c?d");
}

#[tokio::test]
async fn invalid_input_is_rejected_with_not_applied_outcome() {
    let n = test_node();
    let bad_json = put(&n.app, "/v1/kv/k", "{not json").await;
    assert_eq!(bad_json.status, StatusCode::BAD_REQUEST);
    assert_eq!(bad_json.body["error"]["code"], "invalid_json");
    assert_eq!(bad_json.body["error"]["outcome"], "not_applied");

    let reserved = put(&n.app, "/v1/kv/%00internal", "1").await;
    assert_eq!(reserved.status, StatusCode::BAD_REQUEST);
    assert_eq!(reserved.body["error"]["code"], "invalid_key");

    let unknown_param = put(&n.app, "/v1/kv/k?colour=blue", "1").await;
    assert_eq!(unknown_param.status, StatusCode::BAD_REQUEST);
    assert_eq!(unknown_param.body["error"]["code"], "invalid_query");

    let bad_id = call(
        &n.app,
        "PUT",
        "/v1/kv/k",
        &[("celeris-mutation-id", "nope")],
        Some("1"),
    )
    .await;
    assert_eq!(bad_id.body["error"]["code"], "invalid_mutation_id");

    let both = put(&n.app, "/v1/kv/k?if_version=1&if_absent=true", "1").await;
    assert_eq!(both.status, StatusCode::BAD_REQUEST);

    let zero_ttl = put(&n.app, "/v1/kv/k?ttl_ms=0", "1").await;
    assert_eq!(zero_ttl.status, StatusCode::BAD_REQUEST);
    assert_eq!(get(&n.app, "/v1/kv/k").await.status, StatusCode::NOT_FOUND);
}

#[tokio::test]
async fn missing_keys_are_404() {
    let n = test_node();
    let r = get(&n.app, "/v1/kv/nope").await;
    assert_eq!(r.status, StatusCode::NOT_FOUND);
    assert_eq!(r.body["error"]["code"], "not_found");
}

#[tokio::test]
async fn conditional_writes_report_the_current_version() {
    let n = test_node();
    let first = put(&n.app, "/v1/kv/lock?if_absent=true", "\"a\"").await;
    assert_eq!(first.status, StatusCode::OK);
    let v1 = first.body["version"].as_u64().expect("version");

    let again = put(&n.app, "/v1/kv/lock?if_absent=true", "\"b\"").await;
    assert_eq!(again.status, StatusCode::CONFLICT);
    assert_eq!(again.body["error"]["code"], "condition_failed");
    assert_eq!(again.body["error"]["current_version"], v1);
    assert_eq!(again.body["error"]["outcome"], "not_applied");

    let cas = put(&n.app, &format!("/v1/kv/lock?if_version={v1}"), "\"c\"").await;
    assert_eq!(cas.status, StatusCode::OK);
    let stale = put(&n.app, &format!("/v1/kv/lock?if_version={v1}"), "\"d\"").await;
    assert_eq!(stale.status, StatusCode::CONFLICT);

    let missing = put(&n.app, "/v1/kv/other?if_version=1", "1").await;
    assert_eq!(missing.body["error"]["current_version"], Value::Null);

    let del = call(
        &n.app,
        "DELETE",
        &format!("/v1/kv/lock?if_version={v1}"),
        &[],
        None,
    )
    .await;
    assert_eq!(del.status, StatusCode::CONFLICT);
    assert_eq!(get(&n.app, "/v1/kv/lock").await.body["value"], "c");
}

#[tokio::test]
async fn retries_with_the_same_mutation_id_are_idempotent() {
    let n = test_node();
    let id = "6f1c8e1a-3b7e-4c47-9d64-1f7f5ef0a001";
    let headers = [("celeris-mutation-id", id)];
    let first = call(&n.app, "PUT", "/v1/kv/counter", &headers, Some("1")).await;
    assert_eq!(first.body["mutation_id"], id);
    put(&n.app, "/v1/kv/counter", "2").await;

    let retry = call(&n.app, "PUT", "/v1/kv/counter", &headers, Some("1")).await;
    assert_eq!(retry.status, StatusCode::OK);
    assert_eq!(retry.body["deduplicated"], true);
    assert_eq!(retry.body["version"], first.body["version"]);
    assert_eq!(
        get(&n.app, "/v1/kv/counter").await.body["value"],
        2,
        "late retry must not clobber"
    );

    let reused = call(&n.app, "PUT", "/v1/kv/counter", &headers, Some("99")).await;
    assert_eq!(reused.status, StatusCode::UNPROCESSABLE_ENTITY);
    assert_eq!(reused.body["error"]["code"], "mutation_id_reused");

    let status = get(&n.app, &format!("/v1/mutations/{id}")).await;
    assert_eq!(status.status, StatusCode::OK);
    assert_eq!(status.body["status"], "committed");
    assert_eq!(status.body["version"], first.body["version"]);

    let unknown = get(&n.app, "/v1/mutations/00000000-0000-4000-8000-000000000000").await;
    assert_eq!(unknown.status, StatusCode::NOT_FOUND);
    assert_eq!(unknown.body["status"], "unknown");
    assert_eq!(
        get(&n.app, "/v1/mutations/xyz").await.status,
        StatusCode::BAD_REQUEST
    );
}

#[tokio::test]
async fn delete_removes_keys() {
    let n = test_node();
    put(&n.app, "/v1/kv/k", "1").await;
    let d = call(&n.app, "DELETE", "/v1/kv/k", &[], None).await;
    assert_eq!(d.status, StatusCode::OK);
    assert_eq!(d.body["key"], "k");
    assert_eq!(get(&n.app, "/v1/kv/k").await.status, StatusCode::NOT_FOUND);
}

#[tokio::test]
async fn batches_are_atomic() {
    let n = test_node();
    put(&n.app, "/v1/kv/existing", "0").await;
    let failing = json!({"ops": [
        {"op": "put", "key": "a", "value": 1},
        {"op": "put", "key": "existing", "value": 2, "if_absent": true},
    ]});
    let r = call(
        &n.app,
        "POST",
        "/v1/batch",
        &[JSON],
        Some(&failing.to_string()),
    )
    .await;
    assert_eq!(r.status, StatusCode::CONFLICT);
    assert_eq!(r.body["error"]["outcome"], "not_applied");
    assert_eq!(get(&n.app, "/v1/kv/a").await.status, StatusCode::NOT_FOUND);

    let id = "0d4ad6d5-6f0a-4c3e-8b8c-2b5a6f000002";
    let ok = json!({"mutation_id": id, "consistency": "available", "ops": [
        {"op": "put", "key": "a", "value": {"x": 1}, "ttl_ms": 60000},
        {"op": "put", "key": "b", "value": [1, 2]},
        {"op": "delete", "key": "existing"},
    ]});
    let r = call(&n.app, "POST", "/v1/batch", &[JSON], Some(&ok.to_string())).await;
    assert_eq!(r.status, StatusCode::OK, "{:?}", r.body);
    assert_eq!(r.body["consistency"], "available");
    assert!(r.body.get("key").is_none());
    let a = get(&n.app, "/v1/kv/a").await;
    let b = get(&n.app, "/v1/kv/b").await;
    assert_eq!(a.body["value"], json!({"x": 1}));
    assert_eq!(
        a.body["version"], b.body["version"],
        "one batch, one commit version"
    );
    assert!(a.body["expires_at_ms"].is_u64());
    assert_eq!(
        get(&n.app, "/v1/kv/existing").await.status,
        StatusCode::NOT_FOUND
    );

    let retry = call(&n.app, "POST", "/v1/batch", &[JSON], Some(&ok.to_string())).await;
    assert_eq!(retry.body["deduplicated"], true);

    let empty = call(&n.app, "POST", "/v1/batch", &[JSON], Some(r#"{"ops": []}"#)).await;
    assert_eq!(empty.status, StatusCode::BAD_REQUEST);
    let bad_op = call(
        &n.app,
        "POST",
        "/v1/batch",
        &[JSON],
        Some(r#"{"ops": [{"op": "frobnicate"}]}"#),
    )
    .await;
    assert!(bad_op.status.is_client_error());
    assert_eq!(bad_op.body["error"]["code"], "invalid_json");
}

#[tokio::test]
async fn scans_paginate_with_cursors() {
    let n = test_node();
    for i in 0..25 {
        put(&n.app, &format!("/v1/kv/p/{i:02}"), &i.to_string()).await;
    }
    put(&n.app, "/v1/kv/q/0", "0").await;
    put(&n.app, "/v1/kv/o/0", "0").await;

    let mut seen = Vec::new();
    let mut cursor: Option<String> = None;
    loop {
        let uri = match &cursor {
            Some(c) => format!("/v1/scan?prefix=p/&limit=10&after={c}"),
            None => "/v1/scan?prefix=p/&limit=10".to_owned(),
        };
        let page = get(&n.app, &uri).await;
        assert_eq!(page.status, StatusCode::OK, "{:?}", page.body);
        for item in page.body["items"].as_array().expect("items") {
            seen.push(item["key"].as_str().expect("key").to_owned());
        }
        match page.body["next_cursor"].as_str() {
            Some(c) => cursor = Some(c.to_owned()),
            None => break,
        }
    }
    let expected: Vec<String> = (0..25).map(|i| format!("p/{i:02}")).collect();
    assert_eq!(seen, expected);

    let range = get(&n.app, "/v1/scan?start=p/10&end=p/13").await;
    assert_eq!(range.body["items"].as_array().map(Vec::len), Some(3));
    assert_eq!(
        get(&n.app, "/v1/scan?prefix=p/&start=a").await.status,
        StatusCode::BAD_REQUEST
    );
    assert_eq!(
        get(&n.app, "/v1/scan?limit=0").await.status,
        StatusCode::BAD_REQUEST
    );
    assert_eq!(
        get(&n.app, "/v1/scan?limit=1001").await.status,
        StatusCode::BAD_REQUEST
    );
}

#[tokio::test]
async fn ttl_expiry_is_visible_over_http() {
    let clock = Arc::new(ManualClock::new(1_000_000));
    let n = node_with(clock.clone(), Vec::new());
    put(&n.app, "/v1/kv/session?ttl_ms=1000", "\"tok\"").await;
    let r = get(&n.app, "/v1/kv/session").await;
    assert_eq!(r.body["expires_at_ms"], 1_001_000);
    clock.advance(Duration::from_secs(2));
    assert_eq!(
        get(&n.app, "/v1/kv/session").await.status,
        StatusCode::NOT_FOUND
    );
}

#[tokio::test]
async fn consistency_modes_are_validated_and_reported() {
    let n = test_node();
    let w = put(&n.app, "/v1/kv/k?consistency=eventual", "1").await;
    assert_eq!(w.body["consistency"], "eventual");
    assert_eq!(w.headers["celeris-consistency"], "eventual");

    let bounded_write = put(&n.app, "/v1/kv/k?consistency=bounded", "1").await;
    assert_eq!(bounded_write.body["error"]["code"], "invalid_consistency");
    let bogus = get(&n.app, "/v1/kv/k?consistency=linearizable").await;
    assert_eq!(bogus.body["error"]["code"], "invalid_consistency");
    let no_bound = get(&n.app, "/v1/kv/k?consistency=bounded").await;
    assert_eq!(no_bound.status, StatusCode::BAD_REQUEST);
    let stray_bound = get(&n.app, "/v1/kv/k?consistency=strict&max_staleness_ms=5").await;
    assert_eq!(stray_bound.status, StatusCode::BAD_REQUEST);

    let bounded = get(&n.app, "/v1/kv/k?consistency=BOUNDED&max_staleness_ms=500").await;
    assert_eq!(bounded.status, StatusCode::OK);
    assert_eq!(bounded.body["consistency"], "bounded");
    assert_eq!(bounded.body["staleness_ms"], 0);
    let strict = get(&n.app, "/v1/kv/k").await;
    assert!(strict.body.get("staleness_ms").is_none());
}

#[tokio::test]
async fn requests_are_fenced_to_the_partition_leader() {
    let n = test_node();
    let me = NodeId::new("node-test").expect("id");
    let other = NodeId::new("node-other").expect("id");
    let two = vec![
        NodeInfo::new(me.clone(), "z1"),
        NodeInfo::new(other.clone(), "z2"),
    ];
    let map = PartitionMap::new(two.clone(), 1).expect("map");
    let led_by = |m: &PartitionMap, who: &NodeId| {
        (0..)
            .map(|i| format!("k{i}"))
            .find(|k| m.route(k.as_bytes()).replicas[0] == *who)
            .expect("some key")
    };
    let mine = led_by(&map, &me);
    let theirs = led_by(&map, &other);
    n.node.install_partition_map(map.clone());

    let ok = put(&n.app, &format!("/v1/kv/{mine}"), "1").await;
    assert_eq!(ok.status, StatusCode::OK);
    let partition = partition_for(mine.as_bytes()).get().to_string();
    assert_eq!(ok.headers["celeris-partition"], partition.as_str());
    assert_eq!(ok.headers["celeris-partition-epoch"], "1");
    assert_eq!(
        get(&n.app, &format!("/v1/kv/{mine}")).await.status,
        StatusCode::OK
    );

    let misdirected = put(&n.app, &format!("/v1/kv/{theirs}"), "1").await;
    assert_eq!(misdirected.status, StatusCode::MISDIRECTED_REQUEST);
    assert_eq!(misdirected.body["error"]["code"], "not_owner");
    assert_eq!(misdirected.body["error"]["leader"], "node-other");
    assert_eq!(misdirected.body["error"]["outcome"], "not_applied");
    assert_eq!(
        get(&n.app, &format!("/v1/kv/{theirs}")).await.status,
        StatusCode::MISDIRECTED_REQUEST
    );

    let batch = json!({"ops": [
        {"op": "put", "key": mine, "value": 2},
        {"op": "put", "key": theirs, "value": 2},
    ]});
    let r = call(
        &n.app,
        "POST",
        "/v1/batch",
        &[JSON],
        Some(&batch.to_string()),
    )
    .await;
    assert_eq!(
        r.status,
        StatusCode::MISDIRECTED_REQUEST,
        "batches must stay on one leader"
    );
    assert_eq!(
        get(&n.app, &format!("/v1/kv/{mine}")).await.body["value"],
        1
    );

    let scan = get(&n.app, "/v1/scan").await;
    assert_eq!(scan.body["partial"], true);

    // Epoch fencing: `node-other` leaves, so its partitions (including
    // `theirs`) move to this node at epoch 2. A client still routing with
    // epoch 1 for that partition is told to refresh.
    let (map2, moves) = map
        .rebalance(vec![NodeInfo::new(me.clone(), "z1")], 1)
        .expect("rebalance");
    let moved_partition = partition_for(theirs.as_bytes());
    assert!(moves.iter().any(|m| m.partition == moved_partition));
    assert_eq!(map2.partition_epoch(moved_partition), 2);
    n.node.install_partition_map(map2);
    let uri = format!("/v1/kv/{theirs}");
    let stale = call(
        &n.app,
        "PUT",
        &uri,
        &[("celeris-partition-epoch", "1")],
        Some("1"),
    )
    .await;
    assert_eq!(stale.status, StatusCode::CONFLICT);
    assert_eq!(stale.body["error"]["code"], "stale_epoch");
    assert_eq!(stale.body["error"]["partition_epoch"], 2);
    let ahead = call(
        &n.app,
        "PUT",
        &uri,
        &[("celeris-partition-epoch", "3")],
        Some("1"),
    )
    .await;
    assert_eq!(ahead.status, StatusCode::SERVICE_UNAVAILABLE);
    assert_eq!(ahead.body["error"]["code"], "epoch_ahead");
    let current = call(
        &n.app,
        "PUT",
        &uri,
        &[("celeris-partition-epoch", "2")],
        Some("1"),
    )
    .await;
    assert_eq!(current.status, StatusCode::OK);
    let bad = call(
        &n.app,
        "GET",
        &uri,
        &[("celeris-partition-epoch", "x")],
        None,
    )
    .await;
    assert_eq!(bad.status, StatusCode::BAD_REQUEST);
}

#[tokio::test]
async fn partition_map_and_key_routing() {
    let n = test_node();
    let summary = get(&n.app, "/v1/partitions").await;
    assert_eq!(summary.body["count"], 4096);
    assert_eq!(summary.body["epoch"], 1);
    assert_eq!(summary.body["replication_factor"], 1);
    assert_eq!(summary.body["nodes"][0]["id"], "node-test");
    assert_eq!(summary.body["nodes"][0]["replicas"], 4096);
    assert_eq!(summary.body["nodes"][0]["leaders"], 4096);

    let route = get(&n.app, "/v1/partitions/key/users/42").await;
    assert_eq!(route.status, StatusCode::OK);
    assert_eq!(route.body["partition"], partition_for(b"users/42").get());
    assert_eq!(route.body["partition"], 1118, "pinned key hash");
    assert_eq!(route.body["leader"], "node-test");
    assert_eq!(route.body["replicas"], json!(["node-test"]));
    assert_eq!(route.body["partition_epoch"], 1);
    assert_eq!(
        get(&n.app, "/v1/partitions/key/%00x").await.status,
        StatusCode::BAD_REQUEST
    );

    let status = get(&n.app, "/v1/status").await;
    assert_eq!(status.body["partitions"]["count"], 4096);
}

#[tokio::test]
async fn health_ready_and_status() {
    let n = test_node();
    let h = get(&n.app, "/health").await;
    assert_eq!(h.body, json!({"status": "ok", "node_id": "node-test"}));
    assert_eq!(get(&n.app, "/ready").await.status, StatusCode::OK);
    put(&n.app, "/v1/kv/k", "1").await;
    let s = get(&n.app, "/v1/status").await;
    assert_eq!(s.body["node_id"], "node-test");
    assert_eq!(s.body["health"], "healthy");
    assert_eq!(s.body["cluster"]["mode"], "single-node");
    assert_eq!(s.body["cluster"]["nodes"][0]["id"], "node-test");
    assert_eq!(s.body["storage"]["last_version"], 1);
    assert_eq!(
        s.body["consistency_modes"].as_array().map(Vec::len),
        Some(5)
    );
}

#[tokio::test]
async fn metrics_are_prometheus_text() {
    let n = test_node();
    put(&n.app, "/v1/kv/k", "1").await;
    get(&n.app, "/v1/kv/k").await;
    get(&n.app, "/v1/kv/missing").await;
    let m = get(&n.app, "/metrics").await;
    assert_eq!(m.status, StatusCode::OK);
    assert!(
        m.headers["content-type"]
            .to_str()
            .expect("ascii")
            .starts_with("text/plain")
    );
    let text = m.body.as_str().expect("text body");
    assert!(text.contains(
        r#"celeris_http_requests_total{route="/v1/kv/{*key}",method="PUT",status="200"} 1"#
    ));
    assert!(text.contains(
        r#"celeris_http_requests_total{route="/v1/kv/{*key}",method="GET",status="404"} 1"#
    ));
    assert!(
        text.contains(r#"celeris_operations_by_consistency_total{mode="strict",kind="write"} 1"#)
    );
    assert!(text.contains("celeris_storage_write_batches_total 1"));
    assert!(text.contains("celeris_storage_read_only 0"));
    assert!(text.contains(r#"celeris_node_info{node_id="node-test""#));
}

#[tokio::test]
async fn admin_shutdown_is_loopback_only() {
    let n = test_node();
    let no_peer = call(&n.app, "POST", "/v1/admin/shutdown", &[], None).await;
    assert_eq!(no_peer.status, StatusCode::FORBIDDEN);

    let remote = n
        .app
        .clone()
        .layer(MockConnectInfo(SocketAddr::from(([10, 0, 0, 7], 4000))));
    assert_eq!(
        call(&remote, "POST", "/v1/admin/shutdown", &[], None)
            .await
            .status,
        StatusCode::FORBIDDEN
    );

    let local = n
        .app
        .clone()
        .layer(MockConnectInfo(SocketAddr::from(([127, 0, 0, 1], 4000))));
    let r = call(&local, "POST", "/v1/admin/shutdown", &[], None).await;
    assert_eq!(r.status, StatusCode::ACCEPTED);
    assert_eq!(r.body["status"], "shutting_down");
}

#[tokio::test]
async fn cors_preflight_when_configured() {
    let n = node_with(Arc::new(SystemClock), vec!["http://localhost:5173".into()]);
    let r = call(
        &n.app,
        "OPTIONS",
        "/v1/kv/k",
        &[
            ("origin", "http://localhost:5173"),
            ("access-control-request-method", "PUT"),
        ],
        None,
    )
    .await;
    assert_eq!(
        r.headers["access-control-allow-origin"],
        "http://localhost:5173"
    );

    let plain = test_node();
    let r = call(
        &plain.app,
        "GET",
        "/health",
        &[("origin", "http://evil.test")],
        None,
    )
    .await;
    assert!(
        !r.headers.contains_key("access-control-allow-origin"),
        "CORS off by default"
    );
}

#[tokio::test]
async fn real_socket_serve_and_graceful_shutdown_preserve_data_and_identity() {
    let dir = tempfile::tempdir().expect("tempdir");
    let mut config = Config::default();
    config.node.data_dir = dir.path().to_path_buf();
    config.storage.sync = celeris_server::config::SyncSetting::Never;

    let open = |config: Config| async move {
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0")
            .await
            .expect("bind");
        let addr = listener.local_addr().expect("addr");
        let node = tokio::task::spawn_blocking(move || Node::open(&config, addr.to_string(), None))
            .await
            .expect("join")
            .expect("open");
        let id = node.id().to_owned();
        let server = tokio::spawn(serve(
            Arc::new(node),
            listener,
            None,
            std::future::pending(),
        ));
        (addr, id, server)
    };
    let raw = |addr: SocketAddr, request: String| async move {
        let mut stream = tokio::net::TcpStream::connect(addr).await.expect("connect");
        stream.write_all(request.as_bytes()).await.expect("send");
        let mut out = String::new();
        stream.read_to_string(&mut out).await.expect("read");
        out
    };

    let (addr, first_id, server) = open(config.clone()).await;
    let put = raw(
        addr,
        "PUT /v1/kv/persist HTTP/1.1\r\nHost: x\r\nContent-Length: 4\r\nConnection: close\r\n\r\ntrue".into(),
    )
    .await;
    assert!(put.starts_with("HTTP/1.1 200"), "{put}");
    let stop = raw(
        addr,
        "POST /v1/admin/shutdown HTTP/1.1\r\nHost: x\r\nContent-Length: 0\r\nConnection: close\r\n\r\n".into(),
    )
    .await;
    assert!(stop.starts_with("HTTP/1.1 202"), "{stop}");
    tokio::time::timeout(Duration::from_secs(10), server)
        .await
        .expect("server stops after shutdown request")
        .expect("join")
        .expect("serve ok");

    let (addr, second_id, server) = open(config).await;
    assert_eq!(first_id, second_id, "node identity survives restart");
    let get = raw(
        addr,
        "GET /v1/kv/persist HTTP/1.1\r\nHost: x\r\nConnection: close\r\n\r\n".into(),
    )
    .await;
    assert!(get.contains(r#""value":true"#), "{get}");
    server.abort();
}
