//! Replication groups: data replication through Raft.
//!
//! Partitions that share a replica set share one Raft group. With 3 nodes
//! and replication factor 3 that is a single group; in general there are at
//! most as many groups as distinct replica sets in the partition map. Each
//! group owns a storage [`Engine`] in `<data_dir>/groups/<group-id>/` and
//! applies committed [`DataCommand`]s to it in log order. Every replica
//! therefore holds identical data, versions and mutation-ID records:
//!
//! * commands carry the leader's timestamp and are applied with
//!   [`Engine::write_at`], so TTLs and conditions evaluate identically;
//! * the engine serves only its group, so its sequence numbers (the
//!   versions clients see and use for compare-and-set) are the same on
//!   every replica.
//!
//! The applied index is persisted (`<group>/applied`), so a restart does not
//! re-apply old entries. The file is written after the engine write, so a
//! crash can at worst re-apply the last few entries, which mutation-ID
//! deduplication turns into no-ops.
//!
//! A proposal resolves to [`Applied::Write`] when its entry commits,
//! [`Applied::Lost`] when another entry took its log index (so it was not
//! applied), or never, if the caller's timeout fires first (outcome unknown).
//!
//! # Snapshots
//!
//! Once the Raft log holds more than `snapshot_threshold` entries, the group
//! flushes its engine (so the applied state no longer depends on the log)
//! and compacts the log up to the applied index. A follower that needs
//! compacted entries receives the leader's whole engine state instead
//! ([`ReplicaGroup::snapshot_payload`]); it builds a fresh engine from it in
//! `storage-<index>/`, durably points `ACTIVE_STORAGE` at the new directory, swaps
//! the engine in, and only then lets Raft accept the snapshot. A crash at
//! any point leaves either the old engine with the old log, or the new
//! engine (whose index, recorded in `ACTIVE_STORAGE`, is never re-applied).

use std::collections::{BTreeMap, BTreeSet};
use std::fs;
use std::io::Write;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex, PoisonError, RwLock};
use std::time::Duration;

use anyhow::Context;
use celeris_cluster::raft::{
    Envelope, LogIndex, NotLeader, Raft, RaftConfig, RaftMessage, Role, Term,
};
use celeris_core::MutationId;
use celeris_core::partition::NodeId;
use celeris_storage::{Condition, Engine, Op, Options, StorageError, WriteBatch, WriteOutcome};
use serde::{Deserialize, Serialize};
use tokio::sync::oneshot;
use tracing::{error, info, warn};

use crate::raft_log::RaftLogStore;

const APPLIED_FILE: &str = "applied";
/// Names the live storage directory and the log index its state covers.
const STORAGE_POINTER: &str = "ACTIVE_STORAGE";
const INITIAL_STORAGE: &str = "storage";
/// A snapshot transfer to a peer is not restarted within this window.
const SNAPSHOT_RESEND_MS: u64 = 10_000;

/// A replicated data operation.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "op", rename_all = "snake_case")]
pub enum WireOp {
    Put {
        key: String,
        /// JSON document, as text.
        value: String,
        ttl_ms: Option<u64>,
        if_version: Option<u64>,
        #[serde(default)]
        if_absent: bool,
    },
    Delete {
        key: String,
        if_version: Option<u64>,
    },
}

impl WireOp {
    pub fn key(&self) -> &str {
        match self {
            WireOp::Put { key, .. } | WireOp::Delete { key, .. } => key,
        }
    }

    fn into_unconditional_op(self) -> Op {
        match self.into_op() {
            Op::Put {
                key, value, ttl, ..
            } => Op::Put {
                key,
                value,
                ttl,
                condition: None,
            },
            Op::Delete { key, .. } => Op::Delete {
                key,
                condition: None,
            },
        }
    }

    /// Whether the operation carries a compare-and-set condition.
    pub fn is_conditional(&self) -> bool {
        match self {
            WireOp::Put {
                if_version,
                if_absent,
                ..
            } => if_version.is_some() || *if_absent,
            WireOp::Delete { if_version, .. } => if_version.is_some(),
        }
    }

    fn into_op(self) -> Op {
        match self {
            WireOp::Put {
                key,
                value,
                ttl_ms,
                if_version,
                if_absent,
            } => Op::Put {
                key: key.into_bytes(),
                value: value.into_bytes(),
                ttl: ttl_ms.map(Duration::from_millis),
                condition: if_version
                    .map(Condition::Version)
                    .or(if_absent.then_some(Condition::Absent)),
            },
            WireOp::Delete { key, if_version } => Op::Delete {
                key: key.into_bytes(),
                condition: if_version.map(Condition::Version),
            },
        }
    }
}

/// Entries of a replication group's log.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "type", rename_all = "snake_case")]
pub enum DataCommand {
    Write {
        mutation_id: String,
        ops: Vec<WireOp>,
        /// Leader wall-clock time; every replica applies at this time.
        now_ms: u64,
    },
    /// Linearizable-read barrier: once applied, every write committed before
    /// the read began is visible locally.
    Barrier,
    /// Migration (D-020): from here on, writes to these partitions are
    /// rejected, so their data is frozen for export.
    Fence {
        partitions: Vec<u16>,
        mutation_id: String,
        now_ms: u64,
    },
    /// Migration: the partitions now live elsewhere. Their data is deleted
    /// and reads are refused.
    Release {
        partitions: Vec<u16>,
        mutation_id: String,
        now_ms: u64,
    },
    /// An `available`-mode write accepted on some replica without
    /// coordination, now ordered by the log. Each key keeps whichever
    /// version is newest by (`timestamp_ms`, mutation ID); a losing write
    /// is recorded as a [`Conflict`] instead of being dropped (D-023).
    AvailableWrite {
        mutation_id: String,
        ops: Vec<WireOp>,
        /// When the write was accepted (hybrid: never behind the version
        /// the accepting replica held for these keys).
        timestamp_ms: u64,
        origin: String,
        /// Per op, the version of its key the accepting node had seen
        /// (`None`: none, or unknown). Overwriting any other version means
        /// the writes were concurrent, and the overwritten one is recorded.
        #[serde(default)]
        observed: Vec<Option<Observed>>,
    },
    /// Anti-entropy (D-023): every replica hashes its data when this entry
    /// applies, so all digests describe the same log position and can be
    /// compared.
    Digest { id: String, now_ms: u64 },
    /// One step of secondary-index maintenance (D-031): every replica
    /// builds or drops the same keys at the same log position, committing
    /// one engine version.
    IndexStep { now_ms: u64, limit: u32 },
    /// Removes the recorded conflicts of a key.
    ClearConflicts {
        key: String,
        mutation_id: String,
        now_ms: u64,
    },
    /// Migration: copies partition data in. The first chunk (`clear`)
    /// deletes whatever the group held for these partitions and makes them
    /// writable again.
    Import {
        partitions: Vec<u16>,
        clear: bool,
        entries: Vec<ImportEntry>,
        mutation_id: String,
        now_ms: u64,
    },
}

/// A version of a key, as seen by the node that accepted a write.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct Observed {
    pub timestamp_ms: u64,
    pub mutation_id: String,
}

/// A conflict (D-023): two writes to a key were concurrent (neither saw the
/// other) and last-writer-wins kept only one. The losing side is recorded
/// here until cleared, so nothing is lost silently.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct Conflict {
    pub key: String,
    /// The losing value (`None`: the loser was a delete).
    pub value: Option<String>,
    pub timestamp_ms: u64,
    pub mutation_id: String,
    /// Node that accepted the losing write, if known.
    pub origin: Option<String>,
    /// The winner's version, if it was already stored when resolved.
    pub winner_version: Option<u64>,
    pub winner_timestamp_ms: u64,
    pub winner_mutation_id: String,
}

const CONFLICT_META_PREFIX: &str = "conflict/";

