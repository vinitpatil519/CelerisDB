# Design decisions and spec reconciliation

This file records decisions made where the specifications were silent,
missing, or contradictory. Each entry says what was decided and why.

## D-001 Product name: Celeris

The specification files (`SYSTEM_DESIGN.md`, `PRD.md`, `architecture.md`,
`landingpage.md`, `CODING_AGENT_GUIDE.md`) call the product **ParadoxDB**
(`paradoxdb` CLI, `useParadox` React hook). The master engineering prompt names
it **Celeris**. Celeris is canonical:

| Spec says | Implemented as |
|---|---|
| ParadoxDB | Celeris |
| `paradoxdb` binary | `celeris` |
| `useParadox()` | `useCeleris()` |
| `ghcr.io/<org>/paradoxdb` | `ghcr.io/<org>/celeris` |

The spec files are left unchanged.

## D-002 Missing specification files

The master prompt references about 30 spec files. Only five exist:
`SYSTEM_DESIGN.md`, `CODING_AGENT_GUIDE.md`, `PRD.md`, `architecture.md`,
`landingpage.md`. The uppercase/lowercase "duplicates" (`ARCHITECTURE.md` /
`architecture.md` etc.) are the same file: Windows filesystems are
case-insensitive.

Missing specs (STORAGE_ENGINE, API_SPEC, CONSISTENCY_MODEL, PARTITIONING,
REPLICATION, ...) are derived from the five that exist, using the priority
order of the master prompt. Where this repository documents a subsystem
(`docs/STORAGE_ENGINE.md`, `docs/CONSISTENCY.md`), that document describes
what is actually implemented.

## D-003 Storage engine is an LSM tree with two levels

`SYSTEM_DESIGN.md` requires WAL → memtable → immutable segments → sparse
index + bloom filters → block cache → compaction. Implemented as:

* L0: one table per memtable flush (tables may overlap).
* L1: one sorted, non-overlapping run produced by compaction.
* Compaction merges **all** L0 and L1 tables into a new L1 run.

Why: full compaction is the simplest scheme in which dropping a tombstone is
provably safe (every older version is among the inputs). Its cost is write
amplification proportional to data size / memtable size. Leveled or tiered
compaction with partial inputs is a later optimisation and must keep the
invariant "a tombstone is only dropped when no older version can exist
outside the compaction inputs".

## D-004 Version = per-node commit sequence number

Each batch receives one monotonically increasing sequence number, exposed as
`Record::version`. It is node-local. When replication lands, the replicated
version (term/epoch + log index for STRICT, HLC + version vector for
AVAILABLE) will be carried in the value envelope above the storage layer;
the storage sequence stays a local ordering device.

## D-005 Mutation-ID deduplication lives in the storage engine

Every batch writes a dedupe record (`0x00 'm' <mutation id>` → commit version +
payload fingerprint) **in the same WAL frame** as the data. So:

* a retry after a lost response returns the original outcome, never applies twice;
* `Engine::mutation_status(id)` answers "did it commit?" after a crash;
* reusing an ID with a different payload is rejected (`MutationIdReused`).

Records expire after `mutation_retention` (default 24 h). After that the
answer is "unknown", never "failed". Keys starting with `0x00` are reserved
for this namespace and rejected as user keys.

## D-006 WAL failures poison the engine

If a WAL append or fsync fails, the on-disk state of the log is unknown
(the page cache may have dropped dirty pages, cf. PostgreSQL "fsyncgate").
Retrying the fsync can falsely report success. The engine therefore:

1. reports the write as outcome-unknown (`StorageError::WalFailure`), and
2. refuses further writes (`StorageError::Poisoned`) until restarted.

Recovery on restart replays whatever reached disk; the client resolves the
unknown outcome with the mutation ID.

## D-007 Torn WAL tails

A short or checksum-failing frame at the end of the **newest** WAL is a torn
write that was never acknowledged: it is truncated and reported in
`RecoveryReport::truncated_bytes`. The same in an **older** WAL is
corruption (older WALs are fsynced in full before rotation), and startup
fails rather than silently dropping acknowledged writes.

## D-008 Tombstone retention

