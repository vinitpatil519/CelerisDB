# @celeris/client

TypeScript client for [Celeris](../../README.md), for browsers and Node.js 22 or later.
It has no runtime dependencies: it uses the platform `fetch` and `WebSocket`.

```ts
import { Client, OutcomeUnknownError } from "@celeris/client";

const db = new Client({ nodes: ["http://10.0.0.1:8080", "http://10.0.0.2:8080"] });

await db.put("users/42", { name: "Ada" });
const user = await db.get<{ name: string }>("users/42", { consistency: "session" });

// Compare-and-set
await db.put("users/42", { name: "Ada L." }, { ifVersion: user!.version });

// Atomic batch under one mutation ID
await db.batch([
  { op: "put", key: "orders/1", value: { total: 3 }, if_absent: true },
  { op: "delete", key: "carts/9" },
]);

for await (const item of db.scan({ prefix: "orders/" })) console.log(item.key, item.value);

// Filtered on the server; only matches come back
const paid = { status: "paid", total: { $gte: 100 } };
for await (const item of db.query({ prefix: "orders/", where: paid, fields: ["total"] })) console.log(item.key, item.value);
```

## Guarantees

- **Safe retries.** Every write carries a mutation ID. The client retries
  network failures, redirects (`not_leader`, `not_owner`) and errors that
  guarantee nothing was applied, always with the same ID. The server
  deduplicates, so a write is never applied twice.
- **Honest outcomes.** If the client cannot tell whether a write committed, it
  rejects with `OutcomeUnknownError`, which carries `mutationId`. Resolve it with
  `db.mutationStatus(id)`. It is never reported as a plain failure.
- **No silent downgrade.** Every result reports the consistency the server
  applied. The client never weakens the mode you asked for.
- **Sessions.** The client remembers the latest `celeris-session-index`
  token and sends it with `session` reads (read-your-writes).

## Live data

```ts
const watcher = db.watch("orders/", {
  onChange: (e) => console.log(e.kind, e.key, e.value, e.version),
  onLagged: () => reload(), // events were dropped: re-read
});
watcher.close();
```

Change streams are best-effort and start at "now". The hello message tells you
whether the node covers all replica sets (`partial: false`).
See [docs/API.md](../../docs/API.md#get-v1watchprefix-websocket).

### React

```tsx
import { useCeleris } from "@celeris/client/react";

function Profile({ id }: { id: string }) {
  const { data, loading, error } = useCeleris<User>(db, `users/${id}`);
  if (loading) return <Spinner />;
  return <h1>{data?.name}</h1>;
}
```

`useCeleris` reads the key once, then follows it through the change stream
and never moves backwards in version. It re-reads after a `lagged` notice.
Without React, use `createKeyStore(client, key)` and subscribe to it directly.

## Errors

| Class                 | When                                                                              |
| --------------------- | --------------------------------------------------------------------------------- |
| `CelerisError`        | The node answered with an error (`status`, `code`, `details`) or nothing answered |
| `OutcomeUnknownError` | A write may or may not have committed (`mutationId`)                              |

`CelerisError.outcome` is `not_applied` when the write is known not to have
happened.

## Development

```bash
cargo build --release -p celeris-cli   # the tests start a real node
npm install
npm test
```

Set `CELERIS_BIN` to test against another binary.
