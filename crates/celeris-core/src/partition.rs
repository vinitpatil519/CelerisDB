//! Deterministic data placement: key → logical partition → replica set.
//!
//! * Keys hash (xxh3-64, seed 0) into a fixed universe of
//!   [`PARTITION_COUNT`] logical partitions. The hash is a persistent format:
//!   changing it re-homes every key, so it is pinned by golden test vectors.
//! * Partitions map to nodes by rendezvous (highest-random-weight) hashing.
//!   Each node gets a pseudo-random score per partition, and the highest
//!   scores win. Placement is a pure function of (nodes, replication factor),
//!   and changing membership only moves partitions whose winners changed: on
//!   average 1/N of them when a node joins.
//! * Replicas prefer distinct failure domains (zones). When there are fewer
//!   zones than replicas, the set is filled and reported as not zone-diverse.
//! * Every partition carries the epoch at which its replica set last
//!   changed. Requests carry the epoch they routed with, and nodes reject
//!   stale ones ([`PartitionMap::validate_epoch`]). This is the fencing that
//!   stops an outdated owner acting on a partition it no longer holds.

use std::collections::{BTreeMap, HashSet};
use std::fmt;

use serde::{Deserialize, Serialize};
use xxhash_rust::xxh3::{xxh3_64, xxh3_64_with_seed};

/// Size of the logical partition universe. Fixed for the life of a cluster.
pub const PARTITION_COUNT: u16 = 4096;

/// Version of the serialized [`PartitionMap`] format.
pub const PARTITION_MAP_FORMAT_VERSION: u32 = 1;

/// Zone assigned to nodes that do not declare one.
pub const DEFAULT_ZONE: &str = "default";

#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Hash, Serialize, Deserialize)]
#[serde(transparent)]
pub struct PartitionId(u16);

impl PartitionId {
    pub fn new(raw: u16) -> Option<Self> {
        (raw < PARTITION_COUNT).then_some(PartitionId(raw))
    }

    pub fn get(self) -> u16 {
        self.0
    }

    pub fn all() -> impl Iterator<Item = PartitionId> {
        (0..PARTITION_COUNT).map(PartitionId)
    }

    fn index(self) -> usize {
        usize::from(self.0)
    }
}

impl fmt::Display for PartitionId {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        self.0.fmt(f)
    }
}

/// Stable 64-bit key hash. Treat as an on-disk format: never change it.
pub fn key_hash(key: &[u8]) -> u64 {
    xxh3_64(key)
}

/// The logical partition that owns `key`.
pub fn partition_for(key: &[u8]) -> PartitionId {
    PartitionId((key_hash(key) % u64::from(PARTITION_COUNT)) as u16)
}

/// A node's stable identity.
#[derive(Debug, Clone, PartialEq, Eq, PartialOrd, Ord, Hash, Serialize, Deserialize)]
#[serde(try_from = "String", into = "String")]
pub struct NodeId(String);

impl NodeId {
    /// 1–64 characters from `[A-Za-z0-9._-]`.
    pub fn new(id: impl Into<String>) -> Result<Self, PlacementError> {
        let id = id.into();
        let valid = !id.is_empty()
            && id.len() <= 64
            && id
                .bytes()
                .all(|b| b.is_ascii_alphanumeric() || matches!(b, b'-' | b'_' | b'.'));
        if valid {
            Ok(NodeId(id))
        } else {
            Err(PlacementError::InvalidNodeId(id))
        }
    }

    pub fn as_str(&self) -> &str {
        &self.0
    }
}

impl TryFrom<String> for NodeId {
    type Error = PlacementError;
    fn try_from(s: String) -> Result<Self, Self::Error> {
        NodeId::new(s)
    }
}

impl From<NodeId> for String {
    fn from(id: NodeId) -> String {
        id.0
    }
}

impl fmt::Display for NodeId {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(&self.0)
    }
}

/// A placement target: a node and its failure domain.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct NodeInfo {
    pub id: NodeId,
    pub zone: String,
}

