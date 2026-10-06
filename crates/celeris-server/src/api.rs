//! HTTP/JSON client API. Contract: `docs/API.md`.

use std::net::SocketAddr;
use std::ops::Bound;
use std::sync::Arc;
use std::time::{Duration, Instant};

use axum::body::Bytes;
use axum::extract::rejection::{ExtensionRejection, JsonRejection, PathRejection, QueryRejection};
use axum::extract::ws::rejection::WebSocketUpgradeRejection;
use axum::extract::ws::{Message, WebSocket, WebSocketUpgrade};
use axum::extract::{ConnectInfo, DefaultBodyLimit, MatchedPath, Path, Query, Request, State};
use axum::http::{HeaderMap, HeaderName, HeaderValue, StatusCode, header};
use axum::middleware::{self, Next};
use axum::response::{IntoResponse, Response};
use axum::routing::{delete, get, post};
use axum::{Json, Router};
use celeris_cluster::MemberState;
use celeris_cluster::raft::Role;
use celeris_core::partition::{EpochMismatch, PARTITION_COUNT, PartitionId, Route};
use celeris_core::{Consistency, MutationId};
use celeris_storage::{Condition, Op, WriteBatch, prefix_successor};
use serde::{Deserialize, Serialize};
use serde_json::value::RawValue;
use serde_json::{Value, json};
use tower_http::cors::{AllowOrigin, Any, CorsLayer};

use crate::auth::{Denied, Scope};
use crate::error::ApiError;
use crate::groups::WireOp;
use crate::node::{Node, ProposeError};
use crate::{available, replicated};

/// Client-chosen mutation ID (UUID). Retrying with the same ID is safe.
pub const MUTATION_ID_HEADER: &str = "celeris-mutation-id";
/// Commit version of the value returned or written.
pub const VERSION_HEADER: &str = "celeris-version";
/// Consistency mode actually applied.
pub const CONSISTENCY_HEADER: &str = "celeris-consistency";

const MAX_BODY_BYTES: usize = 40 * 1024 * 1024;
const DEFAULT_SCAN_LIMIT: usize = 100;
const MAX_SCAN_LIMIT: usize = 1000;
const DEFAULT_MAX_SCANNED: usize = 10_000;
const MAX_MAX_SCANNED: usize = 100_000;

type AppState = Arc<Node>;

pub fn router(node: Arc<Node>) -> Router {
    let mut app = Router::new()
        .route("/v1/kv/{*key}", get(get_kv).put(put_kv).delete(delete_kv))
        .route("/v1/batch", post(batch))
        .route("/v1/scan", get(scan))
        .route("/v1/query", post(query))
        .route("/v1/mutations/{id}", get(mutation_status))
        .route("/v1/conflicts", get(list_conflicts))
        .route("/v1/watch", get(watch))
        .route("/v1/conflicts/{*key}", delete(clear_conflicts))
        .route("/v1/status", get(status))
        .route("/v1/partitions", get(partitions))
        .route("/v1/partitions/key/{*key}", get(partition_for_key))
        .route("/v1/admin/shutdown", post(shutdown))
        .route("/v1/admin/rebalance", post(rebalance))
        .route("/v1/admin/backup", get(backup))
        .route("/health", get(health))
        .route("/ready", get(ready))
        .route("/metrics", get(metrics))
        .route_layer(middleware::from_fn_with_state(Arc::clone(&node), authorize))
        .route_layer(middleware::from_fn_with_state(
            Arc::clone(&node),
            track_metrics,
        ))
        .layer(DefaultBodyLimit::max(MAX_BODY_BYTES));
    if let Some(cors) = cors_layer(node.cors_origins()) {
        app = app.layer(cors);
    }
    app.with_state(node)
}

fn cors_layer(origins: &[String]) -> Option<CorsLayer> {
    if origins.is_empty() {
        return None;
    }
    let allow = if origins.iter().any(|o| o == "*") {
        AllowOrigin::any()
    } else {
        AllowOrigin::list(origins.iter().filter_map(|o| HeaderValue::from_str(o).ok()))
    };
    Some(
        CorsLayer::new()
            .allow_origin(allow)
            .allow_methods(Any)
            .allow_headers(Any)
            .expose_headers([
                HeaderName::from_static(MUTATION_ID_HEADER),
                HeaderName::from_static(VERSION_HEADER),
                HeaderName::from_static(CONSISTENCY_HEADER),
            ]),
    )
}

/// The scope a request needs, or `None` for public endpoints (health,
/// readiness and metrics carry no data).
fn required_scope(method: &axum::http::Method, route: &str) -> Option<Scope> {
    use axum::http::Method;
    match route {
        "/health" | "/ready" | "/metrics" => None,
        r if r.starts_with("/v1/admin/") => Some(Scope::Admin),
        "/v1/batch" => Some(Scope::Write),
        "/v1/kv/{*key}" | "/v1/conflicts/{*key}"
            if *method == Method::PUT || *method == Method::DELETE =>
        {
            Some(Scope::Write)
        }
        _ => Some(Scope::Read),
    }
}

/// The bearer token of a request. Browsers cannot set headers on a
/// WebSocket, so `/v1/watch` also accepts `?access_token=`.
fn presented_token(req: &Request, route: &str) -> Option<String> {
    let header = req
        .headers()
        .get(header::AUTHORIZATION)
        .and_then(|v| v.to_str().ok())
        .and_then(|v| {
            v.strip_prefix("Bearer ")
                .or_else(|| v.strip_prefix("bearer "))
        })
        .map(|t| t.trim().to_owned());
    if header.is_some() || route != "/v1/watch" {
        return header;
    }
    req.uri().query().and_then(|q| {
        q.split('&')
            .find_map(|pair| pair.strip_prefix("access_token="))
            .map(str::to_owned)
    })
}

/// Enforces API tokens when any are configured (see `auth.rs`).
async fn authorize(State(node): State<AppState>, mut req: Request, next: Next) -> Response {
    if !node.auth().enabled() {
        return next.run(req).await;
    }
    let route = req
        .extensions()
        .get::<MatchedPath>()
        .map_or_else(String::new, |m| m.as_str().to_owned());
    let Some(scope) = required_scope(req.method(), &route) else {
        return next.run(req).await;
    };
    let token = presented_token(&req, &route);
    match node.auth().authorize(token.as_deref(), scope) {
        Ok(principal) => {
            if let Some(principal) = principal {
                req.extensions_mut().insert(principal);
            }
            next.run(req).await
        }
        Err(Denied::Unauthenticated) => {
            let mut resp = ApiError::new(
                StatusCode::UNAUTHORIZED,
                "unauthorized",
                "a valid API token is required: send `Authorization: Bearer <token>`",
            )
            .into_response();
            resp.headers_mut().insert(
                header::WWW_AUTHENTICATE,
                HeaderValue::from_static("Bearer realm=\"celeris\""),
            );
            resp
        }
        Err(Denied::Forbidden { name, needs }) => {
            ApiError::forbidden(format!("token `{name}` does not have the `{needs}` scope"))
                .into_response()
        }
    }
}

