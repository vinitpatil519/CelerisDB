import { Callout, Code, DocLink, Endpoint, H2, H3, OsCode, Params, Table, type DocPage } from "../kit";

/** curl command text for bash/zsh and for PowerShell (curl.exe, body on stdin so quoting never matters). */
function c(args: string, body?: string): { unix: string; windows: string } {
  if (body === undefined) {
    return { unix: "curl " + args, windows: "curl.exe " + args };
  }
  return {
    unix: "curl " + args + " -d '" + body + "'",
    windows: "'" + body + "' | curl.exe " + args + ' --data-binary "@-"',
  };
}

const JSON_H = '-H "content-type: application/json"';

function Body() {
  return (
    <>
      <p>
        Every client, including the SDKs, the CLI and browsers, uses this one HTTP/JSON API. Internal cluster protocols are never exposed. Request and
        response bodies are JSON. Values are arbitrary JSON documents that the server validates and stores unchanged. The examples assume a node on{" "}
        <code>localhost:8080</code>.
      </p>
      <Callout kind="note" title="curl on Windows">
        In PowerShell, <code>curl</code> is an alias for <code>Invoke-WebRequest</code> and does not accept these flags. Use <code>curl.exe</code> (it ships with
        Windows 10 and later). The Windows tabs below send each JSON body on stdin with <code>--data-binary &quot;@-&quot;</code>, which works unchanged in
        Windows PowerShell 5.1 and PowerShell 7 and sidesteps quote escaping. In cmd.exe use double quotes around the body and escape inner quotes as{" "}
        <code>\&quot;</code>, or point curl at a file with <code>--data-binary @body.json</code>.
      </Callout>

      <H2 id="conventions">Conventions</H2>
      <ul>
        <li>Base URL: <code>http://&lt;node&gt;:8080</code>, or <code>https://</code> when <code>http.tls</code> is set (HTTP/2 and HTTP/1.1 are negotiated).</li>
        <li>
          <strong>Content type.</strong> <code>PUT /v1/kv/...</code> reads the body as raw JSON and ignores the content type. <code>POST /v1/batch</code>,{" "}
          <code>POST /v1/query</code> and <code>POST /v1/admin/rebalance</code> require <code>content-type: application/json</code>. curl&apos;s default for{" "}
          <code>-d</code> is a form type, which those endpoints reject (415, code <code>invalid_json</code>), so always add the header there.
        </li>
        <li>Unknown query parameters and unknown JSON fields are rejected (<code>invalid_query</code> / <code>invalid_json</code>), so typos fail loudly.</li>
        <li>Request bodies are limited to 40 MiB. Larger bodies are refused with 413.</li>
      </ul>

      <H3 id="limits">Limits</H3>
      <Table
        head={["Limit", "Value"]}
        rows={[
          ["Key length", "1 to 1024 bytes of UTF-8; must not start with %00"],
          ["Value size", "4 MiB per value"],
          ["Batch", "10,000 operations and 32 MiB of keys plus values"],
          ["Scan page size (limit)", "1 to 1000, default 100"],
          ["Query max_scanned", "1 to 100,000, default 10,000"],
          ["Query filter", "256 conditions, 16 levels of nesting, 1,000 values in $in / $nin"],
          ["TTL (ttl_ms)", "At least 1"],
        ]}
      />

      <H2 id="auth">Authentication and scopes</H2>
      <p>
        Authentication is off until at least one token is configured (<code>[[auth.tokens]]</code> or <code>CELERIS_AUTH_TOKENS</code>; create one with{" "}
        <code>celeris token create</code>). After that every request except <code>/health</code>, <code>/ready</code> and <code>/metrics</code> needs{" "}
        <code>Authorization: Bearer &lt;token&gt;</code> with a scope that covers it. Scopes do not include each other: a client that writes and reads needs both.
      </p>
      <Table
        head={["Scope", "Allows"]}
        rows={[
          [<code key="s">read</code>, <>All <code>GET</code> endpoints under <code>/v1</code> (key-value, scan, mutations, conflicts, status, partitions), <code>POST /v1/query</code>, and <code>/v1/watch</code></>],
          [<code key="s">write</code>, <><code>PUT</code> and <code>DELETE /v1/kv/...</code>, <code>POST /v1/batch</code>, <code>DELETE /v1/conflicts/...</code></>],
          [<code key="s">admin</code>, <>Everything under <code>/v1/admin/</code>, from any address</>],
          ["none required", <><code>/health</code>, <code>/ready</code>, <code>/metrics</code></>],
        ]}
      />
      <ul>
        <li>No or unknown token: <code>401 unauthorized</code> with <code>WWW-Authenticate: Bearer realm=&quot;celeris&quot;</code>.</li>
        <li>Token without the needed scope: <code>403 forbidden</code>.</li>
        <li>Browsers cannot set headers on a WebSocket, so <code>/v1/watch</code> also accepts <code>?access_token=&lt;token&gt;</code>.</li>
        <li>Nodes store only the SHA-256 of each token.</li>
      </ul>
      <OsCode
        title="Sending a token"
        unix={`curl -H "Authorization: Bearer $CELERIS_TOKEN" localhost:8080/v1/kv/users/42`}
        windows={`curl.exe -H "Authorization: Bearer $env:CELERIS_TOKEN" localhost:8080/v1/kv/users/42`}
      />
      <H3 id="admin-loopback">The loopback rule for admin endpoints</H3>
      <p>
        With <strong>no tokens configured</strong>, the three admin endpoints accept connections from a loopback address only (127.0.0.1 or ::1) and answer{" "}
        <code>403 forbidden</code> to anyone else. That is why <code>celeris stop</code> works on the same host out of the box and fails from another machine.
        With tokens configured, the loopback rule is replaced by the <code>admin</code> scope, which works from any address. Behind a reverse proxy every
        request arrives from the proxy&apos;s address, so on an unauthenticated node a proxy on the same host would make the endpoint reachable by anyone who can
        reach the proxy. Configure tokens before putting a node behind a proxy. See <DocLink to="security">Security</DocLink>.
      </p>

      <H2 id="headers">Headers</H2>
      <Table
        head={["Header", "Direction", "Meaning"]}
        rows={[
          [<code key="h">celeris-mutation-id</code>, "request", "Optional client-chosen UUID. Retrying a write with the same ID never applies it twice. Generated by the server if absent. Must be a UUID or the request fails with invalid_mutation_id."],
          [<code key="h">celeris-mutation-id</code>, "response", "ID of the write that was applied (writes only)."],
          [<code key="h">celeris-version</code>, "response", "Commit version of the value written or read."],
          [<code key="h">celeris-consistency</code>, "response", "Consistency mode applied. The server never silently weakens the mode you asked for."],
          [<code key="h">celeris-partition</code>, "response", "Partition of the key. Sent by nodes that do not run the replicated mode."],
          [<code key="h">celeris-partition-epoch</code>, "request", <>Optional. The partition epoch your client routed with. Older than the node knows: <code>409 stale_epoch</code>. Newer than the node knows: <code>503 epoch_ahead</code>. Must be an integer.</>],
          [<code key="h">celeris-partition-epoch</code>, "response", "The key's current partition epoch (non-replicated routing mode)."],
          [<code key="h">celeris-session-index</code>, "response", <>Replicated mode. Position of this write or read in the key&apos;s replica set, as <code>&lt;index&gt;@&lt;group&gt;</code>.</>],
          [<code key="h">celeris-session-index</code>, "request", <>Replicated mode, <code>session</code> reads. Send the last value you received. A replica that has not applied up to it answers <code>503 session_behind</code>. A token from a different group is served by the leader.</>],
        ]}
      />
      <p>
        When CORS is enabled the <code>celeris-mutation-id</code>, <code>celeris-version</code> and <code>celeris-consistency</code> response headers are exposed to
        browsers.
      </p>

      <H2 id="consistency-param">Consistency</H2>
      <p>
        Choose per request with <code>?consistency=</code> (or the <code>consistency</code> field in a JSON body). The default is <code>strict</code>. Reads accept{" "}
        <code>strict</code>, <code>session</code>, <code>bounded</code> (needs <code>max_staleness_ms</code>), <code>available</code> and <code>eventual</code>. Writes
        accept every mode except <code>bounded</code>. <code>max_staleness_ms</code> is rejected with any other mode. Semantics are explained in{" "}
        <DocLink to="consistency">Consistency</DocLink>.
      </p>

      <H2 id="errors-overview">Errors</H2>
      <Code lang="json">{`{"error": {"code": "condition_failed", "message": "...",
           "outcome": "not_applied", "mutation_id": "5d0c...", "current_version": 7}}`}</Code>
      <p>
        Write errors always carry <code>outcome</code>: <code>not_applied</code> (nothing was written) or <code>unknown</code> (the write may have committed; retry with
        the same mutation ID or ask <code>GET /v1/mutations/{"{id}"}</code>). Every code, status and recommended action is on{" "}
        <DocLink to="errors">Errors</DocLink>.
      </p>

      <H2 id="kv">Key-value</H2>
      <p>
        The key is the rest of the path after <code>/v1/kv/</code> and may contain <code>/</code>. It is percent-decoded. URL parsers collapse <code>.</code> and{" "}
        <code>..</code> path segments, so keys containing them cannot be addressed by path.
      </p>

      <H3 id="put">PUT /v1/kv/{"{key}"}</H3>
      <Endpoint method="PUT" path="/v1/kv/{key}">
        Write a value. Needs <code>write</code>. The request body is the JSON value (one document).
      </Endpoint>
      <Params
        rows={[
          { name: "consistency", type: "query", def: "strict", desc: "strict, session, available or eventual." },
          { name: "ttl_ms", type: "query, integer", desc: "Expire after this many milliseconds. At least 1." },
          { name: "if_version", type: "query, integer", desc: "Write only if the key's current version equals this." },
          { name: "if_absent", type: "query, boolean", desc: "true: write only if the key does not exist. Mutually exclusive with if_version." },
          { name: "celeris-mutation-id", type: "header", desc: "Idempotency ID." },
        ]}
      />
      <OsCode {...c('-X PUT "localhost:8080/v1/kv/users/42?ttl_ms=3600000"', '{"name":"Vinit"}')} />
      <Code lang="json" title="200 response">{`{"key":"users/42","version":17,"mutation_id":"5d0c...","deduplicated":false,"consistency":"strict"}`}</Code>
      <p>
        <code>deduplicated: true</code> means this mutation ID had already committed. The original version is returned and nothing new is written. In a
        replicated cluster the response also carries <code>celeris-session-index</code>.
      </p>
      <p>
        <strong>Status codes:</strong> 200 applied; <strong>202</strong> an <code>available</code> or <code>eventual</code> write accepted by a replica that is not the group
        leader, body <code>{`{"accepted":true,"replicated":false,"timestamp_ms":...,"mutation_id":"..."}`}</code>, committed in the background (see{" "}
        <DocLink to="available-mode">Available mode</DocLink>); 400, 401, 403, 409 (<code>condition_failed</code>, <code>stale_epoch</code>), 421, 422, 500, 503. In a
        replicated cluster, <code>if_version</code> and <code>if_absent</code> with <code>available</code>/<code>eventual</code> are refused with{" "}
        <code>400 conditions_require_strict</code>.
      </p>

      <H3 id="get">GET /v1/kv/{"{key}"}</H3>
      <Endpoint method="GET" path="/v1/kv/{key}">
        Read a value. Needs <code>read</code>.
      </Endpoint>
      <Params
        rows={[
          { name: "consistency", type: "query", def: "strict", desc: "strict, session, bounded, available or eventual." },
          { name: "max_staleness_ms", type: "query, integer", desc: "Required for bounded, rejected otherwise." },
          { name: "celeris-session-index", type: "header", desc: "Replicated mode, session reads: the token from your last write or read." },
        ]}
      />
      <OsCode {...c('"localhost:8080/v1/kv/users/42?consistency=bounded&max_staleness_ms=500"')} />
      <Code lang="json" title="200 response">{`{"key":"users/42","value":{"name":"Vinit"},"version":17,"mutation_id":"5d0c...",
 "timestamp_ms":1760000000000,"expires_at_ms":null,"consistency":"bounded","staleness_ms":0}`}</Code>
      <p>
        <code>staleness_ms</code> appears on bounded reads. Status codes: 200, 400, 401, 403, 404 (<code>not_found</code>: absent, deleted or expired), 409, 421, 503.
      </p>

      <H3 id="delete">DELETE /v1/kv/{"{key}"}</H3>
      <Endpoint method="DELETE" path="/v1/kv/{key}">
        Delete a key. Needs <code>write</code>. Same response shape as PUT.
      </Endpoint>
      <Params
        rows={[
          { name: "consistency", type: "query", def: "strict", desc: "strict, session, available or eventual." },
          { name: "if_version", type: "query, integer", desc: "Delete only if the current version equals this." },
          { name: "celeris-mutation-id", type: "header", desc: "Idempotency ID." },
        ]}
      />
      <OsCode {...c('-X DELETE "localhost:8080/v1/kv/users/42?if_version=17"')} />

      <H3 id="batch">POST /v1/batch</H3>
      <Endpoint method="POST" path="/v1/batch">
        Apply several operations atomically, all or nothing, under one mutation ID and one commit version. Needs <code>write</code>.
      </Endpoint>
      <Params
        rows={[
          { name: "ops", type: "array", desc: <>Required, non-empty. Each item is <code>{`{"op":"put","key","value","ttl_ms"?,"if_version"?,"if_absent"?}`}</code> or <code>{`{"op":"delete","key","if_version"?}`}</code>.</> },
          { name: "mutation_id", type: "string (UUID)", desc: "Optional. If omitted the celeris-mutation-id header is used, else a random one." },
          { name: "consistency", type: "string", def: "strict", desc: "Write mode; not bounded." },
        ]}
      />
      <p>
        Conditions are checked against the state before the batch. In a replicated cluster all keys must belong to one replica set (<code>400 cross_group_batch</code>); without
        the replicated mode, all keys must be led by the receiving node (<code>421 not_owner</code>).
      </p>
      <OsCode
        {...c(
          "-X POST localhost:8080/v1/batch " + JSON_H,
          '{"ops":[{"op":"put","key":"orders/1","value":{"total":3},"ttl_ms":60000,"if_absent":true},{"op":"delete","key":"carts/9","if_version":12}]}',
        )}
      />

      <H3 id="scan">GET /v1/scan</H3>
      <Endpoint method="GET" path="/v1/scan">
        List keys in order. Needs <code>read</code>. Not a point-in-time snapshot.
      </Endpoint>
      <Params
        rows={[
          { name: "prefix", type: "string", desc: "Keys that start with this. Cannot be combined with start/end." },
          { name: "start, end", type: "string", desc: "Range: start inclusive, end exclusive." },
          { name: "after", type: "string", desc: "Cursor: the next_cursor of the previous page." },
          { name: "limit", type: "integer", def: "100", desc: "1 to 1000." },
          { name: "consistency", type: "string", def: "strict", desc: "As for reads. max_staleness_ms is accepted for bounded." },
        ]}
      />
      <OsCode {...c('"localhost:8080/v1/scan?prefix=users/&limit=2"')} />
      <Code lang="json">{`{"items":[{"key":"users/1","value":{},"version":3,"expires_at_ms":null}],
 "next_cursor":"users/1","consistency":"strict","partial":false}`}</Code>
      <p>
        <strong>Pagination.</strong> Pass <code>next_cursor</code> as <code>after</code> for the next page. It is <code>null</code> on the last page. <code>partial: true</code> means the
        result may miss records: other nodes lead some partitions, or (for <code>available</code>/<code>eventual</code> scans in a cluster) a replica set could not be reached. A{" "}
        <code>strict</code> scan that cannot reach a replica set fails with <code>503 scan_incomplete</code> instead.
      </p>

      <H3 id="query">POST /v1/query</H3>
      <Endpoint method="POST" path="/v1/query">
        A scan with a JSON filter, projection, sort and aggregates, evaluated on the nodes that hold the data. Needs <code>read</code>. The guide to filters, indexes and cost
        is <DocLink to="queries">Queries</DocLink>.
      </Endpoint>
      <Params
        rows={[
          { name: "prefix | start, end", type: "string", desc: "The range, as for scan." },
          { name: "where", type: "object", desc: "Filter. Conditions are ANDed. Operators: $eq $ne $gt $gte $lt $lte $in $nin $exists $prefix $contains; combinators $and $or $not." },
          { name: "fields", type: "string[]", desc: "Projection: dotted paths to keep. Not applied to aggregate requests." },
          { name: "sort", type: "object", desc: <><code>{`{"field":"total","order":"desc"}`}</code>. Needs a ready index on the field with the same order, else <code>400 sort_unavailable</code>.</> },
          { name: "aggregate", type: "object", desc: <><code>{`{"count":true,"sum":["total"],"min":["created"],"max":["total"]}`}</code>. Replaces <code>items</code> with <code>aggregates</code>. <code>limit</code> does not apply.</> },
          { name: "limit", type: "integer", def: "100", desc: "1 to 1000." },
          { name: "max_scanned", type: "integer", def: "10000", desc: "1 to 100,000. Rows one request may read, matching or not." },
          { name: "after", type: "string", desc: "Cursor from next_cursor. For sorted queries it is an opaque index position; send it back with the same sort." },
          { name: "consistency, max_staleness_ms", type: "string / integer", def: "strict", desc: "As for reads." },
        ]}
      />
      <OsCode
        {...c(
          "-X POST localhost:8080/v1/query " + JSON_H,
          '{"prefix":"orders/","where":{"status":"paid","total":{"$gte":100}},"fields":["total","customer.id"],"limit":100}',
        )}
      />
      <Code lang="json">{`{"items":[{"key":"orders/0042","value":{"total":120,"customer":{"id":7}},"version":9,"expires_at_ms":null}],
 "next_cursor":"orders/0042","scanned":57,"index":"orders_by_status","consistency":"strict","partial":false}`}</Code>
      <p>
        A page reads at most <code>max_scanned</code> rows, so a selective filter can return few or no items and still have a <code>next_cursor</code>. Keep passing it as{" "}
        <code>after</code> until it is <code>null</code>. <code>index</code> names the secondary index used, or is <code>null</code> for a scan. An invalid filter fails with{" "}
        <code>400 invalid_filter</code>; a cluster scan that cannot reach a replica set with <code>503 query_incomplete</code> (strict) or <code>partial: true</code> (other modes).
        Aggregate responses add <code>aggregates</code> with <code>count</code>, <code>sum</code>, <code>min</code> and <code>max</code> for the page; merge pages by adding counts and sums and
        keeping the extreme min and max.
      </p>

      <H3 id="mutations">GET /v1/mutations/{"{id}"}</H3>
      <Endpoint method="GET" path="/v1/mutations/{id}">
        Did this mutation commit? Needs <code>read</code>. The ID must be a UUID (<code>400 invalid_mutation_id</code>).
      </Endpoint>
      <OsCode {...c("localhost:8080/v1/mutations/5d0c9a1e-6a1b-4c52-9a43-1f6c3d2e8b77")} />
      <Code lang="json" title="200 and 404">{`{"mutation_id":"5d0c...","status":"committed","version":17}

{"mutation_id":"5d0c...","status":"unknown","message":"no commit record: ..."}`}</Code>
      <p>
        The 404 body is not an error object. <code>unknown</code> means the mutation did not commit, is still in flight, or is older than{" "}
        <code>storage.mutation_retention_secs</code> (24 hours by default).
      </p>

      <H3 id="conflicts">Conflicts</H3>
      <Endpoint method="GET" path="/v1/conflicts?prefix=&limit=">
        Writes that lost last-writer-wins resolution in <code>available</code> mode. Needs <code>read</code>. <code>limit</code> is clamped to 1-1000 (default 100). Returns{" "}
        <code>{`{"conflicts":[...],"partial":false}`}</code>; on a single node the list is always empty.
      </Endpoint>
      <Endpoint method="DELETE" path="/v1/conflicts/{key}">
        Clear a key&apos;s recorded conflicts through the group leader. Needs <code>write</code>. Returns <code>{`{"key":"...","cleared":true}`}</code>. Idempotent;{" "}
        <code>503 not_confirmed</code> means retry.
      </Endpoint>

      <H2 id="watch">Change stream (WebSocket)</H2>
      <Endpoint method="WS" path="/v1/watch?prefix=">
        Streams the changes this node applies, as JSON text messages. Needs <code>read</code>. A plain HTTP request that is not a WebSocket upgrade gets{" "}
        <code>400 websocket_required</code>.
      </Endpoint>
      <Params
        rows={[
          { name: "prefix", type: "string", def: "all keys", desc: "Only changes whose key starts with this." },
          { name: "access_token", type: "string", desc: "Token for browsers, which cannot set headers on a WebSocket." },
        ]}
      />
      <Code lang="json" title="Messages">{`{"type":"hello","node":"4f1c...","prefix":"users/","groups":[],"partial":false}
{"type":"change","key":"users/42","kind":"put","value":{"name":"Vinit"},"version":17,"mutation_id":"5d0c..."}
{"type":"change","key":"users/42","kind":"delete","value":null,"version":18,"mutation_id":"..."}
{"type":"lagged","missed":128}`}</Code>
      <ul>
        <li><strong>Coverage.</strong> A node sees the changes of its own data. In a replicated cluster <code>partial: true</code> means other replica sets exist that this node does not hold; watch a node in each, or use a replication factor equal to the node count.</li>
        <li><strong>Delivery</strong> is best effort and starts from now. A slow watcher gets <code>lagged</code> and should re-read what it shows. Deduplicated retries produce no events.</li>
        <li>Use <code>wss://</code> when the node serves HTTPS.</li>
      </ul>
      <Code lang="js" title="Browser or Node 22+">{`const ws = new WebSocket("ws://localhost:8080/v1/watch?prefix=users/&access_token=" + token);
ws.onmessage = (e) => console.log(JSON.parse(e.data));`}</Code>
      <p>
        See <DocLink to="change-streams">Change streams</DocLink> for patterns such as resuming after <code>lagged</code>.
      </p>

      <H2 id="routing">Routing and epoch fencing</H2>
      <p>
        Every key belongs to a partition. Clients can ask where a key lives with <code>GET /v1/partitions/key/{"{key}"}</code> and send requests straight to the owner.
      </p>
      <ul>
        <li>A node that does not own the key answers <code>421 not_owner</code> with routing hints in the error object: <code>partition</code>, <code>partition_epoch</code>, <code>map_epoch</code>, <code>replicas</code>, <code>leader</code>.</li>
        <li>In a replicated cluster only the replica-set leader accepts writes and strict reads: others answer <code>421 not_leader</code> with <code>leader</code> and <code>replicas</code>. <code>421 partition_moved</code> carries the new <code>replicas</code>.</li>
        <li>Until a partition map exists, data requests return <code>503 no_partition_map</code>. The control-plane leader commits the first map once every voter is up (<code>cluster.replication_factor</code>, default 3); with <code>replication_factor = 0</code> run <code>celeris cluster rebalance --rf N</code>.</li>
        <li>Read behavior by mode in a replicated cluster: <code>strict</code> and <code>bounded</code> are served by the leader after a read barrier (linearizable); <code>session</code> by any replica that has applied your <code>celeris-session-index</code>; <code>available</code> and <code>eventual</code> by any replica, possibly stale.</li>
      </ul>
      <p>The SDKs follow these hints for you. Details for hand-rolled clients are in <DocLink to="sdk-http">HTTP without an SDK</DocLink>.</p>

      <H2 id="operational">Operational endpoints</H2>
      <H3 id="health">GET /health and GET /ready</H3>
      <Endpoint method="GET" path="/health">Liveness. No token needed. <code>{`{"status":"ok","node_id":"..."}`}</code></Endpoint>
      <Endpoint method="GET" path="/ready">
        200 <code>{`{"status":"ready"}`}</code> when the node accepts writes; <strong>503</strong> <code>{`{"status":"read_only","reason":"..."}`}</code> after a storage failure put it in read-only mode. No token needed. Use it for load-balancer and Kubernetes readiness probes.
      </Endpoint>
      <OsCode {...c("-i localhost:8080/ready")} />

      <H3 id="status">GET /v1/status</H3>
      <Endpoint method="GET" path="/v1/status">Node, cluster, partition, storage, index and control-plane state. Needs <code>read</code>.</Endpoint>
      <Code lang="json" title="Shape (abridged)">{`{"node_id":"...","version":"...","uptime_secs":3720,"health":"healthy",
 "cluster":{"mode":"gossip","view_epoch":4,"nodes":[{"id":"a","address":"10.0.0.4:7000","zone":"default","state":"alive","incarnation":0,"self":true}]},
 "storage":{"last_version":18204,"memtable_bytes":0,"l0_tables":1,"l1_tables":3,"table_bytes":0,
            "read_only_reason":null,"background_error":null,"recovery":{}},
 "partitions":{"count":4096,"epoch":3,"replication_factor":3},
 "indexes":[{"name":"orders_by_status","state":"ready","group":null}],
 "control":{"raft":{"role":"leader","term":2,"leader":"a","commit_index":57},"migrations":{"running":0,"by_phase":{}},"anti_entropy":[]},
 "consistency_modes":["strict","session","bounded","available","eventual"]}`}</Code>
      <p>
        <code>cluster.mode</code> is <code>single-node</code> or <code>gossip</code>. Member <code>state</code> is <code>alive</code>, <code>suspect</code>, <code>unreachable</code> or <code>left</code>.
        Index <code>state</code> is <code>building</code>, <code>ready</code> or <code>dropping</code>. <code>health</code> is <code>healthy</code> or <code>read_only</code>. Treat counts and nested field lists as informational; they can grow.
      </p>

      <H3 id="partitions">GET /v1/partitions and GET /v1/partitions/key/{"{key}"}</H3>
      <Endpoint method="GET" path="/v1/partitions">Needs <code>read</code>. Partition map summary: <code>count</code>, <code>epoch</code>, <code>replication_factor</code>, <code>zone_diverse_partitions</code>, and <code>nodes[]</code> with <code>id</code>, <code>zone</code>, <code>replicas</code> and <code>leaders</code>.</Endpoint>
      <Endpoint method="GET" path="/v1/partitions/key/{key}">Needs <code>read</code>. <code>{`{"key","partition","partition_epoch","map_epoch","replicas","leader"}`}</code>. The first replica is the leader.</Endpoint>

      <H3 id="metrics">GET /metrics</H3>
      <Endpoint method="GET" path="/metrics">Prometheus text format. No token needed. See <DocLink to="observability">Observability</DocLink> for dashboards and alerts.</Endpoint>
      <Table
        head={["Metric", "Type", "Notes"]}
        rows={[
          [<code key="m">celeris_http_requests_total{"{route,method,status}"}</code>, "counter", "Requests by matched route."],
          [<code key="m">celeris_http_request_duration_seconds{"{route,method}"}</code>, "histogram", "Request latency."],
          [<code key="m">celeris_operations_by_consistency_total{"{mode,kind}"}</code>, "counter", "Reads and writes by consistency mode."],
          [<code key="m">celeris_storage_*_total</code>, "counters", "Storage activity: writes, durability syncs and failures, dedupe hits, condition failures, reads, cache hits and misses, flushes, compactions, tombstones purged, write stalls, background errors."],
          [<code key="m">celeris_storage_{"{last_version,memtable_bytes,immutable_memtables,l0_tables,l1_tables,table_bytes,read_only}"}</code>, "gauges", "Storage size and state. read_only is 1 when the node refuses writes."],
          [<code key="m">celeris_node_info{"{node_id,version}"}</code>, "gauge", "Always 1; labels carry the identity."],
          [<code key="m">celeris_uptime_seconds</code>, "gauge", ""],
          [<code key="m">celeris_cluster_members{"{state}"}</code>, "gauge", "Members in this node's view by state. Present in cluster mode."],
          [<code key="m">celeris_cluster_view_epoch</code>, "counter", "Changes to this node's membership view. Present in cluster mode."],
        ]}
      />

      <H3 id="admin">Admin endpoints</H3>
      <p>
        All three need the <code>admin</code> scope, or a loopback connection when no tokens are configured (see <a href="#admin-loopback">the loopback rule</a>).
      </p>
      <Endpoint method="POST" path="/v1/admin/shutdown">
        Graceful stop. Answers <code>202 {`{"status":"shutting_down"}`}</code>.
      </Endpoint>
      <OsCode {...c("-X POST localhost:8080/v1/admin/shutdown")} />
      <Endpoint method="POST" path="/v1/admin/rebalance">
        Body <code>{`{"replication_factor": N}`}</code> (0 to 255). Proposes placing partitions on the current membership through the control plane. The leader answers{" "}
        <code>202 {`{"status":"proposed","log_index":N}`}</code>; a follower forwards the request and answers <code>202 {`{"status":"forwarded","leader":"..."}`}</code>. Errors:{" "}
        <code>409 not_leader</code> (no leader known yet), <code>409 no_control_plane</code> (this node is not a voter), <code>409 migrations_pending</code> (data from the previous placement is
        still moving), <code>400 invalid_argument</code>.
      </Endpoint>
      <OsCode {...c("-X POST localhost:8080/v1/admin/rebalance " + JSON_H, '{"replication_factor":3}')} />
      <Endpoint method="GET" path="/v1/admin/backup">
        A consistent physical snapshot of one node&apos;s storage as <code>application/octet-stream</code>, with <code>content-disposition</code> naming a{" "}
        <code>.backup</code> file and <code>celeris-version</code> holding the last version it contains. In a replicated cluster it answers <code>501 not_supported</code>; use{" "}
        <code>celeris export</code> there. Restore with <code>celeris restore</code>.
      </Endpoint>
      <OsCode
        unix={`curl -o celeris.backup localhost:8080/v1/admin/backup`}
        windows={`curl.exe -o celeris.backup localhost:8080/v1/admin/backup`}
      />

      <H2 id="cors">CORS</H2>
      <p>
        Off by default. Enable with <code>[http] cors_origins = [&quot;http://localhost:5173&quot;]</code> (or <code>&quot;*&quot;</code>) or <code>CELERIS_CORS_ORIGINS</code> (comma-separated).
        All methods and request headers are allowed for the listed origins. If your browser app sends the <code>Authorization</code> header, list its exact origin rather than <code>*</code>.
      </p>

      <H2 id="status-codes">Status codes at a glance</H2>
      <Table
        head={["Code", "Used for"]}
        rows={[
          ["200", "Success"],
          ["202", "Accepted: available/eventual write on a non-leader replica; shutdown or rebalance proposed"],
          ["400", "Bad input (invalid_json, invalid_key, invalid_argument, invalid_query, invalid_filter, invalid_consistency, ...)"],
          ["401 / 403", "Missing or unknown token / token lacks the scope, or admin endpoint from a non-loopback address without tokens"],
          ["404", "Key absent, deleted or expired; mutation with no commit record"],
          ["409", "condition_failed, stale_epoch, migrations_pending, not_leader and no_control_plane (admin)"],
          ["413 / 415", "Body over 40 MiB / JSON endpoint called without a JSON content type"],
          ["421", "not_owner, not_leader, partition_moved: retry against the node named in the hints"],
          ["422", "mutation_id_reused"],
          ["500", "outcome_unknown, corruption, internal"],
          ["501", "not_supported"],
          ["503", "read_only and transient cluster states: retry shortly"],
        ]}
      />

      <H2 id="next">Next steps</H2>
      <ul>
        <li><DocLink to="errors">Errors</DocLink>: what each code means and what to do.</li>
        <li><DocLink to="sdk-http">HTTP without an SDK</DocLink>: routing, retries and idempotency for hand-written clients.</li>
        <li><DocLink to="consistency">Consistency</DocLink> and <DocLink to="reads-writes">Reads and writes</DocLink>.</li>
        <li><DocLink to="cli">CLI reference</DocLink>: the same operations from a terminal.</li>
      </ul>
    </>
  );
}

export const page: DocPage = {
  slug: "http-api",
  title: "HTTP API reference",
  group: "Reference",
  summary: "Every endpoint, parameter, header, status code and auth scope of the CelerisDB HTTP/JSON API, with curl examples for Linux, macOS and Windows.",
  keywords: ["REST", "endpoints", "curl", "curl.exe", "headers", "celeris-consistency", "celeris-session-index", "celeris-partition-epoch", "websocket", "metrics", "admin", "pagination", "bearer token"],
  Body,
};
