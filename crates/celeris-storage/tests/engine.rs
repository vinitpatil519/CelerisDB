//! Engine behaviour through the public API: durability, recovery, TTL,
//! conditional writes, idempotency, corruption handling and concurrency.

use std::fs;
use std::ops::Bound;
use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::thread;
use std::time::Duration;

use celeris_core::MutationId;
use celeris_storage::{
    Condition, Engine, ManualClock, Op, Options, StorageError, SyncMode, WriteBatch,
};

fn small() -> Options {
    Options {
        sync: SyncMode::Never,
        memtable_size_bytes: 4 * 1024,
        block_size_bytes: 512,
        target_table_size_bytes: 16 * 1024,
        background_work: false,
        ..Options::default()
    }
}

fn open(dir: &Path) -> Engine {
    Engine::open(dir, small()).expect("open")
}

fn val(e: &Engine, key: &str) -> Option<String> {
    e.get(key.as_bytes())
        .expect("get")
        .map(|r| String::from_utf8(r.value).expect("utf8"))
}

fn all_keys(e: &Engine) -> Vec<String> {
    e.scan(Bound::Unbounded, Bound::Unbounded, usize::MAX)
        .expect("scan")
        .into_iter()
        .map(|r| String::from_utf8(r.key).expect("utf8"))
        .collect()
}

fn files_with_ext(dir: &Path, ext: &str) -> Vec<PathBuf> {
    let mut v: Vec<_> = fs::read_dir(dir)
        .expect("ls")
        .map(|e| e.expect("entry").path())
        .filter(|p| p.extension().is_some_and(|x| x == ext))
        .collect();
    v.sort();
    v
}

fn put_cond(key: &str, value: &str, condition: Condition) -> WriteBatch {
    WriteBatch::new(MutationId::random()).push(Op::Put {
        key: key.into(),
        value: value.into(),
        ttl: None,
        condition: Some(condition),
    })
}

#[test]
fn put_get_delete_and_versions() {
    let dir = tempfile::tempdir().expect("tempdir");
    let e = open(dir.path());
    let v1 = e.put("users/42", "ada").expect("put").version;
    let rec = e.get(b"users/42").expect("get").expect("present");
    assert_eq!(rec.value, b"ada");
    assert_eq!(rec.version, v1);
    let v2 = e.put("users/42", "grace").expect("put").version;
    assert!(v2 > v1);
    assert_eq!(val(&e, "users/42").as_deref(), Some("grace"));
    e.delete("users/42").expect("delete");
    assert_eq!(val(&e, "users/42"), None);
    assert_eq!(val(&e, "never-written"), None);
    assert!(matches!(e.get(b""), Err(StorageError::InvalidKey(_))));
    assert!(matches!(
        e.put("\0secret", "x"),
        Err(StorageError::InvalidKey(_))
    ));
}

#[test]
fn unflushed_writes_survive_restart_via_wal() {
    let dir = tempfile::tempdir().expect("tempdir");
    {
        let e = Engine::open(
            dir.path(),
            Options {
                memtable_size_bytes: 1 << 20,
                ..small()
            },
        )
        .expect("open");
        for i in 0..100 {
            e.put(format!("k{i:03}"), format!("v{i}")).expect("put");
        }
        e.delete("k050").expect("delete");
    }
    let e = open(dir.path());
    assert_eq!(e.recovery_report().batches_replayed, 101);
    assert_eq!(val(&e, "k007").as_deref(), Some("v7"));
    assert_eq!(val(&e, "k050"), None);
    assert_eq!(all_keys(&e).len(), 99);
}

