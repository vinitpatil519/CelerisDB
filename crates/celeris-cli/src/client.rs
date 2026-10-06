//! Minimal blocking HTTP client for the node API.

use std::fmt::{self, Write};
use std::thread;
use std::time::Duration;

use celeris_core::MutationId;
use serde_json::Value;

const MUTATION_ID_HEADER: &str = "celeris-mutation-id";
const WRITE_ATTEMPTS: u32 = 3;

#[derive(Debug)]
pub struct Reply {
    pub status: u16,
    pub body: Value,
}

impl Reply {
    pub fn is_success(&self) -> bool {
        (200..300).contains(&self.status)
    }

    pub fn error_code(&self) -> Option<&str> {
        self.body["error"]["code"].as_str()
    }
}

/// A transport-level failure, classified by what it implies for writes.
#[derive(Debug)]
pub enum Failure {
    /// No connection was established; the node never saw the request.
    NotSent(String),
    /// The request may have reached the node before the failure.
    MaybeSent(String),
}

impl fmt::Display for Failure {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Failure::NotSent(r) | Failure::MaybeSent(r) => f.write_str(r),
        }
    }
}

#[derive(Debug)]
pub enum WriteResult {
    /// The node answered (success or error).
    Done(Reply),
    /// Every attempt failed and at least one may have been delivered.
    Unknown {
        mutation_id: MutationId,
        reason: String,
    },
    /// Every attempt failed before reaching the node.
    NotSent(String),
}

#[derive(Debug)]
pub struct Client {
    base: String,
    agent: ureq::Agent,
    token: Option<String>,
}

/// The API token every client sends (`--token` / `CELERIS_TOKEN`), set
/// once at startup.
static TOKEN: std::sync::OnceLock<Option<String>> = std::sync::OnceLock::new();

pub fn set_token(token: Option<String>) {
    let _ = TOKEN.set(token.filter(|t| !t.is_empty()));
}

/// TLS trust for HTTPS nodes signed by a private CA (`--ca-cert`).
static TLS: std::sync::OnceLock<Option<std::sync::Arc<rustls::ClientConfig>>> =
    std::sync::OnceLock::new();

/// Trusts only the CA certificates in `pem_file` for HTTPS. Without it, the
/// public web PKI roots are used.
pub fn set_ca_cert(pem_file: Option<&std::path::Path>) -> anyhow::Result<()> {
    use rustls_pki_types::CertificateDer;
    use rustls_pki_types::pem::PemObject;
    let config = match pem_file {
        None => None,
        Some(path) => {
            let pem = std::fs::read(path)
                .map_err(|e| anyhow::anyhow!("reading CA certificate {}: {e}", path.display()))?;
            let mut roots = rustls::RootCertStore::empty();
            for cert in CertificateDer::pem_slice_iter(&pem) {
                roots.add(cert.map_err(|e| anyhow::anyhow!("parsing {}: {e}", path.display()))?)?;
            }
            anyhow::ensure!(
                !roots.is_empty(),
                "{} contains no certificate",
                path.display()
            );
            let provider = std::sync::Arc::new(rustls::crypto::ring::default_provider());
            Some(std::sync::Arc::new(
                rustls::ClientConfig::builder_with_provider(provider)
                    .with_safe_default_protocol_versions()?
                    .with_root_certificates(roots)
                    .with_no_client_auth(),
            ))
        }
    };
    let _ = TLS.set(config);
    Ok(())
}

impl Client {
    pub fn new(addr: &str) -> Self {
        let addr = addr.trim_end_matches('/');
        let base = if addr.starts_with("http://") || addr.starts_with("https://") {
            addr.to_owned()
        } else {
            format!("http://{addr}")
        };
        let mut agent = ureq::AgentBuilder::new()
            .timeout_connect(Duration::from_secs(3))
            .timeout(Duration::from_secs(60));
        if let Some(Some(tls)) = TLS.get() {
            agent = agent.tls_config(std::sync::Arc::clone(tls));
        }
        let agent = agent.build();
        Client {
            base,
            agent,
            token: TOKEN.get().cloned().flatten(),
        }
    }

    pub fn base(&self) -> &str {
        &self.base
    }

    /// GETs raw bytes: (status, body, `celeris-version` header).
    pub fn download(&self, path: &str) -> Result<(u16, Vec<u8>, Option<String>), Failure> {
        use std::io::Read;
        let mut req = self.agent.get(&format!("{}{path}", self.base));
        if let Some(token) = &self.token {
            req = req.set("authorization", &format!("Bearer {token}"));
        }
        let resp = match req.call() {
            Ok(r) | Err(ureq::Error::Status(_, r)) => r,
            Err(ureq::Error::Transport(t)) => return Err(Failure::NotSent(t.to_string())),
        };
        let status = resp.status();
        let version = resp.header("celeris-version").map(str::to_owned);
        let mut bytes = Vec::new();
        resp.into_reader()
            .take(2 * 1024 * 1024 * 1024)
            .read_to_end(&mut bytes)
            .map_err(|e| Failure::MaybeSent(format!("reading response: {e}")))?;
        Ok((status, bytes, version))
    }

