//! `celeris`: run and operate Celeris nodes from the command line.
//!
//! Exit codes: 0 success, 1 error, 2 usage error, 3 write outcome unknown
//! (it may have committed; resolve with `celeris mutation <id>`), 4 not found.

mod backup;
mod bench;
mod client;
mod doctor;

use std::fs;
use std::io::{self, Read, Write};
use std::path::{Path, PathBuf};
use std::process::ExitCode;
use std::sync::Arc;
use std::time::Duration;

use anyhow::{Context, bail};
use celeris_core::MutationId;
use celeris_server::config::{self, LogFormat};
use celeris_server::{Config, Node};
use clap::{Parser, Subcommand};
use serde_json::Value;

use crate::client::{Client, Reply, WriteResult, encode_path, query_string};

const EXIT_UNKNOWN: u8 = 3;
const EXIT_NOT_FOUND: u8 = 4;

#[derive(Debug, Parser)]
#[command(
    name = "celeris",
    version,
    about = "Celeris: distributed data, at speed."
)]
struct Cli {
    /// Node API address.
    #[arg(
        long,
        global = true,
        env = "CELERIS_ADDR",
        default_value = "http://127.0.0.1:8080"
    )]
    addr: String,
    /// Print raw JSON responses.
    #[arg(long, global = true)]
    json: bool,
    /// PEM CA certificate to trust for HTTPS nodes (private CAs, self-signed).
    #[arg(long, global = true, env = "CELERIS_CA_CERT")]
    ca_cert: Option<PathBuf>,
    /// API token, sent as `Authorization: Bearer <token>`.
    #[arg(long, global = true, env = "CELERIS_TOKEN", hide_env_values = true)]
    token: Option<String>,
    #[command(subcommand)]
    command: Command,
}

