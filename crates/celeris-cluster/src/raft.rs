//! Raft consensus (a minimal, correct subset) and the control-plane state
//! machine built on it.
//!
//! Implemented, following the Raft paper (Ongaro & Ousterhout, 2014):
//!
//! * leader election with randomized timeouts, one vote per term, and the
//!   "candidate log at least as up to date" restriction (§5.2, §5.4.1);
//! * log replication with the `prev_log_index`/`prev_log_term` consistency
//!   check and conflict truncation (§5.3);
//! * a leader commits only entries from its own term, using a no-op entry
//!   appended on election (§5.4.2);
//! * higher terms always win; stale messages are ignored.
//!
//! Not implemented yet: changes to the voter set (the voter set is fixed at
//! bootstrap), snapshots/log compaction, linearizable reads (ReadIndex), and
//! check-quorum leader step-down. None of these are needed for safety.
//!
//! **Persistence contract:** `term`, `voted_for` and the log
//! ([`Raft::persistent_state`]) must be durably stored *before* sending the
//! messages returned by the same call to `tick`, `step` or `propose`.
//! A restarted node resumes with [`Raft::restore`].
//!
//! The control plane is a deterministic state machine over committed
//! [`ControlCommand`]s. Partition ownership therefore changes only when a
//! majority agrees, and a node cut off in a minority can never re-own
//! partitions: its proposals cannot commit.

use std::collections::{BTreeMap, BTreeSet};

use celeris_core::partition::{Move, NodeId, NodeInfo, PartitionMap, PlacementError};
use serde::{Deserialize, Serialize};

pub type Term = u64;
pub type LogIndex = u64;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct RaftConfig {
    pub election_timeout_min_ms: u64,
    pub election_timeout_max_ms: u64,
    pub heartbeat_interval_ms: u64,
    pub max_entries_per_message: usize,
    /// Soft cap on the command bytes in one append message, as measured by
    /// [`Raft::with_entry_size`]. A message always carries at least one
    /// entry, so a single larger entry still goes through alone.
    pub max_bytes_per_message: usize,
}