#[test]
fn data_survives_flush_compaction_and_restart() {
    let dir = tempfile::tempdir().expect("tempdir");
    let expect = |e: &Engine| {
        for i in 0..1500 {
            let want = if i % 10 == 0 {
                None
            } else if i % 3 == 0 {
                Some(format!("updated-{i}"))
            } else {
                Some(format!("value-{i}"))
            };
            assert_eq!(val(e, &format!("key{i:05}")), want, "key{i:05}");
        }
    };
    {
        let e = open(dir.path());
        for i in 0..1500 {
            e.put(format!("key{i:05}"), format!("value-{i}"))
                .expect("put");
        }
        for i in (0..1500).step_by(3) {
            e.put(format!("key{i:05}"), format!("updated-{i}"))
                .expect("put");
        }
        for i in (0..1500).step_by(10) {
            e.delete(format!("key{i:05}")).expect("delete");
        }
        assert!(e.metrics().flushes > 0, "small memtable forces flushes");
        expect(&e);
        e.flush().expect("flush");
        let summary = e.compact().expect("compact");
        assert!(summary.input_tables > 1);
        let stats = e.stats();
        assert_eq!(stats.l0_tables, 0);
        assert!(stats.l1_tables >= 1);
        assert_eq!(stats.immutable_memtables, 0);
        expect(&e);
    }
    let e = open(dir.path());
    expect(&e);
    assert!(files_with_ext(dir.path(), "wal").len() <= 2);
}

#[test]
fn scans_merge_every_layer() {
    let dir = tempfile::tempdir().expect("tempdir");
    let e = open(dir.path());
    for i in 0..30 {
        e.put(format!("users/{i:02}"), format!("u{i}"))
            .expect("put");
        e.put(format!("orders/{i:02}"), format!("o{i}"))
            .expect("put");
    }
    e.flush().expect("flush");
    e.put("users/05", "u5-new").expect("put");
    e.delete("users/06").expect("delete");
    e.flush().expect("flush");
    e.put("users/07", "u7-mem").expect("put");
    e.delete("users/08").expect("delete");
    e.put("users/99", "u99").expect("put");

    let users = e.scan_prefix(b"users/", usize::MAX).expect("scan");
    let keys: Vec<_> = users
        .iter()
        .map(|r| String::from_utf8_lossy(&r.key).into_owned())
        .collect();
    let mut expected: Vec<String> = (0..30)
        .filter(|i| *i != 6 && *i != 8)
        .map(|i| format!("users/{i:02}"))
        .collect();
    expected.push("users/99".into());
    assert_eq!(keys, expected);
    let get = |k: &str| {
        users
            .iter()
            .find(|r| r.key == k.as_bytes())
            .map(|r| r.value.clone())
    };
    assert_eq!(get("users/05"), Some(b"u5-new".to_vec()));
    assert_eq!(get("users/07"), Some(b"u7-mem".to_vec()));

    let page = e
        .scan(
            Bound::Excluded(b"users/10"),
            Bound::Included(b"users/13"),
            2,
        )
        .expect("scan");
    assert_eq!(
        page.iter().map(|r| r.key.clone()).collect::<Vec<_>>(),
        vec![b"users/11".to_vec(), b"users/12".to_vec()]
    );
    assert!(
        e.scan(Bound::Included(b"z"), Bound::Included(b"a"), 10)
            .expect("scan")
            .is_empty()
    );
    assert_eq!(e.scan_prefix(b"orders/", 1000).expect("scan").len(), 30);
    assert!(
        all_keys(&e).iter().all(|k| !k.starts_with('\0')),
        "internal mutation records never leak into scans"
    );
}

#[test]
fn write_at_is_deterministic_across_replicas_with_skewed_clocks() {
    // Two replicas with wildly different local clocks apply the same log.
    let apply = |clock_ms: u64| {
        let dir = tempfile::tempdir().expect("tempdir");
        let clock = Arc::new(ManualClock::new(clock_ms));
        let e = Engine::open_with_clock(dir.path(), small(), clock).expect("open");
        let log = [
            (
                1_000,
                WriteBatch::new(MutationId::from_u128(1)).put_with_ttl(
                    "s",
                    "x",
                    Duration::from_secs(5),
                ),
            ),
            (2_000, put_cond("lock", "a", Condition::Absent)),
            (9_000, put_cond("s", "y", Condition::Absent)), // "s" expired at 6_000
        ];
        let outcomes: Vec<String> = log
            .into_iter()
            .map(|(at, batch)| match e.write_at(batch, at) {
                Ok(o) => format!("ok:{}", o.version),
                Err(err) => format!("err:{err}"),
            })
            .collect();
        let s = e.get(b"s").expect("get").map(|r| (r.value, r.timestamp_ms));
        (outcomes, s, dir)
    };
    let (a, a_s, _da) = apply(0);
    let (b, b_s, _db) = apply(10_000_000);
    assert_eq!(a, b, "same log, same outcomes");
    assert!(a.iter().all(|o| o.starts_with("ok:")), "{a:?}");
    assert_eq!(a_s, Some((b"y".to_vec(), 9_000)));
    assert_eq!(b_s.map(|(_, t)| t), Some(9_000));
}

