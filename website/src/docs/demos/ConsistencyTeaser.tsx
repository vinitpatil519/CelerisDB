import { useState } from "react";

import { Demo } from "../kit";
import "./ConsistencyTeaser.css";

interface Mode {
  id: string;
  line: string;
  detail: string;
  /** 0-100 relative scores for the three meters. */
  agree: number;
  fresh: number;
  avail: number;
}

const MODES: Mode[] = [
  {
    id: "strict",
    line: "Linearizable per key.",
    detail: "A read sees the latest committed write. The cost is a quorum round-trip, and during a partition the operation may wait or fail instead of answering wrongly. It is the default.",
    agree: 100,
    fresh: 100,
    avail: 35,
  },
  {
    id: "session",
    line: "Read-your-writes within a session.",
    detail: "You always see your own writes and never go backwards, using a small token. Other clients may briefly lag.",
    agree: 75,
    fresh: 75,
    avail: 60,
  },
  {
    id: "bounded",
    line: "Stale, but never older than your bound.",
    detail: "You name a maximum staleness such as 500ms. If no replica is fresh enough, the read fails rather than lying.",
    agree: 60,
    fresh: 55,
    avail: 55,
  },
  {
    id: "available",
    line: "Accept on any reachable replica.",
    detail: "Writes succeed even when the leader is unreachable. Concurrent writes resolve deterministically and the losers are kept as inspectable conflicts.",
    agree: 30,
    fresh: 35,
    avail: 95,
  },
  {
    id: "eventual",
    line: "Accept anywhere, converge later.",
    detail: "The weakest and cheapest mode. Replicas reconcile in the background, so reads can be stale for a while.",
    agree: 20,
    fresh: 20,
    avail: 100,
  },
];

export function ConsistencyTeaser() {
  const [sel, setSel] = useState("strict");
  const m = MODES.find((x) => x.id === sel) ?? MODES[0]!;
  const meters: [string, number][] = [
    ["Agreement", m.agree],
    ["Freshness", m.fresh],
    ["Availability", m.avail],
  ];
  return (
    <Demo
      title="Five modes, chosen per request"
      note="Illustrative, not measured. The bars give a rough feel for the trade-off each mode makes during a network partition."
    >
      <div className="ct">
        <div className="ct-chips" role="group" aria-label="Consistency mode">
          {MODES.map((x) => (
            <button key={x.id} type="button" className="ct-chip" aria-pressed={x.id === sel} onClick={() => setSel(x.id)}>
              {x.id}
            </button>
          ))}
        </div>
        <div className="ct-panel" aria-live="polite">
          <h4>{m.id}</h4>
          <p>
            <strong>{m.line}</strong> {m.detail}
          </p>
          <div className="ct-meters">
            {meters.map(([label, v]) => (
              <div className="ct-row" key={label}>
                <span>{label}</span>
                <span className="ct-bar" role="img" aria-label={`${label} ${v} percent`}>
                  <span className="ct-fill" style={{ width: `${v}%`, display: "block" }} />
                </span>
              </div>
            ))}
          </div>
        </div>
      </div>
    </Demo>
  );
}
