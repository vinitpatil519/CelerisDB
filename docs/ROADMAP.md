# Roadmap

Order follows `SYSTEM_DESIGN.md` and `CODING_AGENT_GUIDE.md`. A milestone is
done only when behaviour, error paths and failure cases are tested.

## M0 — Bootstrap: done

Cargo workspace; lint and format gates (`clippy -D warnings`, `unsafe_code = forbid`);
CI on Linux, macOS and Windows.

## M1 — Single-node storage engine: done

* WAL with per-batch frames, CRC and versioned header; fsync policy.
* Memtable, immutable memtables, write stalls.
* SSTables with sparse index, bloom filter and checksummed blocks; LRU block cache.
* Full L0+L1 compaction with TTL→tombstone conversion and tombstone retention.
* Atomic batches, conditional writes (CAS), mutation-ID idempotency and status lookup.
* Crash recovery: torn-tail truncation, orphan cleanup, manifest-atomic swaps.
* Tests: unit, integration, property-based model, process-kill crash test.

Follow-ups:

* [ ] Group commit (batch concurrent fsyncs).
* [ ] Partial/leveled compaction (keep the tombstone-safety invariant, D-003).
* [ ] Filesystem trait + fault injection (failed fsync, ENOSPC, slow disk) to
      test the poison path automatically.
* [x] HTTP benchmark client (`celeris bench`): p50/p95/p99, throughput.
* [ ] In-process storage benchmarks (criterion) and write-amplification
      measurement. No numbers are published until both exist and are
      reproducible.

## M2 — HTTP API + CLI: done

* `celeris-server`: axum HTTP/JSON API ([API.md](API.md)).
  * `/v1/kv/{key}` with consistency, TTL, `if_version`/`if_absent` and
    `celeris-mutation-id`.
  * `/v1/batch` (atomic) and `/v1/scan` (cursor pagination).
  * `/v1/mutations/{id}`, `/v1/status`, `/health`, `/ready`, `/metrics`
    (Prometheus).
  * Loopback-only `/v1/admin/shutdown`; CORS configurable, off by default.
* Every write error says `not_applied` or `unknown`. Responses report the
  version and the applied consistency.
* Config file `celeris.toml` with `CELERIS_*` env overrides; persistent
  node ID; graceful shutdown.
* `celeris` CLI ([CLI.md](CLI.md)): `init`, `start`, `stop`, `status`,
  `node list`, `cluster status`, `put`, `get`, `delete`, `scan`,
  `mutation`, `doctor`, `bench`. Writes retry with the same mutation ID,
  and exit code 3 means the outcome is unknown.
* Tests: 16 API contract tests, including a real-socket graceful shutdown,
  and a CLI end-to-end test against a real node process.

Follow-ups:

* [x] WebSocket change stream (see M7).
* [ ] Request size and rate limits per client (M9 security).

## M3 — Partitioning: done

See [PARTITIONING.md](PARTITIONING.md).

* 4096 logical partitions; the xxh3 key hash is pinned by golden vectors.
* Zone-aware rendezvous placement:
  * deterministic, balanced within 10–15%;
  * a join moves about 1/N of partitions, and only to the new node;
  * a leave moves only the leaving node's partitions.
* Map epoch plus per-partition epochs, with `validate_epoch` (Stale/Ahead)
  for fencing.
* Rebalance diffs (`Move`). The serialized map is versioned and validated.
* `/v1/partitions`, `/v1/partitions/key/{key}`, `celeris partitions [--key]`.
* Tests: 11 unit tests including a property test over random memberships;
  API and CLI end-to-end checks.

## M4 — Membership, failure detection, replication: in progress

Done: `crates/celeris-cluster`, SWIM-style membership as a sans-IO state
machine (see `DECISIONS.md` D-015).

* **States:**
  * Alive → Suspect after silence;
  * Suspect → Unreachable after an unrefuted suspicion timeout;
  * Left on a graceful departure.

  A timeout is evidence, never proof of death.
* **Refutation:** a node refutes suspicion of itself by raising its
  incarnation. Merging is a lattice join, so duplicates, delays and
  reordering are harmless.
* **Joining:** joins retry through seeds until a peer answers.
* **Placement:** `placement_nodes()` (Alive and Suspect) feeds
  `PartitionMap`. Suspects keep their partitions to avoid flapping.
