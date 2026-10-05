import { useEffect, useRef, useState, type KeyboardEvent } from "react";

import { CodeBlock, Logo, SectionHead } from "../components/chrome";
import { ARCHITECTURE, DEPLOYMENT, INSTALL, REPO } from "../data/site";
import { Link, Node, Rack, Zone } from "../diagrams/primitives";
import { phase, useReducedMotion, useScrollProgress } from "../motion";

/* --------------------------------------------------- 09 Realtime React */

const HOOK = `import { Client } from "@celeris/client";
import { useCeleris } from "@celeris/client/react";

const db = new Client({ nodes: ["https://db.example.com"] });

function Order({ id }: { id: string }) {
  const { data, loading } = useCeleris<Order>(db, \`orders/\${id}\`, {
    consistency: "session",
  });
  if (loading) return <Spinner />;
  return <OrderCard order={data} />; // re-renders on every change
}`;

const STATUSES = ["placed", "paid", "packed", "shipped", "delivered"] as const;

export function Realtime() {
  const [step, setStep] = useState(0);
  const [version, setVersion] = useState(41);
  const reduced = useReducedMotion();
  useEffect(() => {
    if (reduced) return;
    const timer = setInterval(() => {
      setStep((s) => (s + 1) % STATUSES.length);
      setVersion((v) => v + 1);
    }, 2200);
    return () => clearInterval(timer);
  }, [reduced]);
  const status = STATUSES[step]!;

  return (
    <section className="story" tabIndex={-1} aria-labelledby="realtime-title">
      <SectionHead index="09" kicker="Realtime React" title={<span id="realtime-title">One hook. Live data. No polling.</span>}>
        <p>
          <code>useCeleris</code> reads the key once, then follows it over a WebSocket change stream. It never moves
          backwards in version, and re-reads if it ever missed an event.
        </p>
      </SectionHead>
      <div className="realtime">
        <CodeBlock code={HOOK} label="Order.tsx" language="tsx" />
        <div className="order panel" aria-live="polite">
          <div className="order-head">
            <span className="mono">orders/123</span>
            <span className="live-dot">live</span>
          </div>
          <div key={version} className="order-body flash">
            <div className="order-total">₹ 4,200</div>
            <div className="order-status">
              status <strong>{status}</strong>
            </div>
            <ol className="order-track">
              {STATUSES.map((s, i) => (
                <li key={s} className={i <= step ? "done" : ""}>
                  {s}
                </li>
              ))}
            </ol>
          </div>
          <div className="order-foot mono">
            ws event · put · v{version} · session ✓
          </div>
        </div>
      </div>
    </section>
  );
}

/* ---------------------------------------------------- 10 Deploy anywhere */

const TARGETS = [
  { id: "laptop", label: "Laptop", note: "one binary: celeris start" },
  { id: "docker", label: "Docker", note: "docker compose up: three nodes" },
  { id: "kubernetes", label: "Kubernetes", note: "a StatefulSet with stable identities" },
  { id: "aws", label: "AWS", note: "one node per availability zone, EBS volumes" },
] as const;

export function Deploy() {
  const ref = useRef<HTMLElement>(null);
  const p = useScrollProgress(ref);
  const scrolled = Math.min(TARGETS.length - 1, Math.floor(phase(p, 0.1, 0.9) * TARGETS.length));
  const [picked, setPicked] = useState<number | null>(null);
  const index = picked ?? scrolled;
  const target = TARGETS[index]!;

  const onKey = (e: KeyboardEvent) => {
    if (e.key === "ArrowRight") setPicked(Math.min(TARGETS.length - 1, index + 1));
    if (e.key === "ArrowLeft") setPicked(Math.max(0, index - 1));
  };

  return (
    <section id="deploy" ref={ref} className="story tall" tabIndex={-1} aria-labelledby="deploy-title">
      <div className="sticky stacked">
        <SectionHead index="10" kicker="Deploy anywhere" title={<span id="deploy-title">Laptop to cloud. Same binary. No lock-in.</span>}>
          <p>
            Celeris is one self-contained binary. Run it on your machine, in containers, on Kubernetes or across
            availability zones. Your data stays on infrastructure you control.
          </p>
        </SectionHead>
        <div className="tabs" role="tablist" aria-label="Deployment target" onKeyDown={onKey}>
          {TARGETS.map((t, i) => (
            <button
              key={t.id}
              role="tab"
              type="button"
              aria-selected={i === index}
              tabIndex={i === index ? 0 : -1}
              onClick={() => setPicked(i)}
            >
              {t.label}
            </button>
          ))}
        </div>
        <figure className="deploy panel" role="tabpanel" aria-label={target.label}>
          <svg viewBox="0 0 900 300" role="img" aria-label={`${target.label}: ${target.note}`}>
            <DeployScene id={target.id} />
          </svg>
          <figcaption className="mono">{target.note}</figcaption>
        </figure>
      </div>
    </section>
  );
}

