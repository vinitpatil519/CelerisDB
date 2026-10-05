//! `available` and `eventual` writes in replicated mode (D-023).
//!
//! A replica that leads the key's group commits the write through Raft at
//! once, like any write. Any other node accepts it without coordination:
//! it stores the write durably in its local *pending log* and answers
//! `202 Accepted`. The write is acknowledged, but not yet replicated. A
//! background reconciler keeps offering each pending write to the group
//! leader until it is committed as an `AvailableWrite`.
//!
//! Committing resolves the write per key with last-writer-wins on
//! (timestamp, mutation ID). A losing write is never dropped silently: it
//! becomes a recorded conflict, listed by `GET /v1/conflicts`.
//!
//! The accepting node gives the write a hybrid timestamp. It is never
//! behind its clock, and never behind any version or pending write it
//! holds for the same keys. A client that read a value from this node
//! and then wrote through it therefore wins over that value, whatever the
//! clock skew between nodes.

use std::sync::Arc;
use std::time::Duration;

use axum::http::StatusCode;
use celeris_cluster::raft::Role;
use celeris_core::MutationId;
use celeris_core::partition::NodeId;
use celeris_storage::{Clock, SystemClock};
use serde::{Deserialize, Serialize};
use serde_json::json;
use tracing::{debug, warn};

use crate::cluster::{RpcRequest, rpc};
use crate::error::ApiError;
use crate::groups::{Applied, Conflict, DataCommand, Observed, WireOp, group_id};
use crate::node::{GroupLookup, Node};
use crate::replicated::propose;

/// Key prefix of the pending log in the node's local engine.
const PENDING_PREFIX: &str = "pending/";
/// Pending writes offered per reconciliation pass.
const RECONCILE_BATCH: usize = 256;
const FORWARD_TIMEOUT: Duration = Duration::from_secs(6);

/// A write accepted locally and not yet committed by its group.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub(crate) struct Pending {
    pub mutation_id: String,
    pub ops: Vec<WireOp>,
    pub timestamp_ms: u64,
    pub origin: String,
    /// Per op, the version of the key this node had seen when accepting.
    #[serde(default)]
    pub observed: Vec<Option<Observed>>,
}

impl Pending {
    fn storage_key(&self) -> String {
        format!(
            "{PENDING_PREFIX}{:020}/{}",
            self.timestamp_ms, self.mutation_id
        )
    }

    fn command(&self) -> DataCommand {
        DataCommand::AvailableWrite {
            mutation_id: self.mutation_id.clone(),
            ops: self.ops.clone(),
            timestamp_ms: self.timestamp_ms,
            origin: self.origin.clone(),
            observed: self.observed.clone(),
        }
    }
}

/// How an `available` write was taken.
pub(crate) enum Accepted {
    /// This node leads the group: committed through Raft.
    Committed(crate::replicated::Written),
    /// Stored in this node's pending log; replication follows.
    Pending { timestamp_ms: u64 },
}