/// Admin endpoints: with authentication on, the middleware has checked the
/// `admin` scope; without it, only loopback connections are accepted.
fn admin_allowed(
    node: &Node,
    peer: &Result<ConnectInfo<SocketAddr>, ExtensionRejection>,
) -> Result<(), ApiError> {
    if node.auth().enabled()
        || peer
            .as_ref()
            .is_ok_and(|ConnectInfo(addr)| addr.ip().is_loopback())
    {
        Ok(())
    } else {
        Err(ApiError::forbidden(
            "admin endpoints accept loopback connections only, unless API tokens are configured",
        ))
    }
}

async fn track_metrics(State(node): State<AppState>, req: Request, next: Next) -> Response {
    let route = req
        .extensions()
        .get::<MatchedPath>()
        .map_or_else(|| "unmatched".to_owned(), |m| m.as_str().to_owned());
    let method = req.method().clone();
    let started = Instant::now();
    let resp = next.run(req).await;
    node.metrics().record_request(
        &route,
        method.as_str(),
        resp.status().as_u16(),
        started.elapsed(),
    );
    resp
}

// ---------------------------------------------------------------- parameters

#[derive(Debug, Default, Deserialize)]
#[serde(deny_unknown_fields)]
struct ReadParams {
    consistency: Option<String>,
    max_staleness_ms: Option<u64>,
}

#[derive(Debug, Default, Deserialize)]
#[serde(deny_unknown_fields)]
struct PutParams {
    consistency: Option<String>,
    ttl_ms: Option<u64>,
    if_version: Option<u64>,
    if_absent: Option<bool>,
}

#[derive(Debug, Default, Deserialize)]
#[serde(deny_unknown_fields)]
struct DeleteParams {
    consistency: Option<String>,
    if_version: Option<u64>,
}

#[derive(Debug, Default, Deserialize)]
#[serde(deny_unknown_fields)]
struct ScanParams {
    prefix: Option<String>,
    start: Option<String>,
    end: Option<String>,
    after: Option<String>,
    limit: Option<usize>,
    consistency: Option<String>,
    max_staleness_ms: Option<u64>,
}

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
struct BatchRequest {
    mutation_id: Option<String>,
    consistency: Option<String>,
    ops: Vec<BatchOp>,
}

#[derive(Debug, Deserialize)]
#[serde(tag = "op", rename_all = "lowercase", deny_unknown_fields)]
enum BatchOp {
    Put {
        key: String,
        value: Value,
        ttl_ms: Option<u64>,
        if_version: Option<u64>,
        if_absent: Option<bool>,
    },
    Delete {
        key: String,
        if_version: Option<u64>,
    },
}

fn parse_mode(raw: Option<&str>) -> Result<Consistency, ApiError> {
    raw.map_or(Ok(Consistency::Strict), |s| {
        s.parse().map_err(|e: celeris_core::ParseConsistencyError| {
            ApiError::bad_request("invalid_consistency", e.to_string())
        })
    })
}

/// Bounded reads must state their bound; the bound is meaningless elsewhere.
fn read_mode(raw: Option<&str>, max_staleness_ms: Option<u64>) -> Result<Consistency, ApiError> {
    let mode = parse_mode(raw)?;
    match (mode, max_staleness_ms) {
        (Consistency::Bounded, None) => Err(ApiError::bad_request(
            "invalid_argument",
            "bounded reads require max_staleness_ms",
        )),
        (m, Some(_)) if m != Consistency::Bounded => Err(ApiError::bad_request(
            "invalid_argument",
            "max_staleness_ms only applies to consistency=bounded",
        )),
        _ => Ok(mode),
    }
}

/// `bounded` describes read freshness and has no meaning for writes.
fn write_mode(raw: Option<&str>) -> Result<Consistency, ApiError> {
    match parse_mode(raw)? {
        Consistency::Bounded => Err(ApiError::bad_request(
            "invalid_consistency",
            "bounded applies to reads only; writes accept strict, session, available or eventual",
        )),
        mode => Ok(mode),
    }
}

fn mutation_id(headers: &HeaderMap) -> Result<MutationId, ApiError> {
    match headers.get(MUTATION_ID_HEADER) {
        None => Ok(MutationId::random()),
        Some(v) => v.to_str().ok().and_then(|s| s.parse().ok()).ok_or_else(|| {
            ApiError::bad_request("invalid_mutation_id", "celeris-mutation-id must be a UUID")
        }),
    }
}

fn condition(
    if_version: Option<u64>,
    if_absent: Option<bool>,
) -> Result<Option<Condition>, ApiError> {
    match (if_version, if_absent.unwrap_or(false)) {
        (Some(_), true) => Err(ApiError::bad_request(
            "invalid_argument",
            "if_version and if_absent are mutually exclusive",
        )),
        (Some(v), false) => Ok(Some(Condition::Version(v))),
        (None, true) => Ok(Some(Condition::Absent)),
        (None, false) => Ok(None),
    }
}

fn validate_json(body: &[u8]) -> Result<(), ApiError> {
    serde_json::from_slice::<serde::de::IgnoredAny>(body)
        .map(|_| ())
        .map_err(|e| {
            ApiError::bad_request(
                "invalid_json",
                format!("value must be one JSON document: {e}"),
            )
        })
}

/// Stored values are JSON written by this API; anything else is a bug or corruption.
fn raw_json(bytes: &[u8]) -> Result<&RawValue, ApiError> {
    std::str::from_utf8(bytes)
        .ok()
        .and_then(|s| serde_json::from_str::<&RawValue>(s).ok())
        .ok_or_else(|| ApiError::internal("stored value is not valid JSON"))
}

/// Partition epoch the client routed with (optional, request header), and
/// the key's partition and epoch (response headers).
pub const PARTITION_EPOCH_HEADER: &str = "celeris-partition-epoch";
pub const PARTITION_HEADER: &str = "celeris-partition";

