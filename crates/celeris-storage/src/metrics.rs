//! Engine counters. Exported to Prometheus by the server crate.

use std::sync::atomic::{AtomicU64, Ordering};

macro_rules! counters {
    ($($(#[$doc:meta])* $name:ident),* $(,)?) => {
        #[derive(Debug, Default)]
        pub(crate) struct Metrics {
            $(pub(crate) $name: AtomicU64,)*
        }

        /// Point-in-time copy of the engine's monotonic counters.
        #[derive(Debug, Clone, Copy, Default, PartialEq, Eq)]
        pub struct MetricsSnapshot {
            $($(#[$doc])* pub $name: u64,)*
        }

        impl Metrics {
            pub(crate) fn snapshot(&self) -> MetricsSnapshot {
                MetricsSnapshot {
                    $($name: self.$name.load(Ordering::Relaxed),)*
                }
            }
        }

        impl MetricsSnapshot {
            /// `(name, value)` for every counter, in declaration order.
            pub fn counters(&self) -> Vec<(&'static str, u64)> {
                vec![$((stringify!($name), self.$name),)*]
            }
        }
    };
}

counters! {
    /// Batches committed to the WAL.
    write_batches,
    /// Individual put/delete operations committed.
    write_ops,
    /// Bytes appended to the WAL (including framing).
    wal_bytes,
    /// WAL fsyncs performed on the write path.
    wal_syncs,
    /// WAL append/fsync failures (each one poisons the engine).
    wal_failures,
    /// Writes answered from the mutation-ID dedupe table.
    dedup_hits,
    /// Conditional writes rejected.
    condition_failures,
    /// Point reads.
    reads,
    /// Point reads that found a live value.
    read_hits,
    /// SSTable lookups skipped by the bloom filter.
    bloom_negatives,
    block_cache_hits,
    block_cache_misses,
    /// Memtables flushed to L0.
    flushes,
    flush_bytes,
    compactions,
    compaction_bytes_in,
    compaction_bytes_out,
    /// Tombstones (and expired values) dropped after the retention period.
    tombstones_purged,
    /// Writes that had to wait for an inline flush.
    write_stalls,
    /// Failed background flush/compaction attempts.
    background_errors,
}

pub(crate) fn inc(counter: &AtomicU64) {
    counter.fetch_add(1, Ordering::Relaxed);
}

pub(crate) fn add(counter: &AtomicU64, n: u64) {
    counter.fetch_add(n, Ordering::Relaxed);
}
