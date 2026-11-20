/**
 * Human / AI audience toggle.
 *
 * Two switches drive one piece of state: a dock at the bottom of the hero
 * (it hides once the visitor scrolls down) and a small floating switch in the
 * top-left corner that is always there. Switching to "AI" opens AgentView, a
 * full-screen reader for /agents.md, revealed by a circle that grows out of
 * the switch that was pressed. Switching back shrinks it into that switch.
 */

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
  type RefObject,
} from "react";

import { gsap, prefersReducedMotion, useGSAP } from "../motion";

export type Audience = "human" | "ai";
type Point = { x: number; y: number };

interface AudienceState {
  mode: Audience;
  /** Change mode; `from` is the element the reveal animation grows out of. */
  setMode: (mode: Audience, from?: Element | null) => void;
  origin: RefObject<Point>;
}

const AudienceContext = createContext<AudienceState | null>(null);

export function useAudience(): AudienceState {
  const ctx = useContext(AudienceContext);
  if (!ctx) throw new Error("useAudience must be used inside <AudienceProvider>");
  return ctx;
}

const HASH = "#agents";
const AGENTS_URL = `${import.meta.env.BASE_URL}agents.md`;

export function AudienceProvider({ children }: { children: ReactNode }) {
  const [mode, setModeState] = useState<Audience>(() =>
    typeof location !== "undefined" && location.hash === HASH ? "ai" : "human",
  );
  const origin = useRef<Point>({ x: 40, y: 100 });

  const setMode = useCallback((next: Audience, from?: Element | null) => {
    if (from) {
      const r = from.getBoundingClientRect();
      origin.current = { x: r.left + r.width / 2, y: r.top + r.height / 2 };
    }
    setModeState(next);
    const url = location.pathname + location.search + (next === "ai" ? HASH : "");
    history.replaceState(null, "", url);
  }, []);

  const value = useMemo(() => ({ mode, setMode, origin }), [mode, setMode]);
  return <AudienceContext.Provider value={value}>{children}</AudienceContext.Provider>;
}

/* ── Switch ───────────────────────────────────────────────────────────── */

function PersonIcon() {
  return (
    <svg viewBox="0 0 16 16" width="14" height="14" aria-hidden="true">
      <circle cx="8" cy="5" r="2.75" fill="none" stroke="currentColor" strokeWidth="1.5" />
      <path d="M2.75 14c.6-2.9 2.6-4.5 5.25-4.5s4.65 1.6 5.25 4.5" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
    </svg>
  );
}

function SparkIcon() {
  return (
    <svg viewBox="0 0 16 16" width="14" height="14" aria-hidden="true">
      <path
        d="M8 1.5 9.4 6.6 14.5 8 9.4 9.4 8 14.5 6.6 9.4 1.5 8 6.6 6.6Z"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.4"
        strokeLinejoin="round"
      />
    </svg>
  );
}

/** Segmented pill with a thumb that slides and squashes on change. */
function AudienceSwitch({ size }: { size: "lg" | "sm" }) {
  const { mode, setMode } = useAudience();
  const root = useRef<HTMLDivElement>(null);
  const thumb = useRef<HTMLSpanElement>(null);
  const first = useRef(true);

  useGSAP(
    () => {
      const el = thumb.current;
      if (!el) return;
      const x = mode === "ai" ? 100 : 0;
      if (first.current || prefersReducedMotion()) {
        gsap.set(el, { xPercent: x });
        first.current = false;
        return;
      }
      gsap.to(el, { xPercent: x, duration: 0.55, ease: "back.out(1.7)", overwrite: "auto" });
      gsap.fromTo(el, { scaleX: 1.35, scaleY: 0.82 }, { scaleX: 1, scaleY: 1, duration: 0.7, ease: "elastic.out(1, 0.45)" });
      // A pulse ring from the active segment.
      const ring = root.current?.querySelector<HTMLElement>(".aud-ring");
      if (ring) {
        gsap.fromTo(
          ring,
          { xPercent: x, scale: 1, opacity: 0.7 },
          { scale: 1.9, opacity: 0, duration: 0.7, ease: "power2.out" },
        );
      }
    },
    { scope: root, dependencies: [mode] },
  );

  const pick = (next: Audience) => (e: React.MouseEvent<HTMLButtonElement>) => {
    if (next !== mode) setMode(next, e.currentTarget);
  };

  const onKey = (e: React.KeyboardEvent) => {
    if (e.key === "ArrowLeft" || e.key === "ArrowRight") {
      e.preventDefault();
      const next = e.key === "ArrowRight" ? "ai" : "human";
      const btn = root.current?.querySelector<HTMLButtonElement>(`[data-value="${next}"]`);
      btn?.focus();
      if (next !== mode) setMode(next, btn);
    }
  };

  return (
    <div
      ref={root}
      className={`aud-switch aud-${size} is-${mode}`}
      role="radiogroup"
      aria-label="Who is reading this page"
      onKeyDown={onKey}
    >
      <span className="aud-ring" aria-hidden="true" />
      <span ref={thumb} className="aud-thumb" aria-hidden="true" />
      {(["human", "ai"] as const).map((v) => (
        <button
          key={v}
          type="button"
          role="radio"
          data-value={v}
          aria-checked={mode === v}
          tabIndex={mode === v ? 0 : -1}
          className="aud-opt"
          onClick={pick(v)}
        >
          {v === "human" ? <PersonIcon /> : <SparkIcon />}
          <span>{v === "human" ? "Human" : "AI"}</span>
        </button>
      ))}
    </div>
  );
}

