//! Async client for [Celeris](https://github.com/vinitpatil519/CelerisDB).
//!
//! ```no_run
//! # async fn demo() -> Result<(), celeris_client::Error> {
//! use celeris_client::{Client, PutOptions};
//!
//! let db = Client::builder()
//!     .nodes(["http://10.0.0.1:8080", "http://10.0.0.2:8080"])
//!     .build()?;
//! let written = db.put("users/42", &serde_json::json!({"name": "Ada"})).await?;
//! let user = db.get::<serde_json::Value>("users/42").await?;
//! db.put_with(
//!     "users/42",
//!     &serde_json::json!({"name": "Ada L."}),
//!     PutOptions { if_version: written.version, ..Default::default() },
//! )
//! .await?;
//! # Ok(()) }
//! ```
//!
//! Guarantees the client keeps:
//!
//! * Every write carries a mutation ID. Retries (after connection failures,
//!   redirects, or errors that guarantee nothing was applied) reuse it, so a
//!   write is never applied twice.
//! * A write whose outcome cannot be determined fails with
//!   [`Error::OutcomeUnknown`], carrying the mutation ID. Resolve it with
//!   [`Client::mutation_status`].
//! * Every result reports the consistency the server applied. The client
//!   never weakens a requested mode.

use std::fmt;
use std::sync::Mutex;
use std::sync::atomic::{AtomicUsize, Ordering};
use std::time::Duration;

use futures_util::{SinkExt, StreamExt};
use reqwest::Method;
use serde::Serialize;
use serde::de::DeserializeOwned;
use serde_json::Value;
use tokio_tungstenite::tungstenite::Message;
use tokio_tungstenite::tungstenite::client::IntoClientRequest;

pub const SESSION_HEADER: &str = "celeris-session-index";
pub const MUTATION_HEADER: &str = "celeris-mutation-id";

/// Error codes after which the same request may go to another node.
const REDIRECTS: &[&str] = &["not_leader", "not_owner", "partition_moved"];
/// 503 codes that guarantee nothing was applied: retry shortly.
const TRANSIENT: &[&str] = &[
    "proposal_lost",
    "partition_moving",
    "read_retry",
    "read_timeout",
    "session_behind",
    "no_partition_map",
    "epoch_ahead",
];

/// Per-request consistency. See `docs/CONSISTENCY.md`.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Consistency {
    Strict,
    Session,
    Bounded,
    Available,
    Eventual,
}

impl Consistency {
    pub fn as_str(self) -> &'static str {
        match self {
            Consistency::Strict => "strict",
            Consistency::Session => "session",
            Consistency::Bounded => "bounded",
            Consistency::Available => "available",
            Consistency::Eventual => "eventual",
        }
    }
}

impl fmt::Display for Consistency {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(self.as_str())
    }
}

/// What is known about a failed write.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Outcome {
    /// The write did not happen; it is safe to treat as failed.
    NotApplied,
    /// The write may or may not have committed.
    Unknown,
}

#[derive(Debug, thiserror::Error)]
pub enum Error {
    /// The node answered with an error.
    #[error("{status} {code}: {message}")]
    Api {
        status: u16,
        /// Server error code, e.g. `condition_failed`, `not_found`.
        code: String,
        message: String,
        /// For writes, when the server states it.
        outcome: Option<Outcome>,
        /// The full error object.
        details: Value,
    },
    /// A write may or may not have committed. Check it with
    /// [`Client::mutation_status`].
    #[error("outcome unknown for mutation {mutation_id}: {reason}")]
    OutcomeUnknown { mutation_id: String, reason: String },
    /// No node could be reached. For writes, nothing was applied.
    #[error("no node answered: {0}")]
    Unreachable(String),
    #[error("invalid key: {0}")]
    InvalidKey(String),
    #[error("invalid configuration: {0}")]
    Config(String),
    #[error("could not decode the response: {0}")]
    Decode(String),
    #[error("change stream: {0}")]
    Watch(String),
}

impl Error {
    /// The server error code, if the node answered.
    pub fn code(&self) -> Option<&str> {
        match self {
            Error::Api { code, .. } => Some(code),
            _ => None,
        }
    }

    /// The HTTP status, if the node answered.
    pub fn status(&self) -> Option<u16> {
        match self {
            Error::Api { status, .. } => Some(*status),
            _ => None,
        }
    }

    fn from_body(status: u16, body: &Value) -> Error {
        let error = &body["error"];
        let outcome = match error["outcome"].as_str() {
            Some("not_applied") => Some(Outcome::NotApplied),
            Some("unknown") => Some(Outcome::Unknown),
            _ => None,
        };
        Error::Api {
            status,
            code: error["code"].as_str().unwrap_or("http_error").to_owned(),
            message: error["message"]
                .as_str()
                .map_or_else(|| format!("HTTP {status}"), str::to_owned),
            outcome,
            details: error.clone(),
        }
    }
}

pub type Result<T, E = Error> = std::result::Result<T, E>;