/// Data-path fencing. A key is served only by its partition leader under
/// the node's current map. Other nodes answer `421 not_owner` with routing
/// hints. When the client states the partition epoch it routed with, stale
/// epochs are rejected (`409 stale_epoch`), and so are epochs newer than
/// this node knows (`503 epoch_ahead`).
///
/// Until data replication lands, every request, in every consistency mode,
/// must reach the partition leader: replicas do not hold copies yet.
fn check_route(node: &Node, key: &str, headers: &HeaderMap) -> Result<Route, ApiError> {
    let map = node.partitions();
    let route = map.route(key.as_bytes());
    let hints = |err: ApiError| {
        err.with_detail("partition", json!(route.partition))
            .with_detail("partition_epoch", json!(route.partition_epoch))
            .with_detail("map_epoch", json!(map.epoch()))
            .with_detail("replicas", json!(route.replicas))
            .with_detail("leader", json!(route.replicas.first()))
    };
    if let Some(raw) = headers.get(PARTITION_EPOCH_HEADER) {
        let epoch: u64 = raw
            .to_str()
            .ok()
            .and_then(|s| s.parse().ok())
            .ok_or_else(|| {
                ApiError::bad_request(
                    "invalid_argument",
                    "celeris-partition-epoch must be an integer",
                )
            })?;
        match map.validate_epoch(route.partition, epoch) {
            Ok(()) => {}
            Err(e @ EpochMismatch::Stale { .. }) => {
                return Err(hints(ApiError::new(
                    StatusCode::CONFLICT,
                    "stale_epoch",
                    e.to_string(),
                )));
            }
            Err(e @ EpochMismatch::Ahead { .. }) => {
                return Err(hints(ApiError::new(
                    StatusCode::SERVICE_UNAVAILABLE,
                    "epoch_ahead",
                    e.to_string(),
                )));
            }
        }
    }
    if route.replicas.first() != Some(node.node_id()) {
        let leader = route
            .replicas
            .first()
            .map_or_else(|| "unknown".to_owned(), ToString::to_string);
        return Err(hints(ApiError::new(
            StatusCode::MISDIRECTED_REQUEST,
            "not_owner",
            format!(
                "partition {} is led by `{leader}`, not this node",
                route.partition
            ),
        )));
    }
    Ok(route)
}

fn set_route_headers(resp: &mut Response, route: &Route) {
    let h = resp.headers_mut();
    h.insert(PARTITION_HEADER, HeaderValue::from(route.partition.get()));
    h.insert(
        PARTITION_EPOCH_HEADER,
        HeaderValue::from(route.partition_epoch),
    );
}

fn set_headers(resp: &mut Response, version: u64, id: Option<MutationId>, mode: Consistency) {
    let h = resp.headers_mut();
    h.insert(VERSION_HEADER, HeaderValue::from(version));
    h.insert(CONSISTENCY_HEADER, HeaderValue::from_static(mode.as_str()));
    if let Some(v) = id.and_then(|id| HeaderValue::try_from(id.to_string()).ok()) {
        h.insert(MUTATION_ID_HEADER, v);
    }
}

// ------------------------------------------------------------------ handlers

#[derive(Serialize)]
struct RecordResponse<'a> {
    key: &'a str,
    value: &'a RawValue,
    version: u64,
    mutation_id: String,
    timestamp_ms: u64,
    expires_at_ms: Option<u64>,
    consistency: &'static str,
    #[serde(skip_serializing_if = "Option::is_none")]
    staleness_ms: Option<u64>,
}

async fn get_kv(
    State(node): State<AppState>,
    key: Result<Path<String>, PathRejection>,
    params: Result<Query<ReadParams>, QueryRejection>,
    headers: HeaderMap,
) -> Result<Response, ApiError> {
    let Path(key) = key.map_err(ApiError::path)?;
    let Query(p) = params.map_err(ApiError::query)?;
    let mode = read_mode(p.consistency.as_deref(), p.max_staleness_ms)?;
    celeris_core::validate_key(key.as_bytes())
        .map_err(|e| ApiError::bad_request("invalid_key", e.to_string()))?;
    node.metrics().record_consistency(mode, false);
    let (record, route, session_index) = if node.is_replicated() {
        let (record, applied) = replicated::read(&node, &key, mode, &headers).await?;
        (record, None, Some(applied))
    } else {
        let route = check_route(&node, &key, &headers)?;
        let lookup = key.clone().into_bytes();
        let record = node
            .blocking(move |e| e.get(&lookup))
            .await
            .map_err(|e| ApiError::internal(format!("read task failed: {e}")))?
            .map_err(|e| ApiError::storage(e, None))?;
        (record, Some(route), None)
    };
    let record = record.ok_or_else(|| ApiError::not_found(&key))?;
    let body = RecordResponse {
        key: &key,
        value: raw_json(&record.value)?,
        version: record.version,
        mutation_id: record.mutation_id.to_string(),
        timestamp_ms: record.timestamp_ms,
        expires_at_ms: record.expires_at_ms,
        consistency: mode.as_str(),
        // Bounded reads are served by the leader after a read barrier (or by
        // the only replica), so they are never stale.
        staleness_ms: (mode == Consistency::Bounded).then_some(0),
    };
    let mut resp = Json(body).into_response();
    set_headers(&mut resp, record.version, None, mode);
    if let Some(route) = &route {
        set_route_headers(&mut resp, route);
    }
    if let Some(token) = session_index
        && let Ok(value) = HeaderValue::from_str(&token)
    {
        resp.headers_mut().insert(replicated::SESSION_HEADER, value);
    }
    Ok(resp)
}

/// Replicates `ops` and answers like [`commit`], plus the session index.
async fn replicated_commit(
    node: &Arc<Node>,
    ops: Vec<WireOp>,
    id: MutationId,
    mode: Consistency,
    key: Option<&str>,
) -> Result<Response, ApiError> {
    node.metrics().record_consistency(mode, true);
    let written = if matches!(mode, Consistency::Available | Consistency::Eventual) {
        match available::write(node, ops, id).await? {
            available::Accepted::Committed(written) => written,
            available::Accepted::Pending { timestamp_ms } => {
                let mut resp = (
                    StatusCode::ACCEPTED,
                    Json(available::accepted_body(id, timestamp_ms, key)),
                )
                    .into_response();
                resp.headers_mut()
                    .insert(CONSISTENCY_HEADER, HeaderValue::from_static(mode.as_str()));
                return Ok(resp);
            }
        }
    } else {
        replicated::write(node, ops, id).await?
    };
    let mut body = json!({
        "version": written.outcome.version,
        "mutation_id": id.to_string(),
        "deduplicated": written.outcome.deduplicated,
        "consistency": mode.as_str(),
    });
    if let Some(k) = key {
        body["key"] = json!(k);
    }
    let mut resp = Json(body).into_response();
    set_headers(&mut resp, written.outcome.version, Some(id), mode);
    if let Ok(value) = HeaderValue::from_str(&written.session_token) {
        resp.headers_mut().insert(replicated::SESSION_HEADER, value);
    }
    Ok(resp)
}

async fn put_kv(
    State(node): State<AppState>,
    key: Result<Path<String>, PathRejection>,
    params: Result<Query<PutParams>, QueryRejection>,
    headers: HeaderMap,
    body: Bytes,
) -> Result<Response, ApiError> {
    let result: Result<Response, ApiError> = async {
        let Path(key) = key.map_err(ApiError::path)?;
        let Query(p) = params.map_err(ApiError::query)?;
        let mode = write_mode(p.consistency.as_deref())?;
        let id = mutation_id(&headers)?;
        validate_json(&body)?;
        celeris_core::validate_key(key.as_bytes())
            .map_err(|e| ApiError::bad_request("invalid_key", e.to_string()))?;
        if node.is_replicated() {
            condition(p.if_version, p.if_absent)?;
            let value = String::from_utf8(body.to_vec())
                .map_err(|_| ApiError::bad_request("invalid_json", "value must be UTF-8 JSON"))?;
            let op = WireOp::Put {
                key: key.clone(),
                value,
                ttl_ms: p.ttl_ms,
                if_version: p.if_version,
                if_absent: p.if_absent.unwrap_or(false),
            };
            return replicated_commit(&node, vec![op], id, mode, Some(&key)).await;
        }
        let route = check_route(&node, &key, &headers)?;
        let op = Op::Put {
            key: key.clone().into_bytes(),
            value: body.to_vec(),
            ttl: p.ttl_ms.map(Duration::from_millis),
            condition: condition(p.if_version, p.if_absent)?,
        };
        commit(
            &node,
            WriteBatch::new(id).push(op),
            mode,
            Some((&key, &route)),
        )
        .await
    }
    .await;
    result.map_err(ApiError::write_failure)
}

