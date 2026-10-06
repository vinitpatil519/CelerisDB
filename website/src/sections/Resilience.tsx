import { useEffect, useRef, useState } from "react";

import { Badge, Defs, Node, Wire, curve } from "../components/diagram";
import { Card, SectionHead } from "../components/ui";
import { gsap, revealIn, useGSAP, useReducedMotion } from "../motion";

/* ---------------------------------------------------------------- hooks */

function useTicker(ms: number, run = true): number {
  const [n, setN] = useState(0);
  useEffect(() => {
    if (!run) return;
    const t = setInterval(() => setN((x) => x + 1), ms);
    return () => clearInterval(t);
  }, [ms, run]);
  return n;
}

/* ------------------------------------------------------------ mini systems */

function Election() {
  const reduced = useReducedMotion();
  const tick = useTicker(2600, !reduced);
  const leader = Math.floor(tick / 2) % 5;
  const voting = tick % 2 === 1;
  const pts = Array.from({ length: 5 }, (_, i) => {
    const a = (i / 5) * Math.PI * 2 - Math.PI / 2;
    return [180 + Math.cos(a) * 92, 118 + Math.sin(a) * 92] as [number, number];
  });
  return (
    <svg viewBox="0 0 360 236" aria-hidden="true">
      <Defs id="el" />
      {pts.map((p, i) =>
        i === leader ? null : (
          <Wire
            key={`${leader}-${voting}-${i}`}
            d={curve(pts[leader]!, p, 0.5)}
            tone={voting ? "amber" : "cyan"}
            speed={1.3}
            delay={i * 0.12}
            glow="el"
          />
        ),
      )}
      {pts.map((p, i) => (
        <Node key={i} x={p[0]} y={p[1]} size={34} tone={i === leader ? (voting ? "amber" : "cyan") : "dim"} leader={i === leader} glow="el" />
      ))}
      <Badge
        x={180}
        y={118}
        text={voting ? `PRE-VOTE · TERM ${12 + tick}` : `LEADER n${leader + 1} · HEARTBEAT`}
        tone={voting ? "amber" : "cyan"}
      />
    </svg>
  );
}

function Ring() {
  const canvas = useRef<HTMLCanvasElement>(null);
  const reduced = useReducedMotion();
  useEffect(() => {
    const c = canvas.current;
    if (!c) return;
    const ctx = c.getContext("2d");
    if (!ctx) return;
    const dpr = Math.min(2, devicePixelRatio || 1);
    const size = c.clientWidth || 300;
    c.width = c.height = size * dpr;
    ctx.scale(dpr, dpr);
    const colors = ["#5eead4", "#7dd3fc", "#fbbf24", "#f0abfc"];
    const owner = (p: number, n: number) => {
      let best = 0;
      let score = -1;
      for (let i = 0; i < n; i++) {
        const s = Math.sin(p * 12.9898 + i * 78.233) * 43758.5453;
        const f = s - Math.floor(s);
        if (f > score) {
          score = f;
          best = i;
        }
      }
      return best;
    };
    let raf = 0;
    const start = performance.now();
    const draw = (now: number) => {
      const t = (now - start) / 1000;
      const nodes = Math.floor(t / 4) % 2 === 0 ? 3 : 4;
      ctx.clearRect(0, 0, size, size);
      const cx = size / 2;
      for (let i = 0; i < 1024; i++) {
        const a = (i / 1024) * Math.PI * 2 + t * 0.08;
        const r = size * (0.24 + (i % 6) * 0.035);
        ctx.fillStyle = colors[owner(i, nodes)]!;
        ctx.globalAlpha = 0.8;
        ctx.fillRect(cx + Math.cos(a) * r - 1, cx + Math.sin(a) * r - 1, 2, 2);
      }
      ctx.globalAlpha = 1;
      if (!reduced) raf = requestAnimationFrame(draw);
    };
    raf = requestAnimationFrame(draw);
    return () => cancelAnimationFrame(raf);
  }, [reduced]);
  return <canvas ref={canvas} className="ring-canvas" aria-hidden="true" />;
}

