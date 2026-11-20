/**
 * Human / AI audience toggle.
 *
 * Two switches drive one piece of state: one at the bottom of the hero (it
 * hides once the visitor scrolls down) and one in the top-left corner that is
 * always on screen. Choosing "AI" opens AgentView, the Markdown guide for
 * coding agents (/agents.md) rendered as a document, revealed from the switch
 * that was pressed.
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
  /** Change mode; `from` is the element the reveal grows out of. */
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
const AGENTS_ABS = "https://celerisdb.runs-at.dev/agents.md";

export function AudienceProvider({ children }: { children: ReactNode }) {
  const [mode, setModeState] = useState<Audience>(() =>
    typeof location !== "undefined" && location.hash === HASH ? "ai" : "human",
  );
  const origin = useRef<Point>({ x: 60, y: 100 });

  const setMode = useCallback((next: Audience, from?: Element | null) => {
    if (from) {
      const r = from.getBoundingClientRect();
      origin.current = { x: r.left + r.width / 2, y: r.top + r.height / 2 };
    }
    setModeState(next);
    history.replaceState(null, "", location.pathname + location.search + (next === "ai" ? HASH : ""));
  }, []);

  const value = useMemo(() => ({ mode, setMode, origin }), [mode, setMode]);
  return <AudienceContext.Provider value={value}>{children}</AudienceContext.Provider>;
}

/* ── Switch ───────────────────────────────────────────────────────────── */

/** Light or dark, from the section under `el`, the same way the nav decides. */
function useThemeUnder(el: RefObject<HTMLElement | null>): "dark" | "light" {
  const [theme, setTheme] = useState<"dark" | "light">("dark");
  useEffect(() => {
    const check = () => {
      const box = el.current?.getBoundingClientRect();
      if (!box) return;
      const under = document
        .elementsFromPoint(box.left + box.width / 2, box.top + box.height / 2)
        .find((n) => !el.current?.contains(n) && n.closest("[data-theme]"));
      setTheme(under?.closest("[data-theme]")?.getAttribute("data-theme") === "light" ? "light" : "dark");
    };
    check();
    addEventListener("scroll", check, { passive: true });
    addEventListener("resize", check);
    addEventListener("audience-change", check);
    return () => {
      removeEventListener("scroll", check);
      removeEventListener("resize", check);
      removeEventListener("audience-change", check);
    };
  }, [el]);
  return theme;
}

function AudienceSwitch({ size, theme }: { size: "md" | "sm"; theme: "dark" | "light" }) {
  const { mode, setMode } = useAudience();
  const root = useRef<HTMLDivElement>(null);
  const thumb = useRef<HTMLSpanElement>(null);
  const first = useRef(true);

  useGSAP(
    () => {
      if (!thumb.current) return;
      const x = mode === "ai" ? 100 : 0;
      if (first.current || prefersReducedMotion()) {
        gsap.set(thumb.current, { xPercent: x });
        first.current = false;
        return;
      }
      gsap.to(thumb.current, { xPercent: x, duration: 0.32, ease: "power3.out", overwrite: "auto" });
    },
    { scope: root, dependencies: [mode] },
  );

  const choose = (next: Audience, from: Element | null) => {
    if (next !== mode) setMode(next, from);
  };

  const onKey = (e: React.KeyboardEvent) => {
    if (e.key !== "ArrowLeft" && e.key !== "ArrowRight") return;
    e.preventDefault();
    const next: Audience = e.key === "ArrowRight" ? "ai" : "human";
    const btn = root.current?.querySelector<HTMLButtonElement>(`[data-value="${next}"]`) ?? null;
    btn?.focus();
    choose(next, btn);
  };

  return (
    <div
      ref={root}
      className={`aud-switch aud-${size} aud-on-${theme}`}
      role="radiogroup"
      aria-label="Show this site for"
      onKeyDown={onKey}
    >
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
          onClick={(e) => choose(v, e.currentTarget)}
        >
          {v === "human" ? "Human" : "AI"}
        </button>
      ))}
    </div>
  );
}

/** At the bottom of the hero. Leaves once the visitor scrolls down. */
export function AudienceDock() {
  const { mode } = useAudience();
  const [scrolled, setScrolled] = useState(false);
  useEffect(() => {
    const onScroll = () => setScrolled(scrollY > innerHeight * 0.3);
    onScroll();
    addEventListener("scroll", onScroll, { passive: true });
    return () => removeEventListener("scroll", onScroll);
  }, []);
  const away = scrolled || mode === "ai";
  return (
    <div className={`aud-dock ${away ? "is-away" : ""}`} aria-hidden={away} inert={away}>
      <AudienceSwitch size="md" theme="dark" />
      <p className="aud-dock-note">Building with a coding agent? Switch to AI for a guide it can read.</p>
    </div>
  );
}

