//! Celeris single-node storage engine.
//!
//! A log-structured merge engine built from scratch:
//!
//! ```text
//! write ─► WAL (fsync) ─► memtable ─► immutable memtable ─► L0 SSTable ─► compaction ─► L1 run
//! read  ─► memtable ─► immutable memtables ─► L0 (newest first) ─► L1 (bloom + sparse index + block cache)
//! ```
//!
//! Guarantees provided by this crate:
//!
//! * A write is acknowledged only after its WAL record is written (and, with
//!   [`SyncMode::Always`], fsynced). Acknowledged writes survive process crashes.
//! * A [`WriteBatch`] is atomic: after a crash either every operation in it is
//!   recovered or none is.
//! * Every batch carries a [`celeris_core::MutationId`]. Retrying a batch with
//!   the same ID returns the original outcome instead of applying it twice.
//! * All persistent formats carry a magic number and a format version.
//! * A WAL write or fsync failure makes the engine read-only, because the
//!   on-disk state of the log is then unknown. The failed write reports an
//!   unknown outcome ([`StorageError::is_outcome_unknown`]).
//!
//! See `docs/STORAGE_ENGINE.md` for the on-disk formats.

mod batch;
mod bloom;
mod cache;
mod clock;
mod codec;
mod engine;
mod entry;
mod error;
mod fsutil;
mod index;
mod iter;
mod manifest;
mod memtable;
mod metrics;
mod sstable;
mod wal;

pub use batch::{Condition, MAX_BATCH_BYTES, MAX_BATCH_OPS, Op, WriteBatch};
pub use clock::{Clock, ManualClock, SystemClock};
pub use engine::SNAPSHOT_FORMAT_VERSION;
pub use engine::{
    CompactionSummary, Engine, EngineStats, Latest, Options, Record, RecoveryReport, SyncMode,
    WriteOutcome, prefix_successor,
};
pub use error::{Result, StorageError};
pub use index::{IndexSpec, IndexStatus, IndexStep};
pub use manifest::MANIFEST_FORMAT_VERSION;
pub use metrics::MetricsSnapshot;
pub use sstable::TABLE_FORMAT_VERSION;
pub use wal::WAL_FORMAT_VERSION;
