import { useRef } from "react";

import { CountUp, Marquee } from "../components/ui";
import { revealIn, useGSAP } from "../motion";

const STATS = [
  { value: 8581, label: "fsynced writes / s", detail: "one node, group commit, 32 clients", spark: [3, 4, 3, 6, 5, 8, 7, 9, 8, 10] },
  { value: 4096, label: "logical partitions", detail: "rendezvous-placed across zones", spark: [5, 5, 6, 5, 6, 5, 6, 6, 5, 6] },
  { value: 0.6, decimals: 1, suffix: " s", label: "leader failover", detail: "pre-vote + check-quorum Raft", spark: [9, 8, 9, 3, 2, 8, 9, 9, 8, 9] },
  { value: 0, label: "acknowledged writes lost", detail: "kill -9 crash suite, linearizability checker", spark: [1, 1, 1, 1, 1, 1, 1, 1, 1, 1] },
];

function Spark({ points }: { points: number[] }) {
  const w = 120;
  const h = 32;
  const max = Math.max(...points, 1);
  const d = points
    .map((p, i) => `${i === 0 ? "M" : "L"} ${(i / (points.length - 1)) * w} ${h - (p / max) * (h - 4) - 2}`)
    .join(" ");
  return (
    <svg viewBox={`0 0 ${w} ${h}`} className="spark" aria-hidden="true">
      <path d={`${d} L ${w} ${h} L 0 ${h} Z`} className="spark-fill" />
      <path d={d} className="spark-line" data-reveal="draw" />
    </svg>
  );
}

const TECH = [
  "Rust",
  "Raft consensus",
  "LSM storage",
  "Hybrid logical clocks",
  "SWIM gossip",
  "Merkle anti-entropy",
  "WebSocket change streams",
  "Group commit",
  "Rendezvous hashing",
  "Linearizability-checked",
  "Kubernetes-ready",
];

export function Proof() {
  const ref = useRef<HTMLElement>(null);
  useGSAP(() => ref.current && revealIn(ref.current), { scope: ref });
  return (
    <section ref={ref} className="proof" aria-label="Celeris in numbers">
      <div className="container stats">
        {STATS.map((s, i) => (
          <div className="stat" key={s.label} data-reveal="fade" data-delay={String(i * 0.08)}>
            <div className="stat-value">
              <CountUp to={s.value} decimals={s.decimals ?? 0} suffix={s.suffix ?? ""} />
            </div>
            <div className="stat-label">{s.label}</div>
            <Spark points={s.spark} />
            <div className="stat-detail">{s.detail}</div>
          </div>
        ))}
      </div>
      <Marquee
        items={TECH.map((t) => (
          <>
            {t}
            <span className="marquee-sep">✦</span>
          </>
        ))}
      />
    </section>
  );
}
