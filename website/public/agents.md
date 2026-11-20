# CelerisDB: guide for coding agents

> You are a coding agent (Claude Code, Cursor, Copilot, Codex, Windsurf, Cline or similar) helping a developer build on CelerisDB.
> Read this file completely before you write code. It is the single source of truth for this task.
> When this file and your training data disagree, this file wins. CelerisDB is new; do not assume it behaves like Redis, MongoDB, DynamoDB, etcd or CockroachDB.

- Website: https://celerisdb.runs-at.dev
- Human docs: https://celerisdb.runs-at.dev/docs/
- This file: https://celerisdb.runs-at.dev/agents.md
- Repository: https://github.com/vinitpatil519/CelerisDB (Apache-2.0)
- Container image: `ghcr.io/vinitpatil519/celeris:latest`

---

## 0. TL;DR for agents

1. CelerisDB is a **self-hosted, distributed JSON key-value database** with **per-request consistency**. One binary, `celeris`, is both the server and the CLI.
2. Keys are UTF-8 strings (1 to 1024 bytes) that may contain `/`. Values are any JSON document, 4 MiB maximum.
3. Every read and write takes a consistency mode: `strict` (default), `session`, `bounded`, `available`, `eventual`. **Never weaken a mode the user asked for.** The server never weakens it either.
4. Every write carries a **mutation ID** (UUID). Retrying with the same ID never applies a write twice. The SDKs do this for you.
5. A write can end in three states: **applied**, **not applied**, or **unknown**. Treat `unknown` as "may have committed". Never report it as a failure. Resolve it with `GET /v1/mutations/{id}`.
6. Use the official SDK for the user's language (TypeScript, Python, Go, Rust). Use raw HTTP only when no SDK fits.
7. Model data as **key prefixes** (`users/42`, `orders/2026/0001`). Range scans and queries work on prefixes in key order.
8. Server-side filters (`POST /v1/query`) with MongoDB-like operators exist. Joins, transactions across replica sets, and SQL do not.
9. Compare-and-set: `if_version=N` or `if_absent=true`. Only in `strict` mode.
10. Change streams: WebSocket `GET /v1/watch?prefix=`. Best-effort, start at "now", may send `lagged`.

---

## 1. Decide if CelerisDB fits

Use CelerisDB when the app needs:

- JSON documents addressed by key, with prefix scans and simple server-side filters.
- A mix of strongly consistent data (balances, inventory, uniqueness) and highly available data (likes, presence, telemetry) **in one cluster**.
- Self-hosting on a laptop, Docker, Kubernetes or VMs.
- Live updates to UIs through change streams.
- Agent memory, chat history, job queues, caches, feature flags, sessions.

Do not pick CelerisDB (tell the developer instead) when the app needs:

- SQL, joins, foreign keys or multi-key transactions that span replica sets.
- Full-text search, vector search or geo queries (not built in; pair with a dedicated engine).
- Point-in-time snapshot scans (scans are not snapshots, see D-010).
- A managed cloud service (CelerisDB is self-hosted only).
- Values larger than 4 MiB (store blobs in object storage and keep the URL in CelerisDB).

---

## 2. Install and run a node

### 2.1 Install the binary

```bash
# macOS / Linux
curl -fsSL https://raw.githubusercontent.com/vinitpatil519/CelerisDB/main/install.sh | sh
celeris init && celeris start
```

```powershell
# Windows PowerShell
irm https://raw.githubusercontent.com/vinitpatil519/CelerisDB/main/install.ps1 | iex
celeris init; celeris start
```

```bash
# Docker, single node, data in a named volume
docker run -d -p 8080:8080 -v celeris-data:/var/lib/celeris/data ghcr.io/vinitpatil519/celeris:latest
```

```bash
# Three-node replicated cluster on one machine
git clone https://github.com/vinitpatil519/CelerisDB && cd CelerisDB
docker compose up -d          # API on host ports 8081, 8082, 8083
```

- `celeris init` writes a commented `celeris.toml` in the current folder.
- `celeris start` runs in the foreground and prints exactly one line to stdout: `... listening on http://addr`. Logs go to stderr. Scripts can capture the bound address, including port `0`.
- Default API address: `http://127.0.0.1:8080`.
- Check health: `curl localhost:8080/health` returns `{"status":"ok","node_id":...}`.

### 2.2 Verify before you write app code

```bash
celeris doctor                 # config, data dir, storage lock, port, health
celeris put hello '"world"'    # JSON strings need quotes
celeris get hello
```

Agent rule: run `celeris status` or `curl /health` before you debug app code. Most "the SDK is broken" reports are "no node is running".

### 2.3 Ports

| Port | Purpose | Expose to |
|---|---|---|
| 8080 | HTTP/JSON API, WebSocket change streams, `/metrics`, `/health`, `/ready` | clients, load balancer, Prometheus |
| 7000 | Node-to-node: gossip, Raft, snapshots, data migration | other nodes only, private network |

---

## 3. Core concepts

### 3.1 Keys

- The key is everything after `/v1/kv/` in the URL. It may contain `/`.
- 1 to 1024 bytes of UTF-8 after percent-decoding. Must not start with `%00`.
- Keys with `.` or `..` path segments are not addressable (URL parsers collapse them). Do not generate such keys.
- Keys sort by byte order. Use zero-padded numbers (`orders/000042`) so that numeric order equals key order.
- Percent-encode each key segment when you build URLs by hand. The SDKs do this.

### 3.2 Values

- Any JSON value: object, array, string, number, boolean, null.
- Stored unchanged. 4 MiB maximum per value.
- Optional TTL per write: `ttl_ms` (at least 1). Expired keys read as `404 not_found`.

### 3.3 Versions

- Every committed write gets a **version** (monotonic commit number). Returned in the body and in the `celeris-version` header.
- Use the version for compare-and-set (`if_version`) and for "never go backwards" logic in UIs.

### 3.4 Mutation IDs