/** Bottom dock on the hero. Hides once the visitor scrolls down. */
export function AudienceDock() {
  const { mode } = useAudience();
  const [hidden, setHidden] = useState(false);
  useEffect(() => {
    const onScroll = () => setHidden(scrollY > innerHeight * 0.3);
    onScroll();
    addEventListener("scroll", onScroll, { passive: true });
    return () => removeEventListener("scroll", onScroll);
  }, []);
  const away = hidden || mode === "ai";
  return (
    <div className={`aud-dock ${away ? "is-away" : ""}`} aria-hidden={away} inert={away}>
      <span className="aud-dock-label">Reading as</span>
      <AudienceSwitch size="lg" />
      <span className="aud-dock-hint">AI gets a full guide for your coding agent</span>
    </div>
  );
}

/** Floating top-left switch, present the whole time. */
export function AudienceFloat() {
  return (
    <div className="aud-float">
      <AudienceSwitch size="sm" />
    </div>
  );
}

/* ── Agent view ───────────────────────────────────────────────────────── */

type Line = { kind: string; text: string; level?: number; id?: string };

const slug = (s: string) =>
  s
    .toLowerCase()
    .replace(/[`*]/g, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "");

/** Line-level markdown classification for a raw, highlighted view. */
function classify(md: string): Line[] {
  let fenced = false;
  return md.split("\n").map((text) => {
    if (text.startsWith("```")) {
      fenced = !fenced;
      return { kind: "fence", text };
    }
    if (fenced) return { kind: "code", text };
    const h = /^(#{1,6})\s+(.*)$/.exec(text);
    if (h) return { kind: "h", text, level: h[1]!.length, id: slug(h[2]!) };
    if (text.startsWith(">")) return { kind: "quote", text };
    if (text.startsWith("|")) return { kind: "table", text };
    if (/^---+$/.test(text)) return { kind: "hr", text };
    if (/^\s*- \[[ x]\]/.test(text)) return { kind: "check", text };
    if (/^\s*([-*]|\d+\.)\s/.test(text)) return { kind: "li", text };
    return { kind: "p", text };
  });
}

/** Inline `code`, **bold** and [links](url), keeping the markdown syntax visible. */
function Inline({ text }: { text: string }) {
  const parts = text.split(/(`[^`]+`|\*\*[^*]+\*\*|\[[^\]]+\]\([^)]+\)|https?:\/\/[^\s)]+)/g);
  return (
    <>
      {parts.map((p, i) => {
        if (!p) return null;
        if (p.startsWith("`")) return <span key={i} className="md-ic">{p}</span>;
        if (p.startsWith("**")) return <strong key={i}>{p}</strong>;
        if (p.startsWith("[")) {
          const m = /^\[([^\]]+)\]\(([^)]+)\)$/.exec(p)!;
          return (
            <span key={i} className="md-link">
              [{m[1]}](<a href={m[2]}>{m[2]}</a>)
            </span>
          );
        }
        if (p.startsWith("http")) {
          return (
            <a key={i} className="md-url" href={p}>
              {p}
            </a>
          );
        }
        return p;
      })}
    </>
  );
}

function MdLine({ line }: { line: Line }) {
  const cls = `md-line md-${line.kind}${line.level ? ` md-h${line.level}` : ""}`;
  if (line.kind === "code" || line.kind === "fence") return <span className={cls}>{line.text || " "}</span>;
  return (
    <span className={cls} id={line.kind === "h" ? `md-${line.id}` : undefined}>
      {line.text ? <Inline text={line.text} /> : " "}
    </span>
  );
}

