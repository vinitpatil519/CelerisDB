//! The node runtime: owns the storage engine and serves the HTTP API.

use std::collections::BTreeMap;
use std::fs;
use std::future::Future;
use std::io;
use std::net::SocketAddr;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex, PoisonError, RwLock};
use std::time::{Duration, Instant};

use anyhow::Context;
use celeris_cluster::membership::Member;
use celeris_cluster::raft::{
    ControlCommand, ControlState, Envelope, Migration, NotLeader, PersistentState, Raft,
    RaftConfig, Role,
};
use celeris_cluster::{MemberState, Membership, MembershipEvent};
use celeris_core::partition::{NodeId, NodeInfo, PartitionMap, PlacementError};
use celeris_storage::Engine;
use serde::{Deserialize, Serialize};
use tokio::net::TcpListener;
use tokio::sync::watch;
use tokio::task::JoinError;
use tracing::{error, info, warn};
use uuid::Uuid;

use crate::config::Config;
use crate::groups::{ReplicaGroup, group_id};
use crate::metrics::HttpMetrics;

const NODE_ID_FILE: &str = "NODE_ID";
const INCARNATION_FILE: &str = "INCARNATION";
const RAFT_DIR: &str = "raft";
const RAFT_STATE_FILE: &str = "state.json";
/// Version of `<data_dir>/raft/state.json`.
pub const RAFT_STATE_FORMAT_VERSION: u32 = 1;

#[derive(Debug)]
pub(crate) struct ControlPlane {
    raft: Raft<ControlCommand>,
    state: ControlState,
    path: PathBuf,
    /// What is known to be on disk (state, commit index); compared after
    /// every Raft call.
    persisted: (PersistentState<ControlCommand>, u64),
    /// How often the runtime should call `Raft::tick`.
    tick_ms: u64,
    group_settings: GroupSettings,
    /// Hysteresis for automatic rebalancing: the member set that differs
    /// from the placement, and since when (node clock, ms).
    auto_rebalance: Option<(Vec<NodeId>, u64)>,
    auto_rebalance_after_ms: u64,
    /// The voters, fixed at bootstrap.
    voters: Vec<NodeId>,
    /// Replication factor for the automatic first placement (0: off).
    bootstrap_rf: u8,
    /// The term in which this node last proposed the first placement, so
    /// it proposes at most once per term.
    bootstrap_term: Option<u64>,
}

/// How replication groups are created on this node.
#[derive(Debug, Clone)]
struct GroupSettings {
    data_dir: PathBuf,
    raft: RaftConfig,
    engine: celeris_storage::Options,
    snapshot_threshold: u64,
}

/// Where a request for some keys must go, in replicated mode.
#[derive(Debug)]
pub enum GroupLookup {
    /// The control plane has not committed a partition map yet.
    NoMap,
    /// The keys belong to different replication groups.
    CrossGroup,
    /// This node holds no replica of the keys' partition.
    NotMember(celeris_core::partition::Route),
    Group(Arc<ReplicaGroup>),
}

#[derive(Debug)]
pub enum ProposeError {
    /// This node is not a control-plane voter (or runs single-node).
    NoControlPlane,
    /// Only the leader accepts proposals; retry there.
    NotLeader(Option<NodeId>),
    Placement(PlacementError),
    /// Partitions are still moving from the previous placement.
    MigrationsPending(usize),
    Persist(anyhow::Error),
}

/// Running partition migrations, by partition (see D-020).
pub type Migrations = BTreeMap<u16, Migration>;

#[derive(Serialize, Deserialize)]
struct RaftStateFile {
    format_version: u32,
    state: PersistentState<ControlCommand>,
    /// A commit index known to be committed (a lower bound), so a restarted
    /// node applies the committed log without waiting for a leader.
    #[serde(default)]
    commit_index: u64,
}

/// (state, known commit index) from the Raft state file.
fn load_raft_state(path: &Path) -> anyhow::Result<(PersistentState<ControlCommand>, u64)> {
    match fs::read(path) {
        Ok(bytes) => {
            let file: RaftStateFile = serde_json::from_slice(&bytes)
                .with_context(|| format!("parsing {}", path.display()))?;
            anyhow::ensure!(
                file.format_version == RAFT_STATE_FORMAT_VERSION,
                "{}: unsupported raft state version {}",
                path.display(),
                file.format_version
            );
            Ok((file.state, file.commit_index))
        }
        Err(e) if e.kind() == io::ErrorKind::NotFound => Ok((PersistentState::default(), 0)),
        Err(e) => Err(e).with_context(|| format!("reading {}", path.display())),
    }
}