- Header `celeris-mutation-id: <uuid>` on a write request. If absent, the server generates one.
- Same ID + same payload = deduplicated: the original version is returned with `deduplicated: true`.
- Same ID + different payload = `422 mutation_id_reused`. Never reuse an ID for a different write.
- IDs are remembered for `storage.mutation_retention_secs` (default 86400 = 24 h).
- Deterministic IDs (UUIDv5 from business inputs, for example `order-checkout:<orderId>`) make whole workflows idempotent across process restarts.

### 3.5 Partitions and replica sets

- `partition = xxh3_64(key, seed 0) mod 4096`. Fixed at 4096 partitions forever. Golden vectors: `"users/42"` -> 1118, `"orders/123"` -> 2920.
- Each partition lives on a **replica set** (default 3 replicas), chosen by rendezvous hashing, spread across zones.
- Each replica set is a **Raft group**. Writes need a majority (2 of 3).
- Clients may talk to any node. A node that does not own a key answers `421 not_owner` or `421 not_leader` with routing hints. SDKs follow these automatically.

---

## 4. Consistency modes (read this twice)

| Mode | Reads | Writes | During a network partition | Use for |
|---|---|---|---|---|
| `strict` (default) | Linearizable, leader + read barrier | Raft majority commit | Majority side serves; minority refuses | Balances, inventory, bookings, uniqueness, anything with `if_version` |
| `session` | Read-your-writes, monotonic, any caught-up replica | Same as strict | Any replica that has your writes | Profiles, carts, settings, per-user timelines |
| `bounded` | Stale by at most `max_staleness_ms` | Not allowed for writes | Fails if no replica is fresh enough | Dashboards, leaderboards with a freshness budget |
| `available` | Any replica, maybe stale | Accepted without quorum (`202`), reconciled later, last-writer-wins, losers recorded as conflicts | Both sides accept writes | Likes, presence, telemetry, offline-tolerant carts |
| `eventual` | Nearest replica, fastest | Like available | Every reachable replica answers | Caches, recommendations, analytics |

Hard rules:

1. `strict` is never silently downgraded. If there is no quorum the request fails or times out with an error that says so.
2. A timeout never means success. It also never means failure. It means "unknown".
3. Every response reports the mode actually applied: `consistency` in the body and the `celeris-consistency` header.
4. `bounded` requires `max_staleness_ms`. Writes reject `bounded` with `400 invalid_consistency`.
5. `if_version` / `if_absent` with `available` or `eventual` -> `400 conditions_require_strict`.
6. On a single node every mode behaves the same (one replica is trivially linearizable). Modes diverge only in a replicated cluster. Write code for the cluster case anyway.

How to choose (decision procedure for agents):

```
Does a wrong or lost value cost money, break an invariant, or need compare-and-set?   -> strict
Does the same user need to see their own write immediately?                            -> session
Can the reader tolerate N ms of staleness and you want cheaper reads?                   -> bounded (max_staleness_ms = N)
Must the write succeed even when the cluster is split, and is last-writer-wins OK?     -> available
Is it a cache or derived data that can be rebuilt?                                      -> eventual
Unsure?                                                                                 -> strict, and leave a comment
```

### 4.1 `available` writes in detail

- On the group leader: commit like strict, `200`.
- Elsewhere: `202 {"accepted": true, "replicated": false, "timestamp_ms", "mutation_id"}`. Committed in the background.
- Conflict policy: deterministic per-key last-writer-wins. Every losing write is kept.
- List losers: `GET /v1/conflicts?prefix=&limit=` (key, losing value, timestamps, mutation IDs, origin, winner).
- Clear: `DELETE /v1/conflicts/{key}` (needs `write` scope).
- CLI shows `ACCEPTED (not yet replicated)`. SDKs expose `replicated: false`.
- Merkle-digest anti-entropy repairs diverged replicas every `cluster.anti_entropy_interval_ms` (default 60000).

Agent rule: when you use `available`, show the developer how to read `/v1/conflicts`, or explain why last-writer-wins is acceptable for that data. Never use `available` for counters that must be exact (two concurrent increments collapse into one under LWW). For exact counters use `strict` with `if_version` and retry on `409`.

### 4.2 `session` tokens

- Successful writes in replicated mode return `celeris-session-index: <index>@<group>`.
- Send it back on `session` reads. A replica that has not applied that index answers `503 session_behind`; the SDK retries another node.
- SDK clients store the latest token automatically (`db.session` in TypeScript). One client per user session keeps tokens meaningful. Sharing one client across all users of a server makes "session" mean "this server process".

---

## 5. HTTP API v1 reference

Base URL: `http://<node>:8080`. All bodies are JSON.

### 5.1 Headers

| Header | Direction | Meaning |
|---|---|---|
| `Authorization: Bearer <token>` | request | Required once tokens are configured |
| `celeris-mutation-id: <uuid>` | request / response | Idempotency key for writes |
| `celeris-version` | response | Commit version of the value written or read |
| `celeris-consistency` | response | Mode actually applied |
| `celeris-partition`, `celeris-partition-epoch` | response | Routing info |
| `celeris-partition-epoch: N` | request | Epoch the client routed with (fencing) |
| `celeris-session-index` | response / request | Session token for `session` reads |

### 5.2 Key-value

```http
PUT    /v1/kv/{key}?consistency=&ttl_ms=&if_version=&if_absent=true     body: JSON value
GET    /v1/kv/{key}?consistency=&max_staleness_ms=
DELETE /v1/kv/{key}?consistency=&if_version=
```

PUT response:

```json
{"key":"users/42","version":17,"mutation_id":"5d0c...","deduplicated":false,"consistency":"strict"}
```

GET response:

```json
{"key":"users/42","value":{"name":"Ada"},"version":17,"mutation_id":"5d0c...",
 "timestamp_ms":1760000000000,"expires_at_ms":null,"consistency":"strict"}
```

### 5.3 Atomic batch

```http
POST /v1/batch
```

```json
{"mutation_id": "optional-uuid", "consistency": "strict", "ops": [
  {"op": "put", "key": "orders/1", "value": {"total": 3}, "ttl_ms": 60000, "if_absent": true},
  {"op": "delete", "key": "carts/9", "if_version": 12}
]}
```