#[derive(Debug, Clone, PartialEq)]
pub struct Item<T> {
    pub key: String,
    pub value: T,
    pub version: u64,
    pub expires_at_ms: Option<u64>,
    /// Consistency the server applied.
    pub consistency: String,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct WriteResult {
    pub key: Option<String>,
    /// Commit version; `None` while an `available` write is pending.
    pub version: Option<u64>,
    pub mutation_id: String,
    /// This mutation ID had already committed; nothing new was written.
    pub deduplicated: bool,
    /// `false` when an `available` write was accepted but not yet replicated.
    pub replicated: bool,
    pub consistency: String,
}

#[derive(Debug, Clone, Default)]
pub struct ReadOptions {
    pub consistency: Option<Consistency>,
    /// Staleness bound for `bounded` reads.
    pub max_staleness_ms: Option<u64>,
}

#[derive(Debug, Clone, Default)]
pub struct PutOptions {
    pub consistency: Option<Consistency>,
    pub ttl_ms: Option<u64>,
    /// Write only if the current version equals this (compare-and-set).
    pub if_version: Option<u64>,
    /// Write only if the key does not exist.
    pub if_absent: bool,
    /// Reuse a mutation ID to retry a write safely. Default: random.
    pub mutation_id: Option<String>,
}

#[derive(Debug, Clone, Default)]
pub struct DeleteOptions {
    pub consistency: Option<Consistency>,
    pub if_version: Option<u64>,
    pub mutation_id: Option<String>,
}

#[derive(Debug, Clone, Default)]
pub struct WriteOptions {
    pub consistency: Option<Consistency>,
    pub mutation_id: Option<String>,
}

/// One operation of an atomic batch.
#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(tag = "op", rename_all = "lowercase")]
pub enum BatchOp {
    Put {
        key: String,
        value: Value,
        #[serde(skip_serializing_if = "Option::is_none")]
        ttl_ms: Option<u64>,
        #[serde(skip_serializing_if = "Option::is_none")]
        if_version: Option<u64>,
        #[serde(skip_serializing_if = "std::ops::Not::not")]
        if_absent: bool,
    },
    Delete {
        key: String,
        #[serde(skip_serializing_if = "Option::is_none")]
        if_version: Option<u64>,
    },
}

impl BatchOp {
    /// An unconditional put.
    pub fn put(key: impl Into<String>, value: Value) -> BatchOp {
        BatchOp::Put {
            key: key.into(),
            value,
            ttl_ms: None,
            if_version: None,
            if_absent: false,
        }
    }