function GroupCommit() {
  return (
    <svg viewBox="0 0 360 200" aria-hidden="true">
      <Defs id="gc" />
      {[0, 1, 2, 3, 4, 5].map((i) => (
        <Wire
          key={i}
          d={curve([20, 30 + i * 28], [220, 100], 0.6)}
          tone="cyan"
          speed={1.1 + (i % 3) * 0.25}
          delay={i * 0.17}
          flow={false}
          glow="gc"
        />
      ))}
      <rect x="212" y="66" width="140" height="68" rx="10" className="j-panel" />
      <rect x="212" y="66" width="140" height="68" rx="10" className="fsync-flash" />
      <text x="282" y="94" textAnchor="middle" className="j-label">
        WAL
      </text>
      <text x="282" y="114" textAnchor="middle" className="j-dim">
        1 fsync, 12 writes
      </text>
    </svg>
  );
}

const STREAM = ["put orders/9281", "put carts/7", "delete sessions/q8", "put users/42", "put likes/77", "put feeds/home"];

function ChangeStream() {
  const reduced = useReducedMotion();
  const tick = useTicker(900, !reduced);
  const rows = Array.from({ length: 5 }, (_, i) => {
    const n = tick - i;
    return { n, text: STREAM[((n % STREAM.length) + STREAM.length) % STREAM.length]!, v: 4182 + n };
  });
  return (
    <ol className="stream mono" aria-hidden="true">
      {rows.map((r, i) => (
        <li key={r.n} className={i === 0 ? "is-new" : ""} style={{ opacity: 1 - i * 0.17 }}>
          <span className="stream-dot" />
          {r.text}
          <span className="stream-v">v{r.v}</span>
        </li>
      ))}
    </ol>
  );
}

function Conflict() {
  const reduced = useReducedMotion();
  const tick = useTicker(2400, !reduced);
  const settled = tick % 2 === 1;
  return (
    <div className={`lww ${settled ? "is-settled" : ""}`} aria-hidden="true">
      <div className="lww-v win">
        <span className="mono">node-a · hlc 12:00:03.114</span>
        <code>{'{ "items": 3 }'}</code>
        <span className="lww-tag">{settled ? "winner" : "concurrent"}</span>
      </div>
      <div className="lww-v lose">
        <span className="mono">node-c · hlc 12:00:02.871</span>
        <code>{'{ "items": 2 }'}</code>
        <span className="lww-tag">{settled ? "→ /v1/conflicts" : "concurrent"}</span>
      </div>
    </div>
  );
}

function hex(seed: number) {
  return ((Math.sin(seed) * 1e9) >>> 0).toString(16).padStart(8, "0").slice(0, 6);
}

function Merkle() {
  const ref = useRef<SVGSVGElement>(null);
  const reduced = useReducedMotion();
  const tick = useTicker(3000, !reduced);
  const diverged = tick % 2 === 0;
  useEffect(() => {
    if (reduced || !ref.current) return;
    gsap.to(ref.current.querySelectorAll(".mk-hash"), {
      duration: 0.8,
      stagger: 0.05,
      scrambleText: { text: "{original}", chars: "0123456789abcdef", speed: 0.6 },
    });
  }, [tick, reduced]);
  const nodes: [number, number, number][] = [
    [180, 30, 1],
    [100, 90, 2],
    [260, 90, 3],
    [60, 150, 4],
    [140, 150, 5],
    [220, 150, 6],
    [300, 150, 7],
  ];
  const edges: [number, number][] = [
    [0, 1],
    [0, 2],
    [1, 3],
    [1, 4],
    [2, 5],
    [2, 6],
  ];
  const badNode = (i: number) => diverged && (i === 0 || i === 2 || i === 6);
  return (
    <svg viewBox="0 0 360 190" ref={ref} aria-hidden="true">
      {edges.map(([a, b]) => (
        <path
          key={`${a}${b}`}
          d={curve([nodes[a]![0], nodes[a]![1]], [nodes[b]![0], nodes[b]![1]], 0.5)}
          className={`mk-edge ${badNode(a) && badNode(b) ? "bad" : ""}`}
        />
      ))}
      {nodes.map(([x, y, s], i) => (
        <g key={i} transform={`translate(${x} ${y})`} className={`mk-node ${badNode(i) ? "bad" : ""}`}>
          <rect x={-30} y={-12} width={60} height={24} rx={6} />
          <text y={4} textAnchor="middle" className="mk-hash">
            {hex(s + (badNode(i) ? tick : 0))}
          </text>
        </g>
      ))}
    </svg>
  );
}

