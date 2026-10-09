import { useEffect, useState } from "react";

import { Button, Demo, prefersReducedMotion, useInView, useInterval } from "../kit";
import "./WriteJourney.css";

type NodeId = "c" | "f2" | "l" | "f1";
interface Msg {
  from: NodeId;
  to: NodeId;
  label: string;
  blocked?: boolean;
}
interface Step {
  caption: string;
  msgs?: Msg[];
  marks?: Partial<Record<NodeId, string>>;
  healed?: boolean;
  tone?: "ok" | "bad" | "warn";
}

const POS: Record<NodeId, { x: number; y: number; name: string; sub: string }> = {
  c: { x: 62, y: 150, name: "Client", sub: "app" },
  f2: { x: 218, y: 150, name: "Node 3", sub: "follower" },
  l: { x: 470, y: 62, name: "Node 1", sub: "leader" },
  f1: { x: 470, y: 238, name: "Node 2", sub: "follower" },
};

const STRICT_OK: Step[] = [
  {
    caption: "The client sends the write, tagged with a mutation ID, to any node. Here it happens to reach Node 3.",
    msgs: [{ from: "c", to: "f2", label: "write + id" }],
    marks: { f2: "received" },
  },
  {
    caption: "Node 3 is not the leader for this key's partition, so it forwards the request to the node that is.",
    msgs: [{ from: "f2", to: "l", label: "forward" }],
    marks: { l: "received" },
  },
  {
    caption: "The leader checks it has not already seen this mutation ID, then proposes the write to the replica set.",
    msgs: [
      { from: "l", to: "f1", label: "propose" },
      { from: "l", to: "f2", label: "propose" },
    ],
    marks: { l: "proposed" },
  },
  {
    caption: "Replicas make the entry durable and acknowledge. Two of three is a quorum, so the leader does not wait for a slow third.",
    msgs: [
      { from: "f1", to: "l", label: "ack" },
      { from: "f2", to: "l", label: "ack" },
    ],
    marks: { f1: "durable", f2: "durable" },
  },
  {
    caption: "Quorum reached: the write is committed and the leader applies it to its storage. From here it survives losing any single node.",
    marks: { l: "applied v41", f1: "applied v41", f2: "applied v41" },
    tone: "ok",
  },
  {
    caption: "The result travels back to the node that took the request...",
    msgs: [{ from: "l", to: "f2", label: "result" }],
  },
  {
    caption: "...and to the client: success, the new version, and the mode that was actually applied (strict).",
    msgs: [{ from: "f2", to: "c", label: "200 v41 strict" }],
    marks: { c: "acknowledged" },
    tone: "ok",
  },
];

const STRICT_CUT: Step[] = [
  {
    caption: "The client reaches Node 3, but Node 3 is cut off from the rest of the cluster by a network partition.",
    msgs: [{ from: "c", to: "f2", label: "write + id" }],
    marks: { f2: "received" },
  },
  {
    caption: "Node 3 tries to reach the leader and cannot. On its own it is a minority of one, and a minority cannot form a quorum.",
    msgs: [{ from: "f2", to: "l", label: "forward", blocked: true }],
    tone: "warn",
  },
  {
    caption: "A strict write is never silently downgraded, so Node 3 refuses and says why. Nothing was written anywhere. Retrying later with the same mutation ID is safe.",
    msgs: [{ from: "f2", to: "c", label: "503 no quorum" }],
    marks: { c: "told: not written" },
    tone: "bad",
  },
];

const AVAIL_OK: Step[] = [
  {
    caption: "The client sends an available-mode write to Node 3, which holds a replica of this key.",
    msgs: [{ from: "c", to: "f2", label: "write + id" }],
    marks: { f2: "received" },
  },
  {
    caption: "Node 3 accepts it immediately and makes it durable locally. No coordination, so no cross-node round trip on the write path.",
    marks: { f2: "accepted v41" },
    tone: "ok",
  },
  {
    caption: "The client gets an answer right away. It is marked as accepted, not yet replicated, and reports the mode that was applied.",
    msgs: [{ from: "f2", to: "c", label: "202 available" }],
    marks: { c: "acknowledged" },
    tone: "ok",
  },
  {
    caption: "In the background Node 3 shares the write with the other replicas.",
    msgs: [
      { from: "f2", to: "l", label: "replicate" },
      { from: "f2", to: "f1", label: "replicate" },
    ],
  },
  {
    caption: "All replicas now hold the write. The three copies agree.",
    marks: { l: "applied v41", f1: "applied v41", f2: "applied v41" },
    tone: "ok",
  },
];

