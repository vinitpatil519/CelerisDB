import { useRef, useState } from "react";

import { CodeBlock, SectionHead } from "../components/kit";
import { REPO } from "../data/site";
import data from "../data/benchmarks.json";
import { gsap, prefersReducedMotion, ScrollTrigger, useGSAP } from "../motion";

/**
 * Every number here comes from bench/results/2026-11-05-quick/raw.jsonl through
 * bench/summarize.mjs. Nothing on this page is typed in by hand or simulated.
 */

const SYSTEMS: Record<string, { name: string; version: string; durability: string }> = {
  celeris: { name: "CelerisDB", version: "main", durability: "sync = always" },
  postgres: { name: "PostgreSQL", version: "17.2", durability: "synchronous_commit = on" },
  mysql: { name: "MySQL", version: "8.4.3", durability: "innodb_flush_log_at_trx_commit = 1" },
  mongodb: { name: "MongoDB", version: "8.0.4", durability: "w: 1, j: true" },
  redis: { name: "Redis", version: "7.4.2", durability: "appendfsync always" },
  etcd: { name: "etcd", version: "3.5.17", durability: "default (fsync per batch)" },
  cockroachdb: { name: "CockroachDB", version: "24.2.5", durability: "default" },
  cassandra: { name: "Cassandra", version: "5.0.2", durability: "commitlog_sync: batch" },
};

const WORKLOADS = [
  { id: "a", title: "Update heavy", mix: "YCSB A: 50% reads, 50% updates" },
  { id: "b", title: "Read mostly", mix: "YCSB B: 95% reads, 5% updates" },
  { id: "c", title: "Read only", mix: "YCSB C: 100% reads" },
  { id: "load", title: "Inserts", mix: "New keys only" },
] as const;
type WorkloadId = (typeof WORKLOADS)[number]["id"];

const SYSTEM_IDS = Object.keys(SYSTEMS);
const CONCURRENCY = 32;
const ROW = 44;

function cell(system: string, workload: WorkloadId) {
  const r = data.results.find((x) => x.system === system && x.workload === workload && x.concurrency === CONCURRENCY);
  if (!r) throw new Error(`no result for ${system}/${workload}`);
  return r;
}

const RANK = Object.fromEntries(
  WORKLOADS.map((w) => [
    w.id,
    [...SYSTEM_IDS].sort((x, y) => cell(y, w.id).opsPerSec - cell(x, w.id).opsPerSec),
  ]),
) as Record<WorkloadId, string[]>;

// One axis across all workloads, so a bar's length means the same thing throughout.
const MAX_OPS = Math.max(...WORKLOADS.map((w) => cell(RANK[w.id][0]!, w.id).opsPerSec));
const share = (ops: number) => (ops / MAX_OPS) * 100;
const ops = (n: number) => Math.round(n).toLocaleString("en-US");
const ordinal = (w: WorkloadId) => RANK[w].indexOf("celeris") + 1;

function time(us: number): string {
  return us < 1000 ? `${Math.round(us)} µs` : `${(us / 1000).toFixed(1)} ms`;
}

/* ── Throughput: one chart that re-sorts as the page scrolls ───────────── */