impl NodeInfo {
    pub fn new(id: NodeId, zone: impl Into<String>) -> Self {
        NodeInfo {
            id,
            zone: zone.into(),
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq, thiserror::Error)]
pub enum PlacementError {
    #[error("invalid node id `{0}`: use 1-64 characters from [A-Za-z0-9._-]")]
    InvalidNodeId(String),
    #[error("a partition map needs at least one node")]
    NoNodes,
    #[error("replication factor {rf} is impossible with {nodes} node(s)")]
    ReplicationFactor { rf: u8, nodes: usize },
    #[error("node `{0}` listed more than once")]
    DuplicateNode(NodeId),
    #[error("partition map format version {0} is not supported")]
    UnsupportedFormat(u32),
    #[error("corrupt partition map: {0}")]
    Corrupt(String),
}

/// Why a request's partition epoch was rejected.
#[derive(Debug, Clone, Copy, PartialEq, Eq, thiserror::Error)]
pub enum EpochMismatch {
    /// The client routed with an outdated map; it must refresh and retry.
    #[error("partition {partition}: request epoch {request} is older than current epoch {current}")]
    Stale {
        partition: PartitionId,
        request: u64,
        current: u64,
    },
    /// This node's map is behind the client's; the node must catch up first.
    #[error(
        "partition {partition}: request epoch {request} is newer than this node's epoch {current}"
    )]
    Ahead {
        partition: PartitionId,
        request: u64,
        current: u64,
    },
}

/// Where a key lives.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct Route {
    pub partition: PartitionId,
    pub partition_epoch: u64,
    /// Preferred leader first.
    pub replicas: Vec<NodeId>,
}

/// One partition's change between two maps.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct Move {
    pub partition: PartitionId,
    pub added: Vec<NodeId>,
    pub removed: Vec<NodeId>,
    pub leader_changed: bool,
}

/// Per-node share of the partition space.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize)]
pub struct NodeLoad {
    pub replicas: usize,
    pub leaders: usize,
}

/// The cluster's placement of every partition, at one epoch.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(try_from = "RawPartitionMap")]
pub struct PartitionMap {
    format_version: u32,
    epoch: u64,
    replication_factor: u8,
    /// Sorted by id.
    nodes: Vec<NodeInfo>,
    /// `replicas[p]` holds indexes into `nodes`, preferred leader first.
    replicas: Vec<Vec<u16>>,
    /// Epoch at which each partition's replica list last changed.
    partition_epochs: Vec<u64>,
}

fn score(node: &NodeId, p: PartitionId) -> u64 {
    xxh3_64_with_seed(node.as_str().as_bytes(), u64::from(p.get()))
}

/// Rendezvous placement of one partition: highest scores first, preferring
/// one replica per zone.
fn place(nodes: &[NodeInfo], rf: usize, p: PartitionId) -> Vec<u16> {
    let mut ranked: Vec<(u64, u16)> = nodes
        .iter()
        .enumerate()
        .map(|(i, n)| (score(&n.id, p), i as u16))
        .collect();
    ranked.sort_unstable_by(|a, b| b.0.cmp(&a.0).then(a.1.cmp(&b.1)));
    let mut chosen = Vec::with_capacity(rf);
    let mut zones = HashSet::new();
    for &(_, i) in &ranked {
        if chosen.len() == rf {
            break;
        }
        if zones.insert(nodes[usize::from(i)].zone.as_str()) {
            chosen.push(i);
        }
    }
    for &(_, i) in &ranked {
        if chosen.len() == rf {
            break;
        }
        if !chosen.contains(&i) {
            chosen.push(i);
        }
    }
    chosen
}

impl PartitionMap {
    /// Places every partition on `nodes` with `rf` replicas, at epoch 1.
    pub fn new(nodes: Vec<NodeInfo>, rf: u8) -> Result<Self, PlacementError> {
        Self::place_all(nodes, rf, 1, None)
    }

