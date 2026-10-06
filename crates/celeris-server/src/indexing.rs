//! Builds and drops secondary indexes in the background (D-031).
//!
//! Each step indexes or deletes up to [`STEP_KEYS`] keys as one engine
//! commit. On a single node the step runs locally. In a cluster the leader
//! of each replication group proposes `IndexStep` through the group's log,
//! so every replica runs the same step at the same position and versions
//! stay identical.

use std::sync::Arc;
use std::time::Duration;

use celeris_cluster::raft::Role;
use celeris_storage::{Clock, SystemClock};
use tracing::warn;

use crate::groups::{Applied, DataCommand, ReplicaGroup};
use crate::node::Node;
use crate::replicated::propose;

/// Keys per step: small enough that a step holds the writer lock briefly.
const STEP_KEYS: u32 = 1000;
const IDLE: Duration = Duration::from_millis(500);
const STEP_TIMEOUT: Duration = Duration::from_secs(5);

pub(crate) async fn run(node: Arc<Node>) {
    loop {
        let mut busy = local_step(&node).await;
        for group in node.groups() {
            busy |= group_step(&node, &group).await;
        }
        if !busy {
            tokio::time::sleep(IDLE).await;
        }
    }
}

/// One step on the node's own engine, which holds the data in
/// single-node mode. True when a step ran.
async fn local_step(node: &Arc<Node>) -> bool {
    let result = node
        .blocking(|engine| {
            if !engine.index_work_pending()? {
                return Ok(false);
            }
            engine
                .index_step_at(SystemClock.now_ms(), STEP_KEYS as usize)
                .map(|_| true)
        })
        .await;
    match result {
        Ok(Ok(ran)) => ran,
        Ok(Err(e)) => {
            warn!(error = %e, "index step failed");
            false
        }
        Err(e) => {
            warn!(error = %e, "index step task failed");
            false
        }
    }
}

/// One replicated step for a group this node leads, if its indexes have
/// work left. True when a step was applied.
async fn group_step(node: &Arc<Node>, group: &Arc<ReplicaGroup>) -> bool {
    if group.status().0 != Role::Leader {
        return false;
    }
    let engine = group.engine();
    let pending = tokio::task::spawn_blocking(move || engine.index_work_pending()).await;
    if !matches!(pending, Ok(Ok(true))) {
        return false;
    }
    let command = DataCommand::IndexStep {
        now_ms: SystemClock.now_ms(),
        limit: STEP_KEYS,
    };
    let Ok((_, done)) = propose(node, group, command).await else {
        return false;
    };
    match tokio::time::timeout(STEP_TIMEOUT, done).await {
        Ok(Ok(Applied::Write(Ok(_)))) => true,
        Ok(Ok(Applied::Write(Err(e)))) => {
            warn!(group = %group.id(), error = %e, "index step failed");
            false
        }
        _ => false,
    }
}
