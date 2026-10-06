# HTTP API (v1)

Base URL: `http://<node>:8080`. Request and response bodies are JSON. Values
are arbitrary JSON documents; the API validates them and stores them
unchanged.

Browsers and SDKs only ever use this API. Internal cluster protocols are never
exposed.

## TLS

Set `[http] tls = { cert_file = "...", key_file = "..." }` (or
`CELERIS_TLS_CERT` and `CELERIS_TLS_KEY`) to serve the API over HTTPS only,
with HTTP/2 and HTTP/1.1 negotiated by ALPN. Certificates are PEM: a chain
with the leaf first, and a PKCS#8, PKCS#1 or SEC1 key. WebSocket change
streams use `wss://`.

* The CLI trusts the public web PKI by default. For a private CA, pass
  `--ca-cert ca.pem` (or `CELERIS_CA_CERT`).
* SDKs use their platform trust store. For Node.js, set
  `NODE_EXTRA_CA_CERTS`; for Python, `SSL_CERT_FILE`.
* The cluster port is not encrypted yet: keep it on a private network.

## Authentication

Authentication is off until at least one token is configured (`[[auth.tokens]]`
or `CELERIS_AUTH_TOKENS`; create one with `celeris token create`). Then
every request except `/health`, `/ready` and `/metrics` needs
`Authorization: Bearer <token>`, with a scope that covers it:

| Scope | Allows |
|---|---|
| `read` | `GET` key-value, scans, mutation status, conflicts, status, partitions, `/v1/watch` |
| `write` | `PUT` / `DELETE` key-value, `POST /v1/batch`, `DELETE /v1/conflicts/{key}` |
| `admin` | `/v1/admin/*`, from any address (without tokens, admin is loopback-only) |

* A missing or unknown token gets `401 unauthorized` with
  `WWW-Authenticate: Bearer`. A token without the scope gets `403 forbidden`.
* Browsers cannot set headers on a WebSocket, so `/v1/watch` also accepts
  `?access_token=<token>`.
* Nodes store only the SHA-256 of each token.
* The cluster port is not authenticated yet; keep it on a private network.

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

### `POST /v1/query`

A scan with a JSON filter and projection, evaluated on the nodes that hold
the data (D-030). Body:

```json
{"prefix":"orders/",
 "where":{"status":"paid","total":{"$gte":100},"customer.tier":{"$in":["gold","platinum"]}},
 "fields":["total","customer.id"],
 "limit":100,"max_scanned":10000,"after":null,"consistency":"strict"}
```

Every field is optional. The range is `prefix`, or `start`/`end`, as for
`/v1/scan`.

Response:

```json
{"items":[{"key":"orders/0042","value":{"total":120,"customer":{"id":7}},"version":9,"expires_at_ms":null}],
 "next_cursor":"orders/0042","scanned":57,"consistency":"strict","partial":false}
```

* **Paging.** A request reads at most `max_scanned` rows (1–100,000,
  default 10,000), so a selective filter can return a page with few or no
  items and a `next_cursor`. Keep passing `next_cursor` as `after` until it
  is `null`. Pages are in key order and never skip or repeat a key.
* **Filters.** A filter object ANDs its conditions. `{"field": value}` is
  equality; `{"field": {"$op": arg, ...}}` applies operators:

  | Operator | Matches when the field |
  |---|---|
  | `$eq`, `$ne` | equals / does not equal the value (`$ne` also matches a missing field) |
  | `$gt`, `$gte`, `$lt`, `$lte` | compares with a number or a string; other types never match |
  | `$in`, `$nin` | is / is not one of up to 1,000 values |
  | `$exists` | is present (`true`) or absent (`false`) |
  | `$prefix` | is a string starting with the argument |
  | `$contains` | is an array holding the value, or a string containing the substring |

  `$and` and `$or` take arrays of filters; `$not` takes a filter. Field
  paths are dotted (`customer.tier`); a numeric segment indexes an array
  (`items.0.sku`). Numbers compare by value, so `1` equals `1.0`. Values
  that are not JSON objects only match filters on missing fields.
