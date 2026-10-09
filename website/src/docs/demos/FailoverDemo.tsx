import { useEffect, useState } from "react";

import { Button, Demo, prefersReducedMotion, useInView, useInterval } from "../kit";
import "./FailoverDemo.css";

interface NodeState {
  up: boolean;
  cut: boolean;
}
interface Sim {
  nodes: NodeState[];
  leader: number | null;
  term: number;
  election: number;
  attach: number;
  strictOk: number;
  strictFail: number;
  availOk: number;
  availPending: number;
  availFail: number;
  lastStrict: "ok" | "fail" | null;
  lastAvail: "ok" | "pending" | "fail" | null;
  tick: number;
  log: string[];
}

const ELECTION_TICKS = 3;
const POS = [
  { x: 372, y: 62 },
  { x: 372, y: 238 },
  { x: 232, y: 150 },
];
const CLIENT = { x: 62, y: 150 };

const INIT: Sim = {
  nodes: [
    { up: true, cut: false },
    { up: true, cut: false },
    { up: true, cut: false },
  ],
  leader: 0,
  term: 1,
  election: 0,
  attach: 2,
  strictOk: 0,
  strictFail: 0,
  availOk: 0,
  availPending: 0,
  availFail: 0,
  lastStrict: null,
  lastAvail: null,
  tick: 0,
  log: ["Cluster healthy. Node 1 is the leader (term 1)."],
};

const usable = (n: NodeState) => n.up && !n.cut;
const label = (i: number) => `Node ${i + 1}`;
const pushLog = (s: Sim, line: string): string[] => [line, ...s.log].slice(0, 6);

/** The set of nodes node `i` can talk to (including itself). */
function group(s: Sim, i: number): number[] {
  if (!s.nodes[i]!.up) return [];
  if (s.nodes[i]!.cut) return [i];
  return s.nodes.map((n, j) => (usable(n) ? j : -1)).filter((j) => j >= 0);
}

function servesStrict(s: Sim, i: number): boolean {
  const g = group(s, i);
  return g.length >= 2 && s.leader !== null && g.includes(s.leader);
}

function advance(s: Sim): Sim {
  const n: Sim = { ...s, tick: s.tick + 1 };
  if (n.leader === null) {
    if (n.election > 0) n.election -= 1;
    if (n.election === 0) {
      const alive = n.nodes.map((x, i) => (usable(x) ? i : -1)).filter((i) => i >= 0);
      if (alive.length >= 2) {
        const w = alive[0]!;
        n.leader = w;
        n.term += 1;
        n.log = pushLog(n, `${label(w)} won the election and leads term ${n.term}. Writes can resume.`);
      } else {
        n.election = ELECTION_TICKS;
      }
    }
  }
  const a = n.attach;
  if (!n.nodes[a]!.up) {
    n.strictFail += 1;
    n.availFail += 1;
    n.lastStrict = "fail";
    n.lastAvail = "fail";
  } else {
    if (servesStrict(n, a)) {
      n.strictOk += 1;
      n.lastStrict = "ok";
    } else {
      n.strictFail += 1;
      n.lastStrict = "fail";
    }
    n.availOk += 1;
    if (n.nodes[a]!.cut) {
      n.availPending += 1;
      n.lastAvail = "pending";
    } else {
      n.lastAvail = "ok";
    }
  }
  return n;
}