- All or nothing, one mutation ID, one commit version. Conditions are checked against the state before the batch.
- Limits: 10,000 ops, 32 MiB of keys plus values, 4 MiB per value.
- In a cluster every key must belong to **one replica set**; otherwise `400 cross_group_batch`. Design keys so that things updated together share a replica set, or use a saga with deterministic mutation IDs (see 9.4).

### 5.4 Scan

```http
GET /v1/scan?prefix=users/&limit=100&after=<cursor>&consistency=
GET /v1/scan?start=a&end=m          # start inclusive, end exclusive
```

```json
{"items":[{"key":"users/1","value":{},"version":3,"expires_at_ms":null}],
 "next_cursor":"users/1","consistency":"strict"}
```

- `limit` 1 to 1000, default 100. Pass `next_cursor` as `after`. `null` = last page.
- Each item is committed, but the scan is **not** a point-in-time snapshot.
- `"partial": true` = the node could not cover every partition. In replicated mode `strict`/`session` scans fail with `503 scan_incomplete` instead.

### 5.5 Query (server-side filter, projection, sort, aggregate)

```http
POST /v1/query
```

```json
{"prefix":"orders/",
 "where":{"status":"paid","total":{"$gte":100},"customer.tier":{"$in":["gold","platinum"]}},
 "fields":["total","customer.id"],
 "limit":100,"max_scanned":10000,"after":null,"consistency":"strict"}
```

Response:

```json
{"items":[{"key":"orders/0042","value":{"total":120,"customer":{"id":7}},"version":9,"expires_at_ms":null}],
 "next_cursor":"orders/0042","scanned":57,"index":null,"consistency":"strict","partial":false}
```

Operators:

| Operator | Matches when the field |
|---|---|
| `{"f": v}` / `$eq` | equals v |
| `$ne` | does not equal v (also matches a missing field) |
| `$gt` `$gte` `$lt` `$lte` | compares with a number or a string; other types never match |
| `$in` `$nin` | is / is not one of up to 1,000 values |
| `$exists` | is present (`true`) or absent (`false`) |
| `$prefix` | is a string that starts with the argument |
| `$contains` | is an array that holds the value, or a string that contains the substring |
| `$and` `$or` (arrays), `$not` (filter) | logical composition |

- Dotted paths: `customer.tier`; numeric segments index arrays: `items.0.sku`.
- `1` equals `1.0`. Limits: 256 conditions, 16 nesting levels. Bad filter -> `400 invalid_filter`.
- **Paging trap:** a page reads at most `max_scanned` rows (1 to 100,000, default 10,000). A selective filter can return **zero items and a non-null `next_cursor`**. Always loop until `next_cursor` is `null`. Never treat an empty page as "done".
- Use SDK helpers that follow cursors (`query` iterators, `queryAll`, `aggregate`) or `celeris query --all`.

Sort (needs an index on that field with the same order, else `400 sort_unavailable`):

```json
{"prefix":"orders/","where":{"status":"paid"},"sort":{"field":"total","order":"desc"},"limit":20}
```

- Records whose sort field is missing, an array or an object are not returned by sorted queries.
- Type order: `null < false < true < numbers < strings`.

Aggregate (count, sum, min, max per page; merge pages or use SDK helpers):

```json
{"prefix":"orders/","where":{"status":"paid"},
 "aggregate":{"count":true,"sum":["total"],"min":["created"],"max":["total"]}}
```

### 5.6 Secondary indexes

Declared in `celeris.toml`. Every node must list the same indexes.

```toml
[[indexes]]
name = "orders_by_status"   # a-z, 0-9, _ and -
prefix = "orders/"          # "" for all keys
field = "status"            # dotted path
order = "asc"               # or "desc", used by sort
```

- Indexes cover string, number, boolean and null values. Arrays and objects are not indexed.
- Built in the background (1,000 keys per step). Queries scan until state is `ready` (`GET /v1/status`).
- Used automatically for top-level equality conditions when the query range lies inside the index prefix. `index` in the response names it.
- Updated atomically with the data.

### 5.7 Mutation status

```http
GET /v1/mutations/{id}
200 {"status":"committed","version":17}
404 {"status":"unknown"}     # not committed, still in flight, or older than retention
```

### 5.8 Change streams (WebSocket)

```http
GET /v1/watch?prefix=orders/          (ws:// or wss://, token via ?access_token= in browsers)
```

Messages:

```json
{"type":"hello","node":"a","prefix":"orders/","groups":[...],"partial":false}
{"type":"change","key":"orders/1","kind":"put","value":{...},"version":18,"mutation_id":"..."}
{"type":"lagged","missed":42}
```

- Best-effort, from "now". No replay, no resume token.
- A node sees changes of the replica sets it belongs to. `partial: true` -> watch one node per replica set, or set RF = node count.
- On `lagged`, re-read the state you display. Pattern: read, then watch, then apply events with `version > lastSeenVersion`.
- A plain HTTP request gets `400 websocket_required`.

### 5.9 Operational endpoints

| Endpoint | Purpose |
|---|---|
| `GET /health` | Liveness (no auth) |
| `GET /ready` | 200 when writable, 503 `read_only` after WAL failure (no auth) |
| `GET /metrics` | Prometheus text (no auth) |
| `GET /v1/status` | Node, cluster, Raft, partitions, storage, indexes, migrations |
| `GET /v1/partitions` | Partition map summary |
| `GET /v1/partitions/key/{key}` | `{partition, partition_epoch, map_epoch, replicas, leader}` |
| `GET /v1/conflicts?prefix=&limit=` | Losers of last-writer-wins |
| `DELETE /v1/conflicts/{key}` | Clear conflicts for a key |
| `GET /v1/admin/backup` | Admin. Physical snapshot (single node only, else `501`) |
| `POST /v1/admin/rebalance` | Admin. `{"replication_factor": N}` |
| `POST /v1/admin/shutdown` | Admin. Graceful stop |

Admin endpoints accept loopback only, unless tokens are configured (then `admin` scope from any address).

---

## 6. Errors and what to do with each

Error body:

```json
{"error": {"code": "condition_failed", "message": "...",
           "outcome": "not_applied", "mutation_id": "...", "current_version": 7}}
```