#[derive(Debug, Subcommand)]
enum Command {
    /// Write a commented celeris.toml.
    Init {
        /// Directory to write the config into.
        #[arg(long, default_value = ".")]
        dir: PathBuf,
        /// Client API listen address.
        #[arg(long, default_value = "127.0.0.1:8080")]
        listen: String,
        /// Overwrite an existing config.
        #[arg(long)]
        force: bool,
    },
    /// Run a node in the foreground (Ctrl-C to stop).
    Start {
        #[arg(long, short, default_value = config::FILE_NAME)]
        config: PathBuf,
    },
    /// Ask the node at --addr to shut down gracefully.
    Stop,
    /// Show node health, storage and cluster state.
    Status,
    /// Inspect nodes.
    Node {
        #[command(subcommand)]
        command: NodeCommand,
    },
    /// Inspect the cluster.
    Cluster {
        #[command(subcommand)]
        command: ClusterCommand,
    },
    /// Write a JSON value.
    Put {
        key: String,
        /// JSON value (strings need quotes: '"hello"'). Omit when using --file.
        value: Option<String>,
        /// Read the value from a file, or `-` for stdin.
        #[arg(long, short)]
        file: Option<PathBuf>,
        /// Expire the value after this long, e.g. 30s, 10m, 1h.
        #[arg(long)]
        ttl: Option<humantime::Duration>,
        /// Only write if the current version equals this.
        #[arg(long, conflicts_with = "if_absent")]
        if_version: Option<u64>,
        /// Only write if the key does not exist.
        #[arg(long)]
        if_absent: bool,
        /// Reuse a mutation ID to retry safely (default: random).
        #[arg(long)]
        mutation_id: Option<MutationId>,
        /// strict | session | available | eventual
        #[arg(long, short)]
        consistency: Option<String>,
    },
    /// Read a value.
    Get {
        key: String,
        /// strict | session | bounded | available | eventual
        #[arg(long, short)]
        consistency: Option<String>,
        /// Staleness bound for bounded reads, e.g. 500ms.
        #[arg(long)]
        max_staleness: Option<humantime::Duration>,
    },
    /// Delete a key.
    Delete {
        key: String,
        #[arg(long)]
        if_version: Option<u64>,
        #[arg(long)]
        mutation_id: Option<MutationId>,
        #[arg(long, short)]
        consistency: Option<String>,
    },
    /// List keys in order.
    Scan {
        #[arg(long)]
        prefix: Option<String>,
        /// Continue after this key (the cursor printed by a previous scan).
        #[arg(long)]
        after: Option<String>,
        #[arg(long, default_value_t = 100)]
        limit: usize,
    },
    /// Check whether a mutation committed.
    Mutation { id: MutationId },
    /// List or clear conflicts recorded by `available` writes.
    Conflicts {
        #[command(subcommand)]
        command: ConflictsCommand,
    },
    /// Show the partition map, or where one key lives (--key).
    Partitions {
        #[arg(long)]
        key: Option<String>,
    },
    /// Diagnose configuration, filesystem, ports and node health.
    Doctor {
        #[arg(long, short, default_value = config::FILE_NAME)]
        config: PathBuf,
    },
    /// Measure latency and throughput against a running node.
    #[command(alias = "benchmark")]
    Bench(bench::Args),
    /// Manage API tokens.
    #[command(subcommand)]
    Token(TokenCommand),
    /// Save a consistent physical backup of a single node (exact versions).
    Backup {
        /// File to write.
        #[arg(long, short)]
        out: PathBuf,
    },
    /// Build a stopped node's empty storage from a physical backup.
    Restore {
        /// Backup file written by `celeris backup`.
        #[arg(long)]
        from: PathBuf,
        #[arg(long, short, default_value = config::FILE_NAME)]
        config: PathBuf,
    },
    /// Export keys as JSON lines through the API (any cluster, online).
    Export {
        /// File to write.
        #[arg(long, short)]
        out: PathBuf,
        /// Only keys with this prefix.
        #[arg(long)]
        prefix: Option<String>,
        /// Read consistency for the scan.
        #[arg(long, default_value = "strict")]
        consistency: String,
    },
    /// Import a JSON-lines export (idempotent: safe to re-run).
    Import {
        /// File written by `celeris export`.
        #[arg(long)]
        from: PathBuf,
        /// Keys per batch.
        #[arg(long, default_value_t = 200)]
        batch_size: usize,
        /// Parallel writers when a batch spans replica sets.
        #[arg(long, default_value_t = 8)]
        threads: usize,
    },
}

#[derive(Debug, Subcommand)]
enum TokenCommand {
    /// Generate a token and print the config entry that grants it.
    Create {
        /// A label for the token, e.g. `web-app`.
        #[arg(long)]
        name: String,
        /// read, write or admin; repeat for several.
        #[arg(long = "scope", required = true, value_parser = parse_scope)]
        scopes: Vec<celeris_server::auth::Scope>,
    },
    /// Print the SHA-256 to store for an existing token (read from stdin).
    Hash,
}

fn parse_scope(s: &str) -> Result<celeris_server::auth::Scope, String> {
    celeris_server::auth::Scope::parse(s)
        .ok_or_else(|| format!("unknown scope `{s}` (read, write, admin)"))
}

#[derive(Debug, Subcommand)]
enum ConflictsCommand {
    /// List recorded conflicts.
    List {
        #[arg(long)]
        prefix: Option<String>,
        #[arg(long, default_value_t = 100)]
        limit: usize,
    },
    /// Forget the conflicts of one key (after resolving them).
    Clear { key: String },
}

#[derive(Debug, Subcommand)]
enum NodeCommand {
    /// List the nodes in the cluster.
    List,
}

#[derive(Debug, Subcommand)]
enum ClusterCommand {
    /// Show cluster membership and health.
    Status,
    /// Ask the control-plane leader to place partitions on the current
    /// membership (run against the leader node).
    Rebalance {
        /// Replicas per partition.
        #[arg(long)]
        rf: u8,
    },
}