function Race() {
  const first = WORKLOADS[0].id;
  const pinRef = useRef<HTMLDivElement>(null);
  const [step, setStep] = useState(0);

  useGSAP(
    () => {
      const pin = pinRef.current;
      if (!pin) return;
      const states = SYSTEM_IDS.map((id) => ({
        id,
        row: pin.querySelector<HTMLElement>(`[data-row="${id}"]`)!,
        rank: RANK[first].indexOf(id),
        ops: cell(id, first).opsPerSec,
      }));
      const paint = (s: (typeof states)[number]) => {
        s.row.style.transform = `translateY(${s.rank * ROW}px)`;
        s.row.querySelector<HTMLElement>(".race-fill")!.style.width = `${share(s.ops)}%`;
        s.row.querySelector<HTMLElement>(".race-value")!.textContent = ops(s.ops);
        s.row.querySelector<HTMLElement>(".race-rank")!.textContent = String(Math.round(s.rank) + 1);
      };
      states.forEach(paint);

      // Each workload holds for 0.45, then morphs into the next over 0.55.
      const tl = gsap.timeline({ defaults: { ease: "power2.inOut" } });
      WORKLOADS.slice(1).forEach((w, i) => {
        states.forEach((s) => {
          tl.to(
            s,
            {
              rank: RANK[w.id].indexOf(s.id),
              ops: cell(s.id, w.id).opsPerSec,
              duration: 0.55,
              onUpdate: () => paint(s),
            },
            i + 0.45,
          );
        });
      });
      tl.to({}, { duration: 0.45 });

      const total = tl.duration();
      const st = ScrollTrigger.create({
        trigger: pin,
        start: "top top",
        end: `+=${WORKLOADS.length * 80}%`,
        pin: true,
        scrub: true,
        animation: tl,
        onUpdate: (self) => {
          const t = self.progress * total;
          setStep(Math.min(WORKLOADS.length - 1, Math.floor(t + 0.275)));
        },
      });
      gsap.from(pin.querySelectorAll(".race-grow"), {
        scaleX: 0,
        transformOrigin: "left center",
        duration: 1.2,
        ease: "expo.out",
        stagger: 0.05,
        scrollTrigger: { trigger: pin, start: "top 65%", once: true },
      });
      return () => st.kill();
    },
    { scope: pinRef },
  );

  return (
    <div ref={pinRef} className="cap-pin">
      <div className="container cap-grid">
        <ol className="cap-steps">
          {WORKLOADS.map((w, i) => (
            <li key={w.id} className={i === step ? "is-active" : i < step ? "is-done" : ""}>
              <span className="cap-n">0{i + 1}</span>
              <div>
                <h3>{w.title}</h3>
                <p>{w.mix}</p>
                <p className="race-claim mono">
                  CelerisDB #{ordinal(w.id)} of 8 · {ops(cell("celeris", w.id).opsPerSec)} ops/s
                </p>
              </div>
            </li>
          ))}
        </ol>
        <figure className="race">
          <figcaption className="race-head">
            <span>Throughput, ops/s</span>
            <span className="race-unit">32 clients · higher is better</span>
          </figcaption>
          <div className="race-rows" style={{ height: ROW * SYSTEM_IDS.length }}>
            {SYSTEM_IDS.map((id) => (
              <div
                key={id}
                data-row={id}
                className={`race-row ${id === "celeris" ? "is-us" : ""}`}
                style={{ transform: `translateY(${RANK[first].indexOf(id) * ROW}px)` }}
              >
                <span className="race-rank">{RANK[first].indexOf(id) + 1}</span>
                <span className="race-name">{SYSTEMS[id]!.name}</span>
                <span className="race-track">
                  <span className="race-grow">
                    <span className="race-fill" style={{ width: `${share(cell(id, first).opsPerSec)}%` }} />
                  </span>
                </span>
                <span className="race-value">{ops(cell(id, first).opsPerSec)}</span>
              </div>
            ))}
          </div>
          <div className="cap-progress" aria-hidden="true">
            {WORKLOADS.map((w, i) => (
              <span key={w.id} className={i <= step ? "on" : ""} />
            ))}
          </div>
        </figure>
      </div>
    </div>
  );
}

/** Narrow screens and reduced motion: the same chart, once per workload. */
function RaceStack() {
  return (
    <div className="container cap-stack">
      {WORKLOADS.map((w, i) => (
        <article key={w.id} className="cap-card" data-reveal="fade">
          <span className="cap-n">0{i + 1}</span>
          <h3>{w.title}</h3>
          <p>{w.mix}</p>
          <figure className="race race-static">
            <figcaption className="race-head">
              <span>Throughput, ops/s</span>
              <span className="race-unit">higher is better</span>
            </figcaption>
            {RANK[w.id].map((id, k) => (
              <div key={id} className={`race-row ${id === "celeris" ? "is-us" : ""}`}>
                <span className="race-rank">{k + 1}</span>
                <span className="race-name">{SYSTEMS[id]!.name}</span>
                <span className="race-track">
                  <span className="race-grow">
                    <span className="race-fill" style={{ width: `${share(cell(id, w.id).opsPerSec)}%` }} />
                  </span>
                </span>
                <span className="race-value">{ops(cell(id, w.id).opsPerSec)}</span>
              </div>
            ))}
          </figure>
        </article>
      ))}
    </div>
  );
}

