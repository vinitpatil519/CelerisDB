import { Callout, Code, Details, DocLink, H2, H3, OsCode, Params, Table, type DocPage } from "../kit";

function Body() {
  return (
    <>
      <p>
        The Go client lives in the <code>sdks/go</code> module of the repository. It needs Go 1.22 or newer and uses <strong>only the
        standard library</strong>, including a small built-in WebSocket client for change streams. The package name is{" "}
        <code>celeris</code>, and every call takes a <code>context.Context</code>.
      </p>

      <Callout kind="note" title="Packaging status">
        There are no version tags for the module yet, so you fetch it at a branch or commit (<code>@main</code> or <code>@COMMIT_SHA</code>)
        or use a local clone. Go records an exact pseudo-version in your <code>go.mod</code>. Everything here is taken from the SDK source.
      </Callout>

      <H2 id="install">Install</H2>
      <OsCode
        linux={`mkdir celeris-demo && cd celeris-demo
go mod init example.com/celeris-demo
go get github.com/vinitpatil519/CelerisDB/sdks/go@main`}
        macos={`mkdir celeris-demo && cd celeris-demo
go mod init example.com/celeris-demo
go get github.com/vinitpatil519/CelerisDB/sdks/go@main`}
        windows={`mkdir celeris-demo
cd celeris-demo
go mod init example.com/celeris-demo
go get github.com/vinitpatil519/CelerisDB/sdks/go@main`}
      />
      <p>
        For a reproducible build, replace <code>@main</code> with a commit hash. If you cloned the repository and want to use your local
        copy (for example to try changes), add a <code>replace</code> directive:
      </p>
      <OsCode
        unix={`go mod edit -require=github.com/vinitpatil519/CelerisDB/sdks/go@v0.0.0 \\
  -replace=github.com/vinitpatil519/CelerisDB/sdks/go=../CelerisDB/sdks/go
go mod tidy`}
        windows={`go mod edit -require=github.com/vinitpatil519/CelerisDB/sdks/go@v0.0.0 \`
  -replace=github.com/vinitpatil519/CelerisDB/sdks/go=..\\CelerisDB\\sdks\\go
go mod tidy`}
      />
      <Code lang="go">{`import celeris "github.com/vinitpatil519/CelerisDB/sdks/go"`}</Code>
      <p>
        The import path ends in <code>go</code>, but the package is named <code>celeris</code>; the alias above makes that explicit.
      </p>

      <H2 id="node">A node to talk to</H2>
      <p>
        The examples use a node on <code>127.0.0.1:8080</code>. Start one from the built binary (see{" "}
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
        For a three-node cluster, run <code>docker compose up -d --build</code> in the repository root (ports 8081, 8082, 8083).
      </p>

      <H2 id="client">Create a client</H2>
      <Code lang="go">{`db, err := celeris.New(celeris.Options{
    Nodes:       []string{"http://10.0.0.1:8080", "http://10.0.0.2:8080", "http://10.0.0.3:8080"},
    Token:       os.Getenv("CELERIS_TOKEN"),
    Consistency: celeris.Strict,
    Timeout:     5 * time.Second,
    Attempts:    4,
})
if err != nil {
    log.Fatal(err)
}`}</Code>
      <p>
        <code>*celeris.Client</code> is safe for concurrent use; create one and share it. <code>New</code> returns an error only when no
        node is given.
      </p>
      <Params
        rows={[
          {
            name: "Nodes",
            type: "[]string",
            desc: "Node base URLs. A URL without http:// or https:// gets http://; trailing slashes are removed. At least one is required.",
          },
          {
            name: "Consistency",
            type: "celeris.Consistency",
            def: "\"\" (server default: strict)",
            desc: (
              <>
                Default mode. Constants: <code>Strict</code>, <code>Session</code>, <code>Bounded</code>, <code>Available</code>,{" "}
                <code>Eventual</code>.
              </>
            ),
          },
          {
            name: "Timeout",
            type: "time.Duration",
            def: "10s",
            desc: "Timeout of the internal http.Client, applied to each request. Ignored when you supply HTTPClient.",
          },
          { name: "Attempts", type: "int", def: "4", desc: "Total attempts per call across nodes and transient errors. Zero or negative means 4." },
          {
            name: "Token",
            type: "string",
            desc: (
              <>
                API token, sent as <code>Authorization: Bearer ...</code>, including on the change-stream handshake.
              </>
            ),
          },
          { name: "Headers", type: "map[string]string", desc: "Extra headers on every request, including the change-stream handshake." },
          {
            name: "HTTPClient",
            type: "*http.Client",
            def: "new client with Timeout",
            desc: "Your own client for custom transports, proxies or TLS roots. Used for all requests except change streams (see TLS).",
          },
        ]}
      />
      <H3 id="tls">TLS and custom transports</H3>
      <p>For HTTPS to a node with a private CA, supply an <code>http.Client</code> whose transport trusts it:</p>
      <Code lang="go">{`pem, _ := os.ReadFile("ca.pem")
pool := x509.NewCertPool()
pool.AppendCertsFromPEM(pem)

httpc := &http.Client{
    Timeout:   5 * time.Second,
    Transport: &http.Transport{TLSClientConfig: &tls.Config{RootCAs: pool}},
}
db, _ := celeris.New(celeris.Options{Nodes: []string{"https://db.internal:8080"}, HTTPClient: httpc})`}</Code>
      <Callout kind="warn" title="Change streams use their own dialer">
        <code>Watch</code> opens its own connection and does not go through your <code>HTTPClient</code>. For <code>https://</code> nodes it
        verifies with the system trust store (on Linux Go also honours <code>SSL_CERT_FILE</code>), ignores proxy settings, and sets no
        timeout beyond your context. For a private CA you therefore need the CA installed in the system store for streams to work. See{" "}
        <DocLink to="security">Security</DocLink>.
      </Callout>

      <H2 id="basics">Read, write, delete</H2>
      <Code lang="go">{`ctx := context.Background()

written, err := db.Put(ctx, "users/42", map[string]any{"name": "Ada", "plan": "free"}, nil)
if err != nil {
    log.Fatal(err)
}
fmt.Println(*written.Version, written.MutationID, written.Consistency)

item, err := db.Get(ctx, "users/42", nil)
if err != nil {
    log.Fatal(err)
}
if item == nil {
    fmt.Println("not found")
} else {
    var user struct {
        Name string \`json:"name"\`
        Plan string \`json:"plan"\`
    }
    if err := item.Decode(&user); err != nil {
        log.Fatal(err)
    }
    fmt.Println(user.Name, item.Version)
}

_, err = db.Delete(ctx, "users/42", nil) // deleting a missing key succeeds`}</Code>
      <p>
        Pass <code>nil</code> for the options argument to use defaults. <code>Get</code> returns <code>(nil, nil)</code> for a missing key.
      </p>
      <Table
        head={["Type", "Fields"]}
        rows={[
          [
            <code key="i">Item</code>,
            <>
              <code>Key</code>, <code>Value</code> (<code>json.RawMessage</code>), <code>Version</code> (<code>uint64</code>),{" "}
              <code>ExpiresAtMs</code> (<code>*uint64</code>), <code>Consistency</code> (mode applied), method <code>Decode(v any) error</code>.
            </>,
          ],
          [
            <code key="w">WriteResult</code>,
            <>
              <code>Key</code>, <code>Version</code> (<code>*uint64</code>, nil while an <code>available</code> write is pending),{" "}
              <code>MutationID</code>, <code>Deduplicated</code>, <code>Replicated</code>, <code>Consistency</code>.
            </>,
          ],
        ]}
      />
      <p>
        Keys are 1 to 1024 bytes of UTF-8 and values up to 4 MiB. A key with a <code>.</code> or <code>..</code> path segment returns{" "}
        <code>celeris.ErrInvalidKey</code> without sending anything. <code>celeris.EncodeKey</code> is exported if you need the escaped form.
      </p>

      <H2 id="consistency">Consistency per call</H2>
      <Code lang="go">{`// Linearizable (server default)
db.Get(ctx, "accounts/1", &celeris.ReadOptions{Consistency: celeris.Strict})

// Read your own writes
db.Put(ctx, "cart/ada", map[string]int{"items": 2}, nil)
db.Get(ctx, "cart/ada", &celeris.ReadOptions{Consistency: celeris.Session})

// Fresh within 500 ms
db.Get(ctx, "stats/today", &celeris.ReadOptions{Consistency: celeris.Bounded, MaxStalenessMs: 500})

// Keep working during a partition
r, _ := db.Put(ctx, "likes/post-9", 41, &celeris.PutOptions{Consistency: celeris.Available})
if !r.Replicated {
    fmt.Println("accepted locally, replication pending")
}`}</Code>
      <p>
        Per-call options override the client default, which overrides the server default. The client never weakens a mode. <code>Bounded</code>{" "}
        needs <code>MaxStalenessMs</code> and applies to reads only.
      </p>
      <p>
        <strong>Sessions.</strong> In a replicated cluster the client stores the latest <code>celeris-session-index</code> token (read it
        with <code>db.Session()</code>) and sends it with <code>Session</code> reads. A lagging replica answers <code>503 session_behind</code>,
        and the client tries another node. See <DocLink to="consistency">Consistency</DocLink>.
      </p>

      <H2 id="cas-ttl">Compare-and-set and TTL</H2>
      <p>
        <code>IfVersion</code> is a pointer so that {"“"}not set{"”"} is distinct from zero.
      </p>
      <Code lang="go">{`// Create only if absent, expiring after 30 s
_, err := db.Put(ctx, "locks/report", map[string]string{"owner": "worker-1"},
    &celeris.PutOptions{IfAbsent: true, TTLMs: 30_000})

// Optimistic counter
func bump(ctx context.Context, db *celeris.Client, key string) (int, error) {
    for i := 0; i < 5; i++ {
        item, err := db.Get(ctx, key, nil)
        if err != nil {
            return 0, err
        }
        n := 1
        opts := &celeris.PutOptions{IfAbsent: true}
        if item != nil {
            var cur int
            if err := item.Decode(&cur); err != nil {
                return 0, err
            }
            n = cur + 1
            v := item.Version
            opts = &celeris.PutOptions{IfVersion: &v}
        }
        _, err = db.Put(ctx, key, n, opts)
        if celeris.IsCode(err, "condition_failed") {
            continue // someone else wrote first
        }
        return n, err
    }
    return 0, errors.New("too much contention on " + key)
}

// Conditional delete
v := uint64(7)
_, err = db.Delete(ctx, "locks/report", &celeris.DeleteOptions{IfVersion: &v})`}</Code>
      <p>
        A failed condition is a <code>*celeris.Error</code> with <code>Status</code> 409 and <code>Code</code> <code>condition_failed</code>;{" "}
        <code>Details["current_version"]</code> holds the key{"'"}s version (or nil). Nothing was written.
      </p>
      <Callout kind="warn" title="Conditions need strict writes">
        In a cluster, <code>IfVersion</code> and <code>IfAbsent</code> are refused with <code>400 conditions_require_strict</code> on{" "}
        <code>Available</code> and <code>Eventual</code> writes.
      </Callout>

      <H2 id="batch">Atomic batches</H2>
      <Code lang="go">{`res, err := db.Batch(ctx, []celeris.BatchOp{
    {Op: "put", Key: "orders/1001", Value: map[string]int{"total": 30}, IfAbsent: true},
    {Op: "put", Key: "orders/1001/audit", Value: map[string]string{"by": "ada"}, TTLMs: 86_400_000},
    celeris.Delete("carts/ada"),
}, nil)`}</Code>
      <p>
        <code>celeris.Put(key, value)</code> and <code>celeris.Delete(key)</code> build unconditional operations; fill in{" "}
        <code>BatchOp</code> directly for TTL and conditions. The batch commits atomically under one mutation ID (<code>WriteOptions</code>{" "}
        takes <code>Consistency</code> and <code>MutationID</code>). Limits: 10,000 operations and 32 MiB; in a cluster all keys must be in
        one replica set (<code>400 cross_group_batch</code>).
      </p>

      <H2 id="scan">Scans and queries</H2>
      <Code lang="go">{`// Callback style: return false to stop early
err := db.Scan(ctx, &celeris.ScanOptions{Prefix: "orders/", Limit: 200}, func(it celeris.Item) bool {
    fmt.Println(it.Key, string(it.Value))
    return true
})

// Manual paging
after := ""
for {
    page, err := db.ScanPage(ctx, &celeris.ScanOptions{Prefix: "orders/", Limit: 100}, after)
    if err != nil {
        log.Fatal(err)
    }
    if page.Partial {
        log.Println("some replica sets did not answer")
    }
    for _, it := range page.Items {
        fmt.Println(it.Key)
    }
    if page.NextCursor == "" {
        break
    }
    after = page.NextCursor
}`}</Code>
      <p>
        <code>ScanOptions</code> has <code>Prefix</code>, or <code>Start</code> (inclusive) and <code>End</code> (exclusive), plus{" "}
        <code>Limit</code> (1 to 1000) and <code>Consistency</code>. The cursor is an empty string on the last page.
      </p>
      <H3 id="query">Filter on the server</H3>
      <Code lang="go">{`err := db.Query(ctx, &celeris.QueryOptions{
    ScanOptions: celeris.ScanOptions{Prefix: "orders/"},
    Where: map[string]any{
        "status": "paid",
        "total":  map[string]any{"$gte": 100},
    },
    Fields: []string{"total"},
}, func(it celeris.Item) bool {
    fmt.Println(it.Key, string(it.Value))
    return true
})

// Ordered by a field (needs an index declared with that order)
page, err := db.QueryPage(ctx, &celeris.QueryOptions{
    ScanOptions: celeris.ScanOptions{Prefix: "orders/", Limit: 20},
    Where:       map[string]any{"status": "paid"},
    SortField:   "total",
    SortDesc:    true,
}, "")
fmt.Println(page.Index, page.Scanned, page.NextCursor)`}</Code>
      <p>
        Operators: <code>$eq $ne $gt $gte $lt $lte $in $nin $exists $prefix $contains</code> with <code>$and</code>, <code>$or</code>,{" "}
        <code>$not</code> and dotted paths. A page can be short and still carry a <code>NextCursor</code> because the server stops after{" "}
        <code>MaxScanned</code> rows (default 10,000); <code>Query</code> follows cursors for you. <code>QueryPage</code> also reports{" "}
        <code>Scanned</code>, <code>Index</code> and <code>Aggregates</code>. See <DocLink to="queries">Queries</DocLink>.
      </p>
      <H3 id="aggregate">Aggregate</H3>
      <Code lang="go">{`stats, err := db.Aggregate(ctx, &celeris.QueryOptions{
    ScanOptions: celeris.ScanOptions{Prefix: "orders/"},
    Where:       map[string]any{"status": "paid"},
    Aggregate:   map[string]any{"count": true, "sum": []string{"total"}, "max": []string{"total"}},
})
// map[count:412 sum:map[total:18230.5] max:map[total:990]]  (numbers are float64)`}</Code>
      <p>
        <code>Aggregate</code> requires <code>opts.Aggregate</code>, follows cursors and merges pages. When paging by hand, fold pages
        with <code>celeris.MergeAggregates(total, page)</code>.
      </p>

      <H2 id="watch">Live changes</H2>
      <Code lang="go">{`w, err := db.Watch(ctx, "orders/")
if err != nil {
    log.Fatal(err)
}
defer w.Close()
fmt.Println("covers every replica set:", !w.Hello.Partial)

for {
    ev, err := w.Next(ctx)
    if err != nil {
        break // celeris.ErrWatchClosed, or ctx.Err()
    }
    if ev.Change != nil {
        fmt.Println(ev.Change.Kind, ev.Change.Key, string(ev.Change.Value), ev.Change.Version)
    } else {
        fmt.Println("missed", ev.Lagged, "events: re-read what you show")
    }
}`}</Code>
      <ul>
        <li>
          <code>Next</code> returns a <code>WatchEvent</code>: either <code>Change</code> (<code>*ChangeEvent</code> with{" "}
          <code>Key</code>, <code>Kind</code> <code>"put"</code> or <code>"delete"</code>, <code>Value</code>, <code>Version</code>,{" "}
          <code>MutationID</code>) or a non-zero <code>Lagged</code> count.
        </li>
        <li>
          Cancelling the context closes the stream and <code>Next</code> returns <code>ctx.Err()</code>. A server-side close returns{" "}
          <code>ErrWatchClosed</code>. There is no automatic reconnect: reopen and re-read.
        </li>
        <li>
          Delivery is best-effort and starts at {"“"}now{"”"}. A node reports the changes of its own replica sets;{" "}
          <code>Hello.Partial</code> says whether others exist. See <DocLink to="change-streams">Change streams</DocLink>.
        </li>
        <li>
          <code>Next</code> is meant for one reading goroutine. <code>Close</code> is safe to call from another.
        </li>
      </ul>

      <H2 id="status">Mutation status, conflicts, node status</H2>
      <Code lang="go">{`committed, version, err := db.MutationStatus(ctx, "7d1c0e5a-4b8e-4f0a-9a52-3c1f6e2b9d10")

conflicts, partial, err := db.Conflicts(ctx, "likes/", 50)
err = db.ClearConflicts(ctx, "likes/post-9")

status, err := db.Status(ctx) // map[string]any`}</Code>
      <p>
        <code>committed == false</code> means the mutation did not commit, is still in flight, or is older than the retention window (24
        hours by default).
      </p>

      <H2 id="errors">Errors and unknown outcomes</H2>
      <Table
        head={["Value", "How to test", "Meaning"]}
        rows={[
          [
            <code key="e">*celeris.Error</code>,
            <>
              <code>errors.As</code>, or <code>celeris.IsCode(err, "code")</code>
            </>,
            <>
              The node answered with an error. Fields: <code>Status</code>, <code>Code</code>, <code>Message</code>, <code>Outcome</code>{" "}
              (<code>"not_applied"</code>, <code>"unknown"</code> or empty), <code>Details</code>.
            </>,
          ],
          [
            <code key="o">*celeris.OutcomeUnknownError</code>,
            <code key="oa">errors.As</code>,
            <>
              A write may or may not have committed. Fields: <code>MutationID</code>, <code>Reason</code>.
            </>,
          ],
          [
            <code key="u">celeris.ErrUnreachable</code>,
            <code key="ui">errors.Is</code>,
            "No connection could be opened. For a write, nothing was applied.",
          ],
          [<code key="k">celeris.ErrInvalidKey</code>, <code key="ki">errors.Is</code>, "The key has a . or .. segment."],
          [<code key="w">celeris.ErrWatchClosed</code>, <code key="wi">errors.Is</code>, "A change stream ended."],
        ]}
      />
      <Table
        head={["Status", "Code", "Meaning for you"]}
        rows={[
          ["409", "condition_failed", "IfVersion or IfAbsent did not hold. Not applied."],
          ["422", "mutation_id_reused", "Same mutation ID, different payload. A bug in your retry logic."],
          ["400", "invalid_key, invalid_json, invalid_query, invalid_consistency, ...", "Fix the request. Not applied."],
          ["401 / 403", "unauthorized / forbidden", "Missing token, or scope too small."],
        ]}
      />
      <p>
        See <DocLink to="errors">Errors</DocLink> for every code.
      </p>
      <H3 id="unknown">Handling an unknown outcome</H3>
      <p>
        An <code>*OutcomeUnknownError</code> carries the mutation ID the client used. Ask the server whether it committed, and repeat the
        write with that same ID if not: the server deduplicates, so it cannot apply twice.
      </p>
      <Code lang="go">{`func putSure(ctx context.Context, db *celeris.Client, key string, value any) (*celeris.WriteResult, error) {
    res, err := db.Put(ctx, key, value, nil)
    var unknown *celeris.OutcomeUnknownError
    for round := 0; errors.As(err, &unknown) && round < 3; round++ {
        committed, version, serr := db.MutationStatus(ctx, unknown.MutationID)
        if serr == nil && committed {
            return &celeris.WriteResult{Key: key, Version: version, MutationID: unknown.MutationID,
                Deduplicated: true, Replicated: true}, nil
        }
        // not committed, in flight, or too old: the same ID is still safe to retry
        res, err = db.Put(ctx, key, value, &celeris.PutOptions{MutationID: unknown.MutationID})
    }
    return res, err
}`}</Code>
      <Callout kind="warn">
        Never retry an unknown outcome with a new mutation ID, and never treat it as a plain failure. If your context expires while a write
        might be in flight, the client also returns an <code>*OutcomeUnknownError</code> rather than the context error.
      </Callout>

      <H2 id="retries">Retries, redirects and mutation IDs</H2>
      <p>
        Every write sends a UUID in the <code>celeris-mutation-id</code> header (batches also in the body), reused on every retry.
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
            "Guaranteed not applied. Backs off (100 ms times the attempt number for writes, 50 ms for reads), then the next node.",
          ],
          ["Dial failure (nothing sent)", "Next node. If every attempt fails this way: an error wrapping ErrUnreachable, nothing applied."],
          [
            "Timeout or reset after sending",
            "Might have been applied. Retries with the same ID; if unconfirmed, *OutcomeUnknownError.",
          ],
          [
            <>
              Write error with <code>outcome: unknown</code>
            </>,
            "Retries with the same ID, then *OutcomeUnknownError.",
          ],
          ["Other 4xx or 5xx", "Returned at once as *celeris.Error."],
          ["Reads and other idempotent calls", "Retried on any failure, no mutation ID."],
        ]}
      />
      <p>
        The context bounds the whole call, retries and pauses included. Use <code>context.WithTimeout</code> for an overall deadline. See
        the interactive walkthrough of these rules on the <DocLink to="sdk-typescript:retries">TypeScript page</DocLink>; every SDK follows
        the same contract.
      </p>

      <H2 id="typed">Typed values</H2>
      <p>
        The client stores <code>json.RawMessage</code> and leaves decoding to you with <code>Item.Decode</code>. If you like generics,
        wrap it once in your own code:
      </p>
      <Code lang="go">{`type Typed[T any] struct {
    Value   T
    Version uint64
}

func GetAs[T any](ctx context.Context, db *celeris.Client, key string, opts *celeris.ReadOptions) (*Typed[T], error) {
    item, err := db.Get(ctx, key, opts)
    if err != nil || item == nil {
        return nil, err
    }
    var v T
    if err := item.Decode(&v); err != nil {
        return nil, err
    }
    return &Typed[T]{Value: v, Version: item.Version}, nil
}

type User struct {
    Name string \`json:"name"\`
    Plan string \`json:"plan"\`
}

u, err := GetAs[User](ctx, db, "users/42", nil)`}</Code>
      <p>
        Values you pass to <code>Put</code> go through <code>encoding/json</code>, so struct tags, <code>omitempty</code> and custom{" "}
        <code>MarshalJSON</code> methods all apply.
      </p>

      <H2 id="testing">Testing</H2>
      <H3 id="testing-httptest">Unit tests with httptest</H3>
      <p>
        Point the client at <code>httptest</code> servers. This test checks that a redirect is retried on the second node with the same
        mutation ID.
      </p>
      <Code lang="go" title="retry_test.go">{`package app

import (
    "context"
    "net/http"
    "net/http/httptest"
    "testing"

    celeris "github.com/vinitpatil519/CelerisDB/sdks/go"
)

func TestRedirectReusesMutationID(t *testing.T) {
    var ids []string
    a := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
        ids = append(ids, r.Header.Get("celeris-mutation-id"))
        w.WriteHeader(http.StatusMisdirectedRequest) // 421
        w.Write([]byte(\`{"error":{"code":"not_leader","message":"ask b"}}\`))
    }))
    defer a.Close()
    b := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
        ids = append(ids, r.Header.Get("celeris-mutation-id"))
        w.Header().Set("celeris-session-index", "9@g1")
        w.Write([]byte(\`{"key":"k","version":3,"consistency":"strict"}\`))
    }))
    defer b.Close()

    db, _ := celeris.New(celeris.Options{Nodes: []string{a.URL, b.URL}})
    res, err := db.Put(context.Background(), "k", 1, nil)
    if err != nil || *res.Version != 3 {
        t.Fatalf("put failed: %v", err)
    }
    if len(ids) != 2 || ids[0] != ids[1] || ids[0] == "" {
        t.Fatalf("mutation ids differ: %v", ids)
    }
    if db.Session() != "9@g1" {
        t.Fatalf("session token not kept: %q", db.Session())
    }
}`}</Code>
      <H3 id="testing-real">Against a real node</H3>
      <p>
        For conditions, TTL and queries, test against a real node. The SDK{"'"}s own integration tests read node URLs from{" "}
        <code>CELERIS_URL</code> (comma-separated) and you can follow the same pattern. Without Go installed locally, run tests in a
        container on the compose network:
      </p>
      <Code lang="bash">{`docker compose up -d --build
docker run --rm --network celerisdb_default -v "$PWD:/src" -w /src \\
  -e CELERIS_URL=http://node-a:8080,http://node-b:8080,http://node-c:8080 \\
  golang:1.23 go test ./...`}</Code>
      <p>
        On Windows PowerShell, replace <code>$PWD</code> with <code>${"{PWD}"}</code> if needed and put the command on one line, or run it
        from Git Bash. The network name <code>celerisdb_default</code> comes from the repository folder name, so check{" "}
        <code>docker network ls</code> if yours differs.
      </p>

      <H2 id="example">A complete small app</H2>
      <p>
        In the <code>celeris-demo</code> module from the install step, save this as <code>main.go</code> and run <code>go run .</code>. It
        reads <code>CELERIS_NODES</code> (comma-separated) and <code>CELERIS_TOKEN</code>.
      </p>
      <Code lang="go" title="main.go">{`package main

import (
    "context"
    "errors"
    "fmt"
    "log"
    "os"
    "strings"
    "time"

    celeris "github.com/vinitpatil519/CelerisDB/sdks/go"
)

func bump(ctx context.Context, db *celeris.Client, key string) (int, error) {
    for i := 0; i < 5; i++ {
        item, err := db.Get(ctx, key, nil)
        if err != nil {
            return 0, err
        }
        n, opts := 1, &celeris.PutOptions{IfAbsent: true}
        if item != nil {
            var cur int
            if err := item.Decode(&cur); err != nil {
                return 0, err
            }
            v := item.Version
            n, opts = cur+1, &celeris.PutOptions{IfVersion: &v}
        }
        if _, err = db.Put(ctx, key, n, opts); celeris.IsCode(err, "condition_failed") {
            continue
        }
        return n, err
    }
    return 0, errors.New("too much contention")
}

func main() {
    ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
    defer cancel()

    nodes := "http://127.0.0.1:8080"
    if v := os.Getenv("CELERIS_NODES"); v != "" {
        nodes = v
    }
    db, err := celeris.New(celeris.Options{Nodes: strings.Split(nodes, ","), Token: os.Getenv("CELERIS_TOKEN")})
    if err != nil {
        log.Fatal(err)
    }

    // 1. Write with a TTL
    if _, err := db.Put(ctx, "sessions/abc", map[string]string{"user": "ada"}, &celeris.PutOptions{TTLMs: 60_000}); err != nil {
        log.Fatal(err)
    }

    // 2. Optimistic counter
    n, err := bump(ctx, db, "counters/visits")
    if err != nil {
        log.Fatal(err)
    }
    fmt.Println("visits:", n)

    // 3. Watch while another goroutine writes a batch
    w, err := db.Watch(ctx, "orders/")
    if err != nil {
        log.Fatal(err)
    }
    go func() {
        time.Sleep(300 * time.Millisecond)
        _, err := db.Batch(ctx, []celeris.BatchOp{
            celeris.Put("orders/1", map[string]any{"total": 120, "status": "paid"}),
            celeris.Put("orders/2", map[string]any{"total": 40, "status": "open"}),
        }, nil)
        if err != nil {
            log.Println("batch:", err)
        }
    }()
    ev, err := w.Next(ctx)
    if err != nil {
        log.Fatal(err)
    }
    if ev.Change != nil {
        fmt.Println("change:", ev.Change.Kind, ev.Change.Key, string(ev.Change.Value))
    }
    w.Close()

    // 4. Query and aggregate
    time.Sleep(200 * time.Millisecond)
    err = db.Query(ctx, &celeris.QueryOptions{
        ScanOptions: celeris.ScanOptions{Prefix: "orders/"},
        Where:       map[string]any{"total": map[string]any{"$gte": 100}},
    }, func(it celeris.Item) bool {
        fmt.Println("big order:", it.Key, string(it.Value))
        return true
    })
    if err != nil {
        log.Fatal(err)
    }
    stats, err := db.Aggregate(ctx, &celeris.QueryOptions{
        ScanOptions: celeris.ScanOptions{Prefix: "orders/"},
        Aggregate:   map[string]any{"count": true, "sum": []string{"total"}},
    })
    if err != nil {
        log.Fatal(err)
    }
    fmt.Println("stats:", stats)

    // 5. Clean up, reporting unknown outcomes properly
    for _, k := range []string{"orders/1", "orders/2"} {
        if _, err := db.Delete(ctx, k, nil); err != nil {
            var unknown *celeris.OutcomeUnknownError
            if errors.As(err, &unknown) {
                log.Println("unresolved, mutation id", unknown.MutationID)
            } else {
                log.Fatal(err)
            }
        }
    }
}`}</Code>
      <OsCode
        linux={`go run .`}
        macos={`go run .`}
        windows={`go run .`}
        title="run"
      />
      <p>
        Set <code>CELERIS_TOKEN</code> first when authentication is on (<code>export CELERIS_TOKEN=...</code>, or{" "}
        <code>{'$env:CELERIS_TOKEN = "..."'}</code> in PowerShell).
      </p>

      <H2 id="troubleshooting">Troubleshooting</H2>
      <Details summary="error wraps celeris: no node answered">
        Nothing accepted a connection. Check the URL, port, firewall, and that the node listens on a reachable address (default{" "}
        <code>127.0.0.1</code>; use <code>0.0.0.0:8080</code> for remote clients). <code>celeris doctor</code> checks from the node{"'"}s host.
      </Details>
      <Details summary="go get: module not found, or unknown revision">
        Use <code>@main</code> or a real commit hash; there are no semantic version tags. Behind a corporate proxy, set{" "}
        <code>GOPROXY</code>/<code>GOPRIVATE</code> appropriately, or use the local <code>replace</code> approach.
      </Details>
      <Details summary="x509: certificate signed by unknown authority">
        For requests, give <code>Options.HTTPClient</code> a transport with your CA pool. For change streams, install the CA in the system
        trust store (or set <code>SSL_CERT_FILE</code> on Linux), because <code>Watch</code> ignores the HTTP client.
      </Details>
      <Details summary="context deadline exceeded on a write">
        The deadline covers all retries. If the write may have been sent, you get <code>*OutcomeUnknownError</code>: resolve it with{" "}
        <code>MutationStatus</code> using a fresh context (not the expired one).
      </Details>
      <Details summary="401 or 403 responses">
        Authentication is on: set <code>Options.Token</code>. A 403 means the token{"'"}s scope does not cover the call.
      </Details>
      <Details summary="Numbers come back as float64 in aggregates">
        Aggregates and <code>Status</code> are <code>map[string]any</code> decoded by <code>encoding/json</code>, so numbers are{" "}
        <code>float64</code>. Convert, or decode item values into typed structs with <code>Decode</code>.
      </Details>

      <H2 id="next">Next steps</H2>
      <ul>
        <li>
          <DocLink to="consistency">Consistency</DocLink> and <DocLink to="queries">Queries</DocLink>.
        </li>
        <li>
          <DocLink to="deployment">Deployment</DocLink> and <DocLink to="clustering">Clustering</DocLink> for the nodes behind the client.
        </li>
        <li>
          <DocLink to="observability">Observability</DocLink> to watch your service{"'"}s requests in the node metrics.
        </li>
        <li>
          <DocLink to="sdk-http">HTTP from any language</DocLink> for the wire details.
        </li>
      </ul>
    </>
  );
}

export const page: DocPage = {
  slug: "sdk-go",
  title: "Go",
  group: "SDKs",
  summary: "Use the standard-library-only Go client with contexts, safe retries, queries and change streams.",
  keywords: ["golang", "go get", "module", "context", "client", "sdk", "httptest", "websocket"],
  Body,
};