fn main() -> ExitCode {
    let cli = Cli::parse();
    match run(cli) {
        Ok(code) => code,
        Err(e) => {
            eprintln!("error: {e:#}");
            ExitCode::FAILURE
        }
    }
}

fn run(cli: Cli) -> anyhow::Result<ExitCode> {
    client::set_token(cli.token.clone());
    client::set_ca_cert(cli.ca_cert.as_deref())?;
    let client = Client::new(&cli.addr);
    let json = cli.json;
    match cli.command {
        Command::Init { dir, listen, force } => init(&dir, &listen, force),
        Command::Start { config } => start(&config),
        Command::Stop => stop(&client),
        Command::Status => status(&client, json),
        Command::Node {
            command: NodeCommand::List,
        } => node_list(&client, json),
        Command::Cluster {
            command: ClusterCommand::Status,
        } => cluster_status(&client, json),
        Command::Cluster {
            command: ClusterCommand::Rebalance { rf },
        } => {
            let body = serde_json::json!({ "replication_factor": rf }).to_string();
            let reply = client
                .send(
                    "POST",
                    "/v1/admin/rebalance",
                    &[("content-type", "application/json")],
                    Some(body.as_bytes()),
                )
                .map_err(|e| anyhow::anyhow!("no node reachable at {}: {e}", client.base()))?;
            if reply.is_success() {
                if json {
                    print_json(&reply.body);
                } else {
                    println!(
                        "proposed at log index {}; the new map applies once a majority commits it (see `celeris partitions`)",
                        reply.body["log_index"]
                    );
                }
                Ok(ExitCode::SUCCESS)
            } else {
                print_error(&reply);
                Ok(ExitCode::FAILURE)
            }
        }
        Command::Put {
            key,
            value,
            file,
            ttl,
            if_version,
            if_absent,
            mutation_id,
            consistency,
        } => {
            let body = match (value, file) {
                (Some(v), None) => v.into_bytes(),
                (None, Some(path)) => read_input(&path)?,
                (Some(_), Some(_)) => {
                    bail!("pass the value as an argument or with --file, not both")
                }
                (None, None) => {
                    bail!("missing value: pass JSON as an argument, or --file <path|->")
                }
            };
            serde_json::from_slice::<Value>(&body)
                .context("value must be JSON (strings need quotes, e.g. '\"hello\"')")?;
            let mut q = Vec::new();
            if let Some(c) = consistency {
                q.push(("consistency", c));
            }
            if let Some(ttl) = ttl {
                q.push(("ttl_ms", Duration::from(ttl).as_millis().to_string()));
            }
            if let Some(v) = if_version {
                q.push(("if_version", v.to_string()));
            }
            if if_absent {
                q.push(("if_absent", "true".into()));
            }
            let path = format!("/v1/kv/{}{}", encode_path(&key)?, query_string(&q));
            let id = mutation_id.unwrap_or_else(MutationId::random);
            Ok(report_write(
                client.write("PUT", &path, Some(&body), id),
                json,
            ))
        }
        Command::Get {
            key,
            consistency,
            max_staleness,
        } => {
            let mut q = Vec::new();
            if let Some(c) = consistency {
                q.push(("consistency", c));
            }
            if let Some(s) = max_staleness {
                q.push((
                    "max_staleness_ms",
                    Duration::from(s).as_millis().to_string(),
                ));
            }
            let reply = client.get(&format!(
                "/v1/kv/{}{}",
                encode_path(&key)?,
                query_string(&q)
            ))?;
            if reply.is_success() {
                print_json(if json {
                    &reply.body
                } else {
                    &reply.body["value"]
                });
                Ok(ExitCode::SUCCESS)
            } else if reply.error_code() == Some("not_found") {
                eprintln!("not found: {key}");
                Ok(ExitCode::from(EXIT_NOT_FOUND))
            } else {
                print_error(&reply);
                Ok(ExitCode::FAILURE)
            }
        }
        Command::Delete {
            key,
            if_version,
            mutation_id,
            consistency,
        } => {
            let mut q = Vec::new();
            if let Some(c) = consistency {
                q.push(("consistency", c));
            }
            if let Some(v) = if_version {
                q.push(("if_version", v.to_string()));
            }
            let path = format!("/v1/kv/{}{}", encode_path(&key)?, query_string(&q));
            let id = mutation_id.unwrap_or_else(MutationId::random);
            Ok(report_write(client.write("DELETE", &path, None, id), json))
        }
        Command::Scan {
            prefix,
            after,
            limit,
        } => scan(&client, json, prefix, after, limit),
        Command::Mutation { id } => {
            let reply = client.get(&format!("/v1/mutations/{id}"))?;
            if json {
                print_json(&reply.body);
            }
            match reply.status {
                200 => {
                    if !json {
                        println!("committed at version {}", reply.body["version"]);
                    }
                    Ok(ExitCode::SUCCESS)
                }
                404 => {
                    if !json {
                        println!(
                            "unknown: {}",
                            reply.body["message"].as_str().unwrap_or("no commit record")
                        );
                    }
                    Ok(ExitCode::from(EXIT_NOT_FOUND))
                }
                _ => {
                    print_error(&reply);
                    Ok(ExitCode::FAILURE)
                }
            }
        }
        Command::Conflicts {
            command: ConflictsCommand::List { prefix, limit },
        } => {
            let mut q = vec![("limit", limit.to_string())];
            if let Some(p) = prefix {
                q.push(("prefix", p));
            }
            let reply = client.get(&format!("/v1/conflicts{}", query_string(&q)))?;
            if !reply.is_success() {
                print_error(&reply);
                return Ok(ExitCode::FAILURE);
            }
            if json {
                print_json(&reply.body);
            } else {
                let list = reply.body["conflicts"]
                    .as_array()
                    .cloned()
                    .unwrap_or_default();
                if list.is_empty() {
                    println!("no conflicts");
                }
                for c in list {
                    println!(
                        "{}  lost: {} (at {}, by {})  won: {} (at {})",
                        str_of(&c["key"]),
                        c["value"],
                        c["timestamp_ms"],
                        str_of(&c["mutation_id"]),
                        str_of(&c["winner_mutation_id"]),
                        c["winner_timestamp_ms"]
                    );
                }
                if reply.body["partial"] == true {
                    println!("(partial: some replica sets were unreachable)");
                }
            }
            Ok(ExitCode::SUCCESS)
        }
        Command::Conflicts {
            command: ConflictsCommand::Clear { key },
        } => {
            let path = format!("/v1/conflicts/{}", encode_path(&key)?);
            let reply = client
                .send("DELETE", &path, &[], None)
                .map_err(|e| anyhow::anyhow!("cannot reach node at {}: {e}", client.base()))?;
            if reply.is_success() {
                println!("cleared conflicts of {key}");
                Ok(ExitCode::SUCCESS)
            } else {
                print_error(&reply);
                Ok(ExitCode::FAILURE)
            }
        }
        Command::Partitions { key } => partitions(&client, json, key.as_deref()),
        Command::Doctor { config } => Ok(if doctor::run(&config, &client)? {
            ExitCode::SUCCESS
        } else {
            ExitCode::FAILURE
        }),
        Command::Bench(args) => bench::run(&cli.addr, &args, json).map(|()| ExitCode::SUCCESS),
        Command::Token(TokenCommand::Create { name, scopes }) => token_create(&name, &scopes),
        Command::Backup { out } => backup::backup(&client, &out).map(|()| ExitCode::SUCCESS),
        Command::Restore { from, config } => {
            backup::restore(&config, &from).map(|()| ExitCode::SUCCESS)
        }
        Command::Export {
            out,
            prefix,
            consistency,
        } => backup::export(&client, &out, prefix.as_deref(), &consistency)
            .map(|()| ExitCode::SUCCESS),
        Command::Import {
            from,
            batch_size,
            threads,
        } => backup::import(&client, &from, batch_size, threads).map(|()| ExitCode::SUCCESS),
        Command::Token(TokenCommand::Hash) => {
            let mut token = String::new();
            std::io::stdin().read_line(&mut token)?;
            println!("{}", celeris_server::auth::hash_token(token.trim()));
            Ok(ExitCode::SUCCESS)
        }
    }
}

