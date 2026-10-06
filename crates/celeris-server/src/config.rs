//! Node configuration: `celeris.toml` plus `CELERIS_*` environment overrides.

use std::fs;
use std::net::SocketAddr;
use std::path::{Path, PathBuf};
use std::time::Duration;

use anyhow::{Context, bail};
use axum::http::HeaderValue;
use celeris_storage::{Options, SyncMode};
use serde::{Deserialize, Serialize};

/// Default config file name, looked up in the working directory.
pub const FILE_NAME: &str = "celeris.toml";

const MIB: u64 = 1024 * 1024;

#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(default, deny_unknown_fields)]
pub struct Config {
    pub node: NodeConfig,
    pub http: HttpConfig,
    pub cluster: ClusterConfig,
    pub storage: StorageConfig,
    pub log: LogConfig,
    pub auth: AuthConfig,
    /// Secondary indexes on JSON fields (D-031). Every node of a cluster
    /// should list the same indexes.
    pub indexes: Vec<IndexConfig>,
}

/// One secondary index: `field` (a dotted path) of the JSON values of keys
/// starting with `prefix`.
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct IndexConfig {
    pub name: String,
    #[serde(default)]
    pub prefix: String,
    pub field: String,
}

impl IndexConfig {
    pub fn spec(&self) -> anyhow::Result<celeris_storage::IndexSpec> {
        celeris_storage::IndexSpec::new(&self.name, &self.prefix, &self.field)
            .map_err(|e| anyhow::anyhow!("{e}"))
    }
}

/// API authentication. With no tokens, every request is allowed and admin
/// endpoints accept loopback connections only.
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(default, deny_unknown_fields)]
pub struct AuthConfig {
    pub tokens: Vec<crate::auth::TokenConfig>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(default, deny_unknown_fields)]
pub struct NodeConfig {
    /// Root of everything this node persists. Relative paths in a config
    /// file are resolved against the file's directory.
    pub data_dir: PathBuf,
    /// Fixed node ID (1-64 of `[A-Za-z0-9._-]`). Optional: a random ID is
    /// generated on first start. Must match the ID already in `data_dir`.
    pub id: Option<String>,
}