fn conflict_meta_name(key: &str, mutation_id: &str) -> String {
    // Key first, so all conflicts of a key share a prefix. Keys cannot
    // contain NUL (it is reserved at their start only, but a separator
    // that never appears in a UUID is enough here).
    format!("{CONFLICT_META_PREFIX}{key}\u{0}{mutation_id}")
}

/// One live record copied between groups by a migration.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct ImportEntry {
    pub key: String,
    /// JSON document, as text.
    pub value: String,
    /// Remaining time to live at export, if the record expires.
    pub ttl_ms: Option<u64>,
}

/// A partition's state in a group other than the default "serving".
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum PartitionState {
    /// Being exported: reads are served, writes are refused.
    Fenced,
    /// Moved away: neither reads nor writes are served here.
    Released,
}

const PARTITION_META_PREFIX: &str = "partition/";

fn partition_meta_name(p: u16) -> String {
    format!("{PARTITION_META_PREFIX}{p:04}")
}

fn load_partition_states(engine: &Engine) -> anyhow::Result<BTreeMap<u16, PartitionState>> {
    let mut states = BTreeMap::new();
    for (name, value) in engine.meta(PARTITION_META_PREFIX.as_bytes())? {
        let p = std::str::from_utf8(&name[PARTITION_META_PREFIX.len()..])
            .ok()
            .and_then(|s| s.parse::<u16>().ok())
            .context("malformed partition state record")?;
        let state = match value.as_slice() {
            b"fenced" => PartitionState::Fenced,
            b"released" => PartitionState::Released,
            other => anyhow::bail!(
                "unknown partition state `{}`",
                String::from_utf8_lossy(other)
            ),
        };
        states.insert(p, state);
    }
    Ok(states)
}

/// Applies an `available` write with per-key last-writer-wins. A key keeps
/// its stored version if that is newer by (timestamp, mutation ID); the
/// losing write is then recorded as a conflict in the same commit.
/// Deterministic: it reads only replicated state and the write's own
/// timestamp.
fn resolve_available(
    engine: &Engine,
    mutation_id: &str,
    ops: Vec<WireOp>,
    observed: &[Option<Observed>],
    timestamp_ms: u64,
    origin: &str,
    events: Option<&crate::events::EventBus>,
) -> Result<WriteOutcome, StorageError> {
    let id = mutation_id
        .parse::<MutationId>()
        .unwrap_or_else(|_| MutationId::from_u128(0));
    // A retry of a write that was already resolved returns its outcome
    // instead of being resolved again against newer state.
    if let Some(version) = engine.mutation_status_at(id, timestamp_ms)? {
        return Ok(WriteOutcome {
            version,
            deduplicated: true,
        });
    }
    let encode = |c: &Conflict| {
        serde_json::to_vec(c).map_err(|e| StorageError::Internal(format!("encoding conflict: {e}")))
    };
    let mut batch = WriteBatch::new(id);
    for (i, op) in ops.into_iter().enumerate() {
        let (key, value) = match &op {
            WireOp::Put { key, value, .. } => (key.clone(), Some(value.clone())),
            WireOp::Delete { key, .. } => (key.clone(), None),
        };
        let Some(stored) = engine.latest(key.as_bytes())? else {
            batch = batch.push(op.into_unconditional_op());
            continue;
        };
        if (stored.timestamp_ms, stored.mutation_id) >= (timestamp_ms, id) {
            // The stored version is newer: this write loses.
            let conflict = Conflict {
                key: key.clone(),
                value,
                timestamp_ms,
                mutation_id: mutation_id.to_owned(),
                origin: Some(origin.to_owned()),
                winner_version: Some(stored.version),
                winner_timestamp_ms: stored.timestamp_ms,
                winner_mutation_id: stored.mutation_id.to_string(),
            };
            batch = batch.set_meta(
                conflict_meta_name(&key, mutation_id),
                Some(encode(&conflict)?),
            );
            continue;
        }
        // This write wins. If its author never saw the stored version, the
        // two were concurrent: keep the overwritten one as a conflict.
        let seen = observed.get(i).cloned().flatten().is_some_and(|o| {
            o.timestamp_ms == stored.timestamp_ms && o.mutation_id == stored.mutation_id.to_string()
        });
        if !seen && !stored.deleted {
            let previous = engine.get_at(key.as_bytes(), timestamp_ms)?;
            if let Some(previous) = previous {
                let loser_id = stored.mutation_id.to_string();
                let conflict = Conflict {
                    key: key.clone(),
                    value: Some(String::from_utf8_lossy(&previous.value).into_owned()),
                    timestamp_ms: stored.timestamp_ms,
                    mutation_id: loser_id.clone(),
                    origin: None,
                    winner_version: None,
                    winner_timestamp_ms: timestamp_ms,
                    winner_mutation_id: mutation_id.to_owned(),
                };
                batch = batch.set_meta(
                    conflict_meta_name(&key, &loser_id),
                    Some(encode(&conflict)?),
                );
            }
        }
        // Conditions mean nothing under last-writer-wins; they are refused
        // when the write is accepted, and ignored here.
        batch = batch.push(op.into_unconditional_op());
    }
    let watched = events
        .filter(|bus| bus.receiver_count() > 0)
        .map(|bus| (bus, batch.clone()));
    let outcome = engine.write_at(batch, timestamp_ms)?;
    if let Some((bus, batch)) = watched {
        crate::events::publish_batch(bus, &batch, &outcome);
    }
    Ok(outcome)
}
/// Digests kept per group for comparison.
const MAX_DIGESTS: usize = 8;
/// Records expiring this close to the digest time are left out, so
/// replicas whose clocks differ slightly (and that compacted expired data
/// at slightly different times) still agree.
const DIGEST_EXPIRY_GUARD_MS: u64 = 60_000;

/// Per-partition digest of a replica's data: the leaves of a two-level
/// Merkle tree whose root is the hash of all leaves. Hashes key, value and
/// version of every record that is live at `now_ms`, in key order.
pub fn digest_of(engine: &Engine, now_ms: u64) -> anyhow::Result<BTreeMap<u16, u64>> {
    use xxhash_rust::xxh3::Xxh3;
    let mut hashers: BTreeMap<u16, Xxh3> = BTreeMap::new();
    let records = engine.scan(
        std::ops::Bound::Unbounded,
        std::ops::Bound::Unbounded,
        usize::MAX,
    )?;
    for r in records {
        if r.expires_at_ms
            .is_some_and(|at| at <= now_ms.saturating_add(DIGEST_EXPIRY_GUARD_MS))
        {
            continue;
        }
        let h = hashers.entry(partition_of(&r.key)).or_default();
        h.update(&(r.key.len() as u64).to_le_bytes());
        h.update(&r.key);
        h.update(&(r.value.len() as u64).to_le_bytes());
        h.update(&r.value);
        h.update(&r.version.to_le_bytes());
    }
    Ok(hashers.into_iter().map(|(p, h)| (p, h.digest())).collect())
}

/// Root of a digest: one hash over every partition leaf.
pub fn digest_root(digest: &BTreeMap<u16, u64>) -> u64 {
    let mut h = xxhash_rust::xxh3::Xxh3::new();
    for (p, d) in digest {
        h.update(&p.to_le_bytes());
        h.update(&d.to_le_bytes());
    }
    h.digest()
}

fn rand_u32() -> u32 {
    uuid::Uuid::new_v4().as_u128() as u32
}

fn partition_of(key: &[u8]) -> u16 {
    celeris_core::partition::partition_for(key).get()
}

