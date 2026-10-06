import { useEffect, useRef, useState, type KeyboardEvent } from "react";

import { Defs, Node, Wire, curve } from "../components/diagram";
import { CodeBlock, GitHubIcon, Logo, Magnetic, SectionHead } from "../components/ui";
import { ARCHITECTURE, DEPLOYMENT, INSTALL, REPO } from "../data/site";
import { revealIn, useGSAP, useReducedMotion } from "../motion";

const SDKS = [
  {
    id: "react",
    label: "React",
    file: "Order.tsx",
    code: `import { Client } from "@celeris/client";
import { useCeleris } from "@celeris/client/react";

const db = new Client({ nodes: ["https://db.acme.dev"], token });

export function Order({ id }: { id: string }) {
  // Reads once, then follows every change over a WebSocket.
  const { data } = useCeleris<Order>(db, \`orders/\${id}\`, {
    consistency: "session",
  });
  return <OrderCard order={data} />;
}`,
  },
  {
    id: "query",
    label: "Queries",
    file: "report.ts",
    code: `// Filters run on the replicas that hold the data.
// A secondary index on "status" narrows the read.
for await (const order of db.query({
  prefix: "orders/",
  where: { status: "paid", total: { $gte: 100 } },
  fields: ["total", "customer.id"],
})) ship(order);

const { count, sum } = await db.aggregate({
  prefix: "orders/",
  where: { status: "paid" },
  aggregate: { count: true, sum: ["total"] },
});`,
  },
  {
    id: "python",
    label: "Python",
    file: "checkout.py",
    code: `from celeris import Client, OutcomeUnknownError

db = Client(["https://db.acme.dev"], token=TOKEN)

# Compare-and-set: only if nobody changed the cart meanwhile.
cart = db.get("carts/7")
db.put("carts/7", {**cart.value, "paid": True}, if_version=cart.version)

with db.watch("orders/") as stream:
    for event in stream:
        notify(event.key, event.value)`,
  },
  {
    id: "rust",
    label: "Rust",
    file: "main.rs",
    code: `use celeris_client::{Client, PutOptions};

let db = Client::builder().nodes(["https://db.acme.dev"]).token(token).build()?;

// Retries reuse the mutation ID: applied exactly once.
let written = db.put("orders/9281", &order).await?;
let order: Order = db.get("orders/9281").await?.unwrap().value;`,
  },
  {
    id: "go",
    label: "Go",
    file: "main.go",
    code: `db, _ := celeris.New(celeris.Options{
    Nodes: []string{"https://db.acme.dev"},
    Token: token,
})

// Survives a network partition; reconciled later.
_, err := db.Put(ctx, "likes/77", 1,
    &celeris.PutOptions{Consistency: celeris.Available})`,
  },
];

const STATUSES = ["placed", "paid", "packed", "shipped", "delivered"];

function LiveOrder() {
  const reduced = useReducedMotion();
  const [step, setStep] = useState(1);
  useEffect(() => {
    if (reduced) return;
    const t = setInterval(() => setStep((s) => (s + 1) % STATUSES.length), 2000);
    return () => clearInterval(t);
  }, [reduced]);
  return (
    <div className="live-order card" aria-live="polite">
      <div className="lo-head">
        <span className="mono">orders/9281</span>
        <span className="live">live</span>
      </div>
      <div className="lo-amount" key={step}>
        ₹ 4,200
        <span className="lo-flash" />
      </div>
      <div className="lo-status">
        status <strong className="mono">{STATUSES[step]}</strong>
      </div>
      <div className="lo-track">
        {STATUSES.map((s, i) => (
          <span key={s} className={i <= step ? "on" : ""}>
            {s}
          </span>
        ))}
      </div>
      <div className="lo-foot mono">ws · put · v{4182 + step} · session ✓</div>
    </div>
  );
}

const TARGETS = [
  { id: "laptop", label: "Laptop", note: "celeris start" },
  { id: "docker", label: "Docker", note: "docker compose up" },
  { id: "k8s", label: "Kubernetes", note: "StatefulSet · PDB" },
  { id: "aws", label: "AWS", note: "3 AZs · EBS gp3" },
];

function DeployScene({ id }: { id: string }) {
  const n = id === "laptop" ? 1 : 3;
  const xs = n === 1 ? [180] : [70, 180, 290];
  return (
    <svg viewBox="0 0 360 150" aria-hidden="true">
      <Defs id={`d-${id}`} />
      {id === "aws" ? xs.map((x, i) => <rect key={i} x={x - 48} y={18} width={96} height={114} rx={10} className="zone" />) : null}
      {id === "k8s" ? <rect x={14} y={18} width={332} height={114} rx={14} className="zone" /> : null}
      {id === "docker" ? xs.map((x, i) => <rect key={i} x={x - 40} y={34} width={80} height={80} rx={8} className="zone" />) : null}
      {id === "laptop" ? <rect x={110} y={24} width={140} height={100} rx={10} className="zone" /> : null}
      {n === 3 ? (
        <>
          <Wire d={curve([xs[0]!, 74], [xs[1]!, 74])} speed={1.6} glow={`d-${id}`} />
          <Wire d={curve([xs[1]!, 74], [xs[2]!, 74])} speed={1.6} delay={0.4} glow={`d-${id}`} />
        </>
      ) : null}
      {xs.map((x, i) => (
        <Node key={i} x={x} y={74} size={n === 1 ? 64 : 50} leader={i === 0} glow={`d-${id}`} />
      ))}
    </svg>
  );
}