function DeployScene({ id }: { id: (typeof TARGETS)[number]["id"] }) {
  if (id === "laptop") {
    return (
      <g className="scene">
        <rect x={330} y={60} width={240} height={150} rx={12} className="d-device" />
        <path d="M 290 230 L 610 230 L 580 210 L 320 210 Z" className="d-device" />
        <Node x={450} y={135} label="celeris" size={56} />
      </g>
    );
  }
  if (id === "docker") {
    return (
      <g className="scene">
        <Link from={[278, 135]} to={[402, 135]} tone="accent" />
        <Link from={[498, 135]} to={[622, 135]} tone="accent" />
        {[0, 1, 2].map((i) => (
          <g key={i}>
            <rect x={160 + i * 220} y={70} width={140} height={150} rx={10} className="d-container" />
            <Node x={230 + i * 220} y={135} label={`node-${"abc"[i]}`} size={48} />
          </g>
        ))}
        <text x={450} y={260} textAnchor="middle" className="d-sublabel">
          celerisdb_default network
        </text>
      </g>
    );
  }
  if (id === "kubernetes") {
    return (
      <g className="scene">
        <rect x={120} y={40} width={660} height={220} rx={18} className="d-zone-k8s" />
        <text x={140} y={66} className="d-sublabel">
          statefulset/celeris · headless service celeris-peers
        </text>
        <Link from={[288, 150]} to={[422, 150]} tone="accent" />
        <Link from={[478, 150]} to={[612, 150]} tone="accent" />
        {[0, 1, 2].map((i) => (
          <g key={i}>
            <Node x={260 + i * 190} y={150} label={`celeris-${i}`} sub="pvc 10Gi" size={52} />
          </g>
        ))}
      </g>
    );
  }
  return (
    <g className="scene">
      {["ap-south-1a", "ap-south-1b", "ap-south-1c"].map((z, i) => (
        <Zone key={z} x={60 + i * 280} y={30} w={240} h={240} label={z}>
          <Rack x={180 + i * 280} y={80} slots={5} label={`ec2 + ebs gp3`} />
        </Zone>
      ))}
      <Link from={[208, 140]} to={[432, 140]} tone="accent" />
      <Link from={[488, 140]} to={[712, 140]} tone="accent" />
    </g>
  );
}

/* --------------------------------------------------------- 11 Install */

const INSTALL_TABS = [
  { id: "unix", label: "Linux / macOS", code: INSTALL.unix },
  { id: "windows", label: "Windows", code: INSTALL.windows },
  { id: "docker", label: "Docker", code: INSTALL.docker },
  { id: "cluster", label: "3-node cluster", code: INSTALL.cluster },
] as const;

export function Install() {
  const [tab, setTab] = useState(0);
  const current = INSTALL_TABS[tab]!;
  const onKey = (e: KeyboardEvent) => {
    if (e.key === "ArrowRight") setTab((t) => (t + 1) % INSTALL_TABS.length);
    if (e.key === "ArrowLeft") setTab((t) => (t - 1 + INSTALL_TABS.length) % INSTALL_TABS.length);
  };
  return (
    <section id="install" className="story" tabIndex={-1} aria-labelledby="install-title">
      <SectionHead index="11" kicker="Install now" title={<span id="install-title">Running in under a minute.</span>} />
      <div className="tabs" role="tablist" aria-label="Platform" onKeyDown={onKey}>
        {INSTALL_TABS.map((t, i) => (
          <button
            key={t.id}
            role="tab"
            type="button"
            aria-selected={i === tab}
            tabIndex={i === tab ? 0 : -1}
            onClick={() => setTab(i)}
          >
            {t.label}
          </button>
        ))}
      </div>
      <div role="tabpanel" aria-label={current.label}>
        <CodeBlock code={current.code} label={current.label} language="shell" />
      </div>
      <p className="muted small">
        Then: <code>celeris put users/42 '{"{"}"name":"Ada"{"}"}'</code> and <code>celeris get users/42</code>. SDKs
        for TypeScript, Python, Rust and Go live in the repository.
      </p>
    </section>
  );
}

/* --------------------------------------------------------- 12 Final CTA */

export function FinalCta() {
  return (
    <section className="final" aria-labelledby="final-title">
      <h2 id="final-title">Build for failure. Choose your consistency. Ship anyway.</h2>
      <div className="cta-row center">
        <a className="button primary" href={REPO}>
          GitHub
        </a>
        <a className="button" href={ARCHITECTURE}>
          Read the Architecture
        </a>
        <a className="button" href={DEPLOYMENT}>
          Start Local Cluster
        </a>
      </div>
      <footer className="footer">
        <Logo />
        <span>Celeris · Apache-2.0 · self-hosted, no lock-in</span>
      </footer>
    </section>
  );
}
