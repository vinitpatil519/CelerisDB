import { Badge, Callout, Code, DocLink, H2, H3, Table, type DocPage } from "../kit";
import { FilterTable, type FilterRow } from "../demos/RefFilter";

type Retry = "never" | "fix" | "same" | "route" | "check";

const RETRY_LABEL: Record<Retry, string> = {
  never: "No",
  fix: "After fixing the request",
  same: "Yes, same mutation ID",
  route: "Yes, at the node named in the error",
  check: "Check the mutation first",
};

interface Row {
  code: string;
  http: string;
  /** Outcome the server reports on a write endpoint. */
  outcome: "not_applied" | "unknown" | "n/a";
  retry: Retry;
  meaning: string;
  action: string;
  group: string;
}

const ROWS: Row[] = [
  // Input
  { code: "invalid_json", http: "400 (also 413, 415, 422)", outcome: "not_applied", retry: "fix", group: "Input", meaning: "The body is not one valid JSON document, a JSON field is unknown or has the wrong type, or the endpoint was called without a JSON content type (415) or with an oversized body (413).", action: "Fix the body. For batch, query and rebalance add content-type: application/json." },
  { code: "invalid_key", http: "400", outcome: "not_applied", retry: "fix", group: "Input", meaning: "The key is empty, longer than 1024 bytes, not UTF-8, or starts with %00.", action: "Use a valid key. Keys with . or .. path segments cannot be addressed over HTTP." },
  { code: "invalid_argument", http: "400", outcome: "not_applied", retry: "fix", group: "Input", meaning: "A parameter is out of range or inconsistent: limit outside 1-1000, max_scanned outside 1-100000, bounded without max_staleness_ms (or the reverse), if_version with if_absent, prefix with start/end, an empty batch, a malformed celeris-partition-epoch or celeris-session-index, or a replication factor the cluster cannot place.", action: "Read the message; it names the parameter." },
  { code: "invalid_query", http: "400", outcome: "n/a", retry: "fix", group: "Input", meaning: "The query string has an unknown parameter or a value of the wrong type.", action: "Check parameter names and types against the HTTP API reference." },
  { code: "invalid_path", http: "400", outcome: "n/a", retry: "fix", group: "Input", meaning: "The URL path could not be decoded.", action: "Percent-encode the key correctly." },
  { code: "invalid_consistency", http: "400", outcome: "not_applied", retry: "fix", group: "Input", meaning: "Unknown mode, or bounded used on a write.", action: "Use strict, session, available or eventual for writes; add bounded for reads." },
  { code: "invalid_mutation_id", http: "400", outcome: "not_applied", retry: "fix", group: "Input", meaning: "celeris-mutation-id (or the batch mutation_id) is not a UUID.", action: "Send a UUID, such as one from crypto.randomUUID()." },
  { code: "invalid_filter", http: "400", outcome: "n/a", retry: "fix", group: "Input", meaning: "The where filter is malformed, uses an unknown operator, or exceeds 256 conditions or 16 levels.", action: "Fix the filter. See Queries." },
  { code: "sort_unavailable", http: "400", outcome: "n/a", retry: "fix", group: "Input", meaning: "No ready index on the sort field with the requested order covers the query range.", action: "Declare the index, wait until it is ready in /v1/status, or drop the sort." },
  { code: "conditions_require_strict", http: "400", outcome: "not_applied", retry: "fix", group: "Input", meaning: "if_version or if_absent used with an available or eventual write in a replicated cluster.", action: "Use strict for conditional writes." },
  { code: "cross_group_batch", http: "400", outcome: "not_applied", retry: "fix", group: "Input", meaning: "The keys of a batch belong to different replica sets, so the batch cannot be atomic.", action: "Split the batch, or design keys so related data shares a replica set." },
  { code: "websocket_required", http: "400", outcome: "n/a", retry: "fix", group: "Input", meaning: "/v1/watch was called without a WebSocket upgrade.", action: "Open it with a WebSocket client." },
  // Auth
  { code: "unauthorized", http: "401", outcome: "n/a", retry: "fix", group: "Access", meaning: "Tokens are configured and the request had none, or an unknown one. The response has WWW-Authenticate: Bearer.", action: "Send Authorization: Bearer <token>. Nothing was applied." },
  { code: "forbidden", http: "403", outcome: "n/a", retry: "fix", group: "Access", meaning: "The token lacks the needed scope, or an admin endpoint was called from a non-loopback address on a node without tokens.", action: "Use a token with the right scope (read, write, admin), or call admin endpoints from the node's host." },
  // Not found / conditions
  { code: "not_found", http: "404", outcome: "n/a", retry: "never", group: "Data", meaning: "The key is absent, deleted or expired.", action: "A normal answer, not a fault. SDKs typically return null or an empty value." },
  { code: "condition_failed", http: "409", outcome: "not_applied", retry: "fix", group: "Data", meaning: "if_version or if_absent did not hold. The error carries current_version (null if the key is absent).", action: "Re-read, recompute, and retry with the new version. This is optimistic concurrency working as designed." },
  { code: "mutation_id_reused", http: "422", outcome: "not_applied", retry: "fix", group: "Data", meaning: "The same mutation ID was sent with a different payload.", action: "Generate a new ID per distinct write; reuse an ID only to retry the identical request." },
  // Routing
  { code: "not_owner", http: "421", outcome: "not_applied", retry: "route", group: "Routing", meaning: "This node does not lead (or hold a replica of) the key's partition. Hints: partition, partition_epoch, map_epoch, replicas, leader.", action: "Send the request to the leader named in the hints. SDKs do this automatically." },
  { code: "not_leader", http: "421", outcome: "not_applied", retry: "route", group: "Routing", meaning: "This replica is not the leader of the key's replica set, or no leader is known yet. Hints: leader (may be null), replicas.", action: "Retry at the named leader; if leader is null, wait briefly and retry." },
  { code: "partition_moved", http: "421", outcome: "n/a", retry: "route", group: "Routing", meaning: "This replica set has handed the partition to new replicas. Hint: replicas.", action: "Refresh routing (GET /v1/partitions/key/{key}) and retry there." },
  { code: "stale_epoch", http: "409", outcome: "not_applied", retry: "route", group: "Routing", meaning: "You sent celeris-partition-epoch older than the partition's epoch: your routing table is out of date.", action: "Refresh routing and retry with the new epoch." },
  { code: "epoch_ahead", http: "503", outcome: "not_applied", retry: "same", group: "Routing", meaning: "Your epoch is newer than this node's map: the node is behind.", action: "Retry shortly, or at another node." },
  // Transient cluster
  { code: "no_partition_map", http: "503", outcome: "not_applied", retry: "same", group: "Cluster", meaning: "The control plane has not committed a partition map yet (a new cluster that has not finished forming).", action: "Wait for every voter to be up. With replication_factor = 0, run celeris cluster rebalance --rf N once." },
  { code: "partition_moving", http: "503", outcome: "not_applied", retry: "same", group: "Cluster", meaning: "The partition's data is being moved to new replicas. The write was not applied.", action: "Retry shortly with the same mutation ID." },
  { code: "proposal_lost", http: "503", outcome: "not_applied", retry: "same", group: "Cluster", meaning: "Leadership changed before the write committed. It was not applied.", action: "Retry with the same mutation ID." },
  { code: "replica_failed", http: "503", outcome: "not_applied", retry: "same", group: "Cluster", meaning: "The replica set's local replication state could not take the request.", action: "Retry; if it persists check the node logs and /v1/status." },
  { code: "session_behind", http: "503", outcome: "n/a", retry: "same", group: "Cluster", meaning: "A session read reached a replica that has not applied your last write yet. Hints: applied_index, required_index, leader.", action: "Retry shortly, or read from the leader (strict)." },
  { code: "read_retry", http: "503", outcome: "n/a", retry: "same", group: "Cluster", meaning: "Leadership changed during a strict or bounded read.", action: "Retry." },
  { code: "read_timeout", http: "503", outcome: "n/a", retry: "same", group: "Cluster", meaning: "The leader could not confirm with a majority in time. Usually a lost quorum or a network partition.", action: "Retry with backoff; check cluster health. Use session or eventual if you can tolerate staleness." },
  { code: "scan_incomplete", http: "503", outcome: "n/a", retry: "same", group: "Cluster", meaning: "A strict scan could not read every replica set through its leader. The error lists the failures.", action: "Retry, or accept partial results with consistency=eventual." },
  { code: "query_incomplete", http: "503", outcome: "n/a", retry: "same", group: "Cluster", meaning: "As scan_incomplete, for queries.", action: "Retry, or accept partial results with consistency=eventual." },
  { code: "not_confirmed", http: "503", outcome: "n/a", retry: "same", group: "Cluster", meaning: "Clearing conflicts was not confirmed in time.", action: "Retry; the operation is idempotent." },
  // Admin
  { code: "no_control_plane", http: "409", outcome: "n/a", retry: "fix", group: "Admin", meaning: "A rebalance was sent to a node that is not a control-plane voter.", action: "Send it to a node listed in cluster.voters." },
  { code: "migrations_pending", http: "409", outcome: "n/a", retry: "same", group: "Admin", meaning: "The previous rebalance is still moving data. Detail: migrations (count).", action: "Wait; watch control.migrations in /v1/status." },
  { code: "not_supported", http: "501", outcome: "n/a", retry: "never", group: "Admin", meaning: "Physical backup was requested on a replicated cluster.", action: "Use celeris export / import there." },
  // Server
  { code: "outcome_unknown", http: "500", outcome: "unknown", retry: "check", group: "Server", meaning: "The node could not confirm durability, or the write was not confirmed in time. The write may have committed.", action: "Retry with the same mutation ID, or ask GET /v1/mutations/{id}. Never assume failure." },
  { code: "read_only", http: "503", outcome: "not_applied", retry: "never", group: "Server", meaning: "The node refuses writes after a storage failure (for example a durability error). Reads still work. /ready returns 503.", action: "Do not retry here. Fix the disk or filesystem problem and restart the node, or send writes to another node that owns the data." },
  { code: "corruption", http: "500", outcome: "not_applied", retry: "never", group: "Server", meaning: "The node detected damaged stored data.", action: "Stop and investigate; restore from a backup or rebuild the node from its replicas." },
  { code: "internal", http: "500", outcome: "not_applied", retry: "same", group: "Server", meaning: "An unexpected server-side fault (also logged by the node).", action: "Retry once with backoff; if it repeats, check the node log and report it." },
];

