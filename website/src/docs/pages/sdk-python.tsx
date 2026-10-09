import { Callout, Code, CodeTabs, Details, DocLink, H2, H3, OsCode, Params, Table, type DocPage } from "../kit";

function Body() {
  return (
    <>
      <p>
        <code>celeris-client</code> is the Python client for CelerisDB. It needs Python 3.10 or newer and has <strong>no dependencies</strong>:
        HTTP uses <code>http.client</code> from the standard library, and change streams use a small WebSocket client that ships inside the
        package. The import name is <code>celeris</code>.
      </p>

      <Callout kind="note" title="Packaging status">
        The package is not on PyPI yet. Install it from the git repository or from a local clone (shown below). The client is synchronous
        and blocking; there is no asyncio API. Everything here comes from <code>sdks/python</code> in the repository (version{" "}
        <code>0.1.0</code>).
      </Callout>

      <H2 id="install">Install</H2>
      <p>Create a virtual environment first, then install straight from GitHub. The package lives in the <code>sdks/python</code> subdirectory.</p>
      <OsCode
        linux={`python3 -m venv .venv
source .venv/bin/activate
pip install "git+https://github.com/vinitpatil519/CelerisDB.git#subdirectory=sdks/python"`}
        macos={`python3 -m venv .venv
source .venv/bin/activate
pip install "git+https://github.com/vinitpatil519/CelerisDB.git#subdirectory=sdks/python"`}
        windows={`py -3 -m venv .venv
.venv\\Scripts\\Activate.ps1
pip install "git+https://github.com/vinitpatil519/CelerisDB.git#subdirectory=sdks/python"`}
      />
      <p>
        If PowerShell refuses to run <code>Activate.ps1</code>, allow scripts for the current session with{" "}
        <code>Set-ExecutionPolicy -Scope Process RemoteSigned</code>, or call <code>.venv\Scripts\python.exe -m pip ...</code> directly.
      </p>
      <CodeTabs
        group="py-pm"
        items={[
          {
            id: "pip",
            label: "pip / requirements.txt",
            lang: "text",
            title: "requirements.txt",
            code: "celeris-client @ git+https://github.com/vinitpatil519/CelerisDB.git#subdirectory=sdks/python",
          },
          {
            id: "uv",
            label: "uv",
            lang: "bash",
            code: 'uv add "celeris-client @ git+https://github.com/vinitpatil519/CelerisDB.git#subdirectory=sdks/python"',
          },
          {
            id: "local",
            label: "Local clone",
            lang: "bash",
            code: `git clone https://github.com/vinitpatil519/CelerisDB.git
pip install ./CelerisDB/sdks/python          # add -e for an editable install`,
          },
        ]}
      />
      <p>
        For reproducible builds, pin a commit: append <code>@COMMIT_SHA</code> after the repository URL (before the <code>#</code>). Check the
        install:
      </p>
      <Code lang="py">{`import celeris
print(celeris.__version__)   # 0.1.0`}</Code>

      <H2 id="node">A node to talk to</H2>
      <p>
        The examples assume a node on <code>127.0.0.1:8080</code>. Start one from the built binary (see{" "}
        <DocLink to="installation">Installation</DocLink>):
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
        Or run the three-node cluster from the repository with <code>docker compose up -d --build</code>, which listens on ports 8081, 8082
        and 8083.
      </p>

      <H2 id="client">Create a client</H2>
      <Code lang="py">{`from celeris import Client

db = Client("http://127.0.0.1:8080")

cluster = Client(
    ["http://10.0.0.1:8080", "http://10.0.0.2:8080", "http://10.0.0.3:8080"],
    token="cel_...",
    consistency="strict",
    timeout=5.0,
    attempts=4,
)`}</Code>
      <p>
        The first argument is positional; every other option is keyword-only. A node URL without a scheme gets <code>http://</code>, and
        trailing slashes are removed.
      </p>
      <Params
        rows={[
          { name: "nodes", type: "str | Sequence[str]", desc: "One node URL or a list of them. At least one is required (otherwise ValueError)." },
          {
            name: "consistency",
            type: "Consistency | None",
            def: "None (server default: strict)",
            desc: (
              <>
                Default mode for reads, writes and scans. One of <code>strict</code>, <code>session</code>, <code>bounded</code>,{" "}
                <code>available</code>, <code>eventual</code>.
              </>
            ),
          },
          { name: "timeout", type: "float", def: "10.0", desc: "Socket timeout in seconds for each attempt." },
          { name: "attempts", type: "int", def: "4", desc: "Total attempts per call across nodes and transient errors." },
          {
            name: "headers",
            type: "Mapping[str, str]",
            desc: "Extra headers on every request, including the change-stream handshake.",
          },
          {
            name: "token",
            type: "str | None",
            desc: (
              <>
                API token, sent as <code>Authorization: Bearer ...</code> on every request and on the change-stream handshake.
              </>
            ),
          },
        ]}
      />
      <Callout kind="note">
        The client opens a new connection for each request and closes it afterwards (no keep-alive pooling). That is simple and robust, but
        for very high request rates, run several worker processes or threads instead of expecting connection reuse. One client can be shared
        by threads: its only mutable state is the preferred node index and the session token.
      </Callout>
      <p>
        <strong>TLS.</strong> For <code>https://</code> nodes the client uses Python{"'"}s default certificate verification. For a private CA,
        set <code>SSL_CERT_FILE</code> to the PEM file before starting Python. The client has no argument for a custom SSL context. See{" "}
        <DocLink to="security">Security</DocLink> for server-side TLS.
      </p>

      <H2 id="basics">Read, write, delete</H2>
      <Code lang="py">{`written = db.put("users/42", {"name": "Ada", "plan": "free"})
print(written.version, written.mutation_id, written.consistency)

item = db.get("users/42")
if item is not None:
    print(item.value["name"], item.version, item.expires_at_ms)

db.delete("users/42")          # deleting a missing key succeeds
assert db.get("users/42") is None`}</Code>
      <Table
        head={["Type", "Fields"]}
        rows={[
          [
            <code key="i">Item</code>,
            <>
              <code>key</code>, <code>value</code>, <code>version</code>, <code>expires_at_ms</code> (<code>int | None</code>),{" "}
              <code>consistency</code> (mode the server applied). A frozen dataclass.
            </>,
          ],
          [
            <code key="w">WriteResult</code>,
            <>
              <code>key</code>, <code>version</code> (<code>None</code> while an <code>available</code> write is pending),{" "}
              <code>mutation_id</code>, <code>deduplicated</code>, <code>replicated</code>, <code>consistency</code>.
            </>,
          ],
        ]}
      />
      <ul>
        <li>
          <code>get</code> returns <code>None</code> for a missing key.
        </li>
        <li>
          <code>put</code> accepts anything <code>json.dumps</code> can serialize. Keys are 1 to 1024 bytes of UTF-8; values up to 4 MiB.
        </li>
        <li>
          Keys with a <code>.</code> or <code>..</code> path segment raise <code>CelerisError</code> with code <code>invalid_key</code>{" "}
          before any request is made.
        </li>
        <li>
          <code>deduplicated=True</code> means this mutation ID had already committed; <code>replicated=False</code> means an{" "}
          <code>available</code> write is accepted but not yet replicated (HTTP 202).
        </li>
      </ul>

      <H2 id="consistency">Consistency per call</H2>
      <Code lang="py">{`db.get("accounts/1", consistency="strict")               # linearizable (server default)

db.put("cart/ada", {"items": 2})
db.get("cart/ada", consistency="session")                 # read your own writes

db.get("stats/today", consistency="bounded", max_staleness_ms=500)

r = db.put("likes/post-9", 41, consistency="available")   # keep working in a partition
if not r.replicated:
    print("accepted locally, replication pending")`}</Code>
      <p>
        Without a per-call value the client default applies, and without that the server default (<code>strict</code>). The client never
        weakens a mode, and each result reports the mode that was applied. <code>bounded</code> needs <code>max_staleness_ms</code> and
        applies to reads only.
      </p>
      <p>
        <strong>Sessions.</strong> In a replicated cluster, writes and reads return a <code>celeris-session-index</code> token. The client
        keeps the latest in <code>db.session</code> and sends it with <code>session</code> reads automatically. A replica that is behind
        answers <code>503 session_behind</code> and the client retries on another node. See{" "}
        <DocLink to="consistency">Consistency</DocLink> for what each mode means during a partition.
      </p>

      <H2 id="cas-ttl">Compare-and-set and TTL</H2>
      <Code lang="py">{`from celeris import CelerisError

# Create only if absent, expiring after 30 seconds
db.put("locks/report", {"owner": "worker-1"}, if_absent=True, ttl_ms=30_000)

# Optimistic counter
def bump(key: str, tries: int = 5) -> int:
    for _ in range(tries):
        cur = db.get(key)
        n = (cur.value if cur else 0) + 1
        try:
            if cur:
                db.put(key, n, if_version=cur.version)
            else:
                db.put(key, n, if_absent=True)
            return n
        except CelerisError as e:
            if e.code == "condition_failed":
                continue            # someone else wrote first
            raise
    raise RuntimeError("too much contention on " + key)

db.delete("locks/report", if_version=7)   # conditional delete`}</Code>
      <p>
        A failed condition raises <code>CelerisError</code> with <code>status == 409</code>, <code>code == "condition_failed"</code> and{" "}
        <code>details["current_version"]</code> (the key{"'"}s version, or <code>None</code> if absent). It is a clean failure: nothing was
        written.
      </p>
      <Callout kind="warn" title="Conditions need strict writes">
        In a cluster, <code>if_version</code> and <code>if_absent</code> are refused with <code>400 conditions_require_strict</code> on{" "}
        <code>available</code> and <code>eventual</code> writes.
      </Callout>

      <H2 id="batch">Atomic batches</H2>
      <Code lang="py">{`r = db.batch([
    {"op": "put", "key": "orders/1001", "value": {"total": 30}, "if_absent": True},
    {"op": "put", "key": "orders/1001/audit", "value": {"by": "ada"}, "ttl_ms": 86_400_000},
    {"op": "delete", "key": "carts/ada", "if_version": 12},
])
print(r.version, r.mutation_id)`}</Code>
      <p>
        All operations commit together or not at all, under one mutation ID and one version. Conditions are checked against the state before
        the batch. Limits: 10,000 operations and 32 MiB per batch. In a replicated cluster all keys must belong to one replica set (
        <code>400 cross_group_batch</code> otherwise). <code>batch</code> also accepts <code>consistency=</code> and{" "}
        <code>mutation_id=</code>.
      </p>

      <H2 id="scan">Scans and queries</H2>
      <Code lang="py">{`# Iterate everything under a prefix, in key order. Pages are fetched as needed.
for item in db.scan(prefix="orders/", limit=200):
    print(item.key, item.value)

# Manual paging
after = None
while True:
    page = db.scan_page(prefix="orders/", limit=100, after=after)
    if page.partial:
        print("some replica sets did not answer")
    for item in page.items:
        print(item.key)
    if page.next_cursor is None:
        break
    after = page.next_cursor`}</Code>
      <p>
        Keyword arguments: <code>prefix</code>, or <code>start</code> (inclusive) with <code>end</code> (exclusive); <code>limit</code> (1
        to 1000); <code>consistency</code>. <code>db.scan(...)</code> accepts everything <code>scan_page</code> does except <code>after</code>
        . A scan is not a point-in-time snapshot.
      </p>
      <H3 id="query">Filter on the server</H3>
      <Code lang="py">{`paid = {"status": "paid", "total": {"$gte": 100}}

for item in db.query(prefix="orders/", where=paid, fields=["total"]):
    print(item.key, item.value)

# Ordered by a field (needs an index declared with that order)
page = db.query_page(
    prefix="orders/",
    where={"status": "paid"},
    sort={"field": "total", "order": "desc"},
    limit=20,
)
print(page.index, page.scanned, page.next_cursor)`}</Code>
      <p>
        Operators: <code>$eq $ne $gt $gte $lt $lte $in $nin $exists $prefix $contains</code>, combined with <code>$and</code>,{" "}
        <code>$or</code> and <code>$not</code>; dotted paths reach nested fields. A page can hold fewer than <code>limit</code> items and
        still have a <code>next_cursor</code>, because the server stops after <code>max_scanned</code> rows (default 10,000);{" "}
        <code>db.query()</code> follows cursors for you. <code>QueryPage</code> adds <code>scanned</code>, <code>index</code> (the
        secondary index used, or <code>None</code>) and <code>aggregates</code>. See <DocLink to="queries">Queries</DocLink>.
      </p>
      <H3 id="aggregate">Aggregate</H3>
      <Code lang="py">{`stats = db.aggregate(
    {"count": True, "sum": ["total"], "min": ["created"], "max": ["total"]},
    prefix="orders/",
    where={"status": "paid"},
)
# {'count': 412, 'sum': {'total': 18230.5}, 'min': {'created': '2026-01-02'}, 'max': {'total': 990}}`}</Code>
      <p>
        <code>aggregate</code> takes the aggregate spec as its first argument, follows cursors to the end, and merges pages. If you page
        manually with <code>query_page(aggregate=...)</code>, merge with <code>celeris.merge_aggregates(total, page)</code>.
      </p>

      <H2 id="watch">Live changes</H2>
      <Code lang="py">{`with db.watch("orders/") as w:
    print(w.hello)                    # {'type': 'hello', 'node': ..., 'groups': [...], 'partial': False}
    for event in w:                   # blocks until the stream closes
        print(event.kind, event.key, event.value, event.version)
        if w.lagged:
            print("missed", w.lagged, "events: re-read what you show")`}</Code>
      <ul>
        <li>
          <code>watch(prefix="", *, timeout=None)</code> opens a WebSocket (<code>wss://</code> for https nodes) to the preferred node. The
          returned <code>Watch</code> has <code>hello</code>, a running <code>lagged</code> counter, <code>next(timeout=None)</code> and{" "}
          <code>close()</code>, and works as a context manager and iterator.
        </li>
        <li>
          <code>w.next(timeout=5)</code> returns a <code>ChangeEvent</code>, returns <code>None</code> if the stream closed, and raises{" "}
          <code>TimeoutError</code> if nothing arrives in time.
        </li>
        <li>
          Delivery is best-effort and starts at {"“"}now{"”"}. There is no automatic reconnect; reopen and re-read after a drop.
        </li>
        <li>
          A node reports the changes of its own replica sets. Check <code>w.hello["partial"]</code>. See{" "}
          <DocLink to="change-streams">Change streams</DocLink>.
        </li>
      </ul>
      <p>
        Because iteration blocks, run a watcher in its own thread, or use <code>asyncio.to_thread</code> inside an async program.
      </p>

      <H2 id="status">Mutation status, conflicts, node status</H2>
      <Code lang="py">{`committed, version = db.mutation_status("7d1c0e5a-4b8e-4f0a-9a52-3c1f6e2b9d10")

result = db.conflicts(prefix="likes/", limit=50)   # {'conflicts': [...], 'partial': False}
db.clear_conflicts("likes/post-9")

print(db.status())                                  # node, cluster, partition and storage state`}</Code>
      <p>
        <code>mutation_status</code> returns <code>(committed, version)</code>. <code>(False, None)</code> means the mutation did not commit,
        is still in flight, or is older than the retention window (24 hours by default).
      </p>

      <H2 id="errors">Errors and unknown outcomes</H2>
      <Table
        head={["Exception", "When", "Attributes"]}
        rows={[
          [
            <code key="c">CelerisError</code>,
            "A node answered with an error, or no node answered (status 0, code unreachable).",
            <>
              <code>status</code>, <code>code</code>, <code>details</code>, <code>outcome</code> (<code>"not_applied"</code>,{" "}
              <code>"unknown"</code> or <code>None</code>), <code>mutation_id</code>
            </>,
          ],
          [
            <code key="o">OutcomeUnknownError</code>,
            "A write may or may not have committed. A subclass of CelerisError (status 0, code outcome_unknown).",
            <>
              <code>mutation_id</code>
            </>,
          ],
        ]}
      />
      <Table
        head={["Status", "code", "Meaning for you"]}
        rows={[
          ["409", "condition_failed", "if_version or if_absent did not hold. Not applied."],
          ["422", "mutation_id_reused", "Same mutation ID, different payload. A bug in your retry logic."],
          ["400", "invalid_key, invalid_json, invalid_query, invalid_consistency, ...", "Fix the request. Not applied."],
          ["401 / 403", "unauthorized / forbidden", "Missing token, or token scope too small."],
          ["0", "unreachable", "No node answered; for a write, outcome is not_applied."],
        ]}
      />
      <p>
        See <DocLink to="errors">Errors</DocLink> for every code.
      </p>
      <H3 id="unknown">Handling an unknown outcome</H3>
      <p>
        <code>OutcomeUnknownError</code> means the request may have reached a node and no answer confirmed it. A connection that could not be
        opened at all is known not to have applied anything, so it surfaces as a normal <code>CelerisError</code> with{" "}
        <code>outcome == "not_applied"</code>. For unknown outcomes: choose the mutation ID yourself, then ask the server or repeat the write
        with the same ID.
      </p>
      <Code lang="py">{`import uuid
from celeris import OutcomeUnknownError

def put_sure(key, value, rounds=3):
    mutation_id = str(uuid.uuid4())
    for _ in range(rounds):
        try:
            return db.put(key, value, mutation_id=mutation_id)
        except OutcomeUnknownError as e:
            committed, version = db.mutation_status(e.mutation_id)
            if committed:
                return version
            # not committed, in flight, or too old: retrying with the SAME id is safe
    raise RuntimeError(f"write {mutation_id} unresolved; keep the id and check later")`}</Code>
      <Callout kind="warn">
        Do not retry an unknown outcome with a fresh mutation ID, and do not treat it as a failure and write something else. Either can
        apply the change twice.
      </Callout>

      <H2 id="retries">Retries, redirects and mutation IDs</H2>
      <p>
        Every write sends a UUID in the <code>celeris-mutation-id</code> header (batches also carry it in the body). The client reuses it
        for every retry, which makes retries safe because the server deduplicates.
      </p>
      <Table
        head={["What the client sees", "What it does"]}
        rows={[
          [
            <>
              <code>421</code> with <code>not_leader</code>, <code>not_owner</code> or <code>partition_moved</code>
            </>,
            "Next node immediately, same mutation ID.",
          ],
          [
            <>
              <code>503</code> with <code>proposal_lost</code>, <code>partition_moving</code>, <code>read_retry</code>,{" "}
              <code>read_timeout</code>, <code>session_behind</code>, <code>no_partition_map</code>, <code>epoch_ahead</code>
            </>,
            "Guaranteed not applied. Short randomized backoff (about 100 ms per attempt for writes, 50 ms for reads), then the next node.",
          ],
          [
            "Connection could not be opened",
            "Known not sent. Retries on the next node. If every attempt fails this way, CelerisError (not_applied).",
          ],
          [
            "Timeout or reset after the request was sent",
            "Might have been applied. Retries with the same ID; if it never confirms, OutcomeUnknownError.",
          ],
          [
            <>
              Write error with <code>outcome: unknown</code>
            </>,
            "Retries with the same ID, then OutcomeUnknownError.",
          ],
          ["Other 4xx or 5xx", "Raised at once as CelerisError."],
          ["Reads and other idempotent calls", "Retried on any failure, with no mutation ID."],
        ]}
      />
      <p>
        See the animated walkthrough on the <DocLink to="sdk-typescript:retries">TypeScript page</DocLink>; the rules are identical in every
        SDK. After a success the client starts its next call at the node that answered, and rotates through your list on failure, so list
        all reachable nodes.
      </p>

      <H2 id="typed">Typed values</H2>
      <p>
        Values come back as plain Python objects (<code>dict</code>, <code>list</code>, numbers, strings). The SDK does not impose a
        schema, so map them yourself.
      </p>
      <CodeTabs
        group="py-typed"
        items={[
          {
            id: "dc",
            label: "dataclass",
            lang: "py",
            code: `from dataclasses import dataclass, asdict

@dataclass
class User:
    name: str
    plan: str = "free"

db.put("users/42", asdict(User(name="Ada")))
item = db.get("users/42")
user = User(**item.value) if item else None`,
          },
          {
            id: "td",
            label: "TypedDict",
            lang: "py",
            code: `from typing import TypedDict, cast

class User(TypedDict):
    name: str
    plan: str

item = db.get("users/42")
user = cast(User, item.value) if item else None`,
          },
          {
            id: "pyd",
            label: "Pydantic (your dependency)",
            lang: "py",
            code: `from pydantic import BaseModel

class User(BaseModel):
    name: str
    plan: str = "free"

db.put("users/42", User(name="Ada").model_dump())
item = db.get("users/42")
user = User.model_validate(item.value) if item else None`,
          },
        ]}
      />

      <H2 id="testing">Testing</H2>
      <H3 id="testing-stub">A stub server for unit tests</H3>
      <p>
        There is no injectable transport, so test against a tiny local HTTP server. This test checks that a write is redirected to the
        second node with the same mutation ID.
      </p>
      <Code lang="py" title="test_retry.py">{`import json
import threading
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

from celeris import Client

seen = []

def make_server(status, body, extra_headers=None):
    class Handler(BaseHTTPRequestHandler):
        def do_PUT(self):
            self.rfile.read(int(self.headers.get("content-length", 0)))
            seen.append((self.server.server_port, self.headers["celeris-mutation-id"]))
            payload = json.dumps(body).encode()
            self.send_response(status)
            self.send_header("content-type", "application/json")
            self.send_header("content-length", str(len(payload)))
            for k, v in (extra_headers or {}).items():
                self.send_header(k, v)
            self.end_headers()
            self.wfile.write(payload)

        def log_message(self, *args):
            pass

    server = ThreadingHTTPServer(("127.0.0.1", 0), Handler)
    threading.Thread(target=server.serve_forever, daemon=True).start()
    return server

def test_redirect_reuses_mutation_id():
    a = make_server(421, {"error": {"code": "not_leader", "message": "ask b"}})
    b = make_server(200, {"key": "k", "version": 3, "consistency": "strict"}, {"celeris-session-index": "9@g1"})
    try:
        db = Client([f"http://127.0.0.1:{a.server_port}", f"http://127.0.0.1:{b.server_port}"])
        result = db.put("k", 1)
        assert result.version == 3
        assert len(seen) == 2 and seen[0][1] == seen[1][1]   # same mutation id
        assert db.session == "9@g1"
    finally:
        a.shutdown()
        b.shutdown()`}</Code>
      <H3 id="testing-real">Against a real node</H3>
      <p>
        For behaviour such as conditions, TTL and queries, start a throwaway node in a fixture. The SDK{"'"}s own tests do this with{" "}
        <code>celeris init --dir TMP --listen 127.0.0.1:PORT</code>, then <code>celeris start --config TMP/celeris.toml</code> with{" "}
        <code>CELERIS_SYNC=never</code> (faster, acceptable for tests), polling <code>/health</code> until it answers. For redirects and
        failover, use <code>docker compose up -d --build</code> and the nodes on ports 8081 to 8083.
      </p>

      <H2 id="example">A complete small app</H2>
      <p>
        Save as <code>app.py</code>. It uses a node on port 8080 (override with <code>CELERIS_NODES</code>, comma-separated) and an optional{" "}
        <code>CELERIS_TOKEN</code>.
      </p>
      <Code lang="py" title="app.py">{`import os
import threading
import time

from celeris import CelerisError, Client, OutcomeUnknownError

db = Client(
    os.environ.get("CELERIS_NODES", "http://127.0.0.1:8080").split(","),
    token=os.environ.get("CELERIS_TOKEN"),
)

# 1. Write with a TTL
db.put("sessions/abc", {"user": "ada"}, ttl_ms=60_000)

# 2. Optimistic counter
def bump(key):
    for _ in range(5):
        cur = db.get(key)
        n = (cur.value if cur else 0) + 1
        try:
            db.put(key, n, **({"if_version": cur.version} if cur else {"if_absent": True}))
            return n
        except CelerisError as e:
            if e.code != "condition_failed":
                raise
    raise RuntimeError("contention")

print("visits:", bump("counters/visits"))

# 3. Write from a thread while the main thread watches
def writer():
    time.sleep(0.3)
    db.batch([
        {"op": "put", "key": "orders/1", "value": {"total": 120, "status": "paid"}},
        {"op": "put", "key": "orders/2", "value": {"total": 40, "status": "open"}},
    ])

threading.Thread(target=writer, daemon=True).start()
with db.watch("orders/") as w:
    event = w.next(timeout=5)
    print("change:", event.kind, event.key, event.value)

# 4. Query and aggregate
time.sleep(0.2)
for item in db.query(prefix="orders/", where={"total": {"$gte": 100}}):
    print("big order:", item.key, item.value)
print("stats:", db.aggregate({"count": True, "sum": ["total"]}, prefix="orders/"))

# 5. Clean up, reporting unknown outcomes properly
try:
    db.delete("orders/1")
    db.delete("orders/2")
except OutcomeUnknownError as e:
    print("unresolved, mutation id", e.mutation_id)`}</Code>
      <OsCode linux="python3 app.py" macos="python3 app.py" windows="py -3 app.py" title="run" />
      <p>
        With authentication on, set <code>CELERIS_TOKEN</code> first (<code>export CELERIS_TOKEN=...</code> on Linux and macOS,{" "}
        <code>{'$env:CELERIS_TOKEN = "..."'}</code> in PowerShell).
      </p>

      <H2 id="troubleshooting">Troubleshooting</H2>
      <Details summary="CelerisError: unreachable (no node answered)">
        The URL or port is wrong, the node is down, or it listens on <code>127.0.0.1</code> while you connect from another machine (set the
        listen address to <code>0.0.0.0:8080</code>). <code>celeris doctor</code> checks a node from its own host.
      </Details>
      <Details summary="ssl.SSLCertVerificationError with a private CA">
        Set <code>SSL_CERT_FILE</code> to the CA PEM file (or install the CA in the system store). The client has no per-instance CA option.
      </Details>
      <Details summary="pip cannot find celeris-client">
        It is not on PyPI. Install from the git URL with <code>#subdirectory=sdks/python</code>, or from a local clone. Quote the URL in
        PowerShell and zsh so <code>#</code> is not treated specially.
      </Details>
      <Details summary="401 or 403 responses">
        Authentication is enabled. Pass <code>token=</code>. A 403 means the token{"'"}s scope (read, write, admin) does not cover the call.
      </Details>
      <Details summary="Watch blocks forever">
        <code>for event in w</code> waits until the stream closes. Use <code>w.next(timeout=...)</code> in a loop if you need to check for
        shutdown, or run it in a thread.
      </Details>
      <Details summary="Slow bulk loads">
        Each call is one round trip on a fresh connection. Use <code>batch</code> (up to 10,000 operations atomically) or several threads,
        or import with <code>celeris import</code> for one-off loads.
      </Details>

      <H2 id="next">Next steps</H2>
      <ul>
        <li>
          <DocLink to="frameworks">Frameworks</DocLink> for FastAPI and other Python integration patterns.
        </li>
        <li>
          <DocLink to="consistency">Consistency</DocLink> and <DocLink to="queries">Queries</DocLink>.
        </li>
        <li>
          <DocLink to="ai">AI and agents</DocLink> for using CelerisDB as memory or state storage.
        </li>
        <li>
          <DocLink to="sdk-http">HTTP from any language</DocLink> to see what the client sends on the wire.
        </li>
      </ul>
    </>
  );
}

export const page: DocPage = {
  slug: "sdk-python",
  title: "Python",
  group: "SDKs",
  summary: "Use the dependency-free Python client with safe retries, session tracking, queries and change streams.",
  keywords: ["python", "pip", "uv", "venv", "client", "sdk", "fastapi", "django", "flask", "watch", "websocket"],
  Body,
};
