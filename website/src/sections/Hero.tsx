import { useEffect, useMemo, useRef, useState } from "react";

import { Badge, Defs, Node, Wire, curve } from "../components/diagram";
import { CodeBlock, Magnetic } from "../components/ui";
import { ARCHITECTURE, INSTALL } from "../data/site";
import { gsap, jump, SplitText, useGSAP, useReducedMotion } from "../motion";

/* ------------------------------------------------------------------ */
/* Live cluster: a small simulation that keeps the hero visibly alive. */
/* ------------------------------------------------------------------ */

const NODES = [
  { id: "node-a", zone: "ap-south-1a", x: 300, y: 70 },
  { id: "node-b", zone: "ap-south-1b", x: 452, y: 168 },
  { id: "node-c", zone: "ap-south-1c", x: 300, y: 266 },
] as const;
const CLIENT: [number, number] = [86, 168];

type Mode = "strict" | "session" | "available" | "eventual";

interface LogRow {
  id: number;
  at: string;
  verb: "PUT" | "GET" | "DEL";
  key: string;
  mode: Mode;
  ms: string;
  note: string;
  tone: "ok" | "warn" | "info" | "bad";
}

const KEYS = ["orders/9281", "users/42", "carts/7", "likes/77", "sessions/q8", "inventory/sku-3", "feeds/home"];
const MODES: Mode[] = ["strict", "strict", "session", "available", "eventual"];

function clock(): string {
  const d = new Date();
  return `${d.toTimeString().slice(0, 8)}.${String(d.getMilliseconds()).padStart(3, "0")}`;
}

function useCluster(running: boolean) {
  const [leader, setLeader] = useState(0);
  const [down, setDown] = useState<number | null>(null);
  const [electing, setElecting] = useState(false);
  const [term, setTerm] = useState(7);
  const [rows, setRows] = useState<LogRow[]>([]);
  const [ops, setOps] = useState(8420);
  const [p99, setP99] = useState(3.8);
  const seq = useRef(0);
  const state = useRef({ leader: 0, down: null as number | null, electing: false });
  state.current = { leader, down, electing };

  const push = (row: Omit<LogRow, "id" | "at">) =>
    setRows((r) => [{ ...row, id: seq.current++, at: clock() }, ...r].slice(0, 7));

  // Request traffic.
  useEffect(() => {
    if (!running) return;
    const t = setInterval(() => {
      const { electing: e } = state.current;
      const mode = MODES[Math.floor(Math.random() * MODES.length)]!;
      const key = KEYS[Math.floor(Math.random() * KEYS.length)]!;
      const write = mode !== "eventual" && Math.random() < 0.65;
      const verb = write ? (Math.random() < 0.9 ? "PUT" : "DEL") : "GET";
      if (e && mode === "strict") {
        push({ verb, key, mode, ms: "—", note: "waiting for quorum", tone: "warn" });
      } else if (e && mode === "available" && write) {
        push({ verb, key, mode, ms: "0.3ms", note: "accepted locally", tone: "info" });
      } else {
        const base = mode === "strict" ? 1.6 : mode === "session" ? 0.9 : 0.35;
        const ms = (base + Math.random() * base).toFixed(1);
        const note = write
          ? mode === "available"
            ? "replicated · 202"
            : `committed · v${4180 + seq.current}`
          : mode === "eventual"
            ? "nearest replica"
            : "read barrier ✓";
        push({ verb, key, mode, ms: `${ms}ms`, note, tone: "ok" });
      }
      setOps(Math.round(8200 + Math.random() * 600 - (e ? 2400 : 0)));
      setP99(+(3.2 + Math.random() * 1.4 + (e ? 4 : 0)).toFixed(1));
    }, 520);
    return () => clearInterval(t);
  }, [running]);

  // Failure drill: every ~10 s the leader dies, a new one is elected, the old node returns.
  useEffect(() => {
    if (!running) return;
    const timers: ReturnType<typeof setTimeout>[] = [];
    const cycle = () => {
      const failing = state.current.leader;
      setDown(failing);
      setElecting(true);
      push({ verb: "PUT", key: `raft/${NODES[failing]!.id}`, mode: "strict", ms: "—", note: "leader unreachable", tone: "bad" });
      timers.push(
        setTimeout(() => {
          const next = (failing + 1) % NODES.length;
          setLeader(next);
          setTerm((t) => t + 1);
          setElecting(false);
          push({ verb: "PUT", key: `raft/${NODES[next]!.id}`, mode: "strict", ms: "612ms", note: "elected leader", tone: "ok" });
        }, 1500),
        setTimeout(() => setDown(null), 4200),
      );
    };
    const loop = setInterval(cycle, 10000);
    timers.push(setTimeout(cycle, 4500));
    return () => {
      clearInterval(loop);
      timers.forEach(clearTimeout);
    };
  }, [running]);

  return { leader, down, electing, term, rows, ops, p99 };
}

