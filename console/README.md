# Celeris Console

A browser admin console for Celeris clusters, built with React and Vite on top
of the TypeScript SDK.

| Page | What it shows |
|---|---|
| Overview | Every configured node: health, uptime, storage, Raft role and term, membership, anti-entropy results |
| Partitions | Map epoch, replication factor, replicas and leaders per node, and which partition and replicas hold a key |
| Data | Scan keys by prefix with any consistency mode; view, create, edit and delete JSON values with compare-and-set |
| Live | The WebSocket change stream for a prefix, with coverage and missed-event counts |
| Conflicts | Writes that lost last-writer-wins under `available`, with a button to clear them |

## Run it

```bash
cd console
npm install
npm run dev            # http://localhost:5173
```

Each node must allow the console's origin:

```bash
CELERIS_CORS_ORIGINS=http://localhost:5173 celeris start
```

The 3-node `docker compose` cluster already allows `http://localhost:5173`
and `http://localhost:4173` (`npm run preview`). Enter its nodes in the
sidebar: `http://127.0.0.1:8081`, `http://127.0.0.1:8082` and
`http://127.0.0.1:8083`.

Prefer `127.0.0.1` over `localhost`: on some systems `localhost` resolves to
IPv6 first and the connection stalls.

`npm run build` writes a static site to `dist/` that any web server can host.
The console talks to the nodes directly from the browser; it has no backend.