/// Atomically and durably replaces the Raft state file.
fn store_raft_state(
    path: &Path,
    state: &PersistentState<ControlCommand>,
    commit_index: u64,
) -> anyhow::Result<()> {
    use std::io::Write;
    let dir = path.parent().context("raft state path has no parent")?;
    fs::create_dir_all(dir).with_context(|| format!("creating {}", dir.display()))?;
    let body = serde_json::to_vec(&RaftStateFile {
        format_version: RAFT_STATE_FORMAT_VERSION,
        state: state.clone(),
        commit_index,
    })?;
    let tmp = path.with_extension("json.tmp");
    let mut file = fs::File::create(&tmp).with_context(|| format!("creating {}", tmp.display()))?;
    file.write_all(&body)?;
    file.sync_all()?;
    drop(file);
    fs::rename(&tmp, path).with_context(|| format!("replacing {}", path.display()))?;
    #[cfg(unix)]
    fs::File::open(dir)?.sync_all()?;
    Ok(())
}

/// One Celeris node. Cheap to share behind an `Arc`.
#[derive(Debug)]
pub struct Node {
    engine: Arc<Engine>,
    id: NodeId,
    /// Placement of the logical partitions. Starts as "this node owns
    /// everything" and is replaced only by maps the control plane commits.
    partitions: RwLock<Arc<PartitionMap>>,
    /// Raft control plane, when this node is a configured voter.
    control: Option<Mutex<ControlPlane>>,
    /// Replication groups this node is a member of, by group ID.
    groups: RwLock<BTreeMap<String, Arc<ReplicaGroup>>>,
    /// True once the control plane has committed a partition map.
    map_committed: AtomicBool,
    /// Partitions whose data is moving; they are served by their old
    /// replica set until the move finishes.
    migrations: RwLock<Arc<Migrations>>,
    /// Set while a migration pass runs, so passes never overlap.
    migrating: AtomicBool,
    /// Set while pending `available` writes are being reconciled.
    reconciling: AtomicBool,
    /// Set while an anti-entropy check runs.
    checking: AtomicBool,
    /// Applied changes, for watchers.
    events: crate::events::EventBus,
    /// Latest anti-entropy result per group this node led.
    anti_entropy: Mutex<BTreeMap<String, crate::anti_entropy::Report>>,
    /// How often anti-entropy runs (0: never).
    anti_entropy_interval_ms: u64,
    advertise: String,
    started: Instant,
    cors_origins: Vec<String>,
    metrics: HttpMetrics,
    shutdown: watch::Sender<bool>,
    /// Present when the node runs with a cluster port.
    membership: Option<Mutex<Membership>>,
}

impl Node {
    /// Opens (recovering if needed) the node's data directory. Blocking:
    /// call it from a blocking context. `cluster_addr` is the bound cluster
    /// port, or `None` for single-node mode.
    pub fn open(
        config: &Config,
        advertise: String,
        cluster_addr: Option<SocketAddr>,
    ) -> anyhow::Result<Node> {
        let data_dir = &config.node.data_dir;
        fs::create_dir_all(data_dir)
            .with_context(|| format!("creating data directory {}", data_dir.display()))?;
        let id = load_or_create_node_id(data_dir, config.node.id.as_deref())?;
        let control = match cluster_addr {
            Some(_) if !config.cluster.voters.is_empty() => {
                let voters = config
                    .cluster
                    .voters
                    .iter()
                    .map(|v| NodeId::new(v.clone()))
                    .collect::<Result<Vec<_>, _>>()?;
                if voters.contains(&id) {
                    let path = data_dir.join(RAFT_DIR).join(RAFT_STATE_FILE);
                    let (state, known_commit) = load_raft_state(&path)?;
                    let c = &config.cluster;
                    let raft_config = RaftConfig {
                        election_timeout_min_ms: c.raft_election_timeout_ms,
                        election_timeout_max_ms: 2 * c.raft_election_timeout_ms,
                        heartbeat_interval_ms: c.raft_heartbeat_ms,
                        ..RaftConfig::default()
                    };
                    let seed = Uuid::new_v4().as_u64_pair().0;
                    let mut raft = Raft::restore(
                        id.clone(),
                        voters.clone(),
                        raft_config,
                        seed,
                        0,
                        state.clone(),
                    );
                    raft.restore_commit(known_commit);
                    info!(node_id = %id, term = state.term, log_entries = state.log.len(), known_commit, "control plane voter");
                    Some(Mutex::new(ControlPlane {
                        raft,
                        state: ControlState::default(),
                        path,
                        persisted: (state, known_commit),
                        tick_ms: (c.raft_heartbeat_ms / 2).max(5),
                        group_settings: GroupSettings {
                            data_dir: data_dir.clone(),
                            raft: raft_config,
                            engine: config.engine_options(),
                            snapshot_threshold: c.snapshot_threshold,
                        },
                        auto_rebalance: None,
                        auto_rebalance_after_ms: c.auto_rebalance_after_ms,
                        voters,
                        bootstrap_rf: c.replication_factor,
                        bootstrap_term: None,
                    }))
                } else {
                    info!(node_id = %id, "not a control-plane voter");
                    None
                }
            }
            _ => None,
        };
        let membership = match cluster_addr {
            Some(bound) => {
                let incarnation = next_incarnation(data_dir)?;
                let addr = config
                    .cluster
                    .advertise
                    .clone()
                    .unwrap_or_else(|| bound.to_string());
                let mut m = Membership::new(
                    NodeInfo::new(id.clone(), config.cluster.zone.clone()),
                    addr.clone(),
                    incarnation,
                    0,
                    config.cluster.membership(),
                );
                for seed in &config.cluster.seeds {
                    m.add_seed(seed.clone());
                }
                info!(node_id = %id, cluster_addr = %addr, incarnation, seeds = config.cluster.seeds.len(), "cluster membership enabled");
                Some(Mutex::new(m))
            }
            None => None,
        };
        let engine = Engine::open(config.storage_dir(), config.engine_options())
            .with_context(|| format!("opening storage in {}", config.storage_dir().display()))?;
        let report = engine.recovery_report();
        info!(
            node_id = %id,
            tables = report.tables_opened,
            replayed_batches = report.batches_replayed,
            truncated_bytes = report.truncated_bytes,
            orphans_removed = report.orphan_files_removed,
            last_version = report.last_version,
            "node recovered"
        );
        let mut node = Node::new(engine, id, advertise, config.http.cors_origins.clone());
        node.membership = membership;
        node.control = control;
        node.anti_entropy_interval_ms = config.cluster.anti_entropy_interval_ms;
        // Apply the log known to be committed right away, so routing works
        // after a restart even before a leader is elected.
        if let Some(Err(e)) = node.with_raft(|_, _| ((), Vec::new())) {
            return Err(e);
        }
        Ok(node)
    }

