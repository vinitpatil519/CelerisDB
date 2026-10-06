import { useEffect, useRef, useState } from "react";

import { GitHubIcon } from "../components/kit";
import { DOC, REPO } from "../data/site";
import { gsap, jump, useGSAP, useReducedMotion } from "../motion";

type P = { x: number; y: number };
const APP: P = { x: 70, y: 48 };
const A: P = { x: 250, y: 96 };
const B: P = { x: 120, y: 214 };
const C: P = { x: 380, y: 214 };

/**
 * A small working model of one replica set: a write goes to the leader,
 * the leader replicates to both followers, and commits once a majority
 * (itself plus one) has it. Cutting node C off shows that writes keep
 * committing with two of three.
 */
function ClusterModel() {
  const root = useRef<SVGSVGElement>(null);
  const index = useRef<SVGTSpanElement>(null);
  const [cut, setCut] = useState(false);
  const reduced = useReducedMotion();

  useGSAP(
    () => {
      if (reduced || !root.current) return;
      const q = gsap.utils.selector(root.current);
      const at = (p: P) => ({ attr: { cx: p.x, cy: p.y } });
      const pkt = (sel: string) => q(sel)[0]!;
      let commit = 1204;
      const tl = gsap.timeline({ repeat: -1, repeatDelay: 0.5, defaults: { ease: "power1.inOut" } });
      tl.set(q(".pkt"), { opacity: 0 })
        .set(pkt(".p-req"), { ...at(APP), opacity: 1 })
        .to(pkt(".p-req"), { ...at(A), duration: 0.7 })
        .set(pkt(".p-req"), { opacity: 0 })
        .set([pkt(".p-b"), pkt(".p-c")], { ...at(A), opacity: 1, fill: "var(--signal)" })
        .to(pkt(".p-b"), { ...at(B), duration: 0.6 }, "rep")
        .to(
          pkt(".p-c"),
          cut
            ? { attr: { cx: (A.x + C.x) / 2, cy: (A.y + C.y) / 2 }, fill: "var(--bad)", duration: 0.35 }
            : { ...at(C), duration: 0.6 },
          "rep",
        );
      if (cut) tl.to(pkt(".p-c"), { opacity: 0, duration: 0.3 }, "rep+=0.4");
      tl.set(pkt(".p-b"), { fill: "var(--ok)" }).to(pkt(".p-b"), { ...at(A), duration: 0.5 }, "ack");
      if (!cut) {
        tl.set(pkt(".p-c"), { fill: "var(--ok)" }, "ack").to(pkt(".p-c"), { ...at(A), duration: 0.5 }, "ack");
      }
      tl.set([pkt(".p-b"), pkt(".p-c")], { opacity: 0 })
        .fromTo(
          q(".commit-ring"),
          { attr: { r: 26 }, opacity: 0.9 },
          { attr: { r: 50 }, opacity: 0, duration: 0.7, ease: "power2.out" },
          "commit",
        )
        .call(
          () => {
            commit += 1;
            if (index.current) index.current.textContent = commit.toLocaleString("en-US");
          },
          [],
          "commit",
        )
        .set(pkt(".p-res"), { ...at(A), opacity: 1, fill: "var(--ok)" }, "commit")
        .to(pkt(".p-res"), { ...at(APP), duration: 0.7 }, "commit")
        .set(pkt(".p-res"), { opacity: 0 });
      return () => tl.kill();
    },
    { scope: root, dependencies: [cut, reduced], revertOnUpdate: true },
  );

  const link = (from: P, to: P, broken: boolean) => (
    <line x1={from.x} y1={from.y} x2={to.x} y2={to.y} className={`link ${broken ? "is-broken" : ""}`} />
  );

  const node = (p: P, name: string, role: string, zone: string, down = false) => (
    <g className={`cnode ${down ? "is-down" : ""}`} transform={`translate(${p.x} ${p.y})`}>
      <rect x={-46} y={-24} width={92} height={48} rx={10} />
      <text y={-3} className="cnode-name">
        {name}
      </text>
      <text y={13} className="cnode-role">
        {role}
      </text>
      <text y={42} className="cnode-zone">
        {zone}
      </text>
    </g>
  );

  return (
    <div className="model">
      <div className="model-bar">
        <span className="model-title">
          <span className={`dot ${cut ? "warn" : "ok"}`} /> replica set · partition 1871 · simulated
        </span>
        <button type="button" className={`chip ${cut ? "is-on" : ""}`} onClick={() => setCut((c) => !c)} aria-pressed={cut}>
          {cut ? "Reconnect node C" : "Cut node C off"}
        </button>
      </div>
      <svg ref={root} viewBox="0 0 470 262" role="img" aria-label="A write replicating from the leader to two followers">
        <defs>
          <pattern id="hero-grid" width="20" height="20" patternUnits="userSpaceOnUse">
            <path d="M20 0H0V20" fill="none" stroke="var(--grid)" strokeWidth="1" />
          </pattern>
        </defs>
        <rect width="470" height="262" fill="url(#hero-grid)" />
        {link(APP, A, false)}
        {link(A, B, false)}
        {link(A, C, cut)}
        {link(B, C, cut)}
        {cut ? (
          <g className="split" transform={`translate(${(A.x + C.x) / 2 + 6} ${(A.y + C.y) / 2 + 2})`}>
            <path d="M-7 -7 7 7M7 -7-7 7" />
          </g>
        ) : null}
        <g className="app" transform={`translate(${APP.x} ${APP.y})`}>
          <rect x={-40} y={-18} width={80} height={36} rx={18} />
          <text y={5}>your app</text>
        </g>
        <circle className="commit-ring" cx={A.x} cy={A.y} r={26} opacity={0} />
        <circle className="pkt p-req" r={5} opacity={0} />
        <circle className="pkt p-b" r={5} opacity={0} />
        <circle className="pkt p-c" r={5} opacity={0} />
        <circle className="pkt p-res" r={5} opacity={0} />
        {node(A, "node A", "leader", "zone a")}
        {node(B, "node B", "follower", "zone b")}
        {node(C, "node C", cut ? "unreachable" : "follower", "zone c", cut)}
        <text x={330} y={44} className="model-index">
          commit index <tspan ref={index}>1,204</tspan>
        </text>
      </svg>
      <Metrics cut={cut} />
      <OpsFeed cut={cut} />
    </div>
  );
}