/** Top-left corner, on screen the whole time. */
export function AudienceFloat() {
  const ref = useRef<HTMLDivElement>(null);
  const theme = useThemeUnder(ref);
  return (
    <div ref={ref} className="aud-float">
      <AudienceSwitch size="sm" theme={theme} />
    </div>
  );
}

/* ── Markdown, rendered ───────────────────────────────────────────────── */

type Block =
  | { t: "h"; level: number; text: string; id: string }
  | { t: "p"; text: string }
  | { t: "quote"; text: string }
  | { t: "code"; lang: string; text: string }
  | { t: "list"; ordered: boolean; items: { text: string; checked?: boolean }[] }
  | { t: "table"; head: string[]; rows: string[][] }
  | { t: "hr" };

const slug = (s: string) =>
  s
    .toLowerCase()
    .replace(/[`*]/g, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "");

const cells = (row: string) =>
  row
    .trim()
    .replace(/^\||\|$/g, "")
    .split(/(?<!\\)\|/)
    .map((c) => c.trim().replace(/\\\|/g, "|"));

/** Enough Markdown for agents.md: headings, paragraphs, lists, code, tables, quotes. */
function parse(md: string): Block[] {
  const lines = md.split("\n");
  const out: Block[] = [];
  let i = 0;
  while (i < lines.length) {
    const line = lines[i]!;
    if (!line.trim()) {
      i++;
      continue;
    }
    if (line.startsWith("```")) {
      const lang = line.slice(3).trim();
      const body: string[] = [];
      i++;
      while (i < lines.length && !lines[i]!.startsWith("```")) body.push(lines[i++]!);
      i++;
      out.push({ t: "code", lang, text: body.join("\n") });
      continue;
    }
    const h = /^(#{1,6})\s+(.*)$/.exec(line);
    if (h) {
      out.push({ t: "h", level: h[1]!.length, text: h[2]!, id: slug(h[2]!) });
      i++;
      continue;
    }
    if (/^---+\s*$/.test(line)) {
      out.push({ t: "hr" });
      i++;
      continue;
    }
    if (line.startsWith("|")) {
      const rows: string[][] = [];
      while (i < lines.length && lines[i]!.startsWith("|")) {
        if (!/^\|[\s:|-]+\|?\s*$/.test(lines[i]!)) rows.push(cells(lines[i]!));
        i++;
      }
      out.push({ t: "table", head: rows[0] ?? [], rows: rows.slice(1) });
      continue;
    }
    if (line.startsWith(">")) {
      const body: string[] = [];
      while (i < lines.length && lines[i]!.startsWith(">")) body.push(lines[i++]!.replace(/^>\s?/, ""));
      out.push({ t: "quote", text: body.join(" ") });
      continue;
    }
    const li = /^(\s*)([-*]|\d+\.)\s+(.*)$/.exec(line);
    if (li) {
      const ordered = /\d/.test(li[2]!);
      const items: { text: string; checked?: boolean }[] = [];
      while (i < lines.length) {
        const m = /^(\s*)([-*]|\d+\.)\s+(.*)$/.exec(lines[i]!);
        if (m) {
          const box = /^\[([ x])\]\s+(.*)$/.exec(m[3]!);
          items.push(box ? { text: box[2]!, checked: box[1] === "x" } : { text: m[3]! });
          i++;
        } else if (lines[i]!.startsWith("  ") && lines[i]!.trim() && items.length) {
          items[items.length - 1]!.text += " " + lines[i]!.trim();
          i++;
        } else break;
      }
      out.push({ t: "list", ordered, items });
      continue;
    }
    const body: string[] = [];
    while (i < lines.length && lines[i]!.trim() && !/^(```|#{1,6}\s|\||>|\s*([-*]|\d+\.)\s|---+\s*$)/.test(lines[i]!)) {
      body.push(lines[i++]!.trim());
    }
    out.push({ t: "p", text: body.join(" ") });
  }
  return out;
}

function Inline({ text }: { text: string }) {
  const parts = text.split(/(`[^`]+`|\*\*[^*]+\*\*|\[[^\]]+\]\([^)]+\)|https?:\/\/[^\s)]+)/g);
  return (
    <>
      {parts.map((p, i) => {
        if (!p) return null;
        if (p.startsWith("`")) return <code key={i}>{p.slice(1, -1)}</code>;
        if (p.startsWith("**")) return <strong key={i}>{p.slice(2, -2)}</strong>;
        const link = /^\[([^\]]+)\]\(([^)]+)\)$/.exec(p);
        if (link) return <a key={i} href={link[2]}>{link[1]}</a>;
        if (p.startsWith("http")) return <a key={i} href={p}>{p.replace(/^https:\/\//, "")}</a>;
        return p;
      })}
    </>
  );
}