* **Tests:** a deterministic network simulator covering:
  * joins, and lost joins that are retried;
  * crash detection timing;
  * false-suspicion refutation;
  * a two-sided network partition and heal;
  * graceful leave and rejoin;
  * stale or forged gossip;
  * a property test showing convergence after a period of random
    loss, duplication and delay.

Remaining:

* [x] Internal node-to-node transport:
  * separate `[cluster] listen` port;
  * `CLRS` v1 length-prefixed JSON frames, 4 MiB cap;
  * fire-and-forget sends with 1 s timeouts.
* [x] `Membership` wired into the node:
  * seeds and zone in config;
  * graceful leave on shutdown;
  * cluster view in `/v1/status`, `celeris node list` and `celeris cluster status`;
  * `celeris_cluster_members{state}` metrics.
* [x] Persisted incarnation (`<data_dir>/INCARNATION`), bumped on every start.
* [x] Real-socket test: 3 nodes join, one leaves gracefully (`left`), one
      crashes (`unreachable`, never `left`).
* [x] Raft core (`celeris-cluster/src/raft.rs`, sans-IO):
  * elections with log up-to-date voting;
  * append consistency check and conflict truncation;
  * current-term commit via a leader no-op;
  * persistence contract plus `restore` after a restart.
* [x] Control state machine: `ControlCommand::SetNodes` turns committed log
      entries into the `PartitionMap`, identically on every node. Tested: an
      isolated leader cannot change ownership, and its uncommitted entries
      are overwritten after heal.
* [x] Raft tests with checks after every simulated step:
  * at most one leader per term;
  * identical committed entries everywhere;
  * 40 randomized chaos runs (crashes, restarts, cuts, loss, duplication,
    delay) with liveness after heal.
* [x] Raft wired into the node:
  * Raft rides cluster frames v2 (`membership` and `raft` channels).
  * State persists in `<data_dir>/raft/state.json`: versioned, fsync plus
    atomic rename, written before any message from the same step is sent.
  * Voters are set via `[node] id` plus `[cluster] voters`.
  * Committed `SetNodes` replaces the node's live `PartitionMap`.
  * Operator access:
    * `POST /v1/admin/rebalance`, loopback-only and leader-only;
      followers answer `409 not_leader`;
    * `celeris cluster rebalance --rf N`;
    * Raft role, term, leader and commit index in `/v1/status`.
  * Tested over real sockets with 3 voters.
* [x] Automatic rebalance on membership change (D-022): the control leader
      re-places partitions once the live member set has differed from the
      placement, unchanged, for `cluster.auto_rebalance_after_ms`
      (default 30 s; 0 disables). Tested: a node dies and its data moves to
      the survivors.
* [x] Re-apply the committed log after restart without waiting for the
      leader: `raft/state.json` records a known commit index (a lower
      bound), applied when the node opens.
* [x] Raft pre-vote, leader stickiness and check-quorum (D-021).
* [ ] Raft follow-ups: voter-set changes (joint consensus), control-plane
      log snapshots, ReadIndex for linearizable reads.
* [x] Epoch fencing on the data path:
  * only the partition leader serves a key (`421 not_owner` with hints);
  * `celeris-partition-epoch` validation (`409 stale_epoch` / `503 epoch_ahead`);
  * route headers on responses; batches confined to one leader;
  * `partial` flag on scans.
* [x] Data replication through one Raft group per replica set (D-018):
  * durable group log (`raft_log.rs`) with deterministic apply;
  * strict reads via read barrier; session tokens; eventual local reads;
  * `proposal_lost` / `outcome_unknown` semantics;
  * tested with 3 real nodes: leader failover keeps committed data and
    versions, and retries are deduplicated by the new leader.
* [x] Group log compaction and snapshot install (D-019):
  * `cluster.snapshot_threshold` entries retained, compacted after a flush;
  * lagging replicas receive the leader's engine state over a `CLSN`
    snapshot stream and swap it in crash-safely (`ACTIVE_STORAGE`);
  * Raft sim chaos proptest with random compaction; 3 real nodes: a
    crashed follower catches up from a snapshot.
* [x] Data migration when partitions move between groups (D-020):
      fence, export, import and release steps confirmed through the control
      plane; tested by moving every partition from RF=2 to RF=3 groups
      over real sockets while writes continue.
* [ ] Delete groups that no longer own partitions.
* [ ] Streamed (not in-memory) snapshots for groups larger than 1 GiB.
* [x] Cross-node scans: scatter-gather over serving groups (local or via
      the `CLXR` request/response RPC), merged by key, cursor-paged; strict
      scans use each group leader's read barrier.
