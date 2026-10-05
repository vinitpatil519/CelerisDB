# celeris-client (Rust)

Async Rust client for [Celeris](../../README.md), built on `tokio`, `reqwest`
and `tokio-tungstenite`.

```rust
use celeris_client::{BatchOp, Client, Consistency, PutOptions, ReadOptions, WriteOptions};
use serde_json::json;

let db = Client::builder()
    .nodes(["http://10.0.0.1:8080", "http://10.0.0.2:8080"])
    .build()?;

let written = db.put("users/42", &json!({"name": "Ada"})).await?;
let user = db
    .get_with::<serde_json::Value>("users/42", ReadOptions {
        consistency: Some(Consistency::Session),
        ..Default::default()
    })
    .await?;

// Compare-and-set
db.put_with("users/42", &json!({"name": "Ada L."}), PutOptions {
    if_version: written.version,
    ..Default::default()
})
.await?;

// Atomic batch under one mutation ID
db.batch(
    vec![BatchOp::put("orders/1", json!({"total": 3})), BatchOp::delete("carts/9")],
    WriteOptions::default(),
)
.await?;
```

Values are anything `Serialize` on the way in and `DeserializeOwned` on the
way out, so typed structs work directly: `db.get::<User>("users/42")`.

## Guarantees

- **Safe retries.** Every write carries a mutation ID. The client retries
  connection failures, redirects (`not_leader`, `not_owner`) and errors that
  guarantee nothing was applied, always with the same ID. The server
  deduplicates, so a write is never applied twice.
- **Honest outcomes.** `Error::OutcomeUnknown { mutation_id, .. }` means the
  write may or may not have committed. Check it with
  `db.mutation_status(&id)`. `Error::Unreachable` on a write means no
  connection was ever opened, so nothing was applied.
- **No silent downgrade.** Every result reports the consistency the server
  applied.
- **Sessions.** The client remembers the latest `celeris-session-index`
  token and sends it with `session` reads.

## Change streams

```rust
use celeris_client::WatchEvent;

let mut watch = db.watch("orders/").await?;
while let Some(event) = watch.next().await? {
    match event {
        WatchEvent::Change(e) => println!("{} {} {}", e.kind, e.key, e.value),
        WatchEvent::Lagged(n) => println!("missed {n} events: re-read"),
    }
}
```

Streams are best-effort and start at "now"; `watch.partial()` tells you
whether this node covers all replica sets.

## Features

- `rustls`: HTTPS and WSS with rustls and the bundled Mozilla roots.

## Development

```bash
cargo test -p celeris-client   # starts an in-process node
```