Tombstones and expired TTL values are kept for `tombstone_retention`
(default 24 h) before compaction may drop them. In a replicated cluster, a
replica partitioned for longer than this could resurrect deleted data via
anti-entropy. The retention must exceed the maximum tolerated partition
duration; the cluster layer will enforce that by refusing to re-admit
replicas that have been away longer.

## D-009 Windows toolchain

Development on Windows uses the `x86_64-pc-windows-gnu` Rust toolchain with a
64-bit mingw-w64 (WinLibs) ahead of any 32-bit MinGW on `PATH`. CI also tests
the default MSVC toolchain on `windows-latest`. The code uses no
platform-specific APIs except positional reads (`FileExt`) and directory
fsync, both abstracted in `celeris-storage/src/fsutil.rs`.

## D-011 Values are JSON documents

The HTTP API stores JSON values only. It validates them on write and
returns the stored bytes verbatim. This matches the "key-value/document"
positioning and keeps browser clients simple. Opaque binary values
(`application/octet-stream`) can be added later without breaking the
contract: the storage engine already stores bytes.

## D-012 Consistency on a single node

With one replica, every mode is trivially satisfied: the node serialises
writes and reads its own latest committed state. The API still:

* validates the mode;
* rejects `bounded` writes and bounded reads without a bound;
* reports the mode it applied and counts it in metrics.

This means clients written today keep working unchanged when replication
makes the modes behave differently. It is not a downgrade of anything.

## D-013 Admin endpoints are loopback-only

Until authentication exists (M9), `/v1/admin/*` accepts only loopback
peers. Data endpoints are reachable by anyone who can reach the listen
address, which defaults to `127.0.0.1`. Exposing a node on `0.0.0.0` before
M9 is an explicit operator choice, and the config template says so.

## D-014 Outcome classification on write errors

The engine returns every error except `WalFailure` before appending to the
WAL, so those errors mean `not_applied`. `WalFailure` and a panicked write
task mean `unknown`. On the client side, a transport failure before the TCP
connection was established means nothing was sent. Any later transport
failure means the outcome is unknown, and the CLI retries with the same
mutation ID before reporting it.

## D-015 Membership is SWIM-style gossip; it is not authoritative

Failure detection uses heartbeats with full-view gossip. Each member has an
incarnation that only it may raise. The state precedence is
`Alive < Suspect < Unreachable < Left`.

* Silence produces **Suspect**.
* Only an unrefuted suspicion produces **Unreachable**, and the node can
  still come back by refuting it.
* Nothing concludes a process is dead.

The membership view is local and eventually consistent. It decides who
*looks* healthy, not who *owns* data. Changing partition ownership for
STRICT data must go through the consensus-backed control plane: a
minority-side node that sees everyone else as Unreachable must not take
over their partitions. This module therefore deliberately exposes only
`placement_nodes()` and `view_epoch()` as inputs to that control plane.

## D-016 Control plane is Raft with a static voter set

Partition ownership changes only through committed `ControlCommand`s in a
Raft log (D-015 explains why gossip alone is not enough). The implementation
is the minimal correct subset of the Raft paper: elections, log
replication, and current-term commit via a leader no-op.

The voter set is fixed at bootstrap, as in a static etcd cluster. Changing
voters needs joint consensus, which is deferred until it is needed.
Log compaction, ReadIndex reads and check-quorum are also deferred; none
of them affects safety.

The control state machine is deterministic. Invalid commands are rejected
identically on every node, so all nodes always derive the same
`PartitionMap` and epoch from the same log.

## D-017 Leader-only serving until replication exists

Partition replicas do not hold copies yet. Serving reads or writes from a
follower replica would let replicas silently diverge, which is a hidden
weakening of every consistency mode. So, until replication lands, all
requests go to the partition leader, and every other node answers
`421 not_owner` with routing hints.

Epoch fencing (`celeris-partition-epoch`) already rejects clients routing
with a stale map. Rebalancing changes ownership but does not move data;
that gap is documented in the API rather than hidden.

## D-018 Data replication: one Raft group per replica set

Partitions sharing a replica set share one Raft group. There are at most
as many groups as distinct replica sets; at 3 nodes with RF=3 there is
exactly one. This avoids 4096 per-partition Raft groups and their heartbeats.

