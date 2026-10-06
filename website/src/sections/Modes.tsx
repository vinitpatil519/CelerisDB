import { useEffect, useRef, useState, type KeyboardEvent } from "react";

import { Badge, Defs, Node, Wire, curve } from "../components/diagram";
import { SectionHead } from "../components/ui";
import { gsap, revealIn, ScrollTrigger, useGSAP, useReducedMotion } from "../motion";

type ModeId = "strict" | "session" | "bounded" | "available" | "eventual";

interface Mode {
  id: ModeId;
  label: string;
  tagline: string;
  body: string;
  steps: string[];
  code: string;
  meters: { availability: number; freshness: number; latency: number };
}

const MODES: Mode[] = [
  {
    id: "strict",
    label: "Strict",
    tagline: "Linearizable. Never stale.",
    body: "Writes go to the Raft leader of the key's replica set and are acknowledged once a majority has them on disk. Reads pass a read barrier first.",
    steps: ["Route to the partition leader", "Replicate to followers", "Majority acknowledges", "Reply with the commit version"],
    code: 'await db.put("orders/9281", order, { consistency: "strict" })',
    meters: { availability: 0.62, freshness: 1, latency: 0.55 },
  },
  {
    id: "session",
    label: "Session",
    tagline: "Read your own writes, anywhere.",
    body: "Every write returns a session token. A later read on any replica waits until that replica has applied at least that index, so you never see your own write disappear.",
    steps: ["Write returns token 4182@g7", "Read goes to a nearby follower", "Follower checks applied ≥ 4182", "Reply, never older than your write"],
    code: 'await db.get("users/42", { consistency: "session" })',
    meters: { availability: 0.78, freshness: 0.85, latency: 0.72 },
  },
  {
    id: "bounded",
    label: "Bounded",
    tagline: "Fresh enough, by contract.",
    body: "Any replica may answer as long as it is no further behind than the staleness bound you set. If it is, the read fails instead of lying.",
    steps: ["Read goes to any replica", "Replica measures its lag", "Lag 120 ms ≤ bound 500 ms", "Reply with staleness_ms"],
    code: 'await db.get("feeds/home", { consistency: "bounded", maxStalenessMs: 500 })',
    meters: { availability: 0.86, freshness: 0.7, latency: 0.84 },
  },
  {
    id: "available",
    label: "Available",
    tagline: "Keeps writing through a partition.",
    body: "When the leader is unreachable, the write is accepted locally with a hybrid timestamp, replayed into the Raft log once the network heals, and settled by deterministic last-writer-wins. Losers are recorded, never dropped.",
    steps: ["Leader unreachable", "Accepted locally · 202", "Network heals, write replays", "Converged; conflicts recorded"],
    code: 'await db.put("likes/77", 1, { consistency: "available" })',
    meters: { availability: 0.98, freshness: 0.45, latency: 0.95 },
  },
  {
    id: "eventual",
    label: "Eventual",
    tagline: "The fastest read there is.",
    body: "Read whatever the nearest replica holds right now. No coordination at all: ideal for caches, recommendations and analytics.",
    steps: ["Pick the nearest replica", "Read locally", "Reply immediately", "Converges in the background"],
    code: 'await db.get("recs/ada", { consistency: "eventual" })',
    meters: { availability: 1, freshness: 0.3, latency: 1 },
  },
];

const C: [number, number] = [86, 190];
const L: [number, number] = [330, 190];
const F1: [number, number] = [548, 92];
const F2: [number, number] = [548, 288];

const PATHS = {
  cL: curve(C, L, 0.5),
  cF1: curve(C, F1, 0.55),
  cF2: curve(C, F2, 0.55),
  LF1: curve(L, F1, 0.4),
  LF2: curve(L, F2, 0.4),
};