    /// An unconditional delete.
    pub fn delete(key: impl Into<String>) -> BatchOp {
        BatchOp::Delete {
            key: key.into(),
            if_version: None,
        }
    }
}

#[derive(Debug, Clone, Default)]
pub struct ScanOptions {
    pub prefix: Option<String>,
    /// Inclusive start key.
    pub start: Option<String>,
    /// Exclusive end key.
    pub end: Option<String>,
    /// Page size, 1–1000.
    pub limit: Option<u32>,
    pub consistency: Option<Consistency>,
}

#[derive(Debug, Clone, PartialEq)]
pub struct ScanPage<T> {
    pub items: Vec<Item<T>>,
    pub next_cursor: Option<String>,
    /// Some data may be missing (unreachable replica sets).
    pub partial: bool,
}

/// A filtered query (`POST /v1/query`), evaluated on the server.
#[derive(Debug, Clone, Default)]
pub struct QueryOptions {
    /// Key range and page size, as for scans.
    pub range: ScanOptions,
    /// MongoDB-style filter, e.g.
    /// `json!({"status": "paid", "total": {"$gte": 100}})`. Operators:
    /// `$eq $ne $gt $gte $lt $lte $in $nin $exists $prefix $contains`,
    /// combined with `$and`, `$or` and `$not`.
    pub filter: Option<serde_json::Value>,
    /// Return only these fields (dotted paths).
    pub fields: Option<Vec<String>>,
    /// Rows each request may read on the server (default 10000).
    pub max_scanned: Option<u32>,
    /// Aggregate the matches instead of returning them, e.g.
    /// `json!({"count": true, "sum": ["total"], "max": ["created"]})`.
    pub aggregate: Option<serde_json::Value>,
    /// Order by a field, e.g. `json!({"field": "total", "order": "desc"})`;
    /// needs an index on that field with that order.
    pub sort: Option<serde_json::Value>,
}

#[derive(Debug, Clone, PartialEq)]
pub struct QueryPage<T> {
    pub items: Vec<Item<T>>,
    /// Set while the range is not done, even on a page with few items.
    pub next_cursor: Option<String>,
    pub partial: bool,
    /// Rows the server read for this page, matching or not.
    pub scanned: u64,
    /// The secondary index that served the page (`None`: a scan).
    pub index: Option<String>,
    /// With `aggregate`: this page's partial aggregates.
    pub aggregates: Option<serde_json::Value>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum MutationStatus {
    Committed {
        version: Option<u64>,
    },
    /// Not committed, still in flight, or older than the retention window.
    Unknown,
}

/// A write that lost last-writer-wins under `available` consistency.
#[derive(Debug, Clone, PartialEq, serde::Deserialize)]
pub struct Conflict {
    pub key: String,
    pub value: Option<String>,
    pub timestamp_ms: u64,
    pub mutation_id: String,
    pub origin: Option<String>,
    pub winner_version: Option<u64>,
    pub winner_timestamp_ms: u64,
    pub winner_mutation_id: String,
}

#[derive(Debug, Clone, PartialEq)]
pub struct Conflicts {
    pub conflicts: Vec<Conflict>,
    pub partial: bool,
}

/// Percent-encodes a key for a URL path, keeping `/` readable.
pub fn encode_key(key: &str) -> Result<String> {
    if key.split('/').any(|s| s == "." || s == "..") {
        return Err(Error::InvalidKey(
            "keys with `.` or `..` path segments cannot be used over HTTP".into(),
        ));
    }
    Ok(key
        .split('/')
        .map(encode_component)
        .collect::<Vec<_>>()
        .join("/"))
}

fn encode_component(s: &str) -> String {
    let mut out = String::with_capacity(s.len());
    for b in s.bytes() {
        if b.is_ascii_alphanumeric() || matches!(b, b'-' | b'_' | b'.' | b'~') {
            out.push(char::from(b));
        } else {
            out.push_str(&format!("%{b:02X}"));
        }
    }
    out
}

fn query(params: &[(&str, Option<String>)]) -> String {
    let pairs: Vec<String> = params
        .iter()
        .filter_map(|(k, v)| v.as_ref().map(|v| format!("{k}={}", encode_component(v))))
        .collect();
    if pairs.is_empty() {
        String::new()
    } else {
        format!("?{}", pairs.join("&"))
    }
}

fn header_pair(
    name: &str,
    value: &str,
) -> Result<(reqwest::header::HeaderName, reqwest::header::HeaderValue)> {
    let n = reqwest::header::HeaderName::from_bytes(name.as_bytes())
        .map_err(|e| Error::Config(format!("header {name}: {e}")))?;
    let v = reqwest::header::HeaderValue::from_str(value)
        .map_err(|e| Error::Config(format!("header {name}: {e}")))?;
    Ok((n, v))
}

#[derive(Debug)]
pub struct ClientBuilder {
    nodes: Vec<String>,
    consistency: Option<Consistency>,
    timeout: Duration,
    attempts: usize,
    headers: Vec<(String, String)>,
}

impl ClientBuilder {
    /// Adds one node base URL, e.g. `http://localhost:8080`.
    pub fn node(mut self, url: impl Into<String>) -> Self {
        self.nodes.push(url.into());
        self
    }

    /// Adds node base URLs.
    pub fn nodes<I, S>(mut self, urls: I) -> Self
    where
        I: IntoIterator<Item = S>,
        S: Into<String>,
    {
        self.nodes.extend(urls.into_iter().map(Into::into));
        self
    }

    /// Default consistency for reads and writes (server default: strict).
    pub fn consistency(mut self, consistency: Consistency) -> Self {
        self.consistency = Some(consistency);
        self
    }

    /// Per-request timeout. Default 10 s.
    pub fn timeout(mut self, timeout: Duration) -> Self {
        self.timeout = timeout;
        self
    }

    /// Attempts per request across nodes and transient errors. Default 4.
    pub fn attempts(mut self, attempts: usize) -> Self {
        self.attempts = attempts.max(1);
        self
    }

    /// API token, sent as `Authorization: Bearer <token>`.
    pub fn token(self, token: impl Into<String>) -> Self {
        let token = token.into();
        self.header("authorization", format!("Bearer {token}"))
    }

    /// An extra header on every request.
    pub fn header(mut self, name: impl Into<String>, value: impl Into<String>) -> Self {
        self.headers.push((name.into(), value.into()));
        self
    }

    pub fn build(self) -> Result<Client> {
        if self.nodes.is_empty() {
            return Err(Error::Config("at least one node URL is required".into()));
        }
        let nodes = self
            .nodes
            .iter()
            .map(|n| {
                let n = n.trim_end_matches('/');
                if n.starts_with("http://") || n.starts_with("https://") {
                    n.to_owned()
                } else {
                    format!("http://{n}")
                }
            })
            .collect();
        let mut headers = reqwest::header::HeaderMap::new();
        for (name, value) in &self.headers {
            let (n, v) = header_pair(name, value)?;
            headers.insert(n, v);
        }
        let http = reqwest::Client::builder()
            .timeout(self.timeout)
            .connect_timeout(self.timeout.min(Duration::from_secs(3)))
            .default_headers(headers)
            .build()
            .map_err(|e| Error::Config(e.to_string()))?;
        Ok(Client {
            nodes,
            consistency: self.consistency,
            attempts: self.attempts,
            headers: self.headers,
            http,
            preferred: AtomicUsize::new(0),
            session: Mutex::new(None),
        })
    }
}

struct Raw {
    status: u16,
    body: Value,
    session: Option<String>,
}

impl Raw {
    fn code(&self) -> &str {
        self.body["error"]["code"].as_str().unwrap_or_default()
    }

