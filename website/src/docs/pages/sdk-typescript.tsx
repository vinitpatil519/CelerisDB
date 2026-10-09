import {
  Callout,
  Code,
  CodeTabs,
  Details,
  DocLink,
  H2,
  H3,
  OsCode,
  Params,
  Step,
  Steps,
  Table,
  type DocPage,
} from "../kit";
import RetryTimeline from "../demos/RetryTimeline";

function Body() {
  return (
    <>
      <p>
        <code>@celeris/client</code> is the TypeScript client for CelerisDB. It has no runtime dependencies: it uses the platform{" "}
        <code>fetch</code> and <code>WebSocket</code>, so the same code runs in Node.js 22 or newer and in browsers. A small React hook,{" "}
        <code>useCeleris</code>, keeps a component in sync with one key through the change stream.
      </p>

      <Callout kind="note" title="Packaging status">
        The package is not on the npm registry yet. Today you build it from the repository and install it from a local path or a tarball
        (shown below). Everything on this page is taken from the SDK source in <code>sdks/typescript</code>; the package version is{" "}
        <code>0.1.0</code>.
      </Callout>

      <H2 id="install">Install</H2>
      <p>
        You need Node.js 22 or newer (older versions have no global <code>WebSocket</code>), git, and a package manager. React is an{" "}
        <em>optional</em> peer dependency (version 18 or newer) and is only needed for the <code>@celeris/client/react</code> entry
        point.
      </p>
      <Steps>
        <Step title="Build the package from the repository">
          <OsCode
            linux={`git clone https://github.com/vinitpatil519/CelerisDB.git
cd CelerisDB/sdks/typescript
npm install
npm run build`}
            macos={`git clone https://github.com/vinitpatil519/CelerisDB.git
cd CelerisDB/sdks/typescript
npm install
npm run build`}
            windows={`git clone https://github.com/vinitpatil519/CelerisDB.git
cd CelerisDB\\sdks\\typescript
npm install
npm run build`}
          />
          <p>
            <code>npm run build</code> compiles <code>src/</code> to <code>dist/</code>. The package exposes only <code>dist/</code>, so this
            step is required.
          </p>
        </Step>
        <Step title="Add it to your project">
          <p>
            From your own project folder, install the package from the path of the clone. Adjust the relative path to wherever you cloned
            the repository.
          </p>
          <CodeTabs
            group="js-pm"
            items={[
              { id: "npm", label: "npm", lang: "bash", code: "npm install ../CelerisDB/sdks/typescript" },
              { id: "pnpm", label: "pnpm", lang: "bash", code: "pnpm add ../CelerisDB/sdks/typescript" },
              { id: "yarn", label: "yarn", lang: "bash", code: "yarn add file:../CelerisDB/sdks/typescript" },
            ]}
          />
          <p>
            A folder install is linked, not copied. For CI or Docker builds, create a tarball once and install that instead:
          </p>
          <OsCode
            unix={`cd CelerisDB/sdks/typescript
npm pack                     # writes celeris-client-0.1.0.tgz
cd ../../../my-app
npm install ../CelerisDB/sdks/typescript/celeris-client-0.1.0.tgz`}
            windows={`cd CelerisDB\\sdks\\typescript
npm pack                     # writes celeris-client-0.1.0.tgz
cd ..\\..\\..\\my-app
npm install ..\\CelerisDB\\sdks\\typescript\\celeris-client-0.1.0.tgz`}
          />
        </Step>
        <Step title="Check that it imports">
          <Code lang="js" title="check.mjs">{`import { Client } from "@celeris/client";
const db = new Client({ nodes: "http://127.0.0.1:8080" });
console.log(await db.status());`}</Code>
          <p>
            Run it with <code>node check.mjs</code> while a node is listening on port 8080.
          </p>
        </Step>
      </Steps>

      <H2 id="node">A node to talk to</H2>
      <p>
        The examples assume a node on <code>127.0.0.1:8080</code>. The quickest way is the binary built from the repository (see{" "}
        <DocLink to="installation">Installation</DocLink> and <DocLink to="quickstart">Quickstart</DocLink> for every option):
      </p>
      <OsCode
        linux={`celeris init
celeris start`}
        macos={`celeris init
celeris start`}
        windows={`celeris init
celeris start`}
        title="in a scratch folder"
      />
      <p>
        For a three-node cluster on one machine, <code>docker compose up -d --build</code> in the repository root exposes the nodes on
        ports 8081, 8082 and 8083, so pass all three URLs to the client.
      </p>

      <H2 id="client">Create a client</H2>
      <Code lang="ts">{`import { Client } from "@celeris/client";

// One node
const db = new Client({ nodes: "http://127.0.0.1:8080" });

// Several nodes: the client fails over between them
const cluster = new Client({
  nodes: ["http://10.0.0.1:8080", "http://10.0.0.2:8080", "http://10.0.0.3:8080"],
  token: process.env.CELERIS_TOKEN,
  consistency: "strict",
  timeoutMs: 5_000,
  attempts: 4,
});`}</Code>
      <p>
        A <code>Client</code> is cheap and holds no connection state beyond the preferred node and the latest session token. Create one per
        application and share it.
      </p>
      <Params
        rows={[
          {
            name: "nodes",
            type: "string | string[]",
            desc: (
              <>
                One or more node base URLs. A URL without <code>http://</code> or <code>https://</code> gets <code>http://</code> prepended,
                and trailing slashes are removed. At least one is required.
              </>
            ),
          },
          {
            name: "consistency",
            type: "Consistency",
            def: "server default (strict)",
            desc: (
              <>
                Default mode for reads, writes and scans. Any call can override it. See <DocLink to="consistency">Consistency</DocLink>.
              </>
            ),
          },
          { name: "timeoutMs", type: "number", def: "10000", desc: "Timeout for each individual HTTP request (each attempt), in milliseconds." },
          {
            name: "attempts",
            type: "number",
            def: "4",
            desc: "Total attempts per call, spread across nodes and transient errors. With one node, attempts go to that node again.",
          },
          {
            name: "token",
            type: "string",
            desc: (
              <>
                API token. Sent as <code>Authorization: Bearer ...</code>, and as the <code>access_token</code> query parameter on change
                streams (browsers cannot set headers on a WebSocket).
              </>
            ),
          },
          { name: "headers", type: "Record<string, string>", desc: "Extra headers added to every request, for example a proxy key." },
          {
            name: "fetch",
            type: "typeof fetch",
            def: "globalThis.fetch",
            desc: "A replacement fetch, for tests, instrumentation or runtimes with a special HTTP stack.",
          },
        ]}
      />
      <p>
        The client has no TLS options of its own. It uses the platform trust store, so for a private CA in Node.js set the{" "}
        <code>NODE_EXTRA_CA_CERTS</code> environment variable to the PEM file. See <DocLink to="security">Security</DocLink> for server-side
        TLS.
      </p>

      <H2 id="basics">Read, write, delete</H2>
      <Code lang="ts">{`type User = { name: string; plan: "free" | "pro" };

const written = await db.put<User>("users/42", { name: "Ada", plan: "free" });
console.log(written.version, written.mutationId, written.consistency);

const item = await db.get<User>("users/42");
if (item) console.log(item.value.name, item.version, item.expiresAtMs);

await db.delete("users/42"); // deleting a missing key succeeds
console.log(await db.get("users/42")); // null`}</Code>
      <p>The shapes returned by these calls:</p>
      <Table
        head={["Type", "Fields"]}
        rows={[
          [
            <code key="i">Item&lt;T&gt;</code>,
            <>
              <code>key</code>, <code>value</code> (typed as <code>T</code>), <code>version</code>, <code>expiresAtMs</code> (
              <code>number | null</code>), <code>consistency</code> (the mode the server applied).
            </>,
          ],
          [
            <code key="w">WriteResult</code>,
            <>
              <code>key</code>, <code>version</code> (<code>null</code> while an <code>available</code> write is pending),{" "}
              <code>mutationId</code>, <code>deduplicated</code>, <code>replicated</code>, <code>consistency</code>.
            </>,
          ],
        ]}
      />
      <ul>
        <li>
          <code>get</code> resolves to <code>null</code> when the key does not exist (HTTP 404). Any other error rejects.
        </li>
        <li>
          <code>deduplicated: true</code> means this mutation ID had already committed. The original version is returned and nothing new
          was written.
        </li>
        <li>
          <code>replicated: false</code> means an <code>available</code> write was accepted by a node but is not replicated yet (HTTP 202).
        </li>
        <li>
          Keys are 1 to 1024 bytes of UTF-8. The client percent-encodes each path segment and keeps <code>/</code> readable. Keys with a{" "}
          <code>.</code> or <code>..</code> path segment cannot be addressed over HTTP and are rejected locally with{" "}
          <code>invalid_key</code>.
        </li>
        <li>Values are any JSON value, up to 4 MiB each.</li>
      </ul>

      <H2 id="consistency">Consistency per call</H2>
      <p>
        Every read, write and scan takes a <code>consistency</code> option. Without one the client default applies, and without that the
        server default (<code>strict</code>) applies. The client never weakens a mode you asked for, and every result tells you the mode the
        server actually applied.
      </p>
      <Code lang="ts">{`// Linearizable (the default): goes through the leader
await db.get("accounts/1", { consistency: "strict" });

// Read your own writes from any replica that has caught up
await db.put("cart/ada", { items: 2 });
await db.get("cart/ada", { consistency: "session" });

// Fresh within 500 ms (bounded reads require a staleness bound)
await db.get("stats/today", { consistency: "bounded", maxStalenessMs: 500 });

// Keep working during a partition; conflicts are recorded
const r = await db.put("likes/post-9", 41, { consistency: "available" });
if (!r.replicated) console.log("accepted locally, replication pending");`}</Code>
      <p>
        <strong>Sessions.</strong> In a replicated cluster, every successful write and read returns a <code>celeris-session-index</code>{" "}
        token. The client keeps the latest one (<code>db.session</code>) and sends it automatically on <code>session</code> reads. If the
        replica you reach has not applied your writes yet, the node answers <code>503 session_behind</code>, which the client retries on
        another node. On a single node there is only one replica, so every mode is satisfied by it and no token is needed.
      </p>
      <Callout kind="note">
        <code>bounded</code> describes read freshness only, so writes cannot use it. See <DocLink to="consistency">Consistency</DocLink> for
        what each mode guarantees during a partition.
      </Callout>

      <H2 id="cas-ttl">Compare-and-set and TTL</H2>
      <Code lang="ts">{`// Create only if absent
await db.put("locks/report", { owner: "worker-1" }, { ifAbsent: true, ttlMs: 30_000 });

// Update only if nobody changed it since you read it
const cur = await db.get<{ n: number }>("counters/visits");
await db.put("counters/visits", { n: (cur?.value.n ?? 0) + 1 },
  cur ? { ifVersion: cur.version } : { ifAbsent: true });

// Conditional delete
await db.delete("locks/report", { ifVersion: 7 });`}</Code>
      <p>
        When the condition fails, the call rejects with a <code>CelerisError</code> whose <code>status</code> is 409 and{" "}
        <code>code</code> is <code>condition_failed</code>. <code>details.current_version</code> holds the key{"'"}s present version, or{" "}
        <code>null</code> if it is absent. A condition failure is a clean failure: the write was not applied.
      </p>
      <Code lang="ts" title="Optimistic update helper">{`import { CelerisError } from "@celeris/client";

async function update<T>(key: string, change: (old: T | null) => T, tries = 5): Promise<T> {
  for (let i = 0; i < tries; i++) {
    const cur = await db.get<T>(key);
    const next = change(cur ? cur.value : null);
    try {
      await db.put(key, next, cur ? { ifVersion: cur.version } : { ifAbsent: true });
      return next;
    } catch (e) {
      if (e instanceof CelerisError && e.code === "condition_failed") continue; // lost the race, retry
      throw e;
    }
  }
  throw new Error("too much contention on " + key);
}`}</Code>
      <Callout kind="warn" title="Conditions need strict writes">
        <code>ifVersion</code> and <code>ifAbsent</code> are refused with <code>400 conditions_require_strict</code> on{" "}
        <code>available</code> and <code>eventual</code> writes in a cluster. Use the default mode for conditional writes.
      </Callout>
      <p>
        <code>ttlMs</code> must be at least 1. Expired keys read as absent (<code>get</code> returns <code>null</code>); an item that is
        still alive reports its deadline in <code>expiresAtMs</code>.
      </p>

      <H2 id="batch">Atomic batches</H2>
      <Code lang="ts">{`const r = await db.batch([
  { op: "put", key: "orders/1001", value: { total: 30 }, if_absent: true },
  { op: "put", key: "orders/1001/audit", value: { by: "ada" }, ttl_ms: 86_400_000 },
  { op: "delete", key: "carts/ada", if_version: 12 },
]);
console.log(r.version, r.mutationId);`}</Code>
      <p>
        A batch is all or nothing under one mutation ID and one commit version. Conditions are checked against the state before the batch.
        Note that batch operations use the wire field names <code>ttl_ms</code>, <code>if_version</code> and <code>if_absent</code>.
        Limits: 10,000 operations and 32 MiB of keys plus values per batch. In a replicated cluster all keys must live in one replica set;
        otherwise the node answers <code>400 cross_group_batch</code>.
      </p>

      <H2 id="scan">Scans and queries</H2>
      <H3 id="scan-basic">Scan a range</H3>
      <Code lang="ts">{`// Async iteration: pages are fetched as needed, in key order
for await (const item of db.scan<{ total: number }>({ prefix: "orders/", limit: 200 })) {
  console.log(item.key, item.value.total);
}

// Explicit paging
let after: string | undefined;
do {
  const page = await db.scanPage({ prefix: "orders/", limit: 100 }, after);
  if (page.partial) console.warn("some replica sets did not answer");
  for (const item of page.items) console.log(item.key);
  after = page.nextCursor ?? undefined;
} while (after);`}</Code>
      <p>
        Options are <code>prefix</code>, or <code>start</code> (inclusive) with <code>end</code> (exclusive), plus <code>limit</code>{" "}
        (1 to 1000, server default 100) and <code>consistency</code>. A scan is not a point-in-time snapshot. <code>partial: true</code>{" "}
        means some data may be missing because a replica set was unreachable.
      </p>
      <H3 id="query">Filter on the server</H3>
      <Code lang="ts">{`const paid = { status: "paid", total: { $gte: 100 } };

for await (const item of db.query({ prefix: "orders/", where: paid, fields: ["total"] })) {
  console.log(item.key, item.value);
}

// Order by a field (needs an index declared with that order)
const page = await db.queryPage({
  prefix: "orders/",
  where: { status: "paid" },
  sort: { field: "total", order: "desc" },
  limit: 20,
});
console.log(page.index, page.scanned, page.nextCursor);`}</Code>
      <p>
        Filters use operators <code>$eq $ne $gt $gte $lt $lte $in $nin $exists $prefix $contains</code> combined with{" "}
        <code>$and</code>, <code>$or</code> and <code>$not</code>, and dotted paths such as <code>customer.tier</code>. A page may contain
        fewer than <code>limit</code> items and still carry a <code>nextCursor</code>, because the server stops after{" "}
        <code>maxScanned</code> rows (default 10,000). The iterator <code>db.query</code> keeps following cursors for you. Full operator
        semantics and indexes are on <DocLink to="queries">Queries</DocLink>.
      </p>
      <H3 id="aggregate">Aggregate</H3>
      <Code lang="ts">{`const stats = await db.aggregate({
  prefix: "orders/",
  where: { status: "paid" },
  aggregate: { count: true, sum: ["total"], min: ["created"], max: ["total"] },
});
// { count: 412, sum: { total: 18230.5 }, min: { created: "2026-01-02" }, max: { total: 990 } }`}</Code>
      <p>
        <code>aggregate</code> follows cursors to the end of the range and merges pages for you (counts and sums add, min and max keep the
        extreme). If you page manually with <code>queryPage</code>, merge with the exported <code>mergeAggregates</code>.
      </p>

      <H2 id="watch">Live changes</H2>
      <Code lang="ts">{`const watcher = db.watch<{ total: number }>("orders/", {
  onHello: (h) => console.log("node", h.node, "covers all replica sets:", !h.partial),
  onChange: (e) => console.log(e.kind, e.key, e.value, e.version),
  onLagged: (missed) => console.warn("missed " + missed + " events, re-read"),
  onClose: () => console.log("stream closed"),
  onError: (e) => console.error(e),
});

// later
watcher.close();`}</Code>
      <ul>
        <li>
          The stream opens a WebSocket to one node (the preferred one), carrying <code>?prefix=</code> and, if configured, the token as{" "}
          <code>access_token</code>.
        </li>
        <li>
          Delivery is best-effort and starts at {"“"}now{"”"}. After a <code>lagged</code> notice, re-read whatever you display.
        </li>
        <li>
          The SDK does not reconnect on its own. Handle <code>onClose</code> and open a new watcher (then re-read, since changes in the gap
          are not replayed).
        </li>
        <li>
          In a cluster a node sees the changes of its own replica sets; <code>hello.partial</code> tells you whether others exist. See{" "}
          <DocLink to="change-streams">Change streams</DocLink>.
        </li>
      </ul>

      <H2 id="status">Mutation status, conflicts, node status</H2>
      <Code lang="ts">{`const { committed, version } = await db.mutationStatus("7d1c0e5a-4b8e-4f0a-9a52-3c1f6e2b9d10");

const { conflicts, partial } = await db.conflicts({ prefix: "likes/", limit: 50 });
await db.clearConflicts("likes/post-9");

const status = await db.status(); // node, cluster, partition and storage state`}</Code>
      <p>
        <code>mutationStatus</code> returns <code>committed: false</code> for a mutation that did not commit, is still in flight, or is
        older than the server{"'"}s retention window (<code>mutation_retention_secs</code>, 24 hours by default).{" "}
        <code>conflicts</code> lists writes that lost last-writer-wins under <code>available</code> consistency.
      </p>

      <H2 id="errors">Errors and unknown outcomes</H2>
      <p>The client throws two classes. Both expose the same fields.</p>
      <Table
        head={["Class", "When", "Useful fields"]}
        rows={[
          [
            <code key="c">CelerisError</code>,
            "A node answered with an error, or no node answered (status 0).",
            <>
              <code>status</code>, <code>code</code>, <code>message</code>, <code>details</code>, <code>outcome</code>,{" "}
              <code>mutationId</code>
            </>,
          ],
          [
            <code key="o">OutcomeUnknownError</code>,
            "A write may or may not have committed. Subclass of CelerisError with status 0 and code outcome_unknown.",
            <>
              <code>mutationId</code>
            </>,
          ],
        ]}
      />
      <p>
        <code>CelerisError.outcome</code> is <code>not_applied</code> when the write is known not to have happened and{" "}
        <code>unknown</code> when it may have. The commonly seen codes:
      </p>
      <Table
        head={["Status", "code", "Meaning for you"]}
        rows={[
          ["404", "not_found", "Returned as null by get; thrown by other calls."],
          ["409", "condition_failed", "ifVersion or ifAbsent did not hold. Not applied. Re-read and retry."],
          ["422", "mutation_id_reused", "The same mutation ID was sent with a different payload. A bug in your retry logic."],
          ["400", "invalid_key, invalid_json, invalid_query, invalid_consistency, ...", "Fix the request. Not applied."],
          ["401 / 403", "unauthorized / forbidden", "Missing token, or token scope too small."],
          ["0", "unreachable", "No node answered. For a write, outcome is not_applied."],
          ["0", "outcome_unknown", "Thrown as OutcomeUnknownError. Resolve it as shown below."],
        ]}
      />
      <p>
        The full list is on <DocLink to="errors">Errors</DocLink>.
      </p>
      <H3 id="unknown">Handling an unknown outcome</H3>
      <p>
        An <code>OutcomeUnknownError</code> is thrown after the attempts ran out and at least one request may have reached a node. It is
        never reported as a plain failure. You have two safe choices, and you can combine them: ask what happened, or repeat the write with
        the same mutation ID (the server deduplicates).
      </p>
      <Code lang="ts">{`import { OutcomeUnknownError } from "@celeris/client";

async function putSure(key: string, value: unknown) {
  const mutationId = crypto.randomUUID(); // choose the ID yourself so you can reuse it
  for (let round = 0; round < 3; round++) {
    try {
      return await db.put(key, value, { mutationId });
    } catch (e) {
      if (!(e instanceof OutcomeUnknownError)) throw e;
      const s = await db.mutationStatus(e.mutationId);
      if (s.committed) return { version: s.version, mutationId, deduplicated: true };
      // not committed, in flight, or too old: retrying with the SAME id is still safe
    }
  }
  throw new Error("write " + mutationId + " is still unresolved; keep the ID and check later");
}`}</Code>
      <Callout kind="warn">
        Never treat an unknown outcome as a failure and write a different value to {"“"}fix{"”"} it. Never retry with a new
        mutation ID, because that can apply the write twice.
      </Callout>

      <H2 id="retries">Retries, redirects and mutation IDs</H2>
      <p>
        You do not write retry loops for transport problems; the client does. Every write carries a mutation ID in the{" "}
        <code>celeris-mutation-id</code> header (a UUID; a batch also puts it in the body). Retries reuse it, which is what makes them safe.
      </p>
      <Table
        head={["What the client sees", "What it does"]}
        rows={[
          [
            <>
              <code>421</code> with code <code>not_leader</code>, <code>not_owner</code> or <code>partition_moved</code>
            </>,
            "Tries the next node at once, same mutation ID. Not a failure.",
          ],
          [
            <>
              <code>503</code> with <code>proposal_lost</code>, <code>partition_moving</code>, <code>read_retry</code>,{" "}
              <code>read_timeout</code>, <code>session_behind</code>, <code>no_partition_map</code> or <code>epoch_ahead</code>
            </>,
            "These guarantee nothing was applied. Sleeps briefly (about 100 ms times the attempt number for writes, 50 ms for reads), then tries the next node.",
          ],
          [
            "Network error or timeout while sending a write",
            "The request may have arrived. Retries with the same ID and remembers that the outcome might be unknown.",
          ],
          [
            <>
              A write error with <code>outcome: unknown</code> (such as <code>500 outcome_unknown</code>)
            </>,
            "Retries with the same ID; if it never resolves, throws OutcomeUnknownError.",
          ],
          ["Any other error (400, 409, 422, 401...)", "Thrown immediately. Retrying cannot change the answer."],
          [
            "Reads and other idempotent calls",
            "Retried on any failure, across nodes, with no mutation ID.",
          ],
        ]}
      />
      <p>
        After a success the client remembers which node answered and starts there next time, and it stores the latest session token. The
        attempts rotate through the node list starting at that node, so list every node you can reach.
      </p>
      <RetryTimeline />

      <H2 id="typed">Typed values</H2>
      <p>
        <code>get</code>, <code>put</code>, <code>scan</code>, <code>query</code>, <code>watch</code> and their page variants are generic
        over the value type. The type is a compile-time promise: the client does not validate what the server returns.
      </p>
      <Code lang="ts">{`interface Order { id: string; total: number; status: "open" | "paid" }

const o = await db.get<Order>("orders/1001");
for await (const it of db.query<Order>({ prefix: "orders/", where: { status: "paid" } })) {
  it.value.total.toFixed(2);
}`}</Code>
      <p>
        For data that crosses a trust boundary, parse it with a schema library (zod, valibot) after reading. A document written by another
        service may not match your interface.
      </p>

      <H2 id="react">React: useCeleris</H2>
      <p>
        <code>useCeleris(client, key, options?)</code> reads the key once, then follows it through the change stream. It never moves
        backwards in version and re-reads after a <code>lagged</code> notice. It needs React 18 or newer (it uses{" "}
        <code>useSyncExternalStore</code>).
      </p>
      <Code lang="tsx" title="Profile.tsx">{`import { Client } from "@celeris/client";
import { useCeleris } from "@celeris/client/react";

// Create the client ONCE, outside components
export const db = new Client({ nodes: "http://127.0.0.1:8080" });

interface User { name: string; plan: string }

export function Profile({ id }: { id: string }) {
  const { data, version, loading, error, refresh } = useCeleris<User>(db, "users/" + id);

  if (loading) return <p>Loading...</p>;
  if (error) return <p role="alert">Could not load: {String(error)}</p>;
  if (data === null) return <p>No such user.</p>;

  return (
    <section>
      <h1>{data.name}</h1>
      <p>Plan: {data.plan} (v{version})</p>
      <button onClick={() => db.put("users/" + id, { ...data, plan: "pro" })}>Upgrade</button>
      <button onClick={refresh}>Refresh</button>
    </section>
  );
}`}</Code>
      <Params
        rows={[
          { name: "client", type: "Client", desc: "A shared client. It must be a stable reference (see the warning below)." },
          { name: "key", type: "string", desc: "Exact key to follow. The hook watches by prefix internally and ignores other keys." },
          { name: "options.consistency", type: "Consistency", desc: "Mode for the initial read and for re-reads." },
          { name: "options.live", type: "boolean", def: "true", desc: "Set false for a one-time read with no change stream." },
        ]}
      />
      <p>
        The result is <code>{"{ data, version, loading, error, refresh }"}</code>. <code>data</code> is <code>null</code> when the key does
        not exist (or after a delete event).
      </p>
      <Callout kind="warn" title="Rules for the hook">
        <ul>
          <li>
            Do not construct <code>new Client(...)</code> inside a component body. A new client on every render creates a new store and a
            new WebSocket every time.
          </li>
          <li>
            The store starts its read and its WebSocket as soon as it is created, which is during render. Use the hook in client-only
            components. In server-rendered frameworks (Next.js, Remix), mark the component as a client component and do not render it on
            the server.
          </li>
          <li>
            In React StrictMode during development, the hook can create an extra store that is discarded without being closed. That affects
            development builds only.
          </li>
          <li>
            Each hook instance opens its own change stream. For a long list of rows, subscribe once with a prefix <code>watch</code> and
            keep a map in state instead.
          </li>
        </ul>
      </Callout>
      <p>
        Without React, use the same logic directly: <code>createKeyStore(client, key, options)</code> returns{" "}
        <code>{"{ getSnapshot, subscribe, refresh, close }"}</code> and has no framework dependency. A Svelte or Vue wrapper is a few
        lines around <code>subscribe</code> and <code>getSnapshot</code>.
      </p>

      <H2 id="browser">Browser and Node.js</H2>
      <Table
        head={["", "Node.js 22+", "Browser"]}
        rows={[
          ["HTTP", "global fetch", "fetch (CORS applies)"],
          ["Change streams", "global WebSocket", "WebSocket"],
          ["Token on streams", "query parameter access_token", "query parameter access_token (headers cannot be set)"],
          ["Private CA", "NODE_EXTRA_CA_CERTS", "Install the CA in the OS or browser trust store"],
          ["Timeouts", "AbortController, per attempt", "same"],
        ]}
      />
      <H3 id="cors">CORS</H3>
      <p>
        CORS is off by default. A web page served from another origin can only call the API after you list its origin on the node (the
        node answers preflights and exposes the <code>celeris-mutation-id</code>, <code>celeris-version</code> and{" "}
        <code>celeris-consistency</code> response headers):
      </p>
      <OsCode
        linux={`export CELERIS_CORS_ORIGINS=http://localhost:5173,https://app.example.com
celeris start`}
        macos={`export CELERIS_CORS_ORIGINS=http://localhost:5173,https://app.example.com
celeris start`}
        windows={`$env:CELERIS_CORS_ORIGINS = "http://localhost:5173,https://app.example.com"
celeris start`}
      />
      <p>
        The same setting exists in <code>celeris.toml</code> as <code>[http] cors_origins</code>. Avoid <code>{'"*"'}</code> in
        production.
      </p>
      <Callout kind="warn" title="Cross-origin limits to know about">
        <ul>
          <li>
            The node does not list <code>celeris-session-index</code> among the exposed response headers, so a cross-origin page cannot read
            the session token and <code>session</code> reads cannot track your writes. If you rely on session consistency in a browser,
            serve the page and the API from one origin through a reverse proxy.
          </li>
          <li>
            Browsers do not treat a wildcard <code>Access-Control-Allow-Headers</code> as covering <code>Authorization</code>, and the node
            answers with a wildcard. If a cross-origin request with a token fails in the preflight, use the same-origin proxy setup.
            Test this in your target browsers before depending on it.
          </li>
        </ul>
      </Callout>
      <H3 id="browser-tokens">Tokens in browsers</H3>
      <Callout kind="danger" title="Anything in a browser bundle is public">
        A token passed to <code>new Client</code> in client-side code (including values from <code>VITE_*</code> or{" "}
        <code>NEXT_PUBLIC_*</code> variables) can be read by every visitor. Never ship a token with the <code>admin</code> scope to a
        browser. Admin endpoints are able to shut down or rebalance the cluster.
      </Callout>
      <ul>
        <li>
          Use a dedicated token with only the <code>read</code> scope for public pages, and <code>read,write</code> only when users are
          allowed to write everything under that token{"'"}s reach. CelerisDB tokens have scopes but no per-key permissions.
        </li>
        <li>
          For per-user rules, put your own backend in front: the browser talks to your server, and your server holds the token and uses
          the SDK. This is the usual setup for anything with real access control.
        </li>
        <li>
          Create tokens with <code>celeris token create web --scope read</code>; nodes store only the SHA-256 of each token. More on{" "}
          <DocLink to="security">Security</DocLink>.
        </li>
        <li>
          A token passed to <code>watch</code> appears in the WebSocket URL, and URLs can end up in proxy and server logs. Use a
          short-lived, read-only token for streams.
        </li>
      </ul>

      <H2 id="testing">Testing</H2>
      <H3 id="testing-mock">Unit tests with a fake fetch</H3>
      <p>
        The <code>fetch</code> option lets you test your code, including the retry behaviour, without a node. This test uses the built-in
        Node.js test runner.
      </p>
      <Code lang="js" title="retry.test.mjs">{`import assert from "node:assert/strict";
import { test } from "node:test";
import { Client } from "@celeris/client";

test("a write is retried on another node with the same mutation id", async () => {
  const seen = [];
  const fakeFetch = async (url, init) => {
    seen.push({ url, id: init.headers["celeris-mutation-id"] });
    if (seen.length === 1) {
      return new Response(JSON.stringify({ error: { code: "not_leader", message: "ask node-b" } }), { status: 421 });
    }
    return new Response(JSON.stringify({ key: "k", version: 3, mutation_id: seen[0].id, consistency: "strict" }), {
      status: 200,
      headers: { "celeris-session-index": "9@g1" },
    });
  };

  const db = new Client({ nodes: ["http://a:8080", "http://b:8080"], fetch: fakeFetch });
  const r = await db.put("k", 1);

  assert.equal(r.version, 3);
  assert.equal(seen.length, 2);
  assert.equal(seen[0].id, seen[1].id);
  assert.notEqual(seen[0].url, seen[1].url);
  assert.equal(db.session, "9@g1");
});`}</Code>
      <H3 id="testing-real">Integration tests against a real node</H3>
      <p>
        Start a throwaway node per test run so tests see the real server behaviour (conditions, TTL, queries). The SDK{"'"}s own test suite
        does exactly this: it runs <code>celeris init --dir TMP --listen 127.0.0.1:PORT</code> and then{" "}
        <code>celeris start --config TMP/celeris.toml</code> with <code>CELERIS_SYNC=never</code> (faster, fine for tests), polls{" "}
        <code>/health</code>, and removes the folder afterwards. For cluster behaviour such as redirects, run the compose cluster:
      </p>
      <Code lang="bash">{`docker compose up -d --build        # nodes on 8081, 8082, 8083
# then: new Client({ nodes: ["http://127.0.0.1:8081", "http://127.0.0.1:8082", "http://127.0.0.1:8083"] })`}</Code>

      <H2 id="example">A complete small app</H2>
      <p>
        A runnable script that exercises the main features. It needs Node.js 22+, the package installed as described above, and a node on
        port 8080. Save it as <code>app.mjs</code>.
      </p>
      <Code lang="js" title="app.mjs">{`import { CelerisError, Client, OutcomeUnknownError } from "@celeris/client";

const db = new Client({
  nodes: (process.env.CELERIS_NODES ?? "http://127.0.0.1:8080").split(","),
  token: process.env.CELERIS_TOKEN,
});

// 1. Write, with a TTL and a condition
await db.put("sessions/abc", { user: "ada" }, { ttlMs: 60_000 });

// 2. Optimistic counter
async function bump(key) {
  for (let i = 0; i < 5; i++) {
    const cur = await db.get(key);
    const n = (cur?.value ?? 0) + 1;
    try {
      await db.put(key, n, cur ? { ifVersion: cur.version } : { ifAbsent: true });
      return n;
    } catch (e) {
      if (e instanceof CelerisError && e.code === "condition_failed") continue;
      throw e;
    }
  }
  throw new Error("contention");
}
console.log("visits:", await bump("counters/visits"));

// 3. Watch orders and write one once the stream is open
const watcher = db.watch("orders/", {
  onHello: async () => {
    await db.batch([
      { op: "put", key: "orders/1", value: { total: 120, status: "paid" } },
      { op: "put", key: "orders/2", value: { total: 40, status: "open" } },
    ]);
  },
  onChange: (e) => console.log("change:", e.kind, e.key, JSON.stringify(e.value)),
  onError: (e) => console.error("stream error", e),
});

// 4. Query, then clean up
await new Promise((r) => setTimeout(r, 1000));
for await (const it of db.query({ prefix: "orders/", where: { total: { $gte: 100 } } })) {
  console.log("big order:", it.key, it.value);
}
const stats = await db.aggregate({ prefix: "orders/", aggregate: { count: true, sum: ["total"] } });
console.log("stats:", stats);
watcher.close();

// 5. Report unknown outcomes properly
try {
  await db.delete("orders/1");
  await db.delete("orders/2");
} catch (e) {
  if (e instanceof OutcomeUnknownError) console.error("unresolved, mutation id", e.mutationId);
  else throw e;
}`}</Code>
      <OsCode
        linux={`node app.mjs`}
        macos={`node app.mjs`}
        windows={`node app.mjs`}
        title="run"
      />
      <p>
        With auth enabled, set the token first: <code>export CELERIS_TOKEN=...</code> on Linux and macOS, or{" "}
        <code>{'$env:CELERIS_TOKEN = "..."'}</code> in PowerShell.
      </p>

      <H2 id="troubleshooting">Troubleshooting</H2>
      <Details summary="TypeError: fetch failed, or CelerisError code unreachable">
        No node answered. Check the URL and port, that the node listens on a reachable address (the default is <code>127.0.0.1</code>; use{" "}
        <code>0.0.0.0:8080</code> for remote clients), and firewalls. <code>celeris doctor</code> checks a node from the machine it runs on.
      </Details>
      <Details summary="WebSocket is not defined">
        Your Node.js is older than 22. Upgrade it: <code>watch</code> uses the global <code>WebSocket</code>, which older versions do not
        provide.
      </Details>
      <Details summary="Cannot find module '@celeris/client' or missing dist files">
        The package has to be built (<code>npm run build</code> in <code>sdks/typescript</code>) before it is installed, because only{" "}
        <code>dist/</code> is published in the package.
      </Details>
      <Details summary="401 unauthorized or 403 forbidden">
        Authentication is on. Pass <code>token</code> to the client. A <code>403</code> means the token lacks the scope (read, write, admin)
        the call needs.
      </Details>
      <Details summary="Browser: blocked by CORS policy">
        Add the page{"'"}s origin to <code>CELERIS_CORS_ORIGINS</code> and restart the node. See the limits in the CORS section above.
      </Details>
      <Details summary="400 invalid_key for a key that looks fine">
        Keys with a path segment of exactly <code>.</code> or <code>..</code> are rejected, as are empty or oversized keys (over 1024 bytes).
      </Details>
      <Details summary="Scan or query returns fewer rows than expected">
        Check <code>page.partial</code> (a replica set was unreachable) and keep following <code>nextCursor</code>; a filtered page can be
        short while more pages remain.
      </Details>
      <Details summary="422 mutation_id_reused">
        You passed the same <code>mutationId</code> to two writes with different content. Reuse an ID only to retry the identical write.
      </Details>

      <H2 id="next">Next steps</H2>
      <ul>
        <li>
          <DocLink to="consistency">Consistency</DocLink> to choose a mode per call.
        </li>
        <li>
          <DocLink to="queries">Queries</DocLink> for filters, indexes, sorting and aggregates.
        </li>
        <li>
          <DocLink to="frameworks">Frameworks</DocLink> for Next.js and other integration patterns built on this SDK.
        </li>
        <li>
          <DocLink to="sdk-http">HTTP from any language</DocLink> to see exactly what the client sends.
        </li>
      </ul>
    </>
  );
}

export const page: DocPage = {
  slug: "sdk-typescript",
  title: "TypeScript and React",
  group: "SDKs",
  summary: "Use the TypeScript client in Node.js and browsers, with typed values, safe retries and the useCeleris React hook.",
  keywords: ["javascript", "node", "nodejs", "npm", "react", "hook", "useCeleris", "browser", "fetch", "websocket", "cors", "client", "sdk"],
  Body,
};