function LiveCluster() {
  const reduced = useReducedMotion();
  const { leader, down, electing, term, rows, ops, p99 } = useCluster(!reduced);
  const L = NODES[leader]!;
  const followers = NODES.map((n, i) => ({ ...n, i })).filter((n) => n.i !== leader);
  const id = "hero";

  const wires = useMemo(
    () => ({
      client: curve(CLIENT, [L.x - 32, L.y], 0.55),
      repl: followers.map((f) => curve([L.x, L.y], [f.x, f.y], 0.5)),
    }),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [leader],
  );

  return (
    <div className="console" role="img" aria-label="A live three-node Celeris cluster: requests stream in, the leader fails, a new leader is elected and traffic continues.">
      <div className="console-bar">
        <span className="code-dots" aria-hidden="true">
          <i />
          <i />
          <i />
        </span>
        <span className="console-title mono">celeris · prod-ap-south · RF3</span>
        <span className={`live ${electing ? "is-warn" : ""}`}>{electing ? "electing" : "live"}</span>
      </div>
      <div className="console-body">
        <svg viewBox="0 0 540 330" className="console-svg" aria-hidden="true">
          <Defs id={id} />
          <rect width="540" height="330" fill={`url(#${id}-grid)`} />
          {NODES.map((a, i) =>
            NODES.slice(i + 1).map((b) => (
              <Wire
                key={`${a.id}-${b.id}`}
                d={curve([a.x, a.y], [b.x, b.y], 0.5)}
                tone="dim"
                comet={false}
                broken={down !== null && (NODES[down]!.id === a.id || NODES[down]!.id === b.id)}
              />
            )),
          )}
          {!electing ? (
            <>
              <Wire key={`c-${leader}`} d={wires.client} tone="cyan" speed={1.4} glow={id} />
              {wires.repl.map((d, i) => (
                <Wire key={`r-${leader}-${i}`} d={d} tone="cyan" speed={1.4} delay={0.5 + i * 0.1} glow={id} flow={false} />
              ))}
              {wires.repl.map((d, i) => (
                <Wire key={`a-${leader}-${i}`} d={d} tone="green" speed={1.4} delay={1.1 + i * 0.1} glow={id} flow={false} reverse />
              ))}
            </>
          ) : null}
          <g className="d-client" transform={`translate(${CLIENT[0]} ${CLIENT[1]})`}>
            <rect x={-46} y={-20} width={92} height={40} rx={10} />
            <text y={-2} textAnchor="middle" className="d-label">
              your app
            </text>
            <text y={12} textAnchor="middle" className="d-sub">
              @celeris/client
            </text>
          </g>
          {NODES.map((n, i) => (
            <Node
              key={n.id}
              x={n.x}
              y={n.y}
              label={n.id}
              sub={down === i ? "unreachable" : i === leader && !electing ? `leader · term ${term}` : "follower"}
              tone={down === i ? "red" : i === leader && !electing ? "cyan" : "dim"}
              leader={i === leader && !electing}
              dim={down === i}
              glow={id}
            />
          ))}
          {electing ? <Badge x={386} y={30} text="ELECTION · PRE-VOTE" tone="amber" /> : <Badge x={386} y={30} text="QUORUM 2/3 ✓" tone="green" />}
        </svg>
        <div className="console-metrics">
          <div>
            <span className="metric-label">writes / s</span>
            <span className="metric-value tabular">{ops.toLocaleString("en-US")}</span>
          </div>
          <div>
            <span className="metric-label">p99</span>
            <span className={`metric-value tabular ${p99 > 6 ? "warn" : ""}`}>{p99} ms</span>
          </div>
          <div>
            <span className="metric-label">raft term</span>
            <span className="metric-value tabular">{term}</span>
          </div>
          <div>
            <span className="metric-label">acked writes lost</span>
            <span className="metric-value tabular ok">0</span>
          </div>
        </div>
      </div>
      <ol className="console-log mono" aria-hidden="true">
        {rows.map((r) => (
          <li key={r.id} className={`row tone-${r.tone}`}>
            <span className="t">{r.at}</span>
            <span className={`verb verb-${r.verb}`}>{r.verb}</span>
            <span className="k">{r.key}</span>
            <span className={`mode mode-${r.mode}`}>{r.mode}</span>
            <span className="ms">{r.ms}</span>
            <span className="note">{r.note}</span>
          </li>
        ))}
      </ol>
    </div>
  );
}

