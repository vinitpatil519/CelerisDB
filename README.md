# Celeris

**Distributed data, at speed.**

Celeris is a self-hostable distributed key-value/document database. It is
built around one principle: **consistency is chosen per operation**, not
fixed for the whole database.

> Celeris does not break the CAP theorem. During a network partition no
> system can be both linearizable and unconditionally available. Celeris
> exposes that trade-off as an explicit, per-operation choice:
> `strict`, `session`, `bounded`, `available`, `eventual`.
> See [docs/CONSISTENCY.md](docs/CONSISTENCY.md).

## Status

Early development. **A single node is usable today:**

* storage engine
* HTTP/JSON API
* `celeris` CLI
* Prometheus metrics

Clustering, replication, SDKs and the website are not built yet. See
[docs/ROADMAP.md](docs/ROADMAP.md).

| Milestone | State |
|---|---|
| 0. Workspace, CI, lint, test | done |
| 1. Storage engine: WAL, memtable, SSTables, bloom, block cache, compaction, TTL, crash recovery | done |
| 2. HTTP API + CLI + metrics | done |
| 3. Partitioning: 4096 partitions, zone-aware rendezvous placement, epochs | done |
| 4. Membership, failure detection, replication | in progress: membership + failure detection done |
| 5–9. Strict/available modes, SDKs, deploy, chaos | planned |

## Quick start

```bash
cargo build --release
./target/release/celeris init                 # writes ./celeris.toml
./target/release/celeris start                # node on 127.0.0.1:8080
```

In another terminal:

```bash
celeris put users/42 '{"name":"Vinit"}'
celeris get users/42
celeris put sessions/abc '"token"' --ttl 30m
celeris put users/42 '{"name":"V"}' --if-version 1   # compare-and-set
celeris scan --prefix users/
celeris status
celeris doctor
celeris stop
```

Or with plain HTTP:

```bash
curl -X PUT localhost:8080/v1/kv/users/42 -d '{"name":"Vinit"}'
curl localhost:8080/v1/kv/users/42?consistency=strict
curl localhost:8080/metrics
```

API reference: [docs/API.md](docs/API.md). CLI reference: [docs/CLI.md](docs/CLI.md).

## Repository layout

```text
crates/
  celeris-core/      consistency modes, mutation IDs, key limits (no I/O)
  celeris-storage/   single-node LSM storage engine
  celeris-cluster/   SWIM-style membership + failure detection (sans-IO, simulation-tested)
  celeris-server/    node runtime: HTTP/JSON API, config, Prometheus metrics
  celeris-cli/       the `celeris` binary: init/start/stop/status/put/get/scan/doctor/bench
  celeris-testkit/   failure-injection harnesses (kill-during-write crash test)
docs/
  API.md             HTTP API contract, error model, metrics
  CLI.md             commands, exit codes, retry semantics, env vars
  CONSISTENCY.md     what each mode guarantees; implementation status
  STORAGE_ENGINE.md  write/read paths, recovery guarantees, on-disk formats
  DECISIONS.md       decisions where specs were missing or conflicting
  ROADMAP.md         milestones and what is left
*.md (root)          original product/architecture specifications
```

## Build and test

Requires Rust 1.89+ (`rustup` recommended).

```bash
cargo build --workspace
cargo test --workspace
cargo clippy --workspace --all-targets -- -D warnings
cargo fmt --all -- --check
```

**Windows:** the MSVC toolchain works out of the box with Visual Studio
Build Tools. With the GNU toolchain (`x86_64-pc-windows-gnu`) you need a
64-bit mingw-w64 (e.g. `winget install BrechtSanders.WinLibs.POSIX.UCRT`).
Put its `bin` directory **before** any old 32-bit MinGW on `PATH`.

## Using the storage engine (embedded, today)

```rust
use std::time::Duration;
use celeris_core::MutationId;
use celeris_storage::{Condition, Engine, Op, Options, WriteBatch};

let db = Engine::open("./celeris-data", Options::default())?;

db.put("users/42", r#"{"name":"Ada"}"#)?;
let user = db.get(b"users/42")?;                      // Option<Record>

// Atomic batch with TTL, idempotent under retry.
let id = MutationId::random();
let batch = WriteBatch::new(id)
    .put("users/43", "{}")
    .put_with_ttl("sessions/abc", "token", Duration::from_secs(3600));
db.write(batch.clone())?;
assert!(db.write(batch)?.deduplicated);                 // retry is safe
assert!(db.mutation_status(id)?.is_some());             // "did it commit?"

// Compare-and-set.
let v = db.get(b"users/42")?.unwrap().version;
db.write(WriteBatch::new(MutationId::random()).push(Op::Put {
    key: "users/42".into(),
    value: r#"{"name":"Ada L."}"#.into(),
    ttl: None,
    condition: Some(Condition::Version(v)),
}))?;

let page = db.scan_prefix(b"users/", 100)?;
```

## What is tested

* Unit tests for every on-disk format: round trips, every possible WAL
  truncation point, checksum and version rejection.
* Integration tests for:
  * restart recovery, flush and compaction
  * TTL and tombstone retention (with a controllable clock)
  * CAS atomicity and mutation-ID dedupe across restarts
  * corrupted WAL and corrupted tables
  * directory locking and orphan cleanup
  * write stalls and concurrent readers and writers
* A property test that compares random operation sequences against an
  in-memory model. Sequences include flushes, compactions and restarts.
* A **crash test** that kills a writer process mid-stream six times and checks:
  * every acknowledged write survives;
  * recovered data is a gap-free prefix.
* HTTP API contract tests covering:
  * every endpoint and error code
  * idempotent retries and atomic batches
  * TTL, consistency validation, metrics, CORS and loopback-only admin
  * graceful shutdown over a real socket
* A CLI end-to-end test that drives a real `celeris start` process through
  init, put/get/delete, CAS, retries, scan, status, doctor, bench, stop and
  restart.

No performance numbers are published until the benchmark harness exists.

## License

Apache-2.0
