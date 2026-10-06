import { useRef } from "react";

import { Badge, Defs, Node, Wire, curve, line } from "../components/diagram";
import { SectionHead } from "../components/ui";
import { gsap, revealIn, ScrollTrigger, useGSAP, useReducedMotion } from "../motion";

/* Each stage illustration is a small wireframe scene with its own loop. */

function SdkScene() {
  return (
    <svg viewBox="0 0 360 220" aria-hidden="true">
      <Defs id="j1" />
      <rect x="20" y="24" width="320" height="120" rx="12" className="j-panel" data-draw />
      <text x="40" y="56" className="j-code">
        db.put(<tspan className="j-str">"orders/9281"</tspan>, order)
      </text>
      <text x="40" y="84" className="j-dim">
        celeris-mutation-id: 5d0c…e31
      </text>
      <text x="40" y="106" className="j-dim">
        consistency: strict · retry: same id
      </text>
      <Wire d={line([180, 144], [180, 200])} tone="cyan" speed={1.2} glow="j1" />
      <Badge x={180} y={200} text="HTTP/JSON →" tone="cyan" />
    </svg>
  );
}

function RouterScene() {
  const cells = [];
  for (let r = 0; r < 12; r++) {
    for (let c = 0; c < 24; c++) {
      const hit = r === 5 && c === 9;
      cells.push(
        <rect key={`${r}-${c}`} x={24 + c * 13} y={30 + r * 13} width={10} height={10} rx={2} className={hit ? "cell hit" : "cell"} />,
      );
    }
  }
  return (
    <svg viewBox="0 0 360 220" aria-hidden="true">
      <Defs id="j2" />
      <g className="cells">{cells}</g>
      <rect x="20" y="26" width="318" height="162" rx="8" className="j-frame" data-draw />
      <rect x="20" y="26" width="318" height="2" className="scanline" />
      <Badge x={180} y={206} text="xxh3 → PARTITION 217 / 4096 · EPOCH 7" tone="cyan" />
    </svg>
  );
}

function RaftScene() {
  const L: [number, number] = [64, 84];
  const F = [
    [300, 44],
    [300, 124],
  ] as [number, number][];
  return (
    <svg viewBox="0 0 360 220" aria-hidden="true">
      <Defs id="j3" />
      {F.map((f, i) => (
        <Wire key={i} d={curve(L, f, 0.5)} tone="cyan" speed={1.6} delay={i * 0.3} glow="j3" />
      ))}
      <Node x={L[0]} y={L[1]} label="leader" leader glow="j3" size={52} />
      {F.map((f, i) => (
        <Node key={i} x={f[0]} y={f[1]} size={40} tone="dim" />
      ))}
      <g className="raft-log" transform="translate(40 160)">
        {[0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11].map((i) => (
          <rect key={i} x={i * 24} y={0} width={20} height={22} rx={3} className={`entry e${i % 6}`} />
        ))}
        <line x1={-4} x2={290} y1={32} y2={32} className="commit-line" data-draw />
        <text x={0} y={50} className="j-dim">
          raft log · commit index advances on majority ack
        </text>
      </g>
    </svg>
  );
}

function StorageScene() {
  return (
    <svg viewBox="0 0 360 220" aria-hidden="true">
      <Defs id="j4" />
      <g className="wal-tape">
        <rect x="16" y="28" width="328" height="30" rx="6" className="j-frame" data-draw />
        {[0, 1, 2, 3, 4, 5, 6, 7, 8, 9].map((i) => (
          <rect key={i} x={22 + i * 32} y={34} width={26} height={18} rx={3} className={`frame f${i}`} />
        ))}
        <text x="20" y="20" className="j-label">
          WAL · one fsync, many writers
        </text>
      </g>
      <rect x="40" y="88" width="120" height="70" rx="10" className="j-panel" data-draw />
      <text x="100" y="128" textAnchor="middle" className="j-label">
        memtable
      </text>
      <Wire d={curve([160, 123], [210, 123], 0.5)} tone="cyan" speed={1.4} glow="j4" />
      {[0, 1, 2].map((i) => (
        <rect key={i} x={212 + i * 8} y={96 + i * 10} width={110} height={56} rx={8} className="j-panel sst" data-draw />
      ))}
      <text x="272" y="186" textAnchor="middle" className="j-label">
        SSTables + bloom
      </text>
    </svg>
  );
}

