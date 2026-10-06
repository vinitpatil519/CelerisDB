//! Backups:
//!
//! * `backup` / `restore`: physical, exact versions, single-node mode. The
//!   node streams a consistent engine snapshot; `restore` builds a new data
//!   directory from it, offline.
//! * `export` / `import`: logical JSON lines through the public API, so they
//!   work against clusters of any shape, over HTTPS and with API tokens.
//!   Versions are reassigned on import.

use std::fs::{self, File};
use std::io::{BufRead, BufReader, BufWriter, Write};
use std::path::Path;
use std::sync::atomic::{AtomicUsize, Ordering};
use std::thread;
use std::time::{SystemTime, UNIX_EPOCH};

use anyhow::{Context, bail, ensure};
use celeris_core::MutationId;
use celeris_server::Config;
use serde_json::{Value, json};

use crate::client::{Client, WriteResult, encode_path, query_string};

/// Saves a physical backup of the node at `client` to `out`.
pub fn backup(client: &Client, out: &Path) -> anyhow::Result<()> {
    let (status, bytes, version) = client
        .download("/v1/admin/backup")
        .map_err(|e| anyhow::anyhow!("cannot reach node at {}: {e}", client.base()))?;
    if status != 200 {
        let body: Value = serde_json::from_slice(&bytes).unwrap_or(Value::Null);
        bail!(
            "backup refused ({status} {}): {}",
            body["error"]["code"].as_str().unwrap_or("error"),
            body["error"]["message"].as_str().unwrap_or("")
        );
    }
    write_atomically(out, &bytes)?;
    println!(
        "backup     {} ({} bytes, consistent at version {})",
        out.display(),
        bytes.len(),
        version.as_deref().unwrap_or("?")
    );
    Ok(())
}

/// Builds the storage of the node configured by `config_path` from a
/// physical backup. The node must be stopped and its storage empty.
pub fn restore(config_path: &Path, from: &Path) -> anyhow::Result<()> {
    let mut config = if config_path.exists() {
        Config::load(config_path)?
    } else {
        Config::default()
    };
    config.apply_env(|k| std::env::var(k).ok())?;
    let dir = config.storage_dir();
    if dir.exists() && fs::read_dir(&dir)?.next().is_some() {
        bail!(
            "{} is not empty; restore needs a fresh data directory (stop the node and move the old one aside)",
            dir.display()
        );
    }
    let bytes = fs::read(from).with_context(|| format!("reading {}", from.display()))?;
    fs::create_dir_all(&dir).with_context(|| format!("creating {}", dir.display()))?;
    let engine =
        celeris_storage::Engine::create_from_snapshot(&dir, config.engine_options(), &bytes)
            .with_context(|| format!("restoring {}", from.display()))?;
    let stats = engine.stats();
    drop(engine);
    println!(
        "restored   {} into {} (last version {})",
        from.display(),
        dir.display(),
        stats.last_version
    );
    println!(
        "start the node with: celeris start --config {}",
        config_path.display()
    );
    Ok(())
}

fn now_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0)
}

/// Exports every key (optionally under `prefix`) as JSON lines.
pub fn export(
    client: &Client,
    out: &Path,
    prefix: Option<&str>,
    consistency: &str,
) -> anyhow::Result<()> {
    let tmp = out.with_extension("partial");
    let mut file =
        BufWriter::new(File::create(&tmp).with_context(|| format!("creating {}", tmp.display()))?);
    let mut after: Option<String> = None;
    let mut count = 0u64;
    loop {
        let mut q = vec![
            ("limit", "1000".to_owned()),
            ("consistency", consistency.to_owned()),
        ];
        if let Some(p) = prefix {
            q.push(("prefix", p.to_owned()));
        }
        if let Some(a) = &after {
            q.push(("after", a.clone()));
        }
        let reply = client.get(&format!("/v1/scan{}", query_string(&q)))?;
        ensure!(
            reply.is_success(),
            "scan failed ({}): {}",
            reply.status,
            reply.body["error"]["message"].as_str().unwrap_or("")
        );
        ensure!(
            !reply.body["partial"].as_bool().unwrap_or(false),
            "some replica sets did not answer; refusing to write an incomplete export"
        );
        let items = reply.body["items"].as_array().cloned().unwrap_or_default();
        for item in &items {
            let line = json!({
                "key": item["key"],
                "value": item["value"],
                "expires_at_ms": item["expires_at_ms"],
            });
            serde_json::to_writer(&mut file, &line)?;
            file.write_all(b"\n")?;
            count += 1;
        }
        match reply.body["next_cursor"].as_str() {
            Some(c) => after = Some(c.to_owned()),
            None => break,
        }
    }
    file.flush()?;
    drop(file);
    fs::rename(&tmp, out).with_context(|| format!("renaming {}", tmp.display()))?;
    println!("exported   {count} keys to {}", out.display());
    Ok(())
}

/// One import record.
struct Record {
    line: String,
    key: String,
    value: Value,
    ttl_ms: Option<u64>,
}

/// A mutation ID derived from the content, so re-running an import of the
/// same file deduplicates instead of rewriting.
fn content_id(parts: &[&str]) -> MutationId {
    let mut h = xxhash_rust::xxh3::Xxh3::new();
    for p in parts {
        h.update(p.as_bytes());
        h.update(b"\n");
    }
    MutationId::from_u128(h.digest128())
}