fn token_create(name: &str, scopes: &[celeris_server::auth::Scope]) -> anyhow::Result<ExitCode> {
    use celeris_server::auth::{TokenConfig, generate_token, hash_token};
    let token = generate_token();
    let mut scopes = scopes.to_vec();
    scopes.sort();
    scopes.dedup();
    let entry = TokenConfig {
        name: name.to_owned(),
        sha256: hash_token(&token),
        scopes: scopes.clone(),
    };
    entry.validate().map_err(anyhow::Error::msg)?;
    let list = |sep: &str| {
        scopes
            .iter()
            .map(|s| s.as_str())
            .collect::<Vec<_>>()
            .join(sep)
    };
    println!("token      {token}");
    println!(
        "           (shown once; give it to the client, e.g. CELERIS_TOKEN or the SDK `token` option)"
    );
    println!();
    println!("Add to celeris.toml on every node:");
    println!();
    println!("[[auth.tokens]]");
    println!("name = \"{name}\"");
    println!("sha256 = \"{}\"", entry.sha256);
    println!(
        "scopes = [{}]",
        scopes
            .iter()
            .map(|s| format!("\"{s}\""))
            .collect::<Vec<_>>()
            .join(", ")
    );
    println!();
    println!("or as an environment variable:");
    println!();
    println!(
        "CELERIS_AUTH_TOKENS=\"{name}:{}:{}\"",
        list("+"),
        entry.sha256
    );
    Ok(ExitCode::SUCCESS)
}