    /// A redirect or a 503 that guarantees nothing was applied.
    fn retryable(&self) -> bool {
        (self.status == 421 && REDIRECTS.contains(&self.code()))
            || (self.status == 503 && TRANSIENT.contains(&self.code()))
    }

    fn ok(self) -> Result<Raw> {
        if (200..300).contains(&self.status) {
            Ok(self)
        } else {
            Err(Error::from_body(self.status, &self.body))
        }
    }
}

enum SendError {
    /// The connection could not be opened; the node never saw the request.
    NotSent(String),
    /// The request may have reached the node.
    MaybeSent(String),
}

/// A Celeris client. Share one instance (for example in an `Arc`): it
/// pools connections and remembers the session token.
#[derive(Debug)]
pub struct Client {
    nodes: Vec<String>,
    consistency: Option<Consistency>,
    attempts: usize,
    headers: Vec<(String, String)>,
    http: reqwest::Client,
    /// Index of the node that last answered successfully.
    preferred: AtomicUsize,
    /// Latest session token seen, for `session` reads.
    session: Mutex<Option<String>>,
}

impl Client {
    pub fn builder() -> ClientBuilder {
        ClientBuilder {
            nodes: Vec::new(),
            consistency: None,
            timeout: Duration::from_secs(10),
            attempts: 4,
            headers: Vec::new(),
        }
    }

    /// A client for one node with default settings.
    pub fn new(node: impl Into<String>) -> Result<Client> {
        Client::builder().node(node).build()
    }

    /// The session token from the latest write or read (`<index>@<group>`).
    pub fn session(&self) -> Option<String> {
        self.session.lock().ok().and_then(|s| s.clone())
    }

    fn mode(&self, requested: Option<Consistency>) -> Option<String> {
        requested
            .or(self.consistency)
            .map(|c| c.as_str().to_owned())
    }

    // -- key-value ----------------------------------------------------------

    /// Reads a key. `Ok(None)` if it does not exist.
    pub async fn get<T: DeserializeOwned>(&self, key: &str) -> Result<Option<Item<T>>> {
        self.get_with(key, ReadOptions::default()).await
    }

    pub async fn get_with<T: DeserializeOwned>(
        &self,
        key: &str,
        options: ReadOptions,
    ) -> Result<Option<Item<T>>> {
        let mode = options.consistency.or(self.consistency);
        let mut headers = Vec::new();
        if mode == Some(Consistency::Session)
            && let Some(token) = self.session()
        {
            headers.push((SESSION_HEADER, token));
        }
        let path = format!(
            "/v1/kv/{}{}",
            encode_key(key)?,
            query(&[
                ("consistency", mode.map(|c| c.as_str().to_owned())),
                (
                    "max_staleness_ms",
                    options.max_staleness_ms.map(|v| v.to_string())
                ),
            ])
        );
        let raw = self.read(Method::GET, &path, &headers).await?;
        if raw.status == 404 {
            return Ok(None);
        }
        let raw = raw.ok()?;
        item(&raw.body, None).map(Some)
    }

    /// Writes a JSON-serializable value.
    pub async fn put<T: Serialize + ?Sized>(&self, key: &str, value: &T) -> Result<WriteResult> {
        self.put_with(key, value, PutOptions::default()).await
    }

    pub async fn put_with<T: Serialize + ?Sized>(
        &self,
        key: &str,
        value: &T,
        options: PutOptions,
    ) -> Result<WriteResult> {
        let body = serde_json::to_vec(value).map_err(|e| Error::Decode(e.to_string()))?;
        let path = format!(
            "/v1/kv/{}{}",
            encode_key(key)?,
            query(&[
                ("consistency", self.mode(options.consistency)),
                ("ttl_ms", options.ttl_ms.map(|v| v.to_string())),
                ("if_version", options.if_version.map(|v| v.to_string())),
                ("if_absent", options.if_absent.then(|| "true".to_owned())),
            ])
        );
        self.write(Method::PUT, &path, Some(body), options.mutation_id)
            .await
    }

    /// Deletes a key. Deleting an absent key succeeds.
    pub async fn delete(&self, key: &str) -> Result<WriteResult> {
        self.delete_with(key, DeleteOptions::default()).await
    }

    pub async fn delete_with(&self, key: &str, options: DeleteOptions) -> Result<WriteResult> {
        let path = format!(
            "/v1/kv/{}{}",
            encode_key(key)?,
            query(&[
                ("consistency", self.mode(options.consistency)),
                ("if_version", options.if_version.map(|v| v.to_string())),
            ])
        );
        self.write(Method::DELETE, &path, None, options.mutation_id)
            .await
    }