#[test]
fn snapshots_reproduce_state_versions_and_dedupe_records() {
    let source_dir = tempfile::tempdir().expect("tempdir");
    let source = open(source_dir.path());
    let id = MutationId::random();
    source
        .write(WriteBatch::new(id).put("a", "1"))
        .expect("write");
    for i in 0..300 {
        source
            .put(format!("bulk/{i:03}"), "x".repeat(50))
            .expect("put");
    }
    source.put("b", "2").expect("put");
    source.delete("b").expect("delete"); // newest write is a delete
    let snapshot = source.snapshot().expect("snapshot");
    let last = source.stats().last_version;

    let target_dir = tempfile::tempdir().expect("tempdir");
    let target_path = target_dir.path().join("restored");
    {
        let target =
            Engine::create_from_snapshot(&target_path, small(), &snapshot).expect("install");
        assert_eq!(
            target.get(b"a").expect("get").map(|r| r.version),
            source.get(b"a").expect("get").map(|r| r.version)
        );
        assert_eq!(val(&target, "b"), None);
        assert_eq!(
            target
                .scan_prefix(b"bulk/", usize::MAX)
                .expect("scan")
                .len(),
            300
        );
        assert_eq!(
            target.mutation_status(id).expect("status"),
            source.mutation_status(id).expect("status")
        );
        // Retrying the original mutation is deduplicated on the replica too.
        assert!(
            target
                .write(WriteBatch::new(id).put("a", "1"))
                .expect("retry")
                .deduplicated
        );
        // The next write gets the same version on both engines.
        let next_source = source.put("c", "3").expect("put").version;
        let next_target = target.put("c", "3").expect("put").version;
        assert_eq!(next_source, next_target);
        assert_eq!(next_target, last + 1);
    }
    // The sequence survives a restart of the restored engine.
    let reopened = open(&target_path);
    assert_eq!(reopened.put("d", "4").expect("put").version, last + 2);
    assert!(
        Engine::create_from_snapshot(&target_path, small(), &snapshot).is_err(),
        "target must be empty"
    );
    let mut corrupt = snapshot.clone();
    let n = corrupt.len();
    corrupt[n / 2] ^= 1;
    let elsewhere = target_dir.path().join("corrupt");
    assert!(matches!(
        Engine::create_from_snapshot(&elsewhere, small(), &corrupt),
        Err(StorageError::Corruption { .. })
    ));
}

#[test]
fn metadata_is_atomic_hidden_from_scans_and_survives_restart_and_snapshots() {
    let dir = tempfile::tempdir().expect("tempdir");
    let e = open(dir.path());
    let v = e
        .write(
            WriteBatch::new(MutationId::random())
                .put("user", "1")
                .set_meta("p/7", Some(b"fenced".to_vec()))
                .set_meta("p/9", Some(b"released".to_vec())),
        )
        .expect("write");
    // Metadata alone is a valid batch.
    e.write(WriteBatch::new(MutationId::random()).set_meta("p/9", None))
        .expect("meta only");
    assert!(
        e.write(WriteBatch::new(MutationId::random()).set_meta("", None))
            .is_err(),
        "empty metadata names are rejected"
    );
    assert_eq!(all_keys(&e), vec!["user"], "metadata is not user data");
    assert_eq!(
        e.meta(b"p/").expect("meta"),
        vec![(b"p/7".to_vec(), b"fenced".to_vec())]
    );
    assert_eq!(
        e.get(b"user").expect("get").map(|r| r.version),
        Some(v.version)
    );

    let snapshot = e.snapshot().expect("snapshot");
    e.flush().expect("flush");
    e.compact().expect("compact");
    drop(e);
    let e = open(dir.path());
    assert_eq!(
        e.meta(b"p/").expect("meta").len(),
        1,
        "survives compaction and restart"
    );
    let copy_dir = tempfile::tempdir().expect("tempdir");
    let copy = Engine::create_from_snapshot(copy_dir.path().join("s"), small(), &snapshot)
        .expect("from snapshot");
    assert_eq!(
        copy.meta(b"p/").expect("meta").len(),
        1,
        "carried by snapshots"
    );
}

