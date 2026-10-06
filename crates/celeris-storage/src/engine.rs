//! The storage engine: write path, read path, flush, compaction, recovery.
//!
//! Concurrency model:
//!
//! * One writer at a time (`writer` mutex) owns the WAL and sequence numbers.
//! * Readers take an `Arc<Version>` snapshot (memtable, immutable memtables,
//!   tables) and never block writers for longer than a memtable lookup.
//! * Flush and compaction are serialised by the `maintenance` mutex, which
//!   also guards the in-memory copy of the manifest.
//!
//! Lock order: `writer` → `maintenance` → `version`. Maintenance never takes
//! `writer`, so an inline flush from a stalled writer cannot deadlock.

use std::collections::HashSet;
use std::fmt;
use std::fs::{self, File, OpenOptions, TryLockError};
use std::io;
use std::ops::Bound;
use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::mpsc::{self, Receiver, SyncSender};
use std::thread::{self, JoinHandle};
use std::time::Duration;

use celeris_core::{MutationId, RESERVED_KEY_PREFIX, validate_key};
use parking_lot::{Mutex, RwLock};
use tracing::{debug, error, info, warn};

use crate::batch::{Condition, Op, WriteBatch, duration_ms};
use crate::cache::BlockCache;
use crate::clock::{Clock, SystemClock};
use crate::entry::{Entry, EntryKind};
use crate::error::{Result, StorageError, corruption, io_err};
use crate::fsutil::{self, DataFile};
use crate::iter::{EntryIter, MemIter, MergeIter, as_slice_bound, bounds_empty};
use crate::manifest::{self, Manifest, TableMeta};
use crate::memtable::{MemSlot, Memtable};
use crate::metrics::{Metrics, MetricsSnapshot, add, inc};
use crate::sstable::{SsTable, TableBuilder, TableIter};
use crate::wal::{self, WalWriter};

const LOCK_FILE: &str = "LOCK";

/// Selects the user keys a purging write deletes.
type PurgeFilter<'a> = &'a dyn Fn(&[u8]) -> bool;
/// Internal key namespace for mutation-ID dedupe records: `0x00 'm' <16-byte id>`.
const MUTATION_KEY_TAG: u8 = b'm';

/// When the WAL is fsynced.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum SyncMode {
    /// fsync before acknowledging every batch. Survives power loss.
    Always,
    /// Leave flushing to the OS. Survives process crashes but not power
    /// loss or kernel panics. For benchmarks and tests.
    Never,
}

#[derive(Debug, Clone)]
pub struct Options {
    pub sync: SyncMode,
    /// Rotate the memtable once it holds roughly this many bytes.
    pub memtable_size_bytes: usize,
    /// Writers stall (flush inline) once this many memtables await flushing.
    pub max_immutable_memtables: usize,
    /// Compact once this many L0 tables exist.
    pub l0_compaction_trigger: usize,
    /// Compaction output files are split at about this size.
    pub target_table_size_bytes: u64,
    pub block_size_bytes: usize,
    pub bloom_bits_per_key: usize,
    pub block_cache_bytes: usize,
    /// How long tombstones (and expired values) are kept before compaction
    /// may drop them. Must exceed the longest time a replica can stay
    /// partitioned, or deleted data can be resurrected by anti-entropy.
    pub tombstone_retention: Duration,
    /// How long mutation IDs are remembered for retry deduplication.
    pub mutation_retention: Duration,
    /// Run flush and compaction on a background thread. When false they
    /// run only on explicit calls or when writers stall.
    pub background_work: bool,
}

impl Default for Options {
    fn default() -> Self {
        Options {
            sync: SyncMode::Always,
            memtable_size_bytes: 32 * 1024 * 1024,
            max_immutable_memtables: 4,
            l0_compaction_trigger: 4,
            target_table_size_bytes: 64 * 1024 * 1024,
            block_size_bytes: 4096,
            bloom_bits_per_key: 10,
            block_cache_bytes: 64 * 1024 * 1024,
            tombstone_retention: Duration::from_secs(24 * 60 * 60),
            mutation_retention: Duration::from_secs(24 * 60 * 60),
            background_work: true,
        }
    }
}

impl Options {
    fn validate(&self) -> Result<()> {
        let check = |ok: bool, msg: &str| {
            if ok {
                Ok(())
            } else {
                Err(StorageError::InvalidArgument(msg.to_owned()))
            }
        };
        check(
            self.memtable_size_bytes >= 1024,
            "memtable_size_bytes must be at least 1024",
        )?;
        check(
            self.max_immutable_memtables >= 1,
            "max_immutable_memtables must be at least 1",
        )?;
        check(
            self.l0_compaction_trigger >= 1,
            "l0_compaction_trigger must be at least 1",
        )?;
        check(
            (256..=1024 * 1024).contains(&self.block_size_bytes),
            "block_size_bytes must be between 256 B and 1 MiB",
        )?;
        check(
            (1..=32).contains(&self.bloom_bits_per_key),
            "bloom_bits_per_key must be between 1 and 32",
        )?;
        check(
            self.target_table_size_bytes >= 4096,
            "target_table_size_bytes must be at least 4096",
        )?;
        check(
            !self.mutation_retention.is_zero(),
            "mutation_retention must be positive",
        )
    }
}

/// A live value as seen by a reader.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Record {
    pub key: Vec<u8>,
    pub value: Vec<u8>,
    /// Commit sequence number of the batch that wrote this value. Use it
    /// with [`Condition::Version`] for compare-and-set.
    pub version: u64,
    pub timestamp_ms: u64,
    pub expires_at_ms: Option<u64>,
    pub mutation_id: MutationId,
}

/// The newest stored version of a key, live or not ([`Engine::latest`]).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Latest {
    /// The newest version is a deletion.
    pub deleted: bool,
    pub version: u64,
    pub timestamp_ms: u64,
    pub mutation_id: MutationId,
}