    /// Applies operations atomically under one mutation ID.
    pub async fn batch(&self, ops: Vec<BatchOp>, options: WriteOptions) -> Result<WriteResult> {
        let mutation_id = options
            .mutation_id
            .unwrap_or_else(|| uuid::Uuid::new_v4().to_string());
        let mut body = serde_json::json!({ "mutation_id": mutation_id, "ops": ops });
        if let Some(mode) = self.mode(options.consistency) {
            body["consistency"] = Value::String(mode);
        }
        let body = serde_json::to_vec(&body).map_err(|e| Error::Decode(e.to_string()))?;
        self.write(Method::POST, "/v1/batch", Some(body), Some(mutation_id))
            .await
    }

    // -- scans ----------------------------------------------------------------

    /// One page of a scan. Pass `after` from the previous page's `next_cursor`.
    pub async fn scan_page<T: DeserializeOwned>(
        &self,
        options: &ScanOptions,
        after: Option<&str>,
    ) -> Result<ScanPage<T>> {
        let path = format!(
            "/v1/scan{}",
            query(&[
                ("prefix", options.prefix.clone()),
                ("start", options.start.clone()),
                ("end", options.end.clone()),
                ("limit", options.limit.map(|v| v.to_string())),
                ("consistency", self.mode(options.consistency)),
                ("after", after.map(str::to_owned)),
            ])
        );
        let raw = self.read(Method::GET, &path, &[]).await?.ok()?;
        let applied = raw.body["consistency"].as_str();
        let items = raw.body["items"]
            .as_array()
            .ok_or_else(|| Error::Decode("scan response without items".into()))?
            .iter()
            .map(|i| item(i, applied))
            .collect::<Result<Vec<_>>>()?;
        Ok(ScanPage {
            items,
            next_cursor: raw.body["next_cursor"].as_str().map(str::to_owned),
            partial: raw.body["partial"].as_bool().unwrap_or(false),
        })
    }

    /// Every item in key order. Prefer [`Client::scan_page`] for large ranges.
    pub async fn scan_all<T: DeserializeOwned>(
        &self,
        options: &ScanOptions,
    ) -> Result<Vec<Item<T>>> {
        let mut out = Vec::new();
        let mut after: Option<String> = None;
        loop {
            let page = self.scan_page::<T>(options, after.as_deref()).await?;
            out.extend(page.items);
            match page.next_cursor {
                Some(cursor) => after = Some(cursor),
                None => return Ok(out),
            }
        }
    }

    /// One page of a filtered query. The server stops after
    /// `max_scanned` rows, so a page can be short and still have a cursor.
    pub async fn query_page<T: DeserializeOwned>(
        &self,
        options: &QueryOptions,
        after: Option<&str>,
    ) -> Result<QueryPage<T>> {
        let r = &options.range;
        let mut body = serde_json::Map::new();
        let mut set = |k: &str, v: Option<serde_json::Value>| {
            if let Some(v) = v {
                body.insert(k.to_owned(), v);
            }
        };
        set("prefix", r.prefix.clone().map(Into::into));
        set("start", r.start.clone().map(Into::into));
        set("end", r.end.clone().map(Into::into));
        set("limit", r.limit.map(Into::into));
        set("consistency", self.mode(r.consistency).map(Into::into));
        set("where", options.filter.clone());
        set("fields", options.fields.clone().map(Into::into));
        set("max_scanned", options.max_scanned.map(Into::into));
        set("aggregate", options.aggregate.clone());
        set("sort", options.sort.clone());
        set("after", after.map(Into::into));
        let body = serde_json::to_vec(&body).map_err(|e| Error::Decode(e.to_string()))?;
        let raw = self
            .read_with_body(Method::POST, "/v1/query", &[], Some(body))
            .await?
            .ok()?;
        let applied = raw.body["consistency"].as_str();
        let items = raw.body["items"]
            .as_array()
            .ok_or_else(|| Error::Decode("query response without items".into()))?
            .iter()
            .map(|i| item(i, applied))
            .collect::<Result<Vec<_>>>()?;
        Ok(QueryPage {
            items,
            next_cursor: raw.body["next_cursor"].as_str().map(str::to_owned),
            partial: raw.body["partial"].as_bool().unwrap_or(false),
            scanned: raw.body["scanned"].as_u64().unwrap_or(0),
            index: raw.body["index"].as_str().map(str::to_owned),
            aggregates: raw.body.get("aggregates").cloned(),
        })
    }

    /// Every matching item, following cursors to the end of the range.
    pub async fn query_all<T: DeserializeOwned>(
        &self,
        options: &QueryOptions,
    ) -> Result<Vec<Item<T>>> {
        let mut out = Vec::new();
        let mut after: Option<String> = None;
        loop {
            let page = self.query_page::<T>(options, after.as_deref()).await?;
            out.extend(page.items);
            match page.next_cursor {
                Some(cursor) => after = Some(cursor),
                None => return Ok(out),
            }
        }
    }