    pub fn send(
        &self,
        method: &str,
        path: &str,
        headers: &[(&str, &str)],
        body: Option<&[u8]>,
    ) -> Result<Reply, Failure> {
        let mut req = self.agent.request(method, &format!("{}{path}", self.base));
        if let Some(token) = &self.token {
            req = req.set("authorization", &format!("Bearer {token}"));
        }
        for (k, v) in headers {
            req = req.set(k, v);
        }
        let result = match body {
            Some(b) => req.send_bytes(b),
            None => req.call(),
        };
        let resp = match result {
            Ok(r) | Err(ureq::Error::Status(_, r)) => r,
            Err(ureq::Error::Transport(t)) => {
                return Err(match t.kind() {
                    ureq::ErrorKind::ConnectionFailed | ureq::ErrorKind::Dns => {
                        Failure::NotSent(t.to_string())
                    }
                    _ => Failure::MaybeSent(t.to_string()),
                });
            }
        };
        let status = resp.status();
        let text = resp
            .into_string()
            .map_err(|e| Failure::MaybeSent(format!("reading response: {e}")))?;
        let body = serde_json::from_str(&text).unwrap_or(Value::String(text));
        Ok(Reply { status, body })
    }

    /// GET for read-only calls; failures are plain errors.
    pub fn get(&self, path: &str) -> anyhow::Result<Reply> {
        self.send("GET", path, &[], None)
            .map_err(|f| anyhow::anyhow!("cannot reach node at {}: {f}", self.base))
    }

    /// POST of a JSON body for read-only calls (queries).
    pub fn post_read(&self, path: &str, body: &Value) -> anyhow::Result<Reply> {
        let bytes = serde_json::to_vec(body)?;
        self.send(
            "POST",
            path,
            &[("content-type", "application/json")],
            Some(&bytes),
        )
        .map_err(|f| anyhow::anyhow!("cannot reach node at {}: {f}", self.base))
    }

    /// Sends a mutation, retrying transport failures with the same mutation
    /// ID. The server deduplicates by ID, so retries never apply twice.
    pub fn write(
        &self,
        method: &str,
        path: &str,
        body: Option<&[u8]>,
        id: MutationId,
    ) -> WriteResult {
        let id_text = id.to_string();
        let headers = [
            (MUTATION_ID_HEADER, id_text.as_str()),
            ("content-type", "application/json"),
        ];
        let mut maybe_sent = None;
        let mut last = String::new();
        for attempt in 0..WRITE_ATTEMPTS {
            if attempt > 0 {
                thread::sleep(Duration::from_millis(200 * u64::from(attempt)));
            }
            match self.send(method, path, &headers, body) {
                Ok(reply) => return WriteResult::Done(reply),
                Err(Failure::NotSent(r)) => last = r,
                Err(Failure::MaybeSent(r)) => {
                    last.clone_from(&r);
                    maybe_sent = Some(r);
                }
            }
        }
        match maybe_sent {
            Some(reason) => WriteResult::Unknown {
                mutation_id: id,
                reason,
            },
            None => WriteResult::NotSent(last),
        }
    }
}

fn encode(s: &str, keep: &[u8]) -> String {
    let mut out = String::with_capacity(s.len());
    for &b in s.as_bytes() {
        if b.is_ascii_alphanumeric() || b"-._~".contains(&b) || keep.contains(&b) {
            out.push(char::from(b));
        } else {
            let _ = write!(out, "%{b:02X}");
        }
    }
    out
}

/// Percent-encodes a key for use in a URL path, keeping `/` readable.
///
/// URL parsers collapse `.` and `..` path segments, so keys containing them
/// cannot be addressed by path and are rejected.
pub fn encode_path(key: &str) -> anyhow::Result<String> {
    if key.split('/').any(|seg| seg == "." || seg == "..") {
        anyhow::bail!("keys with `.` or `..` path segments cannot be used over HTTP");
    }
    Ok(encode(key, b"/"))
}

pub fn query_string(pairs: &[(&str, String)]) -> String {
    if pairs.is_empty() {
        return String::new();
    }
    let joined: Vec<String> = pairs
        .iter()
        .map(|(k, v)| format!("{k}={}", encode(v, b"/")))
        .collect();
    format!("?{}", joined.join("&"))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn encoding() {
        assert_eq!(encode_path("users/42").expect("ok"), "users/42");
        assert_eq!(encode_path("a b?c#d%").expect("ok"), "a%20b%3Fc%23d%25");
        assert_eq!(encode_path("ünï").expect("ok"), "%C3%BCn%C3%AF");
        assert!(encode_path("a/../b").is_err());
        assert_eq!(
            query_string(&[("prefix", "users/".into()), ("x", "a&b=c".into())]),
            "?prefix=users/&x=a%26b%3Dc"
        );
        assert_eq!(query_string(&[]), "");
    }

    #[test]
    fn unreachable_writes_are_reported_as_not_sent() {
        // Port 1 on loopback is essentially never listening.
        let client = Client::new("127.0.0.1:1");
        match client.write("PUT", "/v1/kv/x", Some(b"1"), MutationId::random()) {
            WriteResult::NotSent(_) => {}
            other => panic!("expected NotSent, got {other:?}"),
        }
    }
}
