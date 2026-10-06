//! The data path in replicated (cluster) mode: requests go through the
//! Raft replication group that owns the key's partition.
//!
//! | Request | Path |
//! |---|---|
//! | write (any mode) | group leader proposes; ack after commit + apply |
//! | `strict` / `bounded` read | leader commits a read barrier, then reads locally (linearizable) |
//! | `session` read | any replica whose applied index ≥ the client's `celeris-session-index` |
//! | `available` / `eventual` read | any replica, local state (may be stale) |
//!
//! Writes in `available`/`eventual` mode currently take the same quorum path
//! as `strict`, which is stronger than requested, never weaker. Leaderless
//! multi-writer availability is milestone M6.

use std::ops::Bound;
use std::sync::Arc;
use std::time::Duration;

use axum::http::{HeaderMap, StatusCode};
use celeris_core::partition::NodeId;
use celeris_core::{Consistency, MutationId};
use celeris_storage::{Clock, Record, SystemClock, WriteOutcome};
use serde_json::json;
use tokio::sync::oneshot;

use crate::error::ApiError;
use crate::groups::{Applied, DataCommand, PartitionState, Proposed, ReplicaGroup, WireOp};
use crate::node::{GroupLookup, Node};
use crate::query::{Filter, FilteredScan, merge_parts};

/// Applied log index of the replication group. Returned on writes; sent
/// back on `session` reads to get read-your-writes from any replica.
pub const SESSION_HEADER: &str = "celeris-session-index";
const COMMIT_TIMEOUT: Duration = Duration::from_secs(5);

pub(crate) fn group_for(node: &Node, keys: &[&str]) -> Result<Arc<ReplicaGroup>, ApiError> {
    match node.resolve_group(keys) {
        GroupLookup::Group(group) => Ok(group),
        GroupLookup::NoMap => Err(ApiError::new(
            StatusCode::SERVICE_UNAVAILABLE,
            "no_partition_map",
            "the control plane has not committed a partition map yet (run `celeris cluster rebalance`)",
        )),
        GroupLookup::CrossGroup => Err(ApiError::bad_request(
            "cross_group_batch",
            "all keys of a batch must belong to partitions with the same replica set",
        )),
        GroupLookup::NotMember(route) => Err(ApiError::new(
            StatusCode::MISDIRECTED_REQUEST,
            "not_owner",
            format!(
                "this node holds no replica of partition {}",
                route.partition
            ),
        )
        .with_detail("partition", json!(route.partition))
        .with_detail("replicas", json!(route.replicas))
        .with_detail("leader", json!(route.replicas.first()))),
    }
}

/// A write hit a partition whose data is moving between replica sets.
fn partition_moving(p: u16) -> ApiError {
    ApiError::new(
        StatusCode::SERVICE_UNAVAILABLE,
        "partition_moving",
        format!(
            "partition {p} is moving to new replicas; the write was not applied, retry shortly"
        ),
    )
    .with_detail("partition", json!(p))
}

fn not_leader(group: &ReplicaGroup, leader: Option<NodeId>) -> ApiError {
    let message = match &leader {
        Some(l) => {
            format!("this replica is not the leader of its replication group; retry on `{l}`")
        }
        None => "the replication group has no known leader yet; retry shortly".to_owned(),
    };
    ApiError::new(StatusCode::MISDIRECTED_REQUEST, "not_leader", message)
        .with_detail("leader", json!(leader))
        .with_detail("replicas", json!(group.members()))
}

pub(crate) async fn propose(
    node: &Arc<Node>,
    group: &Arc<ReplicaGroup>,
    command: DataCommand,
) -> Result<(u64, oneshot::Receiver<Applied>), ApiError> {
    let worker = Arc::clone(group);
    let now = node.now_ms();
    let proposed = tokio::task::spawn_blocking(move || worker.propose(now, command))
        .await
        .map_err(|e| ApiError::internal(format!("proposal task failed: {e}")))?
        .map_err(|e| {
            ApiError::new(
                StatusCode::SERVICE_UNAVAILABLE,
                "replica_failed",
                format!("{e:#}"),
            )
        })?;
    match proposed {
        Proposed::NotLeader(leader) => Err(not_leader(group, leader)),
        Proposed::Accepted { index, done, out } => {
            crate::cluster::send_group(node, group, out);
            Ok((index, done))
        }
    }
}