    /// Aggregates every match (`options.aggregate` must be set), following
    /// cursors to the end of the range and merging the pages with
    /// [`merge_aggregates`].
    pub async fn aggregate(&self, options: &QueryOptions) -> Result<serde_json::Value> {
        let mut total: Option<serde_json::Value> = None;
        let mut after: Option<String> = None;
        loop {
            let page = self
                .query_page::<serde_json::Value>(options, after.as_deref())
                .await?;
            let part = page.aggregates.unwrap_or_else(|| serde_json::json!({}));
            match &mut total {
                Some(t) => merge_aggregates(t, &part),
                None => total = Some(part),
            }
            match page.next_cursor {
                Some(cursor) => after = Some(cursor),
                None => return Ok(total.unwrap_or_default()),
            }
        }
    }

    // -- mutations, conflicts, status -----------------------------------------

    /// Whether a mutation committed (within the server's retention window).
    pub async fn mutation_status(&self, mutation_id: &str) -> Result<MutationStatus> {
        let path = format!("/v1/mutations/{}", encode_component(mutation_id));
        let raw = self.read(Method::GET, &path, &[]).await?;
        if raw.status == 404 {
            return Ok(MutationStatus::Unknown);
        }
        let raw = raw.ok()?;
        Ok(MutationStatus::Committed {
            version: raw.body["version"].as_u64(),
        })
    }

    /// Writes that lost last-writer-wins under `available` consistency.
    pub async fn conflicts(&self, prefix: Option<&str>, limit: Option<u32>) -> Result<Conflicts> {
        let path = format!(
            "/v1/conflicts{}",
            query(&[
                ("prefix", prefix.map(str::to_owned)),
                ("limit", limit.map(|v| v.to_string())),
            ])
        );
        let raw = self.read(Method::GET, &path, &[]).await?.ok()?;
        let conflicts = serde_json::from_value(raw.body["conflicts"].clone())
            .map_err(|e| Error::Decode(e.to_string()))?;
        Ok(Conflicts {
            conflicts,
            partial: raw.body["partial"].as_bool().unwrap_or(false),
        })
    }

    /// Forgets the recorded conflicts of a key.
    pub async fn clear_conflicts(&self, key: &str) -> Result<()> {
        let path = format!("/v1/conflicts/{}", encode_key(key)?);
        self.read(Method::DELETE, &path, &[]).await?.ok()?;
        Ok(())
    }

    /// Node, cluster and storage status.
    pub async fn status(&self) -> Result<Value> {
        Ok(self.read(Method::GET, "/v1/status", &[]).await?.ok()?.body)
    }

    // -- change stream ----------------------------------------------------------

    /// Opens a change stream for keys starting with `prefix` on one node.
    pub async fn watch(&self, prefix: &str) -> Result<Watch> {
        let base = &self.nodes[self.start() % self.nodes.len()];
        let url = format!(
            "{}/v1/watch{}",
            base.replacen("http", "ws", 1),
            query(&[("prefix", Some(prefix.to_owned()))])
        );
        let mut request = url
            .as_str()
            .into_client_request()
            .map_err(|e| Error::Watch(e.to_string()))?;
        for (name, value) in &self.headers {
            let (n, v) = header_pair(name, value)?;
            request.headers_mut().insert(n, v);
        }
        let (socket, _) = tokio_tungstenite::connect_async(request)
            .await
            .map_err(|e| Error::Watch(e.to_string()))?;
        let mut watch = Watch {
            socket,
            hello: Value::Null,
        };
        match watch.message().await? {
            Some(hello) if hello["type"] == "hello" => watch.hello = hello,
            other => {
                return Err(Error::Watch(format!("unexpected first message: {other:?}")));
            }
        }
        Ok(watch)
    }

    // -- transport ----------------------------------------------------------------

    async fn send(
        &self,
        node: usize,
        method: Method,
        path: &str,
        headers: &[(&str, String)],
        body: Option<Vec<u8>>,
    ) -> Result<Raw, SendError> {
        let mut request = self
            .http
            .request(method, format!("{}{}", self.nodes[node], path))
            .header("content-type", "application/json");
        for (name, value) in headers {
            request = request.header(*name, value);
        }
        if let Some(body) = body {
            request = request.body(body);
        }
        let response = request.send().await.map_err(|e| {
            if e.is_connect() {
                SendError::NotSent(e.to_string())
            } else {
                SendError::MaybeSent(e.to_string())
            }
        })?;
        let status = response.status().as_u16();
        let session = response
            .headers()
            .get(SESSION_HEADER)
            .and_then(|v| v.to_str().ok())
            .map(str::to_owned);
        let bytes = response
            .bytes()
            .await
            .map_err(|e| SendError::MaybeSent(e.to_string()))?;
        let body = if bytes.is_empty() {
            Value::Null
        } else {
            serde_json::from_slice(&bytes).unwrap_or_else(|_| {
                serde_json::json!({ "error": {
                    "code": "invalid_response",
                    "message": String::from_utf8_lossy(&bytes),
                }})
            })
        };
        Ok(Raw {
            status,
            body,
            session,
        })
    }

    fn remember(&self, node: usize, raw: &Raw) {
        self.preferred.store(node, Ordering::Relaxed);
        if let Some(token) = &raw.session
            && let Ok(mut session) = self.session.lock()
        {
            *session = Some(token.clone());
        }
    }

