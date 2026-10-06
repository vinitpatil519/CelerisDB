//! API tokens: scopes per endpoint, 401 vs 403, public endpoints, admin
//! access without loopback, and the WebSocket query-string token.

use std::sync::Arc;

use axum::Router;
use axum::body::Body;
use axum::http::{Request, StatusCode};
use celeris_core::partition::NodeId;
use celeris_server::auth::{Authenticator, Scope, TokenConfig, generate_token, hash_token};
use celeris_server::{Node, api};
use celeris_storage::{Engine, Options, SyncMode};
use http_body_util::BodyExt;
use serde_json::Value;
use tower::ServiceExt;

struct Tokens {
    reader: String,
    writer: String,
    admin: String,
}

fn app() -> (Router, Tokens, tempfile::TempDir) {
    let dir = tempfile::tempdir().expect("tempdir");
    let engine = Engine::open(
        dir.path(),
        Options {
            sync: SyncMode::Never,
            background_work: false,
            ..Options::default()
        },
    )
    .expect("engine");
    let mut node = Node::new(
        engine,
        NodeId::new("auth-test").expect("id"),
        "127.0.0.1:0".into(),
        Vec::new(),
    );
    let tokens = Tokens {
        reader: generate_token(),
        writer: generate_token(),
        admin: generate_token(),
    };
    let entry = |name: &str, token: &str, scopes: &[Scope]| TokenConfig {
        name: name.into(),
        sha256: hash_token(token),
        scopes: scopes.to_vec(),
    };
    node.set_auth(
        Authenticator::new(&[
            entry("reader", &tokens.reader, &[Scope::Read]),
            entry("writer", &tokens.writer, &[Scope::Read, Scope::Write]),
            entry("ops", &tokens.admin, &[Scope::Admin]),
        ])
        .expect("tokens"),
    );
    (api::router(Arc::new(node)), tokens, dir)
}

async fn call(
    app: &Router,
    method: &str,
    uri: &str,
    token: Option<&str>,
    body: &str,
) -> (StatusCode, Value, Option<String>) {
    let mut req = Request::builder().method(method).uri(uri);
    if let Some(t) = token {
        req = req.header("authorization", format!("Bearer {t}"));
    }
    let resp = app
        .clone()
        .oneshot(req.body(Body::from(body.to_owned())).expect("request"))
        .await
        .expect("response");
    let status = resp.status();
    let challenge = resp
        .headers()
        .get("www-authenticate")
        .map(|v| v.to_str().expect("ascii").to_owned());
    let bytes = resp.into_body().collect().await.expect("body").to_bytes();
    let body = serde_json::from_slice(&bytes).unwrap_or(Value::Null);
    (status, body, challenge)
}

#[tokio::test]
async fn requests_need_a_token_with_the_right_scope() {
    let (app, t, _dir) = app();

    // No token, or an unknown one: 401 with a Bearer challenge.
    let (status, body, challenge) = call(&app, "GET", "/v1/kv/a", None, "").await;
    assert_eq!(status, StatusCode::UNAUTHORIZED);
    assert_eq!(body["error"]["code"], "unauthorized");
    assert!(challenge.is_some_and(|c| c.starts_with("Bearer")));
    let (status, ..) = call(&app, "GET", "/v1/kv/a", Some("cel_nope"), "").await;
    assert_eq!(status, StatusCode::UNAUTHORIZED);

    // A read token reads but cannot write: 403.
    let (status, ..) = call(&app, "GET", "/v1/kv/a", Some(&t.reader), "").await;
    assert_eq!(status, StatusCode::NOT_FOUND);
    let (status, body, _) = call(&app, "PUT", "/v1/kv/a", Some(&t.reader), "1").await;
    assert_eq!(status, StatusCode::FORBIDDEN);
    assert!(
        body["error"]["message"]
            .as_str()
            .is_some_and(|m| m.contains("write"))
    );
    let (status, ..) = call(&app, "POST", "/v1/batch", Some(&t.reader), r#"{"ops":[]}"#).await;
    assert_eq!(status, StatusCode::FORBIDDEN);

    // A write token writes, reads, and clears conflicts.
    let (status, ..) = call(&app, "PUT", "/v1/kv/a", Some(&t.writer), "1").await;
    assert_eq!(status, StatusCode::OK);
    let (status, body, _) = call(&app, "GET", "/v1/kv/a", Some(&t.reader), "").await;
    assert_eq!(
        (status, body["value"].clone()),
        (StatusCode::OK, Value::from(1))
    );
    let (status, ..) = call(&app, "DELETE", "/v1/conflicts/a", Some(&t.reader), "").await;
    assert_eq!(status, StatusCode::FORBIDDEN);
    let (status, ..) = call(&app, "DELETE", "/v1/conflicts/a", Some(&t.writer), "").await;
    assert_eq!(status, StatusCode::OK);

    // Admin scope is separate from read and write.
    let (status, ..) = call(&app, "GET", "/v1/status", Some(&t.admin), "").await;
    assert_eq!(status, StatusCode::FORBIDDEN);
}

#[tokio::test]
async fn health_ready_and_metrics_stay_public() {
    let (app, ..) = app();
    for path in ["/health", "/ready", "/metrics"] {
        let (status, ..) = call(&app, "GET", path, None, "").await;
        assert_eq!(status, StatusCode::OK, "{path}");
    }
}

#[tokio::test]
async fn admin_tokens_work_without_loopback() {
    let (app, t, _dir) = app();
    // The in-process router has no peer address, which used to mean "not
    // loopback". With tokens configured, the admin scope is what counts.
    let (status, ..) = call(&app, "POST", "/v1/admin/shutdown", Some(&t.writer), "").await;
    assert_eq!(status, StatusCode::FORBIDDEN);
    let (status, body, _) = call(&app, "POST", "/v1/admin/shutdown", Some(&t.admin), "").await;
    assert_eq!(status, StatusCode::ACCEPTED, "{body}");
}

#[tokio::test]
async fn watch_accepts_a_query_string_token() {
    let (app, t, _dir) = app();
    // Not a WebSocket upgrade, so a token that passes auth gets 400.
    let (status, ..) = call(&app, "GET", "/v1/watch?prefix=a", None, "").await;
    assert_eq!(status, StatusCode::UNAUTHORIZED);
    let uri = format!("/v1/watch?prefix=a&access_token={}", t.reader);
    let (status, body, _) = call(&app, "GET", &uri, None, "").await;
    assert_eq!(status, StatusCode::BAD_REQUEST);
    assert_eq!(body["error"]["code"], "websocket_required");
    // Other endpoints ignore the query parameter.
    let uri = format!("/v1/kv/a?access_token={}", t.reader);
    let (status, ..) = call(&app, "GET", &uri, None, "").await;
    assert_eq!(status, StatusCode::UNAUTHORIZED);
}