/// A committed write and the group index it committed at.
#[derive(Debug)]
pub(crate) struct Written {
    pub outcome: WriteOutcome,
    pub session_token: String,
}

/// Session token: the group's applied index, scoped to the group
/// (`<index>@<group>`), since indices of different groups don't compare.
fn session_token(group: &ReplicaGroup, index: u64) -> String {
    format!("{index}@{}", group.id())
}

/// Replicates a batch; returns once a majority committed it and this
/// leader applied it.
pub(crate) async fn write(
    node: &Arc<Node>,
    ops: Vec<WireOp>,
    id: MutationId,
) -> Result<Written, ApiError> {
    let keys: Vec<&str> = ops.iter().map(WireOp::key).collect();
    let group = group_for(node, &keys)?;
    let command = DataCommand::Write {
        mutation_id: id.to_string(),
        ops,
        now_ms: SystemClock.now_ms(),
    };
    let (index, done) = propose(node, &group, command).await?;
    match tokio::time::timeout(COMMIT_TIMEOUT, done).await {
        Ok(Ok(Applied::Write(Ok(outcome)))) => Ok(Written {
            outcome,
            session_token: session_token(&group, index),
        }),
        Ok(Ok(Applied::Write(Err(e)))) => Err(ApiError::storage(e, Some(id))),
        Ok(Ok(Applied::Lost)) => Err(ApiError::new(
            StatusCode::SERVICE_UNAVAILABLE,
            "proposal_lost",
            "leadership changed before the write committed; it was not applied",
        )
        .write_failure()
        .with_detail("mutation_id", json!(id.to_string()))),
        Ok(Ok(Applied::Moving(p))) => Err(partition_moving(p)
            .write_failure()
            .with_detail("mutation_id", json!(id.to_string()))),
        Ok(Ok(Applied::Barrier | Applied::Migration(_))) => {
            Err(ApiError::internal("write resolved as another command"))
        }
        Ok(Err(_)) | Err(_) => Err(ApiError::outcome_unknown(
            id,
            "the write was not confirmed in time and may still commit; retry with the same mutation ID or check /v1/mutations/{id}",
        )),
    }
}