impl Default for NodeConfig {
    fn default() -> Self {
        NodeConfig {
            data_dir: PathBuf::from("celeris-data"),
            id: None,
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(default, deny_unknown_fields)]
pub struct HttpConfig {
    /// Client API listen address. Loopback by default: nothing is exposed
    /// to the network unless explicitly configured.
    pub listen: String,
    /// Browser origins allowed by CORS. Empty disables CORS; `"*"` allows any.
    pub cors_origins: Vec<String>,
    /// Serve HTTPS with this certificate and key. Relative paths in a config
    /// file are resolved against the file's directory.
    pub tls: Option<TlsConfig>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct TlsConfig {
    /// PEM certificate chain (leaf first).
    pub cert_file: PathBuf,
    /// PEM private key (PKCS#8, PKCS#1 or SEC1).
    pub key_file: PathBuf,
}

impl Default for HttpConfig {
    fn default() -> Self {
        HttpConfig {
            listen: "127.0.0.1:8080".into(),
            cors_origins: Vec::new(),
            tls: None,
        }
    }
}

/// Node-to-node settings. Without `listen` the node runs single-node.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(default, deny_unknown_fields)]
pub struct ClusterConfig {
    /// Internal cluster port (never exposed to browsers), e.g. "0.0.0.0:7000".
    pub listen: Option<String>,
    /// Address peers use to reach this node. Required when `listen` is a
    /// wildcard address; defaults to the bound listen address.
    pub advertise: Option<String>,
    /// Cluster addresses of existing members to join through.
    pub seeds: Vec<String>,
    /// Failure domain (rack / availability zone) for replica placement.
    pub zone: String,
    pub heartbeat_interval_ms: u64,
    pub suspect_after_ms: u64,
    pub suspicion_timeout_ms: u64,
    /// Node IDs of the control-plane (Raft) voters, fixed at bootstrap.
    /// Empty: no control plane, membership only.
    pub voters: Vec<String>,
    /// Minimum Raft election timeout; the maximum is twice this.
    pub raft_election_timeout_ms: u64,
    pub raft_heartbeat_ms: u64,
    /// A replication group snapshots its data and discards its applied Raft
    /// log once the log holds more than this many entries.
    pub snapshot_threshold: u64,
    /// The control-plane leader re-places partitions on its own once the
    /// set of live members has differed from the placement, unchanged, for
    /// this long. 0 disables it (rebalance only on request).
    pub auto_rebalance_after_ms: u64,
    /// Replicas per partition for the first placement, which the
    /// control-plane leader proposes on its own once every voter is alive
    /// (capped at the number of nodes). 0 disables automatic bootstrap; then
    /// run `celeris cluster rebalance --rf N` once.
    pub replication_factor: u8,
    /// How often each group leader verifies that its replicas hold
    /// identical data (and repairs diverged ones). 0 disables it.
    pub anti_entropy_interval_ms: u64,
}

impl Default for ClusterConfig {
    fn default() -> Self {
        let m = celeris_cluster::MembershipConfig::default();
        ClusterConfig {
            listen: None,
            advertise: None,
            seeds: Vec::new(),
            zone: celeris_core::partition::DEFAULT_ZONE.into(),
            heartbeat_interval_ms: m.heartbeat_interval_ms,
            suspect_after_ms: m.suspect_after_ms,
            suspicion_timeout_ms: m.suspicion_timeout_ms,
            voters: Vec::new(),
            raft_election_timeout_ms: 1_000,
            raft_heartbeat_ms: 250,
            snapshot_threshold: 10_000,
            auto_rebalance_after_ms: 30_000,
            replication_factor: 3,
            anti_entropy_interval_ms: 60_000,
        }
    }
}

impl ClusterConfig {
    pub fn membership(&self) -> celeris_cluster::MembershipConfig {
        celeris_cluster::MembershipConfig {
            heartbeat_interval_ms: self.heartbeat_interval_ms,
            suspect_after_ms: self.suspect_after_ms,
            suspicion_timeout_ms: self.suspicion_timeout_ms,
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum SyncSetting {
    Always,
    Never,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(default, deny_unknown_fields)]
pub struct StorageConfig {
    pub sync: SyncSetting,
    pub memtable_size_mb: u64,
    pub block_cache_mb: u64,
    pub tombstone_retention_secs: u64,
    pub mutation_retention_secs: u64,
}

impl Default for StorageConfig {
    fn default() -> Self {
        StorageConfig {
            sync: SyncSetting::Always,
            memtable_size_mb: 32,
            block_cache_mb: 64,
            tombstone_retention_secs: 24 * 60 * 60,
            mutation_retention_secs: 24 * 60 * 60,
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum LogFormat {
    Pretty,
    Json,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(default, deny_unknown_fields)]
pub struct LogConfig {
    pub level: String,
    pub format: LogFormat,
}

impl Default for LogConfig {
    fn default() -> Self {
        LogConfig {
            level: "info".into(),
            format: LogFormat::Pretty,
        }
    }
}

impl Config {
    /// Reads a TOML config file. Relative `data_dir` is resolved against the
    /// file's directory so the node finds its data regardless of the working
    /// directory it is started from.
    pub fn load(path: &Path) -> anyhow::Result<Config> {
        let text =
            fs::read_to_string(path).with_context(|| format!("reading {}", path.display()))?;
        let mut config: Config =
            toml::from_str(&text).with_context(|| format!("parsing {}", path.display()))?;
        if let Some(base) = path.parent() {
            if config.node.data_dir.is_relative() {
                config.node.data_dir = base.join(&config.node.data_dir);
            }
            if let Some(tls) = &mut config.http.tls {
                for file in [&mut tls.cert_file, &mut tls.key_file] {
                    if file.is_relative() {
                        *file = base.join(&*file);
                    }
                }
            }
        }
        Ok(config)
    }

    /// Applies `CELERIS_*` overrides. `get` is usually `std::env::var(..).ok()`.
    pub fn apply_env(&mut self, get: impl Fn(&str) -> Option<String>) -> anyhow::Result<()> {
        if let Some(v) = get("CELERIS_DATA_DIR") {
            self.node.data_dir = v.into();
        }
        if let Some(v) = get("CELERIS_NODE_ID") {
            self.node.id = Some(v).filter(|s| !s.is_empty());
        }
        if let Some(v) = get("CELERIS_CLUSTER_VOTERS") {
            self.cluster.voters = v
                .split(',')
                .map(str::trim)
                .filter(|s| !s.is_empty())
                .map(String::from)
                .collect();
        }
        match (get("CELERIS_TLS_CERT"), get("CELERIS_TLS_KEY")) {
            (Some(cert), Some(key)) => {
                self.http.tls = Some(TlsConfig {
                    cert_file: cert.into(),
                    key_file: key.into(),
                });
            }
            (None, None) => {}
            _ => bail!("set both CELERIS_TLS_CERT and CELERIS_TLS_KEY, or neither"),
        }
        if let Some(v) = get("CELERIS_REPLICATION_FACTOR") {
            self.cluster.replication_factor = v
                .parse()
                .with_context(|| format!("CELERIS_REPLICATION_FACTOR must be 0-255, got `{v}`"))?;
        }
        if let Some(v) = get("CELERIS_HTTP_LISTEN") {
            self.http.listen = v;
        }
        if let Some(v) = get("CELERIS_CORS_ORIGINS") {
            self.http.cors_origins = v
                .split(',')
                .map(str::trim)
                .filter(|s| !s.is_empty())
                .map(String::from)
                .collect();
        }
        if let Some(v) = get("CELERIS_CLUSTER_LISTEN") {
            self.cluster.listen = Some(v).filter(|s| !s.is_empty());
        }
        if let Some(v) = get("CELERIS_CLUSTER_ADVERTISE") {
            self.cluster.advertise = Some(v).filter(|s| !s.is_empty());
        }
        if let Some(v) = get("CELERIS_CLUSTER_SEEDS") {
            self.cluster.seeds = v
                .split(',')
                .map(str::trim)
                .filter(|s| !s.is_empty())
                .map(String::from)
                .collect();
        }
        if let Some(v) = get("CELERIS_ZONE") {
            self.cluster.zone = v;
        }
        if let Some(v) = get("CELERIS_SYNC") {
            self.storage.sync = match v.as_str() {
                "always" => SyncSetting::Always,
                "never" => SyncSetting::Never,
                other => bail!("CELERIS_SYNC must be `always` or `never`, got `{other}`"),
            };
        }
        if let Some(v) = get("CELERIS_LOG_LEVEL") {
            self.log.level = v;
        }
        if let Some(v) = get("CELERIS_LOG_FORMAT") {
            self.log.format = match v.as_str() {
                "pretty" => LogFormat::Pretty,
                "json" => LogFormat::Json,
                other => bail!("CELERIS_LOG_FORMAT must be `pretty` or `json`, got `{other}`"),
            };
        }
        if let Some(v) = get("CELERIS_AUTH_TOKENS") {
            // Replaces the file's tokens, so a deployment can inject them.
            self.auth.tokens = v
                .split(',')
                .filter(|s| !s.trim().is_empty())
                .map(crate::auth::TokenConfig::parse_env)
                .collect::<Result<_, _>>()
                .map_err(anyhow::Error::msg)?;
        }
        Ok(())
    }

    pub fn validate(&self) -> anyhow::Result<()> {
        self.listen_addr()?;
        let mut names = std::collections::HashSet::new();
        for index in &self.indexes {
            index.spec()?;
            if !names.insert(&index.name) {
                bail!("index `{}` is defined twice", index.name);
            }
        }
        crate::auth::Authenticator::new(&self.auth.tokens).map_err(anyhow::Error::msg)?;
        for origin in &self.http.cors_origins {
            if origin != "*" && HeaderValue::from_str(origin).is_err() {
                bail!("invalid CORS origin `{origin}`");
            }
        }
        if let Some(listen) = &self.cluster.listen {
            let addr: SocketAddr = listen
                .parse()
                .with_context(|| format!("invalid cluster.listen address `{listen}`"))?;
            if addr.ip().is_unspecified() && self.cluster.advertise.is_none() {
                bail!("cluster.listen `{listen}` is a wildcard address; set cluster.advertise");
            }
            let c = &self.cluster;
            if c.heartbeat_interval_ms == 0 || c.suspect_after_ms <= c.heartbeat_interval_ms {
                bail!("cluster.suspect_after_ms must exceed heartbeat_interval_ms (> 0)");
            }
            for voter in &c.voters {
                celeris_core::partition::NodeId::new(voter.clone())
                    .with_context(|| format!("cluster.voters entry `{voter}`"))?;
            }
            if !c.voters.is_empty()
                && (c.raft_heartbeat_ms == 0
                    || c.raft_election_timeout_ms <= 2 * c.raft_heartbeat_ms)
            {
                bail!("cluster.raft_election_timeout_ms must exceed twice raft_heartbeat_ms (> 0)");
            }
            if c.snapshot_threshold == 0 {
                bail!("cluster.snapshot_threshold must be at least 1");
            }
        } else if !self.cluster.seeds.is_empty() || !self.cluster.voters.is_empty() {
            bail!("cluster.seeds and cluster.voters require cluster.listen");
        }
        if let Some(id) = &self.node.id {
            celeris_core::partition::NodeId::new(id.clone())
                .with_context(|| format!("node.id `{id}`"))?;
        }
        if self.storage.memtable_size_mb == 0 {
            bail!("storage.memtable_size_mb must be at least 1");
        }
        if self.storage.mutation_retention_secs == 0 {
            bail!("storage.mutation_retention_secs must be at least 1");
        }
        Ok(())
    }

    pub fn listen_addr(&self) -> anyhow::Result<SocketAddr> {
        self.http
            .listen
            .parse()
            .with_context(|| format!("invalid http.listen address `{}`", self.http.listen))
    }

    /// Where the storage engine keeps its files.
    pub fn storage_dir(&self) -> PathBuf {
        self.node.data_dir.join("storage")
    }

    pub fn engine_options(&self) -> Options {
        let s = &self.storage;
        Options {
            sync: match s.sync {
                SyncSetting::Always => SyncMode::Always,
                SyncSetting::Never => SyncMode::Never,
            },
            memtable_size_bytes: usize::try_from(s.memtable_size_mb * MIB).unwrap_or(usize::MAX),
            block_cache_bytes: usize::try_from(s.block_cache_mb * MIB).unwrap_or(usize::MAX),
            tombstone_retention: Duration::from_secs(s.tombstone_retention_secs),
            mutation_retention: Duration::from_secs(s.mutation_retention_secs),
            // Invalid definitions are rejected by `validate`.
            indexes: self.indexes.iter().filter_map(|i| i.spec().ok()).collect(),
            ..Options::default()
        }
    }

    /// Commented config file written by `celeris init`.
    pub fn template(listen: &str) -> String {
        TEMPLATE.replace("{listen}", listen)
    }
}

const TEMPLATE: &str = r#"# Celeris node configuration.
# Every setting can be overridden by the environment variable in [brackets].

[node]
# Where this node keeps its data. Relative paths are resolved against this file. [CELERIS_DATA_DIR]
data_dir = "celeris-data"
# Optional fixed node ID; otherwise one is generated on first start. [CELERIS_NODE_ID]
# id = "node-a"

[http]
# Client API address. 127.0.0.1 keeps the node private to this machine;
# use "0.0.0.0:8080" to accept remote clients. [CELERIS_HTTP_LISTEN]
listen = "{listen}"
# Browser origins allowed to call the API, e.g. ["http://localhost:5173"]. [CELERIS_CORS_ORIGINS]
cors_origins = []
# Serve HTTPS instead of HTTP. [CELERIS_TLS_CERT, CELERIS_TLS_KEY]
# tls = { cert_file = "tls/node.crt", key_file = "tls/node.key" }

[cluster]
# Uncomment `listen` to join a cluster. The cluster port carries only
# node-to-node gossip and is never served to browsers. [CELERIS_CLUSTER_LISTEN]
# listen = "127.0.0.1:7000"
# Address peers use to reach this node; required if listen is 0.0.0.0. [CELERIS_CLUSTER_ADVERTISE]
# advertise = "10.0.0.5:7000"
# Cluster addresses of existing members to join through. [CELERIS_CLUSTER_SEEDS]
# seeds = ["10.0.0.4:7000"]
# Failure domain (rack or availability zone) used to spread replicas. [CELERIS_ZONE]
zone = "default"
# Node IDs of the control-plane (Raft) voters, fixed at bootstrap; use 3 or 5.
# Each voter should set [node] id so its ID is known in advance. [CELERIS_CLUSTER_VOTERS]
# voters = ["node-a", "node-b", "node-c"]
# Replicas per partition. Once every voter is up, the control-plane leader
# places partitions with this many replicas (capped at the node count).
# 0 = wait for `celeris cluster rebalance --rf N`. [CELERIS_REPLICATION_FACTOR]
# replication_factor = 3

[storage]
# "always": fsync every write before acknowledging it (survives power loss).
# "never":  leave flushing to the OS (survives process crashes only). [CELERIS_SYNC]
sync = "always"
memtable_size_mb = 32
block_cache_mb = 64
# Deleted and expired data is kept this long so stale replicas cannot resurrect it.
tombstone_retention_secs = 86400
# How long mutation IDs are remembered, making client retries safe.
mutation_retention_secs = 86400

[auth]
# Bearer tokens for the API. Without any, every request is allowed and
# admin endpoints accept loopback connections only. Create one with
# `celeris token create --name app --scope read --scope write`, which prints
# the entry to paste here. Only the SHA-256 of each token is stored.
# Scopes: read, write, admin. [CELERIS_AUTH_TOKENS="name:read+write:<sha256>,..."]
# [[auth.tokens]]
# name = "app"
# sha256 = "<64 hex characters>"
# scopes = ["read", "write"]

# Secondary indexes make equality filters in `POST /v1/query` read only
# matching keys. Each indexes one field of the JSON values under a prefix.
# A new index is built in the background; a removed one is deleted.
# [[indexes]]
# name = "orders_by_status"
# prefix = "orders/"
# field = "status"

[log]
level = "info"     # [CELERIS_LOG_LEVEL] (RUST_LOG also works)
format = "pretty"  # "pretty" or "json" [CELERIS_LOG_FORMAT]
"#;

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn template_parses_to_defaults_with_listen() {
        let config: Config = toml::from_str(&Config::template("0.0.0.0:9000")).expect("parse");
        assert_eq!(config.http.listen, "0.0.0.0:9000");
        assert_eq!(config.storage, StorageConfig::default());
        assert_eq!(config.node, NodeConfig::default());
        config.validate().expect("valid");
    }

    #[test]
    fn relative_data_dir_resolves_against_config_file() {
        let dir = tempfile::tempdir().expect("tempdir");
        let path = dir.path().join(FILE_NAME);
        fs::write(&path, Config::template("127.0.0.1:0")).expect("write");
        let config = Config::load(&path).expect("load");
        assert_eq!(config.node.data_dir, dir.path().join("celeris-data"));
    }

    #[test]
    fn unknown_keys_are_rejected() {
        assert!(toml::from_str::<Config>("[http]\nlisten_addr = \"x\"").is_err());
    }

    #[test]
    fn env_overrides() {
        let mut config = Config::default();
        config
            .apply_env(|k| match k {
                "CELERIS_HTTP_LISTEN" => Some("0.0.0.0:1".into()),
                "CELERIS_SYNC" => Some("never".into()),
                "CELERIS_CORS_ORIGINS" => Some("http://a.test, http://b.test".into()),
                _ => None,
            })
            .expect("apply");
        assert_eq!(config.http.listen, "0.0.0.0:1");
        assert_eq!(config.storage.sync, SyncSetting::Never);
        assert_eq!(config.http.cors_origins.len(), 2);
        assert!(
            config
                .apply_env(|k| (k == "CELERIS_SYNC").then(|| "sometimes".into()))
                .is_err()
        );
    }

    #[test]
    fn validation_catches_bad_values() {
        let mut config = Config::default();
        config.http.listen = "not an address".into();
        assert!(config.validate().is_err());
        let mut config = Config::default();
        config.http.cors_origins = vec!["bad\norigin".into()];
        assert!(config.validate().is_err());
    }

    #[test]
    fn engine_options_follow_config() {
        let mut config = Config::default();
        config.storage.sync = SyncSetting::Never;
        config.storage.memtable_size_mb = 2;
        let o = config.engine_options();
        assert_eq!(o.sync, SyncMode::Never);
        assert_eq!(o.memtable_size_bytes, 2 * 1024 * 1024);
    }
}
