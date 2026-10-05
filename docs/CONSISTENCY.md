# Consistency modes

Celeris does **not** break the CAP theorem. During a genuine network
partition, no system can guarantee both linearizable consistency and
unconditional availability. Celeris makes the trade-off **explicit and
per-operation** instead of hiding it behind one database-wide setting.

| Mode | During a partition | Guarantee | Coordination cost |
|---|---|---|---|
| `strict` | may reject or wait for quorum | linearizable per key | quorum round-trip |
| `session` | may route to a replica that has the session's writes, or wait | read-your-writes, monotonic reads | session token check |
| `bounded` | fails if no replica is fresh enough | staleness ≤ caller's bound | freshness metadata |
| `available` | accepts on any reachable replica | eventual, conflicts surfaced | none on write path |
| `eventual` | accepts and reconciles | eventual | none |

## Rules the implementation must follow

1. A `strict` operation is **never** silently downgraded. If quorum is
   unavailable it fails or times out with an error that says so.
2. A timeout never means success. If the outcome is unknown the API says
   "unknown" and the client resolves it with the mutation ID
   (`GET /v1/mutations/{id}`; storage: `Engine::mutation_status`).
3. Every response reports the mode that was actually applied, plus the
   version or epoch. Bounded reads also report staleness.
4. Concurrent `available` writes are never silently lost without a
   documented deterministic policy. They are kept as conflicts or merged
   by that policy, and the conflict count is a metric.

## Implementation status

| Layer | Status |
|---|---|
| `celeris_core::Consistency` enum, parsing, `requires_quorum`, `may_diverge` | done |
| Single-node storage: atomic batches, CAS, mutation-ID idempotency | done |
| HTTP API: per-request `consistency`, `max_staleness_ms`, applied mode reported in body + `celeris-consistency` header, per-mode metrics | done |
| Replicated STRICT (Raft groups, read barrier), SESSION (applied-index tokens), EVENTUAL/AVAILABLE local reads | done (D-018) |
| AVAILABLE/EVENTUAL writes accepted on any replica (202 when not yet replicated), deterministic last-writer-wins with every loser kept as a conflict (`/v1/conflicts`), Merkle-digest anti-entropy with repair | done (D-023) |

On a single node every mode behaves identically: one replica, so it is
trivially linearizable. The modes only diverge once replication exists.
