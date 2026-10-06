import { useMemo, useRef, useState } from "react";

import { SectionHead } from "../components/kit";
import { gsap, prefersReducedMotion, useGSAP } from "../motion";

/** 256 cells, each standing for 16 of the 4,096 partitions. */
const CELLS = 256;
const PER_CELL = 4096 / CELLS;

const POOL = [
  { id: "a", zone: "zone 1", color: "#2F6BFF" },
  { id: "b", zone: "zone 2", color: "#0E9F9A" },
  { id: "c", zone: "zone 3", color: "#7C5CFC" },
  { id: "d", zone: "zone 1", color: "#E0813A" },
  { id: "e", zone: "zone 2", color: "#C2457A" },
  { id: "f", zone: "zone 3", color: "#4A8F3C" },
];
type N = (typeof POOL)[number];

/** FNV-1a with a murmur finaliser: cheap, well mixed. */
function hash(s: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  h ^= h >>> 16;
  h = Math.imul(h, 0x85ebca6b);
  h ^= h >>> 13;
  h = Math.imul(h, 0xc2b2ae35);
  h ^= h >>> 16;
  return h >>> 0;
}

/** Rendezvous placement: rank nodes by hash(cell, node), take the best of
 *  each zone first so three replicas land in three zones. */
function place(cell: number, nodes: N[]): N[] {
  const ranked = [...nodes].sort((x, y) => hash(`${cell}:${y.id}`) - hash(`${cell}:${x.id}`));
  const out: N[] = [];
  for (const n of ranked) if (out.length < 3 && !out.some((o) => o.zone === n.zone)) out.push(n);
  for (const n of ranked) if (out.length < 3 && !out.includes(n)) out.push(n);
  return out;
}

export function Partitions() {
  const [count, setCount] = useState(3);
  const [moved, setMoved] = useState<{ n: number; ideal: number } | null>(null);
  const [hover, setHover] = useState<number | null>(null);
  const grid = useRef<HTMLDivElement>(null);
  const prev = useRef<string[] | null>(null);

  const placement = useMemo(() => {
    const nodes = POOL.slice(0, count);
    return Array.from({ length: CELLS }, (_, c) => place(c, nodes));
  }, [count]);
  const nodes = POOL.slice(0, count);

  useGSAP(
    () => {
      const owners = placement.map((p) => p[0]!.id);
      const before = prev.current;
      prev.current = owners;
      if (!before || !grid.current || prefersReducedMotion()) return;
      const cells = grid.current.querySelectorAll<HTMLElement>(".pcell");
      const changed: HTMLElement[] = [];
      owners.forEach((o, i) => {
        if (o !== before[i]) changed.push(cells[i]!);
      });
      if (changed.length === 0) return;
      gsap.fromTo(
        changed,
        { scale: 0.2, opacity: 0.2 },
        { scale: 1, opacity: 1, duration: 0.5, ease: "back.out(2)", stagger: { each: 0.004, from: "random" } },
      );
    },
    { dependencies: [placement] },
  );

  const change = (next: number) => {
    const before = placement.map((p) => p[0]!.id);
    const after = Array.from({ length: CELLS }, (_, c) => place(c, POOL.slice(0, next))[0]!.id);
    const n = after.filter((o, i) => o !== before[i]).length;
    setMoved({ n, ideal: next > count ? 1 / next : 1 / count });
    setCount(next);
  };

  const owned = (id: string) => placement.filter((p) => p[0]!.id === id).length;
  const h = hover === null ? null : placement[hover]!;

  return (
    <section id="placement" className="section" data-theme="light">
      <div className="container">
        <SectionHead eyebrow="Runtime topology" title="4,096 partitions. Placed, not configured.">
          <p>Rendezvous hashing across zones. Add a node and only ~1/N moves.</p>
        </SectionHead>

        <div className="pmap" data-reveal="fade">
          <div className="pmap-grid" ref={grid} onMouseLeave={() => setHover(null)}>
            {placement.map((p, i) => (
              <span
                key={i}
                className={`pcell ${hover !== null && placement[hover]![0]!.id === p[0]!.id ? "is-peer" : ""}`}
                style={{ background: p[0]!.color }}
                onMouseEnter={() => setHover(i)}
              />
            ))}
          </div>

          <aside className="pmap-side">
            <div className="pmap-controls">
              <button
                type="button"
                className="btn btn-sm btn-primary"
                disabled={count >= POOL.length}
                onClick={() => change(count + 1)}
              >
                Add node
              </button>
              <button type="button" className="btn btn-sm btn-outline" disabled={count <= 3} onClick={() => change(count - 1)}>
                Remove node
              </button>
            </div>

            <ul className="pmap-legend">
              {nodes.map((n) => (
                <li key={n.id}>
                  <span className="swatch" style={{ background: n.color }} />
                  <span className="pl-name">node {n.id}</span>
                  <span className="pl-zone">{n.zone}</span>
                  <span className="pl-share">{Math.round((owned(n.id) / CELLS) * 100)}% led</span>
                </li>
              ))}
            </ul>

            <div className="pmap-readout" aria-live="polite">
              {moved ? (
                <>
                  <b>{Math.round((moved.n / CELLS) * 100)}%</b> of partitions changed leader
                  <span className="muted"> · ideal ≈ {Math.round(moved.ideal * 100)}%</span>
                </>
              ) : (
                <span className="muted">Add a node to see what moves.</span>
              )}
            </div>

            <div className="pmap-hover">
              {h ? (
                <>
                  <span className="mono">
                    partitions {hover! * PER_CELL}–{hover! * PER_CELL + PER_CELL - 1}
                  </span>
                  <span>
                    leader <b>node {h[0]!.id}</b> · replicas {h.map((n) => `${n.id} (${n.zone})`).join(", ")}
                  </span>
                </>
              ) : (
                <span className="muted">Hover a cell to see its replica set.</span>
              )}
            </div>
          </aside>
        </div>
      </div>
    </section>
  );
}
