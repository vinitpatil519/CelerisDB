# `celeris` CLI

One binary runs a node and operates it. It works the same on Linux, macOS
and Windows; no shell-specific features are assumed.

Global flags:

* `--addr <url>`: node address. Default `http://127.0.0.1:8080`, or env `CELERIS_ADDR`.
* `--json`: print raw JSON responses.

| Command | What it does |
|---|---|
| `celeris init [--dir .] [--listen 127.0.0.1:8080] [--force]` | Write a commented `celeris.toml` |
| `celeris start [--config celeris.toml]` | Run a node in the foreground. Ctrl-C stops it gracefully. Prints `… listening on http://addr` |
| `celeris stop` | Graceful shutdown of the node at `--addr` (loopback only) |
| `celeris status` | Node health, uptime, storage, cluster |
| `celeris node list` | Nodes in the cluster |
| `celeris cluster status` | Membership and health |
| `celeris put <key> <json> [--ttl 10m] [--if-version N \| --if-absent] [--mutation-id UUID] [-c mode]` | Write a value. `--file path` or `--file -` reads the value from a file or stdin |
| `celeris get <key> [-c mode] [--max-staleness 500ms]` | Read a value |
| `celeris delete <key> [--if-version N]` | Delete a key |
| `celeris scan [--prefix p] [--after cursor] [--limit 100]` | List keys in order |
| `celeris mutation <uuid>` | Did this mutation commit? |
| `celeris conflicts list [--prefix p] [--limit N]` | Writes that lost last-writer-wins in `available` mode |
| `celeris conflicts clear <key>` | Forget a key's recorded conflicts |
| `celeris cluster rebalance --rf N` | Place partitions on the current members (any voter; followers forward to the leader) |
| `celeris partitions [--key K]` | Partition map summary, or the partition, epoch and replicas for one key |
| `celeris doctor [--config celeris.toml]` | Check config, data dir, storage lock, port and node health |
| `celeris bench [--workload put\|get\|mixed] [--ops N] [-c N] [--value-size B] [--keys N]` | Measure p50/p95/p99 latency and throughput (alias: `benchmark`) |

## Exit codes

| Code | Meaning |
|---|---|
| 0 | Success |
| 1 | Error. For writes this also means **not applied** |
| 2 | Usage error |
| 3 | Write outcome **unknown**: it may have committed. Run `celeris mutation <id>` |
| 4 | Key or mutation not found |

## Retries are safe

Every write carries a mutation ID. If the connection fails after the
request may have been sent, the CLI retries up to 3 times **with the same
ID**, and the node deduplicates.

* If every attempt failed before connecting, the CLI reports
  "nothing was written" (exit 1).
* If the outcome cannot be determined, it reports UNKNOWN with the mutation
  ID (exit 3). It never reports a plain failure in that case.

## Shell quoting

Values must be JSON, so strings need quotes:

```bash
celeris put greeting '"hello"'                     # bash / zsh
celeris put users/42 '{"name":"Vinit"}'
```

```powershell
celeris put users/42 '{\"name\":\"Vinit\"}'        # Windows PowerShell 5.1
echo '{"name":"Vinit"}' | celeris put users/42 --file -   # works in every shell
```

## Configuration and environment

`celeris init` writes every setting with comments. Environment variables
override the file:

| Variable | Overrides |
|---|---|
| `CELERIS_DATA_DIR` | `node.data_dir` |
| `CELERIS_HTTP_LISTEN` | `http.listen` |
| `CELERIS_CORS_ORIGINS` | `http.cors_origins` (comma-separated) |
| `CELERIS_SYNC` | `storage.sync` (`always` \| `never`) |
| `CELERIS_CLUSTER_LISTEN` | `cluster.listen`: internal gossip port; unset means single-node |
| `CELERIS_CLUSTER_ADVERTISE` | `cluster.advertise` |
| `CELERIS_CLUSTER_SEEDS` | `cluster.seeds` (comma-separated cluster addresses) |
| `CELERIS_ZONE` | `cluster.zone` |
| `CELERIS_NODE_ID` | `node.id` (fixed node ID; must match the data directory) |
| `CELERIS_CLUSTER_VOTERS` | `cluster.voters` (comma-separated node IDs of the Raft control plane) |
| `CELERIS_LOG_LEVEL` | `log.level`; `RUST_LOG` also works |
| `CELERIS_LOG_FORMAT` | `log.format` (`pretty` \| `json`) |

Logs go to stderr. Only the "listening on" banner goes to stdout, so
scripts can capture the bound address, including port `0`.

## Running a replicated cluster

Give each node a fixed ID, a cluster port and the full list of voters:

```bash
# node a
CELERIS_NODE_ID=a CELERIS_CLUSTER_LISTEN=127.0.0.1:7000 \
  CELERIS_CLUSTER_VOTERS=a,b,c celeris start --config a/celeris.toml
# node b (and c likewise), joining through a
CELERIS_NODE_ID=b CELERIS_HTTP_LISTEN=127.0.0.1:8081 CELERIS_CLUSTER_LISTEN=127.0.0.1:7001 \
  CELERIS_CLUSTER_SEEDS=127.0.0.1:7000 CELERIS_CLUSTER_VOTERS=a,b,c celeris start --config b/celeris.toml
celeris node list
# The leader places partitions on its own once a, b and c are all up
# (cluster.replication_factor, default 3). To re-place them later:
celeris cluster rebalance --rf 3
```

From then on every write goes through the Raft group of its key's replica
set (D-018):

* the control leader moves data when nodes join or die (D-020, D-022);
* `celeris partitions` shows the placement;
* `celeris status` shows Raft, migrations and anti-entropy.

`put -c available` on a node that is not the group leader answers
`ACCEPTED (not yet replicated)`. The write is committed in the background
(D-023).

## Not yet available

`celeris backup` arrives with production hardening (M9).