impl Default for RaftConfig {
    fn default() -> Self {
        RaftConfig {
            election_timeout_min_ms: 1_000,
            election_timeout_max_ms: 2_000,
            heartbeat_interval_ms: 250,
            max_entries_per_message: 64,
            max_bytes_per_message: 8 * 1024 * 1024,
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Role {
    Follower,
    Candidate,
    Leader,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct LogEntry<C> {
    pub term: Term,
    pub index: LogIndex,
    /// `None` is the no-op a new leader appends.
    pub command: Option<C>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "type", rename_all = "snake_case")]
pub enum RaftMessage<C> {
    RequestVote {
        term: Term,
        last_log_index: LogIndex,
        last_log_term: Term,
    },
    Vote {
        term: Term,
        granted: bool,
    },
    /// Pre-vote (Raft thesis 9.6): "would you vote for me in `term`?". It
    /// changes no state, so a node that cannot win (for example, one that
    /// was cut off and kept timing out) never disrupts a healthy leader.
    RequestPreVote {
        term: Term,
        last_log_index: LogIndex,
        last_log_term: Term,
    },
    PreVote {
        term: Term,
        granted: bool,
    },
    Append {
        term: Term,
        prev_log_index: LogIndex,
        prev_log_term: Term,
        entries: Vec<LogEntry<C>>,
        leader_commit: LogIndex,
    },
    AppendAck {
        term: Term,
        success: bool,
        /// On success: the follower's last index matching the leader. On
        /// failure: a hint for where the leader should back up to.
        last_index: LogIndex,
    },
    /// The follower needs entries the leader has compacted away. The
    /// runtime attaches the state-machine snapshot taken at
    /// `last_included_index` and installs it before stepping this message.
    InstallSnapshot {
        term: Term,
        last_included_index: LogIndex,
        last_included_term: Term,
    },
}

impl<C> RaftMessage<C> {
    pub fn term(&self) -> Term {
        match self {
            RaftMessage::RequestVote { term, .. }
            | RaftMessage::Vote { term, .. }
            | RaftMessage::RequestPreVote { term, .. }
            | RaftMessage::PreVote { term, .. }
            | RaftMessage::Append { term, .. }
            | RaftMessage::AppendAck { term, .. }
            | RaftMessage::InstallSnapshot { term, .. } => *term,
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Envelope<C> {
    pub to: NodeId,
    pub message: RaftMessage<C>,
}

/// State that must survive restarts.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct PersistentState<C> {
    pub term: Term,
    pub voted_for: Option<NodeId>,
    /// Entries after `snapshot_index`.
    pub log: Vec<LogEntry<C>>,
    /// Last index covered by the state-machine snapshot (0 = none).
    #[serde(default)]
    pub snapshot_index: LogIndex,
    #[serde(default)]
    pub snapshot_term: Term,
}

impl<C> Default for PersistentState<C> {
    fn default() -> Self {
        PersistentState {
            term: 0,
            voted_for: None,
            log: Vec::new(),
            snapshot_index: 0,
            snapshot_term: 0,
        }
    }
}

/// Returned by [`Raft::propose`] on a non-leader.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct NotLeader {
    /// The leader this node last heard from, if any; clients retry there.
    pub leader: Option<NodeId>,
}

#[derive(Debug, Clone)]
pub struct Raft<C> {
    id: NodeId,
    voters: Vec<NodeId>,
    config: RaftConfig,
    // Persistent.
    term: Term,
    voted_for: Option<NodeId>,
    log: Vec<LogEntry<C>>,
    // Volatile.
    role: Role,
    leader: Option<NodeId>,
    commit_index: LogIndex,
    last_applied: LogIndex,
    votes: BTreeSet<NodeId>,
    next_index: BTreeMap<NodeId, LogIndex>,
    match_index: BTreeMap<NodeId, LogIndex>,
    election_deadline: u64,
    heartbeat_due: u64,
    rng: u64,
    /// Lowest log index written or truncated since the last
    /// [`Raft::take_log_changes`]; lets storage append incrementally.
    dirty_from: Option<LogIndex>,
    // Persistent: the log prefix replaced by a state-machine snapshot.
    snapshot_index: LogIndex,
    snapshot_term: Term,
    /// Set when the snapshot boundary moved; storage must rewrite the log.
    compacted: bool,
    /// Approximate encoded size of a command, for message size caps.
    entry_size: fn(&C) -> usize,
    /// Leader: per peer, the last index sent with entries, and until when
    /// it counts as in flight.
    inflight: BTreeMap<NodeId, (LogIndex, u64)>,
    /// Latest time passed to `tick` or `step`.
    now: u64,
    /// Pre-votes received in the current pre-election, if one is running.
    pre_votes: Option<BTreeSet<NodeId>>,
    /// Follower: when the current leader was last heard from.
    leader_contact: u64,
    /// Leader: when each peer last answered (check-quorum).
    acked_at: BTreeMap<NodeId, u64>,
    /// Leader: when check-quorum last ran.
    quorum_checked: u64,
}

impl<C: Clone> Raft<C> {
    /// A fresh node. `voters` is the fixed voter set (this node is added if
    /// missing). `seed` randomizes election timeouts.
    pub fn new(
        id: NodeId,
        voters: Vec<NodeId>,
        config: RaftConfig,
        seed: u64,
        now_ms: u64,
    ) -> Self {
        Self::restore(id, voters, config, seed, now_ms, PersistentState::default())
    }

    /// Resumes from persisted state after a restart. Volatile state (role,
    /// commit index) starts over, as Raft requires.
    pub fn restore(
        id: NodeId,
        mut voters: Vec<NodeId>,
        config: RaftConfig,
        seed: u64,
        now_ms: u64,
        state: PersistentState<C>,
    ) -> Self {
        voters.push(id.clone());
        voters.sort();
        voters.dedup();
        let mut raft = Raft {
            id,
            voters,
            config,
            term: state.term,
            voted_for: state.voted_for,
            log: state.log,
            role: Role::Follower,
            leader: None,
            // The snapshot is committed and already reflected in the state
            // machine, so it is never re-delivered.
            commit_index: state.snapshot_index,
            last_applied: state.snapshot_index,
            votes: BTreeSet::new(),
            next_index: BTreeMap::new(),
            match_index: BTreeMap::new(),
            election_deadline: 0,
            heartbeat_due: 0,
            rng: seed | 1,
            dirty_from: None,
            snapshot_index: state.snapshot_index,
            snapshot_term: state.snapshot_term,
            compacted: false,
            entry_size: |_| 0,
            inflight: BTreeMap::new(),
            now: now_ms,
            pre_votes: None,
            leader_contact: 0,
            acked_at: BTreeMap::new(),
            quorum_checked: now_ms,
        };
        raft.reset_election_timer(now_ms);
        raft
    }

    /// Re-delivers committed entries after `index` through
    /// [`Raft::take_committed`], because the state machine was reset to its
    /// state at `index` (anti-entropy repair). Returns false if entries
    /// after `index` were compacted away, in which case nothing changes.
    pub fn rewind_applied(&mut self, index: LogIndex) -> bool {
        if index < self.snapshot_index || index > self.commit_index {
            return false;
        }
        self.last_applied = index;
        true
    }

    /// Raises the commit index to a value known to have been committed
    /// before a restart (persisted by the runtime), so committed entries
    /// can be applied without waiting for a leader. Values beyond the
    /// local log are clamped.
    pub fn restore_commit(&mut self, index: LogIndex) {
        self.commit_index = self.commit_index.max(index.min(self.last_index()));
    }

    /// Measures commands so append messages respect
    /// [`RaftConfig::max_bytes_per_message`]. Without it only
    /// `max_entries_per_message` limits a message.
    pub fn with_entry_size(mut self, entry_size: fn(&C) -> usize) -> Self {
        self.entry_size = entry_size;
        self
    }

    pub fn id(&self) -> &NodeId {
        &self.id
    }

    pub fn role(&self) -> Role {
        self.role
    }

    pub fn term(&self) -> Term {
        self.term
    }

    pub fn leader(&self) -> Option<&NodeId> {
        self.leader.as_ref()
    }

    pub fn commit_index(&self) -> LogIndex {
        self.commit_index
    }

    pub fn log(&self) -> &[LogEntry<C>] {
        &self.log
    }

    /// Current term and vote: the small part of the persistent state.
    pub fn hard_state(&self) -> (Term, Option<&NodeId>) {
        (self.term, self.voted_for.as_ref())
    }

    /// The lowest log index changed since the previous call, if any. Every
    /// entry from that index to the end of [`Raft::log`] must be durably
    /// (re)written, and anything after the log's end discarded.
    pub fn take_log_changes(&mut self) -> Option<LogIndex> {
        self.dirty_from.take()
    }

    fn mark_dirty(&mut self, index: LogIndex) {
        self.dirty_from = Some(self.dirty_from.map_or(index, |d| d.min(index)));
    }

    pub fn persistent_state(&self) -> PersistentState<C> {
        PersistentState {
            term: self.term,
            voted_for: self.voted_for.clone(),
            log: self.log.clone(),
            snapshot_index: self.snapshot_index,
            snapshot_term: self.snapshot_term,
        }
    }

    /// (index, term) of the snapshot boundary.
    pub fn snapshot_meta(&self) -> (LogIndex, Term) {
        (self.snapshot_index, self.snapshot_term)
    }

    /// True once if the snapshot boundary moved since the last call: the
    /// stored log must then be rewritten from scratch with the new boundary.
    pub fn take_compaction(&mut self) -> bool {
        std::mem::take(&mut self.compacted)
    }

    /// Term of the entry at `index`, if still known (not compacted away).
    pub fn entry_term(&self, index: LogIndex) -> Option<Term> {
        self.term_at(index)
    }

    pub fn last_applied(&self) -> LogIndex {
        self.last_applied
    }

    /// Discards log entries up to `upto`, which the state machine has
    /// applied (and made durable). Returns false if nothing changed.
    pub fn compact(&mut self, upto: LogIndex) -> bool {
        let upto = upto.min(self.last_applied);
        if upto <= self.snapshot_index {
            return false;
        }
        let Some(term) = self.term_at(upto) else {
            return false;
        };
        self.log.drain(..(upto - self.snapshot_index) as usize);
        self.snapshot_index = upto;
        self.snapshot_term = term;
        self.compacted = true;
        true
    }

    /// Whether a snapshot offered by a leader in `term` covering up to
    /// `index` would be accepted. The runtime installs the snapshot data
    /// into the state machine only if this is true, then steps the
    /// `InstallSnapshot` message.
    pub fn should_install_snapshot(&self, term: Term, index: LogIndex) -> bool {
        term >= self.term && index > self.commit_index
    }

    /// Committed entries not yet handed out, in order. Apply them to the
    /// state machine exactly in this order.
    pub fn take_committed(&mut self) -> Vec<LogEntry<C>> {
        let from = (self.last_applied - self.snapshot_index) as usize;
        let to = (self.commit_index - self.snapshot_index) as usize;
        self.last_applied = self.commit_index;
        self.log[from..to].to_vec()
    }

    /// Appends a command if this node is the leader. The entry is committed
    /// once a majority stores it; watch [`Raft::take_committed`].
    pub fn propose(&mut self, command: C) -> Result<(LogIndex, Vec<Envelope<C>>), NotLeader> {
        if self.role != Role::Leader {
            return Err(NotLeader {
                leader: self.leader.clone(),
            });
        }
        let index = self.append_local(Some(command));
        self.advance_commit();
        Ok((index, self.broadcast_append()))
    }

    pub fn tick(&mut self, now_ms: u64) -> Vec<Envelope<C>> {
        self.now = self.now.max(now_ms);
        match self.role {
            Role::Leader if now_ms >= self.quorum_checked + self.config.election_timeout_max_ms => {
                self.quorum_checked = now_ms;
                if !self.has_recent_quorum(now_ms) {
                    // Check-quorum: a leader cut off from the majority steps
                    // down instead of serving (and redirecting) forever.
                    self.role = Role::Follower;
                    self.leader = None;
                    self.reset_election_timer(now_ms);
                    return Vec::new();
                }
                self.heartbeat_due = now_ms;
                self.tick(now_ms)
            }
            Role::Leader if now_ms >= self.heartbeat_due => {
                self.heartbeat_due = now_ms + self.config.heartbeat_interval_ms;
                self.broadcast_append()
            }
            Role::Follower | Role::Candidate if now_ms >= self.election_deadline => {
                self.start_pre_vote(now_ms)
            }
            _ => Vec::new(),
        }
    }

    /// Whether a majority (counting this leader) answered within the
    /// longest election timeout.
    fn has_recent_quorum(&self, now_ms: u64) -> bool {
        let window = self.config.election_timeout_max_ms;
        let recent = self
            .peers()
            .filter(|p| {
                self.acked_at
                    .get(*p)
                    .is_some_and(|&at| at + window >= now_ms)
            })
            .count();
        recent + 1 >= self.quorum()
    }

    /// Whether this follower heard from a live leader within the minimum
    /// election timeout; such a node refuses to help depose it.
    fn leader_is_fresh(&self, now_ms: u64) -> bool {
        self.role == Role::Follower
            && self.leader.is_some()
            && now_ms < self.leader_contact + self.config.election_timeout_min_ms
    }

    fn start_pre_vote(&mut self, now_ms: u64) -> Vec<Envelope<C>> {
        self.reset_election_timer(now_ms);
        self.pre_votes = Some(BTreeSet::from([self.id.clone()]));
        if 1 >= self.quorum() {
            return self.start_election(now_ms);
        }
        let request = RaftMessage::RequestPreVote {
            term: self.term + 1,
            last_log_index: self.last_index(),
            last_log_term: self.last_term(),
        };
        self.peers()
            .map(|p| Envelope {
                to: p.clone(),
                message: request.clone(),
            })
            .collect()
    }

    pub fn step(&mut self, now_ms: u64, from: NodeId, message: RaftMessage<C>) -> Vec<Envelope<C>> {
        if from == self.id || !self.voters.contains(&from) {
            return Vec::new();
        }
        self.now = self.now.max(now_ms);
        let sticky =
            matches!(message, RaftMessage::RequestVote { .. }) && self.leader_is_fresh(now_ms);
        let pre_vote = matches!(
            message,
            RaftMessage::RequestPreVote { .. } | RaftMessage::PreVote { .. }
        );
        if message.term() > self.term && !sticky && !pre_vote {
            self.become_follower(message.term(), now_ms);
        }
        match message {
            RaftMessage::RequestPreVote {
                term,
                last_log_index,
                last_log_term,
            } => {
                let up_to_date = last_log_term > self.last_term()
                    || (last_log_term == self.last_term() && last_log_index >= self.last_index());
                let granted = term > self.term
                    && up_to_date
                    && !self.leader_is_fresh(now_ms)
                    && self.role != Role::Leader;
                vec![Envelope {
                    to: from,
                    message: RaftMessage::PreVote { term, granted },
                }]
            }
            RaftMessage::PreVote { term, granted } => {
                if granted
                    && term == self.term + 1
                    && self.role != Role::Leader
                    && let Some(votes) = &mut self.pre_votes
                {
                    votes.insert(from);
                    if votes.len() >= self.quorum() {
                        self.pre_votes = None;
                        return self.start_election(now_ms);
                    }
                }
                Vec::new()
            }
            RaftMessage::RequestVote { .. } if sticky => Vec::new(),
            RaftMessage::RequestVote {
                term,
                last_log_index,
                last_log_term,
            } => {
                let up_to_date = last_log_term > self.last_term()
                    || (last_log_term == self.last_term() && last_log_index >= self.last_index());
                let free = self.voted_for.as_ref().is_none_or(|v| *v == from);
                let granted = term == self.term && up_to_date && free;
                if granted {
                    self.voted_for = Some(from.clone());
                    self.reset_election_timer(now_ms);
                }
                vec![Envelope {
                    to: from,
                    message: RaftMessage::Vote {
                        term: self.term,
                        granted,
                    },
                }]
            }
            RaftMessage::Vote { term, granted } => {
                if self.role == Role::Candidate && term == self.term && granted {
                    self.votes.insert(from);
                    if self.votes.len() >= self.quorum() {
                        return self.become_leader(now_ms);
                    }
                }
                Vec::new()
            }
            RaftMessage::Append {
                term,
                prev_log_index,
                prev_log_term,
                entries,
                leader_commit,
            } => {
                if term < self.term {
                    return vec![self.ack(from, false, self.last_index())];
                }
                // Same term: only one leader can exist, so candidates yield.
                self.role = Role::Follower;
                self.votes.clear();
                self.pre_votes = None;
                self.leader = Some(from.clone());
                self.leader_contact = now_ms;
                self.reset_election_timer(now_ms);
                // Entries up to the snapshot are committed, so they match the
                // leader's log by Raft's log-matching property.
                let prev_matches = prev_log_index <= self.snapshot_index
                    || self.term_at(prev_log_index) == Some(prev_log_term);
                if !prev_matches {
                    let hint = self.last_index().min(prev_log_index.saturating_sub(1));
                    return vec![self.ack(from, false, hint)];
                }
                let mut last_new = prev_log_index;
                for entry in entries {
                    if entry.index <= self.snapshot_index {
                        last_new = entry.index;
                        continue;
                    }
                    match self.term_at(entry.index) {
                        Some(t) if t == entry.term => {}
                        Some(_) => {
                            // Conflict: drop it and everything after. Raft
                            // guarantees this never touches committed entries.
                            self.log
                                .truncate((entry.index - self.snapshot_index - 1) as usize);
                            self.log.push(entry.clone());
                            self.mark_dirty(entry.index);
                        }
                        None => {
                            self.log.push(entry.clone());
                            self.mark_dirty(entry.index);
                        }
                    }
                    last_new = entry.index;
                }
                if leader_commit > self.commit_index {
                    self.commit_index = self.commit_index.max(leader_commit.min(last_new));
                }
                vec![self.ack(from, true, last_new)]
            }
            RaftMessage::InstallSnapshot {
                term,
                last_included_index,
                last_included_term,
            } => {
                if term < self.term {
                    return vec![self.ack(from, false, self.last_index())];
                }
                self.role = Role::Follower;
                self.votes.clear();
                self.pre_votes = None;
                self.leader = Some(from.clone());
                self.leader_contact = now_ms;
                self.reset_election_timer(now_ms);
                if last_included_index > self.commit_index {
                    // The runtime has installed the snapshot data (see
                    // `should_install_snapshot`). Keep any log suffix that
                    // agrees with it; otherwise the log is superseded.
                    if self.term_at(last_included_index) == Some(last_included_term) {
                        self.log
                            .drain(..(last_included_index - self.snapshot_index) as usize);
                    } else {
                        self.log.clear();
                    }
                    self.snapshot_index = last_included_index;
                    self.snapshot_term = last_included_term;
                    self.commit_index = last_included_index;
                    self.last_applied = last_included_index;
                    self.compacted = true;
                }
                vec![self.ack(from, true, last_included_index)]
            }
            RaftMessage::AppendAck {
                term,
                success,
                last_index,
            } => {
                if self.role != Role::Leader || term != self.term {
                    return Vec::new();
                }
                self.acked_at.insert(from.clone(), now_ms);
                if success {
                    let matched = self.match_index.entry(from.clone()).or_insert(0);
                    *matched = (*matched).max(last_index);
                    let next = self.next_index.entry(from).or_insert(1);
                    *next = (*next).max(last_index + 1);
                    self.advance_commit();
                    Vec::new()
                } else {
                    let next = self.next_index.get(&from).copied().unwrap_or(1);
                    let backed_up = (last_index + 1).min(next.saturating_sub(1)).max(1);
                    self.next_index.insert(from.clone(), backed_up);
                    self.inflight.remove(&from);
                    vec![self.append_for(&from)]
                }
            }
        }
    }

    fn quorum(&self) -> usize {
        self.voters.len() / 2 + 1
    }

    fn last_index(&self) -> LogIndex {
        self.snapshot_index + self.log.len() as LogIndex
    }

    fn last_term(&self) -> Term {
        self.log.last().map_or(self.snapshot_term, |e| e.term)
    }

    fn term_at(&self, index: LogIndex) -> Option<Term> {
        if index == 0 {
            return Some(0);
        }
        if index < self.snapshot_index {
            return None; // compacted away
        }
        if index == self.snapshot_index {
            return Some(self.snapshot_term);
        }
        self.log
            .get((index - self.snapshot_index - 1) as usize)
            .map(|e| e.term)
    }

    fn rand(&mut self) -> u64 {
        self.rng ^= self.rng << 13;
        self.rng ^= self.rng >> 7;
        self.rng ^= self.rng << 17;
        self.rng
    }

    fn reset_election_timer(&mut self, now_ms: u64) {
        let c = self.config;
        let span = c
            .election_timeout_max_ms
            .saturating_sub(c.election_timeout_min_ms)
            + 1;
        self.election_deadline = now_ms + c.election_timeout_min_ms + self.rand() % span;
    }

    fn peers(&self) -> impl Iterator<Item = &NodeId> {
        self.voters.iter().filter(|v| **v != self.id)
    }

    fn become_follower(&mut self, term: Term, now_ms: u64) {
        self.term = term;
        self.voted_for = None;
        self.role = Role::Follower;
        self.leader = None;
        self.votes.clear();
        self.reset_election_timer(now_ms);
    }

    fn start_election(&mut self, now_ms: u64) -> Vec<Envelope<C>> {
        self.term += 1;
        self.role = Role::Candidate;
        self.leader = None;
        self.voted_for = Some(self.id.clone());
        self.votes = BTreeSet::from([self.id.clone()]);
        self.reset_election_timer(now_ms);
        if self.votes.len() >= self.quorum() {
            return self.become_leader(now_ms);
        }
        let request = RaftMessage::RequestVote {
            term: self.term,
            last_log_index: self.last_index(),
            last_log_term: self.last_term(),
        };
        self.peers()
            .map(|p| Envelope {
                to: p.clone(),
                message: request.clone(),
            })
            .collect()
    }

    fn become_leader(&mut self, now_ms: u64) -> Vec<Envelope<C>> {
        self.role = Role::Leader;
        self.leader = Some(self.id.clone());
        let next = self.last_index() + 1;
        let peers: Vec<NodeId> = self.peers().cloned().collect();
        self.next_index = peers.iter().map(|p| (p.clone(), next)).collect();
        // Every peer gets a full window to answer before check-quorum.
        self.acked_at = peers.iter().map(|p| (p.clone(), now_ms)).collect();
        self.quorum_checked = now_ms;
        self.match_index = peers.into_iter().map(|p| (p, 0)).collect();
        self.inflight.clear();
        self.pre_votes = None;
        // A no-op in the new term lets entries from earlier terms commit.
        self.append_local(None);
        self.advance_commit();
        self.heartbeat_due = now_ms + self.config.heartbeat_interval_ms;
        self.broadcast_append()
    }

    fn append_local(&mut self, command: Option<C>) -> LogIndex {
        let index = self.last_index() + 1;
        self.mark_dirty(index);
        self.log.push(LogEntry {
            term: self.term,
            index,
            command,
        });
        index
    }

    fn ack(&self, to: NodeId, success: bool, last_index: LogIndex) -> Envelope<C> {
        Envelope {
            to,
            message: RaftMessage::AppendAck {
                term: self.term,
                success,
                last_index,
            },
        }
    }

    fn append_for(&mut self, peer: &NodeId) -> Envelope<C> {
        let next = self.next_index.get(peer).copied().unwrap_or(1).max(1);
        if next <= self.snapshot_index {
            // The entries this peer needs were compacted away. The runtime
            // attaches the actual state-machine snapshot to this message.
            return Envelope {
                to: peer.clone(),
                message: RaftMessage::InstallSnapshot {
                    term: self.term,
                    last_included_index: self.snapshot_index,
                    last_included_term: self.snapshot_term,
                },
            };
        }
        let prev = next - 1;
        let mut bytes = 0usize;
        let mut entries: Vec<LogEntry<C>> = self.log[(prev - self.snapshot_index) as usize..]
            .iter()
            .take(self.config.max_entries_per_message)
            .take_while(|e| {
                let first = bytes == 0;
                bytes = bytes.saturating_add(e.command.as_ref().map_or(0, self.entry_size).max(1));
                first || bytes <= self.config.max_bytes_per_message
            })
            .cloned()
            .collect();
        if let Some(last) = entries.last().map(|e| e.index) {
            // Entries sent moments ago are probably still in flight (large
            // ones can take a while). Resending them on every heartbeat
            // would only bury the follower, so heartbeat without them until
            // the resend window passes or the follower answers. The window
            // grows with the message: 1 ms per 4 KiB on top of half the
            // election timeout.
            let recent = self
                .inflight
                .get(peer)
                .is_some_and(|&(sent, until)| sent >= last && self.now < until);
            if recent {
                entries.clear();
            } else {
                let window = self.config.election_timeout_min_ms / 2 + (bytes / 4096) as u64;
                self.inflight
                    .insert(peer.clone(), (last, self.now.saturating_add(window)));
            }
        }
        Envelope {
            to: peer.clone(),
            message: RaftMessage::Append {
                term: self.term,
                prev_log_index: prev,
                prev_log_term: self.term_at(prev).unwrap_or(0),
                entries,
                leader_commit: self.commit_index,
            },
        }
    }

    fn broadcast_append(&mut self) -> Vec<Envelope<C>> {
        let peers: Vec<NodeId> = self.peers().cloned().collect();
        peers.iter().map(|p| self.append_for(p)).collect()
    }

    /// Commits the highest current-term index stored on a majority.
    fn advance_commit(&mut self) {
        if self.role != Role::Leader {
            return;
        }
        for n in (self.commit_index + 1..=self.last_index()).rev() {
            if self.term_at(n) != Some(self.term) {
                break; // terms only decrease going back
            }
            let replicas = 1 + self.match_index.values().filter(|&&m| m >= n).count();
            if replicas >= self.quorum() {
                self.commit_index = n;
                break;
            }
        }
    }
}

/// Commands replicated through the control-plane log.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "type", rename_all = "snake_case")]
pub enum ControlCommand {
    /// Place partitions on exactly these nodes with this replication factor.
    /// Every partition whose replica set changes starts a [`Migration`].
    SetNodes {
        nodes: Vec<NodeInfo>,
        replication_factor: u8,
    },
    /// Moves the listed partitions' migrations from phase `from` to `to`
    /// (`None`: finished). Partitions not currently in phase `from` are
    /// left alone, so duplicate and stale proposals are harmless.
    AdvanceMigration {
        partitions: Vec<u16>,
        from: MigrationPhase,
        to: Option<MigrationPhase>,
    },
}

/// Progress of moving one partition's data between replica sets (D-020).
#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum MigrationPhase {
    /// Data still served by the source; the source must fence writes.
    Moving,
    /// The source rejects writes; the destination copies the data.
    Fenced,
    /// The destination holds the data; the source must release (stop
    /// serving reads), after which the migration finishes.
    Imported,
}

/// A partition whose replica set changed. Requests keep going to `from`
/// until the migration finishes; then `to` (the map's replicas) serves.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct Migration {
    /// Source replica set, sorted.
    pub from: Vec<NodeId>,
    /// Destination replica set, sorted.
    pub to: Vec<NodeId>,
    pub phase: MigrationPhase,
}

/// Why a control command was rejected (identically on every node).
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum ControlError {
    Placement(PlacementError),
    /// A new placement is refused until running migrations finish.
    MigrationsPending(usize),
}

impl std::fmt::Display for ControlError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            ControlError::Placement(e) => write!(f, "{e}"),
            ControlError::MigrationsPending(n) => write!(
                f,
                "{n} partition migrations are still running; retry when they finish"
            ),
        }
    }
}

