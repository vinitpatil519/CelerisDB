import { Callout, Code, Details, DocLink, H2, H3, OsCode, Params, Table, type DocPage } from "../kit";

function Body() {
  return (
    <>
      <p>
        <code>celeris-client</code> is the async Rust client for CelerisDB. It runs on <code>tokio</code>, talks HTTP through{" "}
        <code>reqwest</code> and change streams through <code>tokio-tungstenite</code>. Values are anything <code>serde</code> can serialize
        on the way in and deserialize on the way out, so your own structs work directly.
      </p>

      <Callout kind="note" title="Packaging status">
        The crate is not published on crates.io yet. Depend on it through git or a path to a local clone (shown below). It needs Rust 1.89
        or newer (edition 2024). Everything on this page is taken from <code>sdks/rust</code> (version <code>0.1.0</code>).
      </Callout>

      <H2 id="install">Install</H2>
      <p>
        Add the crate and the helpers the examples use. <code>cargo add</code> checks out the repository and finds the{" "}
        <code>celeris-client</code> package inside it.
      </p>
      <OsCode
        linux={`cargo new celeris-demo && cd celeris-demo
cargo add celeris-client --git https://github.com/vinitpatil519/CelerisDB
cargo add serde --features derive
cargo add serde_json
cargo add tokio --features macros,rt-multi-thread,time`}
        macos={`cargo new celeris-demo && cd celeris-demo
cargo add celeris-client --git https://github.com/vinitpatil519/CelerisDB
cargo add serde --features derive
cargo add serde_json
cargo add tokio --features macros,rt-multi-thread,time`}
        windows={`cargo new celeris-demo
cd celeris-demo
cargo add celeris-client --git https://github.com/vinitpatil519/CelerisDB
cargo add serde --features derive
cargo add serde_json
cargo add tokio --features macros,rt-multi-thread,time`}
      />
      <p>Or edit <code>Cargo.toml</code> yourself:</p>
      <Code lang="toml" title="Cargo.toml">{`[dependencies]
celeris-client = { git = "https://github.com/vinitpatil519/CelerisDB" }
# pin for reproducible builds:
# celeris-client = { git = "https://github.com/vinitpatil519/CelerisDB", rev = "COMMIT_SHA" }
# or use a local clone:
# celeris-client = { path = "../CelerisDB/sdks/rust" }
serde = { version = "1", features = ["derive"] }
serde_json = "1"
tokio = { version = "1", features = ["macros", "rt-multi-thread", "time"] }`}</Code>
      <H3 id="tls-feature">The rustls feature (HTTPS)</H3>
      <p>
        By default the crate is built <strong>without TLS</strong>: only <code>http://</code> and <code>ws://</code> URLs work. For HTTPS
        nodes and <code>wss://</code> change streams, enable the <code>rustls</code> feature, which uses rustls with the bundled Mozilla
        root certificates:
      </p>
      <Code lang="toml">{`celeris-client = { git = "https://github.com/vinitpatil519/CelerisDB", features = ["rustls"] }`}</Code>
      <p>
        There is no builder option for a private CA today; the client trusts the bundled public roots only. For a node with a private
        certificate, keep the connection on a trusted private network over plain HTTP, or terminate TLS at a reverse proxy with a publicly
        trusted certificate. Server-side TLS is covered on <DocLink to="security">Security</DocLink>.
      </p>

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
        Or run <code>docker compose up -d --build</code> in the repository root for three nodes on ports 8081, 8082 and 8083.
      </p>

      <H2 id="client">Create a client</H2>
      <Code lang="rust">{`use std::time::Duration;
use celeris_client::{Client, Consistency};

// One node, default settings
let db = Client::new("http://127.0.0.1:8080")?;

// Several nodes and options
let db = Client::builder()
    .nodes(["http://10.0.0.1:8080", "http://10.0.0.2:8080", "http://10.0.0.3:8080"])
    .token(std::env::var("CELERIS_TOKEN")?)
    .consistency(Consistency::Strict)
    .timeout(Duration::from_secs(5))
    .attempts(4)
    .build()?;`}</Code>
      <p>
        Share one <code>Client</code> across your program (for example in an <code>Arc</code>): it pools connections and remembers the
        preferred node and the session token. <code>build()</code> fails with <code>Error::Config</code> if no node is given or a header is
        invalid.
      </p>
      <Params
        rows={[
          { name: "node(url)", type: "impl Into<String>", desc: "Adds one node base URL." },
          {
            name: "nodes(urls)",
            type: "IntoIterator<Item: Into<String>>",
            desc: "Adds several. A URL without http:// or https:// gets http://; trailing slashes are removed.",
          },
          {
            name: "consistency(mode)",
            type: "Consistency",
            def: "none (server default: strict)",
            desc: (
              <>
                Default mode. Variants: <code>Strict</code>, <code>Session</code>, <code>Bounded</code>, <code>Available</code>,{" "}
                <code>Eventual</code>.
              </>
            ),
          },
          {
            name: "timeout(d)",
            type: "Duration",
            def: "10 s",
            desc: "Overall request timeout. The connect timeout is the smaller of this and 3 seconds.",
          },
          { name: "attempts(n)", type: "usize", def: "4", desc: "Total attempts per call (minimum 1) across nodes and transient errors." },
          {
            name: "token(t)",
            type: "impl Into<String>",
            desc: (
              <>
                API token, sent as <code>Authorization: Bearer ...</code> (including on the change-stream handshake).
              </>
            ),
          },
          { name: "header(name, value)", type: "impl Into<String>", desc: "An extra header on every request. Call repeatedly for several." },
        ]}
      />

      <H2 id="basics">Read, write, delete</H2>
      <Code lang="rust">{`use serde::{Deserialize, Serialize};

#[derive(Debug, Serialize, Deserialize)]
struct User { name: String, plan: String }

let written = db.put("users/42", &User { name: "Ada".into(), plan: "free".into() }).await?;
println!("{:?} {} {}", written.version, written.mutation_id, written.consistency);

match db.get::<User>("users/42").await? {
    Some(item) => println!("{} v{}", item.value.name, item.version),
    None => println!("not found"),
}

db.delete("users/42").await?;   // deleting a missing key succeeds`}</Code>
      <Table
        head={["Type", "Fields"]}
        rows={[
          [
            <code key="i">Item&lt;T&gt;</code>,
            <>
              <code>key</code>, <code>value: T</code>, <code>version: u64</code>, <code>expires_at_ms: Option&lt;u64&gt;</code>,{" "}
              <code>consistency: String</code> (mode applied).
            </>,
          ],
          [
            <code key="w">WriteResult</code>,
            <>
              <code>key: Option&lt;String&gt;</code>, <code>version: Option&lt;u64&gt;</code> (<code>None</code> while an{" "}
              <code>available</code> write is pending), <code>mutation_id</code>, <code>deduplicated</code>, <code>replicated</code>,{" "}
              <code>consistency</code>.
            </>,
          ],
        ]}
      />
      <ul>
        <li>
          Every operation has a plain form (<code>get</code>, <code>put</code>, <code>delete</code>) and a <code>_with</code> form that takes
          options (<code>get_with</code>, <code>put_with</code>, <code>delete_with</code>).
        </li>
        <li>
          <code>get</code> returns <code>Ok(None)</code> for a missing key.
        </li>
        <li>
          <code>put</code> takes <code>&amp;T</code> where <code>T: Serialize + ?Sized</code>, so <code>&amp;str</code>, numbers, structs and{" "}
          <code>serde_json::Value</code> all work. If the stored JSON does not fit the type you ask for, you get <code>Error::Decode</code>.
        </li>
        <li>
          Keys are 1 to 1024 bytes of UTF-8 and values up to 4 MiB. Keys with a <code>.</code> or <code>..</code> path segment fail with{" "}
          <code>Error::InvalidKey</code> before anything is sent. <code>celeris_client::encode_key</code> is exported.
        </li>
      </ul>

      <H2 id="consistency">Consistency per call</H2>
      <Code lang="rust">{`use celeris_client::{Consistency, PutOptions, ReadOptions};

// Linearizable (server default)
db.get_with::<serde_json::Value>("accounts/1", ReadOptions {
    consistency: Some(Consistency::Strict),
    ..Default::default()
}).await?;

// Read your own writes
db.put("cart/ada", &serde_json::json!({"items": 2})).await?;
db.get_with::<serde_json::Value>("cart/ada", ReadOptions {
    consistency: Some(Consistency::Session),
    ..Default::default()
}).await?;

// Fresh within 500 ms
db.get_with::<serde_json::Value>("stats/today", ReadOptions {
    consistency: Some(Consistency::Bounded),
    max_staleness_ms: Some(500),
}).await?;

// Keep working during a partition
let r = db.put_with("likes/post-9", &41, PutOptions {
    consistency: Some(Consistency::Available),
    ..Default::default()
}).await?;
if !r.replicated { println!("accepted locally, replication pending"); }`}</Code>
      <p>
        Per-call options override the client default, which overrides the server default. <code>Bounded</code> needs{" "}
        <code>max_staleness_ms</code> and is for reads only. The client never weakens a mode.
      </p>
      <p>
        <strong>Sessions.</strong> In a replicated cluster the client keeps the latest <code>celeris-session-index</code> token
        (<code>db.session()</code> returns <code>Option&lt;String&gt;</code>) and sends it with <code>Session</code> reads. A lagging
        replica answers <code>503 session_behind</code> and the client tries another node. See{" "}
        <DocLink to="consistency">Consistency</DocLink>.
      </p>

      <H2 id="cas-ttl">Compare-and-set and TTL</H2>
      <Code lang="rust">{`use celeris_client::{DeleteOptions, Error, PutOptions};

// Create only if absent, expiring after 30 s
db.put_with("locks/report", &serde_json::json!({"owner": "worker-1"}), PutOptions {
    if_absent: true,
    ttl_ms: Some(30_000),
    ..Default::default()
}).await?;

// Optimistic counter
async fn bump(db: &celeris_client::Client, key: &str) -> Result<u64, Box<dyn std::error::Error>> {
    for _ in 0..5 {
        let cur = db.get::<u64>(key).await?;
        let (n, opts) = match &cur {
            Some(item) => (item.value + 1, PutOptions { if_version: Some(item.version), ..Default::default() }),
            None => (1, PutOptions { if_absent: true, ..Default::default() }),
        };
        match db.put_with(key, &n, opts).await {
            Err(e) if e.code() == Some("condition_failed") => continue, // someone else wrote first
            other => {
                other?;
                return Ok(n);
            }
        }
    }
    Err("too much contention".into())
}

// Conditional delete
db.delete_with("locks/report", DeleteOptions { if_version: Some(7), ..Default::default() }).await?;`}</Code>
      <p>
        A failed condition is <code>Error::Api</code> with <code>status: 409</code> and <code>code: "condition_failed"</code>;{" "}
        <code>details["current_version"]</code> holds the key{"'"}s version or null. Nothing was written.
      </p>
      <Callout kind="warn" title="Conditions need strict writes">
        In a cluster, <code>if_version</code> and <code>if_absent</code> are refused with <code>400 conditions_require_strict</code> on{" "}
        <code>Available</code> and <code>Eventual</code> writes.
      </Callout>

      <H2 id="batch">Atomic batches</H2>
      <Code lang="rust">{`use celeris_client::{BatchOp, WriteOptions};
use serde_json::json;

let ops = vec![
    BatchOp::Put {
        key: "orders/1001".into(),
        value: json!({"total": 30}),
        ttl_ms: None,
        if_version: None,
        if_absent: true,
    },
    BatchOp::put("orders/1001/audit", json!({"by": "ada"})),
    BatchOp::delete("carts/ada"),
];
let r = db.batch(ops, WriteOptions::default()).await?;
println!("{:?} {}", r.version, r.mutation_id);`}</Code>
      <p>
        <code>BatchOp::put</code> and <code>BatchOp::delete</code> build unconditional operations; construct the enum variants directly for
        TTL and conditions. Batch values are <code>serde_json::Value</code>; use <code>serde_json::to_value(&amp;my_struct)?</code> for a
        struct. The batch commits atomically under one mutation ID. Limits: 10,000 operations and 32 MiB; in a cluster all keys must be in
        one replica set (<code>400 cross_group_batch</code>).
      </p>

      <H2 id="scan">Scans and queries</H2>
      <Code lang="rust">{`use celeris_client::ScanOptions;

let opts = ScanOptions { prefix: Some("orders/".into()), limit: Some(200), ..Default::default() };

// Everything, in key order (collects into memory: prefer pages for large ranges)
let all = db.scan_all::<serde_json::Value>(&opts).await?;

// Page by page
let mut after: Option<String> = None;
loop {
    let page = db.scan_page::<serde_json::Value>(&opts, after.as_deref()).await?;
    if page.partial { eprintln!("some replica sets did not answer"); }
    for item in &page.items { println!("{}", item.key); }
    match page.next_cursor {
        Some(c) => after = Some(c),
        None => break,
    }
}`}</Code>
      <p>
        <code>ScanOptions</code> has <code>prefix</code>, or <code>start</code> (inclusive) and <code>end</code> (exclusive), plus{" "}
        <code>limit</code> (1 to 1000) and <code>consistency</code>.
      </p>
      <H3 id="query">Filter on the server</H3>
      <Code lang="rust">{`use celeris_client::{QueryOptions, ScanOptions};
use serde_json::json;

#[derive(Debug, serde::Deserialize)]
struct Order { total: u32, status: String }

let paid = db.query_all::<Order>(&QueryOptions {
    range: ScanOptions { prefix: Some("orders/".into()), ..Default::default() },
    filter: Some(json!({"status": "paid", "total": {"$gte": 100}})),
    ..Default::default()
}).await?;

// Ordered by a field (needs an index declared with that order)
let page = db.query_page::<Order>(&QueryOptions {
    range: ScanOptions { prefix: Some("orders/".into()), limit: Some(20), ..Default::default() },
    filter: Some(json!({"status": "paid"})),
    sort: Some(json!({"field": "total", "order": "desc"})),
    ..Default::default()
}, None).await?;
println!("{:?} {} {:?}", page.index, page.scanned, page.next_cursor);`}</Code>
      <p>
        <code>QueryOptions</code> fields: <code>range</code> (a <code>ScanOptions</code>), <code>filter</code>, <code>fields</code>,{" "}
        <code>max_scanned</code>, <code>aggregate</code> and <code>sort</code> (the last three as <code>serde_json::Value</code>). Operators:{" "}
        <code>$eq $ne $gt $gte $lt $lte $in $nin $exists $prefix $contains</code> with <code>$and</code>, <code>$or</code>,{" "}
        <code>$not</code> and dotted paths. A page can be short and still have a cursor because the server stops after{" "}
        <code>max_scanned</code> rows (default 10,000); <code>query_all</code> follows cursors for you. If you set <code>fields</code>,
        deserialize into a type that matches the projected shape (or <code>serde_json::Value</code>). See{" "}
        <DocLink to="queries">Queries</DocLink>.
      </p>
      <H3 id="aggregate">Aggregate</H3>
      <Code lang="rust">{`let stats = db.aggregate(&QueryOptions {
    range: ScanOptions { prefix: Some("orders/".into()), ..Default::default() },
    filter: Some(json!({"status": "paid"})),
    aggregate: Some(json!({"count": true, "sum": ["total"], "max": ["total"]})),
    ..Default::default()
}).await?;
// {"count":412,"sum":{"total":18230.5},"max":{"total":990}}  (a serde_json::Value)`}</Code>
      <p>
        <code>aggregate</code> requires <code>options.aggregate</code>, follows cursors and merges pages. When paging by hand, fold pages
        with <code>celeris_client::merge_aggregates(&amp;mut total, &amp;page)</code>.
      </p>

      <H2 id="watch">Live changes</H2>
      <Code lang="rust">{`use celeris_client::WatchEvent;

let mut watch = db.watch("orders/").await?;
println!("covers every replica set: {}", !watch.partial());

while let Some(event) = watch.next().await? {
    match event {
        WatchEvent::Change(e) => println!("{} {} {} v{}", e.kind, e.key, e.value, e.version),
        WatchEvent::Lagged(n) => println!("missed {n} events: re-read what you show"),
    }
}
watch.close().await;`}</Code>
      <ul>
        <li>
          <code>next()</code> returns <code>Ok(Some(event))</code>, <code>Ok(None)</code> once the stream has closed, or an{" "}
          <code>Error::Watch</code> / <code>Error::Decode</code>. <code>watch.hello</code> is the first message as a{" "}
          <code>serde_json::Value</code>.
        </li>
        <li>
          <code>ChangeEvent</code> has <code>key</code>, <code>kind</code> (<code>"put"</code> or <code>"delete"</code>),{" "}
          <code>value</code> (<code>serde_json::Value</code>, null on deletes), <code>version</code>, <code>mutation_id</code>.
        </li>
        <li>
          There is no automatic reconnect or timeout. Wrap <code>next()</code> in <code>tokio::time::timeout</code> if you need one, and
          reopen the stream (then re-read) after a drop.
        </li>
        <li>
          Delivery is best-effort and starts at {"“"}now{"”"}. A node reports the changes of its own replica sets. See{" "}
          <DocLink to="change-streams">Change streams</DocLink>.
        </li>
      </ul>

      <H2 id="status">Mutation status, conflicts, node status</H2>
      <Code lang="rust">{`use celeris_client::MutationStatus;

match db.mutation_status("7d1c0e5a-4b8e-4f0a-9a52-3c1f6e2b9d10").await? {
    MutationStatus::Committed { version } => println!("committed at {version:?}"),
    MutationStatus::Unknown => println!("not committed, in flight, or too old"),
}

let c = db.conflicts(Some("likes/"), Some(50)).await?;   // c.conflicts: Vec<Conflict>, c.partial
db.clear_conflicts("likes/post-9").await?;

let status = db.status().await?;                          // serde_json::Value`}</Code>
      <p>
        <code>Unknown</code> means the mutation did not commit, is still in flight, or is older than the server{"'"}s retention window (24
        hours by default).
      </p>

      <H2 id="errors">Errors and unknown outcomes</H2>
      <Table
        head={["Variant", "Meaning"]}
        rows={[
          [
            <code key="a">Error::Api {"{ status, code, message, outcome, details }"}</code>,
            <>
              A node answered with an error. <code>outcome</code> is <code>Option&lt;Outcome&gt;</code> (<code>NotApplied</code> or{" "}
              <code>Unknown</code>) on write errors. Helpers: <code>e.code()</code> and <code>e.status()</code>.
            </>,
          ],
          [
            <code key="o">Error::OutcomeUnknown {"{ mutation_id, reason }"}</code>,
            "A write may or may not have committed. Resolve it with mutation_status or retry with the same ID.",
          ],
          [<code key="u">Error::Unreachable(String)</code>, "No connection could be opened. For a write, nothing was applied."],
          [<code key="k">Error::InvalidKey(String)</code>, "The key has a . or .. segment."],
          [<code key="c">Error::Config(String)</code>, "Bad builder input (no nodes, invalid header)."],
          [<code key="d">Error::Decode(String)</code>, "A response, or a stored value, did not match the expected type."],
          [<code key="w">Error::Watch(String)</code>, "The change stream could not open or broke."],
        ]}
      />
      <Table
        head={["Status", "code", "Meaning for you"]}
        rows={[
          ["409", "condition_failed", "if_version or if_absent did not hold. Not applied."],
          ["422", "mutation_id_reused", "Same mutation ID, different payload. A bug in your retry logic."],
          ["400", "invalid_key, invalid_json, invalid_query, invalid_consistency, ...", "Fix the request. Not applied."],
          ["401 / 403", "unauthorized / forbidden", "Missing token, or scope too small."],
        ]}
      />
      <p>
        See <DocLink to="errors">Errors</DocLink> for every code.
      </p>
      <H3 id="unknown">Handling an unknown outcome</H3>
      <Code lang="rust">{`use celeris_client::{Client, Error, MutationStatus, PutOptions};
use serde::Serialize;

/// Returns the commit version, resolving an unknown outcome if one occurs.
async fn put_sure<T: Serialize + ?Sized>(db: &Client, key: &str, value: &T) -> Result<Option<u64>, Error> {
    match db.put(key, value).await {
        Ok(r) => Ok(r.version),
        Err(Error::OutcomeUnknown { mutation_id, .. }) => {
            if let MutationStatus::Committed { version } = db.mutation_status(&mutation_id).await? {
                return Ok(version);
            }
            // not committed, in flight, or too old: the same ID is still safe to retry
            let r = db
                .put_with(key, value, PutOptions { mutation_id: Some(mutation_id), ..Default::default() })
                .await?;
            Ok(r.version)
        }
        Err(e) => Err(e),
    }
}`}</Code>
      <Callout kind="warn">
        Never retry an unknown outcome with a new mutation ID, and never treat it as a plain failure. Both can apply the change twice. If
        the second call also ends in <code>OutcomeUnknown</code>, keep the ID and check again later.
      </Callout>

      <H2 id="retries">Retries, redirects and mutation IDs</H2>
      <p>
        Every write sends a UUID in the <code>celeris-mutation-id</code> header (batches also carry it in the body). The same ID is reused
        on every retry.
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
            "Guaranteed not applied. Waits 100 ms times the attempt number for writes (50 ms for reads), then the next node.",
          ],
          [
            "Connection could not be opened",
            "Known not sent. Next node. If every attempt fails this way: Error::Unreachable, nothing applied.",
          ],
          [
            "Timeout or reset after sending",
            "Might have been applied. Retries with the same ID; if never confirmed, Error::OutcomeUnknown.",
          ],
          [
            <>
              Write error with <code>outcome: unknown</code>
            </>,
            "Retries with the same ID, then Error::OutcomeUnknown.",
          ],
          ["Other 4xx or 5xx", "Returned at once as Error::Api."],
          ["Reads and other idempotent calls", "Retried on any failure, no mutation ID."],
        ]}
      />
      <p>
        Every SDK follows the same contract. See the interactive walkthrough on the{" "}
        <DocLink to="sdk-typescript:retries">TypeScript page</DocLink>. Dropping the future returned by a write cancels it mid-flight; if
        that can happen in your program, pass your own <code>mutation_id</code> so you can check it later.
      </p>

      <H2 id="typed">Typed values</H2>
      <p>
        Typing is the strong point of this SDK: generics at the call site decide how a value is read, with no extra layer.
      </p>
      <Code lang="rust">{`#[derive(serde::Serialize, serde::Deserialize, Debug)]
#[serde(rename_all = "camelCase")]
struct Profile { display_name: String, #[serde(default)] tags: Vec<String> }

db.put("profiles/ada", &Profile { display_name: "Ada".into(), tags: vec![] }).await?;
let p: Option<celeris_client::Item<Profile>> = db.get("profiles/ada").await?;`}</Code>
      <p>
        A document written by another service that does not fit your struct yields <code>Error::Decode</code>, so decode into{" "}
        <code>serde_json::Value</code> first when you do not control all writers. Use <code>#[serde(default)]</code> and{" "}
        <code>Option</code> fields to tolerate older documents.
      </p>

      <H2 id="testing">Testing</H2>
      <H3 id="testing-mock">Unit tests with a mock HTTP server</H3>
      <p>
        There is no injectable transport, so mock the node at the HTTP level. This sketch uses the third-party <code>wiremock</code> crate
        (add it as a dev-dependency; check its documentation for the version you use) to confirm that a redirect is retried on the second
        node with the same mutation ID.
      </p>
      <Code lang="rust" title="tests/redirect.rs">{`use celeris_client::Client;
use serde_json::json;
use wiremock::matchers::{method, path};
use wiremock::{Mock, MockServer, ResponseTemplate};

#[tokio::test]
async fn redirect_reuses_mutation_id() {
    let a = MockServer::start().await;
    let b = MockServer::start().await;
    Mock::given(method("PUT")).and(path("/v1/kv/k"))
        .respond_with(ResponseTemplate::new(421).set_body_json(json!({"error": {"code": "not_leader", "message": "ask b"}})))
        .mount(&a).await;
    Mock::given(method("PUT")).and(path("/v1/kv/k"))
        .respond_with(ResponseTemplate::new(200).set_body_json(json!({"key": "k", "version": 3, "consistency": "strict"})))
        .mount(&b).await;

    let db = Client::builder().nodes([a.uri(), b.uri()]).build().unwrap();
    let r = db.put("k", &1).await.unwrap();
    assert_eq!(r.version, Some(3));

    let first = a.received_requests().await.unwrap();
    let second = b.received_requests().await.unwrap();
    assert_eq!(first[0].headers.get("celeris-mutation-id"), second[0].headers.get("celeris-mutation-id"));
}`}</Code>
      <H3 id="testing-real">Against a real node</H3>
      <p>
        For conditions, TTL and queries, run a node (<code>celeris start</code>, or <code>docker compose up -d --build</code> for a
        cluster) and read its URL from an environment variable in your tests, for example{" "}
        <code>CELERIS_URL=http://127.0.0.1:8080 cargo test</code>. Use a unique key prefix per test (a random suffix) so tests do not
        collide. The SDK{"'"}s own suite starts an in-process node, which is only possible inside the repository workspace.
      </p>

      <H2 id="example">A complete small app</H2>
      <p>
        In the <code>celeris-demo</code> project from the install step, replace <code>src/main.rs</code> with the following. It reads{" "}
        <code>CELERIS_NODES</code> (comma-separated) and <code>CELERIS_TOKEN</code>.
      </p>
      <Code lang="rust" title="src/main.rs">{`use std::sync::Arc;
use std::time::Duration;

use celeris_client::{
    BatchOp, Client, Error, PutOptions, QueryOptions, ScanOptions, WatchEvent, WriteOptions,
};
use serde::{Deserialize, Serialize};
use serde_json::json;

#[derive(Debug, Serialize, Deserialize)]
struct Order {
    total: u32,
    status: String,
}

async fn bump(db: &Client, key: &str) -> Result<u64, Box<dyn std::error::Error>> {
    for _ in 0..5 {
        let cur = db.get::<u64>(key).await?;
        let (n, opts) = match &cur {
            Some(item) => (item.value + 1, PutOptions { if_version: Some(item.version), ..Default::default() }),
            None => (1, PutOptions { if_absent: true, ..Default::default() }),
        };
        match db.put_with(key, &n, opts).await {
            Err(e) if e.code() == Some("condition_failed") => continue,
            other => {
                other?;
                return Ok(n);
            }
        }
    }
    Err("too much contention".into())
}

#[tokio::main]
async fn main() -> Result<(), Box<dyn std::error::Error>> {
    let nodes = std::env::var("CELERIS_NODES").unwrap_or_else(|_| "http://127.0.0.1:8080".into());
    let mut builder = Client::builder().nodes(nodes.split(',').map(str::to_owned));
    if let Ok(token) = std::env::var("CELERIS_TOKEN") {
        builder = builder.token(token);
    }
    let db = Arc::new(builder.build()?);

    // 1. Write with a TTL
    db.put_with("sessions/abc", &json!({"user": "ada"}), PutOptions { ttl_ms: Some(60_000), ..Default::default() })
        .await?;

    // 2. Optimistic counter
    println!("visits: {}", bump(&db, "counters/visits").await?);

    // 3. Watch while another task writes a batch
    let mut watch = db.watch("orders/").await?;
    let writer = {
        let db = Arc::clone(&db);
        tokio::spawn(async move {
            tokio::time::sleep(Duration::from_millis(300)).await;
            let ops = vec![
                BatchOp::put("orders/1", json!({"total": 120, "status": "paid"})),
                BatchOp::put("orders/2", json!({"total": 40, "status": "open"})),
            ];
            if let Err(e) = db.batch(ops, WriteOptions::default()).await {
                eprintln!("batch: {e}");
            }
        })
    };
    if let Some(WatchEvent::Change(e)) = watch.next().await? {
        println!("change: {} {} {}", e.kind, e.key, e.value);
    }
    watch.close().await;
    writer.await?;

    // 4. Typed query, then an aggregate
    let range = ScanOptions { prefix: Some("orders/".into()), ..Default::default() };
    let big = db
        .query_all::<Order>(&QueryOptions {
            range: range.clone(),
            filter: Some(json!({"total": {"$gte": 100}})),
            ..Default::default()
        })
        .await?;
    for item in &big {
        println!("big order: {} {:?}", item.key, item.value);
    }
    let stats = db
        .aggregate(&QueryOptions {
            range,
            aggregate: Some(json!({"count": true, "sum": ["total"]})),
            ..Default::default()
        })
        .await?;
    println!("stats: {stats}");

    // 5. Clean up, reporting unknown outcomes properly
    for key in ["orders/1", "orders/2"] {
        match db.delete(key).await {
            Ok(_) => {}
            Err(Error::OutcomeUnknown { mutation_id, .. }) => eprintln!("unresolved, mutation id {mutation_id}"),
            Err(e) => return Err(e.into()),
        }
    }
    Ok(())
}`}</Code>
      <OsCode
        linux={`cargo run`}
        macos={`cargo run`}
        windows={`cargo run`}
        title="run"
      />
      <p>
        Set <code>CELERIS_TOKEN</code> first when authentication is on (<code>export CELERIS_TOKEN=...</code>, or{" "}
        <code>{'$env:CELERIS_TOKEN = "..."'}</code> in PowerShell).
      </p>

      <H2 id="troubleshooting">Troubleshooting</H2>
      <Details summary="Error::Unreachable (no node answered)">
        Nothing accepted a connection. Check the URL and port, and that the node listens on a reachable address (default{" "}
        <code>127.0.0.1</code>; use <code>0.0.0.0:8080</code> for remote clients). The message carries the underlying connect error.
      </Details>
      <Details summary="https:// URL fails with a scheme or TLS error">
        The crate has no TLS unless you enable the <code>rustls</code> feature. Enable it, and note that only publicly trusted
        certificates are accepted.
      </Details>
      <Details summary="cargo add says it cannot find the package">
        Use the repository URL with <code>--git</code>; the crate is not on crates.io. The git checkout needs network access and a recent
        Rust (1.89 or newer): run <code>rustup update</code>.
      </Details>
      <Details summary="there is no reactor running / must be called from a Tokio runtime">
        The client is async. Call it from inside <code>#[tokio::main]</code> or a Tokio runtime, with the <code>rt-multi-thread</code> (or{" "}
        <code>rt</code>) feature enabled.
      </Details>
      <Details summary="Error::Decode on get">
        The stored JSON does not fit your type. Read it as <code>serde_json::Value</code> to inspect, then adjust the struct (optional
        fields, <code>#[serde(default)]</code>, renames).
      </Details>
      <Details summary="401 or 403 responses">
        Authentication is on: call <code>.token(...)</code> on the builder. A 403 means the token scope does not cover the call.
      </Details>

      <H2 id="next">Next steps</H2>
      <ul>
        <li>
          <DocLink to="consistency">Consistency</DocLink> and <DocLink to="queries">Queries</DocLink>.
        </li>
        <li>
          <DocLink to="performance">Performance</DocLink> for batching, prefixes and indexes.
        </li>
        <li>
          <DocLink to="production-checklist">Production checklist</DocLink> before you go live.
        </li>
        <li>
          <DocLink to="sdk-http">HTTP from any language</DocLink> for the wire details.
        </li>
      </ul>
    </>
  );
}

export const page: DocPage = {
  slug: "sdk-rust",
  title: "Rust",
  group: "SDKs",
  summary: "Use the async Rust client with serde-typed values, safe retries, queries and change streams.",
  keywords: ["rust", "cargo", "crate", "tokio", "serde", "reqwest", "rustls", "async", "client", "sdk"],
  Body,
};
