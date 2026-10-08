import { useState } from "react";

import { CodeBlock, GitHubIcon, SectionHead } from "../components/kit";
import { DOCS, INSTALL, REPO } from "../data/site";

const PROOF = [
  {
    kicker: "Correctness",
    title: "Linearizability checker",
    text: "Concurrent histories checked while leaders crash.",
    metric: "checked under leader failure",
  },
  {
    kicker: "Fault injection",
    title: "Chaos suite",
    text: "Random partitions and restarts under CAS load.",
    metric: "seeded and replayable",
  },
  {
    kicker: "Durability",
    title: "Crash recovery",
    text: "Killed mid-write, repeatedly. Nothing lost.",
    metric: "zero acknowledged writes lost",
  },
  {
    kicker: "Performance",
    title: "Engine benchmarks",
    text: "~156K writes/s, ~4M rows/s scanned, per core.",
    metric: "cargo bench -p celeris-storage",
  },
];

export function Proof() {
  return (
    <section id="proof" className="section alt" data-theme="light">
      <div className="container">
        <SectionHead eyebrow="Reliability" title="Tested as if it will fail. Because it will.">
          <p>Proven in the failure cases, in CI.</p>
        </SectionHead>
        <div className="proof">
          {PROOF.map((p, i) => (
            <article key={p.title} className="proof-card" data-reveal="fade" data-delay={String(i * 0.06)}>
              <span className="eyebrow small">{p.kicker}</span>
              <h3>{p.title}</h3>
              <p>{p.text}</p>
              <span className="proof-metric">{p.metric}</span>
            </article>
          ))}
        </div>
      </div>
    </section>
  );
}

export function Cta() {
  const [tab, setTab] = useState(0);
  const item = INSTALL[tab]!;
  return (
    <section id="start" className="cta" data-theme="dark">
      <div className="container cta-grid">
        <div>
          <p className="eyebrow" data-reveal="fade">
            Get started
          </p>
          <h2 data-reveal="lines">Run a cluster before your coffee cools.</h2>
          <p className="cta-sub" data-reveal="fade">
            One binary, one image, or a three-node cluster.
          </p>
          <div className="hero-ctas" data-reveal="fade">
            <a className="btn btn-primary" href={REPO}>
              <GitHubIcon /> View on GitHub
            </a>
            <a className="btn btn-ghost" href={DOCS}>
              Read the docs
            </a>
          </div>
        </div>
        <div className="cta-install" data-reveal="fade" data-delay="0.1">
          <div className="seg seg-dark" role="tablist" aria-label="Install method">
            {INSTALL.map((x, k) => (
              <button key={x.id} type="button" role="tab" aria-selected={k === tab} onClick={() => setTab(k)}>
                {x.label}
              </button>
            ))}
          </div>
          <CodeBlock code={item.code} label="terminal" className="code-dark" />
          <ul className="cta-steps">
            <li className="mono">{`celeris put users/42 '{"name":"Ada"}'`}</li>
            <li className="mono">{`celeris query --prefix users/ --where '{"name":"Ada"}'`}</li>
          </ul>
        </div>
      </div>
    </section>
  );
}