#[test]
fn purging_writes_delete_matching_keys_in_one_version() {
    let dir = tempfile::tempdir().expect("tempdir");
    let e = open(dir.path());
    for k in ["a1", "a2", "b1", "a3"] {
        e.put(k, "v").expect("put");
    }
    e.flush().expect("flush"); // some keys on disk, some in memory
    e.put("a4", "v").expect("put");
    e.delete("a3").expect("delete");
    let before = e.stats().last_version;
    let out = e
        .write_purging_at(
            WriteBatch::new(MutationId::random()).put("a2", "kept"),
            &|k| k.starts_with(b"a"),
            1,
        )
        .expect("purge");
    assert_eq!(out.version, before + 1, "one version for the whole purge");
    assert_eq!(
        all_keys(&e),
        vec!["a2", "b1"],
        "the batch's own key survives"
    );
    assert_eq!(val(&e, "a2").as_deref(), Some("kept"));
    drop(e);
    let e = open(dir.path());
    assert_eq!(all_keys(&e), vec!["a2", "b1"], "durable");
}

#[test]
fn ttl_expiry_and_tombstone_retention() {
    let dir = tempfile::tempdir().expect("tempdir");
    let clock = Arc::new(ManualClock::new(1_000_000));
    let opts = Options {
        tombstone_retention: Duration::from_secs(3600),
        ..small()
    };
    let e = Engine::open_with_clock(dir.path(), opts, clock.clone()).expect("open");
    e.write(WriteBatch::new(MutationId::random()).put_with_ttl(
        "session",
        "token",
        Duration::from_secs(10),
    ))
    .expect("put");
    e.put("keep", "forever").expect("put");
    e.put("doomed", "x").expect("put");
    e.delete("doomed").expect("delete");
    let rec = e.get(b"session").expect("get").expect("live");
    assert_eq!(rec.expires_at_ms, Some(1_010_000));

    clock.advance(Duration::from_secs(11));
    assert_eq!(val(&e, "session"), None, "expired values are invisible");
    assert_eq!(all_keys(&e), vec!["keep".to_string()]);

    e.flush().expect("flush");
    let first = e.compact().expect("compact");
    assert_eq!(first.tombstones_purged, 0, "retention not yet reached");
    assert_eq!(val(&e, "session"), None);

    clock.advance(Duration::from_secs(3600));
    let second = e.compact().expect("compact");
    assert_eq!(
        second.tombstones_purged, 2,
        "expired value and delete tombstone purged"
    );
    assert_eq!(val(&e, "keep").as_deref(), Some("forever"));
    assert_eq!(val(&e, "doomed"), None);
}

#[test]
fn conditional_writes_are_atomic() {
    let dir = tempfile::tempdir().expect("tempdir");
    let e = open(dir.path());
    let v1 = e
        .write(put_cond("lock", "a", Condition::Absent))
        .expect("create")
        .version;
    let err = e
        .write(put_cond("lock", "b", Condition::Absent))
        .expect_err("exists");
    assert!(matches!(err, StorageError::ConditionFailed { actual: Some(v), .. } if v == v1));

    let v2 = e
        .write(put_cond("lock", "c", Condition::Version(v1)))
        .expect("cas")
        .version;
    assert!(
        e.write(put_cond("lock", "d", Condition::Version(v1)))
            .is_err(),
        "stale version"
    );
    assert_eq!(val(&e, "lock").as_deref(), Some("c"));

    // One failed condition aborts the whole batch.
    let batch = WriteBatch::new(MutationId::random())
        .put("side-effect", "x")
        .push(Op::Put {
            key: "lock".into(),
            value: "e".into(),
            ttl: None,
            condition: Some(Condition::Version(v1)),
        });
    assert!(e.write(batch).is_err());
    assert_eq!(val(&e, "side-effect"), None);
    assert_eq!(e.get(b"lock").expect("get").map(|r| r.version), Some(v2));

    e.delete("lock").expect("delete");
    e.write(put_cond("lock", "f", Condition::Absent))
        .expect("deleted counts as absent");
    assert_eq!(e.metrics().condition_failures, 3);
}

