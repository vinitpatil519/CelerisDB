import { useRef } from "react";

import { SectionHead } from "../components/chrome";
import { FailureLine, Link, Node, StateBadge } from "../diagrams/primitives";
import { phase, useScrollProgress } from "../motion";

/* --------------------------------------------- 07 The partition happens */

export function Split() {
  const ref = useRef<HTMLElement>(null);
  const p = useScrollProgress(ref);
  const apart = phase(p, 0.12, 0.38) * (1 - phase(p, 0.62, 0.78));
  const broken = apart > 0.35;
  const healed = p > 0.78;
  const wave = phase(p, 0.78, 0.98);
  const dx = apart * 90;

  const caption = healed
    ? "The network heals. Locally accepted writes replay into the Raft log in order, last-writer-wins settles conflicts, and every replica converges."
    : broken
      ? "The cluster is split. On the majority side strict writes still commit. On node-c, strict writes wait for a quorum while available writes are accepted locally."
      : "A healthy three-node cluster replicating every write.";

  return (
    <section id="reconcile" ref={ref} className="story taller" tabIndex={-1} aria-labelledby="split-title">
      <div className="sticky stacked">
        <SectionHead index="07" kicker="The partition happens" title={<span id="split-title">Watch the cluster tear in two, and heal.</span>} />
        <figure className="split panel">
          <svg viewBox="0 0 900 420" role="img" aria-labelledby="split-desc">
            <desc id="split-desc">{caption}</desc>
            <Link from={[200 - dx, 130]} to={[680 + dx, 210]} tone="accent" broken={broken} opacity={1 - apart * 0.5} />
            <Link from={[200 - dx, 290]} to={[680 + dx, 210]} tone="accent" broken={broken} opacity={1 - apart * 0.5} />
            <g transform={`translate(${-dx} 0)`}>
              <Link from={[200, 130]} to={[200, 290]} tone="accent" />
              <Node x={200} y={130} label="node-a" sub="leader" />
              <Node x={200} y={290} label="node-b" />
              <StateBadge x={200} y={392} text={broken ? "STRICT: COMMITTED 2/3" : "STRICT: COMMITTED 3/3"} tone="accent" />
            </g>
            <g transform={`translate(${dx} 0)`}>
              <Node x={680} y={210} label="node-c" sub={broken ? "minority" : "follower"} tone={broken ? "warn" : "accent"} />
              <StateBadge x={680} y={80} text="STRICT: WAITING FOR QUORUM" tone="warn" opacity={broken ? 1 : 0} />
              <StateBadge x={680} y={340} text="AVAILABLE: ACCEPTED LOCALLY" tone="accent" opacity={broken ? 1 : 0} />
            </g>
            <FailureLine x={450} top={30} bottom={390} opacity={broken ? 1 : 0} />
            {wave > 0 ? (
              <>
                <circle cx={450} cy={210} r={40 + wave * 420} className="wave" opacity={1 - wave} />
                <circle cx={450} cy={210} r={20 + wave * 300} className="wave" opacity={(1 - wave) * 0.6} />
                <StateBadge x={450} y={210} text="RECONCILED" tone="ok" opacity={phase(wave, 0.3, 0.7)} />
              </>
            ) : null}
          </svg>
          <figcaption aria-live="polite">{caption}</figcaption>
        </figure>
      </div>
    </section>
  );
}

/* ----------------------------------------------- 08 Conflict resolution */

const STEPS = [
  {
    title: "Causal ordering",
    body: "Each write carries a hybrid logical clock timestamp and the version it observed. A write that saw the other is simply newer.",
  },
  {
    title: "Concurrent updates",
    body: "node-a and node-c both changed cart/7 during the partition, neither seeing the other. That is a real conflict.",
  },
  {
    title: "Deterministic LWW",
    body: "Every replica picks the same winner: higher timestamp, then mutation ID as a tie-break. No coordination needed.",
  },
  {
    title: "Merge policy",
    body: "The loser is not thrown away. It is recorded in /v1/conflicts so your app can merge it, or clear it.",
  },
  {
    title: "Converged state",
    body: "Anti-entropy compares Merkle digests of every replica and repairs any that diverged. All replicas agree.",
  },
];

export function Conflicts() {
  const ref = useRef<HTMLElement>(null);
  const p = useScrollProgress(ref);
  const step = Math.min(STEPS.length - 1, Math.floor(phase(p, 0.1, 0.9) * STEPS.length));
  const resolved = step >= 2;

  return (
    <section ref={ref} className="story tall" tabIndex={-1} aria-labelledby="conflict-title">
      <div className="sticky two-col">
        <div>
          <SectionHead index="08" kicker="Conflict resolution" title={<span id="conflict-title">Two truths in, one truth out. Nothing lost.</span>} />
          <ol className="steps">
            {STEPS.map((s, i) => (
              <li key={s.title} className={i <= step ? "is-on" : ""} aria-current={i === step ? "step" : undefined}>
                <strong>{s.title}</strong>
                <p>{s.body}</p>
              </li>
            ))}
          </ol>
        </div>
        <div className="versions">
          <VersionCard
            node="node-a"
            ts="12:00:03.114"
            value={'{ "items": 3, "coupon": null }'}
            state={resolved ? "winner" : "pending"}
          />
          <VersionCard
            node="node-c"
            ts="12:00:02.871"
            value={'{ "items": 2, "coupon": "SPRING" }'}
            state={resolved ? "loser" : "pending"}
          />
          <div className={`converged panel ${step >= 4 ? "is-on" : ""}`}>
            <span className="kicker">cart/7 on every replica</span>
            <pre className="mono">{'{ "items": 3, "coupon": null }   v42'}</pre>
            <span className="mono muted">1 conflict recorded · digests match</span>
          </div>
        </div>
      </div>
    </section>
  );
}

function VersionCard({ node, ts, value, state }: { node: string; ts: string; value: string; state: "pending" | "winner" | "loser" }) {
  return (
    <div className={`version panel ${state}`}>
      <div className="version-head">
        <span className="mono">{node}</span>
        <span className="mono muted">hlc {ts}</span>
        <span className={`pill ${state}`}>{state === "pending" ? "concurrent" : state === "winner" ? "wins (later)" : "recorded in /v1/conflicts"}</span>
      </div>
      <pre className="mono">{value}</pre>
    </div>
  );
}