impl DataCommand {
    /// Upper estimate of the command's JSON encoding (escaping can double a
    /// string), used to cap Raft append messages.
    fn approx_size(&self) -> usize {
        match self {
            DataCommand::Write { ops, .. } => {
                128 + ops
                    .iter()
                    .map(|op| match op {
                        WireOp::Put { key, value, .. } => 96 + 2 * (key.len() + value.len()),
                        WireOp::Delete { key, .. } => 64 + 2 * key.len(),
                    })
                    .sum::<usize>()
            }
            DataCommand::Barrier => 32,
            DataCommand::AvailableWrite { ops, .. } => {
                160 + ops
                    .iter()
                    .map(|op| match op {
                        WireOp::Put { key, value, .. } => 96 + 2 * (key.len() + value.len()),
                        WireOp::Delete { key, .. } => 64 + 2 * key.len(),
                    })
                    .sum::<usize>()
            }
            DataCommand::ClearConflicts { key, .. } => 128 + 2 * key.len(),
            DataCommand::Digest { id, .. } => 64 + id.len(),
            DataCommand::IndexStep { .. } => 48,
            DataCommand::Fence { partitions, .. } | DataCommand::Release { partitions, .. } => {
                128 + 8 * partitions.len()
            }
            DataCommand::Import {
                partitions,
                entries,
                ..
            } => {
                128 + 8 * partitions.len()
                    + entries
                        .iter()
                        .map(|e| 96 + 2 * (e.key.len() + e.value.len()))
                        .sum::<usize>()
            }
        }
    }
}

/// What became of a proposal.
#[derive(Debug)]
pub enum Applied {
    Write(Result<WriteOutcome, StorageError>),
    Barrier,
    /// Another entry took this log index: the proposal was not applied.
    Lost,
    /// A write touched a partition that is moving away (fenced or
    /// released here): not applied, retry after the move.
    Moving(u16),
    /// A migration command (fence, release, import) was applied.
    Migration(Result<(), StorageError>),
}

/// Directory-safe group identity: the sorted member IDs joined by `+`.
pub fn group_id(members: &[&NodeId]) -> String {
    let mut ids: Vec<&str> = members.iter().map(|m| m.as_str()).collect();
    ids.sort_unstable();
    ids.join("+")
}

#[derive(Debug)]
struct GroupInner {
    raft: Raft<DataCommand>,
    store: RaftLogStore<DataCommand>,
    waiters: BTreeMap<LogIndex, (Term, oneshot::Sender<Applied>)>,
    applied_index: LogIndex,
    applied_path: PathBuf,
    /// Partitions not in the default serving state; mirrors the engine's
    /// partition metadata.
    partitions: BTreeMap<u16, PartitionState>,
    /// Set by anti-entropy: accept the leader's next snapshot even though
    /// this replica is caught up.
    repair_requested: bool,
    /// Data digests computed when `Digest` entries applied, newest last.
    digests: Vec<(String, LogIndex, BTreeMap<u16, u64>)>,
    /// Set when the group can no longer guarantee durability or
    /// determinism on this node (persist or apply failure).
    failed: Option<String>,
}

#[derive(Debug)]
pub struct ReplicaGroup {
    id: String,
    members: Vec<NodeId>,
    dir: PathBuf,
    engine_options: Options,
    snapshot_threshold: u64,
    /// Replaced wholesale when a snapshot is installed. Only the apply path
    /// (under `inner`) writes to it.
    engine: RwLock<Arc<Engine>>,
    inner: Mutex<GroupInner>,
    /// Peers with a snapshot transfer in flight, and when it started.
    sending: Mutex<BTreeMap<NodeId, u64>>,
    /// Where applied changes are published for watchers.
    events: std::sync::OnceLock<crate::events::EventBus>,
}

/// A group's complete data state at one log index, for a lagging replica.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SnapshotPayload {
    /// The sending leader's current term.
    pub term: Term,
    pub last_included_index: LogIndex,
    pub last_included_term: Term,
    /// [`Engine::snapshot`] bytes (checksummed and versioned by the engine).
    pub data: Vec<u8>,
}

fn write_durably(path: &Path, contents: &str) -> std::io::Result<()> {
    let tmp = path.with_extension("tmp");
    let mut f = fs::File::create(&tmp)?;
    f.write_all(contents.as_bytes())?;
    f.sync_all()?;
    drop(f);
    fs::rename(&tmp, path)?;
    #[cfg(unix)]
    if let Some(parent) = path.parent() {
        fs::File::open(parent)?.sync_all()?;
    }
    Ok(())
}

/// Reads `ACTIVE_STORAGE`: (directory name, log index the directory's state covers).
fn read_storage_pointer(dir: &Path) -> anyhow::Result<(String, LogIndex)> {
    let path = dir.join(STORAGE_POINTER);
    match fs::read_to_string(&path) {
        Ok(text) => {
            let name = text.trim();
            let index = name
                .strip_prefix("storage-")
                .and_then(|n| n.split('-').next())
                .and_then(|n| n.parse::<LogIndex>().ok())
                .with_context(|| format!("{} names no snapshot directory", path.display()))?;
            Ok((name.to_owned(), index))
        }
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok((INITIAL_STORAGE.into(), 0)),
        Err(e) => Err(e).with_context(|| format!("reading {}", path.display())),
    }
}

/// Removes storage directories other than `keep`: engines replaced by a
/// snapshot, or half-built ones from an interrupted install. Best effort.
fn remove_stale_storage(dir: &Path, keep: &str) {
    let Ok(entries) = fs::read_dir(dir) else {
        return;
    };
    for entry in entries.flatten() {
        let name = entry.file_name().to_string_lossy().into_owned();
        let is_storage = name == INITIAL_STORAGE || name.starts_with("storage-");
        if is_storage
            && name != keep
            && entry.path().is_dir()
            && let Err(e) = fs::remove_dir_all(entry.path())
        {
            warn!(dir = %entry.path().display(), error = %e, "could not remove stale storage");
        }
    }
}

/// Result of [`ReplicaGroup::propose`].
#[derive(Debug)]
pub enum Proposed {
    Accepted {
        index: LogIndex,
        done: oneshot::Receiver<Applied>,
        out: Vec<Envelope<DataCommand>>,
    },
    /// Only the leader accepts proposals; the last known leader, if any.
    NotLeader(Option<NodeId>),
}

impl ReplicaGroup {
    /// Opens (recovering if needed) the group's storage and Raft log.
    /// Blocking.
    pub fn open(
        data_dir: &Path,
        me: &NodeId,
        members: Vec<NodeId>,
        raft_config: RaftConfig,
        engine_options: Options,
        snapshot_threshold: u64,
        seed: u64,
    ) -> anyhow::Result<ReplicaGroup> {
        let refs: Vec<&NodeId> = members.iter().collect();
        let id = group_id(&refs);
        let dir = data_dir.join("groups").join(&id);
        fs::create_dir_all(&dir).with_context(|| format!("creating {}", dir.display()))?;
        let (storage, installed_index) = read_storage_pointer(&dir)?;
        remove_stale_storage(&dir, &storage);
        let engine = Engine::open(dir.join(&storage), engine_options.clone())
            .with_context(|| format!("opening storage of group {id}"))?;
        let partitions = load_partition_states(&engine)?;
        let (store, state) = RaftLogStore::open(&dir.join("raft"))?;
        let applied_path = dir.join(APPLIED_FILE);
        let recorded: LogIndex = match fs::read_to_string(&applied_path) {
            Ok(text) => text
                .trim()
                .parse()
                .with_context(|| format!("{} is not a number", applied_path.display()))?,
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => 0,
            Err(e) => return Err(e).context("reading applied index"),
        };
        // The engine holds at least the installed snapshot and, because the
        // log is compacted only after a flush, everything up to the log's
        // snapshot point.
        let applied_index = recorded.max(installed_index).max(state.snapshot_index);
        info!(group = %id, term = state.term, log_entries = state.log.len(), snapshot_index = state.snapshot_index, applied_index, %storage, "replication group opened");
        let raft = Raft::restore(me.clone(), members.clone(), raft_config, seed, 0, state)
            .with_entry_size(DataCommand::approx_size);
        Ok(ReplicaGroup {
            id,
            members,
            dir,
            engine_options,
            snapshot_threshold: snapshot_threshold.max(1),
            engine: RwLock::new(Arc::new(engine)),
            inner: Mutex::new(GroupInner {
                raft,
                store,
                waiters: BTreeMap::new(),
                applied_index,
                applied_path,
                partitions,
                repair_requested: false,
                digests: Vec::new(),
                failed: None,
            }),
            sending: Mutex::new(BTreeMap::new()),
            events: std::sync::OnceLock::new(),
        })
    }