    fn start(&self) -> usize {
        self.preferred.load(Ordering::Relaxed)
    }

    /// Reads and other idempotent calls: retried on any failure.
    async fn read(&self, method: Method, path: &str, headers: &[(&str, String)]) -> Result<Raw> {
        self.read_with_body(method, path, headers, None).await
    }

    async fn read_with_body(
        &self,
        method: Method,
        path: &str,
        headers: &[(&str, String)],
        body: Option<Vec<u8>>,
    ) -> Result<Raw> {
        let start = self.start();
        let mut last = String::new();
        let mut last_error = None;
        for attempt in 0..self.attempts {
            let node = (start + attempt) % self.nodes.len();
            match self
                .send(node, method.clone(), path, headers, body.clone())
                .await
            {
                Err(SendError::NotSent(e) | SendError::MaybeSent(e)) => last = e,
                Ok(raw) if raw.retryable() => {
                    last_error = Some(Error::from_body(raw.status, &raw.body));
                }
                Ok(raw) => {
                    self.remember(node, &raw);
                    return Ok(raw);
                }
            }
            backoff(attempt, 50).await;
        }
        Err(last_error.unwrap_or(Error::Unreachable(last)))
    }

    /// Writes: retried with the same mutation ID after network failures (the
    /// server deduplicates), on another node after redirects, and after
    /// errors that guarantee nothing was applied.
    async fn write(
        &self,
        method: Method,
        path: &str,
        body: Option<Vec<u8>>,
        mutation_id: Option<String>,
    ) -> Result<WriteResult> {
        let id = mutation_id.unwrap_or_else(|| uuid::Uuid::new_v4().to_string());
        let headers = [(MUTATION_HEADER, id.clone())];
        let start = self.start();
        let mut maybe_sent = false;
        let mut last = String::new();
        let mut last_error = None;
        for attempt in 0..self.attempts {
            let node = (start + attempt) % self.nodes.len();
            match self
                .send(node, method.clone(), path, &headers, body.clone())
                .await
            {
                Err(SendError::NotSent(e)) => last = e,
                Err(SendError::MaybeSent(e)) => {
                    maybe_sent = true;
                    last = e;
                }
                Ok(raw) if raw.retryable() => {
                    let redirect = raw.status == 421;
                    last_error = Some(Error::from_body(raw.status, &raw.body));
                    if redirect {
                        continue;
                    }
                }
                Ok(raw) if raw.body["error"]["outcome"] == "unknown" => {
                    // Retrying with the same ID is safe and may resolve it.
                    maybe_sent = true;
                    last = Error::from_body(raw.status, &raw.body).to_string();
                }
                Ok(raw) => {
                    let raw = raw.ok()?;
                    self.remember(node, &raw);
                    let b = &raw.body;
                    return Ok(WriteResult {
                        key: b["key"].as_str().map(str::to_owned),
                        version: b["version"].as_u64(),
                        mutation_id: b["mutation_id"].as_str().unwrap_or(&id).to_owned(),
                        deduplicated: b["deduplicated"].as_bool().unwrap_or(false),
                        replicated: raw.status != 202,
                        consistency: b["consistency"].as_str().unwrap_or_default().to_owned(),
                    });
                }
            }
            backoff(attempt, 100).await;
        }
        if maybe_sent {
            return Err(Error::OutcomeUnknown {
                mutation_id: id,
                reason: format!("no confirmation after {} attempts: {last}", self.attempts),
            });
        }
        Err(last_error.unwrap_or(Error::Unreachable(last)))
    }
}

async fn backoff(attempt: usize, base_ms: u64) {
    let factor = u64::try_from(attempt).unwrap_or(u64::MAX).saturating_add(1);
    tokio::time::sleep(Duration::from_millis(base_ms.saturating_mul(factor))).await;
}

fn item<T: DeserializeOwned>(body: &Value, consistency: Option<&str>) -> Result<Item<T>> {
    let value =
        serde_json::from_value(body["value"].clone()).map_err(|e| Error::Decode(e.to_string()))?;
    Ok(Item {
        key: body["key"]
            .as_str()
            .ok_or_else(|| Error::Decode("item without key".into()))?
            .to_owned(),
        value,
        version: body["version"]
            .as_u64()
            .ok_or_else(|| Error::Decode("item without version".into()))?,
        expires_at_ms: body["expires_at_ms"].as_u64(),
        consistency: consistency
            .or_else(|| body["consistency"].as_str())
            .unwrap_or_default()
            .to_owned(),
    })
}

/// One applied change.
#[derive(Debug, Clone, PartialEq)]
pub struct ChangeEvent {
    pub key: String,
    /// `"put"` or `"delete"`.
    pub kind: String,
    /// The new value for puts, `Null` for deletes.
    pub value: Value,
    pub version: u64,
    pub mutation_id: String,
}

#[derive(Debug, Clone, PartialEq)]
pub enum WatchEvent {
    Change(ChangeEvent),
    /// The server dropped this many events because the watcher fell behind:
    /// re-read the keys you depend on.
    Lagged(u64),
}

type Socket =
    tokio_tungstenite::WebSocketStream<tokio_tungstenite::MaybeTlsStream<tokio::net::TcpStream>>;

/// An open change stream (best-effort, from "now").
pub struct Watch {
    socket: Socket,
    /// The first message: `node`, `prefix`, `groups`, `partial`.
    pub hello: Value,
}

impl fmt::Debug for Watch {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.debug_struct("Watch")
            .field("hello", &self.hello)
            .finish_non_exhaustive()
    }
}

impl Watch {
    /// Whether this node covers only some replica sets.
    pub fn partial(&self) -> bool {
        self.hello["partial"].as_bool().unwrap_or(false)
    }