impl std::error::Error for ControlError {}

impl From<PlacementError> for ControlError {
    fn from(e: PlacementError) -> Self {
        ControlError::Placement(e)
    }
}

/// The agreed cluster configuration, rebuilt identically on every node by
/// applying committed entries in log order.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct ControlState {
    map: Option<PartitionMap>,
    migrations: BTreeMap<u16, Migration>,
    applied_index: LogIndex,
}

fn sorted_set(ids: Vec<&NodeId>) -> Vec<NodeId> {
    let mut v: Vec<NodeId> = ids.into_iter().cloned().collect();
    v.sort();
    v
}

impl ControlState {
    pub fn partition_map(&self) -> Option<&PartitionMap> {
        self.map.as_ref()
    }

    /// Running migrations by partition.
    pub fn migrations(&self) -> &BTreeMap<u16, Migration> {
        &self.migrations
    }

    pub fn applied_index(&self) -> LogIndex {
        self.applied_index
    }

    /// Applies one committed entry. Returns `None` for no-ops and migration
    /// steps, otherwise the partition moves, or the (deterministic)
    /// rejection of an invalid command, which every node reaches
    /// identically.
    pub fn apply(
        &mut self,
        entry: &LogEntry<ControlCommand>,
    ) -> Option<Result<Vec<Move>, ControlError>> {
        self.applied_index = entry.index;
        match entry.command.as_ref()? {
            ControlCommand::SetNodes {
                nodes,
                replication_factor,
            } => Some(self.set_nodes(nodes, *replication_factor)),
            ControlCommand::AdvanceMigration {
                partitions,
                from,
                to,
            } => {
                for p in partitions {
                    let Some(m) = self.migrations.get_mut(p) else {
                        continue;
                    };
                    if m.phase != *from {
                        continue;
                    }
                    match to {
                        Some(next) => m.phase = *next,
                        None => {
                            self.migrations.remove(p);
                        }
                    }
                }
                None
            }
        }
    }