const OUTCOME_TONE: Record<Row["outcome"], "ok" | "warn" | "neutral"> = {
  not_applied: "ok",
  unknown: "warn",
  "n/a": "neutral",
};

function toRows(rows: Row[]): FilterRow[] {
  return rows.map((r) => ({
    search: [r.code, r.http, r.outcome, RETRY_LABEL[r.retry], r.meaning, r.action, r.group].join(" "),
    cells: [
      <code key="c">{r.code}</code>,
      r.http,
      r.outcome === "n/a" ? <span className="faint" key="o">read / none</span> : <Badge key="o" tone={OUTCOME_TONE[r.outcome]}>{r.outcome}</Badge>,
      RETRY_LABEL[r.retry],
      <span key="m">
        {r.meaning} <em>{r.action}</em>
      </span>,
    ],
  }));
}

function Body() {
  return (
    <>
      <p>
        Every error response has the same shape. A client needs two things from it: the <code>code</code> to decide what to do, and, for writes, the{" "}
        <code>outcome</code> to know whether the data changed.
      </p>
      <Code lang="json">{`{"error": {"code": "condition_failed", "message": "...",
           "outcome": "not_applied", "mutation_id": "5d0c...", "current_version": 7}}`}</Code>
      <Table
        head={["Field", "Present", "Meaning"]}
        rows={[
          [<code key="f">code</code>, "always", "Stable machine-readable identifier. Branch on this, never on message."],
          [<code key="f">message</code>, "always", "Human-readable detail. Wording may change."],
          [<code key="f">outcome</code>, "write endpoints", "not_applied or unknown. See below."],
          [<code key="f">mutation_id</code>, "write errors from the storage layer", "The ID to reuse for a retry or to look up."],
          [<code key="f">current_version</code>, "condition_failed", "The key's version now, or null if absent."],
          ["routing hints", "421, some 409 and 503", <><code>partition</code>, <code>partition_epoch</code>, <code>map_epoch</code>, <code>replicas</code>, <code>leader</code>, <code>applied_index</code>, <code>required_index</code>, <code>errors</code>, <code>migrations</code>, depending on the code.</>],
        ]}
      />

      <H2 id="outcome">Did my write apply?</H2>
      <p>
        A write ends in exactly one of three ways. The server tells you which on the success path and on every write error, so you never have to guess.
      </p>
      <Table
        head={["Classification", "How you see it", "Meaning", "What to do"]}
        rows={[
          [<Badge key="b" tone="ok">applied</Badge>, <>HTTP 200 (or 202 for an accepted available write). <code>deduplicated: true</code> means a retry found it already committed.</>, "The write is durable on the replicas the mode requires.", "Done. Use the returned version."],
          [<Badge key="b" tone="ok">not_applied</Badge>, <><code>outcome: &quot;not_applied&quot;</code></>, "Nothing was written. Safe to treat as a failure.", "Fix the request, or retry if the code is transient. A retry with the same mutation ID is always safe."],
          [<Badge key="b" tone="warn">unknown</Badge>, <><code>outcome: &quot;unknown&quot;</code>, or a timeout or dropped connection with no response</>, "The write may have committed. The server could not confirm either way.", <>Retry with the <strong>same</strong> mutation ID, or ask <code>GET /v1/mutations/{"{id}"}</code>. Never assume it failed.</>],
        ]}
      />
      <Callout kind="warn" title="A timeout is an unknown, not a failure">
        If your client gives up waiting, or the connection drops after the request left, the answer is <em>unknown</em> even though you saw no error body. Always send a
        mutation ID so you can retry or check. The CLI exits 3 in this case; each SDK page shows how it surfaces an unknown outcome. See <DocLink to="reads-writes">Reads and writes</DocLink>.
      </Callout>
      <p>
        Reads have no outcome field. A failed read changed nothing and can always be retried when the code is transient.
      </p>

      <H2 id="table">All error codes</H2>
      <p>
        Filter by code, status, outcome, or any word. The retry column assumes you send a stable mutation ID on writes. Errors reported by the CLI and SDKs keep these codes.
      </p>
      <FilterTable
        label="Filter error codes"
        placeholder="Filter by code, status, or text, for example 503 or leader"
        head={["Code", "HTTP", "Write outcome", "Retry?", "Meaning and action"]}
        rows={toRows(ROWS)}
      />
      <p>
        Responses that are not errors but look like them: <code>404 {`{"status":"unknown"}`}</code> from <code>GET /v1/mutations/{"{id}"}</code> means no commit record, and{" "}
        <code>503 {`{"status":"read_only","reason":"..."}`}</code> from <code>/ready</code> is a readiness answer, not an error object.
      </p>

      <H2 id="guidance">Guidance by situation</H2>

      <H3 id="g-input">400 family: fix the request</H3>
      <p>
        These are deterministic. Retrying the same request will fail the same way, so do not loop. The <code>message</code> names the parameter at fault. Because query strings and
        JSON bodies reject unknown fields, a typo in a parameter name is reported instead of ignored.
      </p>

      <H3 id="g-condition">condition_failed: the normal conflict path</H3>
      <p>
        This is optimistic concurrency, not a fault. Read the current value, apply your change to it, and write again with <code>if_version</code> set to the version you read. Loop a
        few times with jitter, then give up and surface the conflict. For a first-writer-wins lock use <code>if_absent</code>.
      </p>
      <Code lang="ts" title="Compare-and-set loop (pseudocode)">{`for (let attempt = 0; attempt < 5; attempt++) {
  const cur = await read(key);                       // value + version
  const next = update(cur.value);
  const res = await write(key, next, { ifVersion: cur.version });
  if (res.ok) return res;
  if (res.code !== "condition_failed") throw res;    // anything else is a different problem
}
throw new Error("too much contention on " + key);`}</Code>

      <H3 id="g-routing">421 and 409 stale_epoch: re-route</H3>
      <p>
        The cluster is healthy; you asked the wrong node or used an old routing table. The error object carries the hints you need. A hand-written client should follow{" "}
        <code>leader</code> (or <code>replicas[0]</code>) and retry, and refresh its cached routing on <code>stale_epoch</code> or <code>partition_moved</code>. The SDKs do this for you.
        Repeated 421s behind a load balancer usually mean every request lands on the same node; follow the hints instead of relying on the balancer to pick the owner.
      </p>

      <H3 id="g-503">503 family: transient, retry with backoff</H3>
      <p>
        Most 503 codes mean the cluster is changing state: an election, a partition moving, a map not committed yet. They are safe to retry. Use exponential backoff with jitter (for
        example 50 ms doubling to 2 s, at most a handful of attempts) and the same mutation ID for writes. If <code>read_timeout</code> or <code>proposal_lost</code> persists for more than a
        few seconds, a majority of a replica set is probably unavailable; see <DocLink to="troubleshooting">Troubleshooting</DocLink>. Exceptions: <code>read_only</code> is not
        transient and should not be retried against the same node.
      </p>

      <H3 id="g-unknown">outcome_unknown and timeouts: resolve, then decide</H3>
      <Code lang="ts" title="Retry with the same ID (pseudocode)">{`const id = crypto.randomUUID();
try {
  await write(key, value, { mutationId: id });
} catch (e) {
  if (e.outcome === "unknown") {
    // Simplest: send the identical write again. If it already committed you get deduplicated: true.
    await write(key, value, { mutationId: id });
  } else throw e;
}`}</Code>
      <p>
        The mutation record is kept for <code>storage.mutation_retention_secs</code> (24 hours by default). Within that window a retry is exact. After it, a duplicate would be applied
        again, so do not retry writes older than the window without checking the key.
      </p>

      <H3 id="g-readonly">read_only and corruption: operator action</H3>
      <p>
        <code>read_only</code> means the node stopped accepting writes to protect your data after a storage failure; <code>/ready</code> reports it and load balancers should stop sending it
        traffic. Look at the node log and <code>celeris status</code> for the reason, fix the underlying disk or permission problem, and restart. <code>corruption</code> is rarer and means
        a checksum or consistency check failed. Restore from a <DocLink to="backup-restore">backup</DocLink> or rebuild the node from its replicas, and report it if it was not caused by hardware.
      </p>

      <H2 id="cli-map">How the CLI maps errors to exit codes</H2>
      <Table
        head={["Situation", "Exit code"]}
        rows={[
          ["Success, including 202 accepted", "0"],
          ["Any error response with outcome not_applied or no outcome", "1"],
          ["An error response with outcome unknown, or a connection that may have delivered the request", "3"],
          ["get: not_found; mutation: no commit record", "4"],
          ["Unreachable node before any connection was made", "1 (nothing was written)"],
        ]}
      />

      <H2 id="next">Next steps</H2>
      <ul>
        <li><DocLink to="http-api">HTTP API</DocLink>: where each code can occur.</li>
        <li><DocLink to="reads-writes">Reads and writes</DocLink>: idempotent writes and conditions.</li>
        <li><DocLink to="troubleshooting">Troubleshooting</DocLink>: symptoms to causes.</li>
        <li><DocLink to="consistency">Consistency</DocLink>: why some reads fail during an outage instead of returning stale data.</li>
      </ul>
    </>
  );
}

export const page: DocPage = {
  slug: "errors",
  title: "Errors",
  group: "Reference",
  summary: "Every error code with its HTTP status, whether the write was applied, whether to retry, and what to do next.",
  keywords: ["error codes", "not_applied", "outcome unknown", "retry", "condition_failed", "421", "503", "idempotency", "mutation id", "not_leader", "read_only"],
  Body,
};