fn init(dir: &Path, listen: &str, force: bool) -> anyhow::Result<ExitCode> {
    listen
        .parse::<std::net::SocketAddr>()
        .with_context(|| format!("invalid --listen address `{listen}`"))?;
    fs::create_dir_all(dir).with_context(|| format!("creating {}", dir.display()))?;
    let path = dir.join(config::FILE_NAME);
    if path.exists() && !force {
        bail!(
            "{} already exists (use --force to overwrite)",
            path.display()
        );
    }
    fs::write(&path, Config::template(listen))
        .with_context(|| format!("writing {}", path.display()))?;
    println!("wrote {}", path.display());
    println!(
        "start a node with: celeris start --config {}",
        path.display()
    );
    Ok(ExitCode::SUCCESS)
}

fn start(path: &Path) -> anyhow::Result<ExitCode> {
    let mut config = if path.exists() {
        Config::load(path)?
    } else if path == Path::new(config::FILE_NAME) {
        eprintln!(
            "note: no {} here; using defaults (run `celeris init` to create one)",
            config::FILE_NAME
        );
        Config::default()
    } else {
        bail!("config file {} not found", path.display());
    };
    config.apply_env(|k| std::env::var(k).ok())?;
    config.validate()?;
    init_logging(&config);

    let runtime = tokio::runtime::Builder::new_multi_thread()
        .enable_all()
        .thread_name("celeris-worker")
        .build()
        .context("starting async runtime")?;
    runtime.block_on(async move {
        let listener = tokio::net::TcpListener::bind(config.listen_addr()?)
            .await
            .with_context(|| format!("binding {}", config.http.listen))?;
        let local = listener.local_addr()?;
        let advertise = local.to_string();
        let cluster = match &config.cluster.listen {
            Some(addr) => Some(
                tokio::net::TcpListener::bind(addr)
                    .await
                    .with_context(|| format!("binding cluster port {addr}"))?,
            ),
            None => None,
        };
        let cluster_addr = cluster.as_ref().map(|l| l.local_addr()).transpose()?;
        let open_config = config.clone();
        let node =
            tokio::task::spawn_blocking(move || Node::open(&open_config, advertise, cluster_addr))
                .await
                .context("opening node")??;
        let node = Arc::new(node);
        let tls = match &config.http.tls {
            Some(t) => Some(celeris_server::tls::acceptor(&t.cert_file, &t.key_file)?),
            None => None,
        };
        println!(
            "celeris {} node {} listening on {}://{local}",
            env!("CARGO_PKG_VERSION"),
            node.id(),
            if tls.is_some() { "https" } else { "http" }
        );
        if let Some(addr) = cluster_addr {
            println!("cluster port {addr}");
        }
        io::stdout().flush()?;
        celeris_server::serve_with_tls(node, listener, cluster, tls, async {
            let _ = tokio::signal::ctrl_c().await;
        })
        .await
    })?;
    Ok(ExitCode::SUCCESS)
}