export function Benchmarks() {
  const [stacked] = useState(() => matchMedia("(max-width: 899px)").matches || prefersReducedMotion());
  return (
    <section id="benchmarks" className="cap bench" data-theme="dark">
      <div className="container">
        <SectionHead eyebrow="Benchmarks" title="Eight databases. One machine. Every write on disk.">
          <p>CelerisDB placed third or fourth of eight in every workload. Not first. Here is all of it.</p>
        </SectionHead>
        <p className="bench-notice" data-reveal="fade">
          <b>Quick first run.</b> 2,000 keys, 2 seconds per workload, one pass, laptop on battery. Small gaps may not hold
          up in a longer run.
        </p>
      </div>
      {stacked ? <RaceStack /> : <Race />}
    </section>
  );
}

/* ── Latency: p50 to p99 on a log axis ─────────────────────────────────── */

const LOG_MIN = 2; // 100 µs
const LOG_MAX = 5; // 100 ms
const at = (us: number) => ((Math.log10(us) - LOG_MIN) / (LOG_MAX - LOG_MIN)) * 100;
const TICKS = [
  { us: 100, label: "100 µs" },
  { us: 1_000, label: "1 ms" },
  { us: 10_000, label: "10 ms" },
  { us: 100_000, label: "100 ms" },
];

function Latency() {
  const [workload, setWorkload] = useState<WorkloadId>("a");
  const chart = useRef<HTMLDivElement>(null);
  const order = [...SYSTEM_IDS].sort((x, y) => cell(x, workload).p99 - cell(y, workload).p99);

  useGSAP(
    () => {
      if (prefersReducedMotion() || !chart.current) return;
      gsap.fromTo(
        chart.current,
        { clipPath: "inset(0 100% 0 0)" },
        {
          clipPath: "inset(0 0% 0 0)",
          duration: 1.5,
          ease: "power3.inOut",
          clearProps: "clipPath",
          scrollTrigger: { trigger: chart.current, start: "top 80%", once: true },
        },
      );
    },
    { scope: chart },
  );

  return (
    <div className="lat" data-reveal="fade">
      <div className="lat-top">
        <div className="seg" role="tablist" aria-label="Workload">
          {WORKLOADS.map((w) => (
            <button key={w.id} type="button" role="tab" aria-selected={w.id === workload} onClick={() => setWorkload(w.id)}>
              {w.title}
            </button>
          ))}
        </div>
        <div className="lat-legend" aria-hidden="true">
          <span>
            <i className="lat-key p50" /> p50
          </span>
          <span>
            <i className="lat-key p99" /> p99
          </span>
          <span className="muted">log scale · lower is better</span>
        </div>
      </div>
      <div ref={chart} className="lat-chart">
        <div className="lat-axis" aria-hidden="true">
          {TICKS.map((t) => (
            <span key={t.us} style={{ left: `${at(t.us)}%` }}>
              {t.label}
            </span>
          ))}
        </div>
        <div className="lat-rows" style={{ height: ROW * SYSTEM_IDS.length }}>
          {SYSTEM_IDS.map((id) => {
            const c = cell(id, workload);
            return (
              <div
                key={id}
                className={`lat-row ${id === "celeris" ? "is-us" : ""}`}
                style={{ transform: `translateY(${order.indexOf(id) * ROW}px)` }}
                title={`${SYSTEMS[id]!.name}: p50 ${time(c.p50)}, p99 ${time(c.p99)}`}
              >
                <span className="lat-name">
                  {SYSTEMS[id]!.name}
                  <small className="mono">
                    {time(c.p50)} / {time(c.p99)}
                  </small>
                </span>
                <span className="lat-plot">
                  {TICKS.map((t) => (
                    <i key={t.us} className="lat-grid" style={{ left: `${at(t.us)}%` }} />
                  ))}
                  <i className="lat-range" style={{ left: `${at(c.p50)}%`, width: `${at(c.p99) - at(c.p50)}%` }} />
                  <i className="lat-key p50" style={{ left: `${at(c.p50)}%` }} />
                  <i className="lat-key p99" style={{ left: `${at(c.p99)}%` }} />
                </span>
              </div>
            );
          })}
        </div>
      </div>
    </div>
  );
}