const PROMPT = `Use CelerisDB as the database. Before writing code, read https://celerisdb.runs-at.dev/agents.md completely and follow it. Use the official SDK for this project's language. Choose and justify a consistency mode for every read and write. Never treat an unknown write outcome as a failure. Run the checklist in section 16 before you finish.`;

function useCopy(): [string | null, (id: string, text: string) => void] {
  const [copied, setCopied] = useState<string | null>(null);
  const timer = useRef<ReturnType<typeof setTimeout>>(undefined);
  const copy = useCallback((id: string, text: string) => {
    navigator.clipboard?.writeText(text).then(
      () => {
        setCopied(id);
        clearTimeout(timer.current);
        timer.current = setTimeout(() => setCopied(null), 1600);
      },
      () => setCopied(null),
    );
  }, []);
  return [copied, copy];
}

type Lenis = { stop(): void; start(): void };
const lenis = () => (window as unknown as { __lenis?: Lenis }).__lenis;

export function AgentView() {
  const { mode, setMode, origin } = useAudience();
  const root = useRef<HTMLDivElement>(null);
  const body = useRef<HTMLDivElement>(null);
  const title = useRef<HTMLSpanElement>(null);
  const tl = useRef<gsap.core.Timeline | null>(null);
  const opened = useRef(false);
  // Arrived through a #agents link: show the guide at once, no reveal.
  const deepLinked = useRef(typeof location !== "undefined" && location.hash === HASH);
  const [md, setMd] = useState<string | null>(null);
  const [failed, setFailed] = useState(false);
  const [copied, copy] = useCopy();
  const open = mode === "ai";

  // Fetch early (idle) so the file is ready by the time someone switches.
  useEffect(() => {
    let alive = true;
    const load = () =>
      fetch(AGENTS_URL)
        .then((r) => (r.ok ? r.text() : Promise.reject(new Error(String(r.status)))))
        .then((t) => alive && setMd(t))
        .catch(() => alive && setFailed(true));
    const t = setTimeout(load, open ? 0 : 1200);
    return () => {
      alive = false;
      clearTimeout(t);
    };
    // Only on mount; `open` just picks the delay.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const lines = useMemo(() => (md ? classify(md) : []), [md]);
  const toc = useMemo(() => lines.filter((l) => l.kind === "h" && l.level === 2), [lines]);
  const stats = useMemo(
    () => (md ? { lines: lines.length, kb: (new Blob([md]).size / 1024).toFixed(1) } : null),
    [md, lines],
  );

  // Reveal / hide animation.
  useEffect(() => {
    const el = root.current;
    if (!el) return;
    tl.current?.kill();
    const { x, y } = origin.current;
    const r = Math.hypot(Math.max(x, innerWidth - x), Math.max(y, innerHeight - y)) + 24;
    const at = (radius: number) => `circle(${radius}px at ${x}px ${y}px)`;
    const reduced = prefersReducedMotion();
    const scan = el.querySelector<HTMLElement>(".av-scan");
    const glyphs = "01<>/{}[]#*_$";

    if (open) {
      lenis()?.stop();
      document.documentElement.classList.add("av-lock");
      el.querySelector<HTMLElement>(".av-scroll")?.scrollTo(0, 0);
      const firstOpen = !opened.current && deepLinked.current;
      opened.current = true;
      if (reduced || firstOpen) {
        gsap.set(el, { visibility: "visible", clipPath: "none", opacity: 1 });
        return;
      }
      const t = gsap.timeline();
      t.set(el, { visibility: "visible", opacity: 1 })
        .fromTo(el, { clipPath: at(0) }, { clipPath: at(r), duration: 0.95, ease: "expo.inOut" }, 0)
        .set(el, { clipPath: "none" });
      if (scan) {
        t.fromTo(
          scan,
          { y: 0, opacity: 1 },
          { y: innerHeight, duration: 0.9, ease: "power2.inOut" },
          0.25,
        ).to(scan, { opacity: 0, duration: 0.2 }, ">-0.1");
      }
      if (title.current) {
        t.to(
          title.current,
          { duration: 0.9, scrambleText: { text: "agents.md", chars: glyphs, speed: 0.7 } },
          0.35,
        );
      }
      const rows = Array.from(el.querySelectorAll(".md-line")).slice(0, 80);
      if (rows.length) {
        t.fromTo(
          rows,
          { opacity: 0, x: -12 },
          { opacity: 1, x: 0, duration: 0.45, stagger: 0.006, ease: "power2.out", clearProps: "transform,opacity" },
          0.45,
        );
      }
      t.fromTo(
        el.querySelectorAll(".av-bar > *, .av-toc"),
        { opacity: 0, y: -8 },
        { opacity: 1, y: 0, duration: 0.5, stagger: 0.05, ease: "power3.out", clearProps: "transform,opacity" },
        0.4,
      );
      tl.current = t;
    } else {
      lenis()?.start();
      document.documentElement.classList.remove("av-lock");
      if (!opened.current) {
        gsap.set(el, { visibility: "hidden" });
        return;
      }
      if (reduced) {
        gsap.set(el, { visibility: "hidden" });
        return;
      }
      const t = gsap.timeline({ onComplete: () => gsap.set(el, { visibility: "hidden" }) });
      t.set(el, { clipPath: at(r) }).to(el, { clipPath: at(0), duration: 0.75, ease: "expo.inOut" });
      tl.current = t;
    }
  }, [open, origin]);

  // While open: Esc returns to the human view, the page behind is inert.
  useEffect(() => {
    if (!open) return;
    const behind = document.querySelectorAll<HTMLElement>("body > #root > :not(.av):not(.aud-float):not(.aud-dock)");
    behind.forEach((n) => (n.inert = true));
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setMode("human", document.querySelector(".aud-float [data-value='human']"));
    };
    addEventListener("keydown", onKey);
    body.current?.focus({ preventScroll: true });
    return () => {
      behind.forEach((n) => (n.inert = false));
      removeEventListener("keydown", onKey);
    };
  }, [open, setMode]);

  const goto = (id: string) => (e: React.MouseEvent) => {
    e.preventDefault();
    document.getElementById(`md-${id}`)?.scrollIntoView({ behavior: prefersReducedMotion() ? "auto" : "smooth", block: "start" });
  };

  return (
    <div
      ref={root}
      className="av"
      data-theme="dark"
      role="region"
      aria-label="CelerisDB guide for coding agents"
      aria-hidden={!open}
      style={{ visibility: "hidden" }}
    >
      <div className="av-scan" aria-hidden="true" />
      <div className="av-scroll" data-lenis-prevent>
        <div className="av-wrap">
          <header className="av-bar">
            <div className="av-file">
              <span className="av-dots" aria-hidden="true">
                <i />
                <i />
                <i />
              </span>
              <span ref={title} className="av-name">
                agents.md
              </span>
              {stats ? (
                <span className="av-meta">
                  {stats.lines} lines · {stats.kb} KB · text/markdown
                </span>
              ) : null}
            </div>
            <div className="av-actions">
              <button type="button" className="av-btn av-btn-primary" disabled={!md} onClick={() => md && copy("md", md)}>
                {copied === "md" ? "Copied" : "Copy markdown"}
              </button>
              <button type="button" className="av-btn" onClick={() => copy("prompt", PROMPT)}>
                {copied === "prompt" ? "Copied" : "Copy agent prompt"}
              </button>
              <a className="av-btn" href={AGENTS_URL} download="celeris-agents.md">
                Download
              </a>
              <a className="av-btn" href={AGENTS_URL} target="_blank" rel="noreferrer">
                Raw
              </a>
            </div>
          </header>

          <p className="av-cmd">
            <span className="av-prompt">$</span> curl -s https://celerisdb.runs-at.dev/agents.md
            <span className="av-caret" aria-hidden="true" />
          </p>

          <div className="av-grid">
            {toc.length ? (
              <nav className="av-toc" aria-label="Sections">
                <span className="av-toc-title">Sections</span>
                {toc.map((h) => (
                  <a key={h.id} href={`#md-${h.id}`} onClick={goto(h.id!)}>
                    {h.text.replace(/^##\s+/, "")}
                  </a>
                ))}
              </nav>
            ) : null}
            <div ref={body} className="av-body" tabIndex={-1}>
              {failed ? (
                <p className="av-empty">
                  Could not load the guide. Open <a href={AGENTS_URL}>agents.md</a> directly.
                </p>
              ) : !md ? (
                <p className="av-empty">Loading agents.md…</p>
              ) : (
                <pre className="md">
                  {lines.map((l, i) => (
                    <MdLine key={i} line={l} />
                  ))}
                </pre>
              )}
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
