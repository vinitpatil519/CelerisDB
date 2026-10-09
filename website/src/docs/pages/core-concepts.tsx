import { Callout, Code, DocLink, H2, H3, OsCode, Table, type DocPage } from "../kit";

const r = String.raw;

function Body() {
  return (
    <>
      <p>
        CelerisDB has a small data model: a key addressing a JSON value, a version on every write, and a handful of
        guarantees about how writes are applied. This page defines each term once, with the exact limits, so the rest of
        the documentation can use them freely.
      </p>

      <H2 id="keys">Keys</H2>
      <p>
        A key is a string of <strong>1 to 1024 bytes</strong> of UTF-8. The empty key is rejected, and a key may not begin
        with a zero byte (<code>%00</code> when percent-encoded), which is reserved. Beyond that, keys are opaque, but the
        convention is a path-like name with <code>/</code> separators, such as <code>users/42</code> or{" "}
        <code>orders/2026/0001</code>.
      </p>
      <p>
        Keys are stored in sorted byte order, which is what makes prefix and range scans cheap. Designing your key names so
        that related records share a prefix (<code>orders/</code>, <code>sessions/</code>) is the main modeling tool you
        have; see <DocLink to="queries">Queries</DocLink>.
      </p>
      <Callout kind="note" title="Keys in URLs">
        In the HTTP API the key is the rest of the path after <code>/v1/kv/</code> and is percent-decoded, so it may contain
        slashes. URL parsers collapse <code>.</code> and <code>..</code> path segments, so a key made of those segments cannot
        be addressed by path.
      </Callout>

      <H2 id="values">JSON values</H2>
      <p>
        A value is any valid JSON document: object, array, string, number, boolean or null. The server validates it and
        stores it unchanged. The maximum size is <strong>4 MiB</strong> per value. Because the database understands JSON,
        queries can filter on fields inside values, but there is no schema to declare.
      </p>
      <Table
        head={["Limit", "Value"]}
        rows={[
          ["Key length", "1 to 1024 bytes"],
          ["Value size", "4 MiB"],
          ["Operations in one batch", "10,000"],
          ["Keys plus values in one batch", "32 MiB"],
          ["Items per scan page", "1 to 1000 (default 100)"],
          ["Rows read per query request", "1 to 100,000 (default 10,000)"],
        ]}
      />

      <H2 id="versions">Versions</H2>
      <p>
        Every committed write is assigned a <strong>version</strong>, a number that increases with each commit. A key's
        version is the version of the write that last changed it. You see it in write and read responses, in the{" "}
        <code>celeris-version</code> response header over HTTP, and in the CLI's <code>OK version=...</code> line. Versions
        let you do optimistic concurrency (see <a href="#conditions">Conditions</a>) and tell whether a value changed
        between two reads. All operations of one batch share one version.
      </p>

      <H2 id="ttl">TTL and expiry</H2>
      <p>
        A write can carry a time to live: <code>--ttl 30m</code> on the CLI or <code>ttl_ms</code> over HTTP (at least 1
        millisecond). The node turns it into an absolute expiry time, <code>expires_at_ms</code>, which reads and scans
        report. After that moment the key behaves as if it had been deleted: <code>get</code> answers <code>not_found</code>.
        Rewriting a key without a TTL makes it permanent again. Exports keep the absolute expiry time and skip keys that
        have already expired.
      </p>

      <H2 id="mutation-ids">Mutation IDs and idempotency</H2>
      <p>
        Networks fail in the awkward middle: you send a write, the connection drops, and you do not know whether it
        committed. A <strong>mutation ID</strong> (a UUID) solves this. Every write carries one, the client chooses it or
        the server generates it, and the database remembers it together with the write's result.
      </p>
      <ul>
        <li>
          <strong>Same ID, same payload:</strong> the write is not applied again. The original version comes back with{" "}
          <code>deduplicated: true</code>.
        </li>
        <li>
          <strong>Same ID, different payload:</strong> rejected with <code>422 mutation_id_reused</code>. An ID names exactly
          one mutation.
        </li>
        <li>
          <strong>Unknown outcome:</strong> if a write times out or storage cannot confirm durability, the error says{" "}
          <code>outcome: unknown</code>. Never assume it failed. Retry with the same ID, or ask{" "}
          <code>GET /v1/mutations/&lt;id&gt;</code> (CLI: <code>celeris mutation &lt;id&gt;</code>).
        </li>
        <li>
          <strong>Not applied:</strong> <code>outcome: not_applied</code> means nothing was written and it is safe to treat
          as a failure.
        </li>
      </ul>
      <p>
        Mutation IDs are remembered for 24 hours by default (<code>storage.mutation_retention_secs</code>). Past that,
        the answer to &ldquo;did it commit?&rdquo; is &ldquo;unknown&rdquo;, never &ldquo;no&rdquo;. The CLI and the SDKs
        retry transport failures automatically with the same ID. The CLI also uses exit codes to separate the cases:{" "}
        <code>0</code> success, <code>1</code> failed and not applied, <code>3</code> outcome unknown, <code>4</code> not
        found.
      </p>

      <H2 id="conditions">Conditions</H2>
      <p>
        Two conditions make a write conditional on the current state of the key. They are evaluated atomically with the
        write.
      </p>
      <Table
        head={["Condition", "CLI", "HTTP", "Writes only if"]}
        rows={[
          ["Version match", <code key="a">--if-version N</code>, <code key="b">?if_version=N</code>, "the key's current version is N"],
          ["Absent", <code key="c">--if-absent</code>, <code key="d">?if_absent=true</code>, "the key does not exist"],
        ]}
      />
      <p>
        When a condition fails, the response is <code>409 condition_failed</code> with <code>outcome: not_applied</code> and
        the key's <code>current_version</code> (null if absent). The usual loop is read, modify, write with{" "}
        <code>if_version</code>, and on a conflict read again and retry. <code>delete</code> accepts{" "}
        <code>--if-version</code> too. In a replicated cluster, conditions require <code>strict</code> or{" "}
        <code>session</code>-style coordination: <code>available</code> and <code>eventual</code> writes refuse them with{" "}
        <code>conditions_require_strict</code>.
      </p>

      <H2 id="batches">Batches</H2>
      <p>
        <code>POST /v1/batch</code> applies a list of puts and deletes <strong>atomically</strong>: all or nothing, under one
        mutation ID and one version. Conditions inside a batch are checked against the state before the batch. In a
        cluster, a batch must stay within one replica set; a batch that spans replica sets is rejected with{" "}
        <code>cross_group_batch</code> rather than applied non-atomically. If you need to update several records together,
        give them a common key prefix design that keeps related data together, or accept separate writes.
      </p>
      <Code lang="json" title="A batch body">{`{
  "mutation_id": "3f2b8c1e-5d4a-4c7e-9b1a-0a1b2c3d4e5f",
  "consistency": "strict",
  "ops": [
    { "op": "put", "key": "orders/1", "value": { "total": 3 }, "ttl_ms": 60000, "if_absent": true },
    { "op": "delete", "key": "carts/9", "if_version": 12 }
  ]
}`}</Code>

      <H2 id="partitions-replicas">Partitions and replicas, in one paragraph</H2>
      <p>
        The keyspace is divided into a fixed number of partitions (4096). Each key belongs to exactly one partition, and
        each partition is stored on a <strong>replica set</strong> of nodes, three by default, spread across zones where
        possible. Every replica set runs its own Raft group, which elects a leader and replicates writes through a
        majority, so a write to a three-replica set is acknowledged once two replicas have it. Adding or removing nodes
        moves partitions between nodes; it does not re-hash your keys. You rarely need to think about this, but it explains
        why a write must reach a partition's leader, why a batch cannot span replica sets, and why a majority of nodes
        must be reachable for <code>strict</code> operations. The concepts are expanded in{" "}
        <DocLink to="how-it-works">How it works</DocLink> and <DocLink to="clustering">Clustering</DocLink>.
      </p>

      <H2 id="consistency-modes">The five consistency modes</H2>
      <p>
        Every read and write names a mode with <code>consistency</code> (<code>-c</code> on the CLI). The default is{" "}
        <code>strict</code>. Writes accept every mode except <code>bounded</code>, which describes read freshness only.
      </p>
      <Table
        head={["Mode", "During a partition", "Guarantee", "Cost"]}
        rows={[
          [<code key="1">strict</code>, "May reject or wait for a quorum", "Linearizable per key", "A quorum round-trip"],
          [<code key="2">session</code>, "May route to a replica that has your writes, or wait", "Read-your-writes and monotonic reads", "A session token check"],
          [<code key="3">bounded</code>, "Fails if no replica is fresh enough", "Staleness no greater than your bound", "Freshness metadata"],
          [<code key="4">available</code>, "Accepts on any reachable replica", "Eventual; conflicts are surfaced", "None on the write path"],
          [<code key="5">eventual</code>, "Accepts and reconciles later", "Eventual", "None"],
        ]}
      />
      <p>
        CelerisDB does not claim to get around the CAP theorem: in a real partition you cannot have both linearizability
        and unconditional availability. What it does is let each request pick. A <code>strict</code> request is never
        silently downgraded, and concurrent <code>available</code> writes are never silently lost; the losers are kept as
        inspectable conflicts. On a single node all modes behave identically. Full details are on the{" "}
        <DocLink to="consistency">Consistency</DocLink> and <DocLink to="available-mode">Available mode</DocLink> pages.
      </p>

      <H2 id="responses">What a response tells you</H2>
      <p>
        Responses report what actually happened, not what you asked for. Over HTTP, three headers accompany every
        successful key operation, and the same facts are in the JSON body:
      </p>
      <Table
        head={["Field", "Meaning"]}
        rows={[
          [<code key="a">version</code>, <>The commit version of the value written or read (header <code>celeris-version</code>).</>],
          [<code key="b">consistency</code>, <>The mode that was actually applied (header <code>celeris-consistency</code>).</>],
          [<code key="c">mutation_id</code>, <>The ID of the write (header <code>celeris-mutation-id</code>), and <code>deduplicated</code> on retries.</>],
          [<code key="d">staleness_ms</code>, <>Reported by <code>bounded</code> reads (0 on a single node).</>],
          [
            <code key="e">celeris-partition</code>,
            <>
              The partition of the key, with <code>celeris-partition-epoch</code>: the epoch is a counter for that
              partition's placement, which SDKs use to detect that their routing is out of date.
            </>,
          ],
          [<code key="f">celeris-session-index</code>, <>On writes in a replicated cluster: a token to send with later <code>session</code> reads.</>],
        ]}
      />
      <OsCode
        title="A write and its response (curl)"
        unix={`curl -i -X PUT "localhost:8080/v1/kv/users/42?ttl_ms=60000" -d '{"name":"Vinit"}'`}
        windows={r`'{"name":"Vinit"}' | curl.exe -i -X PUT "localhost:8080/v1/kv/users/42?ttl_ms=60000" --data-binary "@-"`}
      />
      <Code lang="json" title="Response body">{`{"key":"users/42","version":17,"mutation_id":"5d0c...","deduplicated":false,"consistency":"strict"}`}</Code>
      <H3 id="errors-brief">Errors are explicit</H3>
      <p>
        Every error carries a stable <code>code</code> and, for writes, an <code>outcome</code>. Common ones:{" "}
        <code>not_found</code> (404), <code>condition_failed</code> (409), <code>mutation_id_reused</code> (422) and{" "}
        <code>outcome_unknown</code> (500). The complete list is on the <DocLink to="errors">Errors</DocLink> page.
      </p>

      <H2 id="next">Next steps</H2>
      <ul>
        <li>
          <DocLink to="reads-writes">Reads and writes</DocLink>: every operation in detail.
        </li>
        <li>
          <DocLink to="consistency">Consistency</DocLink>: choosing a mode for each access pattern.
        </li>
        <li>
          <DocLink to="queries">Queries</DocLink>: filters, indexes, sorting and aggregates.
        </li>
        <li>
          <DocLink to="playground">Playground</DocLink>: try versions, TTLs and idempotent retries interactively.
        </li>
        <li>
          <DocLink to="glossary">Glossary</DocLink> for quick definitions.
        </li>
      </ul>
    </>
  );
}

export const page: DocPage = {
  slug: "core-concepts",
  title: "Core concepts",
  group: "Get started",
  summary: "Keys, JSON values, versions, TTL, mutation IDs, conditions, batches and the five consistency modes, with exact limits.",
  keywords: ["keys", "values", "limits", "version", "ttl", "expiry", "idempotency", "mutation id", "cas", "if-version", "if-absent", "batch", "atomic", "partition", "replica", "epoch", "consistency modes"],
  Body,
};
