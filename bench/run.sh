#!/usr/bin/env bash
# Runs the comparative benchmark: each system starts in a fresh container with a
# fresh volume, gets the same preload, then the same cells. One system at a time.
#
#   bench/run.sh [--out FILE] [--reps N] [--systems "a b"] [--keys N] [--duration D] [--cells C]
#
# CPU: databases are pinned to logical CPUs 0-5, the load generator to 6-9.
# Memory: every database is limited to 2 GiB. Host networking, so no NAT overhead;
# each database binds to 127.0.0.1 because the credentials here are throwaway.
set -euo pipefail

here="$(cd "$(dirname "$0")" && pwd)"
out="$here/results/raw.jsonl"
reps=3
systems="celeris postgres mysql mongodb redis etcd cockroachdb cassandra"
keys=100000
duration=15s
warmup=5s
cells="a:32,b:32,c:32,a:1,a:128,load:32"
harness="${HARNESS:-}"

while (($#)); do
  case "$1" in
    --out) out="$2"; shift 2 ;;
    --reps) reps="$2"; shift 2 ;;
    --systems) systems="$2"; shift 2 ;;
    --keys) keys="$2"; shift 2 ;;
    --duration) duration="$2"; shift 2 ;;
    --warmup) warmup="$2"; shift 2 ;;
    --cells) cells="$2"; shift 2 ;;
    *) echo "unknown flag $1" >&2; exit 2 ;;
  esac
done

if [[ -z "$harness" ]]; then
  harness="$(mktemp -d)/harness"
  (cd "$here/harness" && go build -buildvcs=false -o "$harness" .)
fi

name=bench-db
vol=bench-db-data
limits=(--cpuset-cpus=0-5 --memory=2g --memory-swap=2g --network=host)

stop() {
  docker rm -f "$name" >/dev/null 2>&1 || true
  docker volume rm -f "$vol" >/dev/null 2>&1 || true
}
trap stop EXIT

start() {
  case "$1" in
    celeris)
      # sync=always is the default; it is spelled out because it is the point.
      docker run -d --name "$name" "${limits[@]}" -u 0 -v "$vol:/data" \
        -e CELERIS_HTTP_LISTEN=127.0.0.1:8080 -e CELERIS_DATA_DIR=/data -e CELERIS_SYNC=always \
        celeris:bench start ;;
    postgres)
      # fsync=on, synchronous_commit=on and full_page_writes=on are defaults.
      docker run -d --name "$name" "${limits[@]}" -v "$vol:/var/lib/postgresql/data" \
        -e POSTGRES_USER=bench -e POSTGRES_PASSWORD=bench -e POSTGRES_DB=bench \
        postgres:17.2 -c listen_addresses=127.0.0.1 -c shared_buffers=512MB -c max_connections=300 ;;
    mysql)
      # innodb_flush_log_at_trx_commit=1 and sync_binlog=1 are defaults.
      docker run -d --name "$name" "${limits[@]}" -v "$vol:/var/lib/mysql" \
        -e MYSQL_ROOT_PASSWORD=bench -e MYSQL_DATABASE=bench \
        mysql:8.4.3 --bind-address=127.0.0.1 --mysqlx-bind-address=127.0.0.1 --innodb-buffer-pool-size=512M --max-connections=300 ;;
    mongodb)
      docker run -d --name "$name" "${limits[@]}" -v "$vol:/data/db" \
        mongo:8.0.4 --bind_ip 127.0.0.1 --wiredTigerCacheSizeGB=0.5 ;;
    redis)
      # appendfsync always: every write reaches disk before the reply.
      docker run -d --name "$name" "${limits[@]}" -v "$vol:/data" \
        redis:7.4.2 --bind 127.0.0.1 --appendonly yes --appendfsync always --save "" ;;
    etcd)
      # Compaction keeps MVCC history from filling the backend during the run.
      docker run -d --name "$name" "${limits[@]}" -v "$vol:/data" \
        gcr.io/etcd-development/etcd:v3.5.17 /usr/local/bin/etcd --data-dir=/data/etcd \
        --quota-backend-bytes=4294967296 --auto-compaction-mode=revision --auto-compaction-retention=10000 ;;
    cockroachdb)
      docker run -d --name "$name" "${limits[@]}" -v "$vol:/cockroach/cockroach-data" \
        cockroachdb/cockroach:v24.2.5 start-single-node --insecure --listen-addr=127.0.0.1:26257 --http-addr=127.0.0.1:8081 --cache=512MiB --max-sql-memory=512MiB ;;
    cassandra)
      # The default commitlog_sync is periodic (acknowledges before fsync), so
      # it is changed to batch to give the same durability as everyone else.
      docker run -d --name "$name" "${limits[@]}" -v "$vol:/var/lib/cassandra" \
        -e MAX_HEAP_SIZE=1G -e HEAP_NEWSIZE=200M -e CASSANDRA_LISTEN_ADDRESS=127.0.0.1 \
        -e CASSANDRA_BROADCAST_ADDRESS=127.0.0.1 -e CASSANDRA_RPC_ADDRESS=127.0.0.1 -e CASSANDRA_SEEDS=127.0.0.1 --entrypoint sh cassandra:5.0.2 -c \
        "sed -i 's/^commitlog_sync: .*/commitlog_sync: batch/; /^commitlog_sync_period/d' /etc/cassandra/cassandra.yaml; exec docker-entrypoint.sh cassandra -f" ;;
    *) echo "unknown system $1" >&2; exit 2 ;;
  esac >/dev/null
}

mkdir -p "$(dirname "$out")"
for ((rep = 1; rep <= reps; rep++)); do
  for s in $systems; do
    stop
    start "$s"
    taskset -c 6-9 "$harness" -system "$s" -keys "$keys" -cells "$cells" \
      -warmup "$warmup" -duration "$duration" -rep "$rep" -out "$out"
    docker stats --no-stream --format "$s rep=$rep mem={{.MemUsage}}" "$name"
    stop
  done
done