    /// Replicated mode: data lives in Raft replication groups. Enabled on
    /// control-plane voters; all data nodes must currently be voters.
    pub fn is_replicated(&self) -> bool {
        self.control.is_some()
    }

    pub fn group(&self, id: &str) -> Option<Arc<ReplicaGroup>> {
        self.groups
            .read()
            .unwrap_or_else(PoisonError::into_inner)
            .get(id)
            .cloned()
    }

    pub fn groups(&self) -> Vec<Arc<ReplicaGroup>> {
        self.groups
            .read()
            .unwrap_or_else(PoisonError::into_inner)
            .values()
            .cloned()
            .collect()
    }

    /// The replication group serving all `keys`.
    pub fn resolve_group(&self, keys: &[&str]) -> GroupLookup {
        if !self.map_committed.load(Ordering::Acquire) {
            return GroupLookup::NoMap;
        }
        let map = self.partitions();
        let migrations = self.migrations();
        let mut found: Option<String> = None;
        let mut first_route = None;
        for key in keys {
            let mut route = map.route(key.as_bytes());
            if let Some(m) = migrations.get(&route.partition.get()) {
                // Still served by the old replica set.
                route.replicas = m.from.clone();
            }
            let refs: Vec<&NodeId> = route.replicas.iter().collect();
            let gid = group_id(&refs);
            match &found {
                Some(existing) if *existing != gid => return GroupLookup::CrossGroup,
                _ => found = Some(gid),
            }
            first_route.get_or_insert(route);
        }
        match (found.and_then(|g| self.group(&g)), first_route) {
            (Some(group), _) => GroupLookup::Group(group),
            (None, Some(route)) => GroupLookup::NotMember(route),
            (None, None) => GroupLookup::CrossGroup,
        }
    }

    /// Retries opening replication groups of the committed map that failed
    /// to open (for example, storage still locked by a previous process).
    /// Blocking.
    pub(crate) fn reopen_missing_groups(&self) {
        if !self.map_committed.load(Ordering::Acquire) {
            return;
        }
        let Some(control) = &self.control else {
            return;
        };
        let settings = control
            .lock()
            .unwrap_or_else(PoisonError::into_inner)
            .group_settings
            .clone();
        self.ensure_groups(&self.partitions(), &self.migrations(), &settings);
    }