const SETUP = [
  {
    kicker: "Durability",
    title: "Acknowledged means on disk",
    text: "Each system ran in its durable mode. Cassandra needed a change: its default acknowledges before fsync, so we set batch.",
    metric: "fsync before the reply",
  },
  {
    kicker: "Load",
    title: "Same keys, same bytes",
    text: "Zipfian keys, YCSB's 0.99 skew. 1 KiB JSON values. 32 closed-loop clients. Missing keys count as errors.",
    metric: "0 errors in 32 cells",
  },
  {
    kicker: "Isolation",
    title: "Same limits, one at a time",
    text: "Fresh container and volume per system. 6 logical CPUs and 2 GiB for the database, 4 CPUs for the client.",
    metric: "Ryzen 5 4600H · NVMe · ext4",
  },
  {
    kicker: "Clients",
    title: "Native protocol, except ours",
    text: "Every system used its native client. CelerisDB only speaks HTTP and JSON, so it pays that cost here.",
    metric: "bench/harness/drivers.go",
  },
];

const REPRODUCE = `# needs Docker, Go and the image celeris:bench
bench/run.sh --reps 1 --keys 2000 \\
  --warmup 1s --duration 2s \\
  --cells a:32,b:32,c:32,load:32 --out raw.jsonl`;

export function BenchmarkDetails() {
  return (
    <section id="latency" className="section alt" data-theme="light">
      <div className="container">
        <SectionHead eyebrow="Latency" title="The typical request, and the slow one.">
          <p>Sorted by p99. Switch workloads and watch the order change.</p>
        </SectionHead>
        <Latency />

        <div className="proof bench-setup">
          {SETUP.map((s, i) => (
            <article key={s.title} className="proof-card" data-reveal="fade" data-delay={String(i * 0.06)}>
              <span className="eyebrow small">{s.kicker}</span>
              <h3>{s.title}</h3>
              <p>{s.text}</p>
              <span className="proof-metric">{s.metric}</span>
            </article>
          ))}
        </div>

        <div className="bench-limits" data-reveal="fade">
          <div>
            <h3>What this does not show</h3>
            <ul>
              <li>
                <b>Clusters.</b> Every system ran as one node, with no replication or failover. CockroachDB, Cassandra and
                etcd are built for clusters and pay for that here.
              </li>
              <li>
                <b>Per-request consistency.</b> One node has one replica, so CelerisDB&apos;s modes all behave the same.
              </li>
              <li>
                <b>Disk-bound reads.</b> 2,000 keys fit in memory, so read workloads barely touch the disk.
              </li>
              <li>
                <b>Stability.</b> Two seconds and one pass cannot show compaction stalls or run-to-run variation.
              </li>
            </ul>
          </div>
          <div>
            <h3>Run it yourself</h3>
            <CodeBlock code={REPRODUCE} label="terminal" />
            <p className="bench-links">
              <a href={`${REPO}/tree/main/bench`}>Harness</a>
              <a href={`${REPO}/blob/main/bench/results/2026-11-05-quick/raw.jsonl`}>Raw results</a>
            </p>
          </div>
        </div>

        <details className="bench-table" data-reveal="fade" onToggle={() => ScrollTrigger.refresh()}>
          <summary>Every number, as a table</summary>
          <div className="bench-table-scroll">
            <table>
              <thead>
                <tr>
                  <th scope="col">System</th>
                  <th scope="col">Version</th>
                  <th scope="col">Durability setting</th>
                  {WORKLOADS.map((w) => (
                    <th key={w.id} scope="col">
                      {w.title}
                      <small>ops/s · p50 · p99</small>
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {SYSTEM_IDS.map((id) => (
                  <tr key={id} className={id === "celeris" ? "is-us" : ""}>
                    <th scope="row">{SYSTEMS[id]!.name}</th>
                    <td>{SYSTEMS[id]!.version}</td>
                    <td className="mono">{SYSTEMS[id]!.durability}</td>
                    {WORKLOADS.map((w) => {
                      const c = cell(id, w.id);
                      return (
                        <td key={w.id} className="mono">
                          {ops(c.opsPerSec)} · {time(c.p50)} · {time(c.p99)}
                        </td>
                      );
                    })}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </details>
      </div>
    </section>
  );
}
