import { useMemo, useState } from "react";

import { Button, Demo } from "../kit";
import "./PartitionRing.css";

/**
 * Illustrative only: 64 partitions instead of the real number, a small
 * FNV-style hash instead of the real one. The placement idea (rendezvous
 * scoring, one replica per zone, first replica leads) is the real concept.
 */
const NP = 64;
const RF = 3;
const COLS = 8;
const CELL = 38;
const GAP = 3;
const POOL = Array.from({ length: 9 }, (_, i) => ({ id: `n${i + 1}`, zone: "abc"[i % 3]! }));
const ZONE_NAME: Record<string, string> = { a: "zone a", b: "zone b", c: "zone c" };

function h32(s: string): number {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  h ^= h >>> 16;
  h = Math.imul(h, 2246822507);
  h ^= h >>> 13;
  h = Math.imul(h, 3266489909);
  h ^= h >>> 16;
  return h >>> 0;
}

function zoneOf(id: string): string {
  return POOL.find((n) => n.id === id)?.zone ?? "a";
}

/** For each partition: replicas in priority order (first = leader). */
function assign(active: string[]): string[][] {
  const out: string[][] = [];
  for (let p = 0; p < NP; p++) {
    const ranked = [...active].sort((x, y) => h32(`${y}|${p}`) - h32(`${x}|${p}`));
    const picked: string[] = [];
    const zones = new Set<string>();
    for (const id of ranked) {
      const z = zoneOf(id);
      if (!zones.has(z) && picked.length < RF) {
        zones.add(z);
        picked.push(id);
      }
    }
    for (const id of ranked) {
      if (picked.length >= RF) break;
      if (!picked.includes(id)) picked.push(id);
    }
    out.push(picked);
  }
  return out;
}

function nodeColor(id: string): string {
  const i = POOL.findIndex((n) => n.id === id);
  return `hsl(${(i * 41 + 200) % 360} 52% 46%)`;
}

const INITIAL = ["n1", "n2", "n3", "n4", "n5", "n6"];

