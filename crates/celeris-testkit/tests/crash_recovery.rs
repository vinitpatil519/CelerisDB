//! Kill a writer process mid-stream, recover, and check that no acknowledged
//! write was lost and nothing was reordered or invented.

use std::io::{BufRead, BufReader};
use std::ops::Bound;
use std::path::Path;
use std::process::{Command, Stdio};
use std::time::{Duration, Instant};

use celeris_storage::{Engine, Options, StorageError};
use celeris_testkit::{crash_key, crash_value};

/// The OS may take a moment to release the dead process's file lock.
fn reopen(dir: &Path) -> Engine {
    let deadline = Instant::now() + Duration::from_secs(10);
    loop {
        match Engine::open(dir, Options::default()) {
            Ok(engine) => return engine,
            Err(StorageError::Locked(_)) if Instant::now() < deadline => {
                std::thread::sleep(Duration::from_millis(50));
            }
            Err(e) => panic!("recovery failed: {e}"),
        }
    }
}

#[test]
fn acknowledged_writes_survive_process_kill() {
    let dir = tempfile::tempdir().expect("tempdir");
    let mut next = 0u64;
    for round in 0..6u64 {
        let sync = if round % 2 == 0 { "always" } else { "never" };
        let mut child = Command::new(env!("CARGO_BIN_EXE_celeris-crash-writer"))
            .arg(dir.path())
            .arg(next.to_string())
            .arg(sync)
            .stdout(Stdio::piped())
            .stderr(Stdio::inherit())
            .spawn()
            .expect("spawn crash writer");
        let mut lines = BufReader::new(child.stdout.take().expect("stdout")).lines();

        // Vary the kill point so it lands in different phases (append,
        // rotation, flush, compaction).
        let target = 150 + round * 70;
        let mut last_ack = None;
        let mut acks = 0;
        for line in lines.by_ref() {
            let line = line.expect("read child stdout");
            if let Some(n) = line.strip_prefix("ACK ") {
                last_ack = Some(n.parse::<u64>().expect("ack index"));
                acks += 1;
                if acks >= target {
                    break;
                }
            }
        }
        // Kill while the pipe is still open, so the child is mid-write rather
        // than shutting down cleanly.
        let _ = child.kill();
        child.wait().expect("reap child");
        drop(lines);
        let last_ack = last_ack.expect("writer acknowledged nothing");

        let engine = reopen(dir.path());
        let all = engine
            .scan(Bound::Unbounded, Bound::Unbounded, usize::MAX)
            .expect("scan after recovery");
        for (i, record) in all.iter().enumerate() {
            assert_eq!(
                record.key,
                crash_key(i as u64).into_bytes(),
                "round {round} ({sync}): recovered keys must be a gap-free prefix"
            );
            assert_eq!(record.value, crash_value(i as u64).into_bytes());
        }
        assert!(
            all.len() as u64 > last_ack,
            "round {round} ({sync}): acknowledged write {last_ack} lost; recovered {} records",
            all.len()
        );
        next = all.len() as u64;
    }
}