* **Storage:** each group owns its own storage engine
  (`<data_dir>/groups/<ids>/`). The same log applied in the same order
  gives identical data on every replica, and identical versions, so CAS
  `if_version` works across failover.
* **Commands:** a command carries the leader's timestamp and is applied
  with `Engine::write_at`, so TTLs and conditions don't depend on replica
  clocks.
* **Restarts:** the applied index is persisted, so a restart never
  re-applies old entries. If the file lags after a crash, the few entries
  re-applied are deduplicated by mutation ID.
* **Write outcomes:**
  * committed and applied → success;
  * another entry took the proposal's index → `proposal_lost`, not applied;
  * no confirmation within 5 s → `outcome_unknown`, resolve with the mutation ID.
* **Reads:**
  * strict and bounded reads commit a read barrier on the leader
    (linearizable);
  * session reads need the replica's applied index ≥ the client's
    `celeris-session-index`;
  * available and eventual reads use local state on any replica.
* **Available writes** currently take the same quorum path, which is
  stronger than asked, never weaker. True multi-writer availability is M6.

Current limits:

* Cluster data nodes must be control-plane voters.
* Scans gather from every serving group; each group filters out records
  of partitions it does not currently serve (being imported, or not yet
  purged), so a record is never returned twice.

## D-028 HTTPS for the client API

* **rustls with the ring provider.** It needs only a C compiler, unlike
  aws-lc-rs (cmake, NASM), and the lockfile already carried it through
  reqwest.
* **HTTPS only when configured.** A node with a certificate serves HTTPS on
  its API port and nothing else; a plain HTTP request fails the handshake.
* **Same behaviour as plain HTTP.** The TLS path runs the same axum router on
  hyper-util with upgrades (WebSockets), injects the peer address as
  `ConnectInfo` (used by admin checks), negotiates h2 or HTTP/1.1, and drains
  connections for up to 10 s on shutdown.
* **Not yet.** mTLS between nodes on the cluster port, and certificate
  reload without a restart.

## D-027 API tokens with scopes

* **Hashed at rest.** Nodes store the SHA-256 of each token, never the
  token, and look requests up by hash.
* **Three scopes.** `read`, `write` and `admin`, mapped from the matched
  route and method by one middleware. Each scope is independent, so a
  writer that also reads needs both.
* **Public probes.** `/health`, `/ready` and `/metrics` stay open, because
  load balancers and Prometheus need them and they carry no data.
* **Admin.** Without tokens, admin endpoints keep the loopback-only rule.
  With tokens, the `admin` scope replaces it, so operators can rebalance a
  Kubernetes cluster without exec-ing into a pod.
* **WebSockets.** `/v1/watch` also accepts `?access_token=`. It is the only
  route that does, because tokens in URLs end up in logs.

## D-026 Group commit in the storage engine

With `SyncMode::Always`, every batch paid its own fsync while holding the
writer lock, so throughput was one fsync per batch (about 1,500–1,800 puts/s
on the development machine, whatever the concurrency).

* **Append, then sync outside the lock.** A writer appends its WAL frame
  under the writer lock and releases it. A separate sync lock lets one
  writer fsync for everyone queued; the fsync handle is a shared reference
  to the WAL file, so appends continue during the fsync.
* **Invisible until durable.** Synced batches move into the memtable in
  sequence order. Before that, readers cannot see them. Publishing writes
  before they are durable would let a reader observe data that a crash then
  loses, which breaks linearizability.
* **Writer overlay.** Conditions and mutation-ID dedupe consult the queued,
  not yet visible batches first, so serial semantics are unchanged.
* **Scope.** Only `SyncMode::Always` writes without a purge filter take this
  path. Others first drain the queue, then use the direct path.
* **Result.** 3.2× the throughput with 8 clients and 4.7× with 32, measured
  A/B on the same machine. See [STORAGE_ENGINE.md](STORAGE_ENGINE.md).

## D-025 Automatic first placement; admin requests forwarded to the leader

Found while running the 3-node compose cluster: a fresh cluster served
nothing (`503 no_partition_map`) until an operator ran
`celeris cluster rebalance` on the control-plane leader's own machine
(admin endpoints accept loopback only). In containers that meant finding
the leader and `docker exec`-ing into it.