const OPS = [
  { op: "PUT", key: "orders/9281", mode: "strict", res: "200", ms: 2.1 },
  { op: "GET", key: "carts/7", mode: "session", res: "200", ms: 0.4 },
  { op: "PUT", key: "likes/post-9", mode: "available", res: "202", ms: 0.3 },
  { op: "QUERY", key: "orders/ status=paid", mode: "strict", res: "idx", ms: 1.8 },
  { op: "WATCH", key: "inventory/", mode: "eventual", res: "101", ms: 0.1 },
  { op: "GET", key: "accounts/42", mode: "strict", res: "200", ms: 1.2 },
  { op: "PUT", key: "presence/u-17", mode: "available", res: "202", ms: 0.2 },
  { op: "GET", key: "leaderboard/today", mode: "bounded", res: "200", ms: 0.6 },
];

type Row = (typeof OPS)[number] & { id: number };

/** A simulated stream of requests, each with its own consistency mode. */
function OpsFeed({ cut }: { cut: boolean }) {
  const reduced = useReducedMotion();
  const [rows, setRows] = useState<Row[]>(() => OPS.slice(0, 4).map((o, i) => ({ ...o, id: i })));
  const next = useRef(4);
  useEffect(() => {
    if (reduced) return;
    const t = setInterval(() => {
      const base = OPS[next.current % OPS.length]!;
      const jitter = 0.75 + Math.random() * 0.5;
      const row: Row = {
        ...base,
        id: next.current,
        ms: Math.round(base.ms * jitter * (cut && base.mode === "strict" ? 1.6 : 1) * 10) / 10,
      };
      next.current += 1;
      setRows((r) => [row, ...r].slice(0, 4));
    }, 1100);
    return () => clearInterval(t);
  }, [cut, reduced]);
  return (
    <div className="feed" aria-hidden="true">
      {rows.map((r) => (
        <div key={r.id} className="feed-row">
          <span className="feed-op">{r.op}</span>
          <span className="feed-key">{r.key}</span>
          <span className={`feed-mode m-${r.mode}`}>{r.mode}</span>
          <span className={`feed-res ${r.res === "202" ? "warn" : ""}`}>{r.res}</span>
          <span className="feed-ms">{r.ms.toFixed(1)} ms</span>
        </div>
      ))}
    </div>
  );
}

function Metrics({ cut }: { cut: boolean }) {
  const reduced = useReducedMotion();
  const [ops, setOps] = useState(48210);
  useEffect(() => {
    if (reduced) return;
    const t = setInterval(() => setOps(46000 + Math.round(Math.random() * 4500)), 1000);
    return () => clearInterval(t);
  }, [reduced]);
  return (
    <div className="metrics">
      <div>
        <span className="metric-label">ops / s</span>
        <span className="metric-value">{ops.toLocaleString("en-US")}</span>
      </div>
      <div>
        <span className="metric-label">p99 write</span>
        <span className="metric-value">{cut ? "3.4" : "2.2"} ms</span>
      </div>
      <div>
        <span className="metric-label">replicas</span>
        <span className={`metric-value ${cut ? "warn" : "ok"}`}>{cut ? "2 / 3" : "3 / 3"}</span>
      </div>
      <div>
        <span className="metric-label">quorum</span>
        <span className="metric-value ok">held</span>
      </div>
    </div>
  );
}

export function Hero() {
  const ref = useRef<HTMLElement>(null);
  useGSAP(
    () => {
      if (!ref.current) return;
      gsap.from(ref.current.querySelectorAll(".hero-copy > *, .model"), {
        y: 18,
        opacity: 0,
        duration: 0.9,
        stagger: 0.08,
        ease: "power3.out",
        delay: 0.1,
      });
    },
    { scope: ref },
  );
  return (
    <section id="top" ref={ref} className="hero" data-theme="dark">
      <div className="container hero-grid">
        <div className="hero-copy">
          <p className="eyebrow">Distributed JSON database</p>
          <h1>
            One database.
            <br />
            <span className="h1-accent">Every consistency.</span>
          </h1>
          <p className="hero-sub">Strict or available, chosen per request. One cluster, no trade-off baked in.</p>
          <div className="hero-ctas">
            <a className="btn btn-primary" href="#start" onClick={jump("start")}>
              Get started
            </a>
            <a className="btn btn-ghost" href="#cap" onClick={jump("cap")}>
              How it handles CAP
            </a>
          </div>
          <div className="hero-meta">
            <a href={REPO}>
              <GitHubIcon /> vinitpatil519/CelerisDB
            </a>
            <span>Apache-2.0</span>
            <a href={DOC("DECISIONS.md")}>35 design records</a>
          </div>
        </div>
        <ClusterModel />
      </div>
    </section>
  );
}
