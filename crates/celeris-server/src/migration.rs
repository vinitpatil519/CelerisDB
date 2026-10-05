//! Moves partition data between replication groups after a placement
//! change (D-020).
//!
//! The control plane records a [`Migration`] for every partition whose
//! replica set changed, and keeps routing it to the old set until the
//! migration finishes. Group leaders drive each migration forward with
//! idempotent steps, each confirmed through the control plane:
//!
//! 1. **Moving → Fenced:** the source group commits a `Fence` entry. From
//!    then on, it rejects writes to the partition, so the data is final.
//! 2. **Fenced → Imported:** the destination leader fetches the data from
//!    any source replica (only a fenced replica answers), and commits it in
//!    `Import` chunks. The first chunk clears anything the destination held
//!    for the partition.
//! 3. **Imported → done:** the source group commits `Release`, which
//!    deletes its copy and refuses further reads. Only then does routing
//!    switch to the destination, so no reader can see the old copy after a
//!    write to the new one.
//!
//! Every step tolerates retries, crashes and leader changes. A new leader
//! simply repeats the step for the phase the control plane shows.
//!
//! [`Migration`]: celeris_cluster::raft::Migration

use std::collections::BTreeMap;
use std::sync::Arc;
use std::time::Duration;

use celeris_cluster::raft::{ControlCommand, MigrationPhase, Role};
use celeris_core::MutationId;
use celeris_core::partition::NodeId;
use celeris_storage::{Clock, SystemClock};
use tracing::{debug, info, warn};

use crate::cluster::{fetch_export, propose_control};
use crate::groups::{Applied, DataCommand, ImportEntry, ReplicaGroup};
use crate::node::Node;
use crate::replicated::propose;

/// Entries per `Import` command, and its approximate byte budget.
const IMPORT_CHUNK_ENTRIES: usize = 1_000;
const IMPORT_CHUNK_BYTES: usize = 4 * 1024 * 1024;
const STEP_TIMEOUT: Duration = Duration::from_secs(10);

/// One pass over the running migrations: performs every step this node
/// is responsible for, as the leader of a source or destination group.
pub(crate) async fn drive(node: &Arc<Node>) {
    let migrations = node.migrations();
    if migrations.is_empty() {
        return;
    }
    for group in node.groups() {
        if group.status().0 != Role::Leader {
            continue;
        }
        let mut members: Vec<NodeId> = group.members().to_vec();
        members.sort();
        let in_phase = |phase: MigrationPhase| -> Vec<u16> {
            migrations
                .iter()
                .filter(|(_, m)| m.phase == phase && m.from == members)
                .map(|(p, _)| *p)
                .collect()
        };

        let moving = in_phase(MigrationPhase::Moving);
        if !moving.is_empty() {
            let command = DataCommand::Fence {
                partitions: moving.clone(),
                mutation_id: MutationId::random().to_string(),
                now_ms: SystemClock.now_ms(),
            };
            if commit(node, &group, command).await {
                info!(
                    group = group.id(),
                    partitions = moving.len(),
                    "fenced partitions for migration"
                );
                advance(
                    node,
                    moving,
                    MigrationPhase::Moving,
                    Some(MigrationPhase::Fenced),
                )
                .await;
            }
        }

        let imported = in_phase(MigrationPhase::Imported);
        if !imported.is_empty() {
            let command = DataCommand::Release {
                partitions: imported.clone(),
                mutation_id: MutationId::random().to_string(),
                now_ms: SystemClock.now_ms(),
            };
            if commit(node, &group, command).await {
                info!(
                    group = group.id(),
                    partitions = imported.len(),
                    "released migrated partitions"
                );
                advance(node, imported, MigrationPhase::Imported, None).await;
            }
        }

        let mut by_source: BTreeMap<Vec<NodeId>, Vec<u16>> = BTreeMap::new();
        for (p, m) in migrations.iter() {
            if m.phase == MigrationPhase::Fenced && m.to == members {
                by_source.entry(m.from.clone()).or_default().push(*p);
            }
        }
        for (source, partitions) in by_source {
            if import(node, &group, &source, &partitions).await {
                info!(
                    group = group.id(),
                    partitions = partitions.len(),
                    "imported migrated partitions"
                );
                advance(
                    node,
                    partitions,
                    MigrationPhase::Fenced,
                    Some(MigrationPhase::Imported),
                )
                .await;
            }
        }
    }
}