async fn delete_kv(
    State(node): State<AppState>,
    key: Result<Path<String>, PathRejection>,
    params: Result<Query<DeleteParams>, QueryRejection>,
    headers: HeaderMap,
) -> Result<Response, ApiError> {
    let result: Result<Response, ApiError> = async {
        let Path(key) = key.map_err(ApiError::path)?;
        let Query(p) = params.map_err(ApiError::query)?;
        let mode = write_mode(p.consistency.as_deref())?;
        let id = mutation_id(&headers)?;
        celeris_core::validate_key(key.as_bytes())
            .map_err(|e| ApiError::bad_request("invalid_key", e.to_string()))?;
        if node.is_replicated() {
            let op = WireOp::Delete {
                key: key.clone(),
                if_version: p.if_version,
            };
            return replicated_commit(&node, vec![op], id, mode, Some(&key)).await;
        }
        let route = check_route(&node, &key, &headers)?;
        let op = Op::Delete {
            key: key.clone().into_bytes(),
            condition: p.if_version.map(Condition::Version),
        };
        commit(
            &node,
            WriteBatch::new(id).push(op),
            mode,
            Some((&key, &route)),
        )
        .await
    }
    .await;
    result.map_err(ApiError::write_failure)
}

async fn batch(
    State(node): State<AppState>,
    headers: HeaderMap,
    req: Result<Json<BatchRequest>, JsonRejection>,
) -> Result<Response, ApiError> {
    batch_inner(&node, &headers, req)
        .await
        .map_err(ApiError::write_failure)
}

async fn batch_inner(
    node: &Arc<Node>,
    headers: &HeaderMap,
    req: Result<Json<BatchRequest>, JsonRejection>,
) -> Result<Response, ApiError> {
    let Json(req) = req.map_err(ApiError::json)?;
    let mode = write_mode(req.consistency.as_deref())?;
    let id = match req.mutation_id {
        Some(raw) => raw.parse().map_err(|_| {
            ApiError::bad_request("invalid_mutation_id", "mutation_id must be a UUID")
        })?,
        None => mutation_id(headers)?,
    };
    for op in &req.ops {
        let (BatchOp::Put { key, .. } | BatchOp::Delete { key, .. }) = op;
        celeris_core::validate_key(key.as_bytes())
            .map_err(|e| ApiError::bad_request("invalid_key", e.to_string()))?;
    }
    if node.is_replicated() {
        // Atomic within one replication group; `replicated::write` rejects
        // batches spanning groups.
        let mut ops = Vec::with_capacity(req.ops.len());
        for op in req.ops {
            ops.push(match op {
                BatchOp::Put {
                    key,
                    value,
                    ttl_ms,
                    if_version,
                    if_absent,
                } => {
                    condition(if_version, if_absent)?;
                    WireOp::Put {
                        key,
                        value: value.to_string(),
                        ttl_ms,
                        if_version,
                        if_absent: if_absent.unwrap_or(false),
                    }
                }
                BatchOp::Delete { key, if_version } => WireOp::Delete { key, if_version },
            });
        }
        if ops.is_empty() {
            return Err(ApiError::bad_request(
                "invalid_argument",
                "batch has no operations",
            ));
        }
        return replicated_commit(node, ops, id, mode, None).await;
    }
    // A batch is atomic only on one node, so every key must be led here.
    for op in &req.ops {
        let (BatchOp::Put { key, .. } | BatchOp::Delete { key, .. }) = op;
        check_route(node, key, headers)?;
    }
    let mut batch = WriteBatch::new(id);
    for op in req.ops {
        batch = batch.push(match op {
            BatchOp::Put {
                key,
                value,
                ttl_ms,
                if_version,
                if_absent,
            } => Op::Put {
                key: key.into_bytes(),
                value: serde_json::to_vec(&value)
                    .map_err(|e| ApiError::internal(format!("re-encoding value: {e}")))?,
                ttl: ttl_ms.map(Duration::from_millis),
                condition: condition(if_version, if_absent)?,
            },
            BatchOp::Delete { key, if_version } => Op::Delete {
                key: key.into_bytes(),
                condition: if_version.map(Condition::Version),
            },
        });
    }
    commit(node, batch, mode, None).await
}

/// Applies a batch. On a single node every write mode is satisfied by the
/// one local replica; the mode is still validated, reported and counted.
async fn commit(
    node: &Node,
    batch: WriteBatch,
    mode: Consistency,
    key: Option<(&str, &Route)>,
) -> Result<Response, ApiError> {
    let id = batch.mutation_id();
    node.metrics().record_consistency(mode, true);
    let watched = (node.events().receiver_count() > 0).then(|| batch.clone());
    let outcome = node
        .blocking(move |e| e.write(batch))
        .await
        .map_err(|e| ApiError::outcome_unknown(id, format!("write task failed: {e}")))?
        .map_err(|e| ApiError::storage(e, Some(id)))?;
    if let Some(batch) = watched {
        crate::events::publish_batch(node.events(), &batch, &outcome);
    }
    let mut body = json!({
        "version": outcome.version,
        "mutation_id": id.to_string(),
        "deduplicated": outcome.deduplicated,
        "consistency": mode.as_str(),
    });
    if let Some((k, _)) = key {
        body["key"] = json!(k);
    }
    let mut resp = Json(body).into_response();
    set_headers(&mut resp, outcome.version, Some(id), mode);
    if let Some((_, route)) = key {
        set_route_headers(&mut resp, route);
    }
    Ok(resp)
}

#[derive(Serialize)]
struct ScanItem<'a> {
    key: String,
    value: &'a RawValue,
    version: u64,
    expires_at_ms: Option<u64>,
}

#[derive(Serialize)]
struct ScanResponse<'a> {
    items: Vec<ScanItem<'a>>,
    /// Pass as `after` to fetch the next page; `null` on the last page.
    next_cursor: Option<String>,
    consistency: &'static str,
    /// True when the result may miss records: in single-node routing mode,
    /// partitions led by other nodes; in replicated mode, groups that could
    /// not be reached by an `eventual`/`available` scan.
    partial: bool,
}

