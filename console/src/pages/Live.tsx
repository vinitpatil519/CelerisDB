import { useEffect, useRef, useState } from "react";

import type { ChangeEvent, Watcher } from "@celeris/client";

import { useConnection } from "../connection";

const KEEP = 200;

interface Row extends ChangeEvent {
  at: string;
  seq: number;
}

export function Live() {
  const { client } = useConnection();
  const [prefix, setPrefix] = useState("");
  const [watching, setWatching] = useState<string | null>(null);
  const [rows, setRows] = useState<Row[]>([]);
  const [hello, setHello] = useState<{ node: string; groups: string[]; partial: boolean } | null>(null);
  const [lagged, setLagged] = useState(0);
  const [state, setState] = useState<"idle" | "open" | "closed" | "error">("idle");
  const watcher = useRef<Watcher | null>(null);
  const seq = useRef(0);

  useEffect(() => {
    if (watching === null) return;
    setRows([]);
    setLagged(0);
    setHello(null);
    setState("idle");
    const w = client.watch(watching, {
      onHello: (h) => {
        setHello(h);
        setState("open");
      },
      onChange: (event) => {
        const row: Row = { ...event, at: new Date().toLocaleTimeString(), seq: seq.current++ };
        setRows((prev) => [row, ...prev].slice(0, KEEP));
      },
      onLagged: (missed) => setLagged((n) => n + missed),
      onClose: () => setState((s) => (s === "error" ? s : "closed")),
      onError: () => setState("error"),
    });
    watcher.current = w;
    return () => w.close();
  }, [client, watching]);

  return (
    <section>
      <header className="page-head">
        <h1>Live changes</h1>
        <p>
          Streams changes applied by the first node over a WebSocket. Delivery is best-effort and starts now; a node
          sees the replica sets it belongs to.
        </p>
      </header>
      <form
        className="row card"
        onSubmit={(e) => {
          e.preventDefault();
          setWatching(prefix);
        }}
      >
        <input
          aria-label="Key prefix to watch"
          className="mono grow"
          placeholder="prefix (empty = everything)"
          value={prefix}
          onChange={(e) => setPrefix(e.target.value)}
        />
        <button type="submit">{watching === null ? "Watch" : "Restart"}</button>
        {watching !== null ? (
          <button
            type="button"
            className="secondary"
            onClick={() => {
              watcher.current?.close();
              setWatching(null);
              setState("closed");
            }}
          >
            Stop
          </button>
        ) : null}
      </form>
      <div className="stats">
        <div className={`stat ${state === "open" ? "ok" : state === "error" ? "bad" : ""}`}>
          <div className="stat-value">{state}</div>
          <div className="stat-label">stream</div>
        </div>
        <div className="stat">
          <div className="stat-value mono">{hello?.node ?? "—"}</div>
          <div className="stat-label">node</div>
        </div>
        <div className={`stat ${hello?.partial ? "warn" : ""}`}>
          <div className="stat-value">{hello ? (hello.partial ? "partial" : "full") : "—"}</div>
          <div className="stat-label">coverage</div>
        </div>
        <div className={`stat ${lagged > 0 ? "warn" : ""}`}>
          <div className="stat-value">{lagged}</div>
          <div className="stat-label">events missed</div>
        </div>
      </div>
      <div className="card" aria-live="polite">
        <table className="table">
          <thead>
            <tr>
              <th>time</th>
              <th>kind</th>
              <th>key</th>
              <th>version</th>
              <th>value</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((r) => (
              <tr key={r.seq} className="flash">
                <td>{r.at}</td>
                <td>
                  <span className={`badge ${r.kind === "put" ? "accent" : "warn"}`}>{r.kind}</span>
                </td>
                <td className="mono">{r.key}</td>
                <td>{r.version}</td>
                <td className="mono truncate">{r.value === null ? "" : JSON.stringify(r.value)}</td>
              </tr>
            ))}
          </tbody>
        </table>
        {rows.length === 0 ? (
          <p className="muted">{watching === null ? "Not watching." : "Waiting for changes…"}</p>
        ) : null}
      </div>
    </section>
  );
}