    /// Opens the replication groups this node belongs to under `map`.
    /// Groups are never closed here; a group whose replica set disappears
    /// from the map simply stops receiving traffic. Blocking.
    fn ensure_groups(&self, map: &PartitionMap, migrations: &Migrations, settings: &GroupSettings) {
        let mut sets: BTreeMap<String, Vec<NodeId>> = BTreeMap::new();
        for p in celeris_core::partition::PartitionId::all() {
            let replicas = map.replica_ids(p);
            if replicas.contains(&&self.id) {
                let gid = group_id(&replicas);
                sets.entry(gid)
                    .or_insert_with(|| replicas.into_iter().cloned().collect());
            }
        }
        // Sources of running migrations must stay available to export.
        for m in migrations.values() {
            if m.from.contains(&self.id) {
                let refs: Vec<&NodeId> = m.from.iter().collect();
                sets.entry(group_id(&refs))
                    .or_insert_with(|| m.from.clone());
            }
        }
        for (gid, members) in sets {
            if self.group(&gid).is_some() {
                continue;
            }
            let seed = Uuid::new_v4().as_u64_pair().0;
            match ReplicaGroup::open(
                &settings.data_dir,
                &self.id,
                members,
                settings.raft,
                settings.engine.clone(),
                settings.snapshot_threshold,
                seed,
            ) {
                Ok(group) => {
                    group.set_events(self.events.clone());
                    self.groups
                        .write()
                        .unwrap_or_else(PoisonError::into_inner)
                        .insert(gid, Arc::new(group));
                }
                Err(e) => error!(group = %gid, error = %e, "could not open replication group"),
            }
        }
    }

    pub(crate) fn now_ms(&self) -> u64 {
        u64::try_from(self.started.elapsed().as_millis()).unwrap_or(u64::MAX)
    }

    /// Every group that serves at least one partition, by group ID, with
    /// the partitions it serves.
    pub(crate) fn serving_groups(&self) -> BTreeMap<String, (Vec<NodeId>, Vec<u16>)> {
        let (map, migrations) = (self.partitions(), self.migrations());
        let mut groups: BTreeMap<String, (Vec<NodeId>, Vec<u16>)> = BTreeMap::new();
        for p in celeris_core::partition::PartitionId::all() {
            let set = serving_set(&map, &migrations, p.get());
            let refs: Vec<&NodeId> = set.iter().collect();
            groups
                .entry(group_id(&refs))
                .or_insert_with(|| (set.clone(), Vec::new()))
                .1
                .push(p.get());
        }
        groups
    }

    /// Claims the right to run a migration pass; `false` if one is running.
    pub(crate) fn begin_migration_pass(&self) -> bool {
        !self.migrating.swap(true, Ordering::AcqRel)
    }

    pub(crate) fn end_migration_pass(&self) {
        self.migrating.store(false, Ordering::Release);
    }

    /// The bus of changes applied on this node (its own engine and the
    /// replication groups it belongs to).
    pub fn events(&self) -> &crate::events::EventBus {
        &self.events
    }

    /// How often anti-entropy checks run (0: never).
    pub(crate) fn anti_entropy_interval_ms(&self) -> u64 {
        self.anti_entropy_interval_ms
    }

    /// Claims the right to run an anti-entropy check.
    pub(crate) fn begin_check(&self) -> bool {
        !self.checking.swap(true, Ordering::AcqRel)
    }

    pub(crate) fn end_check(&self) {
        self.checking.store(false, Ordering::Release);
    }

    pub(crate) fn record_anti_entropy(&self, group: &str, report: crate::anti_entropy::Report) {
        self.anti_entropy
            .lock()
            .unwrap_or_else(PoisonError::into_inner)
            .insert(group.to_owned(), report);
    }

    /// Latest anti-entropy results, by group.
    pub fn anti_entropy_reports(&self) -> BTreeMap<String, crate::anti_entropy::Report> {
        self.anti_entropy
            .lock()
            .unwrap_or_else(PoisonError::into_inner)
            .clone()
    }

    /// Claims the right to run a reconciliation pass.
    pub(crate) fn begin_reconcile_pass(&self) -> bool {
        !self.reconciling.swap(true, Ordering::AcqRel)
    }

    pub(crate) fn end_reconcile_pass(&self) {
        self.reconciling.store(false, Ordering::Release);
    }

    /// Running partition migrations, as last committed.
    pub fn migrations(&self) -> Arc<Migrations> {
        Arc::clone(
            &self
                .migrations
                .read()
                .unwrap_or_else(PoisonError::into_inner),
        )
    }

    pub fn partitions(&self) -> Arc<PartitionMap> {
        Arc::clone(
            &self
                .partitions
                .read()
                .unwrap_or_else(PoisonError::into_inner),
        )
    }

    /// Replaces the partition map that routes and fences requests. The
    /// control plane calls this for committed maps; tests use it directly.
    pub fn install_partition_map(&self, map: PartitionMap) {
        *self
            .partitions
            .write()
            .unwrap_or_else(PoisonError::into_inner) = Arc::new(map);
    }

    pub fn is_voter(&self) -> bool {
        self.control.is_some()
    }

    pub fn node_id(&self) -> &NodeId {
        &self.id
    }

    pub(crate) fn raft_tick_ms(&self) -> Option<u64> {
        self.control
            .as_ref()
            .map(|c| c.lock().unwrap_or_else(PoisonError::into_inner).tick_ms)
    }

