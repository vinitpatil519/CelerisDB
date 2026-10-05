//! End-to-end: drive a real `celeris start` process with the `celeris` CLI.

use std::io::{BufRead, BufReader};
use std::path::Path;
use std::process::{Child, Command, Output, Stdio};
use std::time::{Duration, Instant};

const BIN: &str = env!("CARGO_BIN_EXE_celeris");

struct NodeProcess {
    child: Child,
    addr: String,
}

impl NodeProcess {
    fn start(config: &Path) -> NodeProcess {
        let mut child = Command::new(BIN)
            .args(["start", "--config"])
            .arg(config)
            .env("CELERIS_LOG_LEVEL", "warn")
            .stdout(Stdio::piped())
            .stderr(Stdio::inherit())
            .spawn()
            .expect("spawn celeris start");
        let mut line = String::new();
        BufReader::new(child.stdout.take().expect("stdout"))
            .read_line(&mut line)
            .expect("read banner");
        let addr = line
            .split("listening on ")
            .nth(1)
            .map(|s| s.trim().to_owned())
            .unwrap_or_else(|| panic!("unexpected banner: {line:?}"));
        NodeProcess { child, addr }
    }

    fn wait_for_exit(&mut self, timeout: Duration) -> bool {
        let deadline = Instant::now() + timeout;
        while Instant::now() < deadline {
            if let Ok(Some(status)) = self.child.try_wait() {
                return status.success();
            }
            std::thread::sleep(Duration::from_millis(50));
        }
        false
    }
}

impl Drop for NodeProcess {
    fn drop(&mut self) {
        let _ = self.child.kill();
        let _ = self.child.wait();
    }
}

fn celeris(addr: &str, args: &[&str]) -> Output {
    Command::new(BIN)
        .arg("--addr")
        .arg(addr)
        .args(args)
        .output()
        .expect("run celeris")
}

fn stdout(o: &Output) -> String {
    String::from_utf8_lossy(&o.stdout).into_owned()
}

fn stderr(o: &Output) -> String {
    String::from_utf8_lossy(&o.stderr).into_owned()
}

#[test]
fn full_single_node_lifecycle() {
    let dir = tempfile::tempdir().expect("tempdir");
    let dir_arg = dir.path().to_str().expect("utf8 path");

    let init = celeris(
        "unused",
        &["init", "--dir", dir_arg, "--listen", "127.0.0.1:0"],
    );
    assert!(init.status.success(), "{}", stderr(&init));
    let config = dir.path().join("celeris.toml");
    assert!(config.exists());
    let again = celeris("unused", &["init", "--dir", dir_arg]);
    assert!(!again.status.success(), "init refuses to overwrite");

    let mut node = NodeProcess::start(&config);
    let addr = node.addr.clone();

    let put = celeris(&addr, &["put", "users/42", r#"{"name":"Vinit"}"#]);
    assert!(put.status.success(), "{}", stderr(&put));
    assert!(stdout(&put).starts_with("OK version="));

    let get = celeris(&addr, &["get", "users/42"]);
    assert!(get.status.success());
    assert!(stdout(&get).contains("\"name\": \"Vinit\""));

    let missing = celeris(&addr, &["get", "users/404"]);
    assert_eq!(missing.status.code(), Some(4));

    let not_json = celeris(&addr, &["put", "k", "hello"]);
    assert!(!not_json.status.success());
    assert!(stderr(&not_json).contains("must be JSON"));

    let conflict = celeris(&addr, &["put", "users/42", "{}", "--if-absent"]);
    assert_eq!(conflict.status.code(), Some(1));
    assert!(stderr(&conflict).contains("condition_failed"));
    assert!(stderr(&conflict).contains("not applied"));

    let id = "11111111-2222-4333-8444-555555555555";
    let first = celeris(
        &addr,
        &["put", "orders/1", "{\"total\":3}", "--mutation-id", id],
    );
    assert!(first.status.success());
    let retry = celeris(
        &addr,
        &["put", "orders/1", "{\"total\":3}", "--mutation-id", id],
    );
    assert!(
        stdout(&retry).contains("deduplicated"),
        "{}",
        stdout(&retry)
    );
    let status = celeris(&addr, &["mutation", id]);
    assert!(stdout(&status).contains("committed at version"));

    let ttl = celeris(
        &addr,
        &["put", "sessions/a", "\"tok\"", "--ttl", "1h", "--json"],
    );
    assert!(stdout(&ttl).contains("\"version\""));

    let scan = celeris(&addr, &["scan", "--prefix", "users/"]);
    assert!(stdout(&scan).contains("users/42"));
    assert!(!stdout(&scan).contains("orders/1"));

    let del = celeris(&addr, &["delete", "users/42"]);
    assert!(del.status.success());
    assert_eq!(celeris(&addr, &["get", "users/42"]).status.code(), Some(4));

    let status = celeris(&addr, &["status"]);
    assert!(status.status.success());
    assert!(stdout(&status).contains("node-"));
    assert!(stdout(&status).contains("single-node"));
    let parts = celeris(&addr, &["partitions"]);
    assert!(
        stdout(&parts).contains("partitions 4096"),
        "{}",
        stdout(&parts)
    );
    let route = celeris(&addr, &["partitions", "--key", "users/42"]);
    assert!(
        stdout(&route).contains("partition  1118"),
        "{}",
        stdout(&route)
    );
    let nodes = celeris(&addr, &["node", "list"]);
    assert!(stdout(&nodes).contains("alive"));
    assert!(stdout(&nodes).contains("(this node)"));
    let cluster = celeris(&addr, &["cluster", "status", "--json"]);
    assert!(stdout(&cluster).contains("\"mode\": \"single-node\""));

    let doctor = celeris(
        &addr,
        &["doctor", "--config", config.to_str().expect("utf8")],
    );
    assert!(doctor.status.success(), "{}", stdout(&doctor));
    assert!(stdout(&doctor).contains("in use by a running node"));

    let bench = celeris(
        &addr,
        &["bench", "--ops", "200", "-c", "2", "--keys", "20", "--json"],
    );
    assert!(bench.status.success(), "{}", stderr(&bench));
    assert!(
        stdout(&bench).contains("\"errors\":0"),
        "{}",
        stdout(&bench)
    );

    let stop = celeris(&addr, &["stop"]);
    assert!(stop.status.success());
    assert!(
        node.wait_for_exit(Duration::from_secs(15)),
        "node exits cleanly after stop"
    );

    let unreachable = celeris(&addr, &["put", "k", "1"]);
    assert_eq!(unreachable.status.code(), Some(1));
    assert!(stderr(&unreachable).contains("nothing was written"));

    // Data and the commit record survive a restart.
    let node = NodeProcess::start(&config);
    let addr = node.addr.clone();
    let get = celeris(&addr, &["get", "orders/1"]);
    assert!(stdout(&get).contains("\"total\": 3"));
    assert!(celeris(&addr, &["mutation", id]).status.success());
}