async fn scan(
    State(node): State<AppState>,
    params: Result<Query<ScanParams>, QueryRejection>,
) -> Result<Response, ApiError> {
    let Query(p) = params.map_err(ApiError::query)?;
    let mode = read_mode(p.consistency.as_deref(), p.max_staleness_ms)?;
    let limit = p.limit.unwrap_or(DEFAULT_SCAN_LIMIT);
    if limit == 0 || limit > MAX_SCAN_LIMIT {
        return Err(ApiError::bad_request(
            "invalid_argument",
            format!("limit must be between 1 and {MAX_SCAN_LIMIT}"),
        ));
    }
    let (lo, hi) = key_range(p.prefix, p.start, p.end, p.after)?;
    node.metrics().record_consistency(mode, false);
    let (records, cluster_partial) = if node.is_replicated() {
        let range = replicated::ScanRange {
            lo: replicated::WireBound::from_bound(&lo),
            hi: replicated::WireBound::from_bound(&hi),
            limit: limit + 1,
        };
        replicated::scan(&node, range, mode).await?
    } else {
        let records = node
            .blocking(move |e| {
                e.scan(
                    lo.as_ref().map(Vec::as_slice),
                    hi.as_ref().map(Vec::as_slice),
                    limit + 1,
                )
            })
            .await
            .map_err(|e| ApiError::internal(format!("scan task failed: {e}")))?
            .map_err(|e| ApiError::storage(e, None))?;
        let map = node.partitions();
        let partial = map.nodes().iter().any(|n| n.id != *node.node_id());
        (records, partial)
    };
    let more = records.len() > limit;
    let page = &records[..records.len().min(limit)];
    let items = page
        .iter()
        .map(|r| {
            Ok(ScanItem {
                key: String::from_utf8_lossy(&r.key).into_owned(),
                value: raw_json(&r.value)?,
                version: r.version,
                expires_at_ms: r.expires_at_ms,
            })
        })
        .collect::<Result<Vec<_>, ApiError>>()?;
    let next_cursor = if more {
        page.last()
            .map(|r| String::from_utf8_lossy(&r.key).into_owned())
    } else {
        None
    };
    let mut resp = Json(ScanResponse {
        items,
        next_cursor,
        consistency: mode.as_str(),
        partial: cluster_partial,
    })
    .into_response();
    resp.headers_mut()
        .insert(CONSISTENCY_HEADER, HeaderValue::from_static(mode.as_str()));
    Ok(resp)
}

type KeyRange = (Bound<Vec<u8>>, Bound<Vec<u8>>);

/// The key range of a scan or query: `prefix`, or `start` (inclusive) and
/// `end` (exclusive), continuing after the cursor `after`.
fn key_range(
    prefix: Option<String>,
    start: Option<String>,
    end: Option<String>,
    after: Option<String>,
) -> Result<KeyRange, ApiError> {
    let (mut lo, hi) = match (prefix, start, end) {
        (Some(_), Some(_), _) | (Some(_), _, Some(_)) => {
            return Err(ApiError::bad_request(
                "invalid_argument",
                "use either prefix or start/end, not both",
            ));
        }
        (Some(prefix), None, None) => {
            let hi = prefix_successor(prefix.as_bytes()).map_or(Bound::Unbounded, Bound::Excluded);
            (Bound::Included(prefix.into_bytes()), hi)
        }
        (None, start, end) => (
            start.map_or(Bound::Unbounded, |s| Bound::Included(s.into_bytes())),
            end.map_or(Bound::Unbounded, |e| Bound::Excluded(e.into_bytes())),
        ),
    };
    if let Some(after) = after {
        let after = after.into_bytes();
        let past_start = match &lo {
            Bound::Included(s) | Bound::Excluded(s) => after >= *s,
            Bound::Unbounded => true,
        };
        if past_start {
            lo = Bound::Excluded(after);
        }
    }
    Ok((lo, hi))
}

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
struct QueryRequest {
    prefix: Option<String>,
    start: Option<String>,
    end: Option<String>,
    after: Option<String>,
    #[serde(rename = "where")]
    filter: Option<Value>,
    fields: Option<Vec<String>>,
    aggregate: Option<Value>,
    sort: Option<Value>,
    limit: Option<usize>,
    max_scanned: Option<usize>,
    consistency: Option<String>,
    max_staleness_ms: Option<u64>,
}

#[derive(Serialize)]
struct QueryItem {
    key: String,
    value: Value,
    version: u64,
    expires_at_ms: Option<u64>,
}

#[derive(Serialize)]
struct QueryResponse {
    items: Vec<QueryItem>,
    /// Pass as `after` to continue; `null` once the range is done. A page
    /// can hold fewer than `limit` items and still have a cursor.
    next_cursor: Option<String>,
    /// Rows read to answer this page, matching or not.
    scanned: usize,
    /// The secondary index that served the page, or `null` for a scan.
    index: Option<String>,
    /// With `aggregate`: count, sum, min and max over this page's matches.
    #[serde(skip_serializing_if = "Option::is_none")]
    aggregates: Option<Value>,
    consistency: &'static str,
    partial: bool,
}