    /// Runs `f` on the Raft node, then persists Raft state if it changed and
    /// applies newly committed control commands. The returned messages may
    /// be sent only when this returns `Ok`: on a persistence failure they
    /// are withheld, as the Raft persistence contract requires. Blocking:
    /// call it from a blocking context.
    pub(crate) fn with_raft<R>(
        &self,
        f: impl FnOnce(&mut Raft<ControlCommand>, u64) -> (R, Vec<Envelope<ControlCommand>>),
    ) -> Option<anyhow::Result<(R, Vec<Envelope<ControlCommand>>)>> {
        let lock = self.control.as_ref()?;
        let mut cp = lock.lock().unwrap_or_else(PoisonError::into_inner);
        let (result, out) = f(&mut cp.raft, self.now_ms());
        let current = (cp.raft.persistent_state(), cp.raft.commit_index());
        if current != cp.persisted {
            if let Err(e) = store_raft_state(&cp.path, &current.0, current.1) {
                error!(error = %e, "persisting raft state failed; withholding messages");
                return Some(Err(e));
            }
            cp.persisted = current;
        }
        for entry in cp.raft.take_committed() {
            let applied = cp.state.apply(&entry);
            if *cp.state.migrations() != *self.migrations() {
                let migrations = Arc::new(cp.state.migrations().clone());
                info!(running = migrations.len(), "partition migrations changed");
                *self
                    .migrations
                    .write()
                    .unwrap_or_else(PoisonError::into_inner) = migrations;
            }
            match applied {
                Some(Ok(moves)) => {
                    if let Some(map) = cp.state.partition_map() {
                        info!(
                            epoch = map.epoch(),
                            nodes = map.nodes().len(),
                            replication_factor = map.replication_factor(),
                            moved_partitions = moves.len(),
                            migrations = cp.state.migrations().len(),
                            "partition map committed"
                        );
                        self.install_partition_map(map.clone());
                        self.map_committed.store(true, Ordering::Release);
                        self.ensure_groups(map, cp.state.migrations(), &cp.group_settings);
                    }
                }
                Some(Err(e)) => warn!(index = entry.index, error = %e, "control command rejected"),
                None => {}
            }
        }
        Some(Ok((result, out)))
    }

    /// (role, term, leader, commit index) of this node's Raft instance.
    pub fn raft_status(&self) -> Option<(Role, u64, Option<NodeId>, u64)> {
        let cp = self
            .control
            .as_ref()?
            .lock()
            .unwrap_or_else(PoisonError::into_inner);
        Some((
            cp.raft.role(),
            cp.raft.term(),
            cp.raft.leader().cloned(),
            cp.raft.commit_index(),
        ))
    }

    /// Proposes placing partitions on the current membership (alive and
    /// suspect members) with `rf` replicas. Blocking.
    pub(crate) fn propose_rebalance(
        &self,
        rf: u8,
    ) -> Result<(u64, Vec<Envelope<ControlCommand>>), ProposeError> {
        let nodes = self
            .with_membership(|m, _| m.placement_nodes())
            .ok_or(ProposeError::NoControlPlane)?;
        // Validate up front for a clear error; the state machine would
        // reject an invalid command the same way on every node anyway.
        PartitionMap::new(nodes.clone(), rf).map_err(ProposeError::Placement)?;
        let pending = self.migrations().len();
        if pending > 0 {
            return Err(ProposeError::MigrationsPending(pending));
        }
        let command = ControlCommand::SetNodes {
            nodes,
            replication_factor: rf,
        };
        let proposed = self
            .with_raft(|raft, _| match raft.propose(command) {
                Ok((index, out)) => (Ok(index), out),
                Err(not_leader) => (Err(not_leader), Vec::new()),
            })
            .ok_or(ProposeError::NoControlPlane)?
            .map_err(ProposeError::Persist)?;
        match proposed {
            (Ok(index), out) => Ok((index, out)),
            (Err(NotLeader { leader }), _) => Err(ProposeError::NotLeader(leader)),
        }
    }