    /// A one-node map: every partition on `id`, replication factor 1.
    pub fn single_node(id: NodeId) -> Self {
        PartitionMap {
            format_version: PARTITION_MAP_FORMAT_VERSION,
            epoch: 1,
            replication_factor: 1,
            nodes: vec![NodeInfo::new(id, DEFAULT_ZONE)],
            replicas: vec![vec![0]; usize::from(PARTITION_COUNT)],
            partition_epochs: vec![1; usize::from(PARTITION_COUNT)],
        }
    }

    /// The map for a new membership, at the next epoch, plus the partitions
    /// that must move. Partitions whose replica list is unchanged keep their
    /// partition epoch, so clients routing to them stay valid.
    pub fn rebalance(
        &self,
        nodes: Vec<NodeInfo>,
        rf: u8,
    ) -> Result<(PartitionMap, Vec<Move>), PlacementError> {
        let next = Self::place_all(nodes, rf, self.epoch + 1, Some(self))?;
        let moves = PartitionId::all()
            .filter_map(|p| {
                let old = self.replica_ids(p);
                let new = next.replica_ids(p);
                if old == new {
                    return None;
                }
                Some(Move {
                    partition: p,
                    added: new
                        .iter()
                        .filter(|n| !old.contains(n))
                        .map(|n| (*n).clone())
                        .collect(),
                    removed: old
                        .iter()
                        .filter(|n| !new.contains(n))
                        .map(|n| (*n).clone())
                        .collect(),
                    leader_changed: old.first() != new.first(),
                })
            })
            .collect();
        Ok((next, moves))
    }

    fn place_all(
        mut nodes: Vec<NodeInfo>,
        rf: u8,
        epoch: u64,
        previous: Option<&PartitionMap>,
    ) -> Result<Self, PlacementError> {
        if nodes.is_empty() {
            return Err(PlacementError::NoNodes);
        }
        if rf == 0 || usize::from(rf) > nodes.len() || nodes.len() > usize::from(u16::MAX) {
            return Err(PlacementError::ReplicationFactor {
                rf,
                nodes: nodes.len(),
            });
        }
        nodes.sort_by(|a, b| a.id.cmp(&b.id));
        if let Some(w) = nodes.windows(2).find(|w| w[0].id == w[1].id) {
            return Err(PlacementError::DuplicateNode(w[0].id.clone()));
        }
        let replicas: Vec<Vec<u16>> = PartitionId::all()
            .map(|p| place(&nodes, usize::from(rf), p))
            .collect();
        let mut map = PartitionMap {
            format_version: PARTITION_MAP_FORMAT_VERSION,
            epoch,
            replication_factor: rf,
            nodes,
            replicas,
            partition_epochs: vec![epoch; usize::from(PARTITION_COUNT)],
        };
        if let Some(prev) = previous {
            for p in PartitionId::all() {
                if prev.replica_ids(p) == map.replica_ids(p) {
                    map.partition_epochs[p.index()] = prev.partition_epochs[p.index()];
                }
            }
        }
        Ok(map)
    }

    pub fn epoch(&self) -> u64 {
        self.epoch
    }

    pub fn replication_factor(&self) -> u8 {
        self.replication_factor
    }

    pub fn nodes(&self) -> &[NodeInfo] {
        &self.nodes
    }

    pub fn partition_epoch(&self, p: PartitionId) -> u64 {
        self.partition_epochs[p.index()]
    }

    /// Replicas of `p`, preferred leader first.
    pub fn replica_ids(&self, p: PartitionId) -> Vec<&NodeId> {
        self.replicas[p.index()]
            .iter()
            .map(|&i| &self.nodes[usize::from(i)].id)
            .collect()
    }

    pub fn leader(&self, p: PartitionId) -> &NodeId {
        &self.nodes[usize::from(self.replicas[p.index()][0])].id
    }

    /// True when every replica of `p` is in a different zone.
    pub fn zone_diverse(&self, p: PartitionId) -> bool {
        let zones: HashSet<&str> = self.replicas[p.index()]
            .iter()
            .map(|&i| self.nodes[usize::from(i)].zone.as_str())
            .collect();
        zones.len() == self.replicas[p.index()].len()
    }

