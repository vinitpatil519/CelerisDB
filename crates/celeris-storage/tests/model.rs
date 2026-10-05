//! Property test: random operation sequences (including flushes, compactions
//! and restarts) must leave the engine equal to a trivial in-memory model.

use std::collections::BTreeMap;
use std::ops::Bound;

use celeris_core::MutationId;
use celeris_storage::{Engine, Options, SyncMode, WriteBatch};
use proptest::prelude::*;

#[derive(Debug, Clone)]
enum Action {
    Put(u8, Vec<u8>),
    Delete(u8),
    Batch(Vec<(u8, Option<Vec<u8>>)>),
    Flush,
    Compact,
    Reopen,
    Check,
}

fn action() -> impl Strategy<Value = Action> {
    let value = || prop::collection::vec(any::<u8>(), 0..40);
    prop_oneof![
        6 => (0u8..32, value()).prop_map(|(k, v)| Action::Put(k, v)),
        2 => (0u8..32).prop_map(Action::Delete),
        2 => prop::collection::vec((0u8..32, prop::option::of(value())), 1..5).prop_map(Action::Batch),
        1 => Just(Action::Flush),
        1 => Just(Action::Compact),
        1 => Just(Action::Reopen),
        1 => Just(Action::Check),
    ]
}

fn key(k: u8) -> Vec<u8> {
    format!("key{k:03}").into_bytes()
}

fn options() -> Options {
    Options {
        sync: SyncMode::Never,
        memtable_size_bytes: 1024,
        block_size_bytes: 256,
        max_immutable_memtables: 2,
        l0_compaction_trigger: 3,
        target_table_size_bytes: 4096,
        background_work: false,
        ..Options::default()
    }
}

fn assert_matches(engine: &Engine, model: &BTreeMap<Vec<u8>, Vec<u8>>) {
    for k in 0..32 {
        let got = engine.get(&key(k)).expect("get").map(|r| r.value);
        assert_eq!(got.as_ref(), model.get(&key(k)), "key{k:03}");
    }
    let scanned: Vec<(Vec<u8>, Vec<u8>)> = engine
        .scan(Bound::Unbounded, Bound::Unbounded, usize::MAX)
        .expect("scan")
        .into_iter()
        .map(|r| (r.key, r.value))
        .collect();
    let expected: Vec<(Vec<u8>, Vec<u8>)> =
        model.iter().map(|(k, v)| (k.clone(), v.clone())).collect();
    assert_eq!(scanned, expected);
}

proptest! {
    #![proptest_config(ProptestConfig { cases: 48, ..ProptestConfig::default() })]

    #[test]
    fn engine_matches_btreemap_model(actions in prop::collection::vec(action(), 1..80)) {
        let dir = tempfile::tempdir().expect("tempdir");
        let mut engine = Some(Engine::open(dir.path(), options()).expect("open"));
        let mut model: BTreeMap<Vec<u8>, Vec<u8>> = BTreeMap::new();
        for action in actions {
            let e = engine.as_ref().expect("engine is open");
            match action {
                Action::Put(k, v) => {
                    e.put(key(k), v.clone()).expect("put");
                    model.insert(key(k), v);
                }
                Action::Delete(k) => {
                    e.delete(key(k)).expect("delete");
                    model.remove(&key(k));
                }
                Action::Batch(ops) => {
                    let mut batch = WriteBatch::new(MutationId::random());
                    for (k, v) in &ops {
                        batch = match v {
                            Some(v) => batch.put(key(*k), v.clone()),
                            None => batch.delete(key(*k)),
                        };
                    }
                    e.write(batch).expect("batch");
                    for (k, v) in ops {
                        match v {
                            Some(v) => model.insert(key(k), v),
                            None => model.remove(&key(k)),
                        };
                    }
                }
                Action::Flush => e.flush().expect("flush"),
                Action::Compact => {
                    e.compact().expect("compact");
                }
                Action::Reopen => {
                    drop(engine.take());
                    engine = Some(Engine::open(dir.path(), options()).expect("reopen"));
                }
                Action::Check => assert_matches(e, &model),
            }
        }
        assert_matches(engine.as_ref().expect("engine is open"), &model);
    }
}