function Diagram({ mode, step }: { mode: ModeId; step: number }) {
  const leaderDown = mode === "available" && step < 2;
  return (
    <svg viewBox="0 0 640 380" className="modes-svg" aria-hidden="true">
      <Defs id="modes" />
      <rect width="640" height="380" fill="url(#modes-grid)" />
      {Object.entries(PATHS).map(([key, d]) => (
        <path key={key} id={`mp-${key}`} d={d} fill="none" stroke="none" />
      ))}
      <Wire d={PATHS.cL} tone={leaderDown ? "red" : "dim"} broken={leaderDown} comet={false} flow={!leaderDown} />
      <Wire d={PATHS.cF1} tone="dim" comet={false} />
      <Wire d={PATHS.cF2} tone="dim" comet={false} />
      <Wire d={PATHS.LF1} tone={leaderDown ? "red" : "dim"} broken={leaderDown} comet={false} />
      <Wire d={PATHS.LF2} tone={leaderDown ? "red" : "dim"} broken={leaderDown} comet={false} />

      <g className="d-client" transform={`translate(${C[0]} ${C[1]})`}>
        <rect x={-50} y={-22} width={100} height={44} rx={11} />
        <text y={-3} textAnchor="middle" className="d-label">
          your app
        </text>
        <text y={12} textAnchor="middle" className="d-sub">
          SDK
        </text>
      </g>
      <Node
        x={L[0]}
        y={L[1]}
        label="leader"
        sub={leaderDown ? "unreachable" : "raft group g7"}
        tone={leaderDown ? "red" : "cyan"}
        leader={!leaderDown}
        dim={leaderDown}
        glow="modes"
        size={62}
      />
      <Node x={F1[0]} y={F1[1]} label="follower" sub="ap-south-1b" tone={mode === "session" || mode === "available" ? "cyan" : "dim"} size={52} />
      <Node x={F2[0]} y={F2[1]} label="follower" sub="ap-south-1c" tone={mode === "bounded" || mode === "eventual" ? "cyan" : "dim"} size={52} />

      <circle className="pkt pkt-a" r={6} filter="url(#modes-glow)" />
      <circle className="pkt pkt-b" r={5} filter="url(#modes-glow)" />
      <circle className="pkt pkt-c" r={5} filter="url(#modes-glow)" />
      <circle className="pkt pkt-ack1" r={4.5} filter="url(#modes-glow)" />
      <circle className="pkt pkt-reply" r={6} filter="url(#modes-glow)" />

      <g className="mode-badges">
        <Badge className="mb mb-commit" x={330} y={110} text="COMMITTED · 2/3 ACKS" tone="green" />
        <Badge className="mb mb-token" x={208} y={120} text="TOKEN 4182@g7" tone="cyan" />
        <Badge className="mb mb-applied" x={548} y={34} text="APPLIED 4190 ≥ 4182 ✓" tone="green" />
        <Badge className="mb mb-lag" x={548} y={348} text="LAG 120 ms ≤ 500 ms" tone="amber" />
        <Badge className="mb mb-local" x={548} y={34} text="ACCEPTED LOCALLY · 202" tone="amber" />
        <Badge className="mb mb-reconciled" x={430} y={150} text="RECONCILED" tone="green" />
        <Badge className="mb mb-nearest" x={548} y={348} text="NEAREST REPLICA · 0.3 ms" tone="cyan" />
      </g>
    </svg>
  );
}