const AVAIL_CUT: Step[] = [
  {
    caption: "The client reaches Node 3, which is partitioned away from the rest of the cluster.",
    msgs: [{ from: "c", to: "f2", label: "write + id" }],
    marks: { f2: "received" },
  },
  {
    caption: "Available mode does not need a quorum. Node 3 accepts the write locally and durably, marked pending.",
    marks: { f2: "pending" },
    tone: "warn",
  },
  {
    caption: "The client is told it was accepted, not yet replicated. The trade-off is explicit: a pending write is invisible to other nodes until reconciled, and lost if this node is lost first.",
    msgs: [{ from: "f2", to: "c", label: "202 pending" }],
    marks: { c: "accepted, pending" },
    tone: "warn",
  },
  {
    caption: "The partition heals. Node 3 shares its pending write with the replica set.",
    msgs: [{ from: "f2", to: "l", label: "reconcile" }],
    healed: true,
  },
  {
    caption: "If someone wrote the same key concurrently on the other side, a deterministic rule picks the winner and the loser is kept as a readable conflict, never silently dropped.",
    marks: { l: "ordered v41" },
    healed: true,
    tone: "ok",
  },
  {
    caption: "Replicas converge. The write is now fully replicated and the pending flag clears.",
    marks: { l: "applied v41", f1: "applied v41", f2: "applied v41" },
    healed: true,
    tone: "ok",
  },
];

function scenario(mode: "strict" | "available", cut: boolean): Step[] {
  if (mode === "strict") return cut ? STRICT_CUT : STRICT_OK;
  return cut ? AVAIL_CUT : AVAIL_OK;
}

function Node({ id, mark, hot, down }: { id: NodeId; mark?: string; hot: boolean; down?: boolean }) {
  const p = POS[id];
  const isClient = id === "c";
  return (
    <g className={`wj-node ${hot ? "hot" : ""} ${down ? "down" : ""}`}>
      <rect x={p.x - 52} y={p.y - 26} width={104} height={52} rx={isClient ? 26 : 10} className="wj-box" />
      <text x={p.x} y={p.y - 3} textAnchor="middle" className="wj-name">
        {p.name}
      </text>
      <text x={p.x} y={p.y + 13} textAnchor="middle" className="wj-sub">
        {p.sub}
      </text>
      {mark ? (
        <g className="wj-mark" key={mark}>
          <rect x={p.x - 50} y={p.y + 31} width={100} height={18} rx={9} />
          <text x={p.x} y={p.y + 44} textAnchor="middle">
            {mark}
          </text>
        </g>
      ) : null}
    </g>
  );
}

