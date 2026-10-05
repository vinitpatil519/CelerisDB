# PRD — ParadoxDB

## 1. Product statement

ParadoxDB is a high-performance, self-hostable distributed key-value/document database that exposes consistency as a programmable property rather than a global ideological choice.

It should feel easy for a frontend developer to use, but expose enough distributed-systems controls for production operators and backend engineers.

## 2. Problem

Developers often choose between databases using oversimplified CAP labels. In practice, the real decisions concern:

- What must be strongly ordered?
- What can be stale?
- How stale can it be?
- Which operations may continue during a partition?
- What happens when two writers update the same key independently?
- How does the system heal after the network recovers?

ParadoxDB makes those answers explicit in the API and runtime.

## 3. Target users

### Primary

- Backend engineers building low-latency services.
- React/Next.js developers who want a simple realtime backend.
- Startup teams that want self-hosted infrastructure.
- Students and engineers learning distributed systems through a serious codebase.

### Secondary

- Quant/fintech systems requiring deterministic per-key correctness.
- IoT and edge workloads with intermittent connectivity.
- Gaming/session state workloads.
- Analytics/event-enrichment systems.

## 4. Product principles

1. **Correctness over marketing claims.** Never call a system CAP-breaking unless assumptions changed.
2. **Fast path first.** A single-key operation should ideally be one client-to-owner hop.
3. **Data-local decisions.** Route requests to the node that owns the partition.
4. **Failure is a normal state.** Every critical component has an explicit failure path.
5. **Consistency is observable.** Every response can report consistency mode, version/epoch, and staleness metadata.
6. **One binary, zero paid services.** Local development must be free.

## 5. User stories

- As a developer, I can install the database on Linux, macOS, or Windows using one command.
- As a developer, I can start a single-node database and call it from React within five minutes.
- As a platform engineer, I can create a three-node cluster with Docker or Kubernetes.
- As an application developer, I can select `STRICT`, `SESSION`, `BOUNDED`, `AVAILABLE`, or `EVENTUAL` per operation.
- As an operator, I can kill a node and watch the cluster recover.
- As a developer, I can subscribe to changes over WebSocket.
- As an operator, I can inspect partition ownership, replication health, WAL lag, compaction, and conflict counts.

## 6. Functional requirements

### FR-1 Storage

- Durable WAL.
- Memtable.
- Immutable sorted segment files.
- Point lookups.
- Prefix/range scan over a partition.
- TTL.
- Tombstones.
- Background compaction.

### FR-2 Distribution

- Fixed logical partition ring.
- Deterministic key hashing.
- Replica placement with failure-domain awareness.
- Automatic rebalancing.
- Membership changes.
- Partition epochs to prevent stale ownership decisions.

### FR-3 Replication

- Primary/replica replication in strict mode.
- Multi-writer replication in available mode.
- Write-ahead replication stream.
- Catch-up snapshots and incremental logs.

### FR-4 Consistency

- Strong/linearizable read option.
- Session guarantees.
- Bounded staleness.
- Available local reads.
- Eventual reads.
- Explicit conflict resolution policy.

### FR-5 APIs

- HTTP REST/JSON.
- WebSocket change stream.
- Internal binary protocol.
- TypeScript SDK.
- Python SDK.
- Go SDK.
- Rust SDK.

### FR-6 Tooling

- `paradoxdb init`.
- `paradoxdb start`.
- `paradoxdb cluster status`.
- `paradoxdb partitions`.
- `paradoxdb backup`.
- `paradoxdb doctor`.
- `paradoxdb bench`.

## 7. Non-functional requirements

| Metric | v1 target |
|---|---:|
| Single-node p50 GET | < 2 ms on local SSD |
| Single-node p99 GET | < 20 ms |
| Cluster point GET | one logical routing hop |
| Recovery | deterministic and observable |
| Availability semantics | documented per consistency mode |
| Supported OS | Linux/macOS/Windows |
| Packaging | static binary + Docker |

These are engineering targets, not promises until benchmarks prove them.

## 8. Success criteria

The v1 release is successful when:

1. A user can run a node on all three desktop operating systems.
2. A React app can perform CRUD and subscribe to realtime changes.
3. A three-node cluster can rebalance without manual data copying.
4. Strict mode passes linearizability tests under supported failure scenarios.
5. Available mode survives node/network partitions and converges after heal.
6. Every consistency tradeoff is visible in documentation and telemetry.

## 9. Release phases

### Phase 0 — single node

WAL, memtable, segments, compaction, HTTP, CLI.

### Phase 1 — cluster

Membership, partition map, replication, failover, rebalance.

### Phase 2 — consistency engine

Strict, session, bounded, available, eventual.

### Phase 3 — developer platform

SDKs, change streams, admin console, metrics.

### Phase 4 — production hardening

Snapshots, backup, encryption, auth, chaos testing, performance tuning.

### Phase 5 — cloud ergonomics

Kubernetes operator, AWS deployment recipes, autoscaling guidance.

## 10. Constraints

No paid infrastructure is required to build or test the project. Public cloud usage is optional and may incur cost; local Docker, MinIO, GitHub Actions free quotas, and local Kubernetes are the default development paths.
