//! Writes sequential keys forever and prints `ACK <i>` after each write is
//! acknowledged. A test harness kills the process at an arbitrary moment and
//! checks that every acknowledged write survived recovery.
//!
//! Usage: `celeris-crash-writer <data-dir> <first-index> <always|never>`

use std::io::{self, Write};
use std::process::ExitCode;

use celeris_storage::{Engine, Options, SyncMode};
use celeris_testkit::{crash_key, crash_value};

fn main() -> ExitCode {
    let args: Vec<String> = std::env::args().collect();
    let (Some(dir), Some(start), Some(sync)) = (
        args.get(1),
        args.get(2).and_then(|s| s.parse::<u64>().ok()),
        args.get(3),
    ) else {
        eprintln!("usage: celeris-crash-writer <data-dir> <first-index> <always|never>");
        return ExitCode::from(2);
    };
    let sync = match sync.as_str() {
        "always" => SyncMode::Always,
        "never" => SyncMode::Never,
        other => {
            eprintln!("unknown sync mode `{other}`");
            return ExitCode::from(2);
        }
    };
    // Tiny memtables and tables so a short run crosses flushes and
    // compactions, and the kill can land in the middle of either.
    let options = Options {
        sync,
        memtable_size_bytes: 16 * 1024,
        l0_compaction_trigger: 3,
        target_table_size_bytes: 32 * 1024,
        ..Options::default()
    };
    let engine = match Engine::open(dir, options) {
        Ok(e) => e,
        Err(e) => {
            eprintln!("open failed: {e}");
            return ExitCode::FAILURE;
        }
    };
    let mut out = io::stdout().lock();
    for i in start.. {
        if let Err(e) = engine.put(crash_key(i), crash_value(i)) {
            eprintln!("put {i} failed: {e}");
            return ExitCode::FAILURE;
        }
        if writeln!(out, "ACK {i}").and_then(|()| out.flush()).is_err() {
            // The harness closed the pipe.
            return ExitCode::SUCCESS;
        }
    }
    ExitCode::SUCCESS
}