`outcome` is on every write error: `not_applied` (safe to treat as failure) or `unknown` (may have committed).

| HTTP | `code` | Meaning | Agent action |
|---|---|---|---|
| 400 | `invalid_json` `invalid_key` `invalid_argument` `invalid_query` `invalid_consistency` `invalid_mutation_id` `invalid_filter` | Bad input | Fix the code. Do not retry. |
| 400 | `conditions_require_strict` | CAS with available/eventual | Use `strict` |
| 400 | `cross_group_batch` | Batch spans replica sets | Split, or redesign keys |
| 400 | `sort_unavailable` | No matching index | Add `[[indexes]]` with the same order, wait for `ready` |
| 400 | `websocket_required` | Plain GET on `/v1/watch` | Use a WebSocket client |
| 401 | `unauthorized` | Missing or unknown token | Set token |
| 403 | `forbidden` | Scope too small, or admin from non-loopback | Use a token with the right scope |
| 404 | `not_found` | Key absent, deleted or expired | Normal; SDK `get` returns null/None/nil |
| 409 | `condition_failed` | `if_version`/`if_absent` did not hold; `current_version` given | Re-read, re-apply business logic, retry with a **new** mutation ID |
| 409 | `stale_epoch` | Routed with old partition epoch | Refresh routing, retry (SDK does this) |
| 409 | `migrations_pending` | Rebalance already moving data | Wait |
| 421 | `not_owner` `not_leader` `partition_moved` | Wrong node | Follow hints (SDK does this) |
| 422 | `mutation_id_reused` | Same ID, different payload | Bug: generate a new ID per distinct write |
| 500 | `outcome_unknown` | Durability not confirmed; `outcome: unknown` | Retry with the **same** ID, or check `/v1/mutations/{id}` |
| 500 | `corruption` `internal` | Server fault | Surface to operator |
| 503 | `read_only` | WAL failure, node refuses writes | Operator must investigate the disk |
| 503 | `no_partition_map` | Cluster not placed yet | Wait for all voters, or `celeris cluster rebalance --rf N` |
| 503 | `proposal_lost` `partition_moving` `epoch_ahead` `session_behind` | Transient, not applied | Retry shortly (SDK does this) |
| 503 | `scan_incomplete` | A group unreachable during strict/session scan | Retry, or use eventual and accept `partial` |

### 6.1 The three-outcome rule (most important rule in this file)

```
success            -> the write is durable
not_applied        -> nothing was written; you may tell the user it failed
unknown            -> it MAY be durable; do NOT tell the user it failed
                      resolve: same mutation ID retry, or GET /v1/mutations/{id}
```

Wrong (do not generate this):

```ts
try { await db.put(key, v); } catch { await refundCustomer(); } // may refund a committed payment
```

Right:

```ts
try {
  await db.put(key, v, { mutationId });
} catch (e) {
  if (e instanceof OutcomeUnknownError) {
    const { committed, version } = await db.mutationStatus(e.mutationId!);
    // committed: done at `version`. Not committed yet: retry later with the SAME mutationId.
  } else if (e instanceof CelerisError && e.outcome === "not_applied") {
    // safe: nothing was written
  } else throw e;
}
```

### 6.2 CLI exit codes

| Code | Meaning |
|---|---|
| 0 | Success |
| 1 | Error; for writes also means **not applied** |
| 2 | Usage error |
| 3 | Write outcome **unknown**; run `celeris mutation <id>` |
| 4 | Key or mutation not found |

---

## 7. SDKs

All SDKs share these guarantees:

- **Safe retries.** Every write has a mutation ID. Network failures, `not_leader`/`not_owner` redirects and not-applied errors are retried with the same ID across nodes.
- **Honest outcomes.** Unknown outcome is a distinct error type with the mutation ID.
- **No silent downgrade.** Results report the applied consistency.
- **Sessions.** The latest `celeris-session-index` is stored and sent on `session` reads.
- **Node list.** Pass every node you can reach. The client starts at the last node that answered and rotates.

Do not wrap SDK calls in your own retry loops for transport errors; that is already done. Do add business-level retries for `409 condition_failed`.

### 7.1 TypeScript / JavaScript (`@celeris/client`)

Node.js 22+ or browsers. No runtime dependencies (platform `fetch` and `WebSocket`). Not on the npm registry yet: install from the repo.

```bash
git clone https://github.com/vinitpatil519/CelerisDB
(cd CelerisDB/sdks/typescript && npm install && npm run build)
npm install ./CelerisDB/sdks/typescript
# CI / Docker: cd CelerisDB/sdks/typescript && npm pack, then npm install path/to/celeris-client-0.1.0.tgz
```

```ts
import { Client, CelerisError, OutcomeUnknownError } from "@celeris/client";

const db = new Client({
  nodes: ["http://10.0.0.1:8080", "http://10.0.0.2:8080", "http://10.0.0.3:8080"],
  token: process.env.CELERIS_TOKEN,   // optional
  consistency: "strict",              // default for calls that do not pass one
  timeoutMs: 5_000,                   // per attempt, default 10000
  attempts: 4,                        // default 4
});

type User = { name: string; plan: "free" | "pro" };

const w = await db.put<User>("users/42", { name: "Ada", plan: "free" });
const u = await db.get<User>("users/42", { consistency: "session" });   // null when missing
await db.put("users/42", { ...u!.value, plan: "pro" }, { ifVersion: u!.version });
await db.put("locks/job-7", { owner: "w1" }, { ifAbsent: true, ttlMs: 30_000 });
await db.delete("carts/9");

await db.batch([
  { op: "put", key: "orders/1", value: { total: 3 }, if_absent: true },
  { op: "delete", key: "carts/9" },
]);

for await (const it of db.scan({ prefix: "orders/" })) console.log(it.key, it.value);
const page = await db.scanPage({ prefix: "orders/", limit: 100 }, /* after */ undefined);

for await (const it of db.query({ prefix: "orders/", where: { status: "paid", total: { $gte: 100 } }, fields: ["total"] })) {}
const stats = await db.aggregate({ prefix: "orders/", where: { status: "paid" },
  aggregate: { count: true, sum: ["total"], min: ["created"], max: ["total"] } });

const watcher = db.watch("orders/", {
  onChange: (e) => console.log(e.kind, e.key, e.value, e.version),
  onLagged: () => reload(),
});
watcher.close();

const status = await db.mutationStatus(mutationId);
```

