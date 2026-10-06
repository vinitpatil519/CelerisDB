//! Secondary indexes (D-031): maintenance on every kind of write, backfill
//! and drop in steps, restarts, and group commit.

use std::collections::BTreeSet;
use std::ops::Bound;
use std::path::Path;
use std::sync::Arc;
use std::thread;
use std::time::Duration;

use celeris_core::MutationId;
use celeris_storage::{Engine, IndexSpec, ManualClock, Options, SyncMode, WriteBatch};
use serde_json::{Value, json};

fn options(indexes: Vec<IndexSpec>) -> Options {
    Options {
        sync: SyncMode::Never,
        background_work: false,
        memtable_size_bytes: 16 * 1024,
        indexes,
        ..Options::default()
    }
}

fn by_status() -> IndexSpec {
    IndexSpec::new("by_status", "orders/", "status").expect("spec")
}

fn open(dir: &Path, indexes: Vec<IndexSpec>) -> Engine {
    Engine::open(dir, options(indexes)).expect("open")
}

fn put(e: &Engine, key: &str, value: Value) {
    e.put(key, value.to_string()).expect("put");
}

fn lookup(e: &Engine, value: Value) -> Option<Vec<String>> {
    e.index_lookup(
        "by_status",
        &value,
        Bound::Unbounded,
        Bound::Unbounded,
        usize::MAX,
    )
    .expect("lookup")
    .map(|keys| {
        keys.into_iter()
            .map(|k| String::from_utf8(k).expect("utf-8"))
            .collect()
    })
}

/// What the index must return: a scan of the data itself.
fn brute(e: &Engine, value: &Value) -> Vec<String> {
    e.scan_prefix(b"orders/", usize::MAX)
        .expect("scan")
        .into_iter()
        .filter(|r| {
            serde_json::from_slice::<Value>(&r.value)
                .is_ok_and(|v| v.get("status").is_some_and(|s| s == value))
        })
        .map(|r| String::from_utf8(r.key).expect("utf-8"))
        .collect()
}

fn finish_steps(e: &Engine, limit: usize) -> usize {
    let mut steps = 0;
    while e.index_step_at(0, limit).expect("step").worked {
        steps += 1;
        assert!(steps < 10_000, "index steps do not converge");
    }
    steps
}

#[test]
fn writes_keep_the_index_exact() {
    let dir = tempfile::tempdir().expect("tempdir");
    let e = open(dir.path(), vec![by_status()]);
    finish_steps(&e, 100);
    put(&e, "orders/1", json!({"status": "paid"}));
    put(&e, "orders/2", json!({"status": "open"}));
    put(&e, "orders/3", json!({"status": "paid", "total": 3}));
    put(&e, "users/1", json!({"status": "paid"}));
    e.put("orders/4", "not json").expect("put");
    put(&e, "orders/5", json!({"status": ["paid"]}));
    assert_eq!(
        lookup(&e, json!("paid")),
        Some(vec!["orders/1".into(), "orders/3".into()])
    );

    // Update moves the key; delete removes it.
    put(&e, "orders/1", json!({"status": "open"}));
    e.delete("orders/3").expect("delete");
    assert_eq!(lookup(&e, json!("paid")), Some(vec![]));
    assert_eq!(
        lookup(&e, json!("open")),
        Some(vec!["orders/1".into(), "orders/2".into()])
    );

    // Two writes of one key in a batch: the last one counts.
    e.write(
        WriteBatch::new(MutationId::random())
            .put("orders/6", json!({"status": "paid"}).to_string())
            .put("orders/6", json!({"status": "void"}).to_string()),
    )
    .expect("batch");
    assert_eq!(lookup(&e, json!("paid")), Some(vec![]));
    assert_eq!(lookup(&e, json!("void")), Some(vec!["orders/6".into()]));

    // Numbers match by value; arrays and objects are never indexed.
    put(&e, "orders/7", json!({"status": 2}));
    assert_eq!(lookup(&e, json!(2.0)), Some(vec!["orders/7".into()]));
    assert_eq!(lookup(&e, json!(["paid"])), None);

    // Range bounds apply to the keys.
    let some = e
        .index_lookup(
            "by_status",
            &json!("open"),
            Bound::Excluded(b"orders/1"),
            Bound::Unbounded,
            10,
        )
        .expect("lookup");
    assert_eq!(some, Some(vec![b"orders/2".to_vec()]));

    // The index survives a restart (WAL replay and flushed tables).
    e.flush().expect("flush");
    put(&e, "orders/8", json!({"status": "open"}));
    drop(e);
    let e = open(dir.path(), vec![by_status()]);
    for v in [json!("open"), json!("paid"), json!("void")] {
        assert_eq!(lookup(&e, v.clone()), Some(brute(&e, &v)), "{v}");
    }
}

