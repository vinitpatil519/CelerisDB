//! SWIM-style membership with incarnation-based refutation.
//!
//! Each node keeps a view: for every known member an `incarnation` (a
//! counter only that member may increase) and a state. Nodes heartbeat
//! every peer periodically and piggyback their whole view (gossip).
//!
//! **A timeout is evidence, not proof.** Silence moves a peer to `Suspect`.
//! Only a longer, unrefuted suspicion moves it to `Unreachable`, and even
//! that is not "dead": an unreachable node that hears about the suspicion
//! refutes it by bumping its incarnation and comes back `Alive`. Nothing in
//! this module ever concludes that a process has crashed.
//!
//! Merging is a join on a lattice ordered by (incarnation, state
//! precedence `Alive < Suspect < Unreachable < Left`). That makes it
//! idempotent, commutative and monotonic, so duplicated, delayed and
//! reordered messages cannot corrupt the view. The tests check this under a
//! simulated network.
//!
//! Views are gossiped in full, which is O(members) per message. That is fine
//! for tens of nodes; bounded piggybacking is a later optimisation.

use std::collections::BTreeMap;

use celeris_core::partition::{NodeId, NodeInfo};
use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum MemberState {
    /// Heard from recently, or refuted suspicion.
    Alive,
    /// Silent for longer than `suspect_after_ms`. Still owns its partitions.
    Suspect,
    /// Suspected for longer than `suspicion_timeout_ms` without refuting.
    /// Communication has failed; the process may still be running.
    Unreachable,
    /// Announced a graceful departure. Terminal for this incarnation.
    Left,
}

impl MemberState {
    fn precedence(self) -> u8 {
        match self {
            MemberState::Alive => 0,
            MemberState::Suspect => 1,
            MemberState::Unreachable => 2,
            MemberState::Left => 3,
        }
    }

    pub fn as_str(self) -> &'static str {
        match self {
            MemberState::Alive => "alive",
            MemberState::Suspect => "suspect",
            MemberState::Unreachable => "unreachable",
            MemberState::Left => "left",
        }
    }
}

/// One member as gossiped on the wire.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct MemberDigest {
    pub id: NodeId,
    /// Cluster address of the member (host:port).
    pub addr: String,
    pub zone: String,
    pub incarnation: u64,
    pub state: MemberState,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "type", rename_all = "snake_case")]
pub enum Message {
    /// Periodic liveness signal carrying the sender's full view.
    Heartbeat {
        from: NodeId,
        members: Vec<MemberDigest>,
    },
    /// Sent to a seed by a node that wants to join. The seed answers with a heartbeat.
    Join { member: MemberDigest },
}

/// A message to deliver to `to` (at `addr`).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Outgoing {
    /// `None` for join requests to a seed whose ID is not yet known.
    pub to: Option<NodeId>,
    pub addr: String,
    pub message: Message,
}

