# Celeris Go client

Go client for [Celeris](../../README.md). Requires Go 1.22 or later and has no
dependencies outside the standard library, including a small built-in
WebSocket client for change streams.

```go
import celeris "github.com/vinitpatil519/CelerisDB/sdks/go"

db, err := celeris.New(celeris.Options{
    Nodes: []string{"http://10.0.0.1:8080", "http://10.0.0.2:8080"},
})

written, err := db.Put(ctx, "users/42", map[string]any{"name": "Ada"}, nil)

item, err := db.Get(ctx, "users/42", &celeris.ReadOptions{Consistency: celeris.Session})
var user User
err = item.Decode(&user)

// Compare-and-set
_, err = db.Put(ctx, "users/42", User{Name: "Ada L."}, &celeris.PutOptions{IfVersion: written.Version})
if celeris.IsCode(err, "condition_failed") { /* someone else wrote first */ }

// Atomic batch under one mutation ID
_, err = db.Batch(ctx, []celeris.BatchOp{
    celeris.Put("orders/1", map[string]int{"total": 3}),
    celeris.Delete("carts/9"),
}, nil)

err = db.Scan(ctx, &celeris.ScanOptions{Prefix: "orders/"}, func(it celeris.Item) bool {
    fmt.Println(it.Key, string(it.Value))
    return true
})

// Filtered on the server; only matches come back
err = db.Query(ctx, &celeris.QueryOptions{
    ScanOptions: celeris.ScanOptions{Prefix: "orders/"},
    Where:       map[string]any{"status": "paid", "total": map[string]any{"$gte": 100}},
    Fields:      []string{"total"},
}, func(it celeris.Item) bool { fmt.Println(it.Key, string(it.Value)); return true })
```

`Get` returns `(nil, nil)` for a missing key.

## Guarantees

- **Safe retries.** Every write carries a mutation ID. The client retries
  connection failures, redirects (`not_leader`, `not_owner`) and errors that
  guarantee nothing was applied, always with the same ID. The server
  deduplicates, so a write is never applied twice.
- **Honest outcomes.** `*celeris.OutcomeUnknownError` (with `MutationID`)
  means the write may or may not have committed. Check it with
  `db.MutationStatus(ctx, id)`. `celeris.ErrUnreachable` on a write means no
  connection was ever opened, so nothing was applied.
- **No silent downgrade.** Every result reports the consistency the server
  applied.
- **Sessions.** The client remembers the latest `celeris-session-index`
  token and sends it with `Session` reads.

## Change streams

```go
w, err := db.Watch(ctx, "orders/")
defer w.Close()
fmt.Println(w.Hello.Partial) // false: this node covers every replica set
for {
    ev, err := w.Next(ctx)
    if err != nil {
        break // celeris.ErrWatchClosed, or ctx.Err()
    }
    if ev.Change != nil {
        fmt.Println(ev.Change.Kind, ev.Change.Key, string(ev.Change.Value))
    } else {
        // ev.Lagged events were dropped: re-read what you depend on.
    }
}
```

## Development

The integration tests need a running node (or several, comma-separated):

```bash
CELERIS_URL=http://127.0.0.1:8080 go test ./...
```

Without Go installed, run them in a container against the compose cluster:

```bash
docker compose up -d --build
docker run --rm --network celerisdb_default -v "$PWD/sdks/go:/src" -w /src \
  -e CELERIS_URL=http://node-a:8080,http://node-b:8080,http://node-c:8080 \
  golang:1.23 go test ./...
```