#[test]
fn indexed_entries_expire_with_their_values() {
    let dir = tempfile::tempdir().expect("tempdir");
    let clock = Arc::new(ManualClock::new(1_000));
    let e = Engine::open_with_clock(dir.path(), options(vec![by_status()]), clock.clone())
        .expect("open");
    finish_steps(&e, 100);
    e.write(WriteBatch::new(MutationId::random()).put_with_ttl(
        "orders/1",
        json!({"status": "paid"}).to_string(),
        Duration::from_secs(5),
    ))
    .expect("put");
    assert_eq!(lookup(&e, json!("paid")), Some(vec!["orders/1".into()]));
    clock.advance(Duration::from_secs(6));
    assert_eq!(lookup(&e, json!("paid")), Some(vec![]));
}

#[test]
fn a_new_index_is_built_in_steps_while_writes_continue() {
    let dir = tempfile::tempdir().expect("tempdir");
    let e = open(dir.path(), Vec::new());
    for i in 0..200 {
        let status = ["paid", "open", "void"][i % 3];
        put(&e, &format!("orders/{i:03}"), json!({"status": status}));
    }
    e.flush().expect("flush");
    drop(e);

    let e = open(dir.path(), vec![by_status()]);
    assert_eq!(lookup(&e, json!("paid")), None, "not ready yet");
    assert_eq!(e.indexes().expect("indexes")[0].state, "building");
    let mut steps = 0;
    while e.index_step_at(0, 17).expect("step").worked {
        steps += 1;
        // Writes on both sides of the build cursor.
        let i = (steps * 37) % 200;
        put(&e, &format!("orders/{i:03}"), json!({"status": "paid"}));
        e.delete(format!("orders/{:03}", (i + 101) % 200))
            .expect("delete");
    }
    assert!(steps >= 200 / 17);
    assert_eq!(e.indexes().expect("indexes")[0].state, "ready");
    for v in [json!("paid"), json!("open"), json!("void")] {
        assert_eq!(lookup(&e, v.clone()), Some(brute(&e, &v)), "{v}");
    }
}

#[test]
fn removed_and_redefined_indexes_are_dropped() {
    let dir = tempfile::tempdir().expect("tempdir");
    let e = open(dir.path(), vec![by_status()]);
    for i in 0..50 {
        put(
            &e,
            &format!("orders/{i:02}"),
            json!({"status": "paid", "kind": i % 2}),
        );
    }
    finish_steps(&e, 100);
    drop(e);

    // Same name, other field: the old entries go, the new ones come.
    let by_kind = IndexSpec::new("by_status", "orders/", "kind").expect("spec");
    let e = open(dir.path(), vec![by_kind]);
    let states: BTreeSet<_> = e
        .indexes()
        .expect("indexes")
        .into_iter()
        .map(|s| s.state)
        .collect();
    assert_eq!(states, BTreeSet::from(["building", "dropping"]));
    finish_steps(&e, 7);
    assert_eq!(lookup(&e, json!("paid")), Some(vec![]));
    assert_eq!(lookup(&e, json!(1)).map(|k| k.len()), Some(25));
    drop(e);

    // Not configured any more: dropped entirely.
    let e = open(dir.path(), Vec::new());
    assert_eq!(e.indexes().expect("indexes")[0].state, "dropping");
    finish_steps(&e, 7);
    assert!(e.indexes().expect("indexes").is_empty());
    assert!(!e.index_work_pending().expect("pending"));
}