/// Reads `key` with the requested consistency. Returns the record (if
/// any) and a session token for the replica's applied state.
pub(crate) async fn read(
    node: &Arc<Node>,
    key: &str,
    mode: Consistency,
    headers: &HeaderMap,
) -> Result<(Option<Record>, String), ApiError> {
    let group = group_for(node, &[key])?;
    let mut barrier = matches!(mode, Consistency::Strict | Consistency::Bounded);
    if mode == Consistency::Session
        && let Some(raw) = headers.get(SESSION_HEADER)
    {
        let invalid = || {
            ApiError::bad_request(
                "invalid_argument",
                "celeris-session-index must be `<index>` or `<index>@<group>`",
            )
        };
        let raw = raw.to_str().map_err(|_| invalid())?;
        let (index, scope) = match raw.split_once('@') {
            Some((i, g)) => (i, Some(g)),
            None => (raw, None),
        };
        let required: u64 = index.parse().map_err(|_| invalid())?;
        if scope.is_some_and(|g| g != group.id()) {
            // The token comes from another group (the partition moved):
            // only a leader read is sure to include the session's writes.
            barrier = true;
        } else {
            let applied = group.applied_index();
            if applied < required {
                return Err(ApiError::new(
                    StatusCode::SERVICE_UNAVAILABLE,
                    "session_behind",
                    "this replica has not applied your session's writes yet; retry or read from the leader",
                )
                .with_detail("applied_index", json!(applied))
                .with_detail("required_index", json!(required))
                .with_detail("leader", json!(group.leader())));
            }
        }
    }
    if barrier {
        let (_, done) = propose(node, &group, DataCommand::Barrier).await?;
        match tokio::time::timeout(COMMIT_TIMEOUT, done).await {
            Ok(Ok(Applied::Barrier)) => {}
            Ok(Ok(_)) => {
                return Err(ApiError::new(
                    StatusCode::SERVICE_UNAVAILABLE,
                    "read_retry",
                    "leadership changed during the read; retry",
                ));
            }
            Ok(Err(_)) | Err(_) => {
                return Err(ApiError::new(
                    StatusCode::SERVICE_UNAVAILABLE,
                    "read_timeout",
                    "could not confirm leadership with a majority in time",
                ));
            }
        }
    }
    let partition = celeris_core::partition::partition_for(key.as_bytes()).get();
    let engine = group.engine();
    let lookup = key.as_bytes().to_vec();
    let record = tokio::task::spawn_blocking(move || engine.get(&lookup))
        .await
        .map_err(|e| ApiError::internal(format!("read task failed: {e}")))?
        .map_err(|e| ApiError::storage(e, None))?;
    // Checked after the read: once released, this group's copy is gone or
    // no longer authoritative.
    if group.partition_state(partition) == Some(PartitionState::Released) {
        let route = node.partitions().route(key.as_bytes());
        return Err(ApiError::new(
            StatusCode::MISDIRECTED_REQUEST,
            "partition_moved",
            format!("partition {partition} has moved to new replicas"),
        )
        .with_detail("partition", json!(partition))
        .with_detail("replicas", json!(route.replicas)));
    }
    Ok((record, session_token(&group, group.applied_index())))
}
/// Finds the commit version of a mutation in any local replication group.
pub(crate) async fn mutation_status(
    node: &Arc<Node>,
    id: MutationId,
) -> Result<Option<u64>, ApiError> {
    for group in node.groups() {
        let engine = group.engine();
        let status = tokio::task::spawn_blocking(move || engine.mutation_status(id))
            .await
            .map_err(|e| ApiError::internal(format!("lookup task failed: {e}")))?
            .map_err(|e| ApiError::storage(e, None))?;
        if status.is_some() {
            return Ok(status);
        }
    }
    Ok(None)
}

/// A key range and page size for a scan, as sent between nodes.
#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
pub(crate) struct ScanRange {
    pub lo: WireBound,
    pub hi: WireBound,
    /// Records wanted (the caller asks for one more than it returns).
    pub limit: usize,
}

#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "snake_case")]
pub(crate) enum WireBound {
    Unbounded,
    Included(String),
    Excluded(String),
}

impl WireBound {
    pub(crate) fn from_bound(b: &Bound<Vec<u8>>) -> Self {
        match b {
            Bound::Unbounded => WireBound::Unbounded,
            Bound::Included(k) => WireBound::Included(String::from_utf8_lossy(k).into_owned()),
            Bound::Excluded(k) => WireBound::Excluded(String::from_utf8_lossy(k).into_owned()),
        }
    }

    fn to_bound(&self) -> Bound<Vec<u8>> {
        match self {
            WireBound::Unbounded => Bound::Unbounded,
            WireBound::Included(k) => Bound::Included(k.clone().into_bytes()),
            WireBound::Excluded(k) => Bound::Excluded(k.clone().into_bytes()),
        }
    }
}

/// A record as sent between nodes (keys and values are UTF-8 by API rule).
#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
pub(crate) struct WireRecord {
    pub key: String,
    pub value: String,
    pub version: u64,
    pub timestamp_ms: u64,
    pub expires_at_ms: Option<u64>,
    pub mutation_id: String,
}

impl WireRecord {
    fn from_record(r: Record) -> Self {
        WireRecord {
            key: String::from_utf8_lossy(&r.key).into_owned(),
            value: String::from_utf8_lossy(&r.value).into_owned(),
            version: r.version,
            timestamp_ms: r.timestamp_ms,
            expires_at_ms: r.expires_at_ms,
            mutation_id: r.mutation_id.to_string(),
        }
    }