* **Bootstrap:** the control-plane leader proposes the first placement on
  its own once *every* configured voter is a live member, with
  `cluster.replication_factor` replicas (default 3, capped at the node
  count). Waiting for all voters avoids placing everything on the first
  quorum and immediately migrating. It proposes at most once per term.
  `replication_factor = 0` restores the manual step.
* **Forwarding:** `POST /v1/admin/rebalance` on a follower is validated
  locally and forwarded to the leader over the cluster port
  (`202 "forwarded"`). The leader's state machine checks it again.

## D-024 Pooled node-to-node connections

The cluster transport opened one TCP connection per frame. Every Raft
heartbeat, group append and gossip ping left a socket in `TIME_WAIT` on the
sender. With many groups (or several nodes on one host) this exhausted the
ephemeral port range: on Windows with Docker running, which reserves part
of the range, connects failed with `WSAEADDRINUSE` and cluster tests timed
out.

* Frames up to 256 KiB share one long-lived connection per peer, written
  in order by a writer task with a bounded queue (1024 frames). When the
  queue is full, frames are dropped; Raft and gossip resend what matters.
  A failed write drops that frame and reconnects. The writer closes the
  connection after 20 s idle; the receiver closes after 60 s, so it never
  closes a connection the sender is about to use.
* Bulky frames (large appends) still get a connection of their own, so a
  4 MiB append does not delay heartbeats. Graceful-leave notices also use
  their own connections and are awaited before shutdown.
* The receiver reads frames until the sender closes the connection and
  handles each frame in its own task, as before. It holds only a weak
  reference to the node, so a stopped node releases its storage at once.
* Compatibility: an older sender sends one frame per connection, which the
  new receiver handles. An older receiver reads only the first frame, so a
  rolling upgrade loses some frames until every node runs the new version.
  Raft and gossip retransmit, so this only delays them.

## D-023 AVAILABLE mode: local accept, ordered reconciliation, surfaced conflicts, anti-entropy

`available` and `eventual` writes must succeed while a client can reach
any replica, even one cut off from its quorum. Celeris still never claims
to break CAP: such a write is *accepted*, not *replicated*, and says so.

* **Accept.**
  * On the group leader, the write commits through Raft as usual: `200`,
    with a version.
  * Anywhere else, it is stored durably in the node's local pending log
    and answered with `202 Accepted`:
    `{"accepted": true, "replicated": false, "timestamp_ms": ...}`.
  * Compare-and-set conditions are refused under `available`
    (`400 conditions_require_strict`); they have no meaning under
    last-writer-wins.
* **Hybrid timestamp.** A pending write is stamped no earlier than the
  node's clock, and no earlier than any version or pending write the node
  holds for those keys. A client that reads a value and then writes
  through the same node therefore wins over what it read, whatever the
  clock skew.
* **Reconcile.** A background pass every 300 ms offers each pending write
  to the group leader: locally, or with a `Forward` RPC. The write is
  committed in the log as `AvailableWrite`, and removed from the pending
  log once applied. Retries carry the same mutation ID, and a write that
  was already resolved is not resolved again (`mutation_status_at`).
* **Resolve (deterministic, per key, at apply).**
  * The newest version by (timestamp, mutation ID) wins. Deletes take
    part through their tombstones, which are retained for
    `tombstone_retention`.
  * Nothing is lost silently. If the incoming write loses, it is recorded
    as a conflict. If it wins over a version its author had not observed
    (the accepting node sends what it had seen), the overwritten value is
    recorded instead.
  * Conflicts are replicated metadata: `GET /v1/conflicts?prefix=` lists
    them across groups, and `DELETE /v1/conflicts/{key}` clears them
    through the leader.
  * Strict writes are authoritative and don't record conflicts.
  * Batches in available mode are resolved per key, not atomically.