#[test]
fn mutation_ids_make_retries_idempotent_across_restarts() {
    let dir = tempfile::tempdir().expect("tempdir");
    let id = MutationId::random();
    let batch = WriteBatch::new(id).put("counter", "1");
    let original = {
        let e = open(dir.path());
        let first = e.write(batch.clone()).expect("write");
        assert!(!first.deduplicated);
        // Someone else overwrites; a late retry must not clobber it.
        e.put("counter", "2").expect("put");
        let retry = e.write(batch.clone()).expect("retry");
        assert!(retry.deduplicated);
        assert_eq!(retry.version, first.version);
        assert_eq!(val(&e, "counter").as_deref(), Some("2"));
        assert!(matches!(
            e.write(WriteBatch::new(id).put("counter", "999")),
            Err(StorageError::MutationIdReused(_))
        ));
        assert_eq!(e.mutation_status(id).expect("status"), Some(first.version));
        assert_eq!(
            e.mutation_status(MutationId::random()).expect("status"),
            None
        );
        e.flush().expect("flush");
        e.compact().expect("compact");
        first.version
    };
    let e = open(dir.path());
    assert_eq!(e.mutation_status(id).expect("status"), Some(original));
    let retry = e.write(batch).expect("retry after restart");
    assert!(retry.deduplicated);
    assert_eq!(val(&e, "counter").as_deref(), Some("2"));
}

#[test]
fn mutation_ids_are_forgotten_after_retention() {
    let dir = tempfile::tempdir().expect("tempdir");
    let clock = Arc::new(ManualClock::new(5_000));
    let opts = Options {
        mutation_retention: Duration::from_secs(60),
        ..small()
    };
    let e = Engine::open_with_clock(dir.path(), opts, clock.clone()).expect("open");
    let id = MutationId::random();
    e.write(WriteBatch::new(id).put("k", "v")).expect("write");
    assert!(e.mutation_status(id).expect("status").is_some());
    clock.advance(Duration::from_secs(61));
    assert_eq!(e.mutation_status(id).expect("status"), None);
    e.flush().expect("flush");
    e.compact().expect("compact");
    assert_eq!(e.mutation_status(id).expect("status"), None);
}

#[test]
fn every_torn_wal_tail_recovers_a_batch_prefix() {
    let source = tempfile::tempdir().expect("tempdir");
    {
        let e = Engine::open(
            source.path(),
            Options {
                memtable_size_bytes: 1 << 20,
                ..small()
            },
        )
        .expect("open");
        for i in 0..12 {
            // Two keys per batch: a torn batch must lose both or neither.
            e.write(
                WriteBatch::new(MutationId::random())
                    .put(format!("a{i:02}"), format!("{i}"))
                    .put(format!("b{i:02}"), format!("{i}")),
            )
            .expect("write");
        }
    }
    let wals = files_with_ext(source.path(), "wal");
    assert_eq!(wals.len(), 1);
    let wal_bytes = fs::read(&wals[0]).expect("read wal");
    let manifest = fs::read(source.path().join("MANIFEST")).expect("read manifest");
    let wal_name = wals[0].file_name().expect("name").to_owned();

    let mut last_count = 0;
    for cut in (0..=wal_bytes.len()).step_by(5).chain([wal_bytes.len()]) {
        let dir = tempfile::tempdir().expect("tempdir");
        fs::write(dir.path().join("MANIFEST"), &manifest).expect("write");
        fs::write(dir.path().join(&wal_name), &wal_bytes[..cut]).expect("write");
        let count = {
            let e = open(dir.path());
            let keys = all_keys(&e);
            let n = keys.len() / 2;
            let expected: Vec<String> = (0..n)
                .map(|i| format!("a{i:02}"))
                .chain((0..n).map(|i| format!("b{i:02}")))
                .collect();
            assert_eq!(
                keys, expected,
                "cut at {cut}: batches recovered whole, in order"
            );
            n
        };
        assert!(count >= last_count);
        last_count = count;
        // The truncated WAL is now an older WAL; reopening must stay clean.
        let again = open(dir.path());
        assert_eq!(
            all_keys(&again).len(),
            count * 2,
            "cut at {cut}: second recovery"
        );
    }
    assert_eq!(last_count, 12);
}

