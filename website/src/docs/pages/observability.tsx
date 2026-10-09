import { Callout, Code, DocLink, H2, H3, OsCode, Table } from "../kit";
import type { DocPage } from "../kit";

function Body() {
  return (
    <>
      <p>
        A CelerisDB node exposes four HTTP endpoints for monitoring, writes structured logs to standard error, and ships a
        few CLI commands that summarize health. This page lists them, gives a ready Prometheus and Grafana setup, and shows
        alert rules you can adapt. Everything named here exists in the product today; where something you might expect (a
        Raft leader-change counter, a conflict counter) is not exported, the page says so and shows a workaround.
      </p>

      <H2 id="endpoints">Health and status endpoints</H2>
      <Table
        head={["Endpoint", "Auth", "Use it for"]}
        rows={[
          [<code key="h">GET /health</code>, "Open", "Liveness. Returns status ok and the node ID whenever the process is serving HTTP."],
          [<code key="r">GET /ready</code>, "Open", "Readiness. 200 when the node accepts writes, 503 with status read_only (and a reason) after a WAL failure."],
          [<code key="s">GET /v1/status</code>, "read scope when tokens are on", "Node, cluster, partition, storage, index and recovery state."],
          [<code key="m">GET /metrics</code>, "Open", "Prometheus text format."],
        ]}
      />
      <p>
        <code>/health</code>, <code>/ready</code> and <code>/metrics</code> stay open even when API tokens are configured, so
        load balancers and Prometheus can reach them without a secret. They carry no user data. Use <code>/health</code> for
        a process liveness probe and <code>/ready</code> for load balancer and orchestrator readiness probes, so a node that
        went read-only after a disk fault is taken out of rotation.
      </p>
      <OsCode
        unix={`curl -s http://127.0.0.1:8080/health
curl -s -o /dev/null -w "%{http_code}\\n" http://127.0.0.1:8080/ready
curl -s http://127.0.0.1:8080/v1/status`}
        windows={`curl.exe -s http://127.0.0.1:8080/health
curl.exe -s -o NUL -w "%{http_code}\`n" http://127.0.0.1:8080/ready
curl.exe -s http://127.0.0.1:8080/v1/status`}
        title="Probe a node"
      />
      <H3 id="status-fields">What /v1/status contains</H3>
      <Table
        head={["Field", "Meaning"]}
        rows={[
          [<code key="a">health</code>, "healthy, or read_only after a WAL failure"],
          [<code key="b">uptime_secs, version, node_id</code>, "Identity and uptime"],
          [<code key="c">cluster.mode, cluster.nodes[]</code>, "single-node or gossip; each node has id, address, zone and state (alive, suspect, unreachable, left)"],
          [<code key="d">partitions</code>, "Partition count, map epoch and replication factor"],
          [<code key="e">control.raft</code>, "Control-plane role, term, leader and commit index (voters only)"],
          [<code key="f">control.migrations, control.anti_entropy</code>, "Partition moves in progress by phase, and replica consistency checks"],
          [<code key="g">storage</code>, "Last version, memtable bytes, immutable memtables, level 0 and level 1 table counts, table bytes, read-only reason, last background error, recovery report"],
          [<code key="h">indexes</code>, "Each secondary index and its state (building, ready, dropping)"],
        ]}
      />

      <H2 id="metrics">Metrics reference</H2>
      <p>
        Metrics are served at <code>/metrics</code> in Prometheus text format. Counters only go up and reset when the process
        restarts, so always query them with <code>rate()</code> or <code>increase()</code>.
      </p>
      <H3 id="metrics-http">Requests</H3>
      <Table
        head={["Metric", "Type", "Meaning"]}
        rows={[
          [<code key="a">celeris_http_requests_total&#123;route,method,status&#125;</code>, "counter", "Requests by route, method and HTTP status."],
          [<code key="b">celeris_http_request_duration_seconds&#123;route,method&#125;</code>, "histogram", "Request latency. Buckets (seconds): 0.0005, 0.001, 0.0025, 0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, +Inf."],
          [<code key="c">celeris_operations_by_consistency_total&#123;mode,kind&#125;</code>, "counter", "Client operations by requested consistency mode and kind (read or write)."],
        ]}
      />
      <H3 id="metrics-storage">Storage counters</H3>
      <p>
        Each is exposed as <code>celeris_storage_&lt;name&gt;_total</code>.
      </p>
      <Table
        head={["Name", "Meaning"]}
        rows={[
          [<code key="a">write_batches</code>, "Batches committed to the write-ahead log"],
          [<code key="b">write_ops</code>, "Individual put and delete operations committed"],
          [<code key="c">wal_bytes</code>, "Bytes appended to the write-ahead log, including framing"],
          [<code key="d">wal_syncs</code>, "Disk flushes performed on the write path"],
          [<code key="e">wal_failures</code>, "Log append or flush failures. Each one makes the node read-only"],
          [<code key="f">dedup_hits</code>, "Writes answered from the mutation-ID table (safe client retries)"],
          [<code key="g">condition_failures</code>, "Conditional writes rejected (if_version or if_absent did not hold)"],
          [<code key="h">reads, read_hits</code>, "Point reads, and those that found a live value"],
          [<code key="i">bloom_negatives</code>, "Table lookups skipped because the bloom filter ruled the key out"],
          [<code key="j">block_cache_hits, block_cache_misses</code>, "Block cache effectiveness"],
          [<code key="k">flushes, flush_bytes</code>, "Memtable flushes to disk and their size"],
          [<code key="l">compactions, compaction_bytes_in, compaction_bytes_out</code>, "Compactions and the bytes they read and wrote"],
          [<code key="m">tombstones_purged</code>, "Deleted or expired entries dropped after the retention period"],
          [<code key="n">write_stalls</code>, "Writes that had to wait for an inline flush"],
          [<code key="o">background_errors</code>, "Failed background flush or compaction attempts"],
        ]}
      />
      <H3 id="metrics-gauges">Gauges</H3>
      <Table
        head={["Metric", "Meaning"]}
        rows={[
          [<code key="a">celeris_storage_last_version</code>, "Highest committed sequence number"],
          [<code key="b">celeris_storage_memtable_bytes</code>, "Approximate bytes in the active in-memory write buffer"],
          [<code key="c">celeris_storage_immutable_memtables</code>, "Buffers waiting to be flushed"],
          [<code key="d">celeris_storage_l0_tables, celeris_storage_l1_tables</code>, "Tables in level 0 and level 1"],
          [<code key="e">celeris_storage_table_bytes</code>, "Bytes in live tables"],
          [<code key="f">celeris_storage_read_only</code>, "1 if a WAL failure made the node read-only"],
          [<code key="g">celeris_node_info&#123;node_id,version&#125;</code>, "Always 1; carries identity as labels"],
          [<code key="h">celeris_uptime_seconds</code>, "Seconds since the node started"],
          [<code key="i">celeris_cluster_members&#123;state&#125;</code>, "Members in this node's view by state (alive, suspect, unreachable, left). Present only in cluster mode"],
          [<code key="j">celeris_cluster_view_epoch</code>, "Counter of changes to this node's membership view. Present only in cluster mode"],
        ]}
      />
      <Callout kind="note" title="Not exported as metrics">
        <p>
          There is no counter for Raft leader elections and none for recorded <code>available</code>-mode conflicts. Use{" "}
          <code>celeris_cluster_members</code> and <code>celeris_cluster_view_epoch</code> for membership churn, the log
          warnings and the polling recipes below for the rest.
        </p>
      </Callout>

      <H2 id="prometheus">Prometheus scrape configuration</H2>
      <p>
        Scrape every node, not a load balancer, so you see each node&apos;s own storage state. The port is the HTTP API port
        (8080 by default); do not scrape the cluster port.
      </p>
      <Code lang="yaml" title="prometheus.yml">{`global:
  scrape_interval: 15s

rule_files:
  - celeris-alerts.yml

scrape_configs:
  - job_name: celeris
    metrics_path: /metrics
    static_configs:
      - targets:
          - node-a.example.internal:8080
          - node-b.example.internal:8080
          - node-c.example.internal:8080

  # If the API is served over HTTPS with a private CA:
  # - job_name: celeris-tls
  #   scheme: https
  #   tls_config:
  #     ca_file: /etc/prometheus/celeris-ca.pem
  #   static_configs:
  #     - targets: ["node-a.example.internal:8080"]`}</Code>
      <p>
        On Kubernetes with the provided StatefulSet, each pod is reachable at{" "}
        <code>celeris-N.celeris-peers.&lt;namespace&gt;.svc.cluster.local:8080</code>. List the three pods as static targets or
        use your Prometheus Operator&apos;s pod discovery with the pod port 8080.
      </p>
      <OsCode
        linux={`# quick check that the endpoint parses
curl -s http://127.0.0.1:8080/metrics | head -20
promtool check config prometheus.yml`}
        macos={`curl -s http://127.0.0.1:8080/metrics | head -20
promtool check config prometheus.yml`}
        windows={`curl.exe -s http://127.0.0.1:8080/metrics | Select-Object -First 20
promtool.exe check config prometheus.yml`}
        title="Check the endpoint and config"
      />

      <H2 id="grafana">Grafana panels</H2>
      <p>These PromQL queries use only the metrics listed above. Add a template variable for the instance label to filter by node.</p>
      <Table
        head={["Panel", "PromQL"]}
        rows={[
          ["Request rate", <code key="a">sum by (instance) (rate(celeris_http_requests_total[5m]))</code>],
          ["Error ratio (5xx)", <code key="b">sum(rate(celeris_http_requests_total&#123;status=~"5.."&#125;[5m])) / sum(rate(celeris_http_requests_total[5m]))</code>],
          ["p99 latency", <code key="c">histogram_quantile(0.99, sum by (le) (rate(celeris_http_request_duration_seconds_bucket[5m])))</code>],
          ["p50 latency by route", <code key="d">histogram_quantile(0.5, sum by (le, route) (rate(celeris_http_request_duration_seconds_bucket[5m])))</code>],
          ["Operations by consistency", <code key="e">sum by (mode, kind) (rate(celeris_operations_by_consistency_total[5m]))</code>],
          ["Writes per flush (group commit)", <code key="f">rate(celeris_storage_write_batches_total[5m]) / rate(celeris_storage_wal_syncs_total[5m])</code>],
          ["Block cache hit ratio", <code key="g">rate(celeris_storage_block_cache_hits_total[5m]) / (rate(celeris_storage_block_cache_hits_total[5m]) + rate(celeris_storage_block_cache_misses_total[5m]))</code>],
          ["Compaction write rate", <code key="h">rate(celeris_storage_compaction_bytes_out_total[5m])</code>],
          ["Stored table bytes", <code key="i">celeris_storage_table_bytes</code>],
          ["Level 0 tables", <code key="j">celeris_storage_l0_tables</code>],
          ["Write stalls per second", <code key="k">rate(celeris_storage_write_stalls_total[5m])</code>],
          ["Cluster members not alive", <code key="l">sum by (state) (celeris_cluster_members&#123;state!="alive"&#125;)</code>],
          ["Read-only nodes", <code key="m">celeris_storage_read_only == 1</code>],
        ]}
      />
      <p>
        The <em>writes per flush</em> panel is a direct view of group commit: a value above 1 means several writes shared each
        disk flush. See <DocLink to="performance:group-commit">Performance</DocLink>.
      </p>

      <H2 id="alerts">Alert rules</H2>
      <p>
        Start with these and tune the thresholds and durations to your traffic. The rules are examples, so check them
        against your own baseline before paging anyone.
      </p>
      <Code lang="yaml" title="celeris-alerts.yml">{`groups:
  - name: celeris
    rules:
      - alert: CelerisNodeDown
        expr: up{job="celeris"} == 0
        for: 1m
        labels: { severity: page }
        annotations:
          summary: "CelerisDB node {{ $labels.instance }} is not scrapeable"

      - alert: CelerisNotReady
        # Mirrors GET /ready returning 503 (read-only after a WAL failure)
        expr: celeris_storage_read_only == 1
        for: 0m
        labels: { severity: page }
        annotations:
          summary: "{{ $labels.instance }} is read-only after a WAL failure; restart after fixing the disk"

      - alert: CelerisWalFailure
        expr: increase(celeris_storage_wal_failures_total[10m]) > 0
        labels: { severity: page }
        annotations:
          summary: "WAL append or flush failed on {{ $labels.instance }}"

      - alert: CelerisBackgroundErrors
        expr: increase(celeris_storage_background_errors_total[15m]) > 0
        labels: { severity: ticket }
        annotations:
          summary: "Background flush or compaction is failing on {{ $labels.instance }}"

      - alert: CelerisWriteStalls
        expr: rate(celeris_storage_write_stalls_total[5m]) > 0
        for: 10m
        labels: { severity: ticket }
        annotations:
          summary: "Writes on {{ $labels.instance }} keep waiting for inline flushes"

      - alert: CelerisFlushBacklog
        expr: celeris_storage_immutable_memtables > 0
        for: 10m
        labels: { severity: ticket }
        annotations:
          summary: "Memtables are not draining on {{ $labels.instance }}"

      - alert: CelerisMemberUnhealthy
        expr: max(celeris_cluster_members{state=~"suspect|unreachable"}) > 0
        for: 2m
        labels: { severity: page }
        annotations:
          summary: "A cluster member is suspect or unreachable"

      - alert: CelerisMembershipChurn
        # Proxy for leader instability: the membership view keeps changing.
        # Tune the count to your cluster; there is no Raft election counter.
        expr: increase(celeris_cluster_view_epoch[15m]) > 6
        labels: { severity: ticket }
        annotations:
          summary: "Cluster membership view is flapping on {{ $labels.instance }}"

      - alert: CelerisServerErrors
        expr: sum(rate(celeris_http_requests_total{status=~"5.."}[5m])) / sum(rate(celeris_http_requests_total[5m])) > 0.01
        for: 5m
        labels: { severity: page }
        annotations:
          summary: "More than 1% of requests are failing with 5xx"

      - alert: CelerisHighP99
        expr: histogram_quantile(0.99, sum by (le) (rate(celeris_http_request_duration_seconds_bucket[5m]))) > 0.1
        for: 10m
        labels: { severity: ticket }
        annotations:
          summary: "p99 request latency above 100 ms"

      - alert: CelerisRedirectStorm
        # 421 = not_leader / not_owner; sustained volume means clients are mis-routing
        expr: sum(rate(celeris_http_requests_total{status="421"}[5m])) > 1
        for: 10m
        labels: { severity: ticket }
        annotations:
          summary: "Many requests are being redirected (421)"`}</Code>
      <Callout kind="tip">
        <p>
          Also alert on free disk space with whatever host-level exporter you already run (for example node_exporter&apos;s
          filesystem metrics). CelerisDB reports table bytes but not the free space of the volume.
        </p>
      </Callout>

      <H3 id="polling">Polling for leader changes and conflicts</H3>
      <p>
        Two signals have no metric. For control-plane leadership, <code>/v1/status</code> reports{" "}
        <code>control.raft.term</code> and <code>control.raft.leader</code>; a term that keeps rising means elections keep
        happening. For recorded last-writer-wins conflicts from <code>available</code> writes,{" "}
        <code>GET /v1/conflicts</code> lists them (and needs a read-scoped token when authentication is on).
      </p>
      <OsCode
        unix={`# control-plane term and leader (requires jq)
curl -s http://127.0.0.1:8080/v1/status | jq '.control.raft | {role, term, leader}'

# how many conflicts are recorded
curl -s "http://127.0.0.1:8080/v1/conflicts?limit=1000" | jq '.conflicts | length'`}
        windows={`# control-plane term and leader
(curl.exe -s http://127.0.0.1:8080/v1/status | ConvertFrom-Json).control.raft

# how many conflicts are recorded
(curl.exe -s "http://127.0.0.1:8080/v1/conflicts?limit=1000" | ConvertFrom-Json).conflicts.Count`}
        title="Poll status and conflicts"
      />

      <H2 id="logs">Logs</H2>
      <p>
        Logs go to standard error; only the <code>listening on</code> banner goes to standard output. Choose the format and
        level in <code>celeris.toml</code> or with environment variables:
      </p>
      <Table
        head={["Setting", "Env var", "Values"]}
        rows={[
          [<code key="a">log.format</code>, <code key="b">CELERIS_LOG_FORMAT</code>, "pretty (default) or json"],
          [<code key="c">log.level</code>, <code key="d">CELERIS_LOG_LEVEL</code>, "A level such as info, or a filter. RUST_LOG, when set, takes precedence"],
        ]}
      />
      <p>
        Use <code>json</code> in production so a log shipper can index fields. Useful messages to alert or search on include{" "}
        <code>cluster member state changed</code> (logged at warn when a peer becomes suspect or unreachable),{" "}
        <code>refuted suspicion about this node</code>, <code>write outcome unknown</code> (logged at error with the
        mutation ID), <code>could not open replication group</code> and <code>partition migrations changed</code>.
      </p>
      <Callout kind="note">
        <p>
          JSON lines follow the standard tracing layout (a <code>level</code>, a <code>timestamp</code> and a{" "}
          <code>fields</code> object holding the message and key-value fields). Look at one line of your own output before you
          write queries against it.
        </p>
      </Callout>
      <H3 id="log-locations">Where the logs end up, per OS</H3>
      <p>
        The node does not write log files itself, so the location depends on how you run it.
      </p>
      <OsCode
        linux={`# systemd (unit named celeris)
journalctl -u celeris -f
journalctl -u celeris --since "1 hour ago" -o cat | grep -i warn

# Docker / Compose / Kubernetes
docker logs -f <container>
docker compose logs -f node-a
kubectl logs -f celeris-0

# foreground, to a file
CELERIS_LOG_FORMAT=json celeris start --config celeris.toml 2>> celeris.log
tail -f celeris.log | jq -c 'select(.level=="WARN" or .level=="ERROR")'`}
        macos={`# foreground, to a file
CELERIS_LOG_FORMAT=json celeris start --config celeris.toml 2>> celeris.log
tail -f celeris.log | jq -c 'select(.level=="WARN" or .level=="ERROR")'

# Docker / Kubernetes
docker logs -f <container>
kubectl logs -f celeris-0

# launchd: set StandardErrorPath in the job plist, then tail that file`}
        windows={`# foreground, to a file (cmd handles the stderr redirect cleanly)
cmd /c "set CELERIS_LOG_FORMAT=json&& celeris start --config celeris.toml 2>> celeris.log"

# follow the file
Get-Content celeris.log -Wait -Tail 50

# only warnings and errors from JSON logs
Get-Content celeris.log | ForEach-Object { $_ | ConvertFrom-Json } | Where-Object { $_.level -in "WARN","ERROR" }

# Docker Desktop
docker logs -f <container>`}
        title="Read and follow logs"
      />

      <H2 id="cli">Operating with the CLI</H2>
      <Table
        head={["Command", "What it tells you"]}
        rows={[
          [<code key="a">celeris status</code>, "Node health, uptime, storage state, cluster view, Raft role, migrations and anti-entropy"],
          [<code key="b">celeris doctor</code>, "Checks the config file, data directory, storage lock, listen port and, if a node is running, its health and readiness"],
          [<code key="c">celeris partitions [--key K]</code>, "The partition map summary, or the partition, epoch and replicas for one key"],
          [<code key="d">celeris node list / cluster status</code>, "Members and their states"],
          [<code key="e">celeris conflicts list</code>, "Recorded last-writer-wins conflicts"],
          [<code key="f">celeris --json status</code>, "The raw JSON of /v1/status, for scripts"],
        ]}
      />
      <Code lang="text" title="celeris doctor (shape of the output)">{`[info] platform: <os> <arch> (celeris <version>)
[ ok ] config: celeris.toml
[ ok ] data directory: <path> is writable
[ ok ] storage: not in use by another process
[ ok ] listen address: 127.0.0.1:8080 is available
[ ok ] node: <id> reachable at http://127.0.0.1:8080
[ ok ] readiness: accepting writes`}</Code>
      <p>
        <code>doctor</code> prints <code>[FAIL]</code> for a problem and exits non-zero, so it works in provisioning scripts.
        When a node is already running, the listen and lock checks report that the port or storage is in use, which is
        expected. See <DocLink to="troubleshooting">Troubleshooting</DocLink> for what to do with a failure.
      </p>

      <H2 id="tracing">Tracing a request by mutation ID</H2>
      <p>
        Every write has a mutation ID: the one your client sent in the <code>celeris-mutation-id</code> header, or one the
        server generated and returned in the same response header. It is your trace key.
      </p>
      <ol>
        <li>
          Log the ID on the client side next to your own request ID.
        </li>
        <li>
          Ask any node what happened: <code>celeris mutation &lt;uuid&gt;</code> or <code>GET /v1/mutations/&#123;id&#125;</code>.
          The answer is <code>committed</code> with a version, or unknown (it did not commit, is still in flight, or is older
          than <code>mutation_retention_secs</code>, 24 hours by default).
        </li>
        <li>
          Search the node logs for the ID: an unknown outcome is logged at error level with the <code>mutation_id</code>{" "}
          field.
        </li>
        <li>
          A <code>dedup_hits</code> increase (<code>celeris_storage_dedup_hits_total</code>) shows that a retry was recognized
          and not applied twice.
        </li>
      </ol>
      <OsCode
        unix={`celeris mutation 5d0c1c2e-0000-4000-8000-000000000000
curl -s http://127.0.0.1:8080/v1/mutations/5d0c1c2e-0000-4000-8000-000000000000`}
        windows={`celeris mutation 5d0c1c2e-0000-4000-8000-000000000000
curl.exe -s http://127.0.0.1:8080/v1/mutations/5d0c1c2e-0000-4000-8000-000000000000`}
        title="Did this write commit?"
      />
      <p>
        Replace the example UUID with a real one. The CLI exits with code 3 when a write outcome is unknown and prints the ID to
        use here.
      </p>

      <H2 id="next">Next steps</H2>
      <ul>
        <li>
          <DocLink to="troubleshooting">Troubleshooting</DocLink> for symptom-by-symptom diagnosis.
        </li>
        <li>
          <DocLink to="performance">Performance tuning</DocLink> to act on what the dashboards show.
        </li>
        <li>
          <DocLink to="production-checklist">Production checklist</DocLink> for the monitoring items.
        </li>
      </ul>
    </>
  );
}

export const page: DocPage = {
  slug: "observability",
  title: "Observability",
  group: "Operate",
  summary: "Health endpoints, Prometheus metrics, Grafana queries, alert rules, logs and CLI diagnostics.",
  keywords: ["monitoring", "metrics", "prometheus", "grafana", "alerts", "logging", "json logs", "health check", "readiness", "tracing", "mutation id", "doctor", "status"],
  Body,
};