/** Builds the looping choreography for one mode; `onStep` syncs the list. */
function choreography(scope: Element, mode: ModeId, onStep: (i: number) => void): gsap.core.Timeline {
  const q = gsap.utils.selector(scope);
  const tl = gsap.timeline({ repeat: -1, repeatDelay: 0.8, defaults: { ease: "power2.inOut" } });
  gsap.set(q(".pkt"), { opacity: 0 });
  gsap.set(q(".mb"), { opacity: 0 });
  const along = (
    target: string,
    path: string,
    opts: { reverse?: boolean; color?: string; duration?: number; at?: string | number } = {},
  ) =>
    tl.fromTo(
      q(target),
      { opacity: 1, fill: opts.color ?? "var(--cyan)" },
      {
        duration: opts.duration ?? 0.9,
        motionPath: {
          path: `#mp-${path}`,
          align: `#mp-${path}`,
          alignOrigin: [0.5, 0.5],
          start: opts.reverse ? 1 : 0,
          end: opts.reverse ? 0 : 1,
        },
      },
      opts.at,
    );
  const hide = (t: string) => tl.to(q(t), { opacity: 0, duration: 0.15 });
  const show = (t: string) => tl.to(q(t), { opacity: 1, duration: 0.3 });
  const step = (i: number) => tl.call(() => onStep(i));

  switch (mode) {
    case "strict":
      step(0);
      along(".pkt-a", "cL");
      hide(".pkt-a");
      step(1);
      along(".pkt-b", "LF1", { duration: 0.7 });
      along(".pkt-c", "LF2", { duration: 0.85, at: "<" });
      step(2);
      along(".pkt-ack1", "LF1", { reverse: true, color: "var(--green)", duration: 0.6 });
      hide(".pkt-b, .pkt-c, .pkt-ack1");
      show(".mb-commit");
      step(3);
      along(".pkt-reply", "cL", { reverse: true, color: "var(--green)" });
      tl.to(q(".pkt-reply, .mb-commit"), { opacity: 0, duration: 0.3, delay: 0.6 });
      break;
    case "session":
      step(0);
      along(".pkt-a", "cL", { duration: 0.7 });
      hide(".pkt-a");
      along(".pkt-reply", "cL", { reverse: true, color: "var(--green)", duration: 0.7 });
      hide(".pkt-reply");
      show(".mb-token");
      step(1);
      along(".pkt-b", "cF1");
      step(2);
      show(".mb-applied");
      hide(".pkt-b");
      step(3);
      along(".pkt-ack1", "cF1", { reverse: true, color: "var(--green)" });
      tl.to(q(".pkt, .mb-token, .mb-applied"), { opacity: 0, duration: 0.3, delay: 0.6 });
      break;
    case "bounded":
      step(0);
      along(".pkt-a", "cF2");
      step(1);
      show(".mb-lag");
      step(2);
      tl.to({}, { duration: 0.5 });
      hide(".pkt-a");
      step(3);
      along(".pkt-reply", "cF2", { reverse: true, color: "var(--green)" });
      tl.to(q(".pkt, .mb-lag"), { opacity: 0, duration: 0.3, delay: 0.6 });
      break;
    case "available":
      step(0);
      tl.to({}, { duration: 0.6 });
      step(1);
      along(".pkt-a", "cF1", { color: "var(--amber)" });
      show(".mb-local");
      hide(".pkt-a");
      along(".pkt-reply", "cF1", { reverse: true, color: "var(--amber)", duration: 0.7 });
      hide(".pkt-reply");
      tl.to({}, { duration: 0.6 });
      step(2);
      hide(".mb-local");
      along(".pkt-b", "LF1", { reverse: true, color: "var(--green)" });
      step(3);
      show(".mb-reconciled");
      tl.to(q(".pkt, .mb-reconciled"), { opacity: 0, duration: 0.3, delay: 0.9 });
      break;
    case "eventual":
      step(0);
      along(".pkt-a", "cF2", { duration: 0.5 });
      step(1);
      show(".mb-nearest");
      hide(".pkt-a");
      step(2);
      along(".pkt-reply", "cF2", { reverse: true, color: "var(--green)", duration: 0.5 });
      step(3);
      tl.to(q(".pkt, .mb-nearest"), { opacity: 0, duration: 0.3, delay: 0.8 });
      break;
  }
  return tl;
}