    async fn message(&mut self) -> Result<Option<Value>> {
        while let Some(frame) = self.socket.next().await {
            match frame.map_err(|e| Error::Watch(e.to_string()))? {
                Message::Text(text) => {
                    return serde_json::from_str(text.as_str())
                        .map(Some)
                        .map_err(|e| Error::Decode(e.to_string()));
                }
                Message::Close(_) => return Ok(None),
                _ => {}
            }
        }
        Ok(None)
    }

    /// The next event, or `None` once the stream closed.
    pub async fn next(&mut self) -> Result<Option<WatchEvent>> {
        loop {
            let Some(msg) = self.message().await? else {
                return Ok(None);
            };
            match msg["type"].as_str() {
                Some("change") => {
                    return Ok(Some(WatchEvent::Change(ChangeEvent {
                        key: msg["key"].as_str().unwrap_or_default().to_owned(),
                        kind: msg["kind"].as_str().unwrap_or_default().to_owned(),
                        value: msg["value"].clone(),
                        version: msg["version"].as_u64().unwrap_or_default(),
                        mutation_id: msg["mutation_id"].as_str().unwrap_or_default().to_owned(),
                    })));
                }
                Some("lagged") => {
                    return Ok(Some(WatchEvent::Lagged(
                        msg["missed"].as_u64().unwrap_or(0),
                    )));
                }
                _ => {}
            }
        }
    }

    /// Closes the stream.
    pub async fn close(mut self) {
        let _ = self.socket.send(Message::Close(None)).await;
        let _ = self.socket.close(None).await;
    }
}

/// Folds one page's aggregates into running totals: counts and sums add;
/// min and max keep the extreme (numbers order before strings).
pub fn merge_aggregates(total: &mut serde_json::Value, page: &serde_json::Value) {
    use serde_json::Value;
    use std::cmp::Ordering;
    let rank = |a: &Value, b: &Value| match (a, b) {
        (Value::Number(x), Value::Number(y)) => x
            .as_f64()
            .partial_cmp(&y.as_f64())
            .unwrap_or(Ordering::Equal),
        (Value::String(x), Value::String(y)) => x.cmp(y),
        (Value::Number(_), _) => Ordering::Less,
        _ => Ordering::Greater,
    };
    if let Some(c) = page["count"].as_u64() {
        total["count"] = (total["count"].as_u64().unwrap_or(0) + c).into();
    }
    if let Some(sums) = page["sum"].as_object() {
        for (field, v) in sums {
            let t = total["sum"][field].clone();
            total["sum"][field] = match (t.as_i64(), v.as_i64()) {
                (Some(a), Some(b)) => a
                    .checked_add(b)
                    .map_or_else(|| Value::from(a as f64 + b as f64), Value::from),
                _ => match (t.as_f64(), v.as_f64()) {
                    (Some(a), Some(b)) => Value::from(a + b),
                    (None, _) => v.clone(),
                    (Some(_), None) => t,
                },
            };
        }
    }
    for (key, keep) in [("min", Ordering::Less), ("max", Ordering::Greater)] {
        if let Some(values) = page[key].as_object() {
            for (field, v) in values {
                let t = &total[key][field];
                if t.is_null() || (!v.is_null() && rank(v, t) == keep) {
                    total[key][field] = v.clone();
                }
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn keys_are_encoded_per_segment() {
        assert_eq!(
            encode_key("a b/ü?").ok().as_deref(),
            Some("a%20b/%C3%BC%3F")
        );
        assert!(matches!(encode_key("a/../b"), Err(Error::InvalidKey(_))));
    }

    #[test]
    fn batch_ops_serialize_like_the_api() {
        let ops = vec![
            BatchOp::Put {
                key: "k".into(),
                value: serde_json::json!(1),
                ttl_ms: None,
                if_version: None,
                if_absent: true,
            },
            BatchOp::delete("d"),
        ];
        assert_eq!(
            serde_json::to_value(&ops).ok(),
            Some(serde_json::json!([
                {"op": "put", "key": "k", "value": 1, "if_absent": true},
                {"op": "delete", "key": "d"}
            ]))
        );
    }

    #[test]
    fn query_skips_absent_values_and_escapes() {
        assert_eq!(query(&[("a", None)]), "");
        assert_eq!(
            query(&[("prefix", Some("a b&".into())), ("x", None)]),
            "?prefix=a%20b%26"
        );
    }
}