#[test]
fn corruption_in_an_older_wal_is_reported_not_skipped() {
    let dir = tempfile::tempdir().expect("tempdir");
    let opts = Options {
        memtable_size_bytes: 1 << 20,
        ..small()
    };
    {
        let e = Engine::open(dir.path(), opts.clone()).expect("open");
        e.put("first", "1").expect("put");
        e.put("second", "2").expect("put");
    }
    {
        let e = Engine::open(dir.path(), opts.clone()).expect("open");
        e.put("third", "3").expect("put");
    }
    let wals = files_with_ext(dir.path(), "wal");
    assert!(wals.len() >= 2);
    let mut bytes = fs::read(&wals[0]).expect("read");
    let last = bytes.len() - 1;
    bytes[last] ^= 0xFF;
    fs::write(&wals[0], &bytes).expect("write");
    assert!(matches!(
        Engine::open(dir.path(), opts),
        Err(StorageError::Corruption { .. })
    ));
}

#[test]
fn corrupted_table_block_returns_an_error_never_wrong_data() {
    let dir = tempfile::tempdir().expect("tempdir");
    {
        let e = open(dir.path());
        for i in 0..200 {
            e.put(format!("key{i:04}"), format!("value-{i}"))
                .expect("put");
        }
        e.flush().expect("flush");
        e.compact().expect("compact");
    }
    // Internal mutation records (prefix 0x00) sort first, so user keys live
    // in the last compaction output.
    let tables = files_with_ext(dir.path(), "sst");
    let target = tables.last().expect("a table");
    let mut bytes = fs::read(target).expect("read");
    bytes[100] ^= 0x5A;
    fs::write(target, &bytes).expect("write");

    let e = open(dir.path());
    let mut errors = 0;
    for i in 0..200 {
        match e.get(format!("key{i:04}").as_bytes()) {
            Ok(Some(r)) => assert_eq!(r.value, format!("value-{i}").into_bytes()),
            Ok(None) => panic!("key{i:04} silently missing"),
            Err(StorageError::Corruption { .. }) => errors += 1,
            Err(other) => panic!("unexpected error {other}"),
        }
    }
    assert!(errors > 0);
}

#[test]
fn data_directory_is_exclusive() {
    let dir = tempfile::tempdir().expect("tempdir");
    let first = open(dir.path());
    assert!(matches!(
        Engine::open(dir.path(), small()),
        Err(StorageError::Locked(_))
    ));
    drop(first);
    open(dir.path());
}

#[test]
fn missing_manifest_with_tables_refuses_to_start() {
    let dir = tempfile::tempdir().expect("tempdir");
    {
        let e = open(dir.path());
        e.put("k", "v").expect("put");
        e.flush().expect("flush");
    }
    fs::remove_file(dir.path().join("MANIFEST")).expect("rm");
    assert!(matches!(
        Engine::open(dir.path(), small()),
        Err(StorageError::Corruption { .. })
    ));
    assert!(
        !files_with_ext(dir.path(), "sst").is_empty(),
        "tables must not be deleted"
    );
}

#[test]
fn leftovers_from_interrupted_operations_are_removed() {
    let dir = tempfile::tempdir().expect("tempdir");
    {
        let e = open(dir.path());
        e.put("k", "v").expect("put");
        e.flush().expect("flush");
    }
    fs::write(dir.path().join("00000000000000000999.sst"), b"half a table").expect("write");
    fs::write(dir.path().join("00000000000000000998.sst.tmp"), b"tmp").expect("write");
    fs::write(dir.path().join("MANIFEST.tmp"), b"tmp").expect("write");
    let e = open(dir.path());
    assert_eq!(e.recovery_report().orphan_files_removed, 3);
    assert!(!dir.path().join("00000000000000000999.sst").exists());
    assert_eq!(val(&e, "k").as_deref(), Some("v"));
}

#[test]
fn future_manifest_version_is_rejected() {
    let dir = tempfile::tempdir().expect("tempdir");
    drop(open(dir.path()));
    let path = dir.path().join("MANIFEST");
    let mut bytes = fs::read(&path).expect("read");
    bytes[8] = 99;
    fs::write(&path, &bytes).expect("write");
    assert!(matches!(
        Engine::open(dir.path(), small()),
        Err(StorageError::UnsupportedFormat { found: 99, .. })
    ));
}

