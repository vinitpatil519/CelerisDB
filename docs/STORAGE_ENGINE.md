# Storage engine (as implemented)

Crate: `crates/celeris-storage`. Single-node, embedded, synchronous API.
The server layer calls it from a blocking thread pool.

## Write path

```text
Engine::write(batch)
  ├─ validate keys / values / TTL / batch size
  ├─ lock writer
  ├─ mutation-ID dedupe lookup ─► already committed? return original version
  ├─ evaluate conditions (Absent / Version) against current state,
  │  including writes still waiting for their fsync
  ├─ stall: too many immutable memtables? flush inline (before WAL append)
  ├─ assign commit sequence number
  ├─ append ONE WAL frame: all ops + dedupe record   ← atomicity point
  ├─ unlock writer (other batches append meanwhile)
  ├─ group commit: one writer fsyncs for every frame  ← durability point
  │  appended so far; the rest wait for it
  ├─ insert the synced batches into the memtable in sequence order
  │  (visible to readers only now)
  └─ memtable full? sync WAL, rotate to new WAL, schedule background flush
```

### Group commit (`SyncMode::Always`)

Writers append their WAL frame under the writer lock, then release it and
queue for the fsync. The first writer in line fsyncs the WAL. That fsync
covers every frame appended before it started, so the writers behind it find
their batch already durable and return without syncing. While one fsync
runs, new writers keep appending, and the next fsync covers all of them.

Visibility and correctness:

* A batch becomes visible only after its fsync. Until then it sits in an
  in-memory queue, so a reader can never observe data that a crash would
  lose.
* Later writes check conditions and mutation IDs against the queued batches
  as well as the memtable. Compare-and-set therefore stays exact, and a
  retry of a queued mutation waits for the original's fsync, then returns
  its version.
* Batches publish in sequence order, so versions stay totally ordered.
* Rotating the memtable syncs the WAL and publishes every queued batch
  first. A WAL file is never retired while one of its batches is still
  queued.
* If an fsync fails, the engine is poisoned. Every queued batch fails with
  `WalFailure`, an unknown outcome, because the frame may be on disk.

On the development machine (Windows, NVMe, `fsync` on every batch), the
put benchmark went from 1,551 to 4,967 ops/s with 8 clients, and from
1,844 to 8,581 ops/s with 32. p99 latency fell from 10.3 ms to 3.8 ms
with 8 clients.

## Read path

```text
Engine::get(key)
  memtable → immutable memtables (newest first)
  → L0 tables (newest first; key-range check, bloom filter, sparse index, block cache)
  → L1 run (binary search by key range, then bloom, index, cache)
  first version found wins; tombstone or expired ⇒ None
```

Scans merge every layer with a k-way merge that keeps the highest sequence
number per key, then hide tombstones, expired values and internal keys.

## Flush and compaction

* **Flush:** an immutable memtable becomes an L0 table (`<id>.sst.tmp` →
  fsync → rename → manifest update). Its WAL files are then deleted.
* **Compaction:** when L0 reaches `l0_compaction_trigger` tables, every L0
  and L1 table is merged into a new L1 run split at `target_table_size_bytes`.
  * Shadowed versions are dropped.
  * Expired values become tombstones dated at their expiry.
  * Tombstones older than `tombstone_retention` are dropped.
  * Expired internal dedupe records are dropped.
* Replaced tables are deleted when the last reader holding them finishes.

## Crash recovery

On `Engine::open`:

1. Take an exclusive lock on `LOCK`. A second process gets `StorageError::Locked`.
2. Load `MANIFEST`. If it is missing while `.sst` files exist, startup fails
   rather than guessing which tables are live.
3. Delete `*.tmp` files and `.sst` files not listed in the manifest. These
   are leftovers of an interrupted flush or compaction.
4. Open the live tables. Each footer, index and bloom filter is checksum-verified.
5. Replay WAL files in id order, skipping batches with
   `seq <= manifest.flushed_seq`, because those are already in tables.
   * A torn tail in the newest WAL is truncated.
   * A bad record in an older WAL is fatal corruption.
6. Persist the manifest, then create a fresh WAL.

`Engine::recovery_report()` exposes what happened.

### What is guaranteed

| Event | Guarantee |
|---|---|
| Process crash, any `SyncMode` | Every acknowledged batch is recovered |
| Power loss, `SyncMode::Always` | Every acknowledged batch is recovered |
| Power loss, `SyncMode::Never` | A prefix of acknowledged batches is recovered |
| Crash mid-batch | Batch recovered entirely or not at all |
| WAL write/fsync error | Write reported outcome-unknown, engine read-only |
| Corrupted table block | Read returns `Corruption`; never wrong data |

The process-crash row is tested by killing a writer process at varying
points (`crates/celeris-testkit/tests/crash_recovery.rs`). The power-loss rows
follow from fsync ordering. They are not yet exercised by an fsync-dropping
filesystem harness; see the roadmap.

## On-disk formats

All integers are little-endian. Every file type has a magic number and a
format version. Readers reject unknown versions with
`StorageError::UnsupportedFormat` instead of guessing.

### Entry (shared by WAL and tables)

```text
kind u8 (1 put, 2 delete) | seq u64 | timestamp_ms u64 | expires_at_ms u64 (0 = none)
| mutation_id [16] | key_len u32 | key | value_len u32 | value
```

