import { useEffect, useMemo, useRef } from "react";

import { SectionHead } from "../components/chrome";
import { StorageLayer } from "../diagrams/primitives";
import { phase, useScrollProgress } from "../motion";

/* ------------------------------------------------- 05 4096 partitions */

const COUNT = 4096;
const NODE_COLORS = ["#22d3ee", "#a78bfa", "#34d399", "#fbbf24"];
const NODE_NAMES = ["node-a", "node-b", "node-c", "node-d"];

/** A 32-bit integer hash (murmur3 finalizer). */
function mix(x: number): number {
  x ^= x >>> 16;
  x = Math.imul(x, 0x85ebca6b);
  x ^= x >>> 13;
  x = Math.imul(x, 0xc2b2ae35);
  x ^= x >>> 16;
  return x >>> 0;
}

/** Rendezvous (highest random weight) placement: the node with the top score wins. */
function owner(partition: number, nodes: number): number {
  let best = 0;
  let bestScore = -1;
  for (let n = 0; n < nodes; n++) {
    const score = mix(partition * 2654435761 + (n + 1) * 40503);
    if (score > bestScore) {
      bestScore = score;
      best = n;
    }
  }
  return best;
}

export function Partitions() {
  const ref = useRef<HTMLElement>(null);
  const canvas = useRef<HTMLCanvasElement>(null);
  const p = useScrollProgress(ref);
  const t = phase(p, 0.2, 0.8);

  const placement = useMemo(() => {
    const before = new Uint8Array(COUNT);
    const after = new Uint8Array(COUNT);
    const order = new Float32Array(COUNT);
    let moved = 0;
    for (let i = 0; i < COUNT; i++) {
      before[i] = owner(i, 3);
      after[i] = owner(i, 4);
      order[i] = (mix(i + 7919) % 1000) / 1000;
      if (before[i] !== after[i]) moved++;
    }
    return { before, after, order, moved };
  }, []);

  useEffect(() => {
    const c = canvas.current;
    if (!c) return;
    const dpr = Math.min(2, window.devicePixelRatio || 1);
    const size = c.clientWidth;
    c.width = size * dpr;
    c.height = size * dpr;
    const ctx = c.getContext("2d");
    if (!ctx) return;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, size, size);
    const cx = size / 2;
    const r0 = size * 0.28;
    for (let i = 0; i < COUNT; i++) {
      const angle = (i / COUNT) * Math.PI * 2 - Math.PI / 2;
      const lane = i % 8;
      const movesNow = placement.before[i] !== placement.after[i] && t > placement.order[i]!;
      const moving = t > 0 && t < 1 && placement.before[i] !== placement.after[i] && Math.abs(t - placement.order[i]!) < 0.08;
      const node = movesNow ? placement.after[i]! : placement.before[i]!;
      const r = r0 + lane * size * 0.022 + (moving ? size * 0.05 : 0);
      ctx.fillStyle = NODE_COLORS[node]!;
      ctx.globalAlpha = moving ? 1 : placement.before[i] !== placement.after[i] ? 0.95 : 0.55;
      ctx.beginPath();
      ctx.arc(cx + Math.cos(angle) * r, cx + Math.sin(angle) * r, moving ? 2.4 : 1.5, 0, Math.PI * 2);
      ctx.fill();
    }
    ctx.globalAlpha = 1;
  }, [t, placement]);

  const movedSoFar = Math.round(placement.moved * t);
  const nodes = t > 0 ? 4 : 3;

  return (
    <section id="partition" ref={ref} className="story tall" tabIndex={-1} aria-labelledby="ring-title">
      <div className="sticky two-col">
        <SectionHead index="05" kicker="4096 logical partitions" title={<span id="ring-title">Add a node. Move a quarter, not everything.</span>}>
          <p>
            Every key hashes into one of 4096 partitions, placed on nodes with rendezvous hashing and spread across
            zones. When a fourth node joins, only the partitions it now wins move, with their data, while the rest
            keep serving.
          </p>
          <dl className="ring-stats">
            <div>
              <dt>nodes</dt>
              <dd className="mono">{nodes}</dd>
            </div>
            <div>
              <dt>partitions moved</dt>
              <dd className="mono">
                {movedSoFar} / {COUNT}
              </dd>
            </div>
            <div>
              <dt>share</dt>
              <dd className="mono">{Math.round((100 * movedSoFar) / COUNT)}%</dd>
            </div>
          </dl>
          <ul className="legend">
            {NODE_NAMES.map((n, i) => (
              <li key={n} className={i === 3 && t === 0 ? "is-dim" : ""}>
                <span style={{ background: NODE_COLORS[i] }} aria-hidden="true" /> {n}
                {i === 3 ? " (joins)" : ""}
              </li>
            ))}
          </ul>
        </SectionHead>
        <figure className="ring panel">
          <canvas
            className="ring-canvas"
            ref={canvas}
            role="img"
            aria-label={`A ring of ${COUNT} partitions colored by owner. ${movedSoFar} have moved to node-d.`}
          />
          <figcaption>
            Each dot is a partition, colored by the node that owns it. Scroll to add node-d.
          </figcaption>
        </figure>
      </div>
    </section>
  );
}

/* ---------------------------------------------------- 06 Storage engine */

const LAYERS = [
  { label: "WAL", detail: "CRC-framed, fsynced before the ack" },
  { label: "Memtable", detail: "sorted, in memory, swapped when full" },
  { label: "Segments", detail: "immutable SSTables, L0 → L1" },
  { label: "Bloom filter", detail: "skips tables that cannot hold the key" },
  { label: "Block cache", detail: "hot 4 KiB blocks, LRU" },
  { label: "Compaction", detail: "merges, drops tombstones after retention" },
];

export function Storage() {
  const ref = useRef<HTMLElement>(null);
  const p = useScrollProgress(ref);
  const spread = phase(p, 0.1, 0.7);
  const gap = 28 + spread * 44;
  const top = 60;
  const height = top * 2 + gap * (LAYERS.length - 1) + 40;

  return (
    <section id="store" ref={ref} className="story tall" tabIndex={-1} aria-labelledby="store-title">
      <div className="sticky two-col">
        <SectionHead index="06" kicker="Storage engine" title={<span id="store-title">An LSM tree that survives the plug being pulled.</span>}>
          <p>
            Writes land in a write-ahead log and an in-memory table, then flush to immutable segments. Recovery
            replays the log and truncates a torn tail; a crash test kills the process mid-write, over and over, and
            checks nothing acknowledged is lost.
          </p>
        </SectionHead>
        <figure className="storage panel">
          <svg viewBox={`-240 0 640 ${height}`} role="img" aria-labelledby="store-fig">
            <title id="store-fig">
              Exploded storage engine: WAL, memtable, segments, bloom filter, block cache and compaction
            </title>
            {LAYERS.map((l, i) => (
              <StorageLayer
                key={l.label}
                y={top + i * gap}
                label={l.label}
                detail={l.detail}
                width={300}
                tone={i === 0 ? "warn" : "accent"}
              />
            )).reverse()}
          </svg>
        </figure>
      </div>
    </section>
  );
}