fn init_logging(config: &Config) {
    use tracing_subscriber::EnvFilter;
    let filter = EnvFilter::try_from_default_env()
        .or_else(|_| EnvFilter::try_new(&config.log.level))
        .unwrap_or_else(|_| EnvFilter::new("info"));
    let builder = tracing_subscriber::fmt()
        .with_env_filter(filter)
        .with_writer(io::stderr);
    match config.log.format {
        LogFormat::Json => builder.json().init(),
        LogFormat::Pretty => builder.compact().init(),
    }
}

fn stop(client: &Client) -> anyhow::Result<ExitCode> {
    let reply = client
        .send("POST", "/v1/admin/shutdown", &[], Some(b""))
        .map_err(|e| anyhow::anyhow!("no node reachable at {}: {e}", client.base()))?;
    if reply.status == 202 {
        println!("shutdown requested");
        Ok(ExitCode::SUCCESS)
    } else {
        print_error(&reply);
        Ok(ExitCode::FAILURE)
    }
}

fn fetch_status(client: &Client) -> anyhow::Result<Value> {
    let reply = client.get("/v1/status")?;
    if !reply.is_success() {
        print_error(&reply);
        bail!("status request failed");
    }
    Ok(reply.body)
}

fn status(client: &Client, json: bool) -> anyhow::Result<ExitCode> {
    let b = fetch_status(client)?;
    if json {
        print_json(&b);
        return Ok(ExitCode::SUCCESS);
    }
    let s = &b["storage"];
    let nodes = b["cluster"]["nodes"].as_array().map_or(0, Vec::len);
    println!(
        "node       {} ({})",
        str_of(&b["node_id"]),
        str_of(&b["health"])
    );
    println!("version    {}", str_of(&b["version"]));
    println!(
        "uptime     {}",
        humantime::format_duration(Duration::from_secs(b["uptime_secs"].as_u64().unwrap_or(0)))
    );
    println!(
        "cluster    {}, {nodes} node(s)",
        str_of(&b["cluster"]["mode"])
    );
    println!(
        "storage    version {}  tables L0={} L1={}  {} on disk  memtable {}",
        s["last_version"],
        s["l0_tables"],
        s["l1_tables"],
        bytes(s["table_bytes"].as_u64().unwrap_or(0)),
        bytes(s["memtable_bytes"].as_u64().unwrap_or(0)),
    );
    if let Some(reason) = s["read_only_reason"].as_str() {
        println!("READ-ONLY  {reason}");
    }
    if let Some(err) = s["background_error"].as_str() {
        println!("warning    last background error: {err}");
    }
    Ok(ExitCode::SUCCESS)
}

fn node_list(client: &Client, json: bool) -> anyhow::Result<ExitCode> {
    let b = fetch_status(client)?;
    let nodes = b["cluster"]["nodes"]
        .as_array()
        .cloned()
        .unwrap_or_default();
    if json {
        print_json(&Value::Array(nodes));
        return Ok(ExitCode::SUCCESS);
    }
    println!(
        "{:<20} {:<24} {:<10} {:<12} INCARNATION",
        "ID", "ADDRESS", "ZONE", "STATE"
    );
    for n in &nodes {
        let me = if n["self"] == true {
            " (this node)"
        } else {
            ""
        };
        println!(
            "{:<20} {:<24} {:<10} {:<12} {}{me}",
            str_of(&n["id"]),
            str_of(&n["address"]),
            str_of(&n["zone"]),
            str_of(&n["state"]),
            n["incarnation"]
        );
    }
    Ok(ExitCode::SUCCESS)
}