/// Takes an `available`/`eventual` write.
pub(crate) async fn write(
    node: &Arc<Node>,
    ops: Vec<WireOp>,
    id: MutationId,
) -> Result<Accepted, ApiError> {
    if ops.iter().any(WireOp::is_conditional) {
        return Err(ApiError::bad_request(
            "conditions_require_strict",
            "if_version / if_absent need `strict` consistency; under `available`, concurrent writes resolve by last-writer-wins",
        ));
    }
    let keys: Vec<&str> = ops.iter().map(WireOp::key).collect();
    let local_group = match node.resolve_group(&keys) {
        GroupLookup::NoMap => {
            return Err(ApiError::new(
                StatusCode::SERVICE_UNAVAILABLE,
                "no_partition_map",
                "the control plane has not committed a partition map yet (run `celeris cluster rebalance`)",
            ));
        }
        GroupLookup::CrossGroup => {
            return Err(ApiError::bad_request(
                "cross_group_batch",
                "all keys of a batch must belong to partitions with the same replica set",
            ));
        }
        GroupLookup::NotMember(_) => None,
        GroupLookup::Group(group) => Some(group),
    };
    if let Some(group) = &local_group
        && group.status().0 == Role::Leader
    {
        // The strong path is available right here; take it.
        return crate::replicated::write(node, ops, id)
            .await
            .map(Accepted::Committed);
    }

    // What this node has seen of each key: its newest pending write for
    // the key, else the replica's stored version. The hybrid timestamp is
    // not behind the clock nor any of these.
    let mut observed: Vec<Option<Observed>> = vec![None; keys.len()];
    if let Some(group) = &local_group {
        let engine = group.engine();
        let owned: Vec<String> = keys.iter().map(|k| (*k).to_owned()).collect();
        observed = tokio::task::spawn_blocking(move || {
            owned
                .iter()
                .map(|k| {
                    engine
                        .latest(k.as_bytes())
                        .ok()
                        .flatten()
                        .map(|l| Observed {
                            timestamp_ms: l.timestamp_ms,
                            mutation_id: l.mutation_id.to_string(),
                        })
                })
                .collect()
        })
        .await
        .map_err(|e| ApiError::internal(format!("lookup task failed: {e}")))?;
    }
    for p in pending(node, usize::MAX).await? {
        for op in &p.ops {
            if let Some(i) = keys.iter().position(|k| *k == op.key())
                && observed[i]
                    .as_ref()
                    .is_none_or(|o| o.timestamp_ms <= p.timestamp_ms)
            {
                observed[i] = Some(Observed {
                    timestamp_ms: p.timestamp_ms,
                    mutation_id: p.mutation_id.clone(),
                });
            }
        }
    }
    let timestamp_ms = observed
        .iter()
        .flatten()
        .map(|o| o.timestamp_ms + 1)
        .fold(SystemClock.now_ms(), u64::max);
    let pending = Pending {
        mutation_id: id.to_string(),
        ops,
        timestamp_ms,
        origin: node.node_id().to_string(),
        observed,
    };
    let key = pending.storage_key();
    let value = serde_json::to_vec(&pending)
        .map_err(|e| ApiError::internal(format!("encoding pending write: {e}")))?;
    node.blocking(move |e| e.put(key, value))
        .await
        .map_err(|e| ApiError::internal(format!("pending write task failed: {e}")))?
        .map_err(|e| ApiError::storage(e, Some(id)))?;
    Ok(Accepted::Pending { timestamp_ms })
}

/// Up to `limit` pending writes in timestamp order.
pub(crate) async fn pending(node: &Arc<Node>, limit: usize) -> Result<Vec<Pending>, ApiError> {
    let records = node
        .blocking(move |e| e.scan_prefix(PENDING_PREFIX.as_bytes(), limit))
        .await
        .map_err(|e| ApiError::internal(format!("pending scan failed: {e}")))?
        .map_err(|e| ApiError::storage(e, None))?;
    Ok(records
        .into_iter()
        .filter_map(|r| serde_json::from_slice(&r.value).ok())
        .collect())
}

/// One reconciliation pass: offers pending writes to their group leaders
/// and forgets those that were committed. Returns how many remain in this
/// batch.
pub(crate) async fn reconcile(node: &Arc<Node>) -> usize {
    let Ok(batch) = pending(node, RECONCILE_BATCH).await else {
        return 0;
    };
    let mut remaining = 0;
    for p in &batch {
        match commit(node, p).await {
            Ok(()) => {
                let key = p.storage_key();
                if let Ok(Err(e)) = node.blocking(move |e| e.delete(key)).await {
                    warn!(error = %e, "could not remove a reconciled pending write");
                }
            }
            Err(e) => {
                debug!(mutation_id = p.mutation_id, error = %e, "pending write not reconciled yet");
                remaining += 1;
            }
        }
    }
    remaining
}