* [ ] Non-voter data nodes.

Node identity, join/leave, heartbeats with suspicion (timeouts are evidence,
not proof), consensus-backed control plane (cluster epoch, ownership, fencing).

## M5 — STRICT mode: done

Raft per replica set rather than per partition (D-018), which gives the
same guarantees with far fewer groups.

* Strict writes commit through the group log; strict reads run a barrier
  through it.
* Pre-vote and check-quorum (D-021) keep partitioned nodes from disrupting
  the leader, and stop isolated leaders.
* `celeris-testkit::linearizability` is a Wing & Gong register checker with
  memoization. Unknown outcomes may apply late or never.
* History tests:
  * the checker is unit-tested on valid and invalid histories;
  * the Raft simulator checks safety after every step under loss,
    duplication, delay, reordering, crashes and partitions;
  * 3 real nodes run concurrent clients doing strict writes and reads on
    shared keys while the group leader is killed. Every key's history must
    be linearizable.

## M6 — AVAILABLE / EVENTUAL modes: done (D-023)

* Local accept with hybrid timestamps (`202 Accepted`, `replicated:
  false`), durable pending log, background reconciliation (resumable:
  survives restarts; observable: pending writes retry until committed).
* Deterministic per-key last-writer-wins at apply. Losers and unseen
  overwrites are recorded as conflicts (`GET`/`DELETE /v1/conflicts`).
* Anti-entropy: per-partition Merkle digests computed at a common log
  position, compared by the group leader; diverged followers are repaired
  from a snapshot without dropping acknowledged entries.
* Tests:
  * unit tests: last-writer-wins, conflicts, and digest-based detection
    and repair;
  * 3 real nodes: concurrent writes on two followers produce one winner
    and one recorded conflict;
  * after a quorum loss, available writes are accepted and committed once
    the quorum returns, while strict writes are refused in the meantime;
  * anti-entropy reports a clean comparison of all replicas.

Not done: version vectors. Per-key hybrid timestamps plus
"observed version" detection cover conflict detection for single-key
writes.

## M7 — Developer platform: done

* WebSocket change stream (`GET /v1/watch?prefix=`): per-node,
  best-effort, from "now", with `lagged` notices and a `hello` that says
  whether the node covers every replica set.
* SDKs, each tested against a real node (Go also against the 3-node compose
  cluster):
  * TypeScript (`sdks/typescript`), with `createKeyStore` and the
    `useCeleris()` React hook;
  * Python (`sdks/python`), standard library only;
  * Rust (`sdks/rust`), async;
  * Go (`sdks/go`), standard library only.
* Shared guarantees: mutation-ID retries, redirect following, session
  tokens, and unknown outcomes reported as such.

Not done: resumable change streams (from a log position).

## M8 — Deployment and website: done

* [x] Dockerfile (multi-stage, non-root, tini) and 3-node `docker compose`
  that bootstraps itself (D-025); CI builds it and checks replication.
* [x] Kubernetes StatefulSet, headless Service, PodDisruptionBudget
  (`deploy/kubernetes/celeris.yaml`); image published to GHCR on `v*` tags.
  Not yet exercised on a live cluster in CI (kind).
* [x] AWS reference architecture (EC2/EBS, EKS): `docs/DEPLOYMENT.md`.
* [x] Admin console (`console/`): overview, partitions, data explorer with
  compare-and-set, live change stream, conflicts.
* [x] Landing page (`website/`): React, GSAP ScrollTrigger, Lenis, SVG
  diagram primitives; all twelve sections of `landingpage.md`, reduced-motion
  and keyboard support.
* [x] Release binaries for Linux, macOS and Windows on `v*` tags, with
  `install.sh` / `install.ps1` (checksums verified).

## M9 — Hardening

* [x] Group commit (D-026): 3–5× fsync-bound write throughput.
* [x] Authentication: API tokens with read / write / admin scopes (D-027);
  CLI `--token`, `celeris token create`, SDK `token` options, console field.
* [x] TLS for the client API (D-028): HTTPS + wss, CLI `--ca-cert`.
* [ ] TLS (mTLS) on the cluster port.
* [x] Online backup and restore (D-029): consistent physical snapshots for
  a single node, JSON-lines export/import for any cluster.
* [x] Criterion micro-benchmarks for the storage engine
  (`cargo bench -p celeris-storage`; numbers in STORAGE_ENGINE.md).
* [ ] Chaos suite beyond the current crash, failover and partition tests.