fn cluster_status(client: &Client, json: bool) -> anyhow::Result<ExitCode> {
    let b = fetch_status(client)?;
    if json {
        print_json(&b["cluster"]);
        return Ok(ExitCode::SUCCESS);
    }
    let nodes = b["cluster"]["nodes"]
        .as_array()
        .cloned()
        .unwrap_or_default();
    let count = |state: &str| nodes.iter().filter(|n| n["state"] == state).count();
    println!("mode       {}", str_of(&b["cluster"]["mode"]));
    println!(
        "nodes      {}: {} alive, {} suspect, {} unreachable, {} left",
        nodes.len(),
        count("alive"),
        count("suspect"),
        count("unreachable"),
        count("left")
    );
    if b["cluster"]["mode"] == "single-node" {
        println!("note       set [cluster] listen and seeds in celeris.toml to form a cluster");
    } else {
        println!(
            "note       membership only; partition ownership and replication across nodes are not enabled yet"
        );
    }
    Ok(ExitCode::SUCCESS)
}

fn partitions(client: &Client, json: bool, key: Option<&str>) -> anyhow::Result<ExitCode> {
    let path = match key {
        Some(k) => format!("/v1/partitions/key/{}", encode_path(k)?),
        None => "/v1/partitions".to_owned(),
    };
    let reply = client.get(&path)?;
    if !reply.is_success() {
        print_error(&reply);
        return Ok(ExitCode::FAILURE);
    }
    let b = &reply.body;
    if json {
        print_json(b);
    } else if let Some(k) = key {
        let replicas: Vec<&str> = b["replicas"]
            .as_array()
            .into_iter()
            .flatten()
            .filter_map(Value::as_str)
            .collect();
        println!("key        {k}");
        println!(
            "partition  {} (epoch {})",
            b["partition"], b["partition_epoch"]
        );
        println!("leader     {}", str_of(&b["leader"]));
        println!("replicas   {}", replicas.join(", "));
    } else {
        println!(
            "partitions {}  epoch {}  replication factor {}  zone-diverse {}",
            b["count"], b["epoch"], b["replication_factor"], b["zone_diverse_partitions"]
        );
        println!(
            "{:<20} {:<12} {:>9} {:>8}",
            "NODE", "ZONE", "REPLICAS", "LEADERS"
        );
        for n in b["nodes"].as_array().into_iter().flatten() {
            println!(
                "{:<20} {:<12} {:>9} {:>8}",
                str_of(&n["id"]),
                str_of(&n["zone"]),
                n["replicas"],
                n["leaders"]
            );
        }
    }
    Ok(ExitCode::SUCCESS)
}

fn scan(
    client: &Client,
    json: bool,
    prefix: Option<String>,
    after: Option<String>,
    limit: usize,
) -> anyhow::Result<ExitCode> {
    let mut q = vec![("limit", limit.to_string())];
    if let Some(p) = &prefix {
        q.push(("prefix", p.clone()));
    }
    if let Some(a) = after {
        q.push(("after", a));
    }
    let reply = client.get(&format!("/v1/scan{}", query_string(&q)))?;
    if !reply.is_success() {
        print_error(&reply);
        return Ok(ExitCode::FAILURE);
    }
    if json {
        print_json(&reply.body);
        return Ok(ExitCode::SUCCESS);
    }
    for item in reply.body["items"].as_array().into_iter().flatten() {
        println!("{}\t{}", str_of(&item["key"]), item["value"]);
    }
    if let Some(cursor) = reply.body["next_cursor"].as_str() {
        let prefix_flag = prefix.map(|p| format!(" --prefix {p}")).unwrap_or_default();
        eprintln!("-- more: celeris scan{prefix_flag} --after {cursor}");
    }
    Ok(ExitCode::SUCCESS)
}