export default function FailoverDemo() {
  const [s, setS] = useState<Sim>(INIT);
  const [running, setRunning] = useState(false);
  const [reduced, setReduced] = useState(false);
  const [ref, seen] = useInView<HTMLDivElement>();

  useEffect(() => setReduced(prefersReducedMotion()), []);
  useInterval(() => setS(advance), 800, running && seen);

  const killLeader = () =>
    setS((p) => {
      if (p.leader === null) return p;
      const nodes = p.nodes.map((x, i) => (i === p.leader ? { ...x, up: false } : x));
      return {
        ...p,
        nodes,
        leader: null,
        election: ELECTION_TICKS,
        log: pushLog(p, `${label(p.leader)} crashed. Followers notice the missing heartbeat and start an election.`),
      };
    });

  const isolate = () =>
    setS((p) => {
      if (p.nodes[p.attach]!.cut || !p.nodes[p.attach]!.up) return p;
      const nodes = p.nodes.map((x, i) => (i === p.attach ? { ...x, cut: true } : x));
      const wasLeader = p.leader === p.attach;
      return {
        ...p,
        nodes,
        leader: wasLeader ? null : p.leader,
        election: wasLeader ? ELECTION_TICKS : p.election,
        log: pushLog(p, `${label(p.attach)} is cut off from the others, so it is a minority of one.`),
      };
    });

  const heal = () =>
    setS((p) => {
      const nodes = p.nodes.map(() => ({ up: true, cut: false }));
      const pending = p.availPending;
      return {
        ...p,
        nodes,
        availPending: 0,
        election: p.leader === null ? ELECTION_TICKS : p.election,
        log: pushLog(
          p,
          pending > 0
            ? `Everything restored. ${pending} pending available-mode writes reconciled with the rest.`
            : "Everything restored. Nodes rejoin as followers and catch up.",
        ),
      };
    });

  const setAttach = (i: number) => setS((p) => ({ ...p, attach: i, lastStrict: null, lastAvail: null }));
  const reset = () => {
    setRunning(false);
    setS(INIT);
  };

  const a = s.attach;
  const aNode = s.nodes[a]!;
  const dx = POS[a]!.x - CLIENT.x;
  const dy = POS[a]!.y - CLIENT.y;
  const degraded = s.leader === null || s.nodes.some((n) => !n.up || n.cut);

  return (
    <Demo
      title="When things break"
      note="Simulated in your browser. A three-node replica set with a client writing about once a second in both strict and available mode."
      controls={
        <>
          <Button kind="primary" onClick={() => setRunning((r) => !r)}>
            {running ? "Pause writes" : "Start writing"}
          </Button>
          <Button onClick={reset}>Reset</Button>
        </>
      }
    >
      <div ref={ref} className="fd-root">
        <div className="fd-bar">
          <span className="fd-lab">Client is connected to</span>
          <div className="fd-seg" role="group" aria-label="Which node the client talks to">
            {[0, 1, 2].map((i) => (
              <button key={i} type="button" className={a === i ? "on" : ""} aria-pressed={a === i} onClick={() => setAttach(i)}>
                {label(i)}
              </button>
            ))}
          </div>
        </div>

        <svg className="fd-svg" viewBox="0 0 520 300" role="img" aria-label="Three database nodes in a triangle with a client connected to one of them">
          {[
            [0, 1],
            [0, 2],
            [1, 2],
          ].map(([i, j]) => {
            const broken = !usable(s.nodes[i!]!) || !usable(s.nodes[j!]!);
            return (
              <line
                key={`${i}${j}`}
                x1={POS[i!]!.x}
                y1={POS[i!]!.y}
                x2={POS[j!]!.x}
                y2={POS[j!]!.y}
                className={`fd-link ${broken ? "broken" : ""}`}
              />
            );
          })}
          <line x1={CLIENT.x} y1={CLIENT.y} x2={POS[a]!.x} y2={POS[a]!.y} className="fd-link client" />

          {s.nodes.map((n, i) => {
            const p = POS[i]!;
            const isLeader = s.leader === i && n.up;
            const strict = servesStrict(s, i);
            const cls = !n.up ? "down" : n.cut ? "cut" : isLeader ? "leader" : s.leader === null ? "cand" : "";
            const role = !n.up ? "down" : n.cut ? "isolated" : isLeader ? "leader" : s.leader === null ? "candidate" : "follower";
            return (
              <g key={i} className={`fd-node ${cls}`}>
                <rect x={p.x - 56} y={p.y - 30} width={112} height={60} rx={12} className="fd-box" />
                <text x={p.x} y={p.y - 8} textAnchor="middle" className="fd-name">
                  {label(i)}
                </text>
                <text x={p.x} y={p.y + 8} textAnchor="middle" className="fd-role">
                  {role}
                </text>
                <text x={p.x} y={p.y + 22} textAnchor="middle" className="fd-cap">
                  {!n.up ? "refuses everything" : strict ? "strict ok, available ok" : "strict no, available ok"}
                </text>
              </g>
            );
          })}

          <g className="fd-client">
            <rect x={CLIENT.x - 38} y={CLIENT.y - 22} width={76} height={44} rx={22} />
            <text x={CLIENT.x} y={CLIENT.y + 4} textAnchor="middle">
              Client
            </text>
          </g>

          {s.tick > 0 && aNode.up && !reduced ? (
            <>
              <circle key={`s${s.tick}`} r={5} className={`fd-pkt ${s.lastStrict ?? ""}`} cx={CLIENT.x} cy={CLIENT.y - 5}>
                <animateMotion dur="0.55s" fill="freeze" path={`M0 0 L${dx} ${dy}`} />
              </circle>
              <circle key={`a${s.tick}`} r={4} className={`fd-pkt av ${s.lastAvail ?? ""}`} cx={CLIENT.x} cy={CLIENT.y + 5}>
                <animateMotion dur="0.55s" begin="0.1s" fill="freeze" path={`M0 0 L${dx} ${dy}`} />
              </circle>
            </>
          ) : null}

          {s.leader === null ? (
            <text x={300} y={290} textAnchor="middle" className="fd-elect">
              {s.nodes.filter(usable).length >= 2
                ? `No leader: election in ${Math.max(s.election, 1)}...`
                : "No leader: no majority reachable, cannot elect"}
            </text>
          ) : null}
        </svg>

        <div className="fd-stats">
          <div className="fd-stat">
            <span>Strict writes</span>
            <strong className="ok">{s.strictOk}</strong> acked
            <strong className={s.strictFail ? "bad" : ""}>{s.strictFail}</strong> refused
          </div>
          <div className="fd-stat">
            <span>Available writes</span>
            <strong className="ok">{s.availOk}</strong> accepted
            <strong className={s.availPending ? "warn" : ""}>{s.availPending}</strong> pending
          </div>
          <div className="fd-stat">
            <span>Acknowledged strict writes lost</span>
            <strong className="ok">0</strong>
          </div>
        </div>

        <div className="fd-actions">
          <Button kind="danger" onClick={killLeader} disabled={s.leader === null}>
            Kill the leader
          </Button>
          <Button kind="danger" onClick={isolate} disabled={aNode.cut || !aNode.up}>
            Partition {label(a)}
          </Button>
          <Button onClick={heal} disabled={!degraded}>
            Heal everything
          </Button>
        </div>

        <ul className="fd-log" aria-live="polite">
          {s.log.map((l, i) => (
            <li key={`${s.log.length}-${i}`} className={i === 0 ? "new" : ""}>
              {l}
            </li>
          ))}
        </ul>
        <p className="fd-note">
          Why nothing acknowledged is lost: a strict write is acked only after a majority stores it, and any new leader must be elected by a majority, so at
          least one voter in every election already holds that write.
        </p>
      </div>
    </Demo>
  );
}