React:

```tsx
import { useCeleris } from "@celeris/client/react";
const { data, version, loading, error, refresh } = useCeleris<User>(db, `users/${id}`);
```

`useCeleris` reads once, then follows the change stream, never moves backwards in version, re-reads after `lagged`. Without React: `createKeyStore(client, key)`.

Errors: `CelerisError` (`status`, `code`, `details`, `outcome`) and `OutcomeUnknownError` (`mutationId`).

Browser warning: any token in client-side code (`VITE_*`, `NEXT_PUBLIC_*`) is public. Never ship `write` or `admin` tokens to browsers unless the data is meant to be world-writable. Proxy through your server instead. CORS is off by default (`http.cors_origins`).

### 7.2 Python (`celeris-client`)

Python 3.10+, standard library only (built-in WebSocket client).

```bash
pip install "git+https://github.com/vinitpatil519/CelerisDB.git#subdirectory=sdks/python"
# requirements.txt:  celeris-client @ git+https://github.com/vinitpatil519/CelerisDB.git#subdirectory=sdks/python
# uv:                uv add "celeris-client @ git+https://github.com/vinitpatil519/CelerisDB.git#subdirectory=sdks/python"
```

```python
from celeris import Client, OutcomeUnknownError

db = Client(["http://10.0.0.1:8080", "http://10.0.0.2:8080"])

db.put("users/42", {"name": "Ada"})
user = db.get("users/42", consistency="session")          # None when missing
db.put("users/42", {"name": "Ada L."}, if_version=user.version)

db.batch([
    {"op": "put", "key": "orders/1", "value": {"total": 3}, "if_absent": True},
    {"op": "delete", "key": "carts/9"},
])

for item in db.scan(prefix="orders/"):
    print(item.key, item.value)

for item in db.query(prefix="orders/", where={"status": "paid", "total": {"$gte": 100}}, fields=["total"]):
    print(item.key, item.value)

with db.watch("orders/") as watch:
    print(watch.hello)
    for event in watch:            # or watch.next(timeout=5)
        print(event.kind, event.key, event.value, event.version)
        if watch.lagged:
            ...                     # re-read

try:
    db.put("payments/p1", {"amount": 10}, mutation_id=mid)
except OutcomeUnknownError as e:
    committed, version = db.mutation_status(e.mutation_id)
```

The client is synchronous. In async frameworks (FastAPI), call it with `asyncio.to_thread(...)` or run it in a threadpool; do not block the event loop.

### 7.3 Go

Go 1.22+, standard library only.

```bash
go get github.com/vinitpatil519/CelerisDB/sdks/go@main
```

```go
import celeris "github.com/vinitpatil519/CelerisDB/sdks/go"

db, err := celeris.New(celeris.Options{Nodes: []string{"http://10.0.0.1:8080", "http://10.0.0.2:8080"}})

written, err := db.Put(ctx, "users/42", map[string]any{"name": "Ada"}, nil)
item, err := db.Get(ctx, "users/42", &celeris.ReadOptions{Consistency: celeris.Session}) // (nil, nil) when missing
var user User
err = item.Decode(&user)

_, err = db.Put(ctx, "users/42", User{Name: "Ada L."}, &celeris.PutOptions{IfVersion: written.Version})
if celeris.IsCode(err, "condition_failed") { /* someone else wrote first */ }

_, err = db.Batch(ctx, []celeris.BatchOp{celeris.Put("orders/1", map[string]int{"total": 3}), celeris.Delete("carts/9")}, nil)

err = db.Scan(ctx, &celeris.ScanOptions{Prefix: "orders/"}, func(it celeris.Item) bool { return true })
err = db.Query(ctx, &celeris.QueryOptions{
    ScanOptions: celeris.ScanOptions{Prefix: "orders/"},
    Where:       map[string]any{"status": "paid", "total": map[string]any{"$gte": 100}},
    Fields:      []string{"total"},
}, func(it celeris.Item) bool { return true })

w, err := db.Watch(ctx, "orders/")
defer w.Close()
for {
    ev, err := w.Next(ctx)
    if err != nil { break }            // celeris.ErrWatchClosed or ctx.Err()
    if ev.Change != nil { /* apply */ } else { /* ev.Lagged: re-read */ }
}

var unk *celeris.OutcomeUnknownError
if errors.As(err, &unk) { committed, version, _ := db.MutationStatus(ctx, unk.MutationID); _ = committed; _ = version }
if errors.Is(err, celeris.ErrUnreachable) { /* write never left: not applied */ }
```

Always pass a `context.Context` with a deadline.

### 7.4 Rust (`celeris-client`)

Async, on `tokio`, `reqwest`, `tokio-tungstenite`. Feature `rustls` for HTTPS/WSS with Mozilla roots.

```bash
cargo add celeris-client --git https://github.com/vinitpatil519/CelerisDB
cargo add serde --features derive
cargo add serde_json
cargo add tokio --features macros,rt-multi-thread,time
```

```rust
use celeris_client::{BatchOp, Client, Consistency, PutOptions, QueryOptions, ReadOptions, ScanOptions, WatchEvent, WriteOptions};
use serde_json::json;

let db = Client::builder().nodes(["http://10.0.0.1:8080", "http://10.0.0.2:8080"]).build()?;

let written = db.put("users/42", &json!({"name": "Ada"})).await?;
let user = db.get_with::<serde_json::Value>("users/42", ReadOptions {
    consistency: Some(Consistency::Session), ..Default::default()
}).await?;
let typed: Option<_> = db.get::<User>("users/42").await?;

db.put_with("users/42", &json!({"name": "Ada L."}), PutOptions { if_version: written.version, ..Default::default() }).await?;
db.batch(vec![BatchOp::put("orders/1", json!({"total": 3})), BatchOp::delete("carts/9")], WriteOptions::default()).await?;

let paid = db.query_all::<serde_json::Value>(&QueryOptions {
    range: ScanOptions { prefix: Some("orders/".into()), ..Default::default() },
    filter: Some(json!({"status": "paid", "total": {"$gte": 100}})),
    fields: Some(vec!["total".into()]),
    ..Default::default()
}).await?;

let mut watch = db.watch("orders/").await?;
while let Some(event) = watch.next().await? {
    match event {
        WatchEvent::Change(e) => println!("{} {} {}", e.kind, e.key, e.value),
        WatchEvent::Lagged(n) => println!("missed {n}: re-read"),
    }
}
```