    pub fn id(&self) -> &str {
        &self.id
    }

    pub fn members(&self) -> &[NodeId] {
        &self.members
    }

    /// The engine currently holding the group's data. A snapshot install
    /// replaces it; a caller keeps reading the engine it got (a consistent,
    /// slightly older state).
    pub fn engine(&self) -> Arc<Engine> {
        Arc::clone(&self.engine.read().unwrap_or_else(PoisonError::into_inner))
    }

    fn lock(&self) -> std::sync::MutexGuard<'_, GroupInner> {
        self.inner.lock().unwrap_or_else(PoisonError::into_inner)
    }

    /// (role, term, leader, commit index, applied index).
    pub fn status(&self) -> (Role, Term, Option<NodeId>, LogIndex, LogIndex) {
        let g = self.lock();
        (
            g.raft.role(),
            g.raft.term(),
            g.raft.leader().cloned(),
            g.raft.commit_index(),
            g.applied_index,
        )
    }

    pub fn leader(&self) -> Option<NodeId> {
        self.lock().raft.leader().cloned()
    }

    pub fn applied_index(&self) -> LogIndex {
        self.lock().applied_index
    }

    pub fn failure(&self) -> Option<String> {
        self.lock().failed.clone()
    }

    /// Runs `f` on the group's Raft node, persists, applies newly committed
    /// entries and resolves waiting proposals. Returns the messages to send,
    /// or an error (in which case nothing may be sent). Blocking.
    pub fn drive<R>(
        &self,
        now_ms: u64,
        f: impl FnOnce(&mut Raft<DataCommand>, u64) -> (R, Vec<Envelope<DataCommand>>),
    ) -> anyhow::Result<(R, Vec<Envelope<DataCommand>>)> {
        let mut g = self.lock();
        self.drive_locked(&mut g, now_ms, f)
    }

    fn drive_locked<R>(
        &self,
        g: &mut GroupInner,
        now_ms: u64,
        f: impl FnOnce(&mut Raft<DataCommand>, u64) -> (R, Vec<Envelope<DataCommand>>),
    ) -> anyhow::Result<(R, Vec<Envelope<DataCommand>>)> {
        if let Some(reason) = &g.failed {
            anyhow::bail!("group {} is failed: {reason}", self.id);
        }
        let (result, out) = f(&mut g.raft, now_ms);
        self.persist_raft(g)?;
        let before = g.applied_index;
        let engine = self.engine();
        for entry in g.raft.take_committed() {
            if entry.index <= g.applied_index {
                continue; // applied before a restart
            }
            let applied = match entry.command {
                None | Some(DataCommand::Barrier) => Applied::Barrier,
                Some(command) => self.apply_command(g, &engine, command),
            };
            g.applied_index = entry.index;
            if let Some((term, tx)) = g.waiters.remove(&entry.index) {
                let _ = tx.send(if term == entry.term {
                    applied
                } else {
                    Applied::Lost
                });
            }
        }
        if g.applied_index > before {
            self.record_applied(g);
            self.maybe_compact(g, &engine)?;
        }
        Ok((result, out))
    }

    /// Applies a write or migration command. Everything here depends only
    /// on replicated state, so every replica reaches the same result.
    fn apply_command(&self, g: &mut GroupInner, engine: &Engine, command: DataCommand) -> Applied {
        let id_of = |s: &str| {
            s.parse::<MutationId>()
                .unwrap_or_else(|_| MutationId::from_u128(0))
        };
        let result: Result<(), StorageError> = match command {
            DataCommand::Barrier => return Applied::Barrier,
            DataCommand::Write {
                mutation_id,
                ops,
                now_ms,
            } => {
                if let Some(p) = ops
                    .iter()
                    .map(|op| partition_of(op.key().as_bytes()))
                    .find(|p| g.partitions.contains_key(p))
                {
                    return Applied::Moving(p);
                }
                let batch = ops
                    .into_iter()
                    .fold(WriteBatch::new(id_of(&mutation_id)), |b, op| {
                        b.push(op.into_op())
                    });
                let watched = self
                    .events
                    .get()
                    .filter(|bus| bus.receiver_count() > 0)
                    .map(|bus| (bus, batch.clone()));
                let result = engine.write_at(batch, now_ms);
                self.check_apply(g, result.as_ref().err());
                if let (Some((bus, batch)), Ok(outcome)) = (watched, &result) {
                    crate::events::publish_batch(bus, &batch, outcome);
                }
                return Applied::Write(result);
            }
            DataCommand::AvailableWrite {
                mutation_id,
                ops,
                timestamp_ms,
                origin,
                observed,
            } => {
                if let Some(p) = ops
                    .iter()
                    .map(|op| partition_of(op.key().as_bytes()))
                    .find(|p| g.partitions.contains_key(p))
                {
                    return Applied::Moving(p);
                }
                let result = resolve_available(
                    engine,
                    &mutation_id,
                    ops,
                    &observed,
                    timestamp_ms,
                    &origin,
                    self.events.get(),
                );
                self.check_apply(g, result.as_ref().err());
                return Applied::Write(result);
            }
            DataCommand::Digest { id, now_ms } => {
                match digest_of(engine, now_ms) {
                    Ok(digest) => {
                        let index = g.applied_index + 1;
                        g.digests.push((id, index, digest));
                        if g.digests.len() > MAX_DIGESTS {
                            g.digests.remove(0);
                        }
                    }
                    Err(e) => warn!(group = %self.id, error = %e, "digest failed"),
                }
                return Applied::Barrier;
            }
            DataCommand::IndexStep { now_ms, limit } => {
                let result =
                    engine
                        .index_step_at(now_ms, limit as usize)
                        .map(|step| WriteOutcome {
                            version: step.version,
                            deduplicated: false,
                        });
                self.check_apply(g, result.as_ref().err());
                return Applied::Write(result);
            }
            DataCommand::ClearConflicts {
                key,
                mutation_id,
                now_ms,
            } => {
                let prefix = format!("{CONFLICT_META_PREFIX}{key}\u{0}");
                match engine.meta(prefix.as_bytes()) {
                    Err(e) => Err(e),
                    Ok(found) if found.is_empty() => Ok(()),
                    Ok(found) => {
                        let batch = found
                            .into_iter()
                            .fold(WriteBatch::new(id_of(&mutation_id)), |b, (name, _)| {
                                b.set_meta(name, None)
                            });
                        engine.write_at(batch, now_ms).map(|_| ())
                    }
                }
            }
            DataCommand::Fence {
                partitions,
                mutation_id,
                now_ms,
            } => {
                let fresh: Vec<u16> = partitions
                    .into_iter()
                    .filter(|p| !g.partitions.contains_key(p))
                    .collect();
                if fresh.is_empty() {
                    Ok(())
                } else {
                    let batch = fresh
                        .iter()
                        .fold(WriteBatch::new(id_of(&mutation_id)), |b, p| {
                            b.set_meta(partition_meta_name(*p), Some(b"fenced".to_vec()))
                        });
                    engine.write_at(batch, now_ms).map(|_| {
                        for p in fresh {
                            g.partitions.insert(p, PartitionState::Fenced);
                        }
                    })
                }
            }
            DataCommand::Release {
                partitions,
                mutation_id,
                now_ms,
            } => {
                let set: BTreeSet<u16> = partitions
                    .into_iter()
                    .filter(|p| g.partitions.get(p) != Some(&PartitionState::Released))
                    .collect();
                if set.is_empty() {
                    Ok(())
                } else {
                    let batch = set
                        .iter()
                        .fold(WriteBatch::new(id_of(&mutation_id)), |b, p| {
                            b.set_meta(partition_meta_name(*p), Some(b"released".to_vec()))
                        });
                    engine
                        .write_purging_at(batch, &|k| set.contains(&partition_of(k)), now_ms)
                        .map(|_| {
                            for p in &set {
                                g.partitions.insert(*p, PartitionState::Released);
                            }
                        })
                }
            }
            DataCommand::Import {
                partitions,
                clear,
                entries,
                mutation_id,
                now_ms,
            } => {
                let set: BTreeSet<u16> = partitions.into_iter().collect();
                let mut batch = WriteBatch::new(id_of(&mutation_id));
                for e in entries {
                    if !set.contains(&partition_of(e.key.as_bytes())) {
                        continue; // never write outside the imported partitions
                    }
                    batch = batch.push(Op::Put {
                        key: e.key.into_bytes(),
                        value: e.value.into_bytes(),
                        ttl: e.ttl_ms.map(Duration::from_millis),
                        condition: None,
                    });
                }
                if clear {
                    for p in &set {
                        batch = batch.set_meta(partition_meta_name(*p), None);
                    }
                    if set.is_empty() {
                        Ok(())
                    } else {
                        engine
                            .write_purging_at(batch, &|k| set.contains(&partition_of(k)), now_ms)
                            .map(|_| {
                                for p in &set {
                                    g.partitions.remove(p);
                                }
                            })
                    }
                } else if batch.ops().is_empty() {
                    Ok(())
                } else {
                    engine.write_at(batch, now_ms).map(|_| ())
                }
            }
        };
        self.check_apply(g, result.as_ref().err());
        Applied::Migration(result)
    }

    /// A WAL failure while applying means this replica can no longer stay
    /// identical to the others.
    fn check_apply(&self, g: &mut GroupInner, error: Option<&StorageError>) {
        if let Some(e) = error
            && e.is_outcome_unknown()
        {
            error!(group = %self.id, error = %e, "apply failed; group disabled on this node");
            g.failed = Some(format!("apply: {e}"));
        }
    }

    /// Recorded conflicts of keys starting with `prefix`, at most `limit`.
    pub fn conflicts(&self, prefix: &str, limit: usize) -> anyhow::Result<Vec<Conflict>> {
        let name = format!("{CONFLICT_META_PREFIX}{prefix}");
        let mut out = Vec::new();
        for (_, value) in self.engine().meta(name.as_bytes())?.into_iter().take(limit) {
            out.push(serde_json::from_slice(&value).context("malformed conflict record")?);
        }
        Ok(out)
    }

    /// The state of partition `p` in this group, if not plain serving.
    pub fn partition_state(&self, p: u16) -> Option<PartitionState> {
        self.lock().partitions.get(&p).copied()
    }

    /// Live records of fenced partitions, for the destination of a
    /// migration. Fails unless every partition is fenced here (so the data
    /// is final). Blocking: reads the whole engine.
    pub fn export(&self, partitions: &[u16], now_ms: u64) -> anyhow::Result<Vec<ImportEntry>> {
        // Holding the lock keeps a concurrent release from purging the data
        // mid-read.
        let g = self.lock();
        for p in partitions {
            anyhow::ensure!(
                g.partitions.get(p) == Some(&PartitionState::Fenced),
                "partition {p} is not fenced in group {}",
                self.id
            );
        }
        let set: BTreeSet<u16> = partitions.iter().copied().collect();
        let records = self.engine().scan(
            std::ops::Bound::Unbounded,
            std::ops::Bound::Unbounded,
            usize::MAX,
        )?;
        let mut out = Vec::new();
        for r in records {
            if !set.contains(&partition_of(&r.key)) {
                continue;
            }
            let ttl_ms = match r.expires_at_ms {
                Some(at) if at <= now_ms => continue,
                Some(at) => Some(at - now_ms),
                None => None,
            };
            out.push(ImportEntry {
                key: String::from_utf8(r.key).context("non-UTF-8 key")?,
                value: String::from_utf8(r.value).context("non-UTF-8 value")?,
                ttl_ms,
            });
        }
        drop(g);
        Ok(out)
    }

    fn persist_raft(&self, g: &mut GroupInner) -> anyhow::Result<()> {
        let GroupInner { raft, store, .. } = g;
        if let Err(e) = store.persist(raft) {
            error!(group = %self.id, error = %e, "persisting group raft state failed; group disabled on this node");
            g.failed = Some(format!("persist: {e:#}"));
            return Err(e);
        }
        Ok(())
    }

    fn record_applied(&self, g: &GroupInner) {
        let tmp = g.applied_path.with_extension("tmp");
        let written = fs::write(&tmp, format!("{}\n", g.applied_index))
            .and_then(|()| fs::rename(&tmp, &g.applied_path));
        if let Err(e) = written {
            // Not fatal: on restart, entries since the last good write are
            // re-applied and deduplicated by mutation ID.
            error!(group = %self.id, error = %e, "persisting applied index failed");
        }
    }

    /// Discards the applied log prefix once the log is long enough. The
    /// engine is flushed first: afterwards those entries exist nowhere else.
    fn maybe_compact(&self, g: &mut GroupInner, engine: &Engine) -> anyhow::Result<()> {
        let (snapshot_index, _) = g.raft.snapshot_meta();
        if g.failed.is_some()
            || (g.raft.log().len() as u64) <= self.snapshot_threshold
            || g.applied_index <= snapshot_index
        {
            return Ok(());
        }
        if let Err(e) = engine.flush() {
            // Keep the log; compaction is retried after the next apply.
            warn!(group = %self.id, error = %e, "flush before log compaction failed");
            return Ok(());
        }
        if g.raft.compact(g.applied_index) {
            self.persist_raft(g)?;
            info!(group = %self.id, upto = g.applied_index, "raft log compacted");
        }
        Ok(())
    }

    /// The leader's data state for a peer that needs compacted entries, or
    /// `None` if this node is not the leader or a transfer to `peer`
    /// started recently. Call [`ReplicaGroup::snapshot_sent`] afterwards.
    /// Blocking: serializes the whole engine.
    pub fn snapshot_payload(
        &self,
        peer: &NodeId,
        now_ms: u64,
        force: bool,
    ) -> anyhow::Result<Option<SnapshotPayload>> {
        {
            let mut sending = self.sending.lock().unwrap_or_else(PoisonError::into_inner);
            if !force
                && sending
                    .get(peer)
                    .is_some_and(|started| now_ms < started + SNAPSHOT_RESEND_MS)
            {
                return Ok(None);
            }
            sending.insert(peer.clone(), now_ms);
        }
        let g = self.lock();
        if g.raft.role() != Role::Leader || g.failed.is_some() {
            drop(g);
            self.snapshot_sent(peer, None);
            return Ok(None);
        }
        // Applies happen only under this lock, so the engine is exactly at
        // `applied_index` while we hold it.
        let index = g.applied_index;
        let last_included_term = g
            .raft
            .entry_term(index)
            .with_context(|| format!("term of applied index {index} is unknown"))?;
        let data = self.engine().snapshot()?;
        Ok(Some(SnapshotPayload {
            term: g.raft.term(),
            last_included_index: index,
            last_included_term,
            data,
        }))
    }

    /// Ends a transfer started by [`ReplicaGroup::snapshot_payload`]. After a
    /// delivered snapshot (`delivered_at`), no new transfer to `peer` starts
    /// for a while, giving it time to install and acknowledge; after a
    /// failure (`None`) the next request retries at once.
    pub fn snapshot_sent(&self, peer: &NodeId, delivered_at: Option<u64>) {
        let mut sending = self.sending.lock().unwrap_or_else(PoisonError::into_inner);
        match delivered_at {
            Some(at) => sending.insert(peer.clone(), at),
            None => sending.remove(peer),
        };
    }

    /// Installs a snapshot from the group leader `from` if Raft accepts it,
    /// and returns the acknowledgement to send. Blocking.
    pub fn install_snapshot(
        &self,
        now_ms: u64,
        from: NodeId,
        snapshot: SnapshotPayload,
    ) -> anyhow::Result<Vec<Envelope<DataCommand>>> {
        let mut g = self.lock();
        if let Some(reason) = &g.failed {
            anyhow::bail!("group {} is failed: {reason}", self.id);
        }
        let index = snapshot.last_included_index;
        let (snapshot_index, _) = g.raft.snapshot_meta();
        if self.members.contains(&from)
            && g.raft.should_install_snapshot(snapshot.term, index)
            && index > g.applied_index
        {
            self.swap_engine(&mut g, index, &snapshot.data)?;
            info!(group = %self.id, index, bytes = snapshot.data.len(), "installed snapshot from leader");
        } else if g.repair_requested
            && self.members.contains(&from)
            && snapshot.term == g.raft.term()
            && g.raft.leader() == Some(&from)
            && index >= snapshot_index
            && index <= g.raft.commit_index()
            && g.raft.entry_term(index) == Some(snapshot.last_included_term)
        {
            // Anti-entropy repair: this replica's data diverged from the
            // majority. Take the leader's state at `index` (committed, and in
            // our own log), then re-apply our log after it.
            self.swap_engine(&mut g, index, &snapshot.data)?;
            g.raft.rewind_applied(index);
            g.repair_requested = false;
            warn!(group = %self.id, index, "replaced diverged replica state with the leader's");
        }
        let message = RaftMessage::InstallSnapshot {
            term: snapshot.term,
            last_included_index: index,
            last_included_term: snapshot.last_included_term,
        };
        let ((), out) = self.drive_locked(&mut g, now_ms, |raft, now| {
            ((), raft.step(now, from, message))
        })?;
        Ok(out)
    }

    /// Replaces the engine with one built from `data` (the state at log
    /// `index`), crash-safely. Caller holds the group lock.
    fn swap_engine(&self, g: &mut GroupInner, index: LogIndex, data: &[u8]) -> anyhow::Result<()> {
        // A fresh name every time: an engine at the same index may be live.
        let name = format!("storage-{index}-{:08x}", rand_u32());
        let path = self.dir.join(&name);
        let fresh = Engine::create_from_snapshot(&path, self.engine_options.clone(), data)
            .with_context(|| format!("building group {} storage from a snapshot", self.id))?;
        // From here on a restart opens the new engine.
        write_durably(&self.dir.join(STORAGE_POINTER), &format!("{name}\n"))
            .context("switching storage to the snapshot")?;
        let old = std::mem::replace(
            &mut *self.engine.write().unwrap_or_else(PoisonError::into_inner),
            Arc::new(fresh),
        );
        g.applied_index = index;
        g.partitions = load_partition_states(&self.engine())?;
        self.record_applied(g);
        // Proposals at or below the snapshot can no longer be matched with
        // their outcome; their callers report "unknown".
        g.waiters = g.waiters.split_off(&(index + 1));
        let old_dir = old.dir().to_path_buf();
        drop(old);
        // Readers may still hold the old engine; open() retries this.
        let _ = fs::remove_dir_all(old_dir);
        Ok(())
    }

    /// Publishes this group's applied writes on `bus` from now on.
    pub fn set_events(&self, bus: crate::events::EventBus) {
        let _ = self.events.set(bus);
    }

    /// The digest this replica computed for the `Digest` entry `id`.
    pub fn digest(&self, id: &str) -> Option<BTreeMap<u16, u64>> {
        self.lock()
            .digests
            .iter()
            .find(|(d, ..)| d == id)
            .map(|(_, _, digest)| digest.clone())
    }

    /// Asks this replica to accept the next snapshot from the leader even
    /// though it is up to date (anti-entropy found its data diverged).
    pub fn request_repair(&self) {
        self.lock().repair_requested = true;
    }

    /// Proposes a command on this node if it is the group leader.
    pub fn propose(&self, now_ms: u64, command: DataCommand) -> anyhow::Result<Proposed> {
        // Append and register the waiter under one lock, before anything can
        // commit the entry, so the waiter always receives the real outcome.
        let (index, out, rx) = {
            let mut g = self.lock();
            if let Some(reason) = &g.failed {
                anyhow::bail!("group {} is failed: {reason}", self.id);
            }
            match g.raft.propose(command) {
                Err(NotLeader { leader }) => return Ok(Proposed::NotLeader(leader)),
                Ok((index, out)) => {
                    let (tx, rx) = oneshot::channel();
                    let term = g.raft.term();
                    if let Some((_, earlier)) = g.waiters.insert(index, (term, tx)) {
                        // An older proposal at this index, from an earlier
                        // term of ours: as leader we no longer hold it at
                        // `index`, so by leader completeness it never
                        // committed and never will.
                        let _ = earlier.send(Applied::Lost);
                    }
                    (index, out, rx)
                }
            }
        };
        // Persist (and, for a single-member group, commit and apply) before
        // the append messages may be sent.
        let ((), out) = self.drive(now_ms, |_, _| ((), out))?;
        Ok(Proposed::Accepted {
            index,
            done: rx,
            out,
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn id(s: &str) -> NodeId {
        NodeId::new(s).expect("id")
    }

    #[test]
    fn group_ids_are_stable_and_order_independent() {
        let (a, b, c) = (id("b"), id("a"), id("c"));
        assert_eq!(group_id(&[&a, &b, &c]), "a+b+c");
        assert_eq!(group_id(&[&c, &a, &b]), "a+b+c");
    }

    #[test]
    fn wire_ops_round_trip_and_convert() {
        let op = WireOp::Put {
            key: "users/1".into(),
            value: "{\"n\":1}".into(),
            ttl_ms: Some(5),
            if_version: None,
            if_absent: true,
        };
        let cmd = DataCommand::Write {
            mutation_id: MutationId::random().to_string(),
            ops: vec![op.clone()],
            now_ms: 7,
        };
        let json = serde_json::to_string(&cmd).expect("ser");
        assert_eq!(serde_json::from_str::<DataCommand>(&json).expect("de"), cmd);
        match op.into_op() {
            Op::Put { condition, ttl, .. } => {
                assert_eq!(condition, Some(Condition::Absent));
                assert_eq!(ttl, Some(Duration::from_millis(5)));
            }
            Op::Delete { .. } => panic!("expected put"),
        }
    }

    fn put(key: &str, value: &str) -> DataCommand {
        DataCommand::Write {
            mutation_id: MutationId::random().to_string(),
            ops: vec![WireOp::Put {
                key: key.into(),
                value: value.into(),
                ttl_ms: None,
                if_version: None,
                if_absent: false,
            }],
            now_ms: 1,
        }
    }

    /// Delivers messages between in-process groups until none are left,
    /// turning snapshot requests into snapshot transfers like the cluster
    /// transport does. Returns the number of snapshots installed.
    fn pump(
        groups: &BTreeMap<NodeId, &ReplicaGroup>,
        from: &NodeId,
        out: Vec<Envelope<DataCommand>>,
        now: u64,
    ) -> usize {
        let mut installed = 0;
        let mut queue: Vec<(NodeId, Envelope<DataCommand>)> =
            out.into_iter().map(|e| (from.clone(), e)).collect();
        while !queue.is_empty() {
            let (sender, e) = queue.remove(0);
            let Some(target) = groups.get(&e.to) else {
                continue; // down
            };
            let replies = if let RaftMessage::InstallSnapshot { .. } = e.message {
                let leader = groups[&sender];
                let Some(payload) = leader.snapshot_payload(&e.to, now, false).expect("payload")
                else {
                    continue;
                };
                leader.snapshot_sent(&e.to, None);
                installed += 1;
                target
                    .install_snapshot(now, sender.clone(), payload)
                    .expect("install")
            } else {
                let message = e.message;
                let sender = sender.clone();
                target
                    .drive(now, move |raft, now| ((), raft.step(now, sender, message)))
                    .expect("step")
                    .1
            };
            queue.extend(replies.into_iter().map(|r| (e.to.clone(), r)));
        }
        installed
    }

    #[test]
    fn digests_expose_diverged_replicas_and_forced_snapshots_repair_them() {
        let dir = tempfile::tempdir().expect("tempdir");
        let (a, b, c) = (id("a"), id("b"), id("c"));
        let members = vec![a.clone(), b.clone(), c.clone()];
        let open = |me: &NodeId| {
            ReplicaGroup::open(
                &dir.path().join(me.as_str()),
                me,
                members.clone(),
                RaftConfig::default(),
                Options {
                    background_work: false,
                    ..Options::default()
                },
                10_000,
                7,
            )
            .expect("open")
        };
        let (ga, gb, gc) = (open(&a), open(&b), open(&c));
        let live: BTreeMap<NodeId, &ReplicaGroup> =
            BTreeMap::from([(a.clone(), &ga), (b.clone(), &gb), (c.clone(), &gc)]);
        let mut now = 10_000;
        let ((), out) = ga.drive(now, |r, n| ((), r.tick(n))).expect("tick");
        pump(&live, &a, out, now);
        for i in 0..10 {
            now += 1;
            let Ok(Proposed::Accepted { out, .. }) = ga.propose(now, put(&format!("k{i}"), "1"))
            else {
                panic!("leader accepts");
            };
            pump(&live, &a, out, now);
        }
        let digest_round = |now: u64, name: &str| {
            let Ok(Proposed::Accepted { out, .. }) = ga.propose(
                now,
                DataCommand::Digest {
                    id: name.into(),
                    now_ms: 1,
                },
            ) else {
                panic!("leader accepts");
            };
            pump(&live, &a, out, now);
            let ((), out) = ga
                .drive(now + 300, |r, n| ((), r.tick(n)))
                .expect("heartbeat");
            pump(&live, &a, out, now + 300);
            [&ga, &gb, &gc].map(|g| g.digest(name).map(|d| digest_root(&d)))
        };
        now += 1_000;
        let [ra, rb, rc] = digest_round(now, "healthy");
        assert!(
            ra.is_some() && ra == rb && rb == rc,
            "identical replicas agree"
        );

        // c's disk "rots": a value changes behind Raft's back.
        gc.engine().put("k3", "corrupted").expect("put");
        now += 1_000;
        let [ra, rb, rc] = digest_round(now, "rotten");
        assert_eq!(ra, rb);
        assert_ne!(ra, rc, "the diverged replica is detected");

        // Repair: c accepts the leader's state although it is caught up.
        gc.request_repair();
        let payload = ga
            .snapshot_payload(&c, now, true)
            .expect("payload")
            .expect("leader");
        gc.install_snapshot(now, a.clone(), payload)
            .expect("install");
        let value = gc.engine().get(b"k3").expect("get").map(|r| r.value);
        assert_eq!(value, Some(b"1".to_vec()));
        now += 1_000;
        let [ra, _, rc] = digest_round(now, "repaired");
        assert_eq!(ra, rc, "repaired");
    }

    #[test]
    fn lagging_replica_catches_up_from_a_snapshot_and_restarts_from_it() {
        let dir = tempfile::tempdir().expect("tempdir");
        let (a, b, c) = (id("a"), id("b"), id("c"));
        let members = vec![a.clone(), b.clone(), c.clone()];
        let opts = Options {
            background_work: false,
            ..Options::default()
        };
        let open = |me: &NodeId| {
            ReplicaGroup::open(
                &dir.path().join(me.as_str()),
                me,
                members.clone(),
                RaftConfig::default(),
                opts.clone(),
                4,
                7,
            )
            .expect("open")
        };
        let (ga, gb) = (open(&a), open(&b));
        let mut live: BTreeMap<NodeId, &ReplicaGroup> =
            BTreeMap::from([(a.clone(), &ga), (b.clone(), &gb)]);
        let mut now = 10_000;
        let ((), out) = ga.drive(now, |r, n| ((), r.tick(n))).expect("tick");
        pump(&live, &a, out, now);
        assert_eq!(ga.status().0, Role::Leader);

        // c is down while 20 writes commit; the leader compacts its log.
        for i in 0..20 {
            now += 1;
            let Ok(Proposed::Accepted { out, .. }) =
                ga.propose(now, put(&format!("k{i}"), &i.to_string()))
            else {
                panic!("leader accepts");
            };
            pump(&live, &a, out, now);
        }
        let (snapshot_index, _) = ga.lock().raft.snapshot_meta();
        assert!(
            snapshot_index >= 15,
            "leader compacted (at {snapshot_index})"
        );

        let gc = open(&c);
        live.insert(c.clone(), &gc);
        now += 1_000;
        let ((), out) = ga.drive(now, |r, n| ((), r.tick(n))).expect("heartbeat");
        assert!(
            pump(&live, &a, out, now) >= 1,
            "c caught up through a snapshot"
        );
        // The next write reaches c through the log again.
        now += 1;
        let Ok(Proposed::Accepted { out, .. }) = ga.propose(now, put("after", "x")) else {
            panic!("leader accepts");
        };
        pump(&live, &a, out, now);
        now += 1_000;
        let ((), out) = ga.drive(now, |r, n| ((), r.tick(n))).expect("heartbeat");
        pump(&live, &a, out, now);

        assert_eq!(gc.applied_index(), ga.applied_index());
        for key in ["k0", "k19", "after"] {
            let on_a = ga.engine().get(key.as_bytes()).expect("get").expect("on a");
            let on_c = gc.engine().get(key.as_bytes()).expect("get").expect("on c");
            assert_eq!(
                (on_a.value, on_a.version),
                (on_c.value, on_c.version),
                "{key}"
            );
        }

        // c restarts from the installed snapshot plus its log.
        let applied = gc.applied_index();
        drop(live);
        drop(gc);
        let gc = open(&c);
        assert_eq!(gc.applied_index(), applied);
        let k0 = gc.engine().get(b"k0").expect("get").map(|r| r.value);
        assert_eq!(k0, Some(b"0".to_vec()));
        let pointer = fs::read_to_string(dir.path().join("c/groups/a+b+c").join(STORAGE_POINTER))
            .expect("pointer");
        assert!(pointer.starts_with("storage-"), "{pointer}");
        assert!(
            !dir.path().join("c/groups/a+b+c/storage").exists(),
            "replaced engine directory is removed"
        );
    }

    #[test]
    fn available_writes_resolve_by_last_writer_wins_and_record_conflicts() {
        let dir = tempfile::tempdir().expect("tempdir");
        let me = id("solo");
        let group = ReplicaGroup::open(
            dir.path(),
            &me,
            vec![me.clone()],
            RaftConfig::default(),
            Options {
                background_work: false,
                ..Options::default()
            },
            10_000,
            1,
        )
        .expect("open");
        group
            .drive(10_000, |raft, now| ((), raft.tick(now)))
            .expect("elect");
        let run = |cmd: DataCommand| -> Applied {
            let Ok(Proposed::Accepted { mut done, .. }) = group.propose(10_001, cmd) else {
                panic!("leader accepts");
            };
            done.try_recv().expect("applied at once")
        };
        let available = |value: &str, ts: u64, mid: &str| DataCommand::AvailableWrite {
            mutation_id: mid.to_owned(),
            ops: vec![WireOp::Put {
                key: "k".into(),
                value: value.into(),
                ttl_ms: None,
                if_version: None,
                if_absent: false,
            }],
            timestamp_ms: ts,
            origin: "n2".into(),
            observed: Vec::new(),
        };
        let value = || {
            group
                .engine()
                .get(b"k")
                .expect("get")
                .map(|r| String::from_utf8(r.value).expect("utf8"))
        };
        // A strict write at t=1000.
        let strict = DataCommand::Write {
            mutation_id: MutationId::random().to_string(),
            ops: vec![WireOp::Put {
                key: "k".into(),
                value: "strict".into(),
                ttl_ms: None,
                if_version: None,
                if_absent: false,
            }],
            now_ms: 1_000,
        };
        assert!(matches!(run(strict), Applied::Write(Ok(_))));

        // An older available write loses, and is recorded.
        let old = MutationId::random().to_string();
        assert!(matches!(
            run(available("old", 500, &old)),
            Applied::Write(Ok(_))
        ));
        assert_eq!(value().as_deref(), Some("strict"));
        let conflicts = group.conflicts("k", 10).expect("conflicts");
        assert_eq!(conflicts.len(), 1);
        assert_eq!(conflicts[0].value.as_deref(), Some("old"));
        assert_eq!(conflicts[0].winner_timestamp_ms, 1_000);

        // A newer one wins; its retry is deduplicated, not re-resolved.
        let new = MutationId::random().to_string();
        assert!(matches!(
            run(available("new", 2_000, &new)),
            Applied::Write(Ok(_))
        ));
        assert_eq!(value().as_deref(), Some("new"));
        assert!(matches!(
            run(available("new", 2_000, &new)),
            Applied::Write(Ok(WriteOutcome {
                deduplicated: true,
                ..
            }))
        ));

        // A delete keeps beating older writes even though the key is gone.
        let delete = DataCommand::AvailableWrite {
            mutation_id: MutationId::random().to_string(),
            ops: vec![WireOp::Delete {
                key: "k".into(),
                if_version: None,
            }],
            timestamp_ms: 3_000,
            origin: "n3".into(),
            observed: Vec::new(),
        };
        assert!(matches!(run(delete), Applied::Write(Ok(_))));
        let stale = MutationId::random().to_string();
        run(available("stale", 2_500, &stale));
        assert_eq!(value(), None, "the newer delete wins");
        // old (lost), strict and new (overwritten unseen), stale (lost).
        let conflicts = group.conflicts("k", 10).expect("conflicts");
        assert_eq!(conflicts.len(), 4, "{conflicts:#?}");

        // Overwriting a version the writer had seen is not a conflict.
        let latest = group
            .engine()
            .latest(b"k")
            .expect("latest")
            .expect("stored");
        let resurrect = DataCommand::AvailableWrite {
            mutation_id: MutationId::random().to_string(),
            ops: vec![WireOp::Put {
                key: "k".into(),
                value: "again".into(),
                ttl_ms: None,
                if_version: None,
                if_absent: false,
            }],
            timestamp_ms: 3_500,
            origin: "n2".into(),
            observed: vec![Some(Observed {
                timestamp_ms: latest.timestamp_ms,
                mutation_id: latest.mutation_id.to_string(),
            })],
        };
        run(resurrect);
        assert_eq!(value().as_deref(), Some("again"));
        assert_eq!(group.conflicts("k", 10).expect("conflicts").len(), 4);

        // Clearing removes the recorded conflicts.
        let clear = DataCommand::ClearConflicts {
            key: "k".into(),
            mutation_id: MutationId::random().to_string(),
            now_ms: 4_000,
        };
        assert!(matches!(run(clear), Applied::Migration(Ok(()))));
        assert!(group.conflicts("k", 10).expect("conflicts").is_empty());
    }

    #[test]
    fn fence_export_release_and_import_move_a_partition() {
        let dir = tempfile::tempdir().expect("tempdir");
        let me = id("solo");
        let opts = Options {
            background_work: false,
            ..Options::default()
        };
        let open = |sub: &str| {
            ReplicaGroup::open(
                &dir.path().join(sub),
                &me,
                vec![me.clone()],
                RaftConfig::default(),
                opts.clone(),
                10_000,
                1,
            )
            .expect("open")
        };
        let run = |g: &ReplicaGroup, now: u64, cmd: DataCommand| -> Applied {
            let Ok(Proposed::Accepted { mut done, .. }) = g.propose(now, cmd) else {
                panic!("leader accepts");
            };
            done.try_recv().expect("applied at once")
        };
        let migrate = |kind: &str, partitions: Vec<u16>| match kind {
            "fence" => DataCommand::Fence {
                partitions,
                mutation_id: MutationId::random().to_string(),
                now_ms: 1,
            },
            _ => DataCommand::Release {
                partitions,
                mutation_id: MutationId::random().to_string(),
                now_ms: 1,
            },
        };
        let source = open("src");
        source
            .drive(10_000, |raft, now| ((), raft.tick(now)))
            .expect("elect");
        for k in ["a", "b", "c", "d"] {
            assert!(matches!(
                run(&source, 10_001, put(k, "1")),
                Applied::Write(Ok(_))
            ));
        }
        let p = partition_of(b"a");
        assert!(matches!(
            run(&source, 10_002, migrate("fence", vec![p])),
            Applied::Migration(Ok(()))
        ));
        assert_eq!(source.partition_state(p), Some(PartitionState::Fenced));
        assert!(
            matches!(run(&source, 10_003, put("a", "2")), Applied::Moving(q) if q == p),
            "writes to a fenced partition are refused"
        );
        let exported = source.export(&[p], 0).expect("export");
        assert!(exported.iter().any(|e| e.key == "a" && e.value == "1"));
        assert!(exported.iter().all(|e| partition_of(e.key.as_bytes()) == p));
        assert!(
            source.export(&[p.wrapping_add(1) % 4096], 0).is_err(),
            "unfenced"
        );

        let dest = open("dst");
        dest.drive(10_000, |raft, now| ((), raft.tick(now)))
            .expect("elect");
        // The destination once held a stale copy of the partition.
        assert!(matches!(
            run(&dest, 10_001, put("a", "stale")),
            Applied::Write(Ok(_))
        ));
        let import = DataCommand::Import {
            partitions: vec![p],
            clear: true,
            entries: exported.clone(),
            mutation_id: MutationId::random().to_string(),
            now_ms: 1,
        };
        assert!(matches!(
            run(&dest, 10_002, import),
            Applied::Migration(Ok(()))
        ));
        let got = dest.engine().get(b"a").expect("get").map(|r| r.value);
        assert_eq!(got, Some(b"1".to_vec()), "stale copy replaced");

        assert!(matches!(
            run(&source, 10_004, migrate("release", vec![p])),
            Applied::Migration(Ok(()))
        ));
        assert_eq!(source.partition_state(p), Some(PartitionState::Released));
        assert_eq!(source.engine().get(b"a").expect("get"), None, "purged");
        drop(source);
        let source = open("src");
        assert_eq!(
            source.partition_state(p),
            Some(PartitionState::Released),
            "state survives restart"
        );
    }

    #[test]
    fn single_member_group_applies_once_and_survives_restart() {
        let dir = tempfile::tempdir().expect("tempdir");
        let me = id("solo");
        let opts = Options {
            background_work: false,
            ..Options::default()
        };
        let open = || {
            ReplicaGroup::open(
                dir.path(),
                &me,
                vec![me.clone()],
                RaftConfig::default(),
                opts.clone(),
                10_000,
                1,
            )
            .expect("open")
        };
        let write = |v: &str| put("k", v);
        let group = open();
        group
            .drive(10_000, |raft, now| ((), raft.tick(now)))
            .expect("elect");
        for (now, v) in [(10_001, "1"), (10_002, "2")] {
            let Ok(Proposed::Accepted { mut done, .. }) = group.propose(now, write(v)) else {
                panic!("leader accepts");
            };
            match done.try_recv() {
                Ok(Applied::Write(Ok(outcome))) => assert!(!outcome.deduplicated),
                other => panic!("expected an applied write, got {other:?}"),
            }
        }
        let version = group.engine().get(b"k").expect("get").map(|r| r.version);
        let applied = group.applied_index();
        drop(group);

        // After a restart the group re-elects and re-commits its log, but
        // must not re-apply entries it already applied.
        let group = open();
        assert_eq!(group.applied_index(), applied);
        group
            .drive(20_000, |raft, now| ((), raft.tick(now)))
            .expect("elect");
        let after = group.engine().get(b"k").expect("get");
        assert_eq!(after.as_ref().map(|r| r.value.clone()), Some(b"2".to_vec()));
        assert_eq!(after.map(|r| r.version), version, "nothing was re-applied");
    }
}