    /// Proposes a new placement when membership has drifted from the
    /// committed one and stayed the same for `auto_rebalance_after_ms`
    /// (hysteresis against flapping). Only the control-plane leader acts.
    /// Returns the messages to send. Blocking.
    pub(crate) fn auto_rebalance(&self) -> Vec<Envelope<ControlCommand>> {
        let Some(control) = &self.control else {
            return Vec::new();
        };
        let Some(mut nodes) = self.with_membership(|m, _| m.placement_nodes()) else {
            return Vec::new();
        };
        nodes.sort_by(|a, b| a.id.cmp(&b.id));
        if !self.map_committed.load(Ordering::Acquire) {
            return self.bootstrap_placement(control, nodes);
        }
        if !self.migrations().is_empty() {
            return Vec::new();
        }
        let wanted: Vec<NodeId> = nodes.iter().map(|n| n.id.clone()).collect();
        let map = self.partitions();
        let mut placed: Vec<NodeId> = map.nodes().iter().map(|n| n.id.clone()).collect();
        placed.sort();
        let now = self.now_ms();
        let rf = map
            .replication_factor()
            .min(u8::try_from(nodes.len()).unwrap_or(u8::MAX));
        {
            let mut cp = control.lock().unwrap_or_else(PoisonError::into_inner);
            if cp.auto_rebalance_after_ms == 0
                || cp.raft.role() != Role::Leader
                || wanted == placed
                || nodes.is_empty()
            {
                cp.auto_rebalance = None;
                return Vec::new();
            }
            match &cp.auto_rebalance {
                Some((candidate, since)) if *candidate == wanted => {
                    if now < since + cp.auto_rebalance_after_ms {
                        return Vec::new();
                    }
                }
                _ => {
                    info!(
                        members = wanted.len(),
                        placed = placed.len(),
                        "membership differs from the placement; rebalancing if it stays this way"
                    );
                    cp.auto_rebalance = Some((wanted, now));
                    return Vec::new();
                }
            }
            cp.auto_rebalance = None;
        }
        info!(
            nodes = nodes.len(),
            replication_factor = rf,
            "proposing automatic rebalance"
        );
        let command = ControlCommand::SetNodes {
            nodes,
            replication_factor: rf,
        };
        match self.with_raft(|raft, _| match raft.propose(command) {
            Ok((_, out)) => ((), out),
            Err(_) => ((), Vec::new()),
        }) {
            Some(Ok(((), out))) => out,
            _ => Vec::new(),
        }
    }

    /// Proposes the first placement once every voter is a live member, on
    /// the control-plane leader, at most once per term. Without it an
    /// operator runs `celeris cluster rebalance` once. Blocking.
    fn bootstrap_placement(
        &self,
        control: &Mutex<ControlPlane>,
        nodes: Vec<NodeInfo>,
    ) -> Vec<Envelope<ControlCommand>> {
        let rf = {
            let mut cp = control.lock().unwrap_or_else(PoisonError::into_inner);
            let term = cp.raft.term();
            let all_voters_alive = cp.voters.iter().all(|v| nodes.iter().any(|n| &n.id == v));
            if cp.bootstrap_rf == 0
                || cp.raft.role() != Role::Leader
                || cp.bootstrap_term == Some(term)
                || !all_voters_alive
            {
                return Vec::new();
            }
            cp.bootstrap_term = Some(term);
            cp.bootstrap_rf
                .min(u8::try_from(nodes.len()).unwrap_or(u8::MAX))
        };
        info!(
            nodes = nodes.len(),
            replication_factor = rf,
            "every voter is up; proposing the first partition placement"
        );
        let command = ControlCommand::SetNodes {
            nodes,
            replication_factor: rf,
        };
        match self.with_raft(|raft, _| match raft.propose(command) {
            Ok((_, out)) => ((), out),
            Err(_) => ((), Vec::new()),
        }) {
            Some(Ok(((), out))) => out,
            _ => Vec::new(),
        }
    }

    /// Cluster address of a member, from the membership view.
    pub(crate) fn member_addr(&self, id: &NodeId) -> Option<String> {
        self.with_membership(|m, _| m.members().find(|x| &x.id == id).map(|x| x.addr.clone()))
            .flatten()
    }

    pub fn new(engine: Engine, id: NodeId, advertise: String, cors_origins: Vec<String>) -> Node {
        Node {
            engine: Arc::new(engine),
            partitions: RwLock::new(Arc::new(PartitionMap::single_node(id.clone()))),
            control: None,
            groups: RwLock::new(BTreeMap::new()),
            map_committed: AtomicBool::new(false),
            migrations: RwLock::new(Arc::new(BTreeMap::new())),
            migrating: AtomicBool::new(false),
            reconciling: AtomicBool::new(false),
            checking: AtomicBool::new(false),
            events: crate::events::new_bus(),
            anti_entropy: Mutex::new(BTreeMap::new()),
            anti_entropy_interval_ms: 0,
            id,
            advertise,
            started: Instant::now(),
            cors_origins,
            metrics: HttpMetrics::default(),
            shutdown: watch::channel(false).0,
            membership: None,
        }
    }