    pub fn route(&self, key: &[u8]) -> Route {
        let partition = partition_for(key);
        Route {
            partition,
            partition_epoch: self.partition_epoch(partition),
            replicas: self.replica_ids(partition).into_iter().cloned().collect(),
        }
    }

    /// Fencing check for a request routed with `request_epoch`.
    pub fn validate_epoch(&self, p: PartitionId, request_epoch: u64) -> Result<(), EpochMismatch> {
        let current = self.partition_epoch(p);
        if request_epoch < current {
            return Err(EpochMismatch::Stale {
                partition: p,
                request: request_epoch,
                current,
            });
        }
        if request_epoch > self.epoch {
            return Err(EpochMismatch::Ahead {
                partition: p,
                request: request_epoch,
                current,
            });
        }
        // An epoch between the partition's and the map's was routed with a
        // map in which this partition is unchanged.
        Ok(())
    }

    /// Replica and leader counts per node.
    pub fn load(&self) -> BTreeMap<NodeId, NodeLoad> {
        let mut load: BTreeMap<NodeId, NodeLoad> = self
            .nodes
            .iter()
            .map(|n| (n.id.clone(), NodeLoad::default()))
            .collect();
        for set in &self.replicas {
            for (rank, &i) in set.iter().enumerate() {
                let entry = load
                    .entry(self.nodes[usize::from(i)].id.clone())
                    .or_default();
                entry.replicas += 1;
                if rank == 0 {
                    entry.leaders += 1;
                }
            }
        }
        load
    }
}

#[derive(Deserialize)]
struct RawPartitionMap {
    format_version: u32,
    epoch: u64,
    replication_factor: u8,
    nodes: Vec<NodeInfo>,
    replicas: Vec<Vec<u16>>,
    partition_epochs: Vec<u64>,
}

impl TryFrom<RawPartitionMap> for PartitionMap {
    type Error = PlacementError;

    fn try_from(raw: RawPartitionMap) -> Result<Self, Self::Error> {
        if raw.format_version != PARTITION_MAP_FORMAT_VERSION {
            return Err(PlacementError::UnsupportedFormat(raw.format_version));
        }
        let corrupt = |m: &str| Err(PlacementError::Corrupt(m.to_owned()));
        let count = usize::from(PARTITION_COUNT);
        let rf = usize::from(raw.replication_factor);
        if raw.nodes.is_empty() || rf == 0 || rf > raw.nodes.len() {
            return corrupt("replication factor does not fit the node list");
        }
        if raw.nodes.windows(2).any(|w| w[0].id >= w[1].id) {
            return corrupt("nodes must be sorted and unique");
        }
        if raw.replicas.len() != count || raw.partition_epochs.len() != count {
            return corrupt("wrong number of partitions");
        }
        for set in &raw.replicas {
            let distinct: HashSet<u16> = set.iter().copied().collect();
            if set.len() != rf
                || distinct.len() != rf
                || set.iter().any(|&i| usize::from(i) >= raw.nodes.len())
            {
                return corrupt("invalid replica set");
            }
        }
        if raw.epoch == 0
            || raw
                .partition_epochs
                .iter()
                .any(|&e| e == 0 || e > raw.epoch)
        {
            return corrupt("partition epochs must be within 1..=epoch");
        }
        Ok(PartitionMap {
            format_version: raw.format_version,
            epoch: raw.epoch,
            replication_factor: raw.replication_factor,
            nodes: raw.nodes,
            replicas: raw.replicas,
            partition_epochs: raw.partition_epochs,
        })
    }
}

#[cfg(test)]
mod tests {
    use proptest::prelude::*;

    use super::*;

    fn node(id: &str, zone: &str) -> NodeInfo {
        NodeInfo::new(NodeId::new(id).expect("valid id"), zone)
    }

    fn nodes(n: usize, zones: usize) -> Vec<NodeInfo> {
        (0..n)
            .map(|i| node(&format!("node-{i}"), &format!("z{}", i % zones)))
            .collect()
    }

