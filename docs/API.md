# HTTP API (v1)

Base URL: `http://<node>:8080`. Request and response bodies are JSON. Values
are arbitrary JSON documents; the API validates them and stores them
unchanged.

Browsers and SDKs only ever use this API. Internal cluster protocols are never
exposed.

## Conventions

| Header | Direction | Meaning |
|---|---|---|
| `celeris-mutation-id: <uuid>` | request | Optional client-chosen ID. Retrying with the same ID never applies a write twice. If absent, the server generates one. |
| `celeris-mutation-id` | response | The ID of the write that was applied. |
| `celeris-version` | response | Commit version of the value written or read. |
| `celeris-consistency` | response | Consistency mode actually applied. |

**Consistency** is chosen per request with `?consistency=`. The default is
`strict`.

* Reads accept `strict`, `session`, `bounded` (requires `max_staleness_ms`),
  `available` and `eventual`.
* Writes accept every mode except `bounded`, which describes read freshness only.

On a single node every mode is satisfied by the one local replica. Responses
report the requested mode, and bounded reads report `staleness_ms: 0`. The
modes diverge once replication lands; see [CONSISTENCY.md](CONSISTENCY.md).
The server never silently weakens a requested mode.

### Errors

```json
{"error": {"code": "condition_failed", "message": "...",
           "outcome": "not_applied", "mutation_id": "…", "current_version": 7}}
```

`outcome` is present on every write error:

* `not_applied`: nothing was written. It is safe to treat as failure.
* `unknown`: the write **may have committed**. Retry with the same mutation ID,
  or check `GET /v1/mutations/{id}`. Never assume it failed.

| HTTP | `code` | When |
|---|---|---|
| 400 | `invalid_json`, `invalid_key`, `invalid_argument`, `invalid_query`, `invalid_consistency`, `invalid_mutation_id` | Bad input |
| 403 | `forbidden` | Admin endpoint called from a non-loopback address |
| 404 | `not_found` | Key absent, deleted or expired |
| 409 | `condition_failed` | `if_version` / `if_absent` did not hold. `current_version` is the key's version, or `null` if absent |
| 422 | `mutation_id_reused` | The same mutation ID was sent with a different payload |
| 500 | `outcome_unknown` | Storage could not confirm durability. `outcome: unknown` |
| 500 | `corruption`, `internal` | Server-side fault |
| 503 | `read_only` | The node refuses writes after a WAL failure |

## Routing and epoch fencing

Every key belongs to a partition (`GET /v1/partitions/key/{key}`). Each
partition has a leader under the node's current partition map.

* Requests for a key are accepted only by its partition leader. Any other
  node answers `421 not_owner` with routing hints in the error object:
  `partition`, `partition_epoch`, `map_epoch`, `replicas` and `leader`.
  Batches must contain only keys led by the receiving node.
* Responses carry `celeris-partition` and `celeris-partition-epoch`.
* Clients may send `celeris-partition-epoch: N`, the epoch they routed with:
  * older than the partition's epoch → `409 stale_epoch`: refresh routing and retry;
  * newer than this node's map → `503 epoch_ahead`: this node is behind, retry shortly.
* `GET /v1/scan` returns `"partial": true` when other nodes lead some
  partitions. The result then covers only this node's data.

### Replicated cluster mode

This mode applies when `cluster.voters` is set (D-018). Data goes through
the Raft group of the key's replica set.

* **Before any map is committed:** data requests return
  `503 no_partition_map`. The control-plane leader commits the first map
  on its own once every voter is alive (`cluster.replication_factor`,
  default 3); with `replication_factor = 0`, run
  `celeris cluster rebalance --rf N` once.
* **Writes:** only the group leader accepts writes; other replicas answer
  `421 not_leader` with `leader` and `replicas`. Successful writes return
  `celeris-session-index` (a token `<index>@<group>`). Errors:
  * `503 proposal_lost`: not applied;
  * `503 partition_moving`: the partition's data is being moved to new
    replicas; not applied, retry shortly;
  * `500 outcome_unknown`: may have committed.
* **Reads by mode:**
  * `strict` and `bounded`: leader only, through a read barrier
    (linearizable);
  * `session`: any replica whose applied index ≥ the
    `celeris-session-index` you send, else `503 session_behind`. A token
    from another group (the partition has moved) is served as a leader read;
  * `available` and `eventual`: any replica, possibly stale.
  * `421 partition_moved` (with the new `replicas`): this group gave the
    partition away.
* **`available` / `eventual` writes** (D-023):
  * On the group leader they commit like strict writes (`200`).
  * Elsewhere they are accepted into the node's pending log and answered
    with `202 {"accepted": true, "replicated": false, "timestamp_ms",
    "mutation_id"}`, even without a quorum. They are committed in the
    background, with per-key last-writer-wins.
  * `if_version` / `if_absent` are refused (`400 conditions_require_strict`).
* **Conflicts:**
  * `GET /v1/conflicts?prefix=&limit=` lists the writes that lost
    last-writer-wins (key, losing value, timestamps, mutation IDs, origin,
    winner), with `partial` if a group could not be reached.
  * `DELETE /v1/conflicts/{key}` clears them for a key, through the
    group leader.
* **Batches** must stay within one replica set (`400 cross_group_batch`).
* **Scans** gather from every replication group and merge by key. `strict`
  (default) and `session` scans read each group through its leader after a
  read barrier, and fail with `503 scan_incomplete` if a group is
  unavailable. `eventual`/`available` scans read any replica and set
  `partial: true` if a group could not be reached.

A rebalance that changes a partition's replica set moves its data (D-020).
`/v1/status` shows `control.migrations` (running, by phase). A new
rebalance is refused with `409 migrations_pending` until the previous one
has finished moving data.

