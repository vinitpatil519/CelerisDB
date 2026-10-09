import { useEffect, useRef, useState } from "react";

import { Button, Demo, prefersReducedMotion } from "../kit";
import "./ConsistencyLab.css";

/**
 * A small model of a three-node replica set (A is the leader) with one client
 * that can stand on either side of a network partition. The rules follow
 * docs/CONSISTENCY.md and D-018 / D-023; message timing and values are
 * illustrative.
 */

type Id = "A" | "B" | "C";
type Mode = "strict" | "session" | "bounded" | "available" | "eventual";
type Op = "read" | "write";
type Side = "left" | "right";
type Tone = "ok" | "bad" | "warn";

interface NodeState {
  v: number;
  val: string;
  ts: number;
}
interface Pending {
  val: string;
  ts: number;
}
interface Lab {
  part: boolean;
  nodes: Record<Id, NodeState>;
  pending: Pending[];
  token: number;
  clock: number;
  n: number;
}
interface Result {
  tone: Tone;
  title: string;
  detail: string;
  wire: string;
}
interface Hop {
  from: string;
  to: string;
  stage: number;
  kind: "req" | "rep" | "res" | "blocked";
  tone?: Tone;
}
interface Dot extends Hop {
  id: number;
  go: boolean;
}
interface Outcome {
  lab: Lab;
  hops: Hop[];
  result: Result;
}

const MODES: { id: Mode; hint: string }[] = [
  { id: "strict", hint: "linearizable, needs a quorum" },
  { id: "session", hint: "read-your-writes via a token" },
  { id: "bounded", hint: "fresh within a bound, leader read" },
  { id: "available", hint: "any reachable replica" },
  { id: "eventual", hint: "accept now, reconcile later" },
];

const P: Record<string, { x: number; y: number }> = {
  A: { x: 205, y: 55 },
  B: { x: 205, y: 225 },
  C: { x: 415, y: 140 },
  cl: { x: 48, y: 140 },
  cr: { x: 520, y: 140 },
};
const STAGE_MS = 520;

const fresh = (): Lab => ({
  part: false,
  nodes: {
    A: { v: 1, val: "initial", ts: 0 },
    B: { v: 1, val: "initial", ts: 0 },
    C: { v: 1, val: "initial", ts: 0 },
  },
  pending: [],
  token: 0,
  clock: 0,
  n: 1,
});

function reach(lab: Lab, side: Side): Id[] {
  if (!lab.part) return ["A", "B", "C"];
  return side === "left" ? ["A", "B"] : ["C"];
}

