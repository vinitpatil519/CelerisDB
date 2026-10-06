import { useRef } from "react";

import { SectionHead } from "../components/kit";
import { gsap, prefersReducedMotion, useGSAP } from "../motion";

/* Small, self-running visuals, one per feature. */

function RetryViz() {
  return (
    <div className="viz viz-retry">
      {["attempt 1", "attempt 2", "attempt 3"].map((a, i) => (
        <div key={a} className="retry-row" style={{ animationDelay: `${i * 0.6}s` }}>
          <span className="mono">PUT orders/9281</span>
          <span className="mono muted">id 7f3a…</span>
          <span className={`tag ${i === 0 ? "ok" : "dim"}`}>{i === 0 ? "applied" : "deduplicated"}</span>
        </div>
      ))}
    </div>
  );
}

function StreamViz() {
  const events = [
    ["put", "orders/9281", "paid"],
    ["put", "orders/9282", "placed"],
    ["del", "carts/7", ""],
    ["put", "orders/9281", "shipped"],
    ["put", "inventory/sku-4", "12"],
    ["put", "orders/9283", "placed"],
  ];
  return (
    <div className="viz viz-stream">
      <div className="stream-track">
        {[...events, ...events].map(([k, key, v], i) => (
          <div key={i} className="stream-row">
            <span className={`tag ${k === "del" ? "bad" : "ok"}`}>{k}</span>
            <span className="mono">{key}</span>
            <span className="mono muted">{v}</span>
          </div>
        ))}
      </div>
    </div>
  );
}

function QueryViz() {
  const rows = [86, 64, 52, 41, 30, 22];
  return (
    <div className="viz viz-query">
      <code className="q-line">{`{ "status": "paid", "total": { "$gte": 100 } }`}</code>
      <div className="q-meta">
        <span className="tag ok">index by_status</span>
        <span className="mono muted">sort total desc · 6 rows · 0 skipped</span>
      </div>
      <div className="q-bars">
        {rows.map((w, i) => (
          <span key={i} style={{ width: `${w}%`, animationDelay: `${i * 0.08}s` }} />
        ))}
      </div>
    </div>
  );
}

function ConflictViz() {
  return (
    <div className="viz viz-conflict">
      <div className="cf-side">
        <span className="mono">region 1</span>
        <span className="cf-val win">likes: 41</span>
      </div>
      <div className="cf-merge" />
      <div className="cf-side">
        <span className="mono">region 2</span>
        <span className="cf-val lose">likes: 40</span>
      </div>
      <div className="cf-out">
        <span className="tag ok">kept 41</span>
        <span className="tag warn">40 → /v1/conflicts</span>
      </div>
    </div>
  );
}

function HealViz() {
  return (
    <div className="viz viz-heal">
      <svg viewBox="0 0 220 110" aria-hidden="true">
        <line x1="40" y1="80" x2="110" y2="25" className="hl" />
        <line x1="180" y1="80" x2="110" y2="25" className="hl hl-cut" />
        <line x1="40" y1="80" x2="180" y2="80" className="hl hl-cut" />
        <circle cx="110" cy="25" r="11" className="hn lead" />
        <circle cx="40" cy="80" r="11" className="hn" />
        <circle cx="180" cy="80" r="11" className="hn fail" />
      </svg>
    </div>
  );
}

function SecurityViz() {
  return (
    <div className="viz viz-sec">
      {[
        ["ci-reader", "read"],
        ["checkout-api", "read · write"],
        ["ops", "admin"],
      ].map(([n, s]) => (
        <div key={n} className="sec-row">
          <span className="mono">{n}</span>
          <span className="tag">{s}</span>
          <span className="mono muted">sha256 9c1e…</span>
        </div>
      ))}
      <div className="sec-foot">
        <span className="tag ok">HTTPS</span>
        <span className="tag ok">mTLS between nodes</span>
      </div>
    </div>
  );
}

function BackupViz() {
  return (
    <div className="viz viz-backup">
      <div className="bk-row">
        <span className="mono">celeris backup --out nightly.backup</span>
      </div>
      <div className="bk-bar">
        <span />
      </div>
      <div className="bk-row muted mono">consistent at v1,204,331 · writes never paused</div>
    </div>
  );
}

function OpsViz() {
  return (
    <div className="viz viz-ops">
      <svg viewBox="0 0 220 60" preserveAspectRatio="none" aria-hidden="true">
        <path
          d="M0 44 L20 40 L40 42 L60 30 L80 34 L100 22 L120 26 L140 18 L160 24 L180 14 L200 18 L220 12"
          className="spark"
        />
      </svg>
      <div className="ops-chips">
        <span className="tag">/metrics</span>
        <span className="tag">/ready</span>
        <span className="tag">celeris doctor</span>
      </div>
    </div>
  );
}

const CARDS = [
  { title: "Live change streams", text: "Every commit, pushed over WebSockets.", viz: <StreamViz />, span: "wide" },
  { title: "Queries and indexes", text: "Filters, indexes, sort and totals, next to the data.", viz: <QueryViz />, span: "wide" },
  { title: "Exactly-once retries", text: "Mutation IDs dedupe every retry.", viz: <RetryViz />, span: "" },
  { title: "Visible conflicts", text: "Losing writes are kept, not dropped.", viz: <ConflictViz />, span: "" },
  { title: "Self-healing", text: "Failover, rebalancing, anti-entropy.", viz: <HealViz />, span: "" },
  { title: "Security", text: "Scoped tokens, HTTPS, mutual TLS.", viz: <SecurityViz />, span: "" },
  { title: "Online backups", text: "Consistent snapshots, no pause.", viz: <BackupViz />, span: "" },
  { title: "Operable", text: "Metrics, probes, console, CLI.", viz: <OpsViz />, span: "" },
];

export function Features() {
  const ref = useRef<HTMLElement>(null);
  useGSAP(
    () => {
      if (!ref.current || prefersReducedMotion()) return;
      gsap.from(ref.current.querySelectorAll(".bento-card"), {
        y: 28,
        opacity: 0,
        duration: 0.8,
        ease: "power3.out",
        stagger: 0.06,
        scrollTrigger: { trigger: ref.current.querySelector(".bento"), start: "top 80%", once: true },
      });
    },
    { scope: ref },
  );
  return (
    <section id="features" ref={ref} className="section alt" data-theme="light">
      <div className="container">
        <SectionHead eyebrow="Features" title="Built for production." />
        <div className="bento">
          {CARDS.map((c) => (
            <article key={c.title} className={`bento-card ${c.span}`}>
              {c.viz}
              <div className="bento-copy">
                <h3>{c.title}</h3>
                <p>{c.text}</p>
              </div>
            </article>
          ))}
        </div>
      </div>
    </section>
  );
}