export default function PartitionRing() {
  const [key, setKey] = useState("users/42");
  const [pinned, setPinned] = useState<number | null>(null);
  const [active, setActive] = useState<string[]>(INITIAL);
  const [prev, setPrev] = useState<string[][] | null>(null);
  const [tick, setTick] = useState(0);
  const [lastChange, setLastChange] = useState<{ kind: "add" | "remove"; n: number } | null>(null);

  const cur = useMemo(() => assign(active), [active]);
  const keyPart = h32(key) % NP;
  const sel = pinned ?? keyPart;

  const moved = useMemo(() => {
    const set = new Set<number>();
    let slots = 0;
    if (prev) {
      for (let p = 0; p < NP; p++) {
        const a = prev[p]!;
        const b = cur[p]!;
        const added = b.filter((x) => !a.includes(x)).length;
        if (added > 0 || a.some((x) => !b.includes(x))) set.add(p);
        slots += added;
      }
    }
    return { set, slots };
  }, [prev, cur]);

  const change = (next: string[], kind: "add" | "remove") => {
    setPrev(cur);
    setActive(next);
    setTick((t) => t + 1);
    setLastChange({ kind, n: kind === "add" ? next.length : next.length + 1 });
  };
  const add = () => {
    const free = POOL.find((n) => !active.includes(n.id));
    if (free) change([...active, free.id], "add");
  };
  const remove = () => {
    if (active.length > RF) change(active.slice(0, -1), "remove");
  };
  const toggle = (id: string) => {
    if (active.includes(id)) {
      if (active.length > RF) change(active.filter((x) => x !== id), "remove");
    } else {
      change([...active, id], "add");
    }
  };
  const reset = () => {
    setActive(INITIAL);
    setPrev(null);
    setLastChange(null);
    setTick(0);
  };

  const leaders: Record<string, number> = {};
  const copies: Record<string, number> = {};
  for (const reps of cur) {
    reps.forEach((id, i) => {
      copies[id] = (copies[id] ?? 0) + 1;
      if (i === 0) leaders[id] = (leaders[id] ?? 0) + 1;
    });
  }

  const reps = cur[sel]!;
  const size = COLS * (CELL + GAP) + GAP;
  const pct = moved.slots / (NP * RF);
  const ideal = lastChange ? 1 / lastChange.n : 0;

  return (
    <Demo
      title="Where does my key live?"
      note="Simulated in your browser. Uses 64 partitions and a toy hash so you can see every cell; a real cluster uses many more partitions and a different hash, but the same placement idea."
      controls={
        <>
          <Button onClick={add} disabled={active.length >= POOL.length}>
            Add a node
          </Button>
          <Button onClick={remove} disabled={active.length <= RF}>
            Remove a node
          </Button>
          <Button onClick={reset}>Reset</Button>
        </>
      }
    >
      <div className="pr-wrap">
        <div className="pr-left">
          <label className="pr-key">
            <span>Key</span>
            <input
              value={key}
              onChange={(e) => {
                setKey(e.target.value);
                setPinned(null);
              }}
              spellCheck={false}
              aria-label="Key to place"
            />
          </label>
          <svg
            className="pr-grid"
            viewBox={`0 0 ${size} ${size}`}
            role="img"
            aria-label={`Grid of ${NP} partitions, each coloured by its leader node`}
          >
            {cur.map((r, p) => {
              const x = GAP + (p % COLS) * (CELL + GAP);
              const y = GAP + Math.floor(p / COLS) * (CELL + GAP);
              const isMoved = moved.set.has(p);
              return (
                <g
                  key={p}
                  className={`pr-cell ${isMoved ? (tick % 2 ? "pr-mv-a" : "pr-mv-b") : ""}`}
                  onClick={() => setPinned(p)}
                  style={{ cursor: "pointer" }}
                >
                  <rect
                    x={x}
                    y={y}
                    width={CELL}
                    height={CELL}
                    rx={5}
                    fill={nodeColor(r[0]!)}
                    className={p === sel ? "pr-sel" : ""}
                  />
                  <text x={x + CELL / 2} y={y + CELL / 2 + 4} textAnchor="middle" className="pr-cell-t">
                    {p}
                  </text>
                </g>
              );
            })}
          </svg>
          <p className="pr-legend">Each square is a partition, coloured by its leader. Click one to inspect it.</p>
        </div>

        <div className="pr-right">
          <div className="pr-path" aria-live="polite">
            <code>{key || "(empty)"}</code>
            <span aria-hidden="true">{" -> "}</span>
            <span>
              partition <strong>{sel}</strong>
              {pinned !== null ? " (pinned)" : ""}
            </span>
          </div>
          <div className="pr-zones">
            {["a", "b", "c"].map((z) => {
              const idx = reps.findIndex((id) => zoneOf(id) === z);
              const id = idx >= 0 ? reps[idx]! : null;
              return (
                <div key={z} className="pr-zone">
                  <span className="pr-zone-h">{ZONE_NAME[z]}</span>
                  {id ? (
                    <div className="pr-rep" style={{ borderColor: nodeColor(id) }}>
                      <span className="pr-dot" style={{ background: nodeColor(id) }} />
                      <strong>{id}</strong>
                      <span className={idx === 0 ? "pr-role lead" : "pr-role"}>{idx === 0 ? "leader" : "follower"}</span>
                    </div>
                  ) : (
                    <div className="pr-rep none">no node</div>
                  )}
                </div>
              );
            })}
          </div>

          <div className="pr-nodes" role="group" aria-label="Nodes in the cluster">
            {POOL.map((n) => {
              const on = active.includes(n.id);
              return (
                <button
                  key={n.id}
                  type="button"
                  aria-pressed={on}
                  className={`pr-node ${on ? "on" : ""}`}
                  onClick={() => toggle(n.id)}
                  title={on ? "Click to remove this node" : "Click to add this node"}
                >
                  <span className="pr-dot" style={{ background: on ? nodeColor(n.id) : "transparent" }} />
                  <strong>{n.id}</strong>
                  <span className="pr-node-z">{n.zone}</span>
                  <span className="pr-node-c">{on ? `${leaders[n.id] ?? 0} lead, ${copies[n.id] ?? 0} total` : "off"}</span>
                </button>
              );
            })}
          </div>

          <div className="pr-stat" aria-live="polite">
            {lastChange ? (
              <>
                <strong>
                  {lastChange.kind === "add" ? "Node joined" : "Node left"}: {moved.set.size} of {NP} partitions changed
                  replicas.
                </strong>{" "}
                {moved.slots} of {NP * RF} replica copies moved ({(pct * 100).toFixed(1)}%), close to the ideal 1/N ={" "}
                {(ideal * 100).toFixed(1)}%. Everything else stayed put.
              </>
            ) : (
              <>Add or remove a node and watch only a small share of the squares flash.</>
            )}
          </div>
        </div>
      </div>
    </Demo>
  );
}