/// `POST /v1/query`: a range scan with a JSON filter and projection,
/// evaluated next to the data (D-030).
async fn query(
    State(node): State<AppState>,
    req: Result<Json<QueryRequest>, JsonRejection>,
) -> Result<Response, ApiError> {
    let Json(req) = req.map_err(ApiError::json)?;
    let mode = read_mode(req.consistency.as_deref(), req.max_staleness_ms)?;
    let limit = req.limit.unwrap_or(DEFAULT_SCAN_LIMIT);
    if limit == 0 || limit > MAX_SCAN_LIMIT {
        return Err(ApiError::bad_request(
            "invalid_argument",
            format!("limit must be between 1 and {MAX_SCAN_LIMIT}"),
        ));
    }
    let max_scanned = req.max_scanned.unwrap_or(DEFAULT_MAX_SCANNED);
    if max_scanned == 0 || max_scanned > MAX_MAX_SCANNED {
        return Err(ApiError::bad_request(
            "invalid_argument",
            format!("max_scanned must be between 1 and {MAX_MAX_SCANNED}"),
        ));
    }
    let filter = req
        .filter
        .as_ref()
        .map(crate::query::Filter::parse)
        .transpose()
        .map_err(|e| ApiError::bad_request("invalid_filter", e))?;
    let fields = req
        .fields
        .as_deref()
        .map(crate::query::parse_fields)
        .transpose()
        .map_err(|e| ApiError::bad_request("invalid_argument", e))?;
    let mut aggregates = req
        .aggregate
        .as_ref()
        .map(crate::query::Aggregates::parse)
        .transpose()
        .map_err(|e| ApiError::bad_request("invalid_argument", e))?;
    // An aggregate page is bounded by the scan budget only.
    let limit = if aggregates.is_some() {
        max_scanned
    } else {
        limit
    };
    let sort = req
        .sort
        .as_ref()
        .map(crate::query::Sort::parse)
        .transpose()
        .map_err(|e| ApiError::bad_request("invalid_argument", e))?;
    // A sorted query's cursor is an index position (hex), not a key.
    let (after_key, after_position) = match (&sort, req.after) {
        (Some(_), Some(cursor)) => (
            None,
            Some(crate::query::unhex(&cursor).ok_or_else(|| {
                ApiError::bad_request(
                    "invalid_argument",
                    "after is not a cursor of this sorted query",
                )
            })?),
        ),
        (_, after) => (after, None),
    };
    let (lo, hi) = key_range(req.prefix, req.start, req.end, after_key)?;
    node.metrics().record_consistency(mode, false);
    let sorted = sort.is_some();
    let (page, partial) = if node.is_replicated() {
        let range = replicated::QueryRange {
            lo: replicated::WireBound::from_bound(&lo),
            hi: replicated::WireBound::from_bound(&hi),
            filter: req.filter,
            limit,
            max_scanned,
            sort: req.sort,
            after_position: after_position.as_deref().map(crate::query::hex),
        };
        replicated::query(&node, range, mode).await?
    } else {
        let page = node
            .blocking(move |e| match &sort {
                Some(sort) => crate::query::sorted_scan(
                    e,
                    sort,
                    (lo, hi),
                    after_position,
                    filter.as_ref(),
                    (limit, max_scanned),
                    |_| true,
                ),
                None => crate::query::filtered_scan(
                    e,
                    lo,
                    hi,
                    filter.as_ref(),
                    limit,
                    max_scanned,
                    |_| true,
                )
                .map(Ok),
            })
            .await
            .map_err(|e| ApiError::internal(format!("query task failed: {e}")))?
            .map_err(|e| ApiError::storage(e, None))?
            .map_err(|e| ApiError::bad_request("sort_unavailable", e))?;
        let partial = node
            .partitions()
            .nodes()
            .iter()
            .any(|n| n.id != *node.node_id());
        (page, partial)
    };
    let items = page
        .records
        .iter()
        .map(|r| {
            let value: Value = serde_json::from_slice(&r.value)
                .map_err(|e| ApiError::internal(format!("stored value is not JSON: {e}")))?;
            Ok(QueryItem {
                key: String::from_utf8_lossy(&r.key).into_owned(),
                // Aggregates read whole values; projection applies to items.
                value: match fields.as_ref().filter(|_| aggregates.is_none()) {
                    Some(f) => crate::query::project(&value, f),
                    None => value,
                },
                version: r.version,
                expires_at_ms: r.expires_at_ms,
            })
        })
        .collect::<Result<Vec<_>, ApiError>>()?;
    let (items, aggregates) = match aggregates.as_mut() {
        Some(agg) => {
            for item in &items {
                agg.add(&item.value);
            }
            (Vec::new(), Some(agg.to_json()))
        }
        None => (items, None),
    };
    let mut resp = Json(QueryResponse {
        items,
        aggregates,
        next_cursor: page.resume.map(|k| {
            if sorted {
                crate::query::hex(&k)
            } else {
                String::from_utf8_lossy(&k).into_owned()
            }
        }),
        scanned: page.scanned,
        index: page.index,
        consistency: mode.as_str(),
        partial,
    })
    .into_response();
    resp.headers_mut()
        .insert(CONSISTENCY_HEADER, HeaderValue::from_static(mode.as_str()));
    Ok(resp)
}

#[derive(Debug, Default, Deserialize)]
#[serde(deny_unknown_fields)]
struct ConflictParams {
    prefix: Option<String>,
    limit: Option<usize>,
}

/// Writes that lost last-writer-wins resolution (D-023), across all groups.
async fn list_conflicts(
    State(node): State<AppState>,
    params: Result<Query<ConflictParams>, QueryRejection>,
) -> Result<Response, ApiError> {
    let Query(p) = params.map_err(ApiError::query)?;
    if !node.is_replicated() {
        return Ok(Json(json!({ "conflicts": [], "partial": false })).into_response());
    }
    let limit = p
        .limit
        .unwrap_or(DEFAULT_SCAN_LIMIT)
        .clamp(1, MAX_SCAN_LIMIT);
    let (conflicts, partial) =
        available::conflicts(&node, p.prefix.as_deref().unwrap_or(""), limit).await?;
    Ok(Json(json!({ "conflicts": conflicts, "partial": partial })).into_response())
}

/// Clears the recorded conflicts of a key (after the application has
/// looked at them), through the group leader.
async fn clear_conflicts(
    State(node): State<AppState>,
    key: Result<Path<String>, PathRejection>,
) -> Result<Response, ApiError> {
    let Path(key) = key.map_err(ApiError::path)?;
    if !node.is_replicated() {
        return Ok(Json(json!({ "key": key, "cleared": true })).into_response());
    }
    replicated::clear_conflicts(&node, &key).await?;
    Ok(Json(json!({ "key": key, "cleared": true })).into_response())
}

#[derive(Debug, Default, Deserialize)]
#[serde(deny_unknown_fields)]
struct WatchParams {
    prefix: Option<String>,
    /// Checked by the auth middleware (browsers cannot send headers here).
    #[serde(rename = "access_token")]
    _access_token: Option<String>,
}

/// Streams applied changes over a WebSocket (see `events.rs`).
async fn watch(
    State(node): State<AppState>,
    params: Result<Query<WatchParams>, QueryRejection>,
    upgrade: Result<WebSocketUpgrade, WebSocketUpgradeRejection>,
) -> Result<Response, ApiError> {
    let Query(p) = params.map_err(ApiError::query)?;
    let upgrade = upgrade.map_err(|e| {
        ApiError::bad_request(
            "websocket_required",
            format!("/v1/watch is a WebSocket endpoint: {e}"),
        )
    })?;
    let prefix = p.prefix.unwrap_or_default();
    Ok(upgrade.on_upgrade(move |socket| watch_loop(node, socket, prefix)))
}

async fn watch_loop(node: Arc<Node>, mut socket: WebSocket, prefix: String) {
    let mut changes = node.events().subscribe();
    // Which replica sets this node can see changes for.
    let (groups, partial) = if node.is_replicated() {
        let serving = node.serving_groups();
        let local: Vec<String> = serving
            .keys()
            .filter(|g| node.group(g).is_some())
            .cloned()
            .collect();
        let partial = local.len() < serving.len();
        (local, partial)
    } else {
        (Vec::new(), false)
    };
    let hello = json!({
        "type": "hello",
        "node": node.id(),
        "prefix": prefix,
        "groups": groups,
        "partial": partial,
    });
    if socket
        .send(Message::Text(hello.to_string().into()))
        .await
        .is_err()
    {
        return;
    }
    loop {
        tokio::select! {
            change = changes.recv() => {
                let text = match change {
                    Ok(event) if event.key.starts_with(&prefix) => event.to_message(),
                    Ok(_) => continue,
                    Err(tokio::sync::broadcast::error::RecvError::Lagged(missed)) => {
                        json!({ "type": "lagged", "missed": missed }).to_string()
                    }
                    Err(tokio::sync::broadcast::error::RecvError::Closed) => break,
                };
                if socket.send(Message::Text(text.into())).await.is_err() {
                    break;
                }
            }
            incoming = socket.recv() => match incoming {
                Some(Ok(Message::Close(_))) | None | Some(Err(_)) => break,
                Some(Ok(_)) => {}
            },
        }
    }
}