/* --------------------------------------------------------- partition film */

function SplitFilm() {
  const ref = useRef<HTMLDivElement>(null);
  const [phase, setPhase] = useState<"healthy" | "split" | "healed">("healthy");
  useGSAP(
    () => {
      const mm = gsap.matchMedia();
      mm.add("(min-width: 960px) and (prefers-reduced-motion: no-preference)", () => {
        const tl = gsap.timeline({
          scrollTrigger: {
            trigger: ref.current,
            start: "top top",
            end: "+=2200",
            pin: true,
            scrub: 0.8,
            onUpdate: (self) => setPhase(self.progress < 0.18 ? "healthy" : self.progress < 0.7 ? "split" : "healed"),
          },
        });
        gsap.set(".sf-stub", { opacity: 0 });
        tl.to(".sf-cross", { opacity: 0, duration: 0.25 }, 0.35)
          .to(".sf-stub", { opacity: 1, duration: 0.25 }, 0.35)
          .to(".sf-left", { x: -90, duration: 1 }, 0.2)
          .to(".sf-right", { x: 90, duration: 1 }, 0.2)
          .fromTo(".sf-fault", { drawSVG: "0%" }, { drawSVG: "100%", duration: 0.6 }, 0.4)
          .from(".sf-b", { opacity: 0, y: 10, stagger: 0.15, duration: 0.4 }, 0.8)
          .to({}, { duration: 1 })
          .to(".sf-left, .sf-right", { x: 0, duration: 1 })
          .to(".sf-stub", { opacity: 0, duration: 0.2 }, "<0.7")
          .to(".sf-cross", { opacity: 1, duration: 0.3 }, "<")
          .to(".sf-fault", { opacity: 0, duration: 0.3 }, "<")
          .to(".sf-b", { opacity: 0, duration: 0.3 }, "<")
          .fromTo(
            ".sf-wave",
            { attr: { r: 20 }, opacity: 0.9 },
            { attr: { r: 520 }, opacity: 0, duration: 1.2, stagger: 0.2, immediateRender: false },
          )
          .from(".sf-done", { opacity: 0, scale: 0.8, transformOrigin: "50% 50%", duration: 0.4 }, "<0.3");
      });
      return () => mm.revert();
    },
    { scope: ref },
  );
  const split = phase === "split";
  const captions = {
    healthy: "A healthy three-node cluster replicating every write.",
    split:
      "The network splits. The majority keeps committing strict writes; on the minority, strict writes wait for a quorum while available writes are accepted locally.",
    healed:
      "The network heals. Local writes replay into the Raft log in order, last-writer-wins settles conflicts, and every replica converges.",
  };
  return (
    <div className="split-film" ref={ref}>
      <div className="container">
        <div className="split-head">
          <span className="eyebrow">
            <span className="eyebrow-dot" />
            The partition happens
          </span>
          <h3>
            Watch the cluster tear in two, <em>and heal.</em>
          </h3>
        </div>
        <div className="split-stage panel">
          <svg viewBox="0 0 960 420" role="img" aria-label={captions[phase]}>
            <Defs id="sf" />
            <rect width="960" height="420" fill="url(#sf-grid)" />
            <g className="sf-cross">
              <Wire d={curve([300, 120], [660, 210], 0.5)} tone="cyan" glow="sf" />
              <Wire d={curve([300, 300], [660, 210], 0.5)} tone="cyan" glow="sf" delay={0.4} />
            </g>
            <g className="sf-left">
              <path className="sf-stub" d="M 300 120 C 360 120, 390 140, 420 160" />
              <path className="sf-stub" d="M 300 300 C 360 300, 390 280, 420 260" />
              <Wire d={curve([300, 120], [300, 300], 0.5)} tone="cyan" glow="sf" />
              <Node x={300} y={120} label="node-a" sub="leader" leader glow="sf" />
              <Node x={300} y={300} label="node-b" sub="follower" />
              <Badge className="sf-b" x={300} y={390} text="STRICT · COMMITTED 2/3" tone="green" />
            </g>
            <g className="sf-right">
              <path className="sf-stub" d="M 660 210 C 610 210, 580 190, 548 176" />
              <path className="sf-stub" d="M 660 210 C 610 210, 580 230, 548 244" />
              <Node x={660} y={210} label="node-c" sub={split ? "minority" : "follower"} tone={split ? "amber" : "cyan"} />
              <Badge className="sf-b" x={660} y={110} text="STRICT · WAITING FOR QUORUM" tone="amber" />
              <Badge className="sf-b" x={660} y={310} text="AVAILABLE · ACCEPTED LOCALLY" tone="cyan" />
            </g>
            <path className="sf-fault" d="M 480 30 L 470 80 L 492 130 L 468 190 L 494 250 L 470 310 L 490 360 L 480 400" />
            <circle className="sf-wave" cx="480" cy="210" r="20" />
            <circle className="sf-wave" cx="480" cy="210" r="20" />
            <Badge className="sf-done" x={480} y={210} text="RECONCILED · 0 LOST" tone="green" />
          </svg>
          <p className="split-caption" aria-live="polite">
            {captions[phase]}
          </p>
        </div>
      </div>
    </div>
  );
}

