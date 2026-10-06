//! Anti-entropy: periodic verification that every replica of a group holds
//! the same data, with repair of the ones that don't (D-023).
//!
//! Raft keeps replicas identical as long as storage behaves. Anti-entropy
//! is the check that it did, catching disk corruption, bugs and operator
//! accidents. The group leader commits a `Digest` entry. Every replica,
//! applying it at the same log position, hashes its data into
//! per-partition digests: the leaves of a two-level Merkle tree. The
//! leader then fetches the digests and compares them.
//!
//! If the leader agrees with a majority, every member that disagrees is
//! repaired: it is told to accept the leader's state and sent a snapshot.
//! If the leader itself is in the minority, nothing is repaired
//! automatically, since the source of truth is in doubt. The problem is
//! reported in `/v1/status` and the logs.

use std::collections::{BTreeMap, BTreeSet};
use std::sync::Arc;
use std::time::Duration;

use celeris_cluster::raft::Role;
use celeris_core::partition::NodeId;
use celeris_storage::{Clock, SystemClock};
use serde::Serialize;
use tracing::{error, info, warn};

use crate::cluster::{RpcRequest, push_snapshot, rpc};
use crate::groups::{Applied, DataCommand, ReplicaGroup, digest_root};
use crate::node::Node;
use crate::replicated::propose;

const RPC_TIMEOUT: Duration = Duration::from_secs(5);

/// Outcome of the latest check of one group.
#[derive(Debug, Clone, Serialize)]
pub struct Report {
    /// Node clock (ms since start) of the check.
    pub at_ms: u64,
    /// Members whose digest was compared, including the leader.
    pub compared: Vec<NodeId>,
    /// Members that did not answer in time.
    pub missing: Vec<NodeId>,
    /// Members whose data differed from the majority (repair requested).
    pub diverged: Vec<NodeId>,
    /// Number of partitions that differed, over all diverged members.
    pub partitions_differing: usize,
    /// The leader itself is in the minority: not repaired automatically.
    pub leader_diverged: bool,
}

/// Checks every group this node leads.
pub(crate) async fn check(node: &Arc<Node>) {
    for group in node.groups() {
        if group.status().0 != Role::Leader {
            continue;
        }
        if let Some(report) = check_group(node, &group).await {
            node.record_anti_entropy(group.id(), report);
        }
    }
}

async fn check_group(node: &Arc<Node>, group: &Arc<ReplicaGroup>) -> Option<Report> {
    let id = uuid::Uuid::new_v4().to_string();
    let command = DataCommand::Digest {
        id: id.clone(),
        now_ms: SystemClock.now_ms(),
    };
    let (_, done) = propose(node, group, command).await.ok()?;
    match tokio::time::timeout(RPC_TIMEOUT, done).await {
        Ok(Ok(Applied::Barrier)) => {}
        _ => return None,
    }
    let mine = group.digest(&id)?;
    let mut digests: BTreeMap<NodeId, BTreeMap<u16, u64>> = BTreeMap::new();
    digests.insert(node.node_id().clone(), mine);
    let mut missing = Vec::new();
    for member in group.members().iter().filter(|m| *m != node.node_id()) {
        match fetch_digest(node, group, member, &id).await {
            Some(d) => {
                digests.insert(member.clone(), d);
            }
            None => missing.push(member.clone()),
        }
    }

    // The digest held by a majority of the whole group, if any.
    let mut votes: BTreeMap<u64, Vec<NodeId>> = BTreeMap::new();
    for (member, d) in &digests {
        votes
            .entry(digest_root(d))
            .or_default()
            .push(member.clone());
    }
    let quorum = group.members().len() / 2 + 1;
    let majority = votes
        .iter()
        .find(|(_, members)| members.len() >= quorum)
        .map(|(root, _)| *root);
    let reference = digests[node.node_id()].clone();
    let mut report = Report {
        at_ms: node.now_ms(),
        compared: digests.keys().cloned().collect(),
        missing,
        diverged: Vec::new(),
        partitions_differing: 0,
        leader_diverged: false,
    };
    let Some(majority) = majority else {
        if votes.len() > 1 {
            warn!(
                group = group.id(),
                "replica digests differ and no majority agrees"
            );
        }
        return Some(report);
    };
    if majority != digest_root(&reference) {
        error!(
            group = group.id(),
            "this leader's data differs from the majority of its replicas; not repairing automatically"
        );
        report.leader_diverged = true;
        return Some(report);
    }
    for (member, d) in &digests {
        if digest_root(d) == majority {
            continue;
        }
        let differing = reference
            .keys()
            .chain(d.keys())
            .collect::<BTreeSet<_>>()
            .into_iter()
            .filter(|p| reference.get(p) != d.get(p))
            .count();
        error!(group = group.id(), %member, partitions = differing, "replica data diverged; repairing from the leader");
        report.partitions_differing += differing;
        report.diverged.push(member.clone());
        repair(node, group, member).await;
    }
    if report.diverged.is_empty() {
        info!(
            group = group.id(),
            replicas = report.compared.len(),
            "anti-entropy check passed"
        );
    }
    Some(report)
}

/// A member's digest for `id`, retried briefly while it catches up.
async fn fetch_digest(
    node: &Arc<Node>,
    group: &ReplicaGroup,
    member: &NodeId,
    id: &str,
) -> Option<BTreeMap<u16, u64>> {
    let addr = node.member_addr(member)?;
    let request = RpcRequest::Digest {
        group: group.id().to_owned(),
        id: id.to_owned(),
    };
    for _ in 0..10 {
        match rpc::<Option<BTreeMap<u16, u64>>>(node, &addr, &request, RPC_TIMEOUT).await {
            Ok(Some(d)) => return Some(d),
            Ok(None) => tokio::time::sleep(Duration::from_millis(200)).await,
            Err(_) => return None,
        }
    }
    None
}

async fn repair(node: &Arc<Node>, group: &Arc<ReplicaGroup>, member: &NodeId) {
    let Some(addr) = node.member_addr(member) else {
        return;
    };
    let request = RpcRequest::Repair {
        group: group.id().to_owned(),
    };
    if rpc::<()>(node, &addr, &request, RPC_TIMEOUT).await.is_ok() {
        push_snapshot(
            Arc::clone(node),
            Arc::clone(group),
            member.clone(),
            addr,
            true,
        )
        .await;
    }
}