async fn mutation_status(
    State(node): State<AppState>,
    id: Result<Path<String>, PathRejection>,
) -> Result<Response, ApiError> {
    let Path(raw) = id.map_err(ApiError::path)?;
    let id: MutationId = raw
        .parse()
        .map_err(|_| ApiError::bad_request("invalid_mutation_id", "mutation id must be a UUID"))?;
    let status = if node.is_replicated() {
        replicated::mutation_status(&node, id).await?
    } else {
        node.blocking(move |e| e.mutation_status(id))
            .await
            .map_err(|e| ApiError::internal(format!("lookup task failed: {e}")))?
            .map_err(|e| ApiError::storage(e, None))?
    };
    Ok(match status {
        Some(version) => Json(json!({
            "mutation_id": id.to_string(),
            "status": "committed",
            "version": version,
        }))
        .into_response(),
        None => (
            StatusCode::NOT_FOUND,
            Json(json!({
                "mutation_id": id.to_string(),
                "status": "unknown",
                "message": "no commit record: the mutation did not commit, is still in flight, \
                            or is older than the retention window",
            })),
        )
            .into_response(),
    })
}

/// Secondary indexes and their states (D-031): of the node's engine, or of
/// every local replication group in cluster mode.
async fn index_view(node: &Arc<Node>) -> Vec<Value> {
    let entry = |group: Option<&str>, s: celeris_storage::IndexStatus| json!({ "name": s.name, "state": s.state, "group": group });
    if !node.is_replicated() {
        return match node.blocking(|e| e.indexes()).await {
            Ok(Ok(list)) => list.into_iter().map(|s| entry(None, s)).collect(),
            _ => Vec::new(),
        };
    }
    let mut out = Vec::new();
    for group in node.groups() {
        let engine = group.engine();
        if let Ok(Ok(list)) = tokio::task::spawn_blocking(move || engine.indexes()).await {
            out.extend(list.into_iter().map(|s| entry(Some(group.id()), s)));
        }
    }
    out
}

async fn status(State(node): State<AppState>) -> Result<Json<Value>, ApiError> {
    let (stats, recovery) = node
        .blocking(|e| (e.stats(), e.recovery_report().clone()))
        .await
        .map_err(|e| ApiError::internal(format!("status task failed: {e}")))?;
    let health = if stats.poisoned.is_some() {
        "read_only"
    } else {
        "healthy"
    };
    let indexes = index_view(&node).await;
    Ok(Json(json!({
        "node_id": node.id(),
        "indexes": indexes,
        "version": env!("CARGO_PKG_VERSION"),
        "uptime_secs": node.uptime().as_secs(),
        "health": health,
        "cluster": cluster_view(&node),
        "storage": {
            "last_version": stats.last_version,
            "memtable_bytes": stats.memtable_bytes,
            "immutable_memtables": stats.immutable_memtables,
            "l0_tables": stats.l0_tables,
            "l1_tables": stats.l1_tables,
            "table_bytes": stats.table_bytes,
            "read_only_reason": stats.poisoned,
            "background_error": stats.background_error,
            "recovery": {
                "tables_opened": recovery.tables_opened,
                "wal_files": recovery.wal_files,
                "batches_replayed": recovery.batches_replayed,
                "batches_skipped": recovery.batches_skipped,
                "truncated_bytes": recovery.truncated_bytes,
                "orphan_files_removed": recovery.orphan_files_removed,
            },
        },
        "partitions": {
            "count": PARTITION_COUNT,
            "epoch": node.partitions().epoch(),
            "replication_factor": node.partitions().replication_factor(),
        },
        "control": control_view(&node),
        "consistency_modes": Consistency::ALL.map(Consistency::as_str),
    })))
}

/// Running partition migrations, counted by phase.
fn migrations_view(node: &Node) -> Value {
    let migrations = node.migrations();
    let mut by_phase: std::collections::BTreeMap<&str, usize> = Default::default();
    for m in migrations.values() {
        let phase = match m.phase {
            celeris_cluster::raft::MigrationPhase::Moving => "moving",
            celeris_cluster::raft::MigrationPhase::Fenced => "fenced",
            celeris_cluster::raft::MigrationPhase::Imported => "imported",
        };
        *by_phase.entry(phase).or_default() += 1;
    }
    json!({ "running": migrations.len(), "by_phase": by_phase })
}

fn control_view(node: &Node) -> Value {
    match node.raft_status() {
        Some((role, term, leader, commit_index)) => json!({
            "raft": {
                "role": match role {
                    Role::Leader => "leader",
                    Role::Candidate => "candidate",
                    Role::Follower => "follower",
                },
                "term": term,
                "leader": leader,
                "commit_index": commit_index,
            },
            "migrations": migrations_view(node),
            "anti_entropy": node.anti_entropy_reports(),
        }),
        None => json!({ "raft": null }),
    }
}

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
struct RebalanceRequest {
    replication_factor: u8,
}

/// Proposes placing partitions on the current membership. A follower
/// forwards the request to the Raft leader (`"status": "forwarded"`); the
/// new map takes effect on every node once the command commits (watch
/// `/v1/partitions` for the epoch to change).
async fn rebalance(
    State(node): State<AppState>,
    peer: Result<ConnectInfo<SocketAddr>, ExtensionRejection>,
    req: Result<Json<RebalanceRequest>, JsonRejection>,
) -> Result<Response, ApiError> {
    admin_allowed(&node, &peer)?;
    let Json(req) = req.map_err(ApiError::json)?;
    let rf = req.replication_factor;
    let worker = Arc::clone(&node);
    let proposed = tokio::task::spawn_blocking(move || worker.propose_rebalance(rf))
        .await
        .map_err(|e| ApiError::internal(format!("proposal task failed: {e}")))?;
    match proposed {
        Ok((index, out)) => {
            crate::cluster::send_raft(&node, out);
            Ok((
                StatusCode::ACCEPTED,
                Json(json!({ "status": "proposed", "log_index": index })),
            )
                .into_response())
        }
        Err(ProposeError::NotLeader(Some(leader)))
            if crate::cluster::forward_rebalance(&node, &leader, rf) =>
        {
            Ok((
                StatusCode::ACCEPTED,
                Json(json!({ "status": "forwarded", "leader": leader })),
            )
                .into_response())
        }
        Err(ProposeError::NotLeader(leader)) => {
            let mut err = ApiError::new(
                StatusCode::CONFLICT,
                "not_leader",
                match &leader {
                    Some(l) => format!("this node is not the control-plane leader; retry on `{l}`"),
                    None => "no control-plane leader is known yet; retry shortly".to_owned(),
                },
            );
            err = err.write_failure();
            Err(err)
        }
        Err(ProposeError::NoControlPlane) => Err(ApiError::new(
            StatusCode::CONFLICT,
            "no_control_plane",
            "this node is not a control-plane voter (set cluster.listen and cluster.voters)",
        )),
        Err(ProposeError::Placement(e)) => {
            Err(ApiError::bad_request("invalid_argument", e.to_string()))
        }
        Err(ProposeError::MigrationsPending(n)) => Err(ApiError::new(
            StatusCode::CONFLICT,
            "migrations_pending",
            format!("{n} partitions are still moving from the previous placement; retry when they finish"),
        )
        .with_detail("migrations", json!(n))),
        Err(ProposeError::Persist(e)) => {
            Err(ApiError::internal(format!("persisting raft state: {e:#}")))
        }
    }
}