### WAL — `<id:020>.wal`, version 1

```text
"CELRSWAL" | version u32 | reserved u32
frame*: len u32 | crc32(len_bytes ++ payload) u32 | payload
payload: 0x01 | count u32 | entry*      (one frame = one batch)
```

### SSTable — `<id:020>.sst`, version 1

```text
data block*  : entry* | crc32 u32                 (~block_size_bytes)
index block  : count u32 | (last_key | offset u64 | len u32)* | crc32 u32
bloom block  : k u8 | bits | crc32 u32             (xxh3-64, double hashing)
footer (64 B): index_off u64 | index_len u64 | bloom_off u64 | bloom_len u64
               | entries u64 | max_seq u64 | version u32 | crc32 u32 | "CELRSSST"
```

### MANIFEST, version 1

```text
"CELRSMAN" | version u32 | body_len u32 | crc32(body) u32 | JSON body
{ "next_file_id", "flushed_seq", "tables": [{ "id", "level", "min_key"(hex),
  "max_key"(hex), "size", "entries", "max_seq" }] }
```

Replaced atomically via `MANIFEST.tmp` + fsync + rename + directory fsync.

### Engine snapshot, version 1 (`Engine::snapshot`)

```text
"CELRSSNP" | version u32 | last_seq u64 | count u64 | entry* | crc32(everything before) u32
```

The snapshot holds every live put, including expired values and internal
mutation-ID records, so a replica built from it evaluates TTLs and
deduplication identically. Tombstones are left out because a fresh engine
has nothing for them to shadow.

`Engine::create_from_snapshot` requires an empty directory. It writes the
entries to a new WAL with their original versions, plus an internal marker
(key `0x00 's'`) at `last_seq`, so that later writes continue from the
same version numbers on every replica.

### Group Raft log — `groups/<ids>/raft/raft.log`, version 2

```text
"CLRSRLOG" | version u32 | snapshot_index u64 | snapshot_term u64
frame*: len u32 | crc32(payload) u32 | JSON log entry
```

Version 1 files have no snapshot fields (boundary 0) and are still read.
`hardstate.json` holds `{format_version: 1, term, voted_for}`.

## Metrics

`Engine::metrics()` returns monotonic counters:

* writes, WAL bytes, WAL syncs, WAL failures
* dedupe hits, condition failures
* reads, read hits, bloom negatives, cache hits and misses
* flushes, compactions with bytes in and out, tombstones purged
* write stalls, background errors

`Engine::stats()` returns gauges: memtable bytes, L0/L1 table counts, table
bytes, the poisoned flag and the last background error. The server will
export both in Prometheus format.

## Online backup

`Engine::backup()` returns a snapshot (the same format as `snapshot()`) that
is consistent at a sequence number without stopping writes. Under the
writer lock it drains group commit and, if the active memtable holds data,
rotates it. It then releases the lock and encodes only the frozen memtables
and the SSTables of that version. Later writes land in the new active
memtable and are not part of the backup. Flushes and compactions may run
meanwhile: the version holds `Arc`s to its tables, and a table file is
deleted only when its last reference drops. `Engine::create_from_snapshot`
restores it into an empty directory with the original versions.

## Benchmarks

Criterion micro-benchmarks live in `crates/celeris-storage/benches/engine.rs`:

```bash
cargo bench -p celeris-storage                  # full run, HTML-free text report
cargo bench -p celeris-storage -- --quick get   # one group, fast
```

128-byte values, 50,000 preloaded keys, `SyncMode::Never` unless noted. One
run on a Windows 11 laptop (NVMe SSD), so use them to compare changes, not
as absolute numbers:

| Benchmark | Time | Throughput |
|---|---|---|
| `put/single` | 6.4 µs | 156 K puts/s |
| `put/batch_10` | 30 µs | 330 K keys/s |
| `put/fsync/1_writers` (`Always`) | 403 µs | 2.5 K puts/s |
| `put/fsync/8_writers` (`Always`, group commit) | 183 µs per put | 5.5 K puts/s |
| `get/hit/memtable` | 1.1 µs | 920 K/s |
| `get/hit/sstable` | 1.9 µs | 540 K/s |
| `get/miss/sstable` (bloom filter) | 0.26 µs | 3.8 M/s |
| `scan/100/memtable` | 31 µs | 3.2 M rows/s |
| `scan/100/sstable` | 23 µs | 4.3 M rows/s |
| `maintenance/flush_50k` | 62 ms | 800 K keys/s |
| `maintenance/compact_50k` (4 L0 tables) | 57 ms | 880 K keys/s |
| `maintenance/backup_50k` | 35 ms | 1.4 M keys/s |

`put/batch_100` stalls on inline flushes once the memtables fill (the
benchmark disables background work), so it measures flush cost more than
batching.

Memtable scans copy entries in chunks of 8 to 256 per read-lock acquisition.
Before that change they took one lock and one tree seek per row and ran at
1.8 M rows/s.

## Known limitations

* Full compaction (see `DECISIONS.md` D-003): write amplification grows with data size.
* Scans are not point-in-time snapshots (D-010).
* No filesystem fault-injection layer yet, so the WAL-failure poison path is
  covered by code review, not by an automated test.