#[test]
fn write_stall_flushes_inline() {
    let dir = tempfile::tempdir().expect("tempdir");
    let e = Engine::open(
        dir.path(),
        Options {
            memtable_size_bytes: 2048,
            max_immutable_memtables: 1,
            ..small()
        },
    )
    .expect("open");
    for i in 0..400 {
        e.put(format!("k{i:04}"), "v".repeat(20)).expect("put");
    }
    let m = e.metrics();
    assert!(m.write_stalls > 0);
    assert!(m.flushes > 0);
    assert_eq!(all_keys(&e).len(), 400);
}

#[test]
fn concurrent_writers_and_readers_with_background_flush() {
    let dir = tempfile::tempdir().expect("tempdir");
    let e = Arc::new(
        Engine::open(
            dir.path(),
            Options {
                background_work: true,
                l0_compaction_trigger: 3,
                ..small()
            },
        )
        .expect("open"),
    );
    let writers: Vec<_> = (0..4)
        .map(|t| {
            let e = Arc::clone(&e);
            thread::spawn(move || {
                for i in 0..300 {
                    e.put(format!("t{t}/{i:04}"), format!("{t}:{i}"))
                        .expect("put");
                }
            })
        })
        .collect();
    let readers: Vec<_> = (0..2)
        .map(|_| {
            let e = Arc::clone(&e);
            thread::spawn(move || {
                for round in 0..200 {
                    let (t, i) = (round % 4, (round * 7) % 300);
                    if let Some(r) = e.get(format!("t{t}/{i:04}").as_bytes()).expect("get") {
                        assert_eq!(r.value, format!("{t}:{i}").into_bytes());
                    }
                    let _ = e
                        .scan_prefix(format!("t{t}/").as_bytes(), 50)
                        .expect("scan");
                }
            })
        })
        .collect();
    for h in writers.into_iter().chain(readers) {
        h.join().expect("thread");
    }
    e.flush().expect("flush");
    for t in 0..4 {
        assert_eq!(
            e.scan_prefix(format!("t{t}/").as_bytes(), usize::MAX)
                .expect("scan")
                .len(),
            300
        );
    }
    let stats = e.stats();
    assert_eq!(stats.background_error, None);
    assert_eq!(stats.poisoned, None);
    assert!(e.metrics().compactions > 0);
}

fn durable() -> Options {
    Options {
        sync: SyncMode::Always,
        ..small()
    }
}

/// Concurrent writers share fsyncs, and every acknowledged write is durable,
/// visible, and has its own version.
#[test]
fn group_commit_shares_fsyncs_and_keeps_every_write() {
    let dir = tempfile::tempdir().expect("tempdir");
    let engine = Arc::new(Engine::open(dir.path(), durable()).expect("open"));
    let threads = 8;
    let per_thread = 50;
    let handles: Vec<_> = (0..threads)
        .map(|t| {
            let engine = Arc::clone(&engine);
            thread::spawn(move || {
                let mut versions = Vec::new();
                for i in 0..per_thread {
                    let key = format!("t{t}/k{i:03}");
                    let out = engine
                        .write(WriteBatch::new(MutationId::random()).put(key.as_str(), "v"))
                        .expect("write");
                    // Visible as soon as it is acknowledged.
                    assert!(engine.get(key.as_bytes()).expect("get").is_some());
                    versions.push(out.version);
                }
                versions
            })
        })
        .collect();
    let mut versions: Vec<u64> = handles
        .into_iter()
        .flat_map(|h| h.join().expect("join"))
        .collect();
    versions.sort_unstable();
    versions.dedup();
    assert_eq!(versions.len(), threads * per_thread, "unique versions");

    let m = engine.metrics();
    assert_eq!(m.write_batches, (threads * per_thread) as u64);
    assert!(
        m.wal_syncs <= m.write_batches,
        "at most one fsync per batch ({} syncs, {} batches)",
        m.wal_syncs,
        m.write_batches
    );

    drop(engine);
    let reopened = Engine::open(dir.path(), durable()).expect("reopen");
    assert_eq!(all_keys(&reopened).len(), threads * per_thread);
}