/* ---------------------------------------------------------------- section */

const CARDS = [
  {
    cls: "span-2",
    title: "Raft per replica set",
    body: "Pre-vote and check-quorum keep elections fast and disruption-free. Failover in about a second.",
    Visual: Election,
  },
  { cls: "", title: "4096 partitions", body: "Rendezvous hashing moves only the partitions a new node wins, with their data.", Visual: Ring },
  { cls: "", title: "Group commit", body: "Concurrent writers share one fsync. 3–5× throughput, same durability.", Visual: GroupCommit },
  { cls: "", title: "Live change streams", body: "WebSocket events for every applied write, with lag detection.", Visual: ChangeStream },
  { cls: "", title: "Deterministic conflicts", body: "Hybrid clocks and last-writer-wins. Losers are kept for your app.", Visual: Conflict },
  {
    cls: "span-3",
    title: "Self-healing replicas",
    body: "Leaders compare Merkle digests of every replica and repair divergence from a snapshot.",
    Visual: Merkle,
  },
];

export function Resilience() {
  const ref = useRef<HTMLElement>(null);
  useGSAP(
    () => {
      if (!ref.current) return;
      revealIn(ref.current);
      gsap.from(".bento .card", {
        y: 40,
        opacity: 0,
        duration: 1,
        ease: "power3.out",
        stagger: 0.08,
        scrollTrigger: { trigger: ".bento", start: "top 80%", once: true },
      });
    },
    { scope: ref },
  );
  return (
    <section id="resilience" ref={ref} className="section resilience" aria-labelledby="res-title">
      <div className="container">
        <SectionHead
          eyebrow="Built for failure"
          id="res-title"
          title={
            <>
              Every mechanism, <em>alive and observable.</em>
            </>
          }
        >
          <p>
            Not slides about distributed systems: these are the mechanisms Celeris runs, tested under crashes,
            partitions and leader loss.
          </p>
        </SectionHead>
        <div className="bento">
          {CARDS.map(({ cls, title, body, Visual }) => (
            <Card key={title} className={`bento-card ${cls}`}>
              <div className="bento-visual">
                <Visual />
              </div>
              <h3>{title}</h3>
              <p>{body}</p>
            </Card>
          ))}
        </div>
      </div>
      <SplitFilm />
    </section>
  );
}
