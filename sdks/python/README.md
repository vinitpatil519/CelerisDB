# celeris-client (Python)

Python client for [Celeris](../../README.md). Requires Python 3.10 or later
and has no dependencies; it uses only the standard library, including a small
built-in WebSocket client for change streams.

```python
from celeris import Client, OutcomeUnknownError

db = Client(["http://10.0.0.1:8080", "http://10.0.0.2:8080"])

db.put("users/42", {"name": "Ada"})
user = db.get("users/42", consistency="session")

# Compare-and-set
db.put("users/42", {"name": "Ada L."}, if_version=user.version)

# Atomic batch under one mutation ID
db.batch([
    {"op": "put", "key": "orders/1", "value": {"total": 3}, "if_absent": True},
    {"op": "delete", "key": "carts/9"},
])

for item in db.scan(prefix="orders/"):
    print(item.key, item.value)

# Filtered on the server; only matches come back
for item in db.query(prefix="orders/", where={"status": "paid", "total": {"$gte": 100}}, fields=["total"]):
    print(item.key, item.value)
```

## Guarantees

- **Safe retries.** Every write carries a mutation ID. The client retries
  connection failures, redirects (`not_leader`, `not_owner`) and errors that
  guarantee nothing was applied, always with the same ID. The server
  deduplicates, so a write is never applied twice.
- **Honest outcomes.** If the request may have reached a node but no answer
  came back, the client raises `OutcomeUnknownError`, which carries
  `mutation_id`. Check it with `db.mutation_status(id)`, which returns
  `(committed, version)`. A connection that could not be opened at all is
  known not to have applied anything (`outcome == "not_applied"`).
- **No silent downgrade.** Every result reports the consistency the server
  applied. The client never weakens the mode you asked for.
- **Sessions.** The client remembers the latest `celeris-session-index`
  token and sends it with `session` reads.

## Change streams

```python
with db.watch("orders/") as watch:
    print(watch.hello)            # {"node": ..., "groups": [...], "partial": False}
    for event in watch:           # blocks; or watch.next(timeout=5)
        print(event.kind, event.key, event.value, event.version)
        if watch.lagged:          # events were dropped: re-read what you show
            ...
```

Streams are best-effort and start at "now". See
[docs/API.md](../../docs/API.md#get-v1watchprefix-websocket) for coverage in
clusters.

## Development

```bash
cargo build --release -p celeris-cli   # the tests start a real node
pip install pytest
python -m pytest
```

Set `CELERIS_BIN` to test against another binary.