export default function WriteJourney() {
  const [mode, setMode] = useState<"strict" | "available">("strict");
  const [cut, setCut] = useState(false);
  const [idx, setIdx] = useState(-1);
  const [playing, setPlaying] = useState(false);
  const [reduced, setReduced] = useState(false);
  const [ref, seen] = useInView<HTMLDivElement>();

  useEffect(() => setReduced(prefersReducedMotion()), []);

  const steps = scenario(mode, cut);
  const last = steps.length - 1;

  useInterval(
    () => {
      setIdx((i) => {
        if (i >= last) {
          setPlaying(false);
          return i;
        }
        return i + 1;
      });
    },
    2600,
    playing && seen && !reduced,
  );

  const reset = (m = mode, c = cut) => {
    setMode(m);
    setCut(c);
    setIdx(-1);
    setPlaying(false);
  };
  const stepOnce = () => {
    setPlaying(false);
    setIdx((i) => Math.min(i + 1, last));
  };
  const play = () => {
    if (idx >= last) setIdx(-1);
    if (reduced) {
      setIdx(last);
      return;
    }
    setPlaying(true);
    setIdx((i) => (i >= last ? 0 : i + 1));
  };

  const marks: Partial<Record<NodeId, string>> = {};
  let healed = false;
  for (let i = 0; i <= idx && i <= last; i++) {
    const s = steps[i]!;
    Object.assign(marks, s.marks);
    if (s.healed) healed = true;
  }
  const current = idx >= 0 ? steps[idx]! : null;
  const hotNodes = new Set<NodeId>();
  current?.msgs?.forEach((m) => {
    hotNodes.add(m.from);
    hotNodes.add(m.to);
  });

  const lines: [NodeId, NodeId][] = [
    ["c", "f2"],
    ["f2", "l"],
    ["f2", "f1"],
    ["l", "f1"],
  ];

  return (
    <Demo
      title="A write's journey"
      note="Simulated in your browser. It shows the shape of the path, not exact timing or the internal messages."
      controls={
        <>
          <Button kind="primary" onClick={playing ? () => setPlaying(false) : play}>
            {playing ? "Pause" : idx >= last ? "Replay" : "Play"}
          </Button>
          <Button onClick={stepOnce} disabled={idx >= last}>
            Step
          </Button>
          <Button onClick={() => reset()}>Reset</Button>
        </>
      }
    >
      <div ref={ref} className="wj-root">
        <div className="wj-opts">
          <div className="wj-seg" role="group" aria-label="Consistency mode">
            <button type="button" aria-pressed={mode === "strict"} className={mode === "strict" ? "on" : ""} onClick={() => reset("strict", cut)}>
              strict
            </button>
            <button type="button" aria-pressed={mode === "available"} className={mode === "available" ? "on" : ""} onClick={() => reset("available", cut)}>
              available
            </button>
          </div>
          <label className="wj-check">
            <input type="checkbox" checked={cut} onChange={(e) => reset(mode, e.target.checked)} />
            <span>Network partition isolates Node 3</span>
          </label>
        </div>

        <svg className="wj-svg" viewBox="0 0 560 300" role="img" aria-label="Diagram of a client, three database nodes and the messages of a write">
          <rect x={372} y={14} width={178} height={272} rx={14} className="wj-set" />
          <text x={461} y={30} textAnchor="middle" className="wj-set-t">
            replica set for this key
          </text>

          {lines.map(([a, b]) => (
            <line key={a + b} x1={POS[a].x} y1={POS[a].y} x2={POS[b].x} y2={POS[b].y} className="wj-link" />
          ))}

          {cut && !healed ? (
            <g className="wj-cut">
              <line x1={316} y1={20} x2={316} y2={280} />
              <text x={316} y={296} textAnchor="middle">
                partition
              </text>
            </g>
          ) : null}

          {(["c", "f2", "l", "f1"] as NodeId[]).map((id) => (
            <Node key={id} id={id} mark={marks[id]} hot={hotNodes.has(id)} down={cut && !healed && id === "f2"} />
          ))}

          {current?.msgs?.map((m, i) => {
            const a = POS[m.from];
            const b = POS[m.to];
            const tx = m.blocked ? a.x + (b.x - a.x) * 0.5 : b.x;
            const ty = m.blocked ? a.y + (b.y - a.y) * 0.5 : b.y;
            const lx = (a.x + tx) / 2;
            const ly = (a.y + ty) / 2;
            return (
              <g key={`${idx}-${i}`} className={`wj-msg ${m.blocked ? "blocked" : ""} ${current.tone ?? ""}`}>
                <line x1={a.x} y1={a.y} x2={tx} y2={ty} className="wj-trail" />
                <circle r={6} className="wj-pkt" cx={reduced ? tx : a.x} cy={reduced ? ty : a.y}>
                  {reduced ? null : (
                    <animateMotion dur="1.1s" begin="0s" fill="freeze" path={`M0 0 L${tx - a.x} ${ty - a.y}`} />
                  )}
                </circle>
                {m.blocked ? (
                  <text x={tx} y={ty + 6} textAnchor="middle" className="wj-x">
                    X
                  </text>
                ) : null}
                <g className="wj-lbl" transform={`translate(${lx} ${ly - 10})`}>
                  <text textAnchor="middle">{m.label}</text>
                </g>
              </g>
            );
          })}
        </svg>

        <div className="wj-progress" aria-hidden="true">
          {steps.map((_, i) => (
            <span key={i} className={i <= idx ? "done" : ""} />
          ))}
        </div>
        <p className={`wj-caption ${current?.tone ?? ""}`} aria-live="polite">
          {current ? (
            <>
              <strong>
                Step {idx + 1} of {steps.length}.
              </strong>{" "}
              {current.caption}
            </>
          ) : (
            <>Press Play or Step. Try switching the mode, then add a partition and run it again to see how the path changes.</>
          )}
        </p>
      </div>
    </Demo>
  );
}
