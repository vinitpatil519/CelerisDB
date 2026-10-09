import { useEffect, useRef, useState } from "react";

import { Button, Demo, prefersReducedMotion } from "../kit";
import "./ConflictLab.css";

/**
 * Models D-023: a write accepted without a quorum is stamped with a hybrid
 * timestamp and held pending. After the network heals, each pending write is
 * offered to the leader, where the newest (timestamp, mutation id) wins and
 * the loser is kept as a conflict record. Timings, ids and values are
 * illustrative.
 */

const KEY = "profile/ada";
const T0 = 1760000000000;

interface Rec {
  value: string;
  ts: number;
  mid: string;
  version: number;
}
interface Pending {
  value: string;
  ts: number;
  mid: string;
  seen: number;
}
interface ConflictRec {
  key: string;
  value: string;
  timestamp_ms: number;
  mutation_id: string;
  origin: string | null;
  winner_version: number;
  winner_timestamp_ms: number;
  winner_mutation_id: string;
}
interface Lab {
  part: boolean;
  cur: Rec;
  cLocal: Rec;
  pending: Pending[];
  t: number;
  conflicts: ConflictRec[];
}
interface Dot {
  id: number;
  verdict: "win" | "lose" | "";
  go: boolean;
}

const mid = (n: number) => `5d0c0000-0000-4000-8000-${(n * 977).toString(16).padStart(12, "0")}`;

const fresh = (): Lab => {
  const r: Rec = { value: '{"theme":"light"}', ts: T0, mid: mid(1), version: 1 };
  return { part: false, cur: r, cLocal: r, pending: [], t: 0, conflicts: [] };
};

const rel = (ts: number) => `t+${((ts - T0) / 1000).toFixed(1)}s`;
const short = (s: string) => (s.length > 19 ? s.slice(0, 18) + "…" : s);

function reconcile(start: Rec, pend: Pending[]) {
  let cur = start;
  const conflicts: ConflictRec[] = [];
  const verdicts: ("win" | "lose")[] = [];
  const notes: string[] = [];
  for (const p of pend) {
    const newer = p.ts > cur.ts || (p.ts === cur.ts && p.mid > cur.mid);
    if (newer) {
      const next: Rec = { value: p.value, ts: p.ts, mid: p.mid, version: cur.version + 1 };
      if (cur.version > p.seen) {
        conflicts.push({
          key: KEY,
          value: cur.value,
          timestamp_ms: cur.ts,
          mutation_id: cur.mid,
          origin: null,
          winner_version: next.version,
          winner_timestamp_ms: next.ts,
          winner_mutation_id: next.mid,
        });
        notes.push(`${p.value} (${rel(p.ts)}) is newer than the committed ${cur.value} (${rel(cur.ts)}) and wins; the value it overwrote is kept as a conflict.`);
      } else {
        notes.push(`${p.value} (${rel(p.ts)}) wins and overwrites a version its author had already seen: no conflict.`);
      }
      cur = next;
      verdicts.push("win");
    } else {
      conflicts.push({
        key: KEY,
        value: p.value,
        timestamp_ms: p.ts,
        mutation_id: p.mid,
        origin: "C",
        winner_version: cur.version,
        winner_timestamp_ms: cur.ts,
        winner_mutation_id: cur.mid,
      });
      notes.push(`${p.value} (${rel(p.ts)}) is older than the committed ${cur.value} (${rel(cur.ts)}) and loses; it is kept as a conflict.`);
      verdicts.push("lose");
    }
  }
  return { cur, conflicts, verdicts, notes };
}