* **Projection.** `fields` keeps only the listed paths, rebuilt as nested
  objects. A path that reaches an array or a scalar keeps that whole value.
* **Limits.** A filter has at most 256 conditions and 16 levels of nesting.
  Invalid filters fail with `400 invalid_filter`.
* **Cost.** Without an index a query reads the whole range, `max_scanned`
  rows at a time; narrow it with `prefix` when you can. In a cluster each
  replica set filters its own data, so only matches cross the network.
  `scanned` adds up the rows (or index entries) read by all of them.
* **Indexes.** When a ready secondary index covers a top-level equality
  condition (`{"status": "paid"}` or `{"status": {"$eq": "paid"}}`) and the
  query's range lies within the index's prefix, the query reads only the
  keys the index lists for that value, still in key order, and checks the
  whole filter against each record. `index` in the response names the index
  used, or is `null` for a scan. Results are the same either way.

#### Sorting

`sort` orders the matches by one field instead of by key (D-035):

```json
{"prefix":"orders/","where":{"status":"paid","total":{"$gte":100}},
 "sort":{"field":"total","order":"desc"},"limit":20}
```

* It needs a ready index on that field with the same order (`order =
  "desc"` in the index definition for descending sorts) whose prefix
  covers the query's range; otherwise the query fails with
  `400 sort_unavailable`.
* Matches come in value order, then key order for equal values. Records
  whose field is missing, or is an array or object, are not in the index
  and are not returned.
* Conditions on the sort field at the top level of `where` (`$eq`, `$gt`,
  `$gte`, `$lt`, `$lte`) narrow the part of the index read; the whole
  filter is still checked on every record.
* Values order as `null < false < true < numbers < strings`. A one-sided
  bound such as `{"$gte": 100}` stays within its type.
* `next_cursor` is an opaque index position. Pass it back as `after` with
  the same `sort`. Paging works the same way as for unsorted queries, in a
  cluster too.

#### Aggregates

Add `aggregate` to count the matches and take the sum, minimum and maximum
of fields instead of returning items (D-032):

```json
{"prefix":"orders/","where":{"status":"paid"},
 "aggregate":{"count":true,"sum":["total"],"min":["created"],"max":["total"]}}
```

```json
{"items":[],"aggregates":{"count":412,"sum":{"total":18230.5},"min":{"created":"2026-01-02"},"max":{"total":990}},
 "next_cursor":"orders/0811","scanned":10000,"index":"orders_by_status","consistency":"strict","partial":false}
```

* Each response covers one page of at most `max_scanned` rows. While
  `next_cursor` is set, keep paging and merge: add counts and sums, and keep
  the smallest minimum and largest maximum. The SDKs' `aggregate` helpers
  and `celeris query --all` do this for you.
* `sum` adds numbers (exactly while every value is an integer). `min` and
  `max` compare numbers by value and strings by code point; numbers order
  before strings, and other types are skipped. A field with no usable values
  is `null`.
* `limit` and `fields` do not apply to aggregate requests.

#### Secondary indexes

Declare indexes in `celeris.toml`; every node of a cluster should list the
same ones (D-031):

```toml
[[indexes]]
name = "orders_by_status"   # a-z, 0-9, _ and -
prefix = "orders/"          # only keys under this prefix ("" for all keys)
field = "status"            # dotted path into the JSON value
order = "asc"               # or "desc": the order `sort` reads values in
```

* An index covers string, number, boolean and null values of the field.
  Arrays and objects are not indexed, and equality on them always scans.
* A new index is built in the background, 1,000 keys per step, while the
  node keeps serving; queries scan until it is `ready`. Removing or
  changing an index deletes its old entries the same way.
* `GET /v1/status` lists each index and its state (`building`, `ready`,
  `dropping`), per replication group in a cluster.
* Writes keep indexes exact: the engine updates entries in the same
  atomic commit as the data.

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
| `GET /v1/admin/backup` | Admin. A consistent physical snapshot of the node's storage as `application/octet-stream`; the `celeris-version` header holds the last version it contains. `501 not_supported` in replicated cluster mode (use `celeris export`). Restore with `celeris restore` |
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
