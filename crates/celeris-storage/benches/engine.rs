//! Storage engine micro-benchmarks.
//!
//! ```text
//! cargo bench -p celeris-storage                 # everything
//! cargo bench -p celeris-storage -- get          # one group
//! ```
//!
//! Most benchmarks use `SyncMode::Never` so they measure the engine, not the
//! disk. `put/fsync` uses `SyncMode::Always` and shows what group commit
//! buys under concurrent writers.

use std::hint::black_box;
use std::ops::Bound;
use std::sync::Arc;
use std::thread;
use std::time::{Duration, Instant};

use celeris_core::MutationId;
use celeris_storage::{Engine, Options, SyncMode, WriteBatch};
use criterion::{BatchSize, Criterion, Throughput, criterion_group, criterion_main};
use tempfile::TempDir;

const VALUE: &[u8] = &[b'x'; 128];
const PRELOADED: u64 = 50_000;

fn options(sync: SyncMode) -> Options {
    Options {
        sync,
        background_work: false,
        ..Options::default()
    }
}

fn open(sync: SyncMode) -> (Engine, TempDir) {
    let dir = tempfile::tempdir().expect("tempdir");
    let engine = Engine::open(dir.path(), options(sync)).expect("open");
    (engine, dir)
}

fn key(i: u64) -> Vec<u8> {
    format!("user/{i:010}").into_bytes()
}

/// An engine holding `PRELOADED` keys, either still in the memtable or
/// flushed and compacted into SSTables.
fn preloaded(on_disk: bool) -> (Engine, TempDir) {
    let (engine, dir) = open(SyncMode::Never);
    for chunk in (0..PRELOADED).collect::<Vec<_>>().chunks(500) {
        let mut batch = WriteBatch::new(MutationId::random());
        for &i in chunk {
            batch = batch.put(key(i), VALUE);
        }
        engine.write(batch).expect("preload");
    }
    if on_disk {
        engine.flush().expect("flush");
        engine.compact().expect("compact");
    }
    (engine, dir)
}

fn put(c: &mut Criterion) {
    let mut group = c.benchmark_group("put");
    group.throughput(Throughput::Elements(1));

    let (engine, _dir) = open(SyncMode::Never);
    let mut i = 0u64;
    group.bench_function("single", |b| {
        b.iter(|| {
            i += 1;
            engine.put(key(i), VALUE).expect("put")
        })
    });

    for size in [10usize, 100] {
        let (engine, _dir) = open(SyncMode::Never);
        let mut i = 0u64;
        group.throughput(Throughput::Elements(size as u64));
        group.bench_function(format!("batch_{size}"), |b| {
            b.iter(|| {
                let mut batch = WriteBatch::new(MutationId::random());
                for _ in 0..size {
                    i += 1;
                    batch = batch.put(key(i), VALUE);
                }
                engine.write(batch).expect("write")
            })
        });
    }
    group.finish();

    // fsync-bound: one writer pays a full fsync per put; eight writers share
    // fsyncs through group commit.
    let mut group = c.benchmark_group("put/fsync");
    group.sample_size(10);
    group.measurement_time(Duration::from_secs(5));
    group.throughput(Throughput::Elements(1));
    for writers in [1u64, 8] {
        let (engine, _dir) = open(SyncMode::Always);
        let engine = Arc::new(engine);
        group.bench_function(format!("{writers}_writers"), |b| {
            b.iter_custom(|iters| {
                let per = iters.div_ceil(writers);
                let start = Instant::now();
                thread::scope(|s| {
                    for w in 0..writers {
                        let engine = Arc::clone(&engine);
                        s.spawn(move || {
                            for i in 0..per {
                                engine.put(key(w << 40 | i), VALUE).expect("put");
                            }
                        });
                    }
                });
                start.elapsed()
            })
        });
    }
    group.finish();
}

fn get(c: &mut Criterion) {
    let mut group = c.benchmark_group("get");
    group.throughput(Throughput::Elements(1));
    for (name, on_disk) in [("memtable", false), ("sstable", true)] {
        let (engine, _dir) = preloaded(on_disk);
        let mut i = 0u64;
        group.bench_function(format!("hit/{name}"), |b| {
            b.iter(|| {
                // A stride coprime with PRELOADED visits every key.
                i = (i + 7_919) % PRELOADED;
                black_box(engine.get(&key(i)).expect("get").expect("present"))
            })
        });
        let mut i = 0u64;
        group.bench_function(format!("miss/{name}"), |b| {
            b.iter(|| {
                i += 1;
                black_box(engine.get(&key(PRELOADED + i)).expect("get"))
            })
        });
    }
    group.finish();
}

fn scan(c: &mut Criterion) {
    let mut group = c.benchmark_group("scan");
    group.throughput(Throughput::Elements(100));
    for (name, on_disk) in [("memtable", false), ("sstable", true)] {
        let (engine, _dir) = preloaded(on_disk);
        let mut i = 0u64;
        group.bench_function(format!("100/{name}"), |b| {
            b.iter(|| {
                i = (i + 7_919) % (PRELOADED - 100);
                let start = key(i);
                let rows = engine
                    .scan(Bound::Included(&start), Bound::Unbounded, 100)
                    .expect("scan");
                assert_eq!(rows.len(), 100);
                black_box(rows)
            })
        });
    }
    group.finish();
}

fn maintenance(c: &mut Criterion) {
    let mut group = c.benchmark_group("maintenance");
    group.sample_size(10);
    group.throughput(Throughput::Elements(PRELOADED));
    group.bench_function("flush_50k", |b| {
        b.iter_batched(
            || preloaded(false),
            |(engine, dir)| {
                engine.flush().expect("flush");
                (engine, dir)
            },
            BatchSize::PerIteration,
        )
    });
    group.bench_function("compact_50k", |b| {
        b.iter_batched(
            || {
                // Four overlapping L0 tables.
                let (engine, dir) = open(SyncMode::Never);
                for round in 0..4u64 {
                    for chunk in (0..PRELOADED / 4).collect::<Vec<_>>().chunks(500) {
                        let mut batch = WriteBatch::new(MutationId::random());
                        for &i in chunk {
                            batch = batch.put(key(i * 4 + round), VALUE);
                        }
                        engine.write(batch).expect("write");
                    }
                    engine.flush().expect("flush");
                }
                (engine, dir)
            },
            |(engine, dir)| {
                black_box(engine.compact().expect("compact"));
                (engine, dir)
            },
            BatchSize::PerIteration,
        )
    });
    group.bench_function("backup_50k", |b| {
        let (engine, _dir) = preloaded(true);
        b.iter(|| black_box(engine.backup().expect("backup")))
    });
    group.finish();
}

criterion_group!(benches, put, get, scan, maintenance);
criterion_main!(benches);