/// Gets one pending write committed by its group: locally if this node
/// leads it, otherwise through a member that does.
async fn commit(node: &Arc<Node>, p: &Pending) -> anyhow::Result<()> {
    let keys: Vec<&str> = p.ops.iter().map(WireOp::key).collect();
    let (gid, members, leader) = match node.resolve_group(&keys) {
        GroupLookup::Group(group) => {
            if group.status().0 == Role::Leader {
                return commit_locally(node, &group, p.command()).await;
            }
            (
                group.id().to_owned(),
                group.members().to_vec(),
                group.leader(),
            )
        }
        GroupLookup::NotMember(route) => {
            let refs: Vec<&NodeId> = route.replicas.iter().collect();
            (group_id(&refs), route.replicas.clone(), None)
        }
        GroupLookup::NoMap | GroupLookup::CrossGroup => {
            anyhow::bail!("no group can take this write now")
        }
    };
    let mut candidates: Vec<NodeId> = members
        .into_iter()
        .filter(|m| m != node.node_id())
        .collect();
    if let Some(l) = &leader {
        candidates.sort_by_key(|m| m != l);
    }
    let request = RpcRequest::Forward {
        group: gid,
        command: p.command(),
    };
    let mut last = anyhow::anyhow!("no reachable replica");
    for member in candidates {
        let Some(addr) = node.member_addr(&member) else {
            continue;
        };
        match rpc::<()>(&addr, &request, FORWARD_TIMEOUT).await {
            Ok(()) => return Ok(()),
            Err(e) => last = e,
        }
    }
    Err(last)
}

/// Proposes an `available` write on this node (which must lead the group)
/// and waits until it is applied.
pub(crate) async fn commit_locally(
    node: &Arc<Node>,
    group: &Arc<crate::groups::ReplicaGroup>,
    command: DataCommand,
) -> anyhow::Result<()> {
    anyhow::ensure!(
        matches!(command, DataCommand::AvailableWrite { .. }),
        "only available writes may be forwarded"
    );
    let (_, done) = propose(node, group, command)
        .await
        .map_err(|_| anyhow::anyhow!("not the leader of group {}", group.id()))?;
    match tokio::time::timeout(FORWARD_TIMEOUT, done).await {
        Ok(Ok(Applied::Write(Ok(_)))) => Ok(()),
        Ok(Ok(Applied::Write(Err(e)))) if !e.is_outcome_unknown() => {
            // Permanent: the write itself is invalid. Keeping it would
            // block the pending log forever.
            warn!(error = %e, "available write rejected by the group; dropping it");
            Ok(())
        }
        Ok(Ok(Applied::Moving(p))) => anyhow::bail!("partition {p} is moving"),
        Ok(Ok(other)) => anyhow::bail!("not applied: {other:?}"),
        Ok(Err(_)) | Err(_) => anyhow::bail!("outcome unknown; will retry"),
    }
}

/// Recorded conflicts of keys starting with `prefix`, from every group.
pub(crate) async fn conflicts(
    node: &Arc<Node>,
    prefix: &str,
    limit: usize,
) -> Result<(Vec<Conflict>, bool), ApiError> {
    let mut all = Vec::new();
    let mut partial = false;
    for (gid, (members, _)) in node.serving_groups() {
        if let Some(group) = node.group(&gid) {
            let prefix = prefix.to_owned();
            let found = tokio::task::spawn_blocking(move || group.conflicts(&prefix, limit))
                .await
                .map_err(|e| ApiError::internal(format!("conflict lookup failed: {e}")))?
                .map_err(|e| ApiError::internal(format!("{e:#}")))?;
            all.extend(found);
            continue;
        }
        let request = RpcRequest::Conflicts {
            group: gid.clone(),
            prefix: prefix.to_owned(),
            limit,
        };
        let mut got = None;
        for member in &members {
            let Some(addr) = node.member_addr(member) else {
                continue;
            };
            if let Ok(found) = rpc::<Vec<Conflict>>(&addr, &request, FORWARD_TIMEOUT).await {
                got = Some(found);
                break;
            }
        }
        match got {
            Some(found) => all.extend(found),
            None => partial = true,
        }
    }
    all.sort_by(|a, b| (&a.key, &a.mutation_id).cmp(&(&b.key, &b.mutation_id)));
    all.truncate(limit);
    Ok((all, partial))
}

/// Body of a `202 Accepted` available write.
pub(crate) fn accepted_body(
    id: MutationId,
    timestamp_ms: u64,
    key: Option<&str>,
) -> serde_json::Value {
    let mut body = json!({
        "accepted": true,
        "replicated": false,
        "mutation_id": id.to_string(),
        "timestamp_ms": timestamp_ms,
        "consistency": "available",
    });
    if let Some(k) = key {
        body["key"] = json!(k);
    }
    body
}