    #[test]
    fn key_hash_is_pinned() {
        // Golden vectors: if these change, every existing key moves partition.
        let got: Vec<u16> = ["", "users/42", "orders/123", "a"]
            .iter()
            .map(|k| partition_for(k.as_bytes()).get())
            .collect();
        assert_eq!(got, vec![1218, 1118, 2920, 3615]);
    }

    #[test]
    fn keys_spread_evenly_over_partitions() {
        let mut counts = vec![0u32; usize::from(PARTITION_COUNT)];
        for i in 0..409_600 {
            counts[partition_for(format!("key-{i}").as_bytes()).index()] += 1;
        }
        // Mean 100 per partition; a good hash keeps every bucket well inside this band.
        let (lo, hi) = (counts.iter().min(), counts.iter().max());
        assert!(
            counts.iter().all(|&c| (50..=160).contains(&c)),
            "min {lo:?} max {hi:?}"
        );
    }

    #[test]
    fn single_node_owns_everything() {
        let id = NodeId::new("node-a").expect("id");
        let map = PartitionMap::single_node(id.clone());
        let r = map.route(b"anything");
        assert_eq!(r.replicas, vec![id.clone()]);
        assert_eq!(
            map.load()[&id],
            NodeLoad {
                replicas: 4096,
                leaders: 4096
            }
        );
        assert_eq!(
            map,
            PartitionMap::new(vec![NodeInfo::new(id, DEFAULT_ZONE)], 1).expect("map")
        );
    }

    #[test]
    fn placement_is_balanced_zone_diverse_and_order_independent() {
        let map = PartitionMap::new(nodes(6, 3), 3).expect("map");
        for p in PartitionId::all() {
            assert_eq!(map.replica_ids(p).len(), 3);
            assert!(map.zone_diverse(p), "partition {p}");
        }
        let mean = 4096.0 * 3.0 / 6.0;
        for (id, load) in map.load() {
            let dev = (load.replicas as f64 - mean).abs() / mean;
            assert!(dev < 0.10, "{id}: {} replicas", load.replicas);
            let leader_mean = 4096.0 / 6.0;
            assert!(
                (load.leaders as f64 - leader_mean).abs() / leader_mean < 0.15,
                "{id} leaders"
            );
        }
        let mut shuffled = nodes(6, 3);
        shuffled.reverse();
        assert_eq!(PartitionMap::new(shuffled, 3).expect("map"), map);
    }

    #[test]
    fn too_few_zones_still_places_all_replicas() {
        let map = PartitionMap::new(nodes(3, 1), 3).expect("map");
        assert!(PartitionId::all().all(|p| map.replica_ids(p).len() == 3 && !map.zone_diverse(p)));
    }

    #[test]
    fn adding_a_node_moves_only_partitions_it_wins() {
        let before = PartitionMap::new(nodes(3, 3), 1).expect("map");
        let (after, moves) = before.rebalance(nodes(4, 4), 1).expect("rebalance");
        let new_node = NodeId::new("node-3").expect("id");
        assert!(
            moves.iter().all(|m| m.added == vec![new_node.clone()]),
            "only the new node gains"
        );
        let fraction = moves.len() as f64 / 4096.0;
        assert!((0.20..0.30).contains(&fraction), "moved {fraction}");
        assert_eq!(after.epoch(), 2);
        for p in PartitionId::all() {
            let moved = moves.iter().any(|m| m.partition == p);
            assert_eq!(after.partition_epoch(p), if moved { 2 } else { 1 });
        }
    }

    #[test]
    fn removing_a_node_moves_only_its_partitions() {
        let before = PartitionMap::new(nodes(5, 5), 2).expect("map");
        let survivors: Vec<_> = nodes(5, 5)
            .into_iter()
            .filter(|n| n.id.as_str() != "node-2")
            .collect();
        let (after, moves) = before.rebalance(survivors, 2).expect("rebalance");
        let gone = NodeId::new("node-2").expect("id");
        for m in &moves {
            assert!(
                m.removed.contains(&gone),
                "partition {} moved without losing node-2",
                m.partition
            );
        }
        assert!(PartitionId::all().all(|p| !after.replica_ids(p).contains(&&gone)));
    }