Errors: `Error::OutcomeUnknown { mutation_id, .. }` (check with `db.mutation_status(&id)`), `Error::Unreachable` (not applied).

### 7.5 Raw HTTP (curl, any language)

```bash
curl -X PUT localhost:8080/v1/kv/users/42 -H 'celeris-mutation-id: 0b3e...' -d '{"name":"Ada"}'
curl "localhost:8080/v1/kv/users/42?consistency=session"
curl -X PUT "localhost:8080/v1/kv/users/42?if_version=17" -d '{"name":"Ada L."}'
curl -X PUT "localhost:8080/v1/kv/locks/a?if_absent=true&ttl_ms=30000" -d '{"owner":"w1"}'
curl "localhost:8080/v1/scan?prefix=users/&limit=100"
curl -X POST localhost:8080/v1/query -d '{"prefix":"orders/","where":{"status":"paid"}}'
curl localhost:8080/v1/mutations/0b3e...
```

If you write your own client, you must implement: a UUID mutation ID per logical write reused on every retry; retry only on network errors, `421`, and `503` codes listed as transient; never retry `4xx` input errors; follow `leader`/`replicas` hints from `421`; surface `outcome: unknown` distinctly.

---

## 8. CLI reference

Global flags: `--addr <url>` (env `CELERIS_ADDR`, default `http://127.0.0.1:8080`), `--json`, `--token` (env `CELERIS_TOKEN`), `--ca-cert <pem>` (env `CELERIS_CA_CERT`).

| Command | Purpose |
|---|---|
| `celeris init [--dir .] [--listen 127.0.0.1:8080] [--force]` | Write commented `celeris.toml` |
| `celeris start [--config celeris.toml]` | Run a node (foreground) |
| `celeris stop` | Graceful stop (loopback) |
| `celeris status` / `node list` / `cluster status` | Health, membership |
| `celeris put <key> <json> [--ttl 10m] [--if-version N \| --if-absent] [--mutation-id UUID] [-c mode] [--file path\|-]` | Write |
| `celeris get <key> [-c mode] [--max-staleness 500ms]` | Read |
| `celeris delete <key> [--if-version N]` | Delete |
| `celeris scan [--prefix p] [--after cursor] [--limit 100]` | List keys |
| `celeris query [--prefix p] [--where JSON] [--fields a,b.c] [--limit N] [--max-scanned N] [--all]` | Filter |
| `celeris query ... --count --sum f --min f --max f --all` | Aggregate |
| `celeris query ... --sort total[:desc]` | Sorted through an index |
| `celeris mutation <uuid>` | Did it commit? |
| `celeris conflicts list [--prefix p]` / `conflicts clear <key>` | LWW losers |
| `celeris cluster rebalance --rf N` | Place partitions |
| `celeris partitions [--key K]` | Placement |
| `celeris doctor` | Diagnose setup |
| `celeris bench [--workload put\|get\|mixed] [--ops N] [-c N] [--value-size B] [--keys N]` | p50/p95/p99, throughput |
| `celeris token create <name> --scope read,write,admin` / `token hash` | Auth tokens |
| `celeris backup --out f` / `restore --from f` | Physical backup, single node |
| `celeris export --out f [--prefix p]` / `import --from f [--batch-size 200] [--threads 8]` | JSON lines, works on clusters, re-runnable |

Shell quoting: values are JSON, strings need quotes: `celeris put greeting '"hello"'`. In Windows PowerShell 5.1 escape quotes (`'{\"name\":\"Ada\"}'`) or pipe through `--file -`.

---

## 9. Data modeling patterns (copy these)

### 9.1 Key design

```
users/<userId>                         one document per user
users/<userId>/settings                sub-document, same prefix for scans
orders/<yyyy>/<mm>/<zero-padded id>    time-ordered
chat/<session>/<999999 - seq>          newest-first (inverted sequence)
idx/email/<lowercased email>           -> {"user": "<userId>"}  manual unique index
jobs/<queue>/<priority>/<ts>/<id>      ordered work queue
```

- Put the high-cardinality, query-defining segment first after the collection.
- Zero-pad numbers. Invert sequences for newest-first.
- Hierarchical prefixes replace "tables". There is no schema; validate in your app (zod, pydantic, serde).

### 9.2 Uniqueness (for example unique email)

```ts
// claim the email first; ifAbsent fails with 409 if taken
await db.put(`idx/email/${email.toLowerCase()}`, { user: id }, { ifAbsent: true });
await db.put(`users/${id}`, { id, email });
```

If both keys land in the same replica set you may use one atomic `batch`. Otherwise write the claim first, and clean up stale claims that point to missing users.

### 9.3 Optimistic concurrency (read-modify-write)

```ts
async function update<T>(key: string, fn: (v: T | undefined) => T) {
  for (let i = 0; i < 8; i++) {
    const cur = await db.get<T>(key);
    const next = fn(cur?.value);
    try {
      return cur ? await db.put(key, next, { ifVersion: cur.version })
                 : await db.put(key, next, { ifAbsent: true });
    } catch (e) {
      if (e instanceof CelerisError && e.code === "condition_failed") continue; // new mutation ID each attempt
      throw e;
    }
  }
  throw new Error(`contention on ${key}`);
}
```

Each attempt is a different logical write, so each gets its own mutation ID (the SDK generates one per call).

### 9.4 Idempotent multi-step workflows (sagas)

Derive mutation IDs from business inputs so a crashed worker can re-run the whole workflow safely:

```ts
import { createHash } from "node:crypto";
export function stableId(...parts: string[]): string {
  const h = createHash("sha256").update(JSON.stringify(parts)).digest();
  h[6] = (h[6]! & 0x0f) | 0x50;
  h[8] = (h[8]! & 0x3f) | 0x80;
  const x = h.subarray(0, 16).toString("hex");
  return [x.slice(0, 8), x.slice(8, 12), x.slice(12, 16), x.slice(16, 20), x.slice(20)].join("-");
}
await db.put(`orders/${id}`, order, { mutationId: stableId("order", id, "create") });
await db.put(`stock/${sku}`, stock, { mutationId: stableId("order", id, "reserve", sku) });
```

```python
import uuid
_NS = uuid.UUID("5f0b6c1e-8f3a-4d57-9a4e-2f4a0e2c9b11")  # pick your own fixed namespace
def stable_id(*parts: str) -> str:
    return str(uuid.uuid5(_NS, "\x1f".join(parts)))
```

Remember retention: IDs are remembered for 24 h by default. Workflows that can be retried later than that need app-level state checks.

### 9.5 Distributed lock / lease

```ts
await db.put(`locks/${name}`, { owner, at: Date.now() }, { ifAbsent: true, ttlMs: 30_000 }); // 409 if held
// renew: put with ifVersion of the lock you hold, same ttl
// release: delete with ifVersion
```

TTL expiry is the safety net. Always use fencing (version) on renew and release.

### 9.6 Work queue

- Enqueue: `put jobs/<queue>/<ts>/<id>`.
- Claim: scan the prefix with `limit`, then `put claims/<id>` with `ifAbsent` and a TTL. The winner processes; losers move on.
- Finish: `batch` delete of job + claim when they share a replica set, else delete job then claim.

### 9.7 Agent and LLM memory

- Chat history: `chat/<session>/<999999 - seq>` with `ifAbsent` to prevent two writers from losing a message, TTL for retention, `scanPage({ prefix, limit: n })` for "last n messages".
- Tool-call results cache: `cache/<tool>/<sha256(args)>` with `eventual` reads and TTL.
- Long-term facts: `memory/<agent>/<topic>/<id>`, query with `$contains` / `$prefix`.
- Agent run state: `runs/<runId>` with `strict` + `ifVersion` so two workers never advance the same run.

### 9.8 Live UI

1. Read the state with `get` or `scan` and remember `version` per key.
2. Open `watch(prefix)`.
3. Apply `change` events only when `event.version > known version`.
4. On `lagged`, re-read. On disconnect, reconnect and re-read (no replay exists).

### 9.9 Counters

- Exact (balances, stock): `strict` + `ifVersion` retry loop (9.3), or one document per bucket to spread contention (`counters/views/<shard 0..15>`), summed with `aggregate`.
- Approximate (likes, views): `available` per-user keys (`likes/<post>/<user>` = true) and `aggregate count`. Never increment a single key under LWW.

---

## 10. Configuration (`celeris.toml`)

| Key | Type | Default | Notes |
|---|---|---|---|
| `node.id` | string | random on first start | Fixed ID; must match data dir. Required for voters |
| `node.data_dir` | path | `data` | |
| `http.listen` | host:port | `127.0.0.1:8080` | `0.0.0.0:8080` in Docker |
| `http.cors_origins` | string[] | `[]` | `["*"]` allowed |
| `http.tls` | `{cert_file, key_file}` | unset | HTTPS only, HTTP/2 via ALPN |
| `auth.tokens` | array of tables | `[]` (auth off) | Create with `celeris token create` |
| `storage.sync` | `always` / `never` | `always` | `never` loses acknowledged writes on power loss |
| `storage.memtable_size_mb` | int | 32 | |
| `storage.block_cache_mb` | int | 64 | |
| `storage.tombstone_retention_secs` | int | 86400 | |
| `storage.mutation_retention_secs` | int | 86400 | Idempotency window |
| `cluster.listen` | host:port | unset (single node) | Cluster port, e.g. 7000 |
| `cluster.advertise` | host:port | bound listen address | Stable address peers dial |
| `cluster.seeds` | string[] | `[]` | |
| `cluster.voters` | string[] | `[]` | Node IDs of Raft control plane (3 or 5). Enables replicated mode |
| `cluster.zone` | string | | Rack / AZ, spreads replicas |
| `cluster.replication_factor` | 0-255 | 3 | 0 = place manually with rebalance |
| `cluster.heartbeat_interval_ms` | int | 500 | Gossip |
| `cluster.suspect_after_ms` | int | 2000 | |
| `cluster.suspicion_timeout_ms` | int | 5000 | |
| `cluster.raft_election_timeout_ms` | int | 1000 | |
| `cluster.raft_heartbeat_ms` | int | 250 | |
| `cluster.snapshot_threshold` | int | 10000 | |
| `cluster.auto_rebalance_after_ms` | int | 30000 | |
| `cluster.anti_entropy_interval_ms` | int | 60000 | 0 disables |
| `cluster.tls` | `{cert_file, key_file, ca_file}` | unset | Mutual TLS between nodes |
| `log.level` / `log.format` | | | `pretty` or `json` |

Environment overrides: `CELERIS_DATA_DIR`, `CELERIS_HTTP_LISTEN`, `CELERIS_CORS_ORIGINS`, `CELERIS_SYNC`, `CELERIS_CLUSTER_LISTEN`, `CELERIS_CLUSTER_ADVERTISE`, `CELERIS_CLUSTER_SEEDS`, `CELERIS_ZONE`, `CELERIS_NODE_ID`, `CELERIS_CLUSTER_VOTERS`, `CELERIS_LOG_LEVEL` (or `RUST_LOG`), `CELERIS_LOG_FORMAT`, `CELERIS_TLS_CERT`, `CELERIS_TLS_KEY`, `CELERIS_CLUSTER_TLS_CERT`, `CELERIS_CLUSTER_TLS_KEY`, `CELERIS_CLUSTER_TLS_CA`, `CELERIS_AUTH_TOKENS`.

---

## 11. Security