    pub(crate) fn into_record(self) -> Record {
        Record {
            key: self.key.into_bytes(),
            value: self.value.into_bytes(),
            version: self.version,
            timestamp_ms: self.timestamp_ms,
            expires_at_ms: self.expires_at_ms,
            mutation_id: self
                .mutation_id
                .parse()
                .unwrap_or_else(|_| MutationId::from_u128(0)),
        }
    }
}

/// Commits a read barrier through `group`, proving this replica leads it
/// and has applied everything committed before the read.
async fn confirm_leader(node: &Arc<Node>, group: &Arc<ReplicaGroup>) -> anyhow::Result<()> {
    let (_, done) = propose(node, group, DataCommand::Barrier)
        .await
        .map_err(|_| anyhow::anyhow!("this replica is not the leader of group {}", group.id()))?;
    match tokio::time::timeout(COMMIT_TIMEOUT, done).await {
        Ok(Ok(Applied::Barrier)) => Ok(()),
        _ => anyhow::bail!("could not confirm leadership of group {}", group.id()),
    }
}

/// Partitions `group` serves now. Its engine can also hold rows of
/// partitions being imported or not yet purged; reads skip those.
fn served_partitions(node: &Node, group: &ReplicaGroup) -> std::collections::BTreeSet<u16> {
    node.serving_groups()
        .remove(group.id())
        .map(|(_, partitions)| partitions.into_iter().collect())
        .unwrap_or_default()
}

/// This replica's part of a scan for `group`: the first `limit` records in
/// the range among the partitions the group currently serves. `strict`
/// requires the leader and a read barrier first.
pub(crate) async fn local_group_scan(
    node: &Arc<Node>,
    group: &Arc<ReplicaGroup>,
    range: &ScanRange,
    strict: bool,
) -> anyhow::Result<Vec<WireRecord>> {
    if strict {
        confirm_leader(node, group).await?;
    }
    let served = served_partitions(node, group);
    let engine = group.engine();
    let (mut lo, hi, limit) = (range.lo.to_bound(), range.hi.to_bound(), range.limit);
    tokio::task::spawn_blocking(move || {
        // Records of partitions served elsewhere (being imported, or not
        // yet purged) are skipped, so keep reading until the page is full.
        let mut out = Vec::new();
        loop {
            let batch = engine.scan(
                lo.as_ref().map(Vec::as_slice),
                hi.as_ref().map(Vec::as_slice),
                limit.max(64),
            )?;
            let done = batch.len() < limit.max(64);
            let last = batch.last().map(|r| r.key.clone());
            for r in batch {
                let p = celeris_core::partition::partition_for(&r.key).get();
                if served.contains(&p) {
                    out.push(WireRecord::from_record(r));
                    if out.len() >= limit {
                        return Ok(out);
                    }
                }
            }
            match last {
                Some(k) if !done => lo = Bound::Excluded(k),
                _ => return Ok(out),
            }
        }
    })
    .await?
}

/// A scan over the whole cluster: every serving group contributes its
/// first `limit` records in the range, and the merged page is sorted by
/// key. Strict scans need every group's leader; other modes read any
/// replica and report `partial` if some group could not be reached.
pub(crate) async fn scan(
    node: &Arc<Node>,
    range: ScanRange,
    mode: Consistency,
) -> Result<(Vec<Record>, bool), ApiError> {
    if let GroupLookup::NoMap = node.resolve_group(&[]) {
        return Err(ApiError::new(
            StatusCode::SERVICE_UNAVAILABLE,
            "no_partition_map",
            "the control plane has not committed a partition map yet (run `celeris cluster rebalance`)",
        ));
    }
    let strict = !matches!(mode, Consistency::Available | Consistency::Eventual);
    let mut tasks = tokio::task::JoinSet::new();
    for (gid, (members, _)) in node.serving_groups() {
        let (node, range) = (Arc::clone(node), range.clone());
        tasks.spawn(async move { group_scan(&node, &gid, &members, &range, strict).await });
    }
    let mut records = Vec::new();
    let mut failures = Vec::new();
    while let Some(joined) = tasks.join_next().await {
        match joined {
            Ok(Ok(part)) => records.extend(part.into_iter().map(WireRecord::into_record)),
            Ok(Err(e)) => failures.push(format!("{e:#}")),
            Err(e) => failures.push(e.to_string()),
        }
    }
    if strict && !failures.is_empty() {
        return Err(ApiError::new(
            StatusCode::SERVICE_UNAVAILABLE,
            "scan_incomplete",
            "some replication groups could not serve a consistent scan; retry",
        )
        .with_detail("errors", json!(failures)));
    }
    records.sort_by(|a, b| a.key.cmp(&b.key));
    records.truncate(range.limit);
    Ok((records, !failures.is_empty()))
}