    /// Runs `f` on the membership state machine with this node's monotonic
    /// clock, and logs the resulting membership events. `None` in
    /// single-node mode.
    pub fn with_membership<R>(&self, f: impl FnOnce(&mut Membership, u64) -> R) -> Option<R> {
        let lock = self.membership.as_ref()?;
        let mut m = lock.lock().unwrap_or_else(PoisonError::into_inner);
        let now = u64::try_from(self.started.elapsed().as_millis()).unwrap_or(u64::MAX);
        let result = f(&mut m, now);
        for event in m.take_events() {
            log_event(&event);
        }
        Some(result)
    }

    /// (view epoch, members) of the cluster view, or `None` in single-node mode.
    pub fn cluster_members(&self) -> Option<(u64, Vec<Member>)> {
        self.with_membership(|m, _| (m.view_epoch(), m.members().cloned().collect()))
    }

    pub fn id(&self) -> &str {
        self.id.as_str()
    }

    pub fn advertise(&self) -> &str {
        &self.advertise
    }

    pub fn uptime(&self) -> Duration {
        self.started.elapsed()
    }

    pub fn cors_origins(&self) -> &[String] {
        &self.cors_origins
    }

    pub(crate) fn metrics(&self) -> &HttpMetrics {
        &self.metrics
    }

    /// Runs a storage call on the blocking pool; storage may fsync.
    pub async fn blocking<T, F>(&self, f: F) -> Result<T, JoinError>
    where
        F: FnOnce(&Engine) -> T + Send + 'static,
        T: Send + 'static,
    {
        let engine = Arc::clone(&self.engine);
        tokio::task::spawn_blocking(move || f(&engine)).await
    }

    /// Asks [`serve`] to stop accepting requests and shut down gracefully.
    pub fn request_shutdown(&self) {
        self.shutdown.send_replace(true);
    }

    fn shutdown_requested(&self) -> impl Future<Output = ()> + Send + 'static {
        let mut rx = self.shutdown.subscribe();
        async move {
            let _ = rx.wait_for(|stop| *stop).await;
        }
    }
}

/// The replica set (sorted) that currently serves partition `p`: the
/// migration source while it moves, otherwise the map's replicas.
fn serving_set(map: &PartitionMap, migrations: &Migrations, p: u16) -> Vec<NodeId> {
    if let Some(m) = migrations.get(&p) {
        return m.from.clone();
    }
    let Some(pid) = celeris_core::partition::PartitionId::new(p) else {
        return Vec::new();
    };
    let mut set: Vec<NodeId> = map.replica_ids(pid).into_iter().cloned().collect();
    set.sort();
    set
}

struct AbortOnDrop(tokio::task::JoinHandle<()>);

impl Drop for AbortOnDrop {
    fn drop(&mut self) {
        self.0.abort();
    }
}

fn log_event(event: &MembershipEvent) {
    match event {
        MembershipEvent::Discovered {
            id,
            state,
            incarnation,
        } => {
            info!(peer = %id, state = state.as_str(), incarnation, "cluster member discovered");
        }
        MembershipEvent::StateChanged {
            id,
            from,
            to,
            incarnation,
        } => {
            if *to == MemberState::Alive {
                info!(peer = %id, from = from.as_str(), to = to.as_str(), incarnation, "cluster member state changed");
            } else {
                warn!(peer = %id, from = from.as_str(), to = to.as_str(), incarnation, "cluster member state changed");
            }
        }
        MembershipEvent::Refuted { incarnation } => {
            warn!(incarnation, "refuted suspicion about this node");
        }
    }
}

/// Serves the API (and, with `cluster`, the membership protocol) until
/// `external` resolves or a shutdown is requested via the admin endpoint.
/// It then leaves the cluster, drains in-flight requests and closes storage.
pub async fn serve(
    node: Arc<Node>,
    listener: TcpListener,
    cluster: Option<TcpListener>,
    external: impl Future<Output = ()> + Send + 'static,
) -> anyhow::Result<()> {
    let app = crate::api::router(Arc::clone(&node));
    let internal = node.shutdown_requested();
    let (stop_cluster, cluster_stopped) = watch::channel(false);
    // If this future is dropped (task aborted), the gossip task must die
    // with it; otherwise a "stopped" node would keep heartbeating.
    let gossip = cluster.map(|l| {
        AbortOnDrop(tokio::spawn(crate::cluster::run(
            Arc::clone(&node),
            l,
            cluster_stopped,
        )))
    });
    let signal = async move {
        tokio::select! {
            () = external => {}
            () = internal => {}
        }
        info!("shutdown requested; draining in-flight requests");
        stop_cluster.send_replace(true);
    };
    axum::serve(
        listener,
        app.into_make_service_with_connect_info::<SocketAddr>(),
    )
    .with_graceful_shutdown(signal)
    .await
    .context("HTTP server failed")?;
    if let Some(mut gossip) = gossip {
        let _ = (&mut gossip.0).await;
    }
    // Closing the engine joins its background thread and syncs the WAL.
    tokio::task::spawn_blocking(move || drop(node))
        .await
        .context("closing storage")?;
    info!("node stopped");
    Ok(())
}