/// Observable membership transitions (for logs and metrics).
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum MembershipEvent {
    Discovered {
        id: NodeId,
        state: MemberState,
        incarnation: u64,
    },
    StateChanged {
        id: NodeId,
        from: MemberState,
        to: MemberState,
        incarnation: u64,
    },
    /// This node refuted a suspicion about itself.
    Refuted { incarnation: u64 },
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct MembershipConfig {
    /// How often the caller should invoke [`Membership::tick`].
    pub heartbeat_interval_ms: u64,
    /// Silence after which an `Alive` peer becomes `Suspect`.
    pub suspect_after_ms: u64,
    /// Unrefuted suspicion after which a peer becomes `Unreachable`.
    pub suspicion_timeout_ms: u64,
}

impl Default for MembershipConfig {
    fn default() -> Self {
        MembershipConfig {
            heartbeat_interval_ms: 500,
            suspect_after_ms: 2_000,
            suspicion_timeout_ms: 5_000,
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Member {
    pub id: NodeId,
    pub addr: String,
    pub zone: String,
    pub incarnation: u64,
    pub state: MemberState,
    pub state_since_ms: u64,
    pub last_heard_ms: u64,
}

impl Member {
    fn digest(&self) -> MemberDigest {
        MemberDigest {
            id: self.id.clone(),
            addr: self.addr.clone(),
            zone: self.zone.clone(),
            incarnation: self.incarnation,
            state: self.state,
        }
    }
}

/// One node's membership view.
#[derive(Debug, Clone)]
pub struct Membership {
    me: NodeId,
    config: MembershipConfig,
    members: BTreeMap<NodeId, Member>,
    seeds: Vec<String>,
    /// Bumped on every change to the view; consumers recompute placement
    /// when it moves.
    view_epoch: u64,
    events: Vec<MembershipEvent>,
}

impl Membership {
    /// `incarnation` must exceed any incarnation this node used before (a
    /// restarted node persists and increments it), or its old `Left` or
    /// `Unreachable` record would shadow it.
    pub fn new(
        me: NodeInfo,
        addr: String,
        incarnation: u64,
        now_ms: u64,
        config: MembershipConfig,
    ) -> Self {
        let id = me.id.clone();
        let mut members = BTreeMap::new();
        members.insert(
            id.clone(),
            Member {
                id: id.clone(),
                addr,
                zone: me.zone,
                incarnation,
                state: MemberState::Alive,
                state_since_ms: now_ms,
                last_heard_ms: now_ms,
            },
        );
        Membership {
            me: id,
            config,
            members,
            seeds: Vec::new(),
            view_epoch: 1,
            events: Vec::new(),
        }
    }

    pub fn id(&self) -> &NodeId {
        &self.me
    }

    pub fn config(&self) -> MembershipConfig {
        self.config
    }

    /// Registers a seed by cluster address (its node ID is learned from the
    /// reply). While this node knows no peers, every `tick` sends a `Join`
    /// to each seed, so a lost join request is simply retried.
    pub fn add_seed(&mut self, addr: String) {
        if addr != self.me().addr && !self.seeds.contains(&addr) {
            self.seeds.push(addr);
        }
    }

    pub fn handle(&mut self, now_ms: u64, message: Message) -> Vec<Outgoing> {
        match message {
            Message::Join { member } => {
                let from = member.id.clone();
                let addr = member.addr.clone();
                self.merge(now_ms, member);
                self.touch(&from, now_ms);
                vec![Outgoing {
                    to: Some(from),
                    addr,
                    message: self.heartbeat(),
                }]
            }
            Message::Heartbeat { from, members } => {
                for digest in members {
                    self.merge(now_ms, digest);
                }
                self.touch(&from, now_ms);
                Vec::new()
            }
        }
    }

    /// Runs failure detection, then heartbeats every peer that has not left
    /// (unreachable peers included, so they can learn of and refute the
    /// suspicion once the network heals).
    pub fn tick(&mut self, now_ms: u64) -> Vec<Outgoing> {
        if self.me().state == MemberState::Left {
            return Vec::new();
        }
        self.detect(now_ms);
        let mut out = self.broadcast();
        if self.members.len() == 1 {
            let join = Message::Join {
                member: self.me().digest(),
            };
            out.extend(self.seeds.iter().map(|addr| Outgoing {
                to: None,
                addr: addr.clone(),
                message: join.clone(),
            }));
        }
        out
    }

    /// Announces a graceful departure to every peer.
    pub fn leave(&mut self, now_ms: u64) -> Vec<Outgoing> {
        let me = self.me.clone();
        self.set_state(&me, MemberState::Left, now_ms);
        self.broadcast()
    }

    pub fn members(&self) -> impl Iterator<Item = &Member> {
        self.members.values()
    }

    pub fn state_of(&self, id: &NodeId) -> Option<MemberState> {
        self.members.get(id).map(|m| m.state)
    }

    pub fn view_epoch(&self) -> u64 {
        self.view_epoch
    }

    /// Nodes that should hold partitions: alive or merely suspected.
    /// Suspects keep their partitions so a slow node does not cause
    /// partitions to flap back and forth.
    pub fn placement_nodes(&self) -> Vec<NodeInfo> {
        self.members
            .values()
            .filter(|m| matches!(m.state, MemberState::Alive | MemberState::Suspect))
            .map(|m| NodeInfo::new(m.id.clone(), m.zone.clone()))
            .collect()
    }

    pub fn take_events(&mut self) -> Vec<MembershipEvent> {
        std::mem::take(&mut self.events)
    }

    fn me(&self) -> &Member {
        &self.members[&self.me]
    }

    fn heartbeat(&self) -> Message {
        Message::Heartbeat {
            from: self.me.clone(),
            members: self.members.values().map(Member::digest).collect(),
        }
    }

    fn broadcast(&self) -> Vec<Outgoing> {
        let heartbeat = self.heartbeat();
        self.members
            .values()
            .filter(|m| m.id != self.me && m.state != MemberState::Left)
            .map(|m| Outgoing {
                to: Some(m.id.clone()),
                addr: m.addr.clone(),
                message: heartbeat.clone(),
            })
            .collect()
    }

    /// Direct contact from `id`.
    fn touch(&mut self, id: &NodeId, now_ms: u64) {
        if let Some(m) = self.members.get_mut(id) {
            m.last_heard_ms = now_ms;
        }
    }

    fn set_state(&mut self, id: &NodeId, to: MemberState, now_ms: u64) {
        if let Some(m) = self.members.get_mut(id)
            && m.state != to
        {
            self.events.push(MembershipEvent::StateChanged {
                id: id.clone(),
                from: m.state,
                to,
                incarnation: m.incarnation,
            });
            m.state = to;
            m.state_since_ms = now_ms;
            self.view_epoch += 1;
        }
    }

    fn detect(&mut self, now_ms: u64) {
        let mut changes = Vec::new();
        for m in self.members.values().filter(|m| m.id != self.me) {
            match m.state {
                MemberState::Alive
                    if now_ms.saturating_sub(m.last_heard_ms) >= self.config.suspect_after_ms =>
                {
                    changes.push((m.id.clone(), MemberState::Suspect));
                }
                MemberState::Suspect
                    if now_ms.saturating_sub(m.state_since_ms)
                        >= self.config.suspicion_timeout_ms =>
                {
                    changes.push((m.id.clone(), MemberState::Unreachable));
                }
                _ => {}
            }
        }
        for (id, state) in changes {
            self.set_state(&id, state, now_ms);
        }
    }

    fn merge(&mut self, now_ms: u64, d: MemberDigest) {
        if d.id == self.me {
            let me = &self.members[&self.me];
            // A live node out-ranks any non-alive claim about itself with a
            // higher incarnation: suspicion, or a `Left` from a previous
            // life (a restart that reused an old incarnation).
            if me.state != MemberState::Left
                && d.state != MemberState::Alive
                && d.incarnation >= me.incarnation
            {
                let incarnation = d.incarnation + 1;
                if let Some(me) = self.members.get_mut(&self.me) {
                    me.incarnation = incarnation;
                }
                self.events.push(MembershipEvent::Refuted { incarnation });
                self.view_epoch += 1;
            }
            return;
        }
        match self.members.get_mut(&d.id) {
            None => {
                self.events.push(MembershipEvent::Discovered {
                    id: d.id.clone(),
                    state: d.state,
                    incarnation: d.incarnation,
                });
                self.members.insert(
                    d.id.clone(),
                    Member {
                        id: d.id,
                        addr: d.addr,
                        zone: d.zone,
                        incarnation: d.incarnation,
                        state: d.state,
                        state_since_ms: now_ms,
                        last_heard_ms: now_ms,
                    },
                );
                self.view_epoch += 1;
            }
            Some(m) => {
                let newer = d.incarnation > m.incarnation
                    || (d.incarnation == m.incarnation
                        && d.state.precedence() > m.state.precedence());
                if !newer {
                    return;
                }
                let from = m.state;
                m.incarnation = d.incarnation;
                m.addr = d.addr;
                m.zone = d.zone;
                if d.state == MemberState::Alive {
                    // Fresh evidence of life restarts the silence timer.
                    m.last_heard_ms = now_ms;
                }
                if from != d.state {
                    m.state = d.state;
                    m.state_since_ms = now_ms;
                    self.events.push(MembershipEvent::StateChanged {
                        id: m.id.clone(),
                        from,
                        to: d.state,
                        incarnation: d.incarnation,
                    });
                }
                self.view_epoch += 1;
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use std::collections::HashSet;

    use celeris_core::partition::{PartitionId, PartitionMap};
    use proptest::prelude::*;

    use super::*;

    const CONFIG: MembershipConfig = MembershipConfig {
        heartbeat_interval_ms: 100,
        suspect_after_ms: 400,
        suspicion_timeout_ms: 1_000,
    };
    const STEP_MS: u64 = 10;

    fn id(s: &str) -> NodeId {
        NodeId::new(s).expect("id")
    }

    /// Deterministic network simulator: per-message random delay, drop and
    /// duplication; crashed nodes; severed links.
    struct Sim {
        now: u64,
        nodes: BTreeMap<NodeId, Membership>,
        crashed: HashSet<NodeId>,
        cut: HashSet<(NodeId, NodeId)>,
        queue: Vec<(u64, NodeId, NodeId, Message)>,
        rng: u64,
        drop_pct: u64,
        dup_pct: u64,
        max_delay_ms: u64,
    }

    impl Sim {
        fn new(seed: u64) -> Sim {
            Sim {
                now: 0,
                nodes: BTreeMap::new(),
                crashed: HashSet::new(),
                cut: HashSet::new(),
                queue: Vec::new(),
                rng: seed | 1,
                drop_pct: 0,
                dup_pct: 0,
                max_delay_ms: 20,
            }
        }

        fn rand(&mut self) -> u64 {
            self.rng ^= self.rng << 13;
            self.rng ^= self.rng >> 7;
            self.rng ^= self.rng << 17;
            self.rng
        }

        fn linked(&self, a: &NodeId, b: &NodeId) -> bool {
            !self.cut.contains(&(a.clone(), b.clone()))
                && !self.cut.contains(&(b.clone(), a.clone()))
        }

        fn send(&mut self, from: &NodeId, outs: Vec<Outgoing>) {
            for o in outs {
                if self.rand() % 100 < self.drop_pct {
                    continue;
                }
                let copies = if self.rand() % 100 < self.dup_pct {
                    2
                } else {
                    1
                };
                for _ in 0..copies {
                    let delay = 1 + self.rand() % self.max_delay_ms;
                    self.queue.push((
                        self.now + delay,
                        from.clone(),
                        // Simulated addresses are "<name>:7000".
                        id(o.addr.trim_end_matches(":7000")),
                        o.message.clone(),
                    ));
                }
            }
        }

        /// Adds (or restarts) a node that joins through `seed`, if given.
        fn add(&mut self, name: &str, zone: &str, incarnation: u64, seed: Option<&str>) {
            let node_id = id(name);
            let mut m = Membership::new(
                NodeInfo::new(node_id.clone(), zone),
                format!("{name}:7000"),
                incarnation,
                self.now,
                CONFIG,
            );
            if let Some(seed) = seed {
                m.add_seed(format!("{seed}:7000"));
            }
            self.crashed.remove(&node_id);
            self.nodes.insert(node_id, m);
        }

        fn run(&mut self, duration_ms: u64) {
            let end = self.now + duration_ms;
            while self.now < end {
                self.now += STEP_MS;
                let now = self.now;
                let (due, rest): (Vec<_>, Vec<_>) =
                    self.queue.drain(..).partition(|(at, ..)| *at <= now);
                self.queue = rest;
                for (_, from, to, msg) in due {
                    if self.crashed.contains(&to) || !self.linked(&from, &to) {
                        continue;
                    }
                    if let Some(node) = self.nodes.get_mut(&to) {
                        let outs = node.handle(now, msg);
                        self.send(&to, outs);
                    }
                }
                if now.is_multiple_of(CONFIG.heartbeat_interval_ms) {
                    let live: Vec<NodeId> = self
                        .nodes
                        .keys()
                        .filter(|n| !self.crashed.contains(*n))
                        .cloned()
                        .collect();
                    for n in live {
                        let outs = self
                            .nodes
                            .get_mut(&n)
                            .map(|m| m.tick(now))
                            .unwrap_or_default();
                        self.send(&n, outs);
                    }
                }
            }
        }

        fn state(&self, observer: &str, subject: &str) -> Option<MemberState> {
            self.nodes[&id(observer)].state_of(&id(subject))
        }

        fn partition(&mut self, left: &[&str], right: &[&str]) {
            for a in left {
                for b in right {
                    self.cut.insert((id(a), id(b)));
                }
            }
        }

        fn views(&self) -> Vec<Vec<(NodeId, u64, MemberState)>> {
            self.nodes
                .iter()
                .filter(|(n, _)| !self.crashed.contains(*n))
                .map(|(_, m)| {
                    m.members()
                        .map(|x| (x.id.clone(), x.incarnation, x.state))
                        .collect()
                })
                .collect()
        }
    }

    fn three_node_cluster(seed: u64) -> Sim {
        let mut sim = Sim::new(seed);
        sim.add("a", "z1", 1, None);
        sim.add("b", "z2", 1, Some("a"));
        sim.add("c", "z3", 1, Some("a"));
        sim.run(1_000);
        sim
    }

    #[test]
    fn nodes_join_through_a_seed_and_converge() {
        let sim = three_node_cluster(7);
        for observer in ["a", "b", "c"] {
            for subject in ["a", "b", "c"] {
                assert_eq!(
                    sim.state(observer, subject),
                    Some(MemberState::Alive),
                    "{observer} sees {subject}"
                );
            }
        }
        assert!(sim.views().windows(2).all(|w| w[0] == w[1]));
    }

    #[test]
    fn lost_join_requests_are_retried() {
        let mut sim = Sim::new(3);
        sim.add("a", "z1", 1, None);
        sim.add("b", "z2", 1, Some("a"));
        sim.drop_pct = 100;
        sim.run(500);
        assert_eq!(sim.state("a", "b"), None);
        sim.drop_pct = 0;
        sim.run(500);
        assert_eq!(sim.state("a", "b"), Some(MemberState::Alive));
        assert_eq!(sim.state("b", "a"), Some(MemberState::Alive));
    }

    #[test]
    fn silence_leads_to_suspect_then_unreachable_never_sooner() {
        let mut sim = three_node_cluster(11);
        sim.crashed.insert(id("c"));
        sim.run(250);
        assert_eq!(
            sim.state("a", "c"),
            Some(MemberState::Alive),
            "too early to suspect"
        );
        sim.run(400);
        assert_eq!(sim.state("a", "c"), Some(MemberState::Suspect));
        assert_eq!(
            sim.nodes[&id("a")].placement_nodes().len(),
            3,
            "suspects keep their partitions"
        );
        sim.run(1_200);
        assert_eq!(sim.state("a", "c"), Some(MemberState::Unreachable));
        assert_eq!(sim.state("b", "c"), Some(MemberState::Unreachable));
        assert_eq!(sim.state("a", "b"), Some(MemberState::Alive));
        let placement = sim.nodes[&id("a")].placement_nodes();
        assert_eq!(placement.len(), 2);
        let map = PartitionMap::new(placement, 2).expect("map");
        let c = id("c");
        assert!(PartitionId::all().all(|p| !map.replica_ids(p).contains(&&c)));
    }

    #[test]
    fn brief_slowness_is_refuted_without_reaching_unreachable() {
        let mut sim = three_node_cluster(13);
        // c is cut off past suspect_after but well inside the suspicion
        // timeout: a false positive the protocol must undo.
        sim.partition(&["c"], &["a", "b"]);
        sim.run(500);
        assert_eq!(sim.state("a", "c"), Some(MemberState::Suspect));
        sim.cut.clear();
        sim.run(500);
        assert_eq!(sim.state("a", "c"), Some(MemberState::Alive));
        assert_eq!(sim.state("b", "c"), Some(MemberState::Alive));
        let c = &sim.nodes[&id("c")];
        assert!(
            c.members().any(|m| m.id == id("c") && m.incarnation == 2),
            "c refuted with a higher incarnation"
        );
        let mut a = sim.nodes[&id("a")].clone();
        assert!(a.take_events().iter().all(|e| !matches!(
            e,
            MembershipEvent::StateChanged {
                to: MemberState::Unreachable,
                ..
            }
        )));
    }

    #[test]
    fn network_partition_and_heal() {
        let mut sim = three_node_cluster(17);
        sim.partition(&["a", "b"], &["c"]);
        sim.run(2_000);
        assert_eq!(sim.state("a", "c"), Some(MemberState::Unreachable));
        assert_eq!(
            sim.state("c", "a"),
            Some(MemberState::Unreachable),
            "both sides see the other as unreachable"
        );
        assert_eq!(
            sim.state("a", "b"),
            Some(MemberState::Alive),
            "majority side intact"
        );
        sim.cut.clear();
        sim.run(1_000);
        for observer in ["a", "b", "c"] {
            for subject in ["a", "b", "c"] {
                assert_eq!(
                    sim.state(observer, subject),
                    Some(MemberState::Alive),
                    "{observer} sees {subject} after heal"
                );
            }
        }
        assert!(
            sim.views().windows(2).all(|w| w[0] == w[1]),
            "views converge after heal"
        );
    }

    #[test]
    fn graceful_leave_and_rejoin_with_higher_incarnation() {
        let mut sim = three_node_cluster(19);
        let now = sim.now;
        let outs = sim
            .nodes
            .get_mut(&id("c"))
            .map(|m| m.leave(now))
            .unwrap_or_default();
        sim.send(&id("c"), outs);
        sim.run(300);
        assert_eq!(sim.state("a", "c"), Some(MemberState::Left));
        assert_eq!(sim.state("b", "c"), Some(MemberState::Left));
        sim.run(3_000);
        assert_eq!(
            sim.state("a", "c"),
            Some(MemberState::Left),
            "left is not re-suspected"
        );

        sim.add("c", "z3", 2, Some("a"));
        sim.run(1_000);
        assert_eq!(sim.state("a", "c"), Some(MemberState::Alive));
        assert_eq!(sim.state("b", "c"), Some(MemberState::Alive));
    }

    #[test]
    fn stale_or_duplicate_gossip_cannot_regress_state() {
        let me = NodeInfo::new(id("a"), "z1");
        let mut m = Membership::new(me, "a:1".into(), 1, 0, CONFIG);
        let digest = |node: &str, inc, state| MemberDigest {
            id: id(node),
            addr: format!("{node}:1"),
            zone: "z".into(),
            incarnation: inc,
            state,
        };
        let hb = |members| Message::Heartbeat {
            from: id("x"),
            members,
        };
        m.handle(1, hb(vec![digest("b", 3, MemberState::Alive)]));
        m.handle(2, hb(vec![digest("b", 2, MemberState::Unreachable)]));
        assert_eq!(
            m.state_of(&id("b")),
            Some(MemberState::Alive),
            "older incarnation ignored"
        );
        m.handle(3, hb(vec![digest("b", 3, MemberState::Suspect)]));
        m.handle(4, hb(vec![digest("b", 3, MemberState::Alive)]));
        assert_eq!(
            m.state_of(&id("b")),
            Some(MemberState::Suspect),
            "same incarnation cannot un-suspect"
        );
        let epoch = m.view_epoch();
        m.handle(5, hb(vec![digest("b", 3, MemberState::Suspect)]));
        assert_eq!(m.view_epoch(), epoch, "duplicates are no-ops");
        m.handle(6, hb(vec![digest("b", 4, MemberState::Alive)]));
        assert_eq!(
            m.state_of(&id("b")),
            Some(MemberState::Alive),
            "refutation wins"
        );

        // Suspicion about ourselves is refuted, and so is a Left from a
        // previous life: a running node never accepts being declared gone.
        m.handle(7, hb(vec![digest("a", 1, MemberState::Suspect)]));
        assert!(
            m.take_events()
                .contains(&MembershipEvent::Refuted { incarnation: 2 })
        );
        m.handle(8, hb(vec![digest("a", 9, MemberState::Left)]));
        assert_eq!(m.state_of(&id("a")), Some(MemberState::Alive));
        assert!(m.members().any(|x| x.id == id("a") && x.incarnation == 10));
    }

    #[test]
    fn messages_round_trip_as_json() {
        let msg = Message::Heartbeat {
            from: id("a"),
            members: vec![MemberDigest {
                id: id("a"),
                addr: "10.0.0.1:7000".into(),
                zone: "z1".into(),
                incarnation: 3,
                state: MemberState::Alive,
            }],
        };
        let json = serde_json::to_string(&msg).expect("serialize");
        assert!(json.contains(r#""type":"heartbeat""#) && json.contains(r#""state":"alive""#));
        assert_eq!(serde_json::from_str::<Message>(&json).expect("parse"), msg);
    }

    proptest! {
        #![proptest_config(ProptestConfig { cases: 32, ..ProptestConfig::default() })]

        /// Under arbitrary loss, duplication and reordering, once the network
        /// becomes reliable every node converges to the same all-alive view.
        #[test]
        fn views_converge_after_a_lossy_period(
            seed in any::<u64>(),
            drop_pct in 0u64..25,
            dup_pct in 0u64..25,
            max_delay_ms in 1u64..150,
        ) {
            let mut sim = Sim::new(seed);
            sim.drop_pct = drop_pct;
            sim.dup_pct = dup_pct;
            sim.max_delay_ms = max_delay_ms;
            sim.add("n0", "z0", 1, None);
            for i in 1..5 {
                sim.add(&format!("n{i}"), &format!("z{}", i % 3), 1, Some("n0"));
            }
            sim.run(5_000);
            sim.drop_pct = 0;
            sim.dup_pct = 0;
            sim.max_delay_ms = 20;
            sim.run(3_000);
            let views = sim.views();
            prop_assert!(views.windows(2).all(|w| w[0] == w[1]), "views differ: {:?}", views);
            prop_assert!(views[0].len() == 5 && views[0].iter().all(|(_, _, s)| *s == MemberState::Alive));
        }
    }
}