    #[test]
    fn epoch_fencing() {
        let before = PartitionMap::new(nodes(3, 3), 1).expect("map");
        let (after, moves) = before.rebalance(nodes(4, 4), 1).expect("rebalance");
        let moved = moves[0].partition;
        let kept = PartitionId::all()
            .find(|p| moves.iter().all(|m| m.partition != *p))
            .expect("unmoved");
        assert!(matches!(
            after.validate_epoch(moved, 1),
            Err(EpochMismatch::Stale { current: 2, .. })
        ));
        assert!(after.validate_epoch(moved, 2).is_ok());
        assert!(
            after.validate_epoch(kept, 1).is_ok(),
            "unchanged partitions stay valid"
        );
        assert!(after.validate_epoch(kept, 2).is_ok());
        assert!(matches!(
            after.validate_epoch(kept, 3),
            Err(EpochMismatch::Ahead { .. })
        ));
    }

    #[test]
    fn invalid_inputs_are_rejected() {
        assert_eq!(PartitionMap::new(vec![], 1), Err(PlacementError::NoNodes));
        assert!(matches!(
            PartitionMap::new(nodes(2, 2), 3),
            Err(PlacementError::ReplicationFactor { .. })
        ));
        assert!(matches!(
            PartitionMap::new(nodes(2, 2), 0),
            Err(PlacementError::ReplicationFactor { .. })
        ));
        let dup = vec![node("a", "z"), node("a", "y")];
        assert!(matches!(
            PartitionMap::new(dup, 1),
            Err(PlacementError::DuplicateNode(_))
        ));
        assert!(NodeId::new("").is_err());
        assert!(NodeId::new("bad id").is_err());
        assert!(NodeId::new("x".repeat(65)).is_err());
        assert!(PartitionId::new(PARTITION_COUNT).is_none());
    }

    #[test]
    fn serialization_round_trips_and_validates() {
        let map = PartitionMap::new(nodes(4, 2), 2).expect("map");
        let json = serde_json::to_string(&map).expect("serialize");
        assert_eq!(
            serde_json::from_str::<PartitionMap>(&json).expect("parse"),
            map
        );

        let mut v: serde_json::Value = serde_json::from_str(&json).expect("value");
        v["format_version"] = 9.into();
        assert!(serde_json::from_value::<PartitionMap>(v.clone()).is_err());
        v["format_version"] = 1.into();
        v["replicas"][7] = serde_json::json!([0, 0]);
        assert!(
            serde_json::from_value::<PartitionMap>(v).is_err(),
            "duplicate replica rejected"
        );
    }

    proptest! {
        #![proptest_config(ProptestConfig { cases: 24, ..ProptestConfig::default() })]

        #[test]
        fn rebalance_invariants(
            n in 1usize..8,
            zones in 1usize..4,
            rf_seed in 0u8..3,
            joiners in 0usize..3,
            leavers in 0usize..3,
        ) {
            let rf = (usize::from(rf_seed) % n + 1) as u8;
            let before = PartitionMap::new(nodes(n, zones), rf).expect("map");
            let next: Vec<NodeInfo> = nodes(n + joiners, zones)
                .into_iter()
                .skip(leavers.min(n - 1))
                .collect();
            let rf_next = rf.min(next.len() as u8);
            let (after, moves) = before.rebalance(next.clone(), rf_next).expect("rebalance");
            let next_ids: HashSet<&NodeId> = next.iter().map(|n| &n.id).collect();
            for p in PartitionId::all() {
                let set = after.replica_ids(p);
                prop_assert_eq!(set.len(), usize::from(rf_next));
                prop_assert_eq!(set.iter().collect::<HashSet<_>>().len(), set.len());
                prop_assert!(set.iter().all(|id| next_ids.contains(id)));
                let changed = before.replica_ids(p) != set;
                prop_assert_eq!(changed, moves.iter().any(|m| m.partition == p));
                prop_assert_eq!(after.partition_epoch(p) == after.epoch(), changed);
            }
        }
    }
}
