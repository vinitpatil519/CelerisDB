import { useState } from "react";

import type { Conflict } from "@celeris/client";

import { useConnection } from "../connection";
import { usePolling } from "../hooks";

export function Conflicts() {
  const { client } = useConnection();
  const [prefix, setPrefix] = useState("");
  const [applied, setApplied] = useState("");
  const polled = usePolling(() => client.conflicts({ prefix: applied || undefined, limit: 500 }), 5_000, [
    client,
    applied,
  ]);
  const conflicts: Conflict[] = polled.data?.conflicts ?? [];

  return (
    <section>
      <header className="page-head">
        <h1>Conflicts</h1>
        <p>
          Writes accepted under <code>available</code> consistency that lost last-writer-wins to a concurrent write.
          The winner is stored; the loser is kept here until you clear it.
        </p>
      </header>
      <form
        className="row card"
        onSubmit={(e) => {
          e.preventDefault();
          setApplied(prefix);
        }}
      >
        <input
          aria-label="Key prefix"
          className="mono grow"
          placeholder="prefix"
          value={prefix}
          onChange={(e) => setPrefix(e.target.value)}
        />
        <button type="submit">Filter</button>
      </form>
      {polled.error ? <p className="error">{polled.error}</p> : null}
      {polled.data?.partial ? <p className="warn-text">Partial: some replica sets did not answer.</p> : null}
      <div className="card">
        <table className="table">
          <thead>
            <tr>
              <th>key</th>
              <th>losing value</th>
              <th>lost at</th>
              <th>winner</th>
              <th />
            </tr>
          </thead>
          <tbody>
            {conflicts.map((c) => (
              <tr key={`${c.key}/${c.mutation_id}`}>
                <td className="mono">{c.key}</td>
                <td className="mono truncate">{c.value ?? "(delete)"}</td>
                <td>
                  {new Date(c.timestamp_ms).toLocaleString()}
                  {c.origin ? <span className="muted"> via {c.origin}</span> : null}
                </td>
                <td className="mono">
                  {c.winner_version !== null ? `v${c.winner_version}` : "pending"} ·{" "}
                  {new Date(c.winner_timestamp_ms).toLocaleTimeString()}
                </td>
                <td>
                  <button
                    type="button"
                    className="secondary small"
                    onClick={async () => {
                      await client.clearConflicts(c.key);
                      polled.refresh();
                    }}
                  >
                    Clear
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
        {conflicts.length === 0 && !polled.loading ? <p className="muted">No conflicts recorded.</p> : null}
      </div>
    </section>
  );
}