    fn set_nodes(&mut self, nodes: &[NodeInfo], rf: u8) -> Result<Vec<Move>, ControlError> {
        if !self.migrations.is_empty() {
            return Err(ControlError::MigrationsPending(self.migrations.len()));
        }
        let (map, moves) = match &self.map {
            None => (PartitionMap::new(nodes.to_vec(), rf)?, Vec::new()),
            Some(current) => current.rebalance(nodes.to_vec(), rf)?,
        };
        if let Some(old) = &self.map {
            for p in celeris_core::partition::PartitionId::all() {
                let from = sorted_set(old.replica_ids(p));
                let to = sorted_set(map.replica_ids(p));
                if from != to {
                    self.migrations.insert(
                        p.get(),
                        Migration {
                            from,
                            to,
                            phase: MigrationPhase::Moving,
                        },
                    );
                }
            }
        }
        self.map = Some(map);
        Ok(moves)
    }
}
#[cfg(test)]
mod tests {
    use std::collections::HashSet;

    use proptest::prelude::*;

    use super::*;

    const CONFIG: RaftConfig = RaftConfig {
        election_timeout_min_ms: 150,
        election_timeout_max_ms: 300,
        heartbeat_interval_ms: 50,
        max_entries_per_message: 8,
        max_bytes_per_message: 1024,
    };
    const STEP_MS: u64 = 10;