/// Compare-and-set sees writes that are still waiting for their fsync, so
/// concurrent increments never lose an update.
#[test]
fn group_commit_conditions_see_unsynced_writes() {
    let dir = tempfile::tempdir().expect("tempdir");
    let engine = Arc::new(Engine::open(dir.path(), durable()).expect("open"));
    engine
        .write(WriteBatch::new(MutationId::random()).put("counter", "0"))
        .expect("seed");
    let threads = 6;
    let per_thread = 20;
    let handles: Vec<_> = (0..threads)
        .map(|_| {
            let engine = Arc::clone(&engine);
            thread::spawn(move || {
                let mut done = 0;
                while done < per_thread {
                    let current = engine.get(b"counter").expect("get").expect("present");
                    let n: u64 = String::from_utf8(current.value)
                        .expect("utf8")
                        .parse()
                        .expect("number");
                    let next = (n + 1).to_string();
                    match engine.write(put_cond(
                        "counter",
                        &next,
                        Condition::Version(current.version),
                    )) {
                        Ok(_) => done += 1,
                        Err(StorageError::ConditionFailed { .. }) => {}
                        Err(e) => panic!("write: {e}"),
                    }
                }
            })
        })
        .collect();
    for h in handles {
        h.join().expect("join");
    }
    assert_eq!(
        val(&engine, "counter").as_deref(),
        Some((threads * per_thread).to_string().as_str())
    );
}

/// A retried mutation ID returns the original version, even while the
/// original is still in flight.
#[test]
fn group_commit_deduplicates_concurrent_retries() {
    let dir = tempfile::tempdir().expect("tempdir");
    let engine = Arc::new(Engine::open(dir.path(), durable()).expect("open"));
    let id = MutationId::random();
    let handles: Vec<_> = (0..8)
        .map(|_| {
            let engine = Arc::clone(&engine);
            thread::spawn(move || {
                engine
                    .write(WriteBatch::new(id).put("same", "x"))
                    .expect("write")
            })
        })
        .collect();
    let outcomes: Vec<_> = handles
        .into_iter()
        .map(|h| h.join().expect("join"))
        .collect();
    let first = outcomes[0].version;
    assert!(outcomes.iter().all(|o| o.version == first));
    assert_eq!(outcomes.iter().filter(|o| !o.deduplicated).count(), 1);
    assert_eq!(engine.mutation_status(id).expect("status"), Some(first));
}

/// An online backup is a consistent cut: every write acknowledged before it
/// started is in it, nothing newer than its version is, and a restored
/// engine continues from the same versions.
#[test]
fn online_backup_is_a_consistent_cut_under_concurrent_writes() {
    let dir = tempfile::tempdir().expect("tempdir");
    let engine = Arc::new(Engine::open(dir.path(), durable()).expect("open"));
    for i in 0..200 {
        engine
            .write(WriteBatch::new(MutationId::random()).put(format!("pre/{i:03}"), "v"))
            .expect("write");
    }
    let stop = Arc::new(std::sync::atomic::AtomicBool::new(false));
    let writer = {
        let (engine, stop) = (Arc::clone(&engine), Arc::clone(&stop));
        thread::spawn(move || {
            let mut i = 0u64;
            while !stop.load(std::sync::atomic::Ordering::Relaxed) {
                engine
                    .write(WriteBatch::new(MutationId::random()).put(format!("live/{i:06}"), "v"))
                    .expect("write");
                engine
                    .write(WriteBatch::new(MutationId::random()).put("pre/000", format!("{i}")))
                    .expect("overwrite");
                i += 1;
            }
        })
    };
    thread::sleep(Duration::from_millis(50));
    let (snapshot, version) = engine.backup().expect("backup");
    stop.store(true, std::sync::atomic::Ordering::Relaxed);
    writer.join().expect("join");

    let restored_dir = tempfile::tempdir().expect("tempdir");
    let restored =
        Engine::create_from_snapshot(restored_dir.path(), durable(), &snapshot).expect("restore");
    let keys = all_keys(&restored);
    for i in 0..200 {
        assert!(keys.contains(&format!("pre/{i:03}")), "pre/{i:03} missing");
    }
    let records = restored
        .scan(Bound::Unbounded, Bound::Unbounded, usize::MAX)
        .expect("scan");
    assert!(
        records.iter().all(|r| r.version <= version),
        "nothing newer than the cut"
    );
    // The overwritten key is present at some version within the cut.
    assert!(records.iter().any(|r| r.key == b"pre/000"));
    let next = restored
        .write(WriteBatch::new(MutationId::random()).put("after", "x"))
        .expect("write after restore");
    assert!(next.version > version, "versions continue after the cut");
}