/// Gets one group's part of a scan: locally when this node can serve it,
/// otherwise from the group's leader or any member.
async fn group_scan(
    node: &Arc<Node>,
    gid: &str,
    members: &[NodeId],
    range: &ScanRange,
    strict: bool,
) -> anyhow::Result<Vec<WireRecord>> {
    let mut leader = None;
    if let Some(group) = node.group(gid) {
        let (role, _, known_leader, _, _) = group.status();
        if !strict || role == celeris_cluster::raft::Role::Leader {
            return local_group_scan(node, &group, range, strict).await;
        }
        leader = known_leader;
    }
    let mut candidates: Vec<&NodeId> = members.iter().filter(|m| *m != node.node_id()).collect();
    if let Some(l) = &leader {
        candidates.sort_by_key(|m| *m != l);
    }
    let request = crate::cluster::RpcRequest::Scan {
        group: gid.to_owned(),
        range: range.clone(),
        strict,
    };
    let mut last_error = anyhow::anyhow!("no reachable replica of group {gid}");
    for member in candidates {
        let Some(addr) = node.member_addr(member) else {
            continue;
        };
        match crate::cluster::rpc(&addr, &request, Duration::from_secs(10)).await {
            Ok(records) => return Ok(records),
            Err(e) => last_error = e,
        }
    }
    Err(last_error)
}

/// A filtered query as sent between nodes (D-030). The filter travels as
/// its JSON document and is parsed again by the replica.
#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
pub(crate) struct QueryRange {
    pub lo: WireBound,
    pub hi: WireBound,
    pub filter: Option<serde_json::Value>,
    pub limit: usize,
    pub max_scanned: usize,
}

/// One group's answer to a query.
#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
pub(crate) struct WireQueryPart {
    pub records: Vec<WireRecord>,
    pub resume: Option<String>,
    pub scanned: usize,
}

impl WireQueryPart {
    fn into_scan(self) -> FilteredScan {
        FilteredScan {
            records: self
                .records
                .into_iter()
                .map(WireRecord::into_record)
                .collect(),
            resume: self.resume.map(String::into_bytes),
            scanned: self.scanned,
        }
    }
}

/// This replica's part of a query for `group`: like a scan, but filtered
/// here and bounded by `max_scanned` rows.
pub(crate) async fn local_group_query(
    node: &Arc<Node>,
    group: &Arc<ReplicaGroup>,
    range: &QueryRange,
    strict: bool,
) -> anyhow::Result<WireQueryPart> {
    let filter = range
        .filter
        .as_ref()
        .map(Filter::parse)
        .transpose()
        .map_err(|e| anyhow::anyhow!("invalid filter: {e}"))?;
    if strict {
        confirm_leader(node, group).await?;
    }
    let served = served_partitions(node, group);
    let engine = group.engine();
    let (lo, hi) = (range.lo.to_bound(), range.hi.to_bound());
    let (limit, max_scanned) = (range.limit, range.max_scanned);
    let part = tokio::task::spawn_blocking(move || {
        crate::query::filtered_scan(&engine, lo, hi, filter.as_ref(), limit, max_scanned, |r| {
            served.contains(&celeris_core::partition::partition_for(&r.key).get())
        })
    })
    .await??;
    Ok(WireQueryPart {
        records: part
            .records
            .into_iter()
            .map(WireRecord::from_record)
            .collect(),
        resume: part
            .resume
            .map(|k| String::from_utf8_lossy(&k).into_owned()),
        scanned: part.scanned,
    })
}