    fn id(s: &str) -> NodeId {
        NodeId::new(s).expect("id")
    }

    /// Simulated cluster that checks Raft's safety properties after every step:
    /// * election safety: at most one leader per term;
    /// * state machine safety: every node applies the same entry at each index.
    struct Sim<C> {
        now: u64,
        names: Vec<NodeId>,
        nodes: BTreeMap<NodeId, Raft<C>>,
        down: HashSet<NodeId>,
        cut: HashSet<(NodeId, NodeId)>,
        queue: Vec<(u64, NodeId, NodeId, RaftMessage<C>)>,
        rng: u64,
        drop_pct: u64,
        dup_pct: u64,
        max_delay_ms: u64,
        leaders: BTreeMap<Term, NodeId>,
        committed: Vec<LogEntry<C>>,
        applied: BTreeMap<NodeId, Vec<LogEntry<C>>>,
        /// Compact a node's log to its applied index once it retains more
        /// than this many entries.
        compact_above: Option<usize>,
        snapshots_installed: usize,
    }

    impl<C: Clone + PartialEq + std::fmt::Debug> Sim<C> {
        fn new(n: usize, seed: u64) -> Self {
            let names: Vec<NodeId> = (0..n).map(|i| id(&format!("r{i}"))).collect();
            let nodes = names
                .iter()
                .enumerate()
                .map(|(i, name)| {
                    let raft = Raft::new(
                        name.clone(),
                        names.clone(),
                        CONFIG,
                        seed ^ ((i as u64 + 1) * 7919),
                        0,
                    );
                    (name.clone(), raft)
                })
                .collect();
            Sim {
                now: 0,
                applied: names.iter().map(|n| (n.clone(), Vec::new())).collect(),
                names,
                nodes,
                down: HashSet::new(),
                cut: HashSet::new(),
                queue: Vec::new(),
                rng: seed | 1,
                drop_pct: 0,
                dup_pct: 0,
                max_delay_ms: 15,
                leaders: BTreeMap::new(),
                committed: Vec::new(),
                compact_above: None,
                snapshots_installed: 0,
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

        fn send(&mut self, from: &NodeId, out: Vec<Envelope<C>>) {
            for e in out {
                if self.rand() % 100 < self.drop_pct {
                    continue;
                }
                let copies = if self.rand() % 100 < self.dup_pct {
                    2
                } else {
                    1
                };
                for _ in 0..copies {
                    let at = self.now + 1 + self.rand() % self.max_delay_ms;
                    self.queue
                        .push((at, from.clone(), e.to.clone(), e.message.clone()));
                }
            }
        }

        fn check(&mut self) {
            for (name, raft) in &mut self.nodes {
                if raft.role() == Role::Leader {
                    let holder = self
                        .leaders
                        .entry(raft.term())
                        .or_insert_with(|| name.clone());
                    assert_eq!(holder, name, "two leaders in term {}", raft.term());
                }
                for entry in raft.take_committed() {
                    let i = entry.index as usize - 1;
                    match self.committed.get(i) {
                        Some(known) => assert_eq!(
                            known, &entry,
                            "{name} applied a different entry at {}",
                            entry.index
                        ),
                        None => {
                            assert_eq!(i, self.committed.len(), "gap in committed history");
                            self.committed.push(entry.clone());
                        }
                    }
                    self.applied.entry(name.clone()).or_default().push(entry);
                }
                if let Some(limit) = self.compact_above
                    && raft.log().len() > limit
                {
                    raft.compact(raft.last_applied());
                }
            }
        }

        /// What the runtime does with an `InstallSnapshot`: replace the
        /// node's state machine with the leader's (here: the committed
        /// history up to the snapshot index) if Raft would accept it.
        fn install_snapshot(&mut self, to: &NodeId, msg: &RaftMessage<C>) {
            let RaftMessage::InstallSnapshot {
                term,
                last_included_index,
                ..
            } = msg
            else {
                return;
            };
            if self.nodes[to].should_install_snapshot(*term, *last_included_index) {
                let state = self.committed[..*last_included_index as usize].to_vec();
                self.applied.insert(to.clone(), state);
                self.snapshots_installed += 1;
            }
        }

        fn run(&mut self, ms: u64) {
            let end = self.now + ms;
            while self.now < end {
                self.now += STEP_MS;
                let now = self.now;
                let (due, rest): (Vec<_>, Vec<_>) =
                    self.queue.drain(..).partition(|(at, ..)| *at <= now);
                self.queue = rest;
                for (_, from, to, msg) in due {
                    if self.down.contains(&to) || !self.linked(&from, &to) {
                        continue;
                    }
                    self.install_snapshot(&to, &msg);
                    let out = self
                        .nodes
                        .get_mut(&to)
                        .map(|r| r.step(now, from, msg))
                        .unwrap_or_default();
                    self.send(&to, out);
                }
                let live: Vec<NodeId> = self
                    .names
                    .iter()
                    .filter(|n| !self.down.contains(*n))
                    .cloned()
                    .collect();
                for n in live {
                    let out = self
                        .nodes
                        .get_mut(&n)
                        .map(|r| r.tick(now))
                        .unwrap_or_default();
                    self.send(&n, out);
                }
                self.check();
            }
        }

        fn leader(&self) -> Option<NodeId> {
            self.nodes
                .iter()
                .filter(|(n, r)| r.role() == Role::Leader && !self.down.contains(*n))
                .max_by_key(|(_, r)| r.term())
                .map(|(n, _)| n.clone())
        }

        fn propose(&mut self, at: &NodeId, command: C) -> Option<LogIndex> {
            if self.down.contains(at) {
                return None;
            }
            let (index, out) = self.nodes.get_mut(at)?.propose(command).ok()?;
            let at = at.clone();
            self.send(&at, out);
            self.check();
            Some(index)
        }

        fn crash(&mut self, n: &NodeId) {
            self.down.insert(n.clone());
        }

        fn restart(&mut self, n: &NodeId) {
            if !self.down.remove(n) {
                return;
            }
            let state = self.nodes[n].persistent_state();
            // The state machine restarts from its last snapshot.
            if let Some(applied) = self.applied.get_mut(n) {
                applied.truncate(state.snapshot_index as usize);
            }
            let seed = self.rand();
            let restored =
                Raft::restore(n.clone(), self.names.clone(), CONFIG, seed, self.now, state);
            self.nodes.insert(n.clone(), restored);
        }

        fn isolate(&mut self, n: &NodeId) {
            for other in self.names.clone() {
                if other != *n {
                    self.cut.insert((n.clone(), other));
                }
            }
        }

        fn committed_commands(&self) -> Vec<C> {
            self.committed
                .iter()
                .filter_map(|e| e.command.clone())
                .collect()
        }
    }

    #[test]
    fn single_voter_commits_immediately() {
        let mut raft: Raft<u64> = Raft::new(id("solo"), vec![], CONFIG, 1, 0);
        assert!(raft.tick(400).is_empty(), "no peers to message");
        assert_eq!(raft.role(), Role::Leader);
        let (index, out) = raft.propose(42).expect("leader");
        assert!(out.is_empty());
        assert_eq!(raft.commit_index(), index);
        let applied: Vec<_> = raft
            .take_committed()
            .into_iter()
            .filter_map(|e| e.command)
            .collect();
        assert_eq!(applied, vec![42]);
        assert_eq!(
            raft.take_log_changes(),
            Some(1),
            "no-op and proposal are new"
        );
        assert_eq!(raft.take_log_changes(), None);
        raft.propose(43).expect("leader");
        assert_eq!(raft.take_log_changes(), Some(3));
        assert_eq!(raft.hard_state().0, raft.term());
    }

    #[test]
    fn three_nodes_elect_one_leader_and_replicate() {
        let mut sim: Sim<u64> = Sim::new(3, 1);
        sim.run(1_000);
        let leader = sim.leader().expect("leader elected");
        for v in 1..=5 {
            sim.propose(&leader, v).expect("accepted");
        }
        let follower = sim
            .names
            .iter()
            .find(|n| **n != leader)
            .cloned()
            .expect("follower");
        assert!(matches!(
            sim.nodes.get_mut(&follower).map(|r| r.propose(9)),
            Some(Err(NotLeader { leader: Some(l) })) if l == leader
        ));
        sim.run(500);
        assert_eq!(sim.committed_commands(), vec![1, 2, 3, 4, 5]);
        for name in &sim.names {
            let applied: Vec<u64> = sim.applied[name].iter().filter_map(|e| e.command).collect();
            assert_eq!(applied, vec![1, 2, 3, 4, 5], "{name}");
        }
    }

    #[test]
    fn leader_crash_fails_over_without_losing_commits() {
        let mut sim: Sim<u64> = Sim::new(3, 2);
        sim.run(1_000);
        let first = sim.leader().expect("leader");
        sim.propose(&first, 1);
        sim.run(300);
        let first_term = sim.nodes[&first].term();
        sim.crash(&first);
        sim.run(1_500);
        let second = sim.leader().expect("new leader");
        assert_ne!(second, first);
        assert!(sim.nodes[&second].term() > first_term);
        sim.propose(&second, 2);
        sim.run(300);
        sim.restart(&first);
        sim.run(1_000);
        assert_eq!(sim.committed_commands(), vec![1, 2]);
        let rejoined: Vec<u64> = sim.nodes[&first]
            .log()
            .iter()
            .filter_map(|e| e.command)
            .collect();
        assert_eq!(rejoined, vec![1, 2], "restarted node catches up");
    }

    #[test]
    fn lagging_follower_catches_up_from_a_snapshot() {
        let mut sim: Sim<u64> = Sim::new(3, 9);
        sim.compact_above = Some(4);
        sim.run(1_000);
        let leader = sim.leader().expect("leader");
        let lagging = sim
            .names
            .iter()
            .find(|n| **n != leader)
            .cloned()
            .expect("follower");
        sim.crash(&lagging);
        for v in 1..=30 {
            sim.propose(&leader, v).expect("accepted");
            sim.run(50);
        }
        let (snapshot_index, _) = sim.nodes[&leader].snapshot_meta();
        assert!(snapshot_index > 10, "leader compacted its log");
        assert!(sim.nodes[&leader].log().len() <= 5);

        sim.restart(&lagging);
        sim.run(1_500);
        assert!(sim.snapshots_installed >= 1, "catch-up used a snapshot");
        let caught_up: Vec<u64> = sim.applied[&lagging]
            .iter()
            .filter_map(|e| e.command)
            .collect();
        assert_eq!(caught_up, (1..=30).collect::<Vec<_>>());
        assert_eq!(
            sim.nodes[&lagging].commit_index(),
            sim.nodes[&leader].commit_index()
        );

        // The restored follower restarts from its own snapshot, not index 1.
        sim.crash(&lagging);
        sim.restart(&lagging);
        sim.run(500);
        let again: Vec<u64> = sim.applied[&lagging]
            .iter()
            .filter_map(|e| e.command)
            .collect();
        assert_eq!(again, (1..=30).collect::<Vec<_>>());
    }

    #[test]
    fn append_messages_respect_the_byte_cap_but_always_carry_one_entry() {
        let voters = vec![id("l"), id("f")];
        // Command "size" is its value; the cap is 1024 bytes.
        let mut leader: Raft<u64> =
            Raft::new(id("l"), voters.clone(), CONFIG, 1, 0).with_entry_size(|v| *v as usize);
        let mut follower: Raft<u64> = Raft::new(id("f"), voters, CONFIG, 2, 0);
        let sync = |leader: &mut Raft<u64>, follower: &mut Raft<u64>, out: Vec<Envelope<u64>>| {
            let mut queue = out;
            while let Some(e) = queue.pop() {
                for reply in follower.step(1_000, id("l"), e.message) {
                    queue.extend(leader.step(1_000, id("f"), reply.message));
                }
            }
        };
        let out = leader.tick(1_000);
        sync(&mut leader, &mut follower, out);
        assert_eq!(leader.role(), Role::Leader);
        let entries = |out: &[Envelope<u64>]| match &out[0].message {
            RaftMessage::Append { entries, .. } => {
                entries.iter().filter_map(|e| e.command).collect::<Vec<_>>()
            }
            other => panic!("expected an append, got {other:?}"),
        };

        let (_, big) = leader.propose(5_000).expect("leader");
        assert_eq!(entries(&big), vec![5_000], "an oversized entry goes alone");
        let mut last = Vec::new();
        for _ in 0..4 {
            last = leader.propose(400).expect("leader").1;
        }
        assert_eq!(
            entries(&last),
            Vec::<u64>::new(),
            "the in-flight entry is not resent at once"
        );
        sync(&mut leader, &mut follower, big);
        let out = leader.tick(1_100);
        assert_eq!(entries(&out), vec![400, 400], "two fit in 1024 bytes");
        // Unacknowledged entries are resent once the resend window passes.
        let out = leader.tick(1_160);
        assert_eq!(entries(&out), Vec::<u64>::new(), "still in flight");
        let out = leader.tick(1_290);
        assert_eq!(entries(&out), vec![400, 400], "resent");
    }

    #[test]
    fn pre_vote_keeps_rejoining_nodes_harmless_and_check_quorum_demotes_cut_off_leaders() {
        let mut sim: Sim<u64> = Sim::new(3, 11);
        sim.run(1_000);
        let leader = sim.leader().expect("leader");
        let term = sim.nodes[&leader].term();
        let follower = sim
            .names
            .iter()
            .find(|n| **n != leader)
            .cloned()
            .expect("follower");
        // The cut-off follower keeps timing out, but without a majority of
        // pre-votes it never raises its term.
        sim.isolate(&follower);
        sim.run(3_000);
        assert_eq!(sim.nodes[&follower].term(), term, "no term inflation");
        sim.cut.clear();
        sim.run(1_000);
        assert_eq!(
            sim.leader(),
            Some(leader.clone()),
            "the leader was not deposed"
        );
        assert_eq!(sim.nodes[&leader].term(), term);

        // A leader cut off from the majority steps down on its own.
        sim.isolate(&leader);
        sim.run(2_000);
        assert_ne!(sim.nodes[&leader].role(), Role::Leader);
        let new_leader = sim.leader().expect("majority elects a new leader");
        assert_ne!(new_leader, leader);
    }

    #[test]
    fn compaction_only_discards_applied_entries() {
        let mut raft: Raft<u64> = Raft::new(id("solo"), vec![], CONFIG, 1, 0);
        raft.tick(400);
        for v in 1..=3 {
            raft.propose(v).expect("leader");
        }
        assert!(!raft.compact(2), "nothing applied yet");
        raft.take_committed();
        assert!(raft.compact(2));
        assert!(raft.take_compaction());
        assert!(!raft.take_compaction(), "reported once");
        assert_eq!(raft.snapshot_meta(), (2, raft.term()));
        assert_eq!(raft.log().len(), 2);
        assert_eq!(raft.entry_term(1), None, "compacted away");
        assert_eq!(raft.entry_term(4), Some(raft.term()));
        let (index, _) = raft.propose(4).expect("leader");
        assert_eq!(index, 5, "indices continue after the snapshot");
        let applied: Vec<u64> = raft
            .take_committed()
            .into_iter()
            .filter_map(|e| e.command)
            .collect();
        assert_eq!(applied, vec![4]);
    }

    #[test]
    fn isolated_leader_cannot_commit_and_its_writes_are_discarded() {
        let mut sim: Sim<u64> = Sim::new(5, 3);
        sim.run(1_000);
        let old = sim.leader().expect("leader");
        sim.propose(&old, 1);
        sim.run(300);
        sim.isolate(&old);
        // The minority leader still accepts proposals but can never commit them.
        sim.propose(&old, 100);
        sim.propose(&old, 101);
        sim.run(2_000);
        let new = sim.leader().expect("majority elects a new leader");
        assert_ne!(new, old);
        sim.propose(&new, 2);
        sim.run(300);
        assert_eq!(sim.committed_commands(), vec![1, 2]);
        sim.cut.clear();
        sim.run(1_000);
        assert_ne!(
            sim.nodes[&old].role(),
            Role::Leader,
            "old leader stepped down"
        );
        let old_log: Vec<u64> = sim.nodes[&old]
            .log()
            .iter()
            .filter_map(|e| e.command)
            .collect();
        assert_eq!(
            old_log,
            vec![1, 2],
            "uncommitted minority writes were overwritten"
        );
        assert_eq!(sim.committed_commands(), vec![1, 2]);
    }

    #[test]
    fn replica_set_changes_become_migrations_that_advance_in_order() {
        let node = |n: &str| NodeInfo::new(id(n), "z");
        let entry = |index, command| LogEntry {
            term: 1,
            index,
            command: Some(command),
        };
        let mut state = ControlState::default();
        let set = |nodes, rf| ControlCommand::SetNodes {
            nodes,
            replication_factor: rf,
        };
        state
            .apply(&entry(1, set(vec![node("a"), node("b"), node("c")], 2)))
            .expect("command")
            .expect("valid");
        assert!(state.migrations().is_empty(), "the first map moves nothing");

        state
            .apply(&entry(2, set(vec![node("a"), node("b"), node("c")], 3)))
            .expect("command")
            .expect("valid");
        let moving = state.migrations().len();
        assert!(moving > 0 && moving <= 4096);
        let (p, m) = state.migrations().iter().next().expect("one");
        let p = *p;
        assert_eq!(m.to.len(), 3);
        assert_eq!(m.from.len(), 2);
        assert_eq!(m.phase, MigrationPhase::Moving);

        // A new placement waits for running migrations.
        assert_eq!(
            state.apply(&entry(3, set(vec![node("a")], 1))),
            Some(Err(ControlError::MigrationsPending(moving)))
        );
        let advance = |from, to| ControlCommand::AdvanceMigration {
            partitions: vec![p],
            from,
            to,
        };
        // Out-of-order steps are ignored.
        state.apply(&entry(
            4,
            advance(MigrationPhase::Fenced, Some(MigrationPhase::Imported)),
        ));
        assert_eq!(state.migrations()[&p].phase, MigrationPhase::Moving);
        state.apply(&entry(
            5,
            advance(MigrationPhase::Moving, Some(MigrationPhase::Fenced)),
        ));
        state.apply(&entry(
            6,
            advance(MigrationPhase::Moving, Some(MigrationPhase::Fenced)),
        ));
        assert_eq!(state.migrations()[&p].phase, MigrationPhase::Fenced);
        state.apply(&entry(
            7,
            advance(MigrationPhase::Fenced, Some(MigrationPhase::Imported)),
        ));
        state.apply(&entry(8, advance(MigrationPhase::Imported, None)));
        assert!(!state.migrations().contains_key(&p));
        assert_eq!(state.migrations().len(), moving - 1);
    }

    #[test]
    fn control_plane_changes_partitions_only_by_majority() {
        let node = |n: &str, z: &str| NodeInfo::new(id(n), z);
        let set = |nodes: Vec<NodeInfo>, rf| ControlCommand::SetNodes {
            nodes,
            replication_factor: rf,
        };
        let mut sim: Sim<ControlCommand> = Sim::new(3, 4);
        sim.run(1_000);
        let leader = sim.leader().expect("leader");
        let three = vec![node("a", "z1"), node("b", "z2"), node("c", "z3")];
        sim.propose(&leader, set(three.clone(), 2));
        sim.run(300);

        // The leader is cut off and tries to drop two nodes: nothing commits.
        sim.isolate(&leader);
        sim.propose(&leader, set(vec![node("a", "z1")], 1));
        sim.run(2_000);

        let mut four = three;
        four.push(node("d", "z1"));
        let majority_leader = sim.leader().expect("majority leader");
        sim.propose(&majority_leader, set(four, 2));
        sim.run(300);
        sim.cut.clear();
        sim.run(1_000);

        let mut maps = Vec::new();
        for name in sim.names.clone() {
            let mut state = ControlState::default();
            for entry in &sim.applied[&name] {
                if let Some(result) = state.apply(entry) {
                    result.expect("valid command");
                }
            }
            maps.push(state.partition_map().cloned().expect("map"));
        }
        assert!(
            maps.windows(2).all(|w| w[0] == w[1]),
            "every node derives the same map"
        );
        assert_eq!(
            maps[0].epoch(),
            2,
            "two committed changes; the minority one never applied"
        );
        assert_eq!(maps[0].nodes().len(), 4);
    }

    #[test]
    fn invalid_control_commands_are_rejected_deterministically() {
        let mut state = ControlState::default();
        let entry = LogEntry {
            term: 1,
            index: 1,
            command: Some(ControlCommand::SetNodes {
                nodes: vec![],
                replication_factor: 1,
            }),
        };
        assert!(matches!(
            state.apply(&entry),
            Some(Err(ControlError::Placement(PlacementError::NoNodes)))
        ));
        assert!(state.partition_map().is_none());
        assert!(
            state
                .apply(&LogEntry {
                    term: 1,
                    index: 2,
                    command: None
                })
                .is_none()
        );
        assert_eq!(state.applied_index(), 2);
    }

    #[test]
    fn persistent_state_round_trips_as_json() {
        let state = PersistentState {
            term: 3,
            voted_for: Some(id("r1")),
            log: vec![LogEntry {
                term: 2,
                index: 1,
                command: Some(ControlCommand::SetNodes {
                    nodes: vec![NodeInfo::new(id("a"), "z")],
                    replication_factor: 1,
                }),
            }],
            snapshot_index: 0,
            snapshot_term: 0,
        };
        let json = serde_json::to_string(&state).expect("serialize");
        assert_eq!(
            serde_json::from_str::<PersistentState<ControlCommand>>(&json).expect("parse"),
            state
        );
    }

    proptest! {
        #![proptest_config(ProptestConfig { cases: 40, ..ProptestConfig::default() })]

        /// Random crashes, restarts, link cuts, loss, duplication and delay
        /// never violate safety (checked after every step), and once the
        /// faults stop the cluster recovers and commits again.
        #[test]
        fn safety_under_chaos_and_liveness_after_heal(
            seed in any::<u64>(),
            drop_pct in 0u64..20,
            dup_pct in 0u64..20,
            max_delay_ms in 1u64..60,
            faults in prop::collection::vec((0u8..6, 0usize..5, 0usize..5), 10..40),
            compact_above in prop::option::of(1usize..6),
        ) {
            let mut sim: Sim<u64> = Sim::new(5, seed);
            sim.compact_above = compact_above;
            sim.drop_pct = drop_pct;
            sim.dup_pct = dup_pct;
            sim.max_delay_ms = max_delay_ms;
            let mut next_value = 0;
            for (kind, a, b) in faults {
                let (na, nb) = (sim.names[a].clone(), sim.names[b].clone());
                match kind {
                    0 => sim.crash(&na),
                    1 => sim.restart(&na),
                    2 if a != b => { sim.cut.insert((na, nb)); }
                    3 => sim.cut.clear(),
                    _ => {
                        if let Some(leader) = sim.leader() {
                            next_value += 1;
                            sim.propose(&leader, next_value);
                        }
                    }
                }
                sim.run(200);
            }
            // Heal everything and check the cluster makes progress again.
            sim.cut.clear();
            for n in sim.names.clone() {
                sim.restart(&n);
            }
            sim.drop_pct = 0;
            sim.dup_pct = 0;
            sim.max_delay_ms = 15;
            sim.run(3_000);
            let leader = sim.leader();
            prop_assert!(leader.is_some(), "no leader after heal");
            let marker = 1_000_000;
            sim.propose(&leader.expect("leader"), marker);
            sim.run(1_000);
            prop_assert!(sim.committed_commands().contains(&marker), "no progress after heal");
            for name in sim.names.clone() {
                let applied = &sim.applied[&name];
                prop_assert_eq!(
                    &applied[..],
                    &sim.committed[..applied.len()],
                    "{} state machine diverged",
                    name
                );
                prop_assert!(
                    applied.iter().any(|e| e.command == Some(marker)),
                    "{} missing the post-heal commit",
                    name
                );
            }
        }
    }
}
