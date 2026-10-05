//! `celeris doctor`: checks configuration, filesystem, ports and node health.

use std::fmt::Display;
use std::fs::{self, OpenOptions, TryLockError};
use std::io::ErrorKind;
use std::net::TcpListener;
use std::path::Path;

use celeris_server::Config;

use crate::client::Client;

#[derive(Debug, Default)]
struct Report {
    failed: bool,
}

impl Report {
    fn ok(&mut self, check: &str, detail: impl Display) {
        println!("[ ok ] {check}: {detail}");
    }

    fn info(&mut self, check: &str, detail: impl Display) {
        println!("[info] {check}: {detail}");
    }

    fn fail(&mut self, check: &str, detail: impl Display) {
        println!("[FAIL] {check}: {detail}");
        self.failed = true;
    }
}

/// Returns true when every check passed.
pub fn run(config_path: &Path, client: &Client) -> anyhow::Result<bool> {
    let mut r = Report::default();
    r.info(
        "platform",
        format!(
            "{} {} (celeris {})",
            std::env::consts::OS,
            std::env::consts::ARCH,
            env!("CARGO_PKG_VERSION")
        ),
    );
    let mut config = if config_path.exists() {
        match Config::load(config_path).and_then(|c| c.validate().map(|()| c)) {
            Ok(c) => {
                r.ok("config", config_path.display());
                c
            }
            Err(e) => {
                r.fail("config", format!("{e:#}"));
                Config::default()
            }
        }
    } else {
        r.info(
            "config",
            format!("{} not found; checking defaults", config_path.display()),
        );
        Config::default()
    };
    if let Err(e) = config.apply_env(|k| std::env::var(k).ok()) {
        r.fail("environment", format!("{e:#}"));
    }
    check_data_dir(&mut r, &config);
    check_storage_lock(&mut r, &config);
    check_listen(&mut r, &config);
    check_node(&mut r, client);
    Ok(!r.failed)
}

fn check_data_dir(r: &mut Report, config: &Config) {
    let dir = &config.node.data_dir;
    let probe = dir.join(".doctor-probe");
    let result = fs::create_dir_all(dir)
        .and_then(|()| fs::write(&probe, b"ok"))
        .and_then(|()| fs::remove_file(&probe));
    match result {
        Ok(()) => r.ok("data directory", format!("{} is writable", dir.display())),
        Err(e) => r.fail("data directory", format!("{}: {e}", dir.display())),
    }
}

fn check_storage_lock(r: &mut Report, config: &Config) {
    let lock = config.storage_dir().join("LOCK");
    if !lock.exists() {
        r.info("storage", "not initialised yet (created on first start)");
        return;
    }
    let file = match OpenOptions::new().read(true).write(true).open(&lock) {
        Ok(f) => f,
        Err(e) => return r.fail("storage", format!("{}: {e}", lock.display())),
    };
    match file.try_lock() {
        Ok(()) => r.ok("storage", "not in use by another process"),
        Err(TryLockError::WouldBlock) => r.info("storage", "in use by a running node"),
        Err(TryLockError::Error(e)) => r.fail("storage", format!("{}: {e}", lock.display())),
    }
}

fn check_listen(r: &mut Report, config: &Config) {
    let addr = match config.listen_addr() {
        Ok(a) => a,
        Err(e) => return r.fail("listen address", format!("{e:#}")),
    };
    match TcpListener::bind(addr) {
        Ok(_) => r.ok("listen address", format!("{addr} is available")),
        Err(e) if e.kind() == ErrorKind::AddrInUse => r.info(
            "listen address",
            format!("{addr} is in use (a node may already be running)"),
        ),
        Err(e) => r.fail("listen address", format!("{addr}: {e}")),
    }
}

fn check_node(r: &mut Report, client: &Client) {
    match client.send("GET", "/health", &[], None) {
        Ok(reply) if reply.is_success() => {
            let id = reply.body["node_id"].as_str().unwrap_or("?").to_owned();
            r.ok("node", format!("{id} reachable at {}", client.base()));
            match client.send("GET", "/ready", &[], None) {
                Ok(ready) if ready.is_success() => r.ok("readiness", "accepting writes"),
                Ok(ready) => r.fail(
                    "readiness",
                    format!("node is read-only: {}", ready.body["reason"]),
                ),
                Err(e) => r.fail("readiness", e),
            }
        }
        Ok(reply) => r.fail(
            "node",
            format!("HTTP {} from {}", reply.status, client.base()),
        ),
        Err(e) => r.info(
            "node",
            format!("no node reachable at {} ({e})", client.base()),
        ),
    }
}