/// A query over the whole cluster: every serving group filters its part of
/// the range, and the parts are merged so no key is skipped between pages.
pub(crate) async fn query(
    node: &Arc<Node>,
    range: QueryRange,
    mode: Consistency,
) -> Result<(FilteredScan, bool), ApiError> {
    if let GroupLookup::NoMap = node.resolve_group(&[]) {
        return Err(ApiError::new(
            StatusCode::SERVICE_UNAVAILABLE,
            "no_partition_map",
            "the control plane has not committed a partition map yet (run `celeris cluster rebalance`)",
        ));
    }
    let strict = !matches!(mode, Consistency::Available | Consistency::Eventual);
    let limit = range.limit;
    let mut tasks = tokio::task::JoinSet::new();
    for (gid, (members, _)) in node.serving_groups() {
        let (node, range) = (Arc::clone(node), range.clone());
        tasks.spawn(async move { group_query(&node, &gid, &members, &range, strict).await });
    }
    let mut parts = Vec::new();
    let mut failures = Vec::new();
    while let Some(joined) = tasks.join_next().await {
        match joined {
            Ok(Ok(part)) => parts.push(part.into_scan()),
            Ok(Err(e)) => failures.push(format!("{e:#}")),
            Err(e) => failures.push(e.to_string()),
        }
    }
    if strict && !failures.is_empty() {
        return Err(ApiError::new(
            StatusCode::SERVICE_UNAVAILABLE,
            "query_incomplete",
            "some replication groups could not serve a consistent query; retry",
        )
        .with_detail("errors", json!(failures)));
    }
    Ok((merge_parts(parts, limit), !failures.is_empty()))
}

/// Gets one group's part of a query: locally when this node can serve it,
/// otherwise from the group's leader or any member.
async fn group_query(
    node: &Arc<Node>,
    gid: &str,
    members: &[NodeId],
    range: &QueryRange,
    strict: bool,
) -> anyhow::Result<WireQueryPart> {
    let mut leader = None;
    if let Some(group) = node.group(gid) {
        let (role, _, known_leader, _, _) = group.status();
        if !strict || role == celeris_cluster::raft::Role::Leader {
            return local_group_query(node, &group, range, strict).await;
        }
        leader = known_leader;
    }
    let mut candidates: Vec<&NodeId> = members.iter().filter(|m| *m != node.node_id()).collect();
    if let Some(l) = &leader {
        candidates.sort_by_key(|m| *m != l);
    }
    let request = crate::cluster::RpcRequest::Query {
        group: gid.to_owned(),
        range: range.clone(),
        strict,
    };
    let mut last_error = anyhow::anyhow!("no reachable replica of group {gid}");
    for member in candidates {
        let Some(addr) = node.member_addr(member) else {
            continue;
        };
        match crate::cluster::rpc(&addr, &request, Duration::from_secs(10)).await {
            Ok(part) => return Ok(part),
            Err(e) => last_error = e,
        }
    }
    Err(last_error)
}

/// Clears a key's recorded conflicts through its group leader.
pub(crate) async fn clear_conflicts(node: &Arc<Node>, key: &str) -> Result<(), ApiError> {
    let group = group_for(node, &[key])?;
    let command = DataCommand::ClearConflicts {
        key: key.to_owned(),
        mutation_id: MutationId::random().to_string(),
        now_ms: SystemClock.now_ms(),
    };
    let (_, done) = propose(node, &group, command).await?;
    match tokio::time::timeout(COMMIT_TIMEOUT, done).await {
        Ok(Ok(Applied::Migration(Ok(())) | Applied::Write(Ok(_)))) => Ok(()),
        Ok(Ok(Applied::Migration(Err(e)) | Applied::Write(Err(e)))) => {
            Err(ApiError::storage(e, None))
        }
        _ => Err(ApiError::new(
            StatusCode::SERVICE_UNAVAILABLE,
            "not_confirmed",
            "clearing the conflicts was not confirmed in time; retry (it is idempotent)",
        )),
    }
}