/// Imports a JSON-lines export through batched writes.
pub fn import(
    client: &Client,
    from: &Path,
    batch_size: usize,
    threads: usize,
) -> anyhow::Result<()> {
    let file = File::open(from).with_context(|| format!("opening {}", from.display()))?;
    let now = now_ms();
    let mut records = Vec::new();
    let mut expired = 0u64;
    for (n, line) in BufReader::new(file).lines().enumerate() {
        let line = line?;
        if line.trim().is_empty() {
            continue;
        }
        let v: Value = serde_json::from_str(&line).with_context(|| format!("line {}", n + 1))?;
        let key = v["key"]
            .as_str()
            .with_context(|| format!("line {}: no key", n + 1))?
            .to_owned();
        let ttl_ms = match v["expires_at_ms"].as_u64() {
            Some(at) if at <= now => {
                expired += 1;
                continue;
            }
            Some(at) => Some(at - now),
            None => None,
        };
        records.push(Record {
            line,
            key,
            value: v["value"].clone(),
            ttl_ms,
        });
    }
    let total = records.len();
    let written = AtomicUsize::new(0);
    let skipped = AtomicUsize::new(0);
    for chunk in records.chunks(batch_size.max(1)) {
        let ops: Vec<Value> = chunk
            .iter()
            .map(|r| {
                let mut op = json!({ "op": "put", "key": r.key, "value": r.value });
                if let Some(ttl) = r.ttl_ms {
                    op["ttl_ms"] = json!(ttl);
                }
                op
            })
            .collect();
        let lines: Vec<&str> = chunk.iter().map(|r| r.line.as_str()).collect();
        let id = content_id(&lines);
        let body = serde_json::to_vec(&json!({ "mutation_id": id.to_string(), "ops": ops }))?;
        match client.write("POST", "/v1/batch", Some(&body), id) {
            WriteResult::Done(reply) if reply.is_success() => {
                written.fetch_add(chunk.len(), Ordering::Relaxed);
            }
            // The same lines were imported before under this content-derived
            // ID (only the remaining TTLs differ now): already done.
            WriteResult::Done(reply) if reply.error_code() == Some("mutation_id_reused") => {
                skipped.fetch_add(chunk.len(), Ordering::Relaxed);
            }
            WriteResult::Done(reply) if reply.error_code() == Some("cross_group_batch") => {
                // A cluster: keys of one batch span replica sets. Write them
                // one by one, in parallel.
                put_each(client, chunk, threads, &written, &skipped)?;
            }
            WriteResult::Done(reply) => bail!(
                "import batch failed ({}): {}",
                reply.status,
                reply.body["error"]["message"].as_str().unwrap_or("")
            ),
            WriteResult::Unknown {
                mutation_id,
                reason,
            } => bail!(
                "outcome unknown for batch {mutation_id}: {reason}; re-run the import (it is idempotent)"
            ),
            WriteResult::NotSent(reason) => bail!("node unreachable: {reason}"),
        }
    }
    println!(
        "imported   {} of {total} keys from {} ({} already imported, {expired} expired and skipped)",
        written.load(Ordering::Relaxed),
        from.display(),
        skipped.load(Ordering::Relaxed),
    );
    Ok(())
}

fn put_each(
    client: &Client,
    records: &[Record],
    threads: usize,
    written: &AtomicUsize,
    skipped: &AtomicUsize,
) -> anyhow::Result<()> {
    let next = AtomicUsize::new(0);
    let failure: std::sync::Mutex<Option<String>> = std::sync::Mutex::new(None);
    let base = client.base().to_owned();
    thread::scope(|s| {
        for _ in 0..threads.max(1) {
            s.spawn(|| {
                let client = Client::new(&base);
                loop {
                    let i = next.fetch_add(1, Ordering::Relaxed);
                    let Some(r) = records.get(i) else { break };
                    let encoded = match encode_path(&r.key) {
                        Ok(k) => k,
                        Err(e) => {
                            if let Ok(mut f) = failure.lock() {
                                f.get_or_insert_with(|| format!("{}: {e}", r.key));
                            }
                            break;
                        }
                    };
                    let mut path = format!("/v1/kv/{encoded}");
                    if let Some(ttl) = r.ttl_ms {
                        path.push_str(&query_string(&[("ttl_ms", ttl.to_string())]));
                    }
                    let body = serde_json::to_vec(&r.value).unwrap_or_default();
                    let id = content_id(&[&r.line]);
                    match client.write("PUT", &path, Some(&body), id) {
                        WriteResult::Done(reply) if reply.is_success() => {
                            written.fetch_add(1, Ordering::Relaxed);
                        }
                        WriteResult::Done(reply)
                            if reply.error_code() == Some("mutation_id_reused") =>
                        {
                            skipped.fetch_add(1, Ordering::Relaxed);
                        }
                        other => {
                            if let Ok(mut f) = failure.lock() {
                                f.get_or_insert_with(|| format!("{}: {other:?}", r.key));
                            }
                            break;
                        }
                    }
                }
            });
        }
    });
    let failure = failure.into_inner().unwrap_or(None);
    match failure {
        Some(reason) => bail!("import stopped: {reason}; re-run the import (it is idempotent)"),
        None => Ok(()),
    }
}

fn write_atomically(path: &Path, bytes: &[u8]) -> anyhow::Result<()> {
    let tmp = path.with_extension("partial");
    {
        let mut f = File::create(&tmp).with_context(|| format!("creating {}", tmp.display()))?;
        f.write_all(bytes)?;
        f.sync_all()?;
    }
    fs::rename(&tmp, path).with_context(|| format!("renaming to {}", path.display()))?;
    Ok(())
}