function plan(lab: Lab, mode: Mode, op: Op, side: Side): Outcome {
  const cl = side === "left" ? "cl" : "cr";
  const entry: Id = side === "left" ? "A" : "C";
  const r = reach(lab, side);
  const quorum = r.includes("A") && r.length >= 2;
  const leader = lab.nodes.A;
  const hops: Hop[] = [];
  let stage = 0;
  const go = (from: string, to: string, kind: Hop["kind"], tone?: Tone) => {
    hops.push({ from, to, stage, kind, tone });
  };

  const reject = (title: string, detail: string, wire: string): Outcome => {
    go(cl, entry, "req");
    stage++;
    if (entry !== "A") {
      go(entry, "A", "blocked");
      stage++;
    }
    go(entry, cl, "res", "bad");
    return { lab, hops, result: { tone: "bad", title, detail, wire } };
  };

  if (op === "write") {
    if (mode === "bounded") {
      return reject(
        "Rejected",
        "bounded describes how fresh a read must be, so the API refuses it on writes. Pick another mode for writes.",
        "400 invalid_argument, outcome: not_applied",
      );
    }
    const val = `value-${lab.n}`;
    if (quorum) {
      const v = leader.v + 1;
      const ts = lab.clock + 1;
      const nodes = { ...lab.nodes };
      for (const id of r) nodes[id] = { v, val, ts };
      go(cl, entry, "req");
      stage++;
      if (entry !== "A") {
        go(entry, "A", "req");
        stage++;
      }
      for (const id of r) if (id !== "A") go("A", id, "rep");
      stage++;
      if (entry !== "A") {
        go("A", entry, "res", "ok");
        stage++;
      }
      go(entry, cl, "res", "ok");
      const lagging = (["A", "B", "C"] as Id[]).filter((id) => !r.includes(id));
      return {
        lab: { ...lab, nodes, token: v, clock: ts, n: lab.n + 1 },
        hops,
        result: {
          tone: "ok",
          title: `Accepted: ${val} is v${v}`,
          detail:
            `The leader committed it with a quorum (${r.join(" + ")}), and the client now holds session token v${v}.` +
            (lagging.length ? ` ${lagging.join(", ")} cannot be reached and will catch up after the network heals.` : ""),
          wire: `200 · version ${v} · celeris-consistency: ${mode}`,
        },
      };
    }
    if (mode === "available" || mode === "eventual") {
      const ts = lab.clock + 1;
      go(cl, entry, "req");
      stage++;
      go(entry, "A", "blocked");
      go(entry, cl, "res", "warn");
      return {
        lab: { ...lab, pending: [...lab.pending, { val, ts }], clock: ts, n: lab.n + 1 },
        hops,
        result: {
          tone: "warn",
          title: `Accepted, not replicated yet: ${val}`,
          detail: `${entry} stored it in its local pending log and answered right away, even without a quorum. Nobody can read it, not even ${entry}, until it reconciles after the network heals.`,
          wire: `202 · accepted: true · replicated: false · celeris-consistency: ${mode}`,
        },
      };
    }
    return reject(
      "Rejected",
      `${entry} cannot reach the leader or a quorum from this side, so a ${mode} write cannot commit. Celeris refuses instead of weakening the mode, and nothing was applied.`,
      "unreachable or 503, outcome: not_applied",
    );
  }

  // reads
  if (mode === "strict" || mode === "bounded") {
    if (!quorum) {
      return reject(
        "Rejected",
        `A ${mode} read goes through the leader with a read barrier that needs a quorum. From this side neither is reachable, so the read fails rather than return something older.`,
        "unreachable or 503",
      );
    }
    go(cl, entry, "req");
    stage++;
    if (entry !== "A") {
      go(entry, "A", "req");
      stage++;
    }
    for (const id of r) if (id !== "A") go("A", id, "rep");
    stage++;
    if (entry !== "A") {
      go("A", entry, "res", "ok");
      stage++;
    }
    go(entry, cl, "res", "ok");
    return {
      lab,
      hops,
      result: {
        tone: "ok",
        title: `Accepted: ${leader.val} (v${leader.v})`,
        detail: `The leader confirmed it is still leader with a quorum before answering, so this is the latest committed value.${mode === "bounded" ? " The bound is met: this read has staleness_ms: 0." : ""}`,
        wire: `200 · version ${leader.v}${mode === "bounded" ? " · staleness_ms: 0" : ""} · celeris-consistency: ${mode}`,
      },
    };
  }
  if (mode === "session") {
    const n = lab.nodes[entry];
    go(cl, entry, "req");
    stage++;
    if (n.v >= lab.token) {
      go(entry, cl, "res", "ok");
      return {
        lab,
        hops,
        result: {
          tone: "ok",
          title: `Accepted: ${n.val} (v${n.v})`,
          detail: `${entry} has applied at least v${lab.token}, the version in your session token, so you see your own writes. It may still be older than what other clients wrote.`,
          wire: `200 · version ${n.v} · celeris-session-index sent · celeris-consistency: session`,
        },
      };
    }
    go(entry, cl, "res", "bad");
    return {
      lab,
      hops,
      result: {
        tone: "bad",
        title: "Rejected: replica is behind your session",
        detail: `${entry} has only applied v${n.v} but your token says v${lab.token}. It will not serve a read that could miss your own write. Retry elsewhere or after the network heals.`,
        wire: "503 session_behind",
      },
    };
  }
  // available / eventual reads: local state
  const n = lab.nodes[entry];
  const stale = n.v < leader.v;
  go(cl, entry, "req");
  stage++;
  go(entry, cl, "res", stale ? "warn" : "ok");
  const hidden = entry === "C" && lab.pending.length > 0;
  return {
    lab,
    hops,
    result: {
      tone: stale ? "warn" : "ok",
      title: stale ? `Stale read: ${n.val} (v${n.v})` : `Accepted: ${n.val} (v${n.v})`,
      detail:
        (stale
          ? `${entry} answered from its own state without asking anyone. The cluster is at v${leader.v}, but this side cannot see it. That is the deal with ${mode}: always an answer, possibly old.`
          : `${entry} answered from its own state, and it happens to be current.`) +
        (hidden ? ` Your ${lab.pending.length} pending write(s) are not visible here yet.` : ""),
      wire: `200 · version ${n.v} · celeris-consistency: ${mode}`,
    },
  };
}