export function Modes() {
  const ref = useRef<HTMLElement>(null);
  const svgWrap = useRef<HTMLDivElement>(null);
  const [index, setIndex] = useState(0);
  const [step, setStep] = useState(0);
  const [touched, setTouched] = useState(false);
  const reduced = useReducedMotion();
  const mode = MODES[index]!;

  useGSAP(() => ref.current && revealIn(ref.current), { scope: ref });

  useGSAP(
    () => {
      if (!svgWrap.current || reduced) {
        setStep(3);
        return;
      }
      const tl = choreography(svgWrap.current, mode.id, setStep);
      ScrollTrigger.create({
        trigger: svgWrap.current,
        start: "top bottom",
        end: "bottom top",
        onToggle: (self) => (self.isActive ? tl.play() : tl.pause()),
      });
    },
    { scope: svgWrap, dependencies: [mode.id, reduced], revertOnUpdate: true },
  );

  useEffect(() => {
    if (touched || reduced) return;
    const t = setInterval(() => setIndex((i) => (i + 1) % MODES.length), 7000);
    return () => clearInterval(t);
  }, [touched, reduced]);

  const pick = (i: number) => {
    setTouched(true);
    setIndex(i);
  };
  const onKey = (e: KeyboardEvent) => {
    if (e.key === "ArrowRight") pick((index + 1) % MODES.length);
    if (e.key === "ArrowLeft") pick((index - 1 + MODES.length) % MODES.length);
  };

  return (
    <section id="modes" ref={ref} className="section modes" aria-labelledby="modes-title">
      <div className="container">
        <SectionHead
          eyebrow="Consistency, per request"
          id="modes-title"
          title={
            <>
              One cluster. <em>Five promises.</em>
            </>
          }
        >
          <p>
            CAP is a law, not a setting. Celeris lets each operation pick its side of it, and every response tells you
            which promise was kept.
          </p>
        </SectionHead>

        <div className="modes-tabs" role="tablist" aria-label="Consistency mode" onKeyDown={onKey} data-reveal="fade">
          {MODES.map((m, i) => (
            <button
              key={m.id}
              type="button"
              role="tab"
              aria-selected={i === index}
              tabIndex={i === index ? 0 : -1}
              onClick={() => pick(i)}
              className={i === index ? "is-active" : ""}
            >
              <span className="tab-label">{m.label}</span>
              {i === index && !touched && !reduced ? <span className="tab-timer" key={index} /> : null}
            </button>
          ))}
        </div>

        <div className="modes-stage" role="tabpanel" aria-label={mode.label}>
          <div className="modes-diagram panel" ref={svgWrap} data-reveal="fade">
            <Diagram mode={mode.id} step={step} />
          </div>
          <div className="modes-copy" data-reveal="fade" data-delay="0.1">
            <p className="modes-tagline" key={`t-${mode.id}`}>
              {mode.tagline}
            </p>
            <p className="modes-body">{mode.body}</p>
            <ol className="modes-steps">
              {mode.steps.map((s, i) => (
                <li key={s} className={i <= step ? "is-on" : ""} aria-current={i === step ? "step" : undefined}>
                  <span className="step-n mono">{String(i + 1).padStart(2, "0")}</span>
                  {s}
                </li>
              ))}
            </ol>
            <div className="meters">
              {(
                [
                  ["Availability", mode.meters.availability, "cyan"],
                  ["Freshness", mode.meters.freshness, "green"],
                  ["Speed", mode.meters.latency, "amber"],
                ] as const
              ).map(([label, v, tone]) => (
                <div className="meter" key={label}>
                  <span>{label}</span>
                  <div
                    className="meter-track"
                    role="meter"
                    aria-label={label}
                    aria-valuemin={0}
                    aria-valuemax={100}
                    aria-valuenow={Math.round(v * 100)}
                  >
                    <span className={`meter-fill tone-${tone}`} style={{ width: `${v * 100}%` }} />
                  </div>
                </div>
              ))}
            </div>
            <pre className="modes-code mono" key={`c-${mode.id}`}>
              <code>{mode.code}</code>
            </pre>
          </div>
        </div>
      </div>
    </section>
  );
}