function CodeBlock({ lang, text }: { lang: string; text: string }) {
  const [copied, copy] = useCopy();
  return (
    <figure className="ag-code">
      <figcaption>
        <span>{lang || "text"}</span>
        <button type="button" onClick={() => copy("c", text)}>
          {copied ? "Copied" : "Copy"}
        </button>
      </figcaption>
      <pre>
        <code>{text}</code>
      </pre>
    </figure>
  );
}

function Doc({ blocks }: { blocks: Block[] }) {
  return (
    <>
      {blocks.map((b, i) => {
        switch (b.t) {
          case "h": {
            const H = `h${Math.min(b.level, 4)}` as "h1" | "h2" | "h3" | "h4";
            return (
              <H key={i} id={`ag-${b.id}`}>
                <Inline text={b.text} />
              </H>
            );
          }
          case "p":
            return (
              <p key={i}>
                <Inline text={b.text} />
              </p>
            );
          case "quote":
            return (
              <blockquote key={i}>
                <Inline text={b.text} />
              </blockquote>
            );
          case "code":
            return <CodeBlock key={i} lang={b.lang} text={b.text} />;
          case "hr":
            return null;
          case "table":
            return (
              <div key={i} className="ag-table">
                <table>
                  <thead>
                    <tr>
                      {b.head.map((c, j) => (
                        <th key={j}>
                          <Inline text={c} />
                        </th>
                      ))}
                    </tr>
                  </thead>
                  <tbody>
                    {b.rows.map((r, j) => (
                      <tr key={j}>
                        {r.map((c, k) => (
                          <td key={k}>
                            <Inline text={c} />
                          </td>
                        ))}
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            );
          case "list": {
            const L = b.ordered ? "ol" : "ul";
            const checks = b.items.some((it) => it.checked !== undefined);
            return (
              <L key={i} className={checks ? "ag-checks" : undefined}>
                {b.items.map((it, j) => (
                  <li key={j}>
                    {checks ? <input type="checkbox" disabled checked={!!it.checked} aria-hidden="true" /> : null}
                    <Inline text={it.text} />
                  </li>
                ))}
              </L>
            );
          }
        }
      })}
    </>
  );
}

/* ── Agent view ───────────────────────────────────────────────────────── */

const PROMPT = `Use CelerisDB as the database. Before writing code, read ${AGENTS_ABS} completely and follow it. Use the official SDK for this project's language. Choose and justify a consistency mode for every read and write. Never treat an unknown write outcome as a failure. Run the checklist in section 16 before you finish.`;

function useCopy(): [string | null, (id: string, text: string) => void] {
  const [copied, setCopied] = useState<string | null>(null);
  const timer = useRef<ReturnType<typeof setTimeout>>(undefined);
  useEffect(() => () => clearTimeout(timer.current), []);
  const copy = useCallback((id: string, text: string) => {
    navigator.clipboard?.writeText(text).then(
      () => {
        setCopied(id);
        clearTimeout(timer.current);
        timer.current = setTimeout(() => setCopied(null), 1500);
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
  const scroller = useRef<HTMLDivElement>(null);
  const tl = useRef<gsap.core.Timeline | null>(null);
  const opened = useRef(false);
  const deepLinked = useRef(typeof location !== "undefined" && location.hash === HASH);
  const [md, setMd] = useState<string | null>(null);
  const [failed, setFailed] = useState(false);
  const [copied, copy] = useCopy();
  const open = mode === "ai";

  // Fetch while idle so the guide is ready before anyone switches.
  useEffect(() => {
    let alive = true;
    const t = setTimeout(
      () =>
        fetch(AGENTS_URL)
          .then((r) => (r.ok ? r.text() : Promise.reject(new Error(`HTTP ${r.status}`))))
          .then((text) => alive && setMd(text))
          .catch(() => alive && setFailed(true)),
      deepLinked.current ? 0 : 1000,
    );
    return () => {
      alive = false;
      clearTimeout(t);
    };
  }, []);

  const blocks = useMemo(() => (md ? parse(md) : []), [md]);
  // The H1 and the opening quote become the page header; the rest is the body.
  const body = useMemo(() => blocks.filter((b, i) => !(i < 3 && (b.t === "h" && b.level === 1))), [blocks]);
  const toc = useMemo(() => blocks.filter((b): b is Extract<Block, { t: "h" }> => b.t === "h" && b.level === 2), [blocks]);

  useEffect(() => {
    const el = root.current;
    if (!el) return;
    tl.current?.kill();
    const { x, y } = origin.current;
    const r = Math.hypot(Math.max(x, innerWidth - x), Math.max(y, innerHeight - y));
    const circle = (radius: number) => `circle(${radius}px at ${x}px ${y}px)`;
    const animate = !prefersReducedMotion();
    // Lets the floating switch re-read the theme under it once the view settles.
    const settled = () => dispatchEvent(new Event("audience-change"));

    if (open) {
      lenis()?.stop();
      document.documentElement.classList.add("ag-lock");
      scroller.current?.scrollTo(0, 0);
      const instant = !animate || (!opened.current && deepLinked.current);
      opened.current = true;
      gsap.set(el, { visibility: "visible" });
      if (instant) gsap.set(el, { clipPath: "none" });
      else {
        tl.current = gsap
          .timeline()
          .fromTo(el, { clipPath: circle(0) }, { clipPath: circle(r), duration: 0.6, ease: "power2.inOut" })
          .set(el, { clipPath: "none" })
          .call(settled);
      }
    } else {
      lenis()?.start();
      document.documentElement.classList.remove("ag-lock");
      const hide = () => {
        gsap.set(el, { visibility: "hidden" });
        settled();
      };
      if (!opened.current || !animate) hide();
      else {
        tl.current = gsap
          .timeline({ onComplete: hide })
          .fromTo(el, { clipPath: circle(r) }, { clipPath: circle(0), duration: 0.5, ease: "power2.inOut" });
      }
    }
    settled();
  }, [open, origin]);

  // While open: Esc goes back, and the page behind is inert.
  useEffect(() => {
    if (!open) return;
    const behind = document.querySelectorAll<HTMLElement>("#root > :not(.ag):not(.aud-float):not(.aud-dock)");
    behind.forEach((n) => (n.inert = true));
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setMode("human", document.querySelector(".aud-float [data-value='human']"));
    };
    addEventListener("keydown", onKey);
    return () => {
      behind.forEach((n) => (n.inert = false));
      removeEventListener("keydown", onKey);
    };
  }, [open, setMode]);

  const goto = (id: string) => (e: React.MouseEvent) => {
    e.preventDefault();
    document.getElementById(`ag-${id}`)?.scrollIntoView({ behavior: prefersReducedMotion() ? "auto" : "smooth" });
  };

  return (
    <div
      ref={root}
      className="ag"
      data-theme="light"
      role="region"
      aria-label="CelerisDB guide for coding agents"
      aria-hidden={!open}
      style={{ visibility: "hidden" }}
    >
      <div ref={scroller} className="ag-scroll" data-lenis-prevent>
        <header className="ag-head">
          <div className="ag-head-inner">
            <h1>Guide for coding agents</h1>
            <p className="ag-lede">
              Everything an agent needs to build on CelerisDB, in one Markdown file: consistency modes, the HTTP API, every
              error, the four SDKs and tested patterns. Hand it to Claude Code, Cursor, Copilot or any agent that reads URLs.
            </p>
            <div className="ag-actions">
              <button type="button" className="btn btn-primary" disabled={!md} onClick={() => md && copy("md", md)}>
                {copied === "md" ? "Copied" : "Copy Markdown"}
              </button>
              <a className="btn btn-outline" href={AGENTS_URL} download="celeris-agents.md">
                Download agents.md
              </a>
              <a className="ag-raw" href={AGENTS_URL} target="_blank" rel="noreferrer">
                Open raw file
              </a>
            </div>
            <div className="ag-prompt">
              <p>Or paste this into your agent:</p>
              <div className="ag-prompt-box">
                <code>{PROMPT}</code>
                <button type="button" onClick={() => copy("prompt", PROMPT)}>
                  {copied === "prompt" ? "Copied" : "Copy"}
                </button>
              </div>
            </div>
          </div>
        </header>

        <div className="ag-main">
          {toc.length ? (
            <nav className="ag-toc" aria-label="On this page">
              <p>On this page</p>
              <ol>
                {toc.map((h) => (
                  <li key={h.id}>
                    <a href={`#ag-${h.id}`} onClick={goto(h.id)}>
                      {h.text.replace(/^\d+\.\s*/, "").replace(/`/g, "")}
                    </a>
                  </li>
                ))}
              </ol>
            </nav>
          ) : null}
          <article className="ag-doc">
            {failed ? (
              <p>
                The guide did not load. Open <a href={AGENTS_URL}>agents.md</a> directly.
              </p>
            ) : md ? (
              <Doc blocks={body} />
            ) : (
              <p className="ag-loading">Loading the guide…</p>
            )}
          </article>
        </div>
      </div>
    </div>
  );
}