- Auth is **off** until at least one token exists. Turn it on for anything not on localhost.
- `celeris token create app --scope read,write` prints the token and the config line holding its SHA-256 hash. Nodes store only the hash.
- Scopes: `read` (GET, scan, query, watch, status, conflicts list), `write` (PUT, DELETE, batch, conflicts clear), `admin` (`/v1/admin/*` from any address).
- `/health`, `/ready`, `/metrics` never need a token. Do not expose them publicly if that leaks information you care about.
- Serve the API over TLS (`http.tls`). Clients: CLI `--ca-cert`, Node `NODE_EXTRA_CA_CERTS`, Python `SSL_CERT_FILE`.
- Protect port 7000 with `cluster.tls` (mutual TLS, dedicated CA) **and** a private network.
- Never commit tokens. Read them from env (`CELERIS_TOKEN`) or a secret manager.
- Never put `admin` tokens in browsers or mobile apps.

---

## 12. Deployment

- **Single node:** `celeris start` under systemd (`Restart=always`, `LimitNOFILE=65536`), SSD, `storage.sync = "always"`.
- **Cluster:** 3 (or 5) voters with fixed `node.id`, stable `cluster.advertise`, `cluster.zone` per AZ. RF 3: tolerates one replica down per replica set.

```bash
CELERIS_NODE_ID=a CELERIS_CLUSTER_LISTEN=127.0.0.1:7000 CELERIS_CLUSTER_VOTERS=a,b,c celeris start --config a/celeris.toml
CELERIS_NODE_ID=b CELERIS_HTTP_LISTEN=127.0.0.1:8081 CELERIS_CLUSTER_LISTEN=127.0.0.1:7001 \
  CELERIS_CLUSTER_SEEDS=127.0.0.1:7000 CELERIS_CLUSTER_VOTERS=a,b,c celeris start --config b/celeris.toml
# c likewise; the leader places partitions once a, b, c are up
celeris node list && celeris partitions
```

- **Docker:** image runs as uid 10001 under `tini`, listens on `0.0.0.0:8080`, data at `/var/lib/celeris/data`.
- **Kubernetes:** `deploy/kubernetes/celeris.yaml`: StatefulSet of 3 voters, headless Service for 7000, client Service, PodDisruptionBudget. Pod names are node IDs. Do not scale below 3. Scaling beyond 3 voters is not supported yet.
- **Load balancer health check:** `/ready` (not `/health`), so read-only nodes leave rotation.
- **Admin in Docker:** `docker compose exec node-a celeris --addr http://127.0.0.1:8080 cluster rebalance --rf 3`.

### 12.1 Backups

| | `backup` / `restore` | `export` / `import` |
|---|---|---|
| Form | binary engine snapshot | JSON lines (`key`, `value`, `expires_at_ms`) |
| Works on | single node | any node or cluster |
| Versions | kept | reassigned |
| Restore | offline, empty data dir | online, through API, re-runnable |

### 12.2 Observability

Prometheus `/metrics`: `celeris_http_requests_total{route,method,status}`, `celeris_http_request_duration_seconds`, `celeris_operations_by_consistency_total{mode,kind}`, `celeris_storage_*`. Alert on `/ready` failures, Raft leader changes, growing conflict counts.

---

## 13. Performance facts

- Measured numbers, method and comparisons live on the website (Benchmarks section) and in `docs/` in the repository. Quote those, never invent numbers.
- Every acknowledged write is durable by default (`storage.sync = "always"`, fsync per commit), so write throughput is bound by disk sync latency.
- Compaction is full (not leveled), so tail latency (p99) can spike while a compaction runs under sustained load.

Implications for app code:

- Batch writes (`/v1/batch`) when you can; each commit fsyncs.
- Narrow queries with `prefix`; add indexes for hot equality filters.
- Expect occasional tail-latency spikes during compaction; set client timeouts accordingly (seconds, not milliseconds).
- Use `session`/`bounded`/`eventual` reads to spread read load across replicas.
- Measure with `celeris bench` on the target hardware before promising numbers.

---

## 14. Known limitations (do not promise these)

- Full (not leveled) compaction: write amplification grows with data size.
- Scans and exports are not point-in-time snapshots.
- No multi-replica-set transactions; batches must stay in one replica set.
- Change streams have no replay or resume.
- No managed cloud, no SQL, no full-text, no vector index.
- TypeScript and Python SDKs are installed from the Git repository, not from npm/PyPI.
- Certificate reload requires a restart.
- Adding non-voter data nodes beyond the initial voters is on the roadmap.

---

## 15. Testing your integration

- Start a real node in tests: `celeris start` with `--config` pointing to a temp dir and `http.listen = "127.0.0.1:0"`; read the bound address from the single stdout line.
- Or run `docker compose up -d` and point tests at 8081-8083 to exercise redirects and replication.
- Test each consistency mode you use, the `409 condition_failed` path, and the unknown-outcome path (kill the node mid-write, then call `mutationStatus`).
- Clean up with a unique key prefix per test (`test/<uuid>/...`) instead of wiping the database.

---

## 16. Checklist before you hand code back

- [ ] Every read and write that matters has an explicit, justified `consistency`.
- [ ] No code treats `OutcomeUnknownError` / `outcome: unknown` / exit code 3 as failure.
- [ ] Writes that may be retried by your app use stable mutation IDs.
- [ ] Compare-and-set uses `strict`; `409` is handled with re-read and retry.
- [ ] Query loops continue until `next_cursor` is `null`, even on empty pages.
- [ ] Batches stay within one replica set or the code handles `cross_group_batch`.
- [ ] Change stream consumers handle `lagged` and reconnect with a re-read.
- [ ] Keys are zero-padded and contain no `.` / `..` segments.
- [ ] Values are under 4 MiB; blobs live elsewhere.
- [ ] Tokens come from env or a secret store; none with `write`/`admin` ships to browsers.
- [ ] The client gets the full node list.
- [ ] `available` writes have a documented conflict story (`/v1/conflicts`).

---

## 17. Prompt you can paste into your agent

```
Use CelerisDB as the database. Before writing code, read https://celerisdb.runs-at.dev/agents.md
completely and follow it. Use the official SDK for this project's language. Choose and justify
a consistency mode for every read and write. Never treat an unknown write outcome as a failure.
Run the checklist in section 16 before you finish.
```