#[test]
fn every_step_commits_exactly_one_version() {
    let dir = tempfile::tempdir().expect("tempdir");
    let e = open(dir.path(), vec![by_status()]);
    let mut last = e.put("orders/x", "1").expect("put").version;
    for _ in 0..5 {
        let step = e.index_step_at(0, 1).expect("step");
        assert_eq!(step.version, last + 1);
        last = step.version;
    }
}

#[test]
fn concurrent_group_commit_writers_keep_the_index_exact() {
    let dir = tempfile::tempdir().expect("tempdir");
    let e = Arc::new(
        Engine::open(
            dir.path(),
            Options {
                sync: SyncMode::Always,
                ..options(vec![by_status()])
            },
        )
        .expect("open"),
    );
    finish_steps(&e, 100);
    thread::scope(|s| {
        for t in 0..4 {
            let e = Arc::clone(&e);
            s.spawn(move || {
                for i in 0..40 {
                    // Writers contend on the same ten keys.
                    let key = format!("orders/{}", (i * 7 + t) % 10);
                    let status = ["paid", "open"][(i + t) % 2];
                    e.put(key, json!({"status": status}).to_string())
                        .expect("put");
                }
            });
        }
    });
    for v in [json!("paid"), json!("open")] {
        assert_eq!(lookup(&e, v.clone()), Some(brute(&e, &v)), "{v}");
    }
}

#[test]
fn ordered_scans_follow_value_order_with_bounds_and_cursors() {
    let dir = tempfile::tempdir().expect("tempdir");
    let asc = IndexSpec::new("by_total", "orders/", "total").expect("spec");
    let desc = IndexSpec::new("by_total_desc", "orders/", "total")
        .expect("spec")
        .descending();
    let e = open(dir.path(), vec![asc, desc]);
    finish_steps(&e, 100);
    let totals = [5, -3, 12, 5, 0, 99, 7, 12];
    for (i, t) in totals.iter().enumerate() {
        put(&e, &format!("orders/{i}"), json!({"total": t}));
    }
    put(&e, "orders/s", json!({"total": "n/a"}));
    let scan = |name: &str, lo: Bound<&Value>, hi: Bound<&Value>, after: Option<&[u8]>, limit| {
        e.index_scan(name, lo, hi, after, limit)
            .expect("scan")
            .expect("ready")
    };
    let keys = |entries: &[celeris_storage::IndexEntry]| -> Vec<String> {
        entries
            .iter()
            .map(|x| String::from_utf8(x.key.clone()).expect("utf-8"))
            .collect()
    };

    let all = scan("by_total", Bound::Unbounded, Bound::Unbounded, None, 100);
    assert_eq!(
        keys(&all),
        [
            "orders/1", "orders/4", "orders/0", "orders/3", "orders/6", "orders/2", "orders/7",
            "orders/5", "orders/s"
        ]
    );
    let all_desc = scan(
        "by_total_desc",
        Bound::Unbounded,
        Bound::Unbounded,
        None,
        100,
    );
    assert_eq!(
        keys(&all_desc),
        [
            "orders/s", "orders/5", "orders/2", "orders/7", "orders/6", "orders/0", "orders/3",
            "orders/4", "orders/1"
        ]
    );

    // A one-sided numeric bound stays within numbers.
    let five = json!(5);
    let at_least_5 = scan(
        "by_total",
        Bound::Included(&five),
        Bound::Unbounded,
        None,
        100,
    );
    assert_eq!(
        keys(&at_least_5),
        [
            "orders/0", "orders/3", "orders/6", "orders/2", "orders/7", "orders/5"
        ]
    );
    let below_5_desc = scan(
        "by_total_desc",
        Bound::Unbounded,
        Bound::Excluded(&five),
        None,
        100,
    );
    assert_eq!(keys(&below_5_desc), ["orders/4", "orders/1"]);

    // Cursors continue where a page stopped.
    let mut seen = Vec::new();
    let mut after: Option<Vec<u8>> = None;
    loop {
        let page = scan(
            "by_total_desc",
            Bound::Unbounded,
            Bound::Unbounded,
            after.as_deref(),
            2,
        );
        if page.is_empty() {
            break;
        }
        after = page.last().map(|x| x.position.clone());
        seen.extend(keys(&page));
    }
    assert_eq!(seen, keys(&all_desc));
}