function heal(lab: Lab): Outcome {
  const nodes = { ...lab.nodes };
  let clock = lab.clock;
  const notes: string[] = [];
  let warn = false;
  let token = lab.token;
  let a = { ...nodes.A };
  for (const w of lab.pending) {
    if (w.ts > a.ts) {
      a = { v: a.v + 1, val: w.val, ts: w.ts };
      token = Math.max(token, a.v);
      notes.push(`${w.val} won last-writer-wins and became v${a.v}`);
    } else {
      warn = true;
      notes.push(`${w.val} lost to a newer write and was kept as a conflict record`);
    }
  }
  nodes.A = a;
  nodes.B = a;
  nodes.C = a;
  clock = Math.max(clock, a.ts);
  const hops: Hop[] = [
    { from: "A", to: "C", stage: 0, kind: "rep" },
    { from: "C", to: "A", stage: 0, kind: "rep" },
  ];
  return {
    lab: { ...lab, part: false, nodes, pending: [], token, clock },
    hops,
    result: {
      tone: warn ? "warn" : "ok",
      title: "Network healed",
      detail: (notes.length ? notes.join("; ") + ". " : "") + "C replays the log and catches up, so all three nodes agree again.",
      wire: "replicas converge",
    },
  };
}

export default function ConsistencyLab() {
  const [lab, setLab] = useState<Lab>(fresh);
  const [mode, setMode] = useState<Mode>("strict");
  const [op, setOp] = useState<Op>("write");
  const [side, setSide] = useState<Side>("left");
  const [result, setResult] = useState<Result | null>(null);
  const [log, setLog] = useState<string[]>([]);
  const [dots, setDots] = useState<Dot[]>([]);
  const [busy, setBusy] = useState(false);
  const timers = useRef<ReturnType<typeof setTimeout>[]>([]);
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

  const animate = (hops: Hop[]) => {
    if (prefersReducedMotion() || hops.length === 0) return 0;
    const last = Math.max(...hops.map((h) => h.stage)) + 1;
    for (const h of hops) {
      later(() => {
        const id = ++ids.current;
        setDots((d) => [...d, { ...h, id, go: false }]);
        later(() => setDots((d) => d.map((x) => (x.id === id ? { ...x, go: true } : x))), 30);
        later(() => setDots((d) => d.filter((x) => x.id !== id)), STAGE_MS + 120);
      }, h.stage * STAGE_MS);
    }
    return last * STAGE_MS + 150;
  };

  const apply = (out: Outcome, label: string) => {
    const wait = animate(out.hops);
    setBusy(wait > 0);
    if (wait > 0) later(() => setBusy(false), wait);
    later(() => {
      setLab(out.lab);
      setResult(out.result);
      setLog((l) => [`${label}: ${out.result.title}`, ...l].slice(0, 6));
    }, Math.max(0, wait - 200));
  };

  const run = () => {
    apply(plan(lab, mode, op, side), `${op} ${mode} from ${side === "left" ? "A/B side" : "C side"}`);
  };
  const toggle = () => {
    if (lab.part) {
      apply(heal(lab), "heal");
    } else {
      setLab({ ...lab, part: true });
      setResult({
        tone: "warn",
        title: "Network partitioned",
        detail: "C can no longer talk to A and B. A and B still form a majority (2 of 3) and keep the leader. C is alone.",
        wire: "",
      });
      setLog((l) => ["partition: C isolated", ...l].slice(0, 6));
    }
  };
  const reset = () => {
    timers.current.forEach(clearTimeout);
    timers.current = [];
    setLab(fresh());
    setResult(null);
    setLog([]);
    setDots([]);
    setBusy(false);
  };

  const pt = (k: string) => P[k] ?? { x: 0, y: 0 };
  const clientPos = pt(side === "left" ? "cl" : "cr");

  const node = (id: Id) => {
    const n = lab.nodes[id];
    const p = pt(id);
    const cut = lab.part && id === "C";
    return (
      <g key={id} transform={`translate(${p.x - 62} ${p.y - 28})`} className={`cl-node ${id === "A" ? "lead" : ""} ${cut ? "cut" : ""}`}>
        <rect width="124" height="56" rx="10" />
        <text x="12" y="21" className="cl-nt">
          {id}
          <tspan className="cl-role">{id === "A" ? "  leader" : "  follower"}</tspan>
        </text>
        <text x="12" y="42" className="cl-nv">
          v{n.v} {n.val.length > 9 ? n.val.slice(0, 9) : n.val}
        </text>
        {id === "C" && lab.pending.length > 0 ? (
          <text x="62" y="75" textAnchor="middle" className="cl-pend">
            pending: {lab.pending.length}
          </text>
        ) : null}
      </g>
    );
  };

  const link = (a: string, b: string, cut: boolean) => (
    <line key={a + b} x1={pt(a).x} y1={pt(a).y} x2={pt(b).x} y2={pt(b).y} className={`cl-link ${cut ? "cut" : ""}`} />
  );

  return (
    <Demo
      title="Consistency lab"
      note="A simulation in your browser: three nodes, one client, no server. The outcomes follow the documented rules; timings and values are illustrative."
      controls={
        <Button onClick={reset} disabled={busy}>
          Reset
        </Button>
      }
    >
      <div className="cl-grid">
        <div className="cl-ctl">
          <fieldset className="cl-fs">
            <legend>1. Network</legend>
            <Button kind={lab.part ? "primary" : "danger"} onClick={toggle} disabled={busy}>
              {lab.part ? "Heal the partition" : "Cut the network: isolate C"}
            </Button>
          </fieldset>
          <fieldset className="cl-fs">
            <legend>2. Where is the client?</legend>
            <div className="cl-seg" role="group" aria-label="Client location">
              <Button pressed={side === "left"} onClick={() => setSide("left")} disabled={busy}>
                Near A and B
              </Button>
              <Button pressed={side === "right"} onClick={() => setSide("right")} disabled={busy}>
                Near C
              </Button>
            </div>
          </fieldset>
          <fieldset className="cl-fs">
            <legend>3. Consistency mode</legend>
            <div className="cl-modes" role="radiogroup" aria-label="Consistency mode">
              {MODES.map((m) => (
                <label key={m.id} className={mode === m.id ? "on" : ""}>
                  <input type="radio" name="cl-mode" checked={mode === m.id} onChange={() => setMode(m.id)} disabled={busy} />
                  <span>
                    <code>{m.id}</code>
                    <small>{m.hint}</small>
                  </span>
                </label>
              ))}
            </div>
          </fieldset>
          <fieldset className="cl-fs">
            <legend>4. Operation</legend>
            <div className="cl-seg" role="group" aria-label="Operation">
              <Button pressed={op === "write"} onClick={() => setOp("write")} disabled={busy}>
                Write
              </Button>
              <Button pressed={op === "read"} onClick={() => setOp("read")} disabled={busy}>
                Read
              </Button>
            </div>
            <div className="cl-run">
              <Button kind="primary" onClick={run} disabled={busy}>
                Send {op} ({mode})
              </Button>
            </div>
          </fieldset>
        </div>

        <div className="cl-stage">
          <svg
            viewBox="0 0 570 290"
            className="cl-svg"
            role="img"
            aria-label="Three nodes A, B and C and a client, with an optional network partition between C and the others"
          >
            {link("A", "B", false)}
            {link("A", "C", lab.part)}
            {link("B", "C", lab.part)}
            {lab.part ? (
              <g>
                <line x1="312" y1="8" x2="312" y2="282" className="cl-cut" />
                <text x="318" y="20" className="cl-cut-t">
                  partition
                </text>
              </g>
            ) : null}
            <line
              x1={clientPos.x}
              y1={clientPos.y}
              x2={side === "left" ? pt("A").x : pt("C").x}
              y2={side === "left" ? pt("A").y : pt("C").y}
              className="cl-link client"
            />
            {side === "left" ? (
              <line x1={clientPos.x} y1={clientPos.y} x2={pt("B").x} y2={pt("B").y} className="cl-link client" />
            ) : null}
            {(["A", "B", "C"] as Id[]).map(node)}
            <g className="cl-client" style={{ transform: `translate(${clientPos.x - 34}px, ${clientPos.y - 24}px)` }}>
              <rect width="68" height="48" rx="10" />
              <text x="34" y="20" textAnchor="middle" className="cl-nt">
                client
              </text>
              <text x="34" y="37" textAnchor="middle" className="cl-nv">
                token v{lab.token}
              </text>
            </g>
            {dots.map((d) => {
              const a = pt(d.from);
              const b = pt(d.to);
              const f = d.kind === "blocked" ? 0.5 : 1;
              const x = d.go ? a.x + (b.x - a.x) * f : a.x;
              const y = d.go ? a.y + (b.y - a.y) * f : a.y;
              return (
                <g
                  key={d.id}
                  className={`cl-dot ${d.kind} ${d.tone ?? ""} ${d.go && d.kind === "blocked" ? "fade" : ""}`}
                  style={{ transform: `translate(${x}px, ${y}px)` }}
                >
                  <circle r="6" />
                </g>
              );
            })}
          </svg>

          <div className={`cl-result ${result ? result.tone : "idle"}`} aria-live="polite">
            {result ? (
              <>
                <strong>{result.title}</strong>
                <p>{result.detail}</p>
                {result.wire ? <code>{result.wire}</code> : null}
              </>
            ) : (
              <p>Pick a mode and an operation, then send it. Then cut the network and try again from each side.</p>
            )}
          </div>
          {log.length ? (
            <ol className="cl-log" aria-label="History">
              {log.map((l, i) => (
                <li key={i + l}>{l}</li>
              ))}
            </ol>
          ) : null}
        </div>
      </div>
      <p className="cl-cap">
        Try this: cut the network, write with <code>strict</code> near A, move the client near C, then read with <code>session</code>,{" "}
        <code>strict</code> and <code>eventual</code> and compare.
      </p>
    </Demo>
  );
}
