import { Callout, CodeTabs, DocLink, H2, H3, OsCode, Params, Steps, Step, Table, type DocPage } from "../kit";

/** PowerShell variant of a bash command: curl.exe, escaped JSON quotes, backtick continuations. */
const ps = (s: string) =>
  s
    .replace(/'([^']*)'/g, (_m, a: string) => `'${a.replace(/"/g, '\\"')}'`)
    .replace(/^curl /gm, "curl.exe ")
    .replace(/ \\\n/g, " `\n");
function Sh({ children }: { children: string }) {
  return <OsCode unix={children} windows={ps(children)} />;
}

function Body() {
  return (
    <>
      <p>
        Everything in Celeris is a key that holds a JSON document. This page covers the basic operations (put, get, delete), the version number every value carries, expiry with TTL,
        compare-and-set, atomic batches, scans, and the mutation ID machinery that lets you retry a write without ever applying it twice. It ends with three patterns you can copy:
        a counter, a lock, and idempotent order creation.
      </p>
      <p>
        The examples assume a client named <code>db</code> that points at one or more nodes. Reads and writes accept a <code>consistency</code> option on every call; the default is{" "}
        <code>strict</code>. See <DocLink to="consistency">Consistency</DocLink> for what the other modes mean.
      </p>

      <CodeTabs
        group="sdk-lang"
        items={[
          {
            id: "ts",
            label: "TypeScript",
            lang: "ts",
            code: `import { Client, CelerisError } from "@celeris/client";

const db = new Client({
  nodes: ["http://10.0.0.1:8080", "http://10.0.0.2:8080"],
  // token: process.env.CELERIS_TOKEN,   // when auth is enabled
});`,
          },
          {
            id: "py",
            label: "Python",
            lang: "py",
            code: `from celeris import Client, CelerisError, OutcomeUnknownError

db = Client(["http://10.0.0.1:8080", "http://10.0.0.2:8080"])
# db = Client(nodes, token=os.environ["CELERIS_TOKEN"])   # when auth is enabled`,
          },
          {
            id: "go",
            label: "Go",
            lang: "go",
            code: `import (
	"context"
	celeris "github.com/vinitpatil519/CelerisDB/sdks/go"
)

ctx := context.Background()
db, err := celeris.New(celeris.Options{
	Nodes: []string{"http://10.0.0.1:8080", "http://10.0.0.2:8080"},
	// Token: os.Getenv("CELERIS_TOKEN"),
})`,
          },
          {
            id: "rust",
            label: "Rust",
            lang: "rust",
            code: `use celeris_client::{BatchOp, Client, Consistency, DeleteOptions, PutOptions, ReadOptions, WriteOptions};
use serde_json::json;

let db = Client::builder()
    .nodes(["http://10.0.0.1:8080", "http://10.0.0.2:8080"])
    // .token(std::env::var("CELERIS_TOKEN")?)
    .build()?;`,
          },
        ]}
      />

      <H2 id="keys-values">Keys and values</H2>
      <p>
        A key is a UTF-8 string of 1 to 1024 bytes. It may contain <code>/</code>, which is the usual way to build namespaces such as <code>users/42</code> or{" "}
        <code>orders/2026/0042</code>. Keys sort byte by byte, and scans and prefix queries follow that order, so design keys with the scans you will run in mind.
      </p>
      <p>
        A value is any JSON document up to 4 MiB: an object, an array, a string, a number, a boolean or <code>null</code>. The server validates the JSON on write and returns exactly the
        stored text on read.
      </p>
      <Callout kind="note" title="Keys in URLs">
        Over HTTP the key is the rest of the path after <code>/v1/kv/</code>, percent-decoded. URL parsers collapse <code>.</code> and <code>..</code> path segments, so a key with such a
        segment cannot be addressed and the SDKs reject it up front. A key also must not start with <code>%00</code>.
      </Callout>

      <H2 id="put-get-delete">Put, get and delete</H2>
      <p>
        <code>put</code> creates or replaces a key. <code>get</code> returns the value together with its version, expiry and the consistency mode the server actually applied. A missing
        key is not an error in the SDKs: <code>get</code> returns <code>null</code> (<code>None</code>, a nil item, <code>Ok(None)</code>). <code>delete</code> of a key that does not
        exist also succeeds.
      </p>
      <CodeTabs
        group="sdk-lang"
        items={[
          {
            id: "ts",
            label: "TypeScript",
            lang: "ts",
            code: `const written = await db.put("users/42", { name: "Ada", plan: "pro" });
console.log(written.version, written.mutationId, written.consistency);

const user = await db.get<{ name: string; plan: string }>("users/42");
if (user) console.log(user.value.name, user.version, user.expiresAtMs);

await db.delete("users/42");
console.log(await db.get("users/42")); // null`,
          },
          {
            id: "py",
            label: "Python",
            lang: "py",
            code: `written = db.put("users/42", {"name": "Ada", "plan": "pro"})
print(written.version, written.mutation_id, written.consistency)

user = db.get("users/42")
if user:
    print(user.value["name"], user.version, user.expires_at_ms)

db.delete("users/42")
print(db.get("users/42"))  # None`,
          },
          {
            id: "go",
            label: "Go",
            lang: "go",
            code: `written, err := db.Put(ctx, "users/42", map[string]any{"name": "Ada", "plan": "pro"}, nil)
// written.Version is a *uint64: nil while an "available" write is still pending
fmt.Println(*written.Version, written.MutationID, written.Consistency)

item, err := db.Get(ctx, "users/42", nil) // (nil, nil) when the key does not exist
if item != nil {
	var u struct {
		Name string \`json:"name"\`
		Plan string \`json:"plan"\`
	}
	_ = item.Decode(&u)
	fmt.Println(u.Name, item.Version)
}

_, err = db.Delete(ctx, "users/42", nil)`,
          },
          {
            id: "rust",
            label: "Rust",
            lang: "rust",
            code: `let written = db.put("users/42", &json!({"name": "Ada", "plan": "pro"})).await?;
println!("{:?} {} {}", written.version, written.mutation_id, written.consistency);

if let Some(user) = db.get::<serde_json::Value>("users/42").await? {
    println!("{} {}", user.value["name"], user.version);
}

db.delete("users/42").await?;
assert!(db.get::<serde_json::Value>("users/42").await?.is_none());`,
          },
        ]}
      />
      <p>The same calls from a shell, with curl and with the CLI:</p>
      <Sh>{`curl -X PUT localhost:8080/v1/kv/users/42 -d '{"name":"Ada","plan":"pro"}'
curl localhost:8080/v1/kv/users/42
curl -X DELETE localhost:8080/v1/kv/users/42`}</Sh>
      <Sh>{`celeris put users/42 '{"name":"Ada","plan":"pro"}'
celeris get users/42
celeris delete users/42`}</Sh>
      <p>A successful PUT answers with the version and the mutation ID. A GET answers with the value and its metadata:</p>
      <Sh>{`curl -i localhost:8080/v1/kv/users/42`}</Sh>
      <Table
        head={["Field or header", "Meaning"]}
        rows={[
          [<code key="a">version</code>, "The commit version of this value. It changes on every write to the key. Also sent as the celeris-version header."],
          [<code key="b">mutation_id</code>, "The ID of the write that produced the value. Also the celeris-mutation-id header on writes."],
          [<code key="c">timestamp_ms</code>, "When the value was written, in milliseconds since the Unix epoch."],
          [<code key="d">expires_at_ms</code>, "Absolute expiry time, or null if the key does not expire."],
          [<code key="e">consistency</code>, "The mode the server applied (also the celeris-consistency header). The server never reports a stronger mode than it delivered, and never weakens a strict request."],
          [<code key="f">deduplicated</code>, "On writes: true when this mutation ID had already committed, so nothing new was written."],
        ]}
      />

      <H2 id="versions">Versions</H2>
      <p>
        Every committed write gets a commit version, and a key remembers the version of its latest write. You use versions for one thing: telling the server &ldquo;apply this change
        only if the key has not changed since I read it&rdquo;. Treat a version as an opaque token that you compare for equality. Do not assume that consecutive writes to one key differ by
        exactly one, because versions come from the commit sequence of the node or replica set, which other keys share.
      </p>
      <p>
        In a replicated cluster every replica applies the same log in the same order and therefore assigns the same versions, so a version you read from one node stays valid after a
        failover.
      </p>

      <H2 id="ttl">Expiry with TTL</H2>
      <p>
        Pass <code>ttl_ms</code> (at least 1) to make a key expire that many milliseconds after the write. Expired keys behave as deleted: reads return not found and scans skip them. The
        absolute expiry time is returned as <code>expires_at_ms</code>. Writing the key again without a TTL clears the expiry, so repeat the TTL on every refresh.
      </p>
      <CodeTabs
        group="sdk-lang"
        items={[
          {
            id: "ts",
            label: "TypeScript",
            lang: "ts",
            code: `await db.put("sessions/abc", { user: 42 }, { ttlMs: 30 * 60 * 1000 });
const s = await db.get("sessions/abc");
console.log(s?.expiresAtMs); // absolute time in ms`,
          },
          {
            id: "py",
            label: "Python",
            lang: "py",
            code: `db.put("sessions/abc", {"user": 42}, ttl_ms=30 * 60 * 1000)
s = db.get("sessions/abc")
print(s.expires_at_ms)`,
          },
          {
            id: "go",
            label: "Go",
            lang: "go",
            code: `_, err = db.Put(ctx, "sessions/abc", map[string]any{"user": 42},
	&celeris.PutOptions{TTLMs: 30 * 60 * 1000})
item, _ := db.Get(ctx, "sessions/abc", nil)
fmt.Println(*item.ExpiresAtMs)`,
          },
          {
            id: "rust",
            label: "Rust",
            lang: "rust",
            code: `db.put_with(
    "sessions/abc",
    &json!({"user": 42}),
    PutOptions { ttl_ms: Some(30 * 60 * 1000), ..Default::default() },
).await?;`,
          },
        ]}
      />
      <Sh>{`curl -X PUT "localhost:8080/v1/kv/sessions/abc?ttl_ms=1800000" -d '{"user":42}'`}</Sh>
      <Sh>{`celeris put sessions/abc '{"user":42}' --ttl 30m`}</Sh>
      <p>
        TTLs use the leader&rsquo;s clock at the moment of the write, and in a replicated cluster the same timestamp is applied on every replica, so replicas agree on when a key expires even
        if their own clocks differ slightly.
      </p>

      <H2 id="cas">Compare-and-set</H2>
      <p>
        Two conditions turn a write into a conditional write. <code>if_version=N</code> applies it only if the key&rsquo;s current version is exactly N. <code>if_absent=true</code>{" "}
        applies it only if the key does not exist. If the condition does not hold, nothing is written and the server answers <code>409 condition_failed</code>, with the key&rsquo;s{" "}
        <code>current_version</code> (or <code>null</code> if it does not exist) in the error. <code>delete</code> accepts <code>if_version</code> too.
      </p>
      <CodeTabs
        group="sdk-lang"
        items={[
          {
            id: "ts",
            label: "TypeScript",
            lang: "ts",
            code: `const cur = await db.get<{ stock: number }>("items/sku-1");
try {
  await db.put("items/sku-1", { stock: cur!.value.stock - 1 }, { ifVersion: cur!.version });
} catch (e) {
  if (e instanceof CelerisError && e.code === "condition_failed") {
    console.log("someone else wrote first, current version:", e.details["current_version"]);
  } else throw e;
}

// create only if it does not exist yet
await db.put("users/42", { name: "Ada" }, { ifAbsent: true });`,
          },
          {
            id: "py",
            label: "Python",
            lang: "py",
            code: `cur = db.get("items/sku-1")
try:
    db.put("items/sku-1", {"stock": cur.value["stock"] - 1}, if_version=cur.version)
except CelerisError as e:
    if e.code == "condition_failed":
        print("someone else wrote first, current version:", e.details.get("current_version"))
    else:
        raise

db.put("users/42", {"name": "Ada"}, if_absent=True)  # create only if absent`,
          },
          {
            id: "go",
            label: "Go",
            lang: "go",
            code: `cur, _ := db.Get(ctx, "items/sku-1", nil)
_, err = db.Put(ctx, "items/sku-1", map[string]int{"stock": 41},
	&celeris.PutOptions{IfVersion: &cur.Version})
if celeris.IsCode(err, "condition_failed") {
	fmt.Println("someone else wrote first")
}

_, err = db.Put(ctx, "users/42", map[string]string{"name": "Ada"},
	&celeris.PutOptions{IfAbsent: true})`,
          },
          {
            id: "rust",
            label: "Rust",
            lang: "rust",
            code: `let cur = db.get::<serde_json::Value>("items/sku-1").await?.unwrap();
let res = db
    .put_with(
        "items/sku-1",
        &json!({"stock": 41}),
        PutOptions { if_version: Some(cur.version), ..Default::default() },
    )
    .await;
if let Err(e) = &res {
    if e.code() == Some("condition_failed") {
        println!("someone else wrote first");
    }
}

db.put_with("users/42", &json!({"name": "Ada"}), PutOptions { if_absent: true, ..Default::default() }).await?;`,
          },
        ]}
      />
      <Sh>{`curl -X PUT "localhost:8080/v1/kv/items/sku-1?if_version=17" -d '{"stock":41}'
curl -X PUT "localhost:8080/v1/kv/users/42?if_absent=true" -d '{"name":"Ada"}'`}</Sh>
      <Sh>{`celeris put items/sku-1 '{"stock":41}' --if-version 17
celeris put users/42 '{"name":"Ada"}' --if-absent`}</Sh>
      <Callout kind="warn" title="Conditions need strict">
        <code>if_version</code> and <code>if_absent</code> only make sense when there is a single authoritative order of writes. Under <code>available</code> or <code>eventual</code>{" "}
        consistency in a cluster they are refused with <code>400 conditions_require_strict</code>. See <DocLink to="available-mode">Available mode</DocLink>.
      </Callout>

      <H2 id="batches">Atomic batches</H2>
      <p>
        A batch applies up to 10,000 puts and deletes <strong>atomically</strong>: all of them or none, under one mutation ID and one commit version. Each operation can carry its own{" "}
        <code>ttl_ms</code>, <code>if_version</code> or <code>if_absent</code>. The conditions are all checked against the state before the batch, and if any fails the whole batch fails
        and nothing changes.
      </p>
      <CodeTabs
        group="sdk-lang"
        items={[
          {
            id: "ts",
            label: "TypeScript",
            lang: "ts",
            code: `await db.batch([
  { op: "put", key: "orders/1001", value: { total: 3 }, if_absent: true, ttl_ms: 86_400_000 },
  { op: "delete", key: "carts/9", if_version: 12 },
]);`,
          },
          {
            id: "py",
            label: "Python",
            lang: "py",
            code: `db.batch([
    {"op": "put", "key": "orders/1001", "value": {"total": 3}, "if_absent": True, "ttl_ms": 86_400_000},
    {"op": "delete", "key": "carts/9", "if_version": 12},
])`,
          },
          {
            id: "go",
            label: "Go",
            lang: "go",
            code: `v := uint64(12)
_, err = db.Batch(ctx, []celeris.BatchOp{
	{Op: "put", Key: "orders/1001", Value: map[string]int{"total": 3}, IfAbsent: true, TTLMs: 86_400_000},
	{Op: "delete", Key: "carts/9", IfVersion: &v},
}, nil)`,
          },
          {
            id: "rust",
            label: "Rust",
            lang: "rust",
            code: `db.batch(
    vec![
        BatchOp::Put {
            key: "orders/1001".into(),
            value: json!({"total": 3}),
            ttl_ms: Some(86_400_000),
            if_version: None,
            if_absent: true,
        },
        BatchOp::Delete { key: "carts/9".into(), if_version: Some(12) },
    ],
    WriteOptions::default(),
).await?;`,
          },
        ]}
      />
      <Sh>{`curl -X POST localhost:8080/v1/batch -d '{"ops":[
  {"op":"put","key":"orders/1001","value":{"total":3},"if_absent":true},
  {"op":"delete","key":"carts/9","if_version":12}
]}'`}</Sh>
      <H3 id="batch-scope">Where atomicity ends</H3>
      <ul>
        <li>
          <strong>One replica set.</strong> In a replicated cluster each key belongs to a replica set, and a batch is one log entry in one set&rsquo;s Raft group. A batch whose keys span
          several sets is refused with <code>400 cross_group_batch</code> and nothing is applied. With a replication factor equal to the node count (for example 3 nodes, RF 3) there is
          exactly one replica set and every batch qualifies. On larger clusters, use <code>celeris partitions --key K</code> to see where a key lives, and keep keys that must change
          together in one document where you can.
        </li>
        <li>
          <strong>Not across modes.</strong> In <code>available</code> mode a batch is resolved key by key, not atomically. Use <code>strict</code> for batches that must be all-or-nothing.
        </li>
        <li>
          <strong>No read isolation.</strong> A batch is atomic for writes. Celeris has no multi-key read transactions: a scan that runs while a batch commits can see it partially, because a
          scan is not a point-in-time snapshot.
        </li>
      </ul>

      <H2 id="mutation-ids">Mutation IDs and safe retries</H2>
      <p>
        Networks fail in the middle of a request. If a client sends a write and the connection drops before the answer arrives, it cannot know whether the write happened. Celeris solves
        this with <strong>mutation IDs</strong>: every write carries a UUID, the server remembers the ID of each committed write, and a retry that reuses the ID is recognised and answered
        with the original outcome (<code>deduplicated: true</code>) instead of being applied again.
      </p>
      <ul>
        <li>
          The SDKs generate an ID for every write and reuse it for every internal retry (connection failures, redirects to another node, transient 503s). The CLI does the same and retries up to
          three times.
        </li>
        <li>
          You can supply your own with the <code>celeris-mutation-id</code> header or the <code>mutation_id</code> option, which lets a retry survive a process restart. The ID must be a UUID.
        </li>
        <li>
          The same ID with a different payload is a bug in the caller and is answered <code>422 mutation_id_reused</code>.
        </li>
        <li>
          Dedupe records are kept for <code>mutation_retention_secs</code> (default 24 hours). A retry after that window is no longer recognised.
        </li>
      </ul>
      <CodeTabs
        group="sdk-lang"
        items={[
          {
            id: "ts",
            label: "TypeScript",
            lang: "ts",
            code: `import { randomUUID } from "node:crypto"; // or crypto.randomUUID() in the browser
const mutationId = randomUUID();
const res = await db.put("jobs/7", { state: "queued" }, { mutationId });
// retrying later with the same ID is harmless:
const again = await db.put("jobs/7", { state: "queued" }, { mutationId });
console.log(again.deduplicated); // true`,
          },
          {
            id: "py",
            label: "Python",
            lang: "py",
            code: `import uuid
mutation_id = str(uuid.uuid4())
db.put("jobs/7", {"state": "queued"}, mutation_id=mutation_id)
again = db.put("jobs/7", {"state": "queued"}, mutation_id=mutation_id)
print(again.deduplicated)  # True`,
          },
          {
            id: "go",
            label: "Go",
            lang: "go",
			code: `id := uuid.NewString() // any UUID generator
_, err = db.Put(ctx, "jobs/7", map[string]string{"state": "queued"}, &celeris.PutOptions{MutationID: id})
again, _ := db.Put(ctx, "jobs/7", map[string]string{"state": "queued"}, &celeris.PutOptions{MutationID: id})
fmt.Println(again.Deduplicated) // true`,
          },
          {
            id: "rust",
            label: "Rust",
            lang: "rust",
            code: `let id = uuid::Uuid::new_v4().to_string();
let opts = || PutOptions { mutation_id: Some(id.clone()), ..Default::default() };
db.put_with("jobs/7", &json!({"state": "queued"}), opts()).await?;
let again = db.put_with("jobs/7", &json!({"state": "queued"}), opts()).await?;
assert!(again.deduplicated);`,
          },
        ]}
      />
      <Sh>{`celeris put jobs/7 '{"state":"queued"}' --mutation-id 5d0c2b4e-7c1a-4f1e-9a39-2f4c0d5e8a11`}</Sh>

      <H2 id="unknown-outcome">When the outcome is unknown</H2>
      <p>
        Every write error carries an <code>outcome</code>. <code>not_applied</code> means nothing was written and it is safe to treat the call as failed. <code>unknown</code> means the write{" "}
        <strong>may have committed</strong>: the storage layer could not confirm durability, or the connection broke after the request left. Celeris never reports a plain failure in that
        case. The SDKs raise a dedicated error (<code>OutcomeUnknownError</code>) that carries the mutation ID, and the CLI exits with code 3.
      </p>
      <Steps>
        <Step title="Prefer retrying with the same ID">
          The simplest resolution is to repeat the write with the same mutation ID. If the first attempt committed, you get <code>deduplicated: true</code> and the original version. If it did
          not, the write is applied now. Either way, it ends up applied exactly once.
        </Step>
        <Step title="Or ask what happened">
          <code>GET /v1/mutations/&lt;id&gt;</code> returns <code>200 {"{"}&quot;status&quot;:&quot;committed&quot;,&quot;version&quot;:N{"}"}</code> if it committed. A <code>404</code> with{" "}
          <code>status: unknown</code> means it did not commit, is still in flight, or is older than the retention window. A 404 is therefore not proof of failure, which is why retrying with
          the same ID is the better default.
        </Step>
        <Step title="Never assume">
          Do not turn an unknown outcome into a user-visible failure such as &ldquo;payment failed&rdquo; unless you have resolved it. Surface it as &ldquo;confirming&rdquo; and resolve it.
        </Step>
      </Steps>
      <CodeTabs
        group="sdk-lang"
        items={[
          {
            id: "ts",
            label: "TypeScript",
            lang: "ts",
            code: `import { OutcomeUnknownError } from "@celeris/client";

const mutationId = crypto.randomUUID();
try {
  await db.put("orders/1001", order, { ifAbsent: true, mutationId });
} catch (e) {
  if (!(e instanceof OutcomeUnknownError)) throw e;
  const { committed, version } = await db.mutationStatus(e.mutationId!);
  if (!committed) {
    // not proven either way: retry with the SAME id, it applies at most once
    await db.put("orders/1001", order, { ifAbsent: true, mutationId });
  }
}`,
          },
          {
            id: "py",
            label: "Python",
            lang: "py",
            code: `mutation_id = str(uuid.uuid4())
try:
    db.put("orders/1001", order, if_absent=True, mutation_id=mutation_id)
except OutcomeUnknownError as e:
    committed, version = db.mutation_status(e.mutation_id)
    if not committed:
        # not proven either way: retry with the SAME id, it applies at most once
        db.put("orders/1001", order, if_absent=True, mutation_id=mutation_id)`,
          },
          {
            id: "go",
            label: "Go",
            lang: "go",
            code: `var unknown *celeris.OutcomeUnknownError
_, err = db.Put(ctx, "orders/1001", order, &celeris.PutOptions{IfAbsent: true, MutationID: id})
if errors.As(err, &unknown) {
	committed, _, _ := db.MutationStatus(ctx, unknown.MutationID)
	if !committed {
		// not proven either way: retry with the SAME id, it applies at most once
		_, err = db.Put(ctx, "orders/1001", order, &celeris.PutOptions{IfAbsent: true, MutationID: id})
	}
}`,
          },
          {
            id: "rust",
            label: "Rust",
            lang: "rust",
            code: `use celeris_client::{Error, MutationStatus};

let opts = || PutOptions { if_absent: true, mutation_id: Some(id.clone()), ..Default::default() };
match db.put_with("orders/1001", &order, opts()).await {
    Err(Error::OutcomeUnknown { mutation_id, .. }) => {
        if let MutationStatus::Unknown = db.mutation_status(&mutation_id).await? {
            // not proven either way: retry with the SAME id, it applies at most once
            db.put_with("orders/1001", &order, opts()).await?;
        }
    }
    other => { other?; }
}`,
          },
        ]}
      />
      <Sh>{`curl localhost:8080/v1/mutations/5d0c2b4e-7c1a-4f1e-9a39-2f4c0d5e8a11`}</Sh>
      <Sh>{`celeris mutation 5d0c2b4e-7c1a-4f1e-9a39-2f4c0d5e8a11`}</Sh>
      <p>
        For the full picture of what can go wrong and what each error code means, see <DocLink to="errors">Errors</DocLink>.
      </p>

      <H2 id="scan">Scans and pagination</H2>
      <p>
        <code>scan</code> lists keys in byte order. Select a range with <code>prefix</code>, or with <code>start</code> (inclusive) and <code>end</code> (exclusive). Results come in pages of{" "}
        <code>limit</code> items (1 to 1000, default 100). When more remain the response has a <code>next_cursor</code>; pass it as <code>after</code> to get the next page. It is{" "}
        <code>null</code> on the last page. The SDK iterators do this for you.
      </p>
      <CodeTabs
        group="sdk-lang"
        items={[
          {
            id: "ts",
            label: "TypeScript",
            lang: "ts",
            code: `for await (const item of db.scan({ prefix: "orders/", limit: 200 })) {
  console.log(item.key, item.value);
}

// or manage the cursor yourself
let after: string | undefined;
do {
  const page = await db.scanPage({ prefix: "orders/", limit: 100 }, after);
  for (const it of page.items) console.log(it.key);
  after = page.nextCursor ?? undefined;
} while (after);`,
          },
          {
            id: "py",
            label: "Python",
            lang: "py",
            code: `for item in db.scan(prefix="orders/", limit=200):
    print(item.key, item.value)

after = None
while True:
    page = db.scan_page(prefix="orders/", limit=100, after=after)
    for it in page.items:
        print(it.key)
    if page.next_cursor is None:
        break
    after = page.next_cursor`,
          },
          {
            id: "go",
            label: "Go",
            lang: "go",
            code: `err = db.Scan(ctx, &celeris.ScanOptions{Prefix: "orders/", Limit: 200}, func(it celeris.Item) bool {
	fmt.Println(it.Key, string(it.Value))
	return true // return false to stop early
})`,
          },
          {
            id: "rust",
            label: "Rust",
            lang: "rust",
            code: `use celeris_client::ScanOptions;

let opts = ScanOptions { prefix: Some("orders/".into()), limit: Some(200), ..Default::default() };
let mut after: Option<String> = None;
loop {
    let page = db.scan_page::<serde_json::Value>(&opts, after.as_deref()).await?;
    for it in &page.items {
        println!("{}", it.key);
    }
    match page.next_cursor {
        Some(c) => after = Some(c),
        None => break,
    }
}`,
          },
        ]}
      />
      <Sh>{`curl "localhost:8080/v1/scan?prefix=orders/&limit=100"
curl "localhost:8080/v1/scan?prefix=orders/&limit=100&after=orders/0100"`}</Sh>
      <Sh>{`celeris scan --prefix orders/ --limit 100
celeris scan --prefix orders/ --limit 100 --after orders/0100`}</Sh>
      <ul>
        <li>
          <strong>A scan is not a snapshot.</strong> Each item is a committed version, but items on later pages may be newer than items on earlier ones. Pages never skip or repeat a key
          as long as it is not modified while you page.
        </li>
        <li>
          <strong>In a cluster</strong> a scan gathers from every replica set and merges by key. With <code>strict</code> (default) or <code>session</code> it reads each set through its
          leader and fails with <code>503 scan_incomplete</code> if a set is unavailable. With <code>available</code> or <code>eventual</code> it reads any replica and sets{" "}
          <code>partial: true</code> if a set could not be reached.
        </li>
        <li>
          To filter on values rather than keys, use <DocLink to="queries">queries</DocLink>.
        </li>
      </ul>

      <H2 id="limits">Limits</H2>
      <Params
        rows={[
          { name: "key size", type: "bytes", def: "1 to 1024", desc: "UTF-8. Must not start with %00. . and .. path segments are not addressable over HTTP." },
          { name: "value size", type: "bytes", def: "4 MiB", desc: "One JSON document." },
          { name: "batch operations", type: "count", def: "10,000", desc: "Per batch." },
          { name: "batch payload", type: "bytes", def: "32 MiB", desc: "Keys plus values in one batch." },
          { name: "scan limit", type: "items", def: "100 (1 to 1000)", desc: "Page size for scan and query." },
          { name: "ttl_ms", type: "ms", def: "none", desc: "Must be at least 1." },
          { name: "mutation retention", type: "seconds", def: "86400", desc: "How long a committed mutation ID is remembered (storage.mutation_retention_secs)." },
        ]}
      />

      <H2 id="patterns">Patterns</H2>
      <H3 id="pattern-counter">A counter with a compare-and-set retry loop</H3>
      <p>
        Read the value and its version, compute the new value, write with <code>if_version</code>. If another client got in first the write fails with <code>condition_failed</code>, so you
        read again and retry. The count is exact no matter how many clients race. Under heavy contention on one key add a short random backoff, or shard the counter across several keys and
        sum them with a scan.
      </p>
      <CodeTabs
        group="sdk-lang"
        items={[
          {
            id: "ts",
            label: "TypeScript",
            lang: "ts",
            code: `async function increment(db: Client, key: string): Promise<number> {
  for (;;) {
    const cur = await db.get<{ n: number }>(key);
    const n = (cur?.value.n ?? 0) + 1;
    try {
      await db.put(key, { n }, cur ? { ifVersion: cur.version } : { ifAbsent: true });
      return n;
    } catch (e) {
      if (e instanceof CelerisError && e.code === "condition_failed") continue; // lost the race
      throw e;
    }
  }
}`,
          },
          {
            id: "py",
            label: "Python",
            lang: "py",
            code: `def increment(db, key):
    while True:
        cur = db.get(key)
        n = (cur.value["n"] if cur else 0) + 1
        try:
            if cur:
                db.put(key, {"n": n}, if_version=cur.version)
            else:
                db.put(key, {"n": n}, if_absent=True)
            return n
        except CelerisError as e:
            if e.code != "condition_failed":
                raise  # lost the race otherwise: loop and re-read`,
          },
          {
            id: "go",
            label: "Go",
            lang: "go",
            code: `func increment(ctx context.Context, db *celeris.Client, key string) (int, error) {
	for {
		item, err := db.Get(ctx, key, nil)
		if err != nil {
			return 0, err
		}
		n, opts := 1, &celeris.PutOptions{IfAbsent: true}
		if item != nil {
			var cur struct{ N int \`json:"n"\` }
			if err := item.Decode(&cur); err != nil {
				return 0, err
			}
			n, opts = cur.N+1, &celeris.PutOptions{IfVersion: &item.Version}
		}
		_, err = db.Put(ctx, key, map[string]int{"n": n}, opts)
		if celeris.IsCode(err, "condition_failed") {
			continue // lost the race
		}
		return n, err
	}
}`,
          },
          {
            id: "rust",
            label: "Rust",
            lang: "rust",
            code: `async fn increment(db: &Client, key: &str) -> celeris_client::Result<u64> {
    loop {
        let cur = db.get::<serde_json::Value>(key).await?;
        let n = cur.as_ref().and_then(|i| i.value["n"].as_u64()).unwrap_or(0) + 1;
        let opts = match &cur {
            Some(i) => PutOptions { if_version: Some(i.version), ..Default::default() },
            None => PutOptions { if_absent: true, ..Default::default() },
        };
        match db.put_with(key, &json!({ "n": n }), opts).await {
            Ok(_) => return Ok(n),
            Err(e) if e.code() == Some("condition_failed") => continue, // lost the race
            Err(e) => return Err(e),
        }
    }
}`,
          },
        ]}
      />

      <H3 id="pattern-lock">A lock with a TTL</H3>
      <p>
        <code>if_absent</code> plus a TTL gives you a lease: whoever creates the key owns it, and it disappears on its own if the owner crashes. Release it with a conditional delete so you
        never delete someone else&rsquo;s lock.
      </p>
      <CodeTabs
        group="sdk-lang"
        items={[
          {
            id: "ts",
            label: "TypeScript",
            lang: "ts",
            code: `async function tryLock(db: Client, name: string, owner: string, ttlMs = 30_000): Promise<boolean> {
  try {
    await db.put(\`locks/\${name}\`, { owner }, { ifAbsent: true, ttlMs });
    return true;
  } catch (e) {
    if (e instanceof CelerisError && e.code === "condition_failed") return false; // held by someone else
    throw e;
  }
}

async function unlock(db: Client, name: string, owner: string) {
  const cur = await db.get<{ owner: string }>(\`locks/\${name}\`);
  if (cur?.value.owner === owner) {
    await db.delete(\`locks/\${name}\`, { ifVersion: cur.version }).catch(() => {}); // expired or taken over meanwhile
  }
}`,
          },
          {
            id: "py",
            label: "Python",
            lang: "py",
            code: `def try_lock(db, name, owner, ttl_ms=30_000):
    try:
        db.put(f"locks/{name}", {"owner": owner}, if_absent=True, ttl_ms=ttl_ms)
        return True
    except CelerisError as e:
        if e.code == "condition_failed":
            return False  # held by someone else
        raise

def unlock(db, name, owner):
    cur = db.get(f"locks/{name}")
    if cur and cur.value["owner"] == owner:
        try:
            db.delete(f"locks/{name}", if_version=cur.version)
        except CelerisError:
            pass  # expired or taken over meanwhile`,
          },
          {
            id: "go",
            label: "Go",
            lang: "go",
            code: `func tryLock(ctx context.Context, db *celeris.Client, name, owner string) (bool, error) {
	_, err := db.Put(ctx, "locks/"+name, map[string]string{"owner": owner},
		&celeris.PutOptions{IfAbsent: true, TTLMs: 30_000})
	if celeris.IsCode(err, "condition_failed") {
		return false, nil // held by someone else
	}
	return err == nil, err
}

func unlock(ctx context.Context, db *celeris.Client, name, owner string) {
	item, err := db.Get(ctx, "locks/"+name, nil)
	if err != nil || item == nil {
		return
	}
	var cur struct{ Owner string \`json:"owner"\` }
	if item.Decode(&cur) == nil && cur.Owner == owner {
		_, _ = db.Delete(ctx, "locks/"+name, &celeris.DeleteOptions{IfVersion: &item.Version})
	}
}`,
          },
          {
            id: "rust",
            label: "Rust",
            lang: "rust",
            code: `async fn try_lock(db: &Client, name: &str, owner: &str) -> celeris_client::Result<bool> {
    let opts = PutOptions { if_absent: true, ttl_ms: Some(30_000), ..Default::default() };
    match db.put_with(&format!("locks/{name}"), &json!({ "owner": owner }), opts).await {
        Ok(_) => Ok(true),
        Err(e) if e.code() == Some("condition_failed") => Ok(false), // held by someone else
        Err(e) => Err(e),
    }
}

async fn unlock(db: &Client, name: &str, owner: &str) -> celeris_client::Result<()> {
    let key = format!("locks/{name}");
    if let Some(cur) = db.get::<serde_json::Value>(&key).await? {
        if cur.value["owner"] == owner {
            let _ = db.delete_with(&key, DeleteOptions { if_version: Some(cur.version), ..Default::default() }).await;
        }
    }
    Ok(())
}`,
          },
        ]}
      />
      <Callout kind="warn" title="A lease is not a mutex">
        If the owner pauses longer than the TTL (a long GC pause, a stalled VM), the lock expires and someone else takes it while the first owner still believes it holds it. For work that must
        never overlap, also fence the protected writes: store the lock key&rsquo;s <code>version</code> as a fencing token and have the protected write use <code>if_version</code> on the
        resource it modifies.
      </Callout>

      <H3 id="pattern-order">Idempotent order creation</H3>
      <p>
        Combine a client-chosen mutation ID with <code>if_absent</code>. The mutation ID makes a retry of the same click harmless (the second attempt returns{" "}
        <code>deduplicated: true</code>). The <code>if_absent</code> condition stops two different requests from creating the same order. Putting the cart cleanup in the same batch means
        the order exists if and only if the cart is gone.
      </p>
      <CodeTabs
        group="sdk-lang"
        items={[
          {
            id: "ts",
            label: "TypeScript",
            lang: "ts",
            code: `// mutationId is created once per checkout attempt and stored with it (a form field, a request header...)
async function placeOrder(db: Client, orderId: string, userId: string, order: object, mutationId: string) {
  const res = await db.batch(
    [
      { op: "put", key: \`orders/\${orderId}\`, value: order, if_absent: true },
      { op: "delete", key: \`carts/\${userId}\` },
    ],
    { mutationId },
  );
  return res.deduplicated ? "already placed" : "placed";
}`,
          },
          {
            id: "py",
            label: "Python",
            lang: "py",
            code: `def place_order(db, order_id, user_id, order, mutation_id):
    res = db.batch(
        [
            {"op": "put", "key": f"orders/{order_id}", "value": order, "if_absent": True},
            {"op": "delete", "key": f"carts/{user_id}"},
        ],
        mutation_id=mutation_id,  # created once per checkout attempt
    )
    return "already placed" if res.deduplicated else "placed"`,
          },
          {
            id: "go",
            label: "Go",
            lang: "go",
            code: `func placeOrder(ctx context.Context, db *celeris.Client, orderID, userID string, order any, mutationID string) (string, error) {
	res, err := db.Batch(ctx, []celeris.BatchOp{
		{Op: "put", Key: "orders/" + orderID, Value: order, IfAbsent: true},
		celeris.Delete("carts/" + userID),
	}, &celeris.WriteOptions{MutationID: mutationID}) // created once per checkout attempt
	if err != nil {
		return "", err
	}
	if res.Deduplicated {
		return "already placed", nil
	}
	return "placed", nil
}`,
          },
          {
            id: "rust",
            label: "Rust",
            lang: "rust",
            code: `async fn place_order(db: &Client, order_id: &str, user_id: &str, order: serde_json::Value, mutation_id: String)
    -> celeris_client::Result<&'static str>
{
    let res = db.batch(
        vec![
            BatchOp::Put { key: format!("orders/{order_id}"), value: order, ttl_ms: None, if_version: None, if_absent: true },
            BatchOp::delete(format!("carts/{user_id}")),
        ],
        WriteOptions { mutation_id: Some(mutation_id), ..Default::default() }, // created once per checkout attempt
    ).await?;
    Ok(if res.deduplicated { "already placed" } else { "placed" })
}`,
          },
        ]}
      />
      <p>
        A second checkout that reuses the order ID with a <em>new</em> mutation ID fails with <code>409 condition_failed</code>, which is the signal that the order already exists.
      </p>

      <H2 id="next">Next steps</H2>
      <ul>
        <li>
          <DocLink to="consistency">Consistency</DocLink>: pick the right mode per call.
        </li>
        <li>
          <DocLink to="queries">Queries and indexes</DocLink>: filter, project, sort and aggregate on the server.
        </li>
        <li>
          <DocLink to="change-streams">Change streams</DocLink>: react to writes in real time.
        </li>
        <li>
          <DocLink to="errors">Errors</DocLink>: every error code and what to do about it.
        </li>
      </ul>
    </>
  );
}

export const page: DocPage = {
  slug: "reads-writes",
  title: "Reading and writing data",
  group: "Guides",
  summary: "Put, get, delete, batches, TTL, compare-and-set and safe retries.",
  keywords: ["put", "get", "delete", "crud", "cas", "compare and set", "optimistic locking", "if_version", "if_absent", "ttl", "expire", "batch", "transaction", "idempotency", "idempotent", "retry", "mutation id", "pagination", "cursor", "scan", "counter", "lock", "unknown outcome"],
  Body,
};