* **Anti-entropy.** Every `cluster.anti_entropy_interval_ms` (default
  60 s), each group leader commits a `Digest` entry. Every replica hashes
  its data when it applies the entry, so all hashes describe the same log
  position. Each replica produces per-partition xxh3 digests (the leaves
  of a two-level Merkle tree) over key, value and version. Records within
  60 s of expiry are excluded, so small clock differences don't count as
  divergence. The leader compares the members' digests:
  * A member that differs from a majority that includes the leader is
    repaired. It accepts the leader's snapshot at a committed index in its
    own log, then re-applies its log after that point (`rewind_applied`).
    No acknowledged entry is ever dropped.
  * If the leader is in the minority, nothing is repaired automatically.
  * Results are shown in `/v1/status` under `control.anti_entropy`.

Limits:

* A pending write is visible only after it is reconciled. Until then,
  reads don't show it, not even on the accepting node.
* Writes stay pending for as long as the group has no quorum. If the
  accepting node is lost, its pending writes are lost too.
* A dedupe record is deterministic only within `mutation_retention`
  (24 h). Retrying a pending write that has been stuck longer than that
  could resolve it a second time.

## D-022 Automatic rebalancing with hysteresis

The control-plane leader checks every second whether the placement nodes
(Alive and Suspect members) differ from the committed map's nodes. It
proposes `SetNodes` once the *same* differing set has been seen
continuously for `cluster.auto_rebalance_after_ms` (default 30 s). It never
does so while migrations are running, and never before an operator has
committed a first map. The replication factor stays as configured, capped
at the number of nodes.

* Suspect members keep their partitions (D-015), so slow nodes don't
  churn ownership. A flapping node resets the timer each time the set
  changes.
* Losing a node is a placement change like any other: its partitions
  migrate (D-020) from the surviving majority of each old replica set. If
  a set has lost its majority, its migrations wait.
* The trade-off: with 30 s, a dead node's replicas stay under-replicated
  for at least that long. Set the delay to 0 to require an operator
  instead.

## D-021 Raft pre-vote, leader stickiness and check-quorum

Raft as first built let a node that had been cut off come back with an
inflated term and depose a healthy leader, which cancelled in-flight
proposals (`proposal_lost`). Group leaders also kept leading while
isolated. Both the control plane and the data groups now use the
standard extensions from the Raft thesis (§9.6, §6.2):

* **Pre-vote.** An election starts only after a majority answers "yes" to
  `RequestPreVote` (term + 1, log up to date). A pre-vote changes no
  state, so a node that cannot win never raises its term.
* **Stickiness.** A follower that heard from its leader within the minimum
  election timeout refuses pre-votes, and ignores real vote requests with
  higher terms.
* **Check-quorum.** Once per maximum election timeout, a leader that has
  not heard from a majority steps down. A partitioned leader then stops
  accepting proposals that can never commit.

Tested in the simulator: a cut-off follower keeps its term while
isolated, the leader survives its return, and an isolated leader steps
down while the majority elects another.

## D-020 Partition migration between replication groups

When a placement change gives a partition a new replica set, its data
moves to the group of that set. The control plane drives the move, and
routing never points at a group that lacks the data.

* **Control state.** `SetNodes` records a `Migration {from, to, phase}`
  for every partition whose replica *set* changed. Leader-only changes
  keep the same group and need no move. Requests for a migrating
  partition still go to `from`. A new `SetNodes` is refused
  (`409 migrations_pending`) until all migrations finish, so moves never
  overlap.
* **Steps.** Each step is performed by a group leader, committed in the
  group log, then confirmed with `AdvanceMigration` through the control
  plane. A node that is not the control leader forwards the command with
  a `ControlPropose` frame.
  1. *Moving → Fenced:* the source commits `Fence`. Writes to the
     partition are then refused (`503 partition_moving`, not applied,
     safe to retry), so its data is final.
  2. *Fenced → Imported:* the destination fetches the data from any
     source replica over a `CLXR`/`CLXS` request/response; only a replica
     that has applied the fence answers. It then commits it in `Import`
     chunks. The first chunk purges whatever the destination already held
     for the partition, such as a stale copy from an earlier ownership.
  3. *Imported → done:* the source commits `Release`, which deletes its
     copy and refuses reads (`421 partition_moved`). Only then does
     routing switch.
* **Why release comes before the switch.** A strict read on the old group
  runs a barrier through that group's log. Any strict read that starts
  after a write to the new group is therefore ordered after `Release`,
  and is refused rather than served stale.