/// Copies `partitions` from the `source` replica set into `group`.
async fn import(
    node: &Arc<Node>,
    group: &Arc<ReplicaGroup>,
    source: &[NodeId],
    partitions: &[u16],
) -> bool {
    let refs: Vec<&NodeId> = source.iter().collect();
    let source_group = crate::groups::group_id(&refs);
    let mut entries = None;
    for member in source {
        let Some(addr) = node.member_addr(member) else {
            continue;
        };
        match fetch_export(&addr, &source_group, partitions).await {
            Ok(e) => {
                entries = Some(e);
                break;
            }
            Err(e) => debug!(%member, error = %e, "export not available from this source replica"),
        }
    }
    let Some(entries) = entries else {
        return false;
    };
    for (i, chunk) in chunks(entries).into_iter().enumerate() {
        let command = DataCommand::Import {
            partitions: partitions.to_vec(),
            clear: i == 0,
            entries: chunk,
            mutation_id: MutationId::random().to_string(),
            now_ms: SystemClock.now_ms(),
        };
        if !commit(node, group, command).await {
            return false;
        }
    }
    true
}

/// Splits entries into `Import` chunks; always at least one (possibly
/// empty) so the clearing step runs.
fn chunks(entries: Vec<ImportEntry>) -> Vec<Vec<ImportEntry>> {
    let mut out: Vec<Vec<ImportEntry>> = vec![Vec::new()];
    let mut bytes = 0;
    for e in entries {
        let size = e.key.len() + e.value.len();
        let full = out.last().is_some_and(|current| {
            !current.is_empty()
                && (current.len() >= IMPORT_CHUNK_ENTRIES || bytes + size > IMPORT_CHUNK_BYTES)
        });
        if full {
            out.push(Vec::new());
            bytes = 0;
        }
        bytes += size;
        if let Some(current) = out.last_mut() {
            current.push(e);
        }
    }
    out
}

/// Proposes a migration command in `group` and waits until it is applied.
async fn commit(node: &Arc<Node>, group: &Arc<ReplicaGroup>, command: DataCommand) -> bool {
    let Ok((_, done)) = propose(node, group, command).await else {
        return false;
    };
    match tokio::time::timeout(STEP_TIMEOUT, done).await {
        Ok(Ok(Applied::Migration(Ok(())))) => true,
        Ok(Ok(Applied::Migration(Err(e)))) => {
            warn!(group = group.id(), error = %e, "migration step failed");
            false
        }
        _ => false,
    }
}

async fn advance(
    node: &Arc<Node>,
    partitions: Vec<u16>,
    from: MigrationPhase,
    to: Option<MigrationPhase>,
) {
    propose_control(
        node,
        ControlCommand::AdvanceMigration {
            partitions,
            from,
            to,
        },
    )
    .await;
}

#[cfg(test)]
mod tests {
    use super::*;

    fn entry(n: usize, size: usize) -> ImportEntry {
        ImportEntry {
            key: format!("k{n}"),
            value: "x".repeat(size),
            ttl_ms: None,
        }
    }

    #[test]
    fn chunks_respect_count_and_byte_budgets() {
        assert_eq!(
            chunks(Vec::new()),
            vec![Vec::new()],
            "one empty chunk clears"
        );
        let small: Vec<_> = (0..2_500).map(|n| entry(n, 1)).collect();
        let sizes: Vec<usize> = chunks(small).iter().map(Vec::len).collect();
        assert_eq!(sizes, vec![1_000, 1_000, 500]);
        let big: Vec<_> = (0..3).map(|n| entry(n, 3 * 1024 * 1024)).collect();
        assert_eq!(chunks(big).len(), 3, "one large entry per chunk");
    }
}