## Keys

The key is the rest of the path after `/v1/kv/` and may contain `/`. It is
percent-decoded, must be 1–1024 bytes of UTF-8, and must not start with
`%00`.

URL parsers collapse `.` and `..` path segments, so such keys are not
addressable by path.

## Endpoints

### `PUT /v1/kv/{key}`

The body is the JSON value. Query parameters:

* `consistency`
* `ttl_ms`: expire after this many milliseconds; must be at least 1
* `if_version=N`: write only if the current version is N
* `if_absent=true`: write only if the key does not exist

```bash
curl -X PUT localhost:8080/v1/kv/users/42 -d '{"name":"Vinit"}'
```

```json
{"key":"users/42","version":17,"mutation_id":"5d0c…","deduplicated":false,"consistency":"strict"}
```

`deduplicated: true` means this mutation ID had already committed. The
original version is returned and nothing new is written.

### `GET /v1/kv/{key}`

Query parameters: `consistency`, and `max_staleness_ms` (bounded only).

```json
{"key":"users/42","value":{"name":"Vinit"},"version":17,"mutation_id":"5d0c…",
 "timestamp_ms":1760000000000,"expires_at_ms":null,"consistency":"strict"}
```

### `DELETE /v1/kv/{key}`

Query parameters: `consistency`, `if_version`. Response shape is the same as PUT.

### `POST /v1/batch`

Applies every operation atomically, all or nothing, under one mutation ID
and one commit version. Conditions are checked against the state before the
batch.

```json
{"mutation_id": "optional-uuid", "consistency": "strict", "ops": [
  {"op": "put", "key": "orders/1", "value": {"total": 3}, "ttl_ms": 60000, "if_absent": true},
  {"op": "delete", "key": "carts/9", "if_version": 12}
]}
```

Limits: 10,000 operations and 32 MiB of keys plus values per batch; 4 MiB
per value.

### `GET /v1/scan`

Parameters:

* `prefix`, or `start` (inclusive) and `end` (exclusive)
* `after`: cursor
* `limit`: 1–1000, default 100
* `consistency`

```json
{"items":[{"key":"users/1","value":{},"version":3,"expires_at_ms":null}],
 "next_cursor":"users/1","consistency":"strict"}
```

Pass `next_cursor` as `after` to get the next page. It is `null` on the last page.

Each item is a committed version, but a scan is not a point-in-time snapshot.

### `GET /v1/mutations/{id}`

* `200 {"status":"committed","version":17}`
* `404 {"status":"unknown"}`: the mutation did not commit, is still in
  flight, or is older than `mutation_retention_secs` (default 24 h).

### `GET /v1/watch?prefix=` (WebSocket)

Streams the changes this node applies, as JSON text messages:

* first `{"type":"hello","node","prefix","groups","partial"}`;
* then one `{"type":"change","key","kind":"put"|"delete","value","version","mutation_id"}`
  per applied change whose key starts with `prefix`.

The stream follows these rules:

* **Coverage:** a node sees the changes of its own data. In replicated
  mode that is the replica sets it belongs to; `partial: true` means
  others exist, so watch a node in each replica set, or use RF = node
  count.
* **Delivery:** best-effort and from "now". A slow watcher gets
  `{"type":"lagged","missed":n}` and should re-read what it shows.
  Deduplicated retries produce no events.
* **Plain HTTP:** a plain request (not a WebSocket upgrade) gets
  `400 websocket_required`.

### Operational

| Endpoint | Purpose |
|---|---|
| `GET /health` | Liveness: `{"status":"ok","node_id":…}` |
| `GET /ready` | 200 when writable, 503 `read_only` after a WAL failure |
| `GET /v1/status` | Node, cluster, partition, storage and recovery state. `cluster.mode` is `single-node` or `gossip`; `cluster.nodes[]` is `{id, address, zone, state, incarnation, self}` with `state` one of `alive`/`suspect`/`unreachable`/`left` |
| `GET /v1/partitions` | Partition map: epoch, replication factor, per-node replica and leader counts |
| `GET /v1/partitions/key/{key}` | `{partition, partition_epoch, map_epoch, replicas, leader}` for a key. Lets clients route directly to owners. See [PARTITIONING.md](PARTITIONING.md) |
| `GET /metrics` | Prometheus text format |
| `POST /v1/admin/shutdown` | Graceful stop. **Loopback clients only** until authentication lands (M9) |
| `POST /v1/admin/rebalance` | `{"replication_factor": N}`: proposes placing partitions on the current membership through the Raft control plane. Loopback only. The leader answers `202 {"status":"proposed","log_index"}`; a follower forwards the request to the leader and answers `202 {"status":"forwarded","leader"}`; `409 not_leader` only while no leader is known. `/v1/status.control.raft` shows role, term, leader and commit index |

## Metrics

| Metric | Type |
|---|---|
| `celeris_http_requests_total{route,method,status}` | counter |
| `celeris_http_request_duration_seconds{route,method}` | histogram |
| `celeris_operations_by_consistency_total{mode,kind}` | counter |
| `celeris_storage_*_total` | counters: writes, WAL bytes and syncs, WAL failures, dedupe hits, condition failures, reads, bloom negatives, cache hits and misses, flushes, compactions, tombstones purged, write stalls, background errors |
| `celeris_storage_{last_version,memtable_bytes,immutable_memtables,l0_tables,l1_tables,table_bytes,read_only}` | gauges |
| `celeris_node_info{node_id,version}`, `celeris_uptime_seconds` | gauges |

## CORS

Off by default. Enable it with `[http] cors_origins = ["http://localhost:5173"]`
(or `"*"`) or `CELERIS_CORS_ORIGINS`. The `celeris-*` response headers are
exposed to browsers.