/// This node's membership view. Single-node mode reports only itself.
fn cluster_view(node: &Node) -> Value {
    match node.cluster_members() {
        Some((view_epoch, members)) => json!({
            "mode": "gossip",
            "view_epoch": view_epoch,
            "nodes": members.iter().map(|m| json!({
                "id": m.id,
                "address": m.addr,
                "zone": m.zone,
                "state": m.state.as_str(),
                "incarnation": m.incarnation,
                "self": m.id.as_str() == node.id(),
            })).collect::<Vec<_>>(),
        }),
        None => json!({
            "mode": "single-node",
            "nodes": [{
                "id": node.id(),
                "address": node.advertise(),
                "zone": celeris_core::partition::DEFAULT_ZONE,
                "state": "alive",
                "incarnation": 0,
                "self": true,
            }],
        }),
    }
}

/// Partition-map summary: epoch, replication factor and per-node load.
async fn partitions(State(node): State<AppState>) -> Json<Value> {
    let map = node.partitions();
    let load = map.load();
    let nodes: Vec<Value> = map
        .nodes()
        .iter()
        .map(|n| {
            let l = load.get(&n.id).copied().unwrap_or_default();
            json!({ "id": n.id, "zone": n.zone, "replicas": l.replicas, "leaders": l.leaders })
        })
        .collect();
    let zone_diverse = PartitionId::all().filter(|p| map.zone_diverse(*p)).count();
    Json(json!({
        "count": PARTITION_COUNT,
        "epoch": map.epoch(),
        "replication_factor": map.replication_factor(),
        "zone_diverse_partitions": zone_diverse,
        "nodes": nodes,
    }))
}

/// Where a key lives: its partition, the partition epoch and the replicas
/// (preferred leader first). Clients use this to route directly to owners.
async fn partition_for_key(
    State(node): State<AppState>,
    key: Result<Path<String>, PathRejection>,
) -> Result<Json<Value>, ApiError> {
    let Path(key) = key.map_err(ApiError::path)?;
    celeris_core::validate_key(key.as_bytes())
        .map_err(|e| ApiError::bad_request("invalid_key", e.to_string()))?;
    let route = node.partitions().route(key.as_bytes());
    Ok(Json(json!({
        "key": key,
        "partition": route.partition,
        "partition_epoch": route.partition_epoch,
        "map_epoch": node.partitions().epoch(),
        "replicas": route.replicas,
        "leader": route.replicas.first(),
    })))
}

async fn health(State(node): State<AppState>) -> Json<Value> {
    Json(json!({ "status": "ok", "node_id": node.id() }))
}

async fn ready(State(node): State<AppState>) -> Result<Response, ApiError> {
    let stats = node
        .blocking(|e| e.stats())
        .await
        .map_err(|e| ApiError::internal(format!("status task failed: {e}")))?;
    Ok(match stats.poisoned {
        None => Json(json!({ "status": "ready" })).into_response(),
        Some(reason) => (
            StatusCode::SERVICE_UNAVAILABLE,
            Json(json!({ "status": "read_only", "reason": reason })),
        )
            .into_response(),
    })
}

async fn metrics(State(node): State<AppState>) -> Result<Response, ApiError> {
    let (snapshot, stats) = node
        .blocking(|e| (e.metrics(), e.stats()))
        .await
        .map_err(|e| ApiError::internal(format!("metrics task failed: {e}")))?;
    let mut text = node
        .metrics()
        .render(node.id(), node.uptime(), &snapshot, &stats);
    if let Some((epoch, members)) = node.cluster_members() {
        use std::fmt::Write;
        let _ = writeln!(
            text,
            "# HELP celeris_cluster_members Cluster members in this node's view, by state."
        );
        let _ = writeln!(text, "# TYPE celeris_cluster_members gauge");
        for state in [
            MemberState::Alive,
            MemberState::Suspect,
            MemberState::Unreachable,
            MemberState::Left,
        ] {
            let n = members.iter().filter(|m| m.state == state).count();
            let _ = writeln!(
                text,
                "celeris_cluster_members{{state=\"{}\"}} {n}",
                state.as_str()
            );
        }
        let _ = writeln!(
            text,
            "# HELP celeris_cluster_view_epoch Changes to this node's membership view."
        );
        let _ = writeln!(text, "# TYPE celeris_cluster_view_epoch counter");
        let _ = writeln!(text, "celeris_cluster_view_epoch {epoch}");
    }
    Ok((
        [(
            header::CONTENT_TYPE,
            "text/plain; version=0.0.4; charset=utf-8",
        )],
        text,
    )
        .into_response())
}

/// A consistent physical backup of this node's storage (single-node mode),
/// in the engine snapshot format. Restore it with `celeris restore`.
/// Replicated clusters are backed up logically with `celeris export`.
async fn backup(
    State(node): State<AppState>,
    peer: Result<ConnectInfo<SocketAddr>, ExtensionRejection>,
) -> Result<Response, ApiError> {
    admin_allowed(&node, &peer)?;
    if node.is_replicated() {
        return Err(ApiError::new(
            StatusCode::NOT_IMPLEMENTED,
            "not_supported",
            "physical backups cover a single node; back up a replicated cluster with `celeris export`",
        ));
    }
    let (snapshot, version) = node
        .blocking(|engine| engine.backup())
        .await
        .map_err(|e| ApiError::internal(format!("backup task failed: {e}")))?
        .map_err(|e| ApiError::internal(format!("backup failed: {e}")))?;
    Ok((
        [
            (header::CONTENT_TYPE, "application/octet-stream".to_owned()),
            (
                header::CONTENT_DISPOSITION,
                format!(
                    "attachment; filename=\"celeris-{}-v{version}.backup\"",
                    node.id()
                ),
            ),
            (HeaderName::from_static(VERSION_HEADER), version.to_string()),
        ],
        snapshot,
    )
        .into_response())
}

async fn shutdown(
    State(node): State<AppState>,
    peer: Result<ConnectInfo<SocketAddr>, ExtensionRejection>,
) -> Result<Response, ApiError> {
    admin_allowed(&node, &peer)?;
    node.request_shutdown();
    Ok((
        StatusCode::ACCEPTED,
        Json(json!({ "status": "shutting_down" })),
    )
        .into_response())
}