/// Persists and returns a fresh membership incarnation, one higher than the
/// last start. Refutation may raise the live incarnation further without
/// persisting it; that is safe, because a restarted node that finds a higher
/// record of itself in the cluster refutes it with an even higher one.
fn next_incarnation(dir: &Path) -> anyhow::Result<u64> {
    let path = dir.join(INCARNATION_FILE);
    let previous = match fs::read_to_string(&path) {
        Ok(text) => text
            .trim()
            .parse::<u64>()
            .with_context(|| format!("{} is not a number", path.display()))?,
        Err(e) if e.kind() == io::ErrorKind::NotFound => 0,
        Err(e) => return Err(e).with_context(|| format!("reading {}", path.display())),
    };
    let next = previous + 1;
    let tmp = dir.join(format!("{INCARNATION_FILE}.tmp"));
    fs::write(&tmp, format!("{next}\n"))
        .and_then(|()| fs::rename(&tmp, &path))
        .with_context(|| format!("writing {}", path.display()))?;
    Ok(next)
}

/// The node's identity is tied to its data, so it lives in the data directory.
/// `configured` (from `node.id`) must match an existing ID: a data directory
/// never silently changes identity.
fn load_or_create_node_id(dir: &Path, configured: Option<&str>) -> anyhow::Result<NodeId> {
    let path = dir.join(NODE_ID_FILE);
    match fs::read_to_string(&path) {
        Ok(text) => {
            let id = NodeId::new(text.trim())
                .with_context(|| format!("{} does not contain a valid node id", path.display()))?;
            if let Some(want) = configured {
                anyhow::ensure!(
                    id.as_str() == want,
                    "node.id `{want}` does not match `{id}` stored in {}",
                    path.display()
                );
            }
            Ok(id)
        }
        Err(e) if e.kind() == io::ErrorKind::NotFound => {
            let id = match configured {
                Some(want) => NodeId::new(want)?,
                None => NodeId::new(format!(
                    "node-{}",
                    &Uuid::new_v4().simple().to_string()[..12]
                ))?,
            };
            let tmp = dir.join(format!("{NODE_ID_FILE}.tmp"));
            fs::write(&tmp, format!("{id}\n"))
                .and_then(|()| fs::rename(&tmp, &path))
                .with_context(|| format!("writing {}", path.display()))?;
            info!(node_id = %id, "generated new node id");
            Ok(id)
        }
        Err(e) => Err(e).with_context(|| format!("reading {}", path.display())),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn node_id_is_generated_once_and_reused() {
        let dir = tempfile::tempdir().expect("tempdir");
        let first = load_or_create_node_id(dir.path(), None).expect("create");
        assert!(first.as_str().starts_with("node-"));
        assert_eq!(
            load_or_create_node_id(dir.path(), None).expect("reload"),
            first
        );
        assert!(
            load_or_create_node_id(dir.path(), Some("other")).is_err(),
            "identity cannot change"
        );
        fs::write(dir.path().join(NODE_ID_FILE), "bad id!\n").expect("write");
        assert!(load_or_create_node_id(dir.path(), None).is_err());

        let fresh = tempfile::tempdir().expect("tempdir");
        let named = load_or_create_node_id(fresh.path(), Some("n1")).expect("create");
        assert_eq!(named.as_str(), "n1");
    }

    #[test]
    fn raft_state_persists_atomically_and_is_versioned() {
        let dir = tempfile::tempdir().expect("tempdir");
        let path = dir.path().join(RAFT_DIR).join(RAFT_STATE_FILE);
        let (empty, _) = load_raft_state(&path).expect("missing file is empty state");
        assert_eq!(empty.term, 0);
        let state = PersistentState {
            term: 7,
            voted_for: Some(NodeId::new("n2").expect("id")),
            log: vec![celeris_cluster::raft::LogEntry {
                term: 7,
                index: 1,
                command: None,
            }],
            ..PersistentState::default()
        };
        store_raft_state(&path, &state, 1).expect("store");
        assert_eq!(load_raft_state(&path).expect("load"), (state, 1));
        fs::write(
            &path,
            r#"{"format_version":9,"state":{"term":0,"voted_for":null,"log":[]}}"#,
        )
        .expect("write");
        assert!(load_raft_state(&path).is_err());
    }

    #[test]
    fn incarnation_increases_on_every_start() {
        let dir = tempfile::tempdir().expect("tempdir");
        assert_eq!(next_incarnation(dir.path()).expect("first"), 1);
        assert_eq!(next_incarnation(dir.path()).expect("second"), 2);
        fs::write(dir.path().join(INCARNATION_FILE), "garbage").expect("write");
        assert!(next_incarnation(dir.path()).is_err());
    }
}
