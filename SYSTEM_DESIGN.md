# ParadoxDB — Master System Design

This file is the executive technical map for coding agents. Read it first, then follow links into the specialized documents.

## What are we building?

A self-hosted distributed key-value/document database that works on Linux, macOS and Windows, can run as a single local process or a multi-node cluster, exposes browser-friendly APIs, and lets developers choose consistency behavior per operation.

## The one sentence architecture

> **Cluster-aware clients route keys to deterministic logical partitions; each partition uses replicated storage; strict operations use quorum/consensus, while available operations may accept writes on reachable replicas and later reconcile them.**

## The core flow

```text
Application
   |
   | HTTP / WebSocket
   v
TypeScript/Python/Go SDK
   |
   | routing metadata
   v
Correct partition owner
   |
   +-------------------------+
   |                         |
STRICT                   AVAILABLE
   |                         |
quorum/consensus         local durable append
   |                         |
commit                  async replication
   |                         |
   +------------+------------+
                |
              WAL
                |
            Memtable
                |
          Immutable SSTable
                |
             Compaction
```

## Partitioning model

Use a fixed logical partition universe (start at 4096). Hash keys to logical partitions, then map partitions to physical nodes. This makes cluster expansion a placement/migration problem rather than a key-space redesign.

## Why this is not a CAP violation

A network partition makes it impossible to guarantee both linearizability and unconditional availability. ParadoxDB therefore exposes the tradeoff rather than hiding it.

| Mode | Partition behavior | Consistency | Availability |
|---|---|---|---|
| STRICT | may reject/wait | linearizable per key | not unconditional |
| SESSION | may route/wait | read-your-writes | high |
| BOUNDED | may fail if stale | freshness bound | high but conditional |
| AVAILABLE | accept at reachable replica | eventual/conflict-aware | high |
| EVENTUAL | accept and reconcile | eventual | highest |

## Storage engine

A custom engine, not a wrapper around another database:

```text
WAL
  -> Memtable
  -> immutable segment files
  -> sparse index + bloom filters
  -> block cache
  -> compaction
```

## Cluster control

Control-plane data must be strongly coordinated:

- cluster membership.
- partition ownership.
- cluster epoch.
- fencing tokens.

Do not let a disconnected node promote itself and keep accepting strict writes.

## Rebalancing

Use snapshot + mutation tail:

```text
source snapshot
     |
     +--> stream chunks --> target
     |
     +--> stream WAL tail -> target
                         |
                    verify checksum
                         |
                    switch epoch
                         |
                    serve traffic
```

## Frontend architecture

Browsers should use:

- REST/JSON for CRUD/query.
- WebSocket for realtime events.

The browser never needs to understand the cluster topology directly.

## Deployment path

```text
local binary
    -> Docker
    -> Docker Compose 3-node cluster
    -> Kubernetes StatefulSet
    -> AWS 3-AZ topology
```

## Website architecture

The landing page is a static React/TypeScript site with:

- GSAP ScrollTrigger.
- Lenis.
- SVG wireframe diagrams.
- D3 only where useful.
- reduced-motion fallback.

The website itself has no paid service dependency.

## Build order for agents

### Milestone 1

Single-node WAL/storage engine.

### Milestone 2

HTTP API + CLI.

### Milestone 3

Logical partitions + partition map.

### Milestone 4

Membership + failure detection + replication.

### Milestone 5

Strict mode + failover + correctness tests.

### Milestone 6

Available mode + conflict resolver + anti-entropy.

### Milestone 7

SDKs + WebSocket + React integration.

### Milestone 8

Kubernetes/AWS + admin console + website.

### Milestone 9

Chaos testing + benchmark + production hardening.

## Documents

- Product: `PRD.md`
- CAP semantics: `CAP_REALITY.md`
- Architecture: `ARCHITECTURE.md`, `HLD.md`, `LLD.md`
- Data: `STORAGE_ENGINE.md`, `QUERY_ENGINE.md`, `TRANSACTIONS.md`
- Distributed system: `DISTRIBUTED_SYSTEM.md`, `PARTITIONING.md`, `REPLICATION.md`, `CLUSTER_MEMBERSHIP.md`, `FAILURE_DETECTION.md`, `CONFLICT_RESOLUTION.md`
- API/dev: `API_SPEC.md`, `SDK_SPEC.md`, `CLI.md`, `OBSERVABILITY.md`
- Ops: `DEPLOYMENT.md`, `AWS_DEPLOYMENT.md`, `SECURITY.md`, `TESTING.md`, `BENCHMARKING.md`
- Web: `LANDINGPAGE.md`, `ANIMATION_SYSTEM.md`, `WEB_ARCHITECTURE.md`
- Agents: `CODING_AGENT_GUIDE.md`