* **Determinism.** A partition's state (fenced or released) is a
  replicated engine metadata record (`WriteBatch::set_meta`), so
  snapshots carry it. Purges are one atomic commit
  (`Engine::write_purging_at`), so replicas keep identical versions even
  if their already-expired entries differ.
* **Session tokens** are now `<index>@<group>`. A token from another
  group (the partition moved) turns a session read into a leader read.
  Bare `<index>` tokens are still accepted.

Costs and limits:

* Writes to a moving partition fail with a retryable error until the
  data is copied. Reads keep working until the release.
* Versions restart in the destination group. A client CAS with an old
  version fails safely (`condition_failed`) and must re-read.
* Mutation-ID records don't move. A retry of a pre-move mutation after
  the move is not deduplicated by the new group. `/v1/mutations/{id}`
  still finds the record on the source replicas until it expires.
* An export is built in memory, up to 1 GiB per batch of partitions. If
  the source group has lost its quorum, the migration waits until it
  recovers.
* Old groups that no longer own anything are not yet deleted from disk.

## D-019 Group log compaction and snapshot install

A group's Raft log would otherwise grow forever, and a replica that was
down for long would have to replay all of it.

* **Compaction:** once the log holds more than `cluster.snapshot_threshold`
  entries (default 10 000), the group flushes its engine and then discards
  the log up to the applied index. The flush comes first because those
  entries exist nowhere else afterwards. The Raft log file (format v2)
  records the snapshot boundary (index, term) in its header and is
  rewritten through a temporary file plus an atomic rename.
* **The snapshot is the engine itself.** No separate snapshot file is
  kept. When a follower needs compacted entries, the leader serializes its
  engine (`Engine::snapshot`) under the group lock, so the state is exactly
  at its applied index. It sends that index and term in place of its log's
  boundary: it is a committed prefix, so Raft safety holds.
* **Transport:** snapshots don't fit cluster frames (4 MiB), so they use
  their own connection: `CLSN` magic, version, a JSON header, then the
  engine bytes, which carry their own magic, version and CRC. A transfer
  per peer is not repeated for 10 s after it was delivered.
* **Install (crash-safe order):**
  1. Raft must accept it (`should_install_snapshot`: current term, beyond
     the commit index).
  2. Build a new engine in `storage-<index>/`.
  3. Durably point `ACTIVE_STORAGE` at it (tmp + fsync + rename).
  4. Swap the engine and record the applied index.
  5. Only then let Raft adopt the snapshot and persist its log.

  After a crash at any step, the node opens either the old engine with
  the old log, or the new engine. The index of the new engine is never
  re-applied, because it is named in `ACTIVE_STORAGE`. Readers holding the
  old engine finish on it. Stale storage directories are removed on open.
  Pending proposals at or below the snapshot index resolve as unknown
  (resolve them with the mutation ID).
* **Limit:** snapshots are built and received in memory, up to 1 GiB per
  group. Streaming them is on the roadmap.

Large entries, found while testing this:

* **Frame limit.** A 4 MiB value used to produce an append frame over the
  old 4 MiB frame limit. Followers rejected it forever and the group
  stalled. Frames may now be 128 MiB, which fits one maximal 32 MiB batch
  after JSON escaping. Bodies are read as the bytes arrive, and the read
  timeout grows with the frame size.
* **Append size.** Append messages are capped at 8 MiB of commands
  (`RaftConfig::max_bytes_per_message`), but always carry at least one
  entry.
* **Resends.** Entries sent recently are not resent on every heartbeat;
  the follower gets an empty heartbeat instead. The resend window is half
  the election timeout plus 1 ms per 4 KiB. Without this, a slow follower
  was buried in duplicate 4 MiB frames and the cluster churned leaders.
* **Off the async threads.** Bulky frames are encoded and decoded on the
  blocking pool, so gossip and heartbeats keep running.
* **Lost, not unknown.** A proposal whose log index a later term of the
  same leader reuses now resolves as `proposal_lost` rather than unknown.
  By leader completeness, it can never commit.

## D-010 Scans are not snapshots

`Engine::scan` returns committed versions only, but concurrent writes during a
scan may or may not be observed. Point-in-time scans need MVCC (retaining
multiple versions per key) and are deferred until a consumer requires them.