export default function ConflictLab() {
  const [lab, setLab] = useState<Lab>(fresh);
  const [aVal, setAVal] = useState('{"theme":"dark"}');
  const [cVal, setCVal] = useState('{"theme":"sepia"}');
  const [skew, setSkew] = useState(0);
  const [log, setLog] = useState<string[]>([]);
  const [err, setErr] = useState("");
  const [dots, setDots] = useState<Dot[]>([]);
  const [flash, setFlash] = useState(false);
  const [busy, setBusy] = useState(false);
  const [explain, setExplain] = useState<string[]>([]);
  const timers = useRef<ReturnType<typeof setTimeout>[]>([]);
  const labRef = useRef(lab);
  labRef.current = lab;
  const skewRef = useRef(skew);
  skewRef.current = skew;
  const mids = useRef(2);
  const ids = useRef(0);

  useEffect(
    () => () => {
      timers.current.forEach(clearTimeout);
    },
    [],
  );
  const later = (fn: () => void, ms: number) => {
    timers.current.push(setTimeout(fn, ms));
  };
  const note = (s: string) => setLog((l) => [s, ...l].slice(0, 8));

  const valid = (v: string) => {
    try {
      JSON.parse(v);
      return true;
    } catch {
      setErr("The value must be valid JSON.");
      return false;
    }
  };

  const partition = () => {
    setLab((l) => ({ ...l, part: true }));
    note("The network splits. A and B keep a majority and the leader. C is alone.");
  };

  const writeA = (value = aVal) => {
    if (!valid(value)) return;
    setErr("");
    const l = labRef.current;
    const t = l.t + 1000;
    const rec: Rec = { value, ts: T0 + t, mid: mid(mids.current++), version: l.cur.version + 1 };
    setLab({ ...l, t, cur: rec, cLocal: l.part ? l.cLocal : rec });
    note(`Write on the A/B side (available): 200, committed as v${rec.version} at ${rel(rec.ts)}.`);
  };

  const writeC = (value = cVal) => {
    if (!valid(value)) return;
    setErr("");
    const l = labRef.current;
    const t = l.t + 1000;
    if (!l.part) {
      const rec: Rec = { value, ts: T0 + t, mid: mid(mids.current++), version: l.cur.version + 1 };
      setLab({ ...l, t, cur: rec, cLocal: rec });
      note(`Write via C (available): C reached the leader, so it committed normally as v${rec.version}. No partition, no conflict.`);
      return;
    }
    const lastP = l.pending.length ? l.pending[l.pending.length - 1]!.ts : 0;
    const ts = Math.max(T0 + t + skewRef.current, l.cLocal.ts + 1, lastP + 1);
    const p: Pending = { value, ts, mid: mid(mids.current++), seen: l.cLocal.version };
    setLab({ ...l, t, pending: [...l.pending, p] });
    note(`Write on C (available): 202 accepted, replicated: false, stamped ${rel(ts)}. Held in C's pending log.`);
  };

  const healNow = () => {
    const l = labRef.current;
    const res = reconcile(l.cur, l.pending);
    note(`The network heals. C offers ${l.pending.length} pending write(s) to the leader.`);
    const ds: Dot[] = res.verdicts.map((v) => ({ id: ++ids.current, verdict: v, go: false }));
    const reduced = prefersReducedMotion();
    const finish = () => {
      setDots([]);
      setFlash(true);
      later(() => setFlash(false), 700);
      setLab((cur) => ({
        ...cur,
        part: false,
        cur: res.cur,
        cLocal: res.cur,
        pending: [],
        conflicts: [...cur.conflicts, ...res.conflicts],
      }));
      setExplain(res.notes);
      note(
        res.conflicts.length
          ? `Reconciled: v${res.cur.version} is now ${res.cur.value} everywhere. ${res.conflicts.length} conflict record(s) kept.`
          : `Reconciled: v${res.cur.version} is now ${res.cur.value} everywhere. No conflicts.`,
      );
      setBusy(false);
    };
    if (reduced || ds.length === 0) {
      finish();
      return;
    }
    setBusy(true);
    ds.forEach((d, i) => {
      later(() => setDots((x) => [...x, d]), i * 350);
      later(() => setDots((x) => x.map((y) => (y.id === d.id ? { ...y, go: true } : y))), i * 350 + 40);
    });
    later(finish, ds.length * 350 + 800);
  };

  const story = () => {
    timers.current.forEach(clearTimeout);
    timers.current = [];
    setLab(fresh());
    setLog([]);
    setExplain([]);
    setDots([]);
    setErr("");
    mids.current = 2;
    setBusy(true);
    later(partition, 300);
    later(() => writeC('{"theme":"sepia"}'), 1500);
    later(() => writeA('{"theme":"dark"}'), 2700);
    later(healNow, 4000);
  };

  const reset = () => {
    timers.current.forEach(clearTimeout);
    timers.current = [];
    setLab(fresh());
    setLog([]);
    setExplain([]);
    setDots([]);
    setErr("");
    setFlash(false);
    setBusy(false);
    mids.current = 2;
  };

  const pos = { A: [200, 50], B: [200, 200], C: [420, 125] } as const;
  const nodeBox = (id: "A" | "B" | "C", r: Rec) => {
    const [x, y] = pos[id];
    const cut = lab.part && id === "C";
    return (
      <g key={id} transform={`translate(${x - 70} ${y - 30})`} className={`cf-node ${id === "A" ? "lead" : ""} ${cut ? "cut" : ""} ${flash && id === "A" ? "flash" : ""}`}>
        <rect width="140" height="60" rx="10" />
        <text x="12" y="21" className="cf-t">
          {id}
          <tspan className="cf-s">{id === "A" ? "  leader" : "  follower"}</tspan>
        </text>
        <text x="12" y="38" className="cf-s">
          v{r.version} {rel(r.ts)}
        </text>
        <text x="12" y="53" className="cf-s">
          {short(r.value)}
        </text>
        {id === "C" && lab.pending.length ? (
          <text x="70" y="78" textAnchor="middle" className="cf-s" style={{ fill: "var(--d-warn)" }}>
            pending: {lab.pending.length}
          </text>
        ) : null}
      </g>
    );
  };
  const last = lab.conflicts[lab.conflicts.length - 1];

  return (
    <Demo
      title="Conflict lab"
      note="A simulation in your browser. The reconciliation rule (newest timestamp, then mutation id, wins; the loser is kept) is the documented one; times and ids are made up."
      controls={
        <>
          <Button kind="primary" onClick={story} disabled={busy}>
            Play the whole story
          </Button>
          <Button onClick={reset}>Reset</Button>
        </>
      }
    >
      <div className="cf-grid">
        <div className="cf-ctl">
          <fieldset className="cf-fs">
            <legend>1. Partition</legend>
            <div className="cf-btns">
              <Button kind="danger" onClick={partition} disabled={lab.part || busy}>
                Isolate C
              </Button>
            </div>
          </fieldset>
          <fieldset className="cf-fs">
            <legend>2. Both sides write {KEY}</legend>
            <label className="cf-f">
              A/B side value
              <input type="text" value={aVal} onChange={(e) => setAVal(e.target.value)} spellCheck={false} />
            </label>
            <div className="cf-btns">
              <Button onClick={() => writeA()} disabled={busy}>
                Write on A/B side
              </Button>
            </div>
            <label className="cf-f" style={{ marginTop: 10 }}>
              C side value
              <input type="text" value={cVal} onChange={(e) => setCVal(e.target.value)} spellCheck={false} />
            </label>
            <div className="cf-btns">
              <Button onClick={() => writeC()} disabled={busy}>
                Write on C
              </Button>
            </div>
            <label className="cf-f" style={{ marginTop: 10 }}>
              Clock of C vs the others: {skew >= 0 ? "+" : ""}
              {skew / 1000}s
              <input type="range" min={-4000} max={4000} step={500} value={skew} onChange={(e) => setSkew(Number(e.target.value))} aria-label="Clock skew of node C in milliseconds" />
            </label>
            {err ? (
              <p className="cf-err" role="alert">
                {err}
              </p>
            ) : null}
          </fieldset>
          <fieldset className="cf-fs">
            <legend>3. Heal</legend>
            <div className="cf-btns">
              <Button kind="primary" onClick={healNow} disabled={!lab.part || busy}>
                Heal and reconcile
              </Button>
            </div>
          </fieldset>
        </div>

        <div className="cf-stage">
          <svg viewBox="0 0 560 250" className="cf-svg" role="img" aria-label="Nodes A, B and C holding the same key; C is cut off during the partition and later offers its pending writes to the leader">
            <line x1={pos.A[0]} y1={pos.A[1]} x2={pos.B[0]} y2={pos.B[1]} className="cf-link" />
            <line x1={pos.A[0]} y1={pos.A[1]} x2={pos.C[0]} y2={pos.C[1]} className={`cf-link ${lab.part ? "cut" : ""}`} />
            <line x1={pos.B[0]} y1={pos.B[1]} x2={pos.C[0]} y2={pos.C[1]} className={`cf-link ${lab.part ? "cut" : ""}`} />
            {lab.part ? (
              <g>
                <line x1="312" y1="8" x2="312" y2="242" className="cf-cut" />
                <text x="318" y="20" className="cf-cut-t">
                  partition
                </text>
              </g>
            ) : null}
            {nodeBox("A", lab.cur)}
            {nodeBox("B", lab.cur)}
            {nodeBox("C", lab.cLocal)}
            {dots.map((d) => (
              <g
                key={d.id}
                className={`cf-dot ${d.go ? d.verdict : ""}`}
                style={{ transform: `translate(${d.go ? pos.A[0] : pos.C[0]}px, ${d.go ? pos.A[1] : pos.C[1]}px)` }}
              >
                <circle r="7" />
              </g>
            ))}
          </svg>

          <div className="cf-reads">
            <div className="cf-read">
              <b>Read on A or B (strict)</b>
              <code>{lab.cur.value}</code>
            </div>
            <div className="cf-read">
              <b>Read on C (eventual)</b>
              <code>{lab.cLocal.value}</code>
              {lab.pending.length ? <div>{lab.pending.length} pending write(s) are not visible, not even here.</div> : null}
            </div>
          </div>

          {last ? (
            <div className="cf-rec">
              <h4>GET /v1/conflicts shows ({lab.conflicts.length})</h4>
              <pre>{JSON.stringify(last, null, 2)}</pre>
              {explain.map((e, i) => (
                <p key={i}>{e}</p>
              ))}
              <p>
                The losing value is not gone: it is the <code>value</code> field above, as JSON text. Resolve it in your application, then clear it with{" "}
                <code>DELETE /v1/conflicts/{KEY}</code> or <code>celeris conflicts clear {KEY}</code>.
              </p>
              <div className="cf-btns">
                <Button onClick={() => setLab((l) => ({ ...l, conflicts: [] }))}>Clear conflicts for this key</Button>
              </div>
            </div>
          ) : null}

          {log.length ? (
            <ol className="cf-log" aria-label="Event log" aria-live="polite">
              {log.map((l, i) => (
                <li key={i + l}>{l}</li>
              ))}
            </ol>
          ) : (
            <p className="cf-log">Press Play, or isolate C, write on both sides and heal. Change the clock slider to see a skewed clock decide a winner.</p>
          )}
        </div>
      </div>
    </Demo>
  );
}