/* ------------------------------------------------------------------ */

export function Hero() {
  const ref = useRef<HTMLElement>(null);
  const reduced = useReducedMotion();

  useGSAP(
    () => {
      if (reduced) return;
      const title = ref.current?.querySelector(".hero-title");
      if (!title) return;
      const split = SplitText.create(title, { type: "words,chars", mask: "words", wordsClass: "word", charsClass: "char" });
      title.classList.add("is-split");
      const tl = gsap.timeline({ defaults: { ease: "expo.out" } });
      tl.from(".hero .eyebrow", { y: 16, opacity: 0, duration: 0.8 })
        .from(split.chars, { yPercent: 120, duration: 1.1, stagger: 0.012 }, "-=0.5")
        .from(".hero-lede, .hero-ctas, .hero-install", { y: 24, opacity: 0, filter: "blur(8px)", duration: 1, stagger: 0.1 }, "-=0.7")
        .from(".console", { y: 40, opacity: 0, scale: 0.97, duration: 1.4 }, "-=1.1");
      gsap.to(".console", {
        yPercent: -8,
        rotateX: 6,
        ease: "none",
        scrollTrigger: { trigger: ref.current, start: "top top", end: "bottom top", scrub: true },
      });
      gsap.to(".hero-copy", {
        yPercent: -14,
        opacity: 0.2,
        ease: "none",
        scrollTrigger: { trigger: ref.current, start: "top top", end: "bottom top", scrub: true },
      });
    },
    { scope: ref, dependencies: [reduced] },
  );

  return (
    <section id="top" ref={ref} className="hero" aria-labelledby="hero-title">
      <div className="hero-aurora" aria-hidden="true" />
      <div className="hero-grid" aria-hidden="true" />
      <div className="container hero-inner">
        <div className="hero-copy">
          <a className="eyebrow eyebrow-link" href={ARCHITECTURE}>
            <span className="eyebrow-tag">New</span>
            Group commit · 8.5k fsynced writes/s per node
            <span aria-hidden="true">→</span>
          </a>
          <h1 id="hero-title" className="hero-title">
            The database where every request <em>chooses</em> its tradeoff.
          </h1>
          <p className="hero-lede">
            Celeris is an open-source distributed key-value and document store. Strict when money moves, available when
            the network splits, realtime everywhere — one cluster, five consistency modes, chosen per operation.
          </p>
          <div className="hero-ctas">
            <Magnetic className="btn btn-primary" href="#start" onClick={jump("start")}>
              Start a cluster
              <span aria-hidden="true" className="btn-arrow">
                →
              </span>
            </Magnetic>
            <Magnetic className="btn btn-ghost" href="#journey" onClick={jump("journey")}>
              See how it works
            </Magnetic>
          </div>
          <CodeBlock className="hero-install" code={INSTALL.docker} label="Run a node" />
        </div>
        <LiveCluster />
      </div>
    </section>
  );
}