fn report_write(result: WriteResult, json: bool) -> ExitCode {
    match result {
        WriteResult::Done(reply) if reply.status == 202 => {
            if json {
                print_json(&reply.body);
            } else {
                println!(
                    "ACCEPTED (not yet replicated) mutation={} timestamp_ms={}",
                    str_of(&reply.body["mutation_id"]),
                    reply.body["timestamp_ms"]
                );
            }
            ExitCode::SUCCESS
        }
        WriteResult::Done(reply) if reply.is_success() => {
            if json {
                print_json(&reply.body);
            } else {
                let b = &reply.body;
                let dedup = if b["deduplicated"] == true {
                    "  (already committed; retry was deduplicated)"
                } else {
                    ""
                };
                println!(
                    "OK version={} mutation={}{dedup}",
                    b["version"],
                    str_of(&b["mutation_id"])
                );
            }
            ExitCode::SUCCESS
        }
        WriteResult::Done(reply) => {
            print_error(&reply);
            if reply.body["error"]["outcome"] == "unknown" {
                ExitCode::from(EXIT_UNKNOWN)
            } else {
                ExitCode::FAILURE
            }
        }
        WriteResult::Unknown {
            mutation_id,
            reason,
        } => {
            eprintln!("outcome UNKNOWN: {reason}");
            eprintln!("the write may have committed; check with: celeris mutation {mutation_id}");
            ExitCode::from(EXIT_UNKNOWN)
        }
        WriteResult::NotSent(reason) => {
            eprintln!("error: node unreachable ({reason}); nothing was written");
            ExitCode::FAILURE
        }
    }
}

fn print_error(reply: &Reply) {
    let err = &reply.body["error"];
    match err["code"].as_str() {
        Some(code) => {
            eprintln!(
                "error [{code}] (HTTP {}): {}",
                reply.status,
                str_of(&err["message"])
            );
            if let Some(outcome) = err["outcome"].as_str() {
                eprintln!("  outcome: {}", outcome.replace('_', " "));
            }
            if let Some(current) = err.get("current_version") {
                eprintln!("  current version: {current}");
            }
            if let Some(id) = err["mutation_id"].as_str() {
                eprintln!("  mutation: {id}");
            }
        }
        None => eprintln!("error: HTTP {}: {}", reply.status, reply.body),
    }
}

fn print_json(v: &Value) {
    println!(
        "{}",
        serde_json::to_string_pretty(v).unwrap_or_else(|_| v.to_string())
    );
}

fn str_of(v: &Value) -> &str {
    v.as_str().unwrap_or("?")
}

fn bytes(n: u64) -> String {
    const UNITS: [&str; 5] = ["B", "KiB", "MiB", "GiB", "TiB"];
    let mut value = n as f64;
    let mut unit = 0;
    while value >= 1024.0 && unit + 1 < UNITS.len() {
        value /= 1024.0;
        unit += 1;
    }
    if unit == 0 {
        format!("{n} B")
    } else {
        format!("{value:.1} {}", UNITS[unit])
    }
}

fn read_input(path: &Path) -> anyhow::Result<Vec<u8>> {
    if path == Path::new("-") {
        let mut buf = Vec::new();
        io::stdin().read_to_end(&mut buf).context("reading stdin")?;
        Ok(buf)
    } else {
        fs::read(path).with_context(|| format!("reading {}", path.display()))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn cli_definition_is_valid() {
        use clap::CommandFactory;
        Cli::command().debug_assert();
    }

    #[test]
    fn byte_formatting() {
        assert_eq!(bytes(512), "512 B");
        assert_eq!(bytes(1536), "1.5 KiB");
        assert_eq!(bytes(3 * 1024 * 1024), "3.0 MiB");
    }
}