function ResponseScene() {
  return (
    <svg viewBox="0 0 360 220" aria-hidden="true">
      <Defs id="j5" />
      <rect x="20" y="24" width="320" height="150" rx="12" className="j-panel" data-draw />
      <text x="40" y="58" className="j-code">
        200 OK <tspan className="j-dim">· 1.8 ms</tspan>
      </text>
      <text x="40" y="86" className="j-dim">
        celeris-version: <tspan className="j-num scramble">4182</tspan>
      </text>
      <text x="40" y="108" className="j-dim">
        celeris-consistency: <tspan className="j-str">strict</tspan>
      </text>
      <text x="40" y="130" className="j-dim">
        celeris-session-index: <tspan className="j-num">4182@g7</tspan>
      </text>
      <Badge x={180} y={198} text="NEVER SILENTLY WEAKENED" tone="green" />
    </svg>
  );
}

const STAGES = [
  {
    n: "01",
    title: "SDK",
    body: "Your request gets a mutation ID. Retries reuse it, so a write can never apply twice, and an unknown outcome is reported as unknown.",
    Scene: SdkScene,
  },
  {
    n: "02",
    title: "Router",
    body: "The key hashes to one of 4096 partitions. The map says which replica set owns it and who leads; stale maps are fenced by epoch.",
    Scene: RouterScene,
  },
  {
    n: "03",
    title: "Raft group",
    body: "Each replica set is one Raft group. The leader appends, followers acknowledge, and the entry commits once a majority has it.",
    Scene: RaftScene,
  },
  {
    n: "04",
    title: "Storage",
    body: "Committed batches land in a write-ahead log whose fsyncs concurrent writers share, then a memtable, then immutable SSTables.",
    Scene: StorageScene,
  },
  {
    n: "05",
    title: "Response",
    body: "The answer carries its version, the consistency actually applied, and a session token for your next read.",
    Scene: ResponseScene,
  },
];

export function Journey() {
  const ref = useRef<HTMLElement>(null);
  const track = useRef<HTMLDivElement>(null);
  const reduced = useReducedMotion();

  useGSAP(
    () => {
      if (!ref.current || !track.current) return;
      revealIn(ref.current);
      const mm = gsap.matchMedia();
      mm.add("(min-width: 960px) and (prefers-reduced-motion: no-preference)", () => {
        const el = track.current!;
        const distance = () => el.scrollWidth - window.innerWidth + 80;
        const horizontal = gsap.to(el, {
          x: () => -distance(),
          ease: "none",
          scrollTrigger: {
            trigger: ".journey-pin",
            start: "top top",
            end: () => `+=${distance()}`,
            pin: true,
            scrub: 0.6,
            invalidateOnRefresh: true,
          },
        });
        gsap.fromTo(
          ".journey-rail-fill",
          { scaleX: 0 },
          {
            scaleX: 1,
            ease: "none",
            scrollTrigger: { trigger: ".journey-pin", start: "top top", end: () => `+=${distance()}`, scrub: 0.6 },
          },
        );
        gsap.utils.toArray<HTMLElement>(".stage").forEach((stage) => {
          gsap.from(stage.querySelectorAll("[data-draw]"), {
            drawSVG: "0%",
            duration: 1.4,
            ease: "power2.inOut",
            stagger: 0.08,
            scrollTrigger: { trigger: stage, containerAnimation: horizontal, start: "left 85%" },
          });
          gsap.from(stage.querySelector(".stage-copy"), {
            y: 30,
            opacity: 0,
            duration: 1,
            ease: "power3.out",
            scrollTrigger: { trigger: stage, containerAnimation: horizontal, start: "left 80%" },
          });
        });
        ScrollTrigger.create({
          trigger: ".stage:last-child",
          containerAnimation: horizontal,
          start: "left 70%",
          onEnter: () => gsap.to(".scramble", { duration: 1.2, scrambleText: { text: "4182", chars: "0123456789" } }),
        });
      });
      return () => mm.revert();
    },
    { scope: ref, dependencies: [reduced] },
  );

  return (
    <section id="journey" ref={ref} className="journey" aria-labelledby="journey-title">
      <div className="journey-pin">
        <div className="container journey-head">
          <SectionHead
            eyebrow="Architecture"
            id="journey-title"
            title={
              <>
                Follow one write <em>from SDK to disk.</em>
              </>
            }
          >
            <p>No proxy tier and no coordinator hop: the client routes by partition, and every hop is observable.</p>
          </SectionHead>
          <div className="journey-rail" aria-hidden="true">
            <span className="journey-rail-fill" />
          </div>
        </div>
        <div className="journey-track" ref={track}>
          {STAGES.map(({ n, title, body, Scene }) => (
            <article className="stage card" key={n}>
              <div className="stage-scene">
                <Scene />
              </div>
              <div className="stage-copy">
                <span className="stage-n mono">{n}</span>
                <h3>{title}</h3>
                <p>{body}</p>
              </div>
            </article>
          ))}
        </div>
      </div>
    </section>
  );
}