impl From<Entry> for Record {
    fn from(e: Entry) -> Self {
        Record {
            key: e.key,
            value: e.value,
            version: e.seq,
            timestamp_ms: e.timestamp_ms,
            expires_at_ms: e.expires_at_ms,
            mutation_id: e.mutation_id,
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct WriteOutcome {
    /// Commit sequence number of the batch.
    pub version: u64,
    /// True when this mutation ID had already committed and the original
    /// outcome was returned without applying the batch again.
    pub deduplicated: bool,
}

/// What startup recovery found and did.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct RecoveryReport {
    pub tables_opened: usize,
    pub wal_files: usize,
    pub batches_replayed: u64,
    /// Batches already present in SSTables (WAL deleted late after a flush).
    pub batches_skipped: u64,
    /// Bytes of torn WAL tail discarded. Never acknowledged data.
    pub truncated_bytes: u64,
    /// Temp files and unreferenced tables from interrupted flushes/compactions.
    pub orphan_files_removed: usize,
    pub last_version: u64,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct EngineStats {
    pub last_version: u64,
    pub memtable_bytes: usize,
    pub immutable_memtables: usize,
    pub l0_tables: usize,
    pub l1_tables: usize,
    pub table_bytes: u64,
    /// Set after a WAL failure; the engine is then read-only.
    pub poisoned: Option<String>,
    /// Most recent background flush/compaction failure, if any.
    pub background_error: Option<String>,
}

#[derive(Debug, Clone, Copy, Default, PartialEq, Eq)]
pub struct CompactionSummary {
    pub input_tables: usize,
    pub output_tables: usize,
    pub bytes_in: u64,
    pub bytes_out: u64,
    pub tombstones_purged: u64,
}

/// Immutable snapshot of the read path.
#[derive(Debug, Clone)]
struct Version {
    mem: Arc<MemSlot>,
    /// Frozen memtables awaiting flush, newest first.
    imm: Vec<Arc<MemSlot>>,
    /// Flushed tables, newest first. May overlap.
    l0: Vec<Arc<SsTable>>,
    /// Compacted run, sorted by key range, non-overlapping.
    l1: Vec<Arc<SsTable>>,
}

#[derive(Debug)]
struct WriterState {
    wal: WalWriter,
    next_seq: u64,
    poisoned: Option<String>,
    /// Group commit: batches written to the WAL but not yet fsynced, in
    /// sequence order. They are invisible to readers until published.
    unsynced: std::collections::VecDeque<UnsyncedBatch>,
    /// The newest unpublished entry of each key in `unsynced`, so later
    /// writes check conditions and retries against them.
    overlay: std::collections::HashMap<Vec<u8>, Entry>,
}

#[derive(Debug)]
struct UnsyncedBatch {
    seq: u64,
    entries: Vec<Entry>,
    ops: usize,
}

impl WriterState {
    fn check(&self) -> Result<()> {
        match &self.poisoned {
            Some(reason) => Err(StorageError::Poisoned(reason.clone())),
            None => Ok(()),
        }
    }
}

#[derive(Debug)]
enum Task {
    Flush,
    Shutdown,
}

#[derive(Debug)]
struct Inner {
    dir: PathBuf,
    opts: Options,
    clock: Arc<dyn Clock>,
    metrics: Arc<Metrics>,
    cache: Arc<BlockCache>,
    writer: Mutex<WriterState>,
    version: RwLock<Arc<Version>>,
    /// In-memory copy of the manifest; held for the whole of a flush or compaction.
    maintenance: Mutex<Manifest>,
    next_file_id: AtomicU64,
    last_seq: AtomicU64,
    bg_tx: Option<SyncSender<Task>>,
    bg_error: Mutex<Option<String>>,
    /// Serializes group-commit fsyncs: one writer syncs for everyone queued.
    sync_lock: Mutex<()>,
    recovery: RecoveryReport,
    _lock: File,
}

/// A single-node storage engine instance bound to one data directory.
pub struct Engine {
    inner: Arc<Inner>,
    worker: Option<JoinHandle<()>>,
}

impl fmt::Debug for Engine {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.debug_struct("Engine")
            .field("dir", &self.inner.dir)
            .field("last_version", &self.inner.last_seq.load(Ordering::Acquire))
            .finish_non_exhaustive()
    }
}

/// (commit version, batch fingerprint) from a mutation record, if live.
fn decode_mutation(entry: Option<Entry>, id: MutationId, now: u64) -> Result<Option<(u64, u64)>> {
    let Some(e) = entry else {
        return Ok(None);
    };
    if !e.is_live_at(now) {
        return Ok(None);
    }
    let (Some(version), Some(fingerprint)) = (
        e.value
            .get(..8)
            .and_then(|b| b.try_into().ok())
            .map(u64::from_le_bytes),
        e.value
            .get(8..16)
            .and_then(|b| b.try_into().ok())
            .map(u64::from_le_bytes),
    ) else {
        return Err(StorageError::Internal(format!(
            "malformed mutation record for {id}"
        )));
    };
    Ok(Some((version, fingerprint)))
}

/// After a group commit the batch must be visible; anything else is a bug.
fn check_visible(published: u64, seq: u64) -> Result<()> {
    if published >= seq {
        Ok(())
    } else {
        Err(StorageError::Internal(format!(
            "group commit published up to {published}, not {seq}"
        )))
    }
}

fn mutation_key(id: MutationId) -> Vec<u8> {
    let mut key = Vec::with_capacity(18);
    key.push(RESERVED_KEY_PREFIX);
    key.push(MUTATION_KEY_TAG);
    key.extend_from_slice(&id.to_bytes());
    key
}

fn acquire_lock(dir: &Path) -> Result<File> {
    let path = dir.join(LOCK_FILE);
    let file = OpenOptions::new()
        .create(true)
        .truncate(false)
        .read(true)
        .write(true)
        .open(&path)
        .map_err(io_err(&path))?;
    match file.try_lock() {
        Ok(()) => Ok(file),
        Err(TryLockError::WouldBlock) => Err(StorageError::Locked(dir.to_path_buf())),
        Err(TryLockError::Error(e)) => Err(io_err(&path)(e)),
    }
}

#[derive(Debug, Default)]
struct DirScan {
    wals: Vec<u64>,
    tables: Vec<u64>,
    temp: Vec<PathBuf>,
    max_id: u64,
}

fn scan_dir(dir: &Path) -> Result<DirScan> {
    let mut scan = DirScan::default();
    for entry in fs::read_dir(dir).map_err(io_err(dir))? {
        let entry = entry.map_err(io_err(dir))?;
        let name = entry.file_name();
        let Some(name) = name.to_str() else { continue };
        match fsutil::classify(name) {
            DataFile::Wal(id) => {
                scan.max_id = scan.max_id.max(id);
                scan.wals.push(id);
            }
            DataFile::Table(id) => {
                scan.max_id = scan.max_id.max(id);
                scan.tables.push(id);
            }
            DataFile::Temp => scan.temp.push(entry.path()),
            DataFile::Other => {}
        }
    }
    scan.wals.sort_unstable();
    Ok(scan)
}

fn remove_orphan(path: &Path, report: &mut RecoveryReport) {
    match fs::remove_file(path) {
        Ok(()) => {
            report.orphan_files_removed += 1;
            info!(path = %path.display(), "removed leftover file from an interrupted operation");
        }
        Err(e) => warn!(path = %path.display(), error = %e, "could not remove leftover file"),
    }
}

impl Engine {
    /// Opens (creating if necessary) the data directory and recovers state.
    pub fn open(dir: impl AsRef<Path>, options: Options) -> Result<Engine> {
        Self::open_with_clock(dir, options, Arc::new(SystemClock))
    }

    pub fn open_with_clock(
        dir: impl AsRef<Path>,
        options: Options,
        clock: Arc<dyn Clock>,
    ) -> Result<Engine> {
        options.validate()?;
        let dir = dir.as_ref().to_path_buf();
        fs::create_dir_all(&dir).map_err(io_err(&dir))?;
        let lock = acquire_lock(&dir)?;
        let metrics = Arc::new(Metrics::default());
        let cache = Arc::new(BlockCache::new(options.block_cache_bytes));
        let mut report = RecoveryReport::default();

        // 1. Manifest and directory listing.
        let scan = scan_dir(&dir)?;
        let mut manifest = match manifest::load(&dir)? {
            Some(m) => m,
            None if !scan.tables.is_empty() => {
                return Err(corruption(
                    &manifest::path(&dir),
                    "MANIFEST is missing but table files exist; refusing to guess which are live",
                ));
            }
            None => Manifest::default(),
        };
        for path in &scan.temp {
            remove_orphan(path, &mut report);
        }
        let live: HashSet<u64> = manifest.tables.iter().map(|t| t.id).collect();
        for &id in scan.tables.iter().filter(|id| !live.contains(id)) {
            remove_orphan(&fsutil::table_path(&dir, id), &mut report);
        }

        // 2. Open live tables.
        let mut l0 = Vec::new();
        let mut l1 = Vec::new();
        let mut max_seq = manifest.flushed_seq;
        for meta in &manifest.tables {
            max_seq = max_seq.max(meta.max_seq);
            let table = Arc::new(SsTable::open(
                &dir,
                meta.clone(),
                Arc::clone(&cache),
                Arc::clone(&metrics),
            )?);
            if meta.level == 0 {
                l0.push(table);
            } else {
                l1.push(table);
            }
        }
        l0.sort_by_key(|t| std::cmp::Reverse(t.meta.id));
        l1.sort_by(|a, b| a.meta.min_key.cmp(&b.meta.min_key));
        report.tables_opened = l0.len() + l1.len();

        // 3. Replay WALs in order. Only the newest may have a torn tail: older
        //    ones were fsynced in full before the writer moved on.
        let mut mem = Memtable::default();
        for (i, &id) in scan.wals.iter().enumerate() {
            let path = fsutil::wal_path(&dir, id);
            let contents = wal::read_wal(&path)?;
            if contents.valid_len < contents.file_len {
                if i + 1 != scan.wals.len() {
                    return Err(corruption(
                        &path,
                        format!(
                            "invalid record at offset {} in a WAL that is not the newest; acknowledged writes may be lost",
                            contents.valid_len
                        ),
                    ));
                }
                let dropped = contents.file_len - contents.valid_len;
                warn!(path = %path.display(), bytes = dropped, "discarding torn WAL tail (never acknowledged)");
                wal::truncate(&path, contents.valid_len)?;
                report.truncated_bytes += dropped;
            }
            for batch in contents.batches {
                let seq = batch[0].seq;
                if seq <= manifest.flushed_seq {
                    report.batches_skipped += 1;
                    continue;
                }
                max_seq = max_seq.max(seq);
                for entry in batch {
                    mem.insert(entry);
                }
                report.batches_replayed += 1;
            }
        }
        report.wal_files = scan.wals.len();
        report.last_version = max_seq;

        // 4. Persist the manifest before creating the new WAL so a WAL never
        //    exists with an id the manifest could hand out again.
        let wal_id = manifest.next_file_id.max(scan.max_id + 1);
        manifest.next_file_id = wal_id + 1;
        manifest::store(&dir, &manifest)?;
        let wal = WalWriter::create(&dir, wal_id, options.sync == SyncMode::Always)?;
        let mut mem_wals = scan.wals.clone();
        mem_wals.push(wal_id);

        let version = Version {
            mem: Arc::new(MemSlot::new(mem, mem_wals)),
            imm: Vec::new(),
            l0,
            l1,
        };
        let (bg_tx, bg_rx) = if options.background_work {
            let (tx, rx) = mpsc::sync_channel(4);
            (Some(tx), Some(rx))
        } else {
            (None, None)
        };
        info!(
            dir = %dir.display(),
            tables = report.tables_opened,
            wal_files = report.wal_files,
            replayed = report.batches_replayed,
            truncated_bytes = report.truncated_bytes,
            last_version = max_seq,
            "storage engine opened"
        );
        let inner = Arc::new(Inner {
            dir,
            opts: options,
            clock,
            metrics,
            cache,
            writer: Mutex::new(WriterState {
                wal,
                next_seq: max_seq + 1,
                poisoned: None,
                unsynced: std::collections::VecDeque::new(),
                overlay: std::collections::HashMap::new(),
            }),
            version: RwLock::new(Arc::new(version)),
            maintenance: Mutex::new(manifest),
            next_file_id: AtomicU64::new(wal_id + 1),
            last_seq: AtomicU64::new(max_seq),
            bg_tx,
            bg_error: Mutex::new(None),
            sync_lock: Mutex::new(()),
            recovery: report,
            _lock: lock,
        });
        let worker = match bg_rx {
            Some(rx) => {
                let worker_inner = Arc::clone(&inner);
                Some(
                    thread::Builder::new()
                        .name("celeris-storage-bg".into())
                        .spawn(move || background_loop(&worker_inner, &rx))
                        .map_err(io_err(&inner.dir))?,
                )
            }
            None => None,
        };
        Ok(Engine { inner, worker })
    }

    /// Commits a batch atomically. See [`WriteBatch`].
    pub fn write(&self, batch: WriteBatch) -> Result<WriteOutcome> {
        self.inner.write(&batch, None, None)
    }

    /// Like [`Engine::write`], but evaluates TTLs, conditions, expiry and
    /// mutation-ID retention at `now_ms` instead of the local clock.
    ///
    /// Replicas applying the same replicated log must use this with the
    /// timestamp carried in the log entry, so every replica reaches the same
    /// result regardless of clock skew.
    pub fn write_at(&self, batch: WriteBatch, now_ms: u64) -> Result<WriteOutcome> {
        self.inner.write(&batch, Some(now_ms), None)
    }

    /// Like [`Engine::write_at`], and in the same atomic commit (one
    /// version) deletes every stored user key for which `purge` returns
    /// true, except keys the batch itself writes.
    ///
    /// The purge is a single commit however many keys match, so replicas
    /// applying it stay at identical versions even if they hold different
    /// already-expired entries.
    pub fn write_purging_at(
        &self,
        batch: WriteBatch,
        purge: &dyn Fn(&[u8]) -> bool,
        now_ms: u64,
    ) -> Result<WriteOutcome> {
        self.inner.write(&batch, Some(now_ms), Some(purge))
    }

    /// Like [`Engine::mutation_status`], but judges whether the record is
    /// still remembered at `now_ms` instead of the local clock, so replicas
    /// applying the same log agree.
    pub fn mutation_status_at(&self, id: MutationId, now_ms: u64) -> Result<Option<u64>> {
        let v = self.inner.current();
        Ok(self
            .inner
            .lookup_mutation(&v, id, now_ms)?
            .map(|(version, _)| version))
    }

    /// The newest stored version of `key`, including deletions and expired
    /// values that are still retained, or `None` if nothing is stored.
    /// Last-writer-wins resolution needs this: a delete must keep beating
    /// older writes even though reads no longer show the key.
    pub fn latest(&self, key: &[u8]) -> Result<Option<Latest>> {
        validate_key(key)?;
        let v = self.inner.current();
        Ok(self.inner.get_entry(&v, key)?.map(|e| Latest {
            deleted: e.kind == EntryKind::Delete,
            version: e.seq,
            timestamp_ms: e.timestamp_ms,
            mutation_id: e.mutation_id,
        }))
    }

    /// Metadata records (see [`WriteBatch::set_meta`]) whose names start
    /// with `prefix`, as (name, value) pairs in name order.
    pub fn meta(&self, prefix: &[u8]) -> Result<Vec<(Vec<u8>, Vec<u8>)>> {
        let start = meta_key(prefix);
        let end = prefix_successor(&start).map_or(Bound::Unbounded, Bound::Excluded);
        let mut out = Vec::new();
        for entry in self.inner.raw_entries(Bound::Included(start), end) {
            let entry = entry?;
            if entry.kind == EntryKind::Put {
                out.push((entry.key[2..].to_vec(), entry.value));
            }
        }
        Ok(out)
    }

    /// Puts one key with a fresh random mutation ID.
    pub fn put(&self, key: impl Into<Vec<u8>>, value: impl Into<Vec<u8>>) -> Result<WriteOutcome> {
        self.write(WriteBatch::new(MutationId::random()).put(key, value))
    }

    /// Deletes one key with a fresh random mutation ID.
    pub fn delete(&self, key: impl Into<Vec<u8>>) -> Result<WriteOutcome> {
        self.write(WriteBatch::new(MutationId::random()).delete(key))
    }

    /// Returns the live value of `key`, or `None` if absent, deleted or expired.
    pub fn get(&self, key: &[u8]) -> Result<Option<Record>> {
        validate_key(key)?;
        inc(&self.inner.metrics.reads);
        let version = self.inner.current();
        let now = self.inner.clock.now_ms();
        let found = self
            .inner
            .get_entry(&version, key)?
            .filter(|e| e.is_live_at(now));
        if found.is_some() {
            inc(&self.inner.metrics.read_hits);
        }
        Ok(found.map(Record::from))
    }

    /// Like [`Engine::get`], but judges expiry at `now_ms` instead of the
    /// local clock, so replicas applying the same log agree.
    pub fn get_at(&self, key: &[u8], now_ms: u64) -> Result<Option<Record>> {
        validate_key(key)?;
        let version = self.inner.current();
        Ok(self
            .inner
            .get_entry(&version, key)?
            .filter(|e| e.is_live_at(now_ms))
            .map(Record::from))
    }

    /// Returns up to `limit` live records with keys in `[start, end]` per the
    /// bounds, in key order.
    ///
    /// Each returned record is a committed version, but the scan is not a
    /// point-in-time snapshot: writes that commit during the scan may or may
    /// not be observed.
    pub fn scan(
        &self,
        start: Bound<&[u8]>,
        end: Bound<&[u8]>,
        limit: usize,
    ) -> Result<Vec<Record>> {
        let min_user_key: &[u8] = &[RESERVED_KEY_PREFIX + 1];
        let start = match start {
            Bound::Included(k) | Bound::Excluded(k) if k >= min_user_key => {
                start.map(<[u8]>::to_vec)
            }
            _ => Bound::Included(min_user_key.to_vec()),
        };
        let end = end.map(<[u8]>::to_vec);
        if limit == 0 || bounds_empty(as_slice_bound(&start), as_slice_bound(&end)) {
            return Ok(Vec::new());
        }
        let v = self.inner.current();
        let mut sources: Vec<EntryIter> = Vec::new();
        for slot in std::iter::once(&v.mem).chain(&v.imm) {
            sources.push(Box::new(MemIter::new(
                Arc::clone(slot),
                start.clone(),
                end.clone(),
            )));
        }
        for table in v.l0.iter().chain(&v.l1) {
            if table_overlaps(&table.meta, &start, &end) {
                sources.push(Box::new(TableIter::new(
                    Arc::clone(table),
                    start.clone(),
                    end.clone(),
                    true,
                )));
            }
        }
        let now = self.inner.clock.now_ms();
        let mut out = Vec::new();
        for entry in MergeIter::new(sources) {
            let entry = entry?;
            if entry.is_live_at(now) {
                out.push(Record::from(entry));
                if out.len() >= limit {
                    break;
                }
            }
        }
        Ok(out)
    }

    /// Scans keys starting with `prefix`.
    pub fn scan_prefix(&self, prefix: &[u8], limit: usize) -> Result<Vec<Record>> {
        let end = prefix_successor(prefix);
        self.scan(
            Bound::Included(prefix),
            end.as_deref().map_or(Bound::Unbounded, Bound::Excluded),
            limit,
        )
    }

    /// The commit version of a mutation, if it committed within the
    /// mutation-retention window. `None` means "not committed, or too old to
    /// know" — never "definitely failed" for writes older than the window.
    pub fn mutation_status(&self, id: MutationId) -> Result<Option<u64>> {
        let v = self.inner.current();
        let now = self.inner.clock.now_ms();
        Ok(self
            .inner
            .lookup_mutation(&v, id, now)?
            .map(|(version, _)| version))
    }

    /// Rotates the memtable and flushes every pending memtable to disk.
    pub fn flush(&self) -> Result<()> {
        {
            let mut w = self.inner.writer.lock();
            w.check()?;
            self.inner.drain(&mut w)?;
            if !self.inner.current().mem.table.read().is_empty() {
                self.inner.rotate(&mut w)?;
            }
        }
        self.inner.flush_immutables()
    }

    /// Merges every on-disk table into a single sorted run, dropping
    /// shadowed versions and tombstones older than the retention period.
    pub fn compact(&self) -> Result<CompactionSummary> {
        let mut manifest = self.inner.maintenance.lock();
        self.inner.compact_locked(&mut manifest)
    }

    pub fn metrics(&self) -> MetricsSnapshot {
        self.inner.metrics.snapshot()
    }

    pub fn recovery_report(&self) -> &RecoveryReport {
        &self.inner.recovery
    }

    pub fn stats(&self) -> EngineStats {
        let v = self.inner.current();
        EngineStats {
            last_version: self.inner.last_seq.load(Ordering::Acquire),
            memtable_bytes: v.mem.table.read().approx_bytes(),
            immutable_memtables: v.imm.len(),
            l0_tables: v.l0.len(),
            l1_tables: v.l1.len(),
            table_bytes: v.l0.iter().chain(&v.l1).map(|t| t.meta.size).sum(),
            poisoned: self.inner.writer.lock().poisoned.clone(),
            background_error: self.inner.bg_error.lock().clone(),
        }
    }

    pub fn dir(&self) -> &Path {
        &self.inner.dir
    }

    /// Serializes the engine's state for a replica to catch up from.
    ///
    /// Includes every value (expired ones too, so replicas evaluate TTLs
    /// identically), internal mutation-ID records, and the last commit
    /// sequence, so [`Engine::create_from_snapshot`] reproduces identical
    /// versions. Tombstones are omitted: a fresh engine has nothing for
    /// them to shadow.
    ///
    /// The caller must prevent concurrent writes for a consistent cut.
    pub fn snapshot(&self) -> Result<Vec<u8>> {
        let v = self.inner.current();
        let mut sources: Vec<EntryIter> = Vec::new();
        for slot in std::iter::once(&v.mem).chain(&v.imm) {
            sources.push(Box::new(MemIter::new(
                Arc::clone(slot),
                Bound::Unbounded,
                Bound::Unbounded,
            )));
        }
        for table in v.l0.iter().chain(&v.l1) {
            sources.push(Box::new(TableIter::new(
                Arc::clone(table),
                Bound::Unbounded,
                Bound::Unbounded,
                false,
            )));
        }
        let last_seq = self.inner.last_seq.load(Ordering::Acquire);
        let mut body = Vec::new();
        let mut count: u64 = 0;
        for entry in MergeIter::new(sources) {
            let entry = entry?;
            if entry.kind == EntryKind::Put && entry.key != snapshot_marker_key() {
                entry.encode(&mut body);
                count += 1;
            }
        }
        let mut out = Vec::with_capacity(body.len() + 36);
        out.extend_from_slice(SNAPSHOT_MAGIC);
        out.extend_from_slice(&SNAPSHOT_FORMAT_VERSION.to_le_bytes());
        out.extend_from_slice(&last_seq.to_le_bytes());
        out.extend_from_slice(&count.to_le_bytes());
        out.extend_from_slice(&body);
        let crc = crc32fast::hash(&out);
        out.extend_from_slice(&crc.to_le_bytes());
        Ok(out)
    }

    /// Creates a new engine in the empty directory `dir` holding exactly the
    /// state captured by [`Engine::snapshot`], with the same versions.
    pub fn create_from_snapshot(
        dir: impl AsRef<Path>,
        options: Options,
        snapshot: &[u8],
    ) -> Result<Engine> {
        let dir = dir.as_ref();
        let path = dir.join("<snapshot>");
        if snapshot.len() < 32 || &snapshot[..8] != SNAPSHOT_MAGIC {
            return Err(corruption(&path, "not an engine snapshot"));
        }
        let (body, crc) = snapshot.split_at(snapshot.len() - 4);
        if crc32fast::hash(body) != u32::from_le_bytes([crc[0], crc[1], crc[2], crc[3]]) {
            return Err(corruption(&path, "snapshot checksum mismatch"));
        }
        let version = u32::from_le_bytes([body[8], body[9], body[10], body[11]]);
        if version != SNAPSHOT_FORMAT_VERSION {
            return Err(StorageError::UnsupportedFormat {
                what: "engine snapshot",
                found: version,
                supported: SNAPSHOT_FORMAT_VERSION,
            });
        }
        let word = |i: usize| u64::from_le_bytes(body[i..i + 8].try_into().unwrap_or([0; 8]));
        let (last_seq, count) = (word(12), word(20));
        let mut decoder = crate::codec::Decoder::new(&body[28..]);
        let mut entries = Vec::with_capacity(count.min(1 << 20) as usize);
        for _ in 0..count {
            entries.push(
                Entry::decode(&mut decoder)
                    .map_err(|e| corruption(&path, format!("snapshot entry: {e}")))?,
            );
        }
        if !decoder.is_empty() {
            return Err(corruption(&path, "trailing bytes in snapshot"));
        }
        if dir.exists() && fs::read_dir(dir).map_err(io_err(dir))?.next().is_some() {
            return Err(StorageError::InvalidArgument(format!(
                "{} must be empty to install a snapshot",
                dir.display()
            )));
        }
        let engine = Engine::open(dir, options)?;
        engine.inner.ingest(entries, last_seq)?;
        Ok(engine)
    }
}

const SNAPSHOT_MAGIC: &[u8; 8] = b"CELRSSNP";
/// Current engine snapshot format version.
pub const SNAPSHOT_FORMAT_VERSION: u32 = 1;
/// Internal key recording the snapshot's last sequence, so the sequence
/// survives WAL replay even when the newest write was a delete.
const SNAPSHOT_MARKER_TAG: u8 = b's';

fn snapshot_marker_key() -> Vec<u8> {
    vec![RESERVED_KEY_PREFIX, SNAPSHOT_MARKER_TAG]
}

/// Internal key namespace for metadata records: `0x00 'g' <name>`.
const META_KEY_TAG: u8 = b'g';

fn meta_key(name: &[u8]) -> Vec<u8> {
    let mut key = Vec::with_capacity(name.len() + 2);
    key.push(RESERVED_KEY_PREFIX);
    key.push(META_KEY_TAG);
    key.extend_from_slice(name);
    key
}

impl Drop for Engine {
    fn drop(&mut self) {
        if let Some(tx) = &self.inner.bg_tx {
            let _ = tx.send(Task::Shutdown);
        }
        if let Some(handle) = self.worker.take()
            && handle.join().is_err()
        {
            error!("storage background thread panicked");
        }
        let mut w = self.inner.writer.lock();
        if w.poisoned.is_none()
            && let Err(e) = self.inner.drain(&mut w)
        {
            warn!(error = %e, "final WAL sync on close failed");
        }
    }
}

fn background_loop(inner: &Inner, rx: &Receiver<Task>) {
    while let Ok(task) = rx.recv() {
        match task {
            Task::Flush => {
                if let Err(e) = inner.flush_immutables() {
                    inc(&inner.metrics.background_errors);
                    error!(error = %e, "background flush failed; will retry");
                    *inner.bg_error.lock() = Some(e.to_string());
                }
            }
            Task::Shutdown => break,
        }
    }
}

fn table_overlaps(meta: &TableMeta, start: &Bound<Vec<u8>>, end: &Bound<Vec<u8>>) -> bool {
    let below_start = match start {
        Bound::Included(s) => meta.max_key < *s,
        Bound::Excluded(s) => meta.max_key <= *s,
        Bound::Unbounded => false,
    };
    let above_end = match end {
        Bound::Included(e) => meta.min_key > *e,
        Bound::Excluded(e) => meta.min_key >= *e,
        Bound::Unbounded => false,
    };
    !below_start && !above_end
}

/// Smallest key greater than every key with this prefix, or `None` if
/// there is none (prefix empty or all 0xFF). Use as the exclusive upper
/// bound of a prefix scan.
pub fn prefix_successor(prefix: &[u8]) -> Option<Vec<u8>> {
    let mut p = prefix.to_vec();
    while let Some(last) = p.pop() {
        if last < u8::MAX {
            p.push(last + 1);
            return Some(p);
        }
    }
    None
}

/// Decides what compaction keeps. Inputs cover every on-disk table, so a
/// tombstone dropped here cannot unmask an older version.
fn compaction_filter(
    mut e: Entry,
    now: u64,
    retention_ms: u64,
    summary: &mut CompactionSummary,
) -> Option<Entry> {
    if e.key.first() == Some(&RESERVED_KEY_PREFIX) {
        // Internal records are node-local; drop them as soon as they expire.
        return e.is_live_at(now).then_some(e);
    }
    if e.kind == EntryKind::Put
        && let Some(expired_at) = e.expires_at_ms
        && expired_at <= now
    {
        // An expired value becomes a tombstone dated at its expiry, so it
        // keeps shadowing older versions (on this node and, later, on
        // replicas) until the retention period ends.
        e = Entry {
            kind: EntryKind::Delete,
            timestamp_ms: expired_at,
            expires_at_ms: None,
            value: Vec::new(),
            ..e
        };
    }
    if e.kind == EntryKind::Delete && now.saturating_sub(e.timestamp_ms) >= retention_ms {
        summary.tombstones_purged += 1;
        return None;
    }
    Some(e)
}

impl Inner {
    /// Loads snapshot entries (each keeping its original sequence) into an
    /// empty engine, then records `last_seq` so new writes continue from it.
    fn ingest(&self, entries: Vec<Entry>, last_seq: u64) -> Result<()> {
        let mut w = self.writer.lock();
        w.check()?;
        self.drain(&mut w)?;
        let marker = Entry {
            key: snapshot_marker_key(),
            seq: last_seq,
            kind: EntryKind::Put,
            timestamp_ms: 0,
            expires_at_ms: None,
            mutation_id: MutationId::from_u128(0),
            value: last_seq.to_le_bytes().to_vec(),
        };
        for entry in entries.into_iter().chain(std::iter::once(marker)) {
            let payload = wal::encode_batch(std::slice::from_ref(&entry));
            if let Err(e) = w.wal.append(&payload) {
                let reason = format!("append to {} failed: {e}", w.wal.path().display());
                w.poisoned = Some(reason.clone());
                return Err(StorageError::WalFailure(reason));
            }
            let bytes = {
                let v = self.current();
                let mut table = v.mem.table.write();
                table.insert(entry);
                table.approx_bytes()
            };
            if bytes >= self.opts.memtable_size_bytes {
                self.rotate(&mut w)?;
                self.schedule_flush();
            }
        }
        if let Err(e) = w.wal.sync() {
            let reason = format!("sync of {} failed: {e}", w.wal.path().display());
            w.poisoned = Some(reason.clone());
            return Err(StorageError::WalFailure(reason));
        }
        w.next_seq = w.next_seq.max(last_seq + 1);
        self.last_seq.store(
            last_seq.max(self.last_seq.load(Ordering::Acquire)),
            Ordering::Release,
        );
        Ok(())
    }

    fn current(&self) -> Arc<Version> {
        Arc::clone(&self.version.read())
    }

    /// Newest version of `key` (including tombstones and expired values).
    fn get_entry(&self, v: &Version, key: &[u8]) -> Result<Option<Entry>> {
        if let Some(e) = v.mem.table.read().get(key) {
            return Ok(Some(e.clone()));
        }
        for slot in &v.imm {
            if let Some(e) = slot.table.read().get(key) {
                return Ok(Some(e.clone()));
            }
        }
        for table in &v.l0 {
            if key < table.meta.min_key.as_slice() || key > table.meta.max_key.as_slice() {
                continue;
            }
            if let Some(e) = table.get(key)? {
                return Ok(Some(e));
            }
        }
        let i = v.l1.partition_point(|t| t.meta.max_key.as_slice() < key);
        if let Some(table) = v.l1.get(i)
            && table.meta.min_key.as_slice() <= key
        {
            return table.get(key);
        }
        Ok(None)
    }

    /// (commit version, batch fingerprint) of a remembered mutation.
    fn lookup_mutation(&self, v: &Version, id: MutationId, now: u64) -> Result<Option<(u64, u64)>> {
        decode_mutation(self.get_entry(v, &mutation_key(id))?, id, now)
    }

    /// The writer's view of a key: unpublished group-commit writes first.
    fn writer_entry(&self, w: &WriterState, v: &Version, key: &[u8]) -> Result<Option<Entry>> {
        match w.overlay.get(key) {
            Some(e) => Ok(Some(e.clone())),
            None => self.get_entry(v, key),
        }
    }

    /// Makes every queued group-commit batch durable and visible. Caller
    /// holds `writer`.
    fn drain(&self, w: &mut WriterState) -> Result<()> {
        if w.unsynced.is_empty() {
            return Ok(());
        }
        if let Err(e) = w.wal.sync() {
            let reason = format!("sync of {} failed: {e}", w.wal.path().display());
            error!(%reason, "WAL failure; engine is now read-only");
            inc(&self.metrics.wal_failures);
            w.poisoned = Some(reason.clone());
            return Err(StorageError::WalFailure(reason));
        }
        inc(&self.metrics.wal_syncs);
        self.publish(w, u64::MAX);
        Ok(())
    }

    /// Moves durable group-commit batches (seq <= `upto`) into the memtable,
    /// in order. Caller holds `writer`.
    fn publish(&self, w: &mut WriterState, upto: u64) {
        if w.unsynced.is_empty() {
            return;
        }
        let v = self.current();
        let mut table = v.mem.table.write();
        while w.unsynced.front().is_some_and(|b| b.seq <= upto) {
            let Some(batch) = w.unsynced.pop_front() else {
                break;
            };
            for entry in batch.entries {
                if w.overlay
                    .get(&entry.key)
                    .is_some_and(|e| e.seq == entry.seq)
                {
                    w.overlay.remove(&entry.key);
                }
                table.insert(entry);
            }
            self.last_seq.store(batch.seq, Ordering::Release);
            inc(&self.metrics.write_batches);
            add(&self.metrics.write_ops, batch.ops as u64);
        }
    }

    /// Waits until batch `seq` is durable and visible, fsyncing the WAL for
    /// every batch queued so far unless another writer already did.
    fn commit(&self, seq: u64) -> Result<()> {
        let _turn = self.sync_lock.lock();
        if self.last_seq.load(Ordering::Acquire) >= seq {
            return Ok(());
        }
        let (target, file, path) = {
            let w = self.writer.lock();
            w.check()?;
            if self.last_seq.load(Ordering::Acquire) >= seq {
                return Ok(());
            }
            (w.next_seq - 1, w.wal.handle(), w.wal.path().to_path_buf())
        };
        // Other writers keep appending while this fsync runs.
        let synced = file.sync_data();
        let mut w = self.writer.lock();
        if let Err(e) = synced {
            let reason = format!("sync of {} failed: {e}", path.display());
            error!(%reason, "WAL failure; engine is now read-only");
            inc(&self.metrics.wal_failures);
            w.poisoned = Some(reason.clone());
            return Err(StorageError::WalFailure(reason));
        }
        inc(&self.metrics.wal_syncs);
        self.publish(&mut w, target);
        let mem_bytes = self.current().mem.table.read().approx_bytes();
        if mem_bytes >= self.opts.memtable_size_bytes {
            // Durable already; a failed rotation is retried later.
            match self.rotate(&mut w) {
                Ok(()) => self.schedule_flush(),
                Err(e) => warn!(error = %e, "memtable rotation failed; will retry"),
            }
        }
        drop(w);
        check_visible(self.last_seq.load(Ordering::Acquire), seq)
    }

    /// The newest entry of every key in the range, tombstones included.
    fn raw_entries(&self, start: Bound<Vec<u8>>, end: Bound<Vec<u8>>) -> MergeIter {
        let v = self.current();
        let mut sources: Vec<EntryIter> = Vec::new();
        for slot in std::iter::once(&v.mem).chain(&v.imm) {
            sources.push(Box::new(MemIter::new(
                Arc::clone(slot),
                start.clone(),
                end.clone(),
            )));
        }
        for table in v.l0.iter().chain(&v.l1) {
            if table_overlaps(&table.meta, &start, &end) {
                sources.push(Box::new(TableIter::new(
                    Arc::clone(table),
                    start.clone(),
                    end.clone(),
                    false,
                )));
            }
        }
        MergeIter::new(sources)
    }

    fn write(
        &self,
        batch: &WriteBatch,
        at_ms: Option<u64>,
        purge: Option<PurgeFilter<'_>>,
    ) -> Result<WriteOutcome> {
        batch.validate()?;
        let fingerprint = batch.fingerprint();
        let mut w = self.writer.lock();
        w.check()?;
        let now = at_ms.unwrap_or_else(|| self.clock.now_ms());
        let group = self.opts.sync == SyncMode::Always && purge.is_none();
        if !group {
            // The direct path below reads and writes the memtable itself.
            self.drain(&mut w)?;
        }
        let v = self.current();

        // Idempotent retry: return the original outcome.
        let id = batch.mutation_id();
        if let Some((version, previous)) =
            decode_mutation(self.writer_entry(&w, &v, &mutation_key(id))?, id, now)?
        {
            if previous != fingerprint {
                return Err(StorageError::MutationIdReused(id));
            }
            inc(&self.metrics.dedup_hits);
            // The original may still be waiting for its fsync.
            let pending = self.last_seq.load(Ordering::Acquire) < version;
            drop(w);
            if pending {
                self.commit(version)?;
            }
            return Ok(WriteOutcome {
                version,
                deduplicated: true,
            });
        }

        for op in batch.ops() {
            let Some(expected) = op.condition() else {
                continue;
            };
            let actual = self
                .writer_entry(&w, &v, op.key())?
                .filter(|e| e.is_live_at(now))
                .map(|e| e.seq);
            let holds = match expected {
                Condition::Absent => actual.is_none(),
                Condition::Version(want) => actual == Some(want),
            };
            if !holds {
                inc(&self.metrics.condition_failures);
                return Err(StorageError::ConditionFailed {
                    key: op.key().to_vec(),
                    expected,
                    actual,
                });
            }
        }

        // Back-pressure happens before the WAL append, so a failed inline
        // flush leaves the outcome definitely "not applied".
        self.make_room()?;

        let seq = w.next_seq;
        let mut entries = self.build_entries(batch, seq, now, fingerprint);
        if let Some(purge) = purge {
            let written: HashSet<&[u8]> = batch.ops().iter().map(Op::key).collect();
            let doomed: Vec<Vec<u8>> = self
                .raw_entries(
                    Bound::Included(vec![RESERVED_KEY_PREFIX + 1]),
                    Bound::Unbounded,
                )
                .filter_map(|e| match e {
                    Ok(e)
                        if e.kind == EntryKind::Put
                            && purge(&e.key)
                            && !written.contains(e.key.as_slice()) =>
                    {
                        Some(Ok(e.key))
                    }
                    Ok(_) => None,
                    Err(err) => Some(Err(err)),
                })
                .collect::<Result<_>>()?;
            entries.extend(doomed.into_iter().map(|key| Entry {
                key,
                seq,
                kind: EntryKind::Delete,
                timestamp_ms: now,
                expires_at_ms: None,
                mutation_id: batch.mutation_id(),
                value: Vec::new(),
            }));
        }
        let payload = wal::encode_batch(&entries);
        if group {
            if let Err(e) = w.wal.append_unsynced(&payload) {
                let reason = format!("append to {} failed: {e}", w.wal.path().display());
                error!(%reason, "WAL failure; engine is now read-only");
                inc(&self.metrics.wal_failures);
                w.poisoned = Some(reason.clone());
                return Err(StorageError::WalFailure(reason));
            }
            add(&self.metrics.wal_bytes, payload.len() as u64);
            w.next_seq += 1;
            for entry in &entries {
                w.overlay.insert(entry.key.clone(), entry.clone());
            }
            w.unsynced.push_back(UnsyncedBatch {
                seq,
                entries,
                ops: batch.ops().len(),
            });
            drop(w);
            self.commit(seq)?;
            return Ok(WriteOutcome {
                version: seq,
                deduplicated: false,
            });
        }
        match w.wal.append(&payload) {
            Ok(n) => {
                add(&self.metrics.wal_bytes, n as u64);
                if self.opts.sync == SyncMode::Always {
                    inc(&self.metrics.wal_syncs);
                }
            }
            Err(e) => {
                let reason = format!("append to {} failed: {e}", w.wal.path().display());
                error!(%reason, "WAL failure; engine is now read-only");
                inc(&self.metrics.wal_failures);
                w.poisoned = Some(reason.clone());
                return Err(StorageError::WalFailure(reason));
            }
        }
        w.next_seq += 1;

        let mem_bytes = {
            let v = self.current();
            let mut table = v.mem.table.write();
            for entry in entries {
                table.insert(entry);
            }
            table.approx_bytes()
        };
        self.last_seq.store(seq, Ordering::Release);
        inc(&self.metrics.write_batches);
        add(&self.metrics.write_ops, batch.ops().len() as u64);

        if mem_bytes >= self.opts.memtable_size_bytes {
            // The batch is already durable; a rotation failure only delays
            // the flush and is retried on the next write.
            match self.rotate(&mut w) {
                Ok(()) => self.schedule_flush(),
                Err(e) => warn!(error = %e, "memtable rotation failed; will retry"),
            }
        }
        Ok(WriteOutcome {
            version: seq,
            deduplicated: false,
        })
    }

    fn build_entries(
        &self,
        batch: &WriteBatch,
        seq: u64,
        now: u64,
        fingerprint: u64,
    ) -> Vec<Entry> {
        let id = batch.mutation_id();
        let mut out = Vec::with_capacity(batch.ops().len() + 1);
        for op in batch.ops() {
            out.push(match op {
                Op::Put {
                    key, value, ttl, ..
                } => Entry {
                    key: key.clone(),
                    seq,
                    kind: EntryKind::Put,
                    timestamp_ms: now,
                    expires_at_ms: ttl.map(|t| now.saturating_add(duration_ms(t))),
                    mutation_id: id,
                    value: value.clone(),
                },
                Op::Delete { key, .. } => Entry {
                    key: key.clone(),
                    seq,
                    kind: EntryKind::Delete,
                    timestamp_ms: now,
                    expires_at_ms: None,
                    mutation_id: id,
                    value: Vec::new(),
                },
            });
        }
        for (name, value) in batch.meta() {
            out.push(Entry {
                key: meta_key(name),
                seq,
                kind: if value.is_some() {
                    EntryKind::Put
                } else {
                    EntryKind::Delete
                },
                timestamp_ms: now,
                expires_at_ms: None,
                mutation_id: id,
                value: value.clone().unwrap_or_default(),
            });
        }
        // Dedupe record, committed atomically with the batch it describes.
        let mut record = Vec::with_capacity(16);
        record.extend_from_slice(&seq.to_le_bytes());
        record.extend_from_slice(&fingerprint.to_le_bytes());
        out.push(Entry {
            key: mutation_key(id),
            seq,
            kind: EntryKind::Put,
            timestamp_ms: now,
            expires_at_ms: Some(now.saturating_add(duration_ms(self.opts.mutation_retention))),
            mutation_id: id,
            value: record,
        });
        out
    }

    fn make_room(&self) -> Result<()> {
        let pending = self.current().imm.len();
        if pending >= self.opts.max_immutable_memtables {
            inc(&self.metrics.write_stalls);
            warn!(pending, "write stall: flushing immutable memtables inline");
            self.flush_immutables()?;
        }
        Ok(())
    }

    /// Freezes the active memtable and starts a new WAL. Caller holds `writer`.
    fn rotate(&self, w: &mut WriterState) -> Result<()> {
        // The old WAL must be complete on disk before writes move on, so
        // recovery can treat a torn tail in any older WAL as corruption.
        if let Err(e) = w.wal.sync() {
            let reason = format!("sync of {} failed: {e}", w.wal.path().display());
            error!(%reason, "WAL failure; engine is now read-only");
            inc(&self.metrics.wal_failures);
            w.poisoned = Some(reason.clone());
            return Err(StorageError::WalFailure(reason));
        }
        // Everything in the old WAL is durable now; publish it into the
        // memtable that this WAL backs before freezing it.
        self.publish(w, u64::MAX);
        let id = self.next_file_id.fetch_add(1, Ordering::SeqCst);
        w.wal = WalWriter::create(&self.dir, id, self.opts.sync == SyncMode::Always)?;
        let mut current = self.version.write();
        let mut next = (**current).clone();
        next.imm.insert(0, Arc::clone(&next.mem));
        next.mem = Arc::new(MemSlot::new(Memtable::default(), vec![id]));
        *current = Arc::new(next);
        debug!(wal = id, "memtable rotated");
        Ok(())
    }

    fn schedule_flush(&self) {
        if let Some(tx) = &self.bg_tx {
            // A full queue already holds a pending flush request.
            let _ = tx.try_send(Task::Flush);
        }
    }

    fn open_table(&self, meta: TableMeta) -> Result<Arc<SsTable>> {
        Ok(Arc::new(SsTable::open(
            &self.dir,
            meta,
            Arc::clone(&self.cache),
            Arc::clone(&self.metrics),
        )?))
    }

    /// Flushes every immutable memtable, oldest first, then compacts if L0
    /// has grown past the trigger.
    fn flush_immutables(&self) -> Result<()> {
        let mut manifest = self.maintenance.lock();
        while let Some(slot) = self.current().imm.last().cloned() {
            self.flush_one(&mut manifest, &slot)?;
        }
        if self.current().l0.len() >= self.opts.l0_compaction_trigger {
            self.compact_locked(&mut manifest)?;
        }
        Ok(())
    }

    fn flush_one(&self, manifest: &mut Manifest, slot: &Arc<MemSlot>) -> Result<()> {
        let (table, max_seq) = {
            let mem = slot.table.read();
            let table = if mem.is_empty() {
                None
            } else {
                let id = self.next_file_id.fetch_add(1, Ordering::SeqCst);
                let mut builder = TableBuilder::create(
                    &self.dir,
                    id,
                    0,
                    self.opts.block_size_bytes,
                    self.opts.bloom_bits_per_key,
                )?;
                for entry in mem.iter() {
                    builder.add(entry)?;
                }
                Some(self.open_table(builder.finish()?)?)
            };
            (table, mem.max_seq())
        };

        let mut next = manifest.clone();
        if let Some(t) = &table {
            next.tables.push(t.meta.clone());
        }
        next.flushed_seq = next.flushed_seq.max(max_seq);
        next.next_file_id = self.next_file_id.load(Ordering::SeqCst);
        if let Err(e) = manifest::store(&self.dir, &next) {
            if let Some(t) = &table {
                t.mark_obsolete();
            }
            return Err(e);
        }
        *manifest = next;

        let bytes = table.as_ref().map_or(0, |t| t.meta.size);
        {
            let mut current = self.version.write();
            let mut v = (**current).clone();
            v.imm.retain(|s| !Arc::ptr_eq(s, slot));
            if let Some(t) = table {
                v.l0.insert(0, t);
            }
            *current = Arc::new(v);
        }
        // Every batch in these WALs is now in an SSTable. A failed delete is
        // harmless: recovery skips batches at or below `flushed_seq`.
        for &id in &slot.wal_ids {
            let path = fsutil::wal_path(&self.dir, id);
            if let Err(e) = fs::remove_file(&path)
                && e.kind() != io::ErrorKind::NotFound
            {
                warn!(path = %path.display(), error = %e, "could not delete flushed WAL");
            }
        }
        inc(&self.metrics.flushes);
        add(&self.metrics.flush_bytes, bytes);
        info!(bytes, flushed_seq = max_seq, "memtable flushed to L0");
        Ok(())
    }

    fn compact_locked(&self, manifest: &mut Manifest) -> Result<CompactionSummary> {
        let v = self.current();
        let inputs: Vec<Arc<SsTable>> = v.l0.iter().chain(&v.l1).cloned().collect();
        if inputs.is_empty() {
            return Ok(CompactionSummary::default());
        }
        let mut summary = CompactionSummary {
            input_tables: inputs.len(),
            bytes_in: inputs.iter().map(|t| t.meta.size).sum(),
            ..CompactionSummary::default()
        };
        let mut outputs = Vec::new();
        if let Err(e) = self.merge_tables(&inputs, &mut outputs, &mut summary) {
            outputs.iter().for_each(|t| t.mark_obsolete());
            return Err(e);
        }

        let input_ids: HashSet<u64> = inputs.iter().map(|t| t.meta.id).collect();
        let mut next = manifest.clone();
        next.tables.retain(|t| !input_ids.contains(&t.id));
        next.tables.extend(outputs.iter().map(|t| t.meta.clone()));
        next.next_file_id = self.next_file_id.load(Ordering::SeqCst);
        if let Err(e) = manifest::store(&self.dir, &next) {
            outputs.iter().for_each(|t| t.mark_obsolete());
            return Err(e);
        }
        *manifest = next;

        summary.output_tables = outputs.len();
        summary.bytes_out = outputs.iter().map(|t| t.meta.size).sum();
        {
            let mut current = self.version.write();
            let mut v = (**current).clone();
            v.l0.retain(|t| !input_ids.contains(&t.meta.id));
            v.l1 = outputs;
            *current = Arc::new(v);
        }
        // Files are deleted when the last in-flight reader releases them.
        inputs.iter().for_each(|t| t.mark_obsolete());

        inc(&self.metrics.compactions);
        add(&self.metrics.compaction_bytes_in, summary.bytes_in);
        add(&self.metrics.compaction_bytes_out, summary.bytes_out);
        add(&self.metrics.tombstones_purged, summary.tombstones_purged);
        info!(
            inputs = summary.input_tables,
            outputs = summary.output_tables,
            bytes_in = summary.bytes_in,
            bytes_out = summary.bytes_out,
            tombstones_purged = summary.tombstones_purged,
            "compaction finished"
        );
        Ok(summary)
    }

    fn merge_tables(
        &self,
        inputs: &[Arc<SsTable>],
        outputs: &mut Vec<Arc<SsTable>>,
        summary: &mut CompactionSummary,
    ) -> Result<()> {
        let now = self.clock.now_ms();
        let retention = duration_ms(self.opts.tombstone_retention);
        let sources: Vec<EntryIter> = inputs
            .iter()
            .map(|t| {
                Box::new(TableIter::new(
                    Arc::clone(t),
                    Bound::Unbounded,
                    Bound::Unbounded,
                    false,
                )) as EntryIter
            })
            .collect();
        let mut builder: Option<TableBuilder> = None;
        for item in MergeIter::new(sources) {
            let Some(entry) = compaction_filter(item?, now, retention, summary) else {
                continue;
            };
            if builder.is_none() {
                let id = self.next_file_id.fetch_add(1, Ordering::SeqCst);
                builder = Some(TableBuilder::create(
                    &self.dir,
                    id,
                    1,
                    self.opts.block_size_bytes,
                    self.opts.bloom_bits_per_key,
                )?);
            }
            let full = match builder.as_mut() {
                Some(b) => {
                    b.add(&entry)?;
                    b.estimated_size() >= self.opts.target_table_size_bytes
                }
                None => false,
            };
            if full && let Some(b) = builder.take() {
                outputs.push(self.open_table(b.finish()?)?);
            }
        }
        if let Some(b) = builder.take() {
            outputs.push(self.open_table(b.finish()?)?);
        }
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn prefix_successor_cases() {
        assert_eq!(prefix_successor(b"abc"), Some(b"abd".to_vec()));
        assert_eq!(prefix_successor(b"a\xff"), Some(b"b".to_vec()));
        assert_eq!(prefix_successor(b"\xff\xff"), None);
        assert_eq!(prefix_successor(b""), None);
    }

    #[test]
    fn options_validation() {
        assert!(Options::default().validate().is_ok());
        let bad = Options {
            block_size_bytes: 10,
            ..Options::default()
        };
        assert!(bad.validate().is_err());
    }
}
