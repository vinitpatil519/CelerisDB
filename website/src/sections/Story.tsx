import { useEffect, useRef, useState, type KeyboardEvent } from "react";

import { SectionHead } from "../components/chrome";
import { MODES } from "../data/site";
import { FailureLine, Link, Node, StateBadge } from "../diagrams/primitives";
import { gsap, phase, useReducedMotion, useScrollProgress } from "../motion";

/* ---------------------------------------------------------------- 02 CAP */

export function Cap() {
  const ref = useRef<HTMLElement>(null);
  const p = useScrollProgress(ref);
  const split = phase(p, 0.35, 0.75);
  const triangle = 1 - phase(p, 0.25, 0.5);
  const gap = split * 70;

  return (
    <section id="cap" ref={ref} className="story tall" tabIndex={-1} aria-labelledby="cap-title">
      <div className="sticky two-col">
        <div>
          <SectionHead index="02" kicker="The CAP problem" title={<span id="cap-title">We don't break CAP. We make the tradeoff explicit.</span>}>
            <p>
              When the network partitions, no database can be both linearizable and always available. Most pick one
              for you, once, for everything.
            </p>
            <p>
              Celeris lets each operation pick: a payment waits for a quorum, a page view keeps writing locally and
              reconciles later. Same cluster, same data, different promises, and every response says which promise
              it kept.
            </p>
          </SectionHead>
        </div>
        <figure className="diagram panel">
          <svg viewBox="0 0 440 360" role="img" aria-labelledby="cap-fig-title">
            <title id="cap-fig-title">
              The CAP triangle turns into a cluster split by a network partition
            </title>
            <g opacity={triangle} transform={`translate(220 190) scale(${0.8 + triangle * 0.2}) translate(-220 -190)`}>
              <path d="M 220 50 L 70 310 L 370 310 Z" className="d-triangle" />
              <text x="220" y="36" textAnchor="middle" className="d-big">C</text>
              <text x="50" y="330" textAnchor="middle" className="d-big">A</text>
              <text x="390" y="330" textAnchor="middle" className="d-big">P</text>
              <text x="220" y="200" textAnchor="middle" className="d-sublabel">pick two?</text>
            </g>
            <g opacity={split}>
              <Link from={[130 - gap, 110]} to={[130 - gap, 250]} tone="accent" />
              <Link from={[130 - gap, 110]} to={[310 + gap, 180]} tone="accent" broken={split > 0.5} opacity={1 - split * 0.4} />
              <Link from={[130 - gap, 250]} to={[310 + gap, 180]} tone="accent" broken={split > 0.5} opacity={1 - split * 0.4} />
              <Node x={130 - gap} y={110} label="node-a" size={50} />
              <Node x={130 - gap} y={250} label="node-b" size={50} />
              <Node x={310 + gap} y={180} label="node-c" size={50} tone={split > 0.6 ? "warn" : "accent"} />
              <FailureLine x={220} top={40} bottom={320} opacity={phase(split, 0.4, 1)} />
              <StateBadge x={130 - gap} y={330} text="MAJORITY" tone="accent" opacity={phase(split, 0.6, 1)} />
              <StateBadge x={310 + gap} y={330} text="MINORITY" tone="warn" opacity={phase(split, 0.6, 1)} />
            </g>
          </svg>
          <figcaption>
            A partition leaves a majority on one side and a minority on the other. Strict operations need the
            majority; available ones work on both sides.
          </figcaption>
        </figure>
      </div>
    </section>
  );
}

/* ----------------------------------------------------------- 03 The dial */

export function Dial() {
  const [index, setIndex] = useState(0);
  const mode = MODES[index]!;
  const needle = useRef<SVGGElement>(null);
  const reduced = useReducedMotion();
  const angle = -90 + (index * 180) / (MODES.length - 1);

  useEffect(() => {
    if (!needle.current) return;
    gsap.to(needle.current, {
      rotation: angle,
      svgOrigin: "200 200",
      duration: reduced ? 0 : 0.8,
      ease: "elastic.out(1, 0.6)",
    });
  }, [angle, reduced]);

  const onKey = (e: KeyboardEvent) => {
    if (e.key === "ArrowRight" || e.key === "ArrowDown") {
      e.preventDefault();
      setIndex((i) => Math.min(MODES.length - 1, i + 1));
    } else if (e.key === "ArrowLeft" || e.key === "ArrowUp") {
      e.preventDefault();
      setIndex((i) => Math.max(0, i - 1));
    } else if (e.key === "Home") {
      setIndex(0);
    } else if (e.key === "End") {
      setIndex(MODES.length - 1);
    }
  };

  return (
    <section id="dial" className="story" tabIndex={-1} aria-labelledby="dial-title">
      <SectionHead index="03" kicker="Consistency dial" title={<span id="dial-title">Five modes. One request at a time.</span>}>
        <p>Turn the dial. Every step trades coordination for availability.</p>
      </SectionHead>
      <div className="dial-layout">
        <figure className="dial panel">
          <svg viewBox="0 0 400 230" aria-hidden="true">
            <path d="M 40 200 A 160 160 0 0 1 360 200" className="dial-track" />
            <path
              d="M 40 200 A 160 160 0 0 1 360 200"
              className="dial-fill"
              pathLength={1}
              style={{ strokeDashoffset: 1 - index / (MODES.length - 1) }}
            />
            {MODES.map((m, i) => {
              const a = ((-180 + (i * 180) / (MODES.length - 1)) * Math.PI) / 180;
              return (
                <g key={m.id}>
                  <line
                    x1={200 + Math.cos(a) * 140}
                    y1={200 + Math.sin(a) * 140}
                    x2={200 + Math.cos(a) * 176}
                    y2={200 + Math.sin(a) * 176}
                    className={i === index ? "dial-tick is-active" : "dial-tick"}
                  />
                </g>
              );
            })}
            <g ref={needle}>
              <line x1="200" y1="200" x2="200" y2="70" className="dial-needle" />
            </g>
            <circle cx="200" cy="200" r="10" className="dial-hub" />
          </svg>
          <div className="dial-mode mono" aria-live="polite">
            {mode.label}
          </div>
        </figure>
        <div className="dial-detail">
          <div className="segmented" role="radiogroup" aria-label="Consistency mode" onKeyDown={onKey}>
            {MODES.map((m, i) => (
              <button
                key={m.id}
                type="button"
                role="radio"
                aria-checked={i === index}
                tabIndex={i === index ? 0 : -1}
                onClick={() => setIndex(i)}
              >
                {m.label}
              </button>
            ))}
          </div>
          <p className="dial-summary">{mode.summary}</p>
          <Meter label="Expected availability" value={mode.availability} tone="accent" />
          <Meter label="Stale-read risk" value={mode.staleRisk} tone="warn" />
          <Meter label="Coordination cost" value={mode.coordination} tone="muted" />
          <p className="dial-use">
            <span className="kicker">Typical use</span> {mode.useCase}
          </p>
          <pre className="inline-code mono">{`GET /v1/kv/orders/123?consistency=${mode.id}`}</pre>
        </div>
      </div>
    </section>
  );
}

function Meter({ label, value, tone }: { label: string; value: number; tone: "accent" | "warn" | "muted" }) {
  return (
    <div className="meter">
      <div className="meter-head">
        <span>{label}</span>
        <span className="mono">{Math.round(value * 100)}</span>
      </div>
      <div className="meter-track" role="meter" aria-label={label} aria-valuemin={0} aria-valuemax={100} aria-valuenow={Math.round(value * 100)}>
        <span className={`meter-fill ${tone}`} style={{ width: `${Math.max(2, value * 100)}%` }} />
      </div>
    </div>
  );
}

/* ------------------------------------------------ 04 One request, inside */

const STAGES = [
  { name: "React", detail: "useCeleris('orders/123')" },
  { name: "SDK", detail: "mutation ID, session token, retries" },
  { name: "Router", detail: "hash(key) → partition, map epoch 7" },
  { name: "Partition 217", detail: "replica set node-a · node-b · node-c" },
  { name: "Replica", detail: "Raft leader node-a, read barrier" },
  { name: "Block cache", detail: "hit: 4 KiB block, bloom says maybe" },
  { name: "Value", detail: '{"total": 42, "status": "paid"}' },
];

export function Request() {
  const ref = useRef<HTMLElement>(null);
  const p = useScrollProgress(ref);
  const lit = Math.min(STAGES.length, Math.floor(phase(p, 0.05, 0.9) * STAGES.length + 0.0001) + 1);
  const rowHeight = 64;
  const height = rowHeight * (STAGES.length - 1);

  return (
    <section id="route" ref={ref} className="story tall" tabIndex={-1} aria-labelledby="route-title">
      <div className="sticky two-col">
        <SectionHead index="04" kicker="One request, inside the database" title={<span id="route-title">Follow a GET from component to disk.</span>}>
          <p>
            No proxy tier, no coordinator hop. The client routes by partition, the leader answers from memory or one
            block read, and every hop is visible in metrics.
          </p>
        </SectionHead>
        <figure className="request panel">
          <svg viewBox={`0 0 40 ${height + 40}`} className="request-wire" aria-hidden="true" preserveAspectRatio="xMidYMin meet">
            <line x1="20" y1="20" x2="20" y2={height + 20} className="wire-base" />
            <line
              x1="20"
              y1="20"
              x2="20"
              y2={height + 20}
              className="wire-lit"
              pathLength={1}
              style={{ strokeDashoffset: 1 - (lit - 1) / (STAGES.length - 1) }}
            />
          </svg>
          <ol className="request-stages">
            {STAGES.map((s, i) => (
              <li key={s.name} className={i < lit ? "is-lit" : ""} style={{ height: rowHeight }}>
                <span className="stage-dot" aria-hidden="true" />
                <span className="stage-name">{s.name}</span>
                <span className="stage-detail mono">{s.detail}</span>
              </li>
            ))}
          </ol>
        </figure>
      </div>
    </section>
  );
}
