//! Change events for watchers (`GET /v1/watch`, a WebSocket).
//!
//! Every write that this node applies is published on an in-memory
//! broadcast bus: single-node writes, and writes applied by the
//! replication groups this node belongs to. Delivery is best-effort. A
//! watcher that falls behind the bus capacity gets a `lagged` notice and
//! should re-read the keys it cares about. Events are not persisted;
//! watching starts at "now".

use std::sync::Arc;

use celeris_storage::{Op, WriteBatch, WriteOutcome};
use serde::Serialize;
use tokio::sync::broadcast;

/// Events buffered per watcher before it is told it lagged.
pub const BUS_CAPACITY: usize = 4_096;

/// One applied change to a key.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct ChangeEvent {
    pub key: String,
    /// `put` or `delete`.
    pub kind: &'static str,
    /// The new value (JSON text), for puts.
    #[serde(skip)]
    pub value: Option<String>,
    pub version: u64,
    pub mutation_id: String,
}

pub type EventBus = broadcast::Sender<Arc<ChangeEvent>>;

pub fn new_bus() -> EventBus {
    broadcast::channel(BUS_CAPACITY).0
}

/// Publishes the operations of an applied batch. Deduplicated retries are
/// not new changes and publish nothing.
pub fn publish_batch(bus: &EventBus, batch: &WriteBatch, outcome: &WriteOutcome) {
    if outcome.deduplicated || bus.receiver_count() == 0 {
        return;
    }
    for op in batch.ops() {
        let (key, kind, value) = match op {
            Op::Put { key, value, .. } => (key, "put", Some(value)),
            Op::Delete { key, .. } => (key, "delete", None),
        };
        let _ = bus.send(Arc::new(ChangeEvent {
            key: String::from_utf8_lossy(key).into_owned(),
            kind,
            value: value.map(|v| String::from_utf8_lossy(v).into_owned()),
            version: outcome.version,
            mutation_id: batch.mutation_id().to_string(),
        }));
    }
}

impl ChangeEvent {
    /// The message sent to watchers, with the value embedded as JSON.
    pub fn to_message(&self) -> String {
        let value = self
            .value
            .as_deref()
            .and_then(|v| serde_json::from_str::<serde_json::Value>(v).ok());
        serde_json::json!({
            "type": "change",
            "key": self.key,
            "kind": self.kind,
            "value": value,
            "version": self.version,
            "mutation_id": self.mutation_id,
        })
        .to_string()
    }
}

#[cfg(test)]
mod tests {
    use celeris_core::MutationId;

    use super::*;

    #[test]
    fn applied_batches_become_events_and_retries_do_not() {
        let bus = new_bus();
        let mut rx = bus.subscribe();
        let batch = WriteBatch::new(MutationId::random())
            .put("a", r#"{"n":1}"#)
            .delete("b");
        let outcome = WriteOutcome {
            version: 7,
            deduplicated: false,
        };
        publish_batch(&bus, &batch, &outcome);
        let put = rx.try_recv().expect("put");
        assert_eq!((put.key.as_str(), put.kind, put.version), ("a", "put", 7));
        assert!(put.to_message().contains(r#""value":{"n":1}"#));
        let delete = rx.try_recv().expect("delete");
        assert_eq!((delete.key.as_str(), delete.kind), ("b", "delete"));
        publish_batch(
            &bus,
            &batch,
            &WriteOutcome {
                version: 7,
                deduplicated: true,
            },
        );
        assert!(
            rx.try_recv().is_err(),
            "a deduplicated retry is not a change"
        );
    }
}