export function Developers() {
  const ref = useRef<HTMLElement>(null);
  const ctaRef = useRef<HTMLElement>(null);
  const [tab, setTab] = useState(0);
  const [target, setTarget] = useState(0);
  const reduced = useReducedMotion();
  useGSAP(() => ref.current && revealIn(ref.current), { scope: ref });
  useGSAP(() => ctaRef.current && revealIn(ctaRef.current), { scope: ctaRef });
  useEffect(() => {
    if (reduced) return;
    const t = setInterval(() => setTarget((x) => (x + 1) % TARGETS.length), 3200);
    return () => clearInterval(t);
  }, [reduced]);
  const onKey = (e: KeyboardEvent) => {
    if (e.key === "ArrowRight") setTab((t) => (t + 1) % SDKS.length);
    if (e.key === "ArrowLeft") setTab((t) => (t - 1 + SDKS.length) % SDKS.length);
  };
  const sdk = SDKS[tab]!;

  return (
    <>
      <section id="developers" ref={ref} className="section developers" aria-labelledby="dev-title">
        <div className="container">
          <SectionHead
            eyebrow="Developers"
            id="dev-title"
            title={
              <>
                Four SDKs. One hook. <em>Zero polling.</em>
              </>
            }
          >
            <p>
              Typed clients for TypeScript, Python, Rust and Go with safe retries, session tokens and live change
              streams built in.
            </p>
          </SectionHead>
          <div className="dev-grid">
            <div data-reveal="fade">
              <div className="tabs" role="tablist" aria-label="SDK" onKeyDown={onKey}>
                {SDKS.map((s, i) => (
                  <button
                    key={s.id}
                    role="tab"
                    type="button"
                    aria-selected={i === tab}
                    tabIndex={i === tab ? 0 : -1}
                    onClick={() => setTab(i)}
                  >
                    {s.label}
                  </button>
                ))}
              </div>
              <CodeBlock code={sdk.code} label={sdk.file} key={sdk.id} className="dev-code" />
            </div>
            <div className="dev-side" data-reveal="fade" data-delay="0.1">
              <LiveOrder />
              <ul className="dev-points">
                <li>
                  <strong>Exactly-once retries.</strong> Mutation IDs make every retry safe.
                </li>
                <li>
                  <strong>Honest failures.</strong> Unknown outcomes are reported as unknown.
                </li>
                <li>
                  <strong>Pushdown queries.</strong> JSON filters, indexes and aggregates run where the data lives.
                </li>
                <li>
                  <strong>Scoped tokens.</strong> Read, write and admin, hashed at rest.
                </li>
              </ul>
            </div>
          </div>

          <div className="deploy" data-reveal="fade">
            <div className="deploy-copy">
              <h3>
                Laptop to cloud. <em>Same binary.</em>
              </h3>
              <p>One self-contained Rust binary. Your data stays on infrastructure you control.</p>
              <a className="text-link" href={DEPLOYMENT}>
                Deployment guide →
              </a>
            </div>
            <div className="deploy-targets">
              {TARGETS.map((t, i) => (
                <button
                  key={t.id}
                  type="button"
                  className={`target card ${i === target ? "is-active" : ""}`}
                  onClick={() => setTarget(i)}
                  aria-pressed={i === target}
                >
                  <DeployScene id={t.id} />
                  <span className="target-label">{t.label}</span>
                  <span className="target-note mono">{t.note}</span>
                </button>
              ))}
            </div>
          </div>
        </div>
      </section>

      <section id="start" ref={ctaRef} className="cta" aria-labelledby="cta-title">
        <div className="cta-aurora" aria-hidden="true" />
        <div className="container cta-inner">
          <h2 id="cta-title" data-reveal="lines">
            Build for failure. Choose your consistency. <em>Ship anyway.</em>
          </h2>
          <div className="cta-code" data-reveal="fade">
            <CodeBlock code={INSTALL.cluster} label="Start a 3-node cluster" />
          </div>
          <div className="hero-ctas center" data-reveal="fade">
            <Magnetic className="btn btn-primary" href={REPO}>
              <GitHubIcon /> Star on GitHub
            </Magnetic>
            <Magnetic className="btn btn-ghost" href={ARCHITECTURE}>
              Read the architecture
            </Magnetic>
          </div>
        </div>
      </section>

      <footer className="footer">
        <div className="container footer-inner">
          <div className="footer-brand">
            <Logo size={20} /> Celeris
            <span className="muted">Distributed data, at speed.</span>
          </div>
          <nav aria-label="Footer">
            <a href={REPO}>GitHub</a>
            <a href={ARCHITECTURE}>Consistency</a>
            <a href={DEPLOYMENT}>Deploy</a>
            <span className="muted">Apache-2.0</span>
          </nav>
        </div>
      </footer>
    </>
  );
}
