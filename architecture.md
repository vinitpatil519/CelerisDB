# Architecture

## 1. System goals

ParadoxDB should behave like a low-latency distributed key-value/document platform with a clear separation between storage, placement, replication, consistency, and API layers.

```text
+-------------------------------+
|         Applications          |
| React / Next / Node / Python  |
+---------------+---------------+
                |
        HTTP / WebSocket
                |
+---------------v---------------+
|            SDK / CLI          |
| routing + retries + session  |
+---------------+---------------+
                |
+---------------v---------------+
|          API Gateway          |
| auth | validation | limits    |
+---------------+---------------+
                |
+---------------v---------------+
|      Request Coordinator      |
| consistency | routing | txn   |
+-----+------------------+------+
      |                  |
      |                  +-------------------+
      v                                      v
+-----+----------------+           +---------+----------+
|  Partition Manager   |           |  Query / Indexes  |
| ownership + epochs  |           | secondary paths   |
+-----+----------------+           +---------+----------+
      |
      v
+-----+------------------------------------------------+
|                    Data Node                         |
|  WAL -> Memtable -> Immutable Segments -> Compactor |
|          |                |                         |
|          +--> Replica Log +--> Block Cache         |
+-----------------------------------------------------+
```

## 2. Node model

Every node runs the same binary and can provide:

- API service.
- Partition service.
- Storage engine.
- Replication service.
- Membership/failure detection.
- Metrics.
- Admin endpoint.

The architecture is shared-nothing: no permanent single leader for the entire cluster.

## 3. Partitioning

Use a fixed number of logical partitions, initially 4096 or 16384. A key is hashed using a stable 64-bit hash and mapped to a partition ID.

Each logical partition has a replica set:

```text
Partition 217
  primary: Node B
  replica: Node A
  replica: Node D
  epoch: 4921
```

Changing physical membership changes ownership but not the key-to-partition mapping.

## 4. Request path

### GET

```text
Client
  -> SDK routing cache
  -> owner node
  -> consistency checker
  -> memtable/cache
  -> segment/block lookup
  -> response
```

### STRICT SET

```text
Client
  -> owner
  -> append WAL
  -> replicate/consensus
  -> commit point
  -> local apply
  -> acknowledgement
```

### AVAILABLE SET

```text
Client
  -> reachable replica
  -> append local WAL
  -> acknowledge
  -> asynchronous replication
  -> conflict metadata
  -> convergence
```

## 5. Control plane vs data plane

### Control plane

- membership.
- partition ownership.
- cluster epoch.
- node health.
- replica placement.
- rebalance plans.

### Data plane

- GET.
- SET.
- DELETE.
- CAS.
- batch operations.
- change streams.

Control-plane state should be tiny and consensus-backed. Data-plane traffic should avoid unnecessary cluster-wide coordination.

## 6. Cross-platform architecture

Rust is the reference implementation because it can target Linux, macOS and Windows from one codebase and provides strong control over memory, IO and concurrency.

Build targets:

- `x86_64-unknown-linux-gnu`
- `aarch64-unknown-linux-gnu`
- `x86_64-apple-darwin`
- `aarch64-apple-darwin`
- `x86_64-pc-windows-msvc`

The CLI and SDKs should hide platform-specific details.

## 7. Frontend connectivity

Do not make React speak the internal binary cluster protocol directly.

Use:

- HTTP/JSON for CRUD/query.
- WebSocket for change streams.
- Optional SSE for simple one-way streams.

This keeps browser integration friction low.

## 8. Deployment layers

### Local

Single binary or Docker Compose.

### VM

One node per VM, fronted by a load balancer.

### Kubernetes

StatefulSet or an Operator manages pods, volumes, topology labels and controlled scaling.

### AWS

Recommended production shape:

- 3 or 5 EC2 nodes or Kubernetes workers.
- EBS gp3 volumes.
- 3 Availability Zones for replica placement.
- private subnets.
- security groups restricted to API and cluster ports.
- CloudWatch or Prometheus/Grafana if desired.

The database itself should remain cloud-agnostic.
