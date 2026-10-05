import { useRef, useState } from "react";

import { jump } from "../components/chrome";
import { NODES } from "../data/site";
import { Link, Node, Packet, StateBadge } from "../diagrams/primitives";
import { useScrollProgress } from "../motion";

const POS: [number, number][] = [
  [220, 96],
  [100, 300],
  [340, 300],
];
const CLIENT: [number, number] = [220, 430];

const STATES = [
  {
    id: "route",
    title: "Route",
    body: "The SDK knows the partition map. A key hashes to one of 4096 partitions and goes straight to the replica that leads it.",
  },
  {
    id: "replicate",
    title: "Replicate",
    body: "The leader appends the write to its replica set's Raft log and acknowledges once a majority has it on disk.",
  },
  {
    id: "recover",
    title: "Recover",
    body: "A node fails. The survivors elect a new leader in about a second; strict operations wait, available ones carry on.",
  },
] as const;

const path = (a: [number, number], b: [number, number]) => `M ${a[0]} ${a[1]} L ${b[0]} ${b[1]}`;

export function Hero() {
  const ref = useRef<HTMLElement>(null);
  const progress = useScrollProgress(ref);
  const index = Math.min(STATES.length - 1, Math.floor(progress * STATES.length * 0.999));
  const state = STATES[index]!;
  const [hover, setHover] = useState<number | null>(null);
  const failed = state.id === "recover";

  return (
    <section id="top" ref={ref} className="hero" tabIndex={-1} aria-labelledby="hero-title">
      <div className="hero-sticky">
        <div className="hero-copy">
          <p className="kicker">
            <span className="kicker-index">01</span> Distributed data, at speed
          </p>
          <h1 id="hero-title">A database that makes distributed-system tradeoffs programmable.</h1>
          <p className="lede">
            Partition-tolerant. Low latency. Developer-first. Choose how each operation balances consistency,
            availability and failure behavior.
          </p>
          <div className="cta-row">
            <a className="button primary" href="#install" onClick={jump("install")}>
              Install Celeris
            </a>
            <a className="button" href="#route" onClick={jump("route")}>
              Explore Architecture
            </a>
          </div>
          <ol className="hero-states" aria-label="What the cluster is doing">
            {STATES.map((s, i) => (
              <li key={s.id} className={i === index ? "is-active" : ""} aria-current={i === index ? "step" : undefined}>
                <span className="mono">{String(i + 1).padStart(2, "0")}</span>
                <div>
                  <strong>{s.title}</strong>
                  <p>{s.body}</p>
                </div>
              </li>
            ))}
          </ol>
        </div>

        <figure className="hero-figure">
          <svg viewBox="0 0 440 480" role="img" aria-labelledby="topo-title topo-desc">
            <title id="topo-title">A three-node Celeris cluster</title>
            <desc id="topo-desc">
              {state.id === "route"
                ? "A request travels from the client to node-a, the leader of its partition."
                : state.id === "replicate"
                  ? "node-a replicates the write to node-b and node-c."
                  : "node-c has failed; node-a and node-b still form a majority and keep serving."}
            </desc>
            <defs>
              <radialGradient id="hero-glow" cx="50%" cy="45%" r="55%">
                <stop offset="0%" stopColor="rgba(34,211,238,0.18)" />
                <stop offset="100%" stopColor="rgba(34,211,238,0)" />
              </radialGradient>
            </defs>
            <circle cx="220" cy="230" r="210" fill="url(#hero-glow)" />
            <Link from={POS[0]!} to={POS[1]!} tone="accent" />
            <Link from={POS[0]!} to={POS[2]!} tone="accent" broken={failed} />
            <Link from={POS[1]!} to={POS[2]!} tone="accent" broken={failed} />
            <Link from={CLIENT} to={POS[0]!} tone="muted" opacity={state.id === "route" ? 1 : 0.35} />

            {state.id === "route" ? <Packet key="r" path={path(CLIENT, POS[0]!)} duration={1.8} /> : null}
            {state.id === "replicate" ? (
              <>
                <Packet key="a" path={path(POS[0]!, POS[1]!)} duration={1.6} />
                <Packet key="b" path={path(POS[0]!, POS[2]!)} duration={1.6} delay={0.2} />
              </>
            ) : null}
            {failed ? <Packet key="h" path={path(POS[0]!, POS[1]!)} duration={1.2} tone="ok" /> : null}

            {NODES.map((n, i) => (
              <Node
                key={n.id}
                x={POS[i]![0]}
                y={POS[i]![1]}
                label={n.id}
                sub={i === 0 ? "leader" : failed && i === 2 ? "down" : "follower"}
                tone={failed && i === 2 ? "fail" : "accent"}
                dim={failed && i === 2}
                tabIndex={0}
                role="button"
                aria-label={`${n.id}, zone ${n.zone}`}
                onMouseEnter={() => setHover(i)}
                onMouseLeave={() => setHover(null)}
                onFocus={() => setHover(i)}
                onBlur={() => setHover(null)}
              />
            ))}
            <g className="d-client" transform={`translate(${CLIENT[0]} ${CLIENT[1]})`}>
              <rect x={-44} y={-16} width={88} height={32} rx={8} />
              <text y={5} textAnchor="middle" className="d-sublabel">
                your app
              </text>
            </g>
            <StateBadge
              x={220}
              y={200}
              text={state.id === "recover" ? "LEADER ELECTED" : state.id === "replicate" ? "QUORUM 2/3" : "PARTITION 217"}
              tone={state.id === "recover" ? "ok" : "accent"}
            />
          </svg>
          {hover !== null ? <HoverCard index={hover} failed={failed} /> : null}
          <figcaption className="sr-only">{state.body}</figcaption>
        </figure>
      </div>
    </section>
  );
}

function HoverCard({ index, failed }: { index: number; failed: boolean }) {
  const n = NODES[index]!;
  const [x, y] = POS[index]!;
  const down = failed && index === 2;
  return (
    <div className="hover-card panel" style={{ left: `${(x / 440) * 100}%`, top: `${(y / 480) * 100}%` }} role="tooltip">
      <pre className="mono">
        {`${n.id}
zone: ${n.zone}
partitions: ${n.partitions}
replication: RF3
status: `}
        <span className={down ? "fail-text" : "ok-text"}>{down ? "unreachable" : "healthy"}</span>
      </pre>
    </div>
  );
}
