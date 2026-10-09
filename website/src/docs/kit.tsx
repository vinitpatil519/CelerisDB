/**
 * Documentation component kit. Pages are plain React: write prose with HTML
 * elements and use these components for everything richer.
 *
 * Rules for pages and demos:
 *  - Pages are rendered once to static markup for search, so never touch
 *    `window`, `document` or `navigator` during render (use effects or event
 *    handlers).
 *  - Heading ids are the in-page anchors: use <H2 id="..."> and <H3 id="...">.
 */

import { useEffect, useRef, useState, type ComponentType, type ReactNode } from "react";

import { detectOs, useOs, useStored, type Os } from "./store";

export interface DocPage {
  /** URL slug, `#/<slug>`. Must equal the file name. */
  slug: string;
  title: string;
  /** Sidebar group. */
  group: string;
  /** One sentence shown under the title and in search results. */
  summary: string;
  keywords?: string[];
  Body: ComponentType;
}

export const REPO = "https://github.com/vinitpatil519/CelerisDB";
export const RAW = "https://raw.githubusercontent.com/vinitpatil519/CelerisDB/main";
export const IMAGE = "ghcr.io/vinitpatil519/celeris:latest";

/* ── Links and headings ───────────────────────────────────────────────── */

/** Link to another docs page, optionally to a heading: `to="consistency"` or `to="consistency:modes"`. */
export function DocLink({ to, children }: { to: string; children: ReactNode }) {
  return <a href={`#/${to}`}>{children}</a>;
}

function Heading({ level, id, children }: { level: 2 | 3 | 4; id: string; children: ReactNode }) {
  const Tag = `h${level}` as "h2" | "h3" | "h4";
  return (
    <Tag id={id} className="hd">
      {children}
      <a className="hd-anchor" href={`#${id}`} aria-label="Link to this section" data-anchor={id}>
        #
      </a>
    </Tag>
  );
}
export const H2 = (p: { id: string; children: ReactNode }) => <Heading level={2} {...p} />;
export const H3 = (p: { id: string; children: ReactNode }) => <Heading level={3} {...p} />;
export const H4 = (p: { id: string; children: ReactNode }) => <Heading level={4} {...p} />;

/* ── Code ─────────────────────────────────────────────────────────────── */

export type Lang =
  | "bash"
  | "powershell"
  | "json"
  | "toml"
  | "yaml"
  | "ts"
  | "tsx"
  | "js"
  | "py"
  | "go"
  | "rust"
  | "http"
  | "dockerfile"
  | "hcl"
  | "text";

const LANG_LABEL: Record<Lang, string> = {
  bash: "bash",
  powershell: "PowerShell",
  json: "JSON",
  toml: "TOML",
  yaml: "YAML",
  ts: "TypeScript",
  tsx: "TSX",
  js: "JavaScript",
  py: "Python",
  go: "Go",
  rust: "Rust",
  http: "HTTP",
  dockerfile: "Dockerfile",
  hcl: "HCL",
  text: "text",
};

const KW: Record<string, string> = {
  ts: "await async const let var import from export function return for of in if else new class interface type extends implements true false null undefined throw try catch finally default as typeof",
  py: "await async def class import from as return for in if elif else with try except finally raise lambda pass None True False yield not and or is",
  go: "func package import return for range if else defer go chan select switch case default type struct interface map var const nil true false make err",
  rust: "fn let mut use pub struct impl enum match if else for in while loop return async await mod crate self Self true false Some None Ok Err as ref move where trait",
  bash: "if then else fi for do done in case esac function export set unset local echo cd sudo curl docker kubectl git",
  powershell: "if else foreach for while function param return $true $false $null",
  toml: "true false",
  yaml: "true false null",
  json: "true false null",
  hcl: "resource variable provider module output data locals true false",
  dockerfile: "FROM RUN COPY CMD ENTRYPOINT ENV EXPOSE WORKDIR USER VOLUME ARG ADD",
};
KW.tsx = KW.ts!;
KW.js = KW.ts!;

function escapeRe(s: string) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** A small, forgiving highlighter: comments, strings, numbers, flags and keywords. */
export function highlight(code: string, lang: Lang): ReactNode[] {
  const out: ReactNode[] = [];
  const words = (KW[lang] ?? "").split(" ").filter(Boolean);
  const kwRe = words.length ? new RegExp(`(?<![\\w$-])(${words.map(escapeRe).join("|")})(?![\\w-])`, "g") : null;
  const hashComment = ["bash", "powershell", "py", "toml", "yaml", "dockerfile", "hcl", "text"].includes(lang);
  const slashComment = ["ts", "tsx", "js", "go", "rust", "hcl"].includes(lang);
  const parts: string[] = [];
  if (slashComment) parts.push(String.raw`(?<![:\w"'])\/\/.*$`);
  if (hashComment) parts.push(String.raw`(?<![\w$"'])#.*$`);
  const comment = parts.length ? `(${parts.join("|")})` : `(?!x)x`;
  const pattern = new RegExp(
    `${comment}|("(?:[^"\\\\\\n]|\\\\.)*"|'(?:[^'\\\\\\n]|\\\\.)*'|\`(?:[^\`\\\\]|\\\\.)*\`)|(\\b\\d[\\d_.]*\\b)|((?<=\\s)--?[A-Za-z][\\w-]*)`,
    "gm",
  );
  let last = 0;
  let key = 0;
  const plain = (text: string) => {
    if (!kwRe) {
      out.push(text);
      return;
    }
    let l = 0;
    for (const m of text.matchAll(kwRe)) {
      if (m.index! > l) out.push(text.slice(l, m.index));
      out.push(
        <span key={key++} className="tk-k">
          {m[0]}
        </span>,
      );
      l = m.index! + m[0].length;
    }
    if (l < text.length) out.push(text.slice(l));
  };
  for (const m of code.matchAll(pattern)) {
    if (m.index! > last) plain(code.slice(last, m.index));
    const cls = m[1] ? "tk-c" : m[2] ? "tk-s" : m[3] ? "tk-n" : "tk-f";
    out.push(
      <span key={key++} className={cls}>
        {m[0]}
      </span>,
    );
    last = m.index! + m[0].length;
  }
  if (last < code.length) plain(code.slice(last));
  return out;
}

/** A copyable code block. `children` is the raw code as a string. */
export function Code({
  lang = "bash",
  title,
  children,
  flush = false,
}: {
  lang?: Lang;
  title?: string;
  children: string;
  /** Drop the outer margin (used inside tabs). */
  flush?: boolean;
}) {
  const [copied, setCopied] = useState(false);
  const code = children.replace(/^\n+|\s+$/g, "");
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(code);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      /* clipboard unavailable */
    }
  };
  return (
    <figure className={`dcode ${flush ? "flush" : ""}`}>
      <figcaption>
        <span className="dcode-title">{title ?? LANG_LABEL[lang]}</span>
        {title ? <span className="dcode-lang">{LANG_LABEL[lang]}</span> : null}
        <button type="button" className="dcode-copy" onClick={copy} aria-label="Copy code to clipboard">
          {copied ? "Copied" : "Copy"}
        </button>
      </figcaption>
      <pre tabIndex={0}>
        <code>{highlight(code, lang)}</code>
      </pre>
    </figure>
  );
}

/* ── Tabs ─────────────────────────────────────────────────────────────── */

export interface TabItem {
  id: string;
  label: string;
  content: ReactNode;
}

/** Tabs whose selection is remembered, and shared by every tab set with the same `group`. */
export function Tabs({ group, items, label }: { group: string; items: TabItem[]; label?: string }) {
  const [stored, setStored] = useStored(`celeris-docs-tab-${group}`, items[0]!.id);
  const active = items.find((i) => i.id === stored) ?? items[0]!;
  return (
    <div className="dtabs">
      <div className="dtabs-bar" role="tablist" aria-label={label ?? group}>
        {items.map((i) => (
          <button
            key={i.id}
            type="button"
            role="tab"
            aria-selected={i.id === active.id}
            className={i.id === active.id ? "on" : ""}
            onClick={() => setStored(i.id)}
          >
            {i.label}
          </button>
        ))}
      </div>
      <div className="dtabs-panel" role="tabpanel">
        {active.content}
      </div>
    </div>
  );
}

export interface LangSnippet {
  id: string;
  label: string;
  lang: Lang;
  code: string;
  title?: string;
}

/** Same code in several languages (SDK languages, curl vs CLI, ...). Selection is shared by `group`. */
export function CodeTabs({ group, items }: { group: string; items: LangSnippet[] }) {
  return (
    <Tabs
      group={group}
      items={items.map((s) => ({
        id: s.id,
        label: s.label,
        content: (
          <Code lang={s.lang} title={s.title} flush>
            {s.code}
          </Code>
        ),
      }))}
    />
  );
}

const OS_LABEL: Record<Os, string> = { linux: "Linux", macos: "macOS", windows: "Windows" };

/**
 * One command set per operating system. `unix` is shorthand for identical
 * Linux and macOS text. Windows defaults to PowerShell; pass `windowsLang="bash"`
 * for Git Bash text.
 */
export function OsCode({
  linux,
  macos,
  windows,
  unix,
  title,
  windowsLang = "powershell",
  lang = "bash",
}: {
  linux?: string;
  macos?: string;
  windows?: string;
  unix?: string;
  title?: string;
  windowsLang?: Lang;
  lang?: Lang;
}) {
  const [os, setOs] = useOs();
  const text: Record<Os, string | undefined> = { linux: linux ?? unix, macos: macos ?? unix, windows };
  const available = (["linux", "macos", "windows"] as Os[]).filter((o) => text[o] !== undefined);
  const active = available.includes(os) ? os : available[0]!;
  return (
    <div className="dtabs os">
      <div className="dtabs-bar" role="tablist" aria-label="Operating system">
        {available.map((o) => (
          <button
            key={o}
            type="button"
            role="tab"
            aria-selected={o === active}
            className={o === active ? "on" : ""}
            onClick={() => setOs(o)}
          >
            {OS_LABEL[o]}
          </button>
        ))}
      </div>
      <div className="dtabs-panel" role="tabpanel">
        <Code lang={active === "windows" ? windowsLang : lang} title={title} flush>
          {text[active]!}
        </Code>
      </div>
    </div>
  );
}

/** Show different prose per operating system. */
export function OsOnly({ children }: { children: Partial<Record<Os, ReactNode>> }) {
  const [os] = useOs();
  return <>{children[os] ?? null}</>;
}

export { detectOs, useOs, useStored };

/* ── Prose blocks ─────────────────────────────────────────────────────── */

export function Callout({
  kind = "note",
  title,
  children,
}: {
  kind?: "note" | "tip" | "warn" | "danger";
  title?: string;
  children: ReactNode;
}) {
  const label = { note: "Note", tip: "Tip", warn: "Warning", danger: "Important" }[kind];
  return (
    <aside className={`callout ${kind}`} role="note">
      <strong className="callout-title">{title ?? label}</strong>
      <div>{children}</div>
    </aside>
  );
}

export function Steps({ children }: { children: ReactNode }) {
  return <ol className="steps">{children}</ol>;
}
export function Step({ title, children }: { title: string; children?: ReactNode }) {
  return (
    <li>
      <h4 className="step-title">{title}</h4>
      <div className="step-body">{children}</div>
    </li>
  );
}

export function Cards({ children }: { children: ReactNode }) {
  return <div className="cards">{children}</div>;
}
export function Card({ title, to, href, children }: { title: string; to?: string; href?: string; children: ReactNode }) {
  const target = to ? `#/${to}` : href;
  const body = (
    <>
      <strong>{title}</strong>
      <span>{children}</span>
    </>
  );
  return target ? (
    <a className="card" href={target}>
      {body}
    </a>
  ) : (
    <div className="card">{body}</div>
  );
}

export function Badge({ children, tone = "neutral" }: { children: ReactNode; tone?: "neutral" | "ok" | "warn" | "bad" | "accent" }) {
  return <span className={`badge ${tone}`}>{children}</span>;
}

export function Kbd({ children }: { children: ReactNode }) {
  return <kbd>{children}</kbd>;
}

export function Table({ head, rows }: { head: ReactNode[]; rows: ReactNode[][] }) {
  return (
    <div className="table-wrap">
      <table>
        <thead>
          <tr>
            {head.map((h, i) => (
              <th key={i}>{h}</th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map((r, i) => (
            <tr key={i}>
              {r.map((c, j) => (
                <td key={j}>{c}</td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

/** A reference table of parameters / options / settings: name, type, default, description. */
export function Params({ rows }: { rows: { name: string; type?: string; def?: string; desc: ReactNode }[] }) {
  return (
    <div className="table-wrap">
      <table className="params">
        <thead>
          <tr>
            <th>Name</th>
            <th>Type</th>
            <th>Default</th>
            <th>Description</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((r) => (
            <tr key={r.name}>
              <td>
                <code>{r.name}</code>
              </td>
              <td>{r.type ? <code>{r.type}</code> : null}</td>
              <td>{r.def ? <code>{r.def}</code> : <span className="faint">-</span>}</td>
              <td>{r.desc}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

export function Endpoint({
  method,
  path,
  children,
}: {
  method: "GET" | "PUT" | "POST" | "DELETE" | "WS";
  path: string;
  children?: ReactNode;
}) {
  return (
    <div className="endpoint">
      <div className="endpoint-line">
        <span className={`method m-${method.toLowerCase()}`}>{method}</span>
        <code>{path}</code>
      </div>
      {children ? <div className="endpoint-body">{children}</div> : null}
    </div>
  );
}

export function Details({ summary, children }: { summary: ReactNode; children: ReactNode }) {
  return (
    <details className="ddetails">
      <summary>{summary}</summary>
      <div>{children}</div>
    </details>
  );
}

/* ── Interactive demo frame ───────────────────────────────────────────── */

/**
 * Frame for every interactive or animated demo. `note` is the honest
 * one-liner about what is simulated.
 */
export function Demo({
  title,
  note = "Interactive. Simulated in your browser, no server involved.",
  children,
  controls,
}: {
  title: string;
  note?: string;
  children: ReactNode;
  controls?: ReactNode;
}) {
  return (
    <section className="demo" aria-label={title}>
      <header className="demo-head">
        <div>
          <span className="demo-tag">Interactive</span>
          <strong>{title}</strong>
        </div>
        {controls ? <div className="demo-controls">{controls}</div> : null}
      </header>
      <div className="demo-stage">{children}</div>
      <footer className="demo-foot">{note}</footer>
    </section>
  );
}

/* ── Hooks for demos ──────────────────────────────────────────────────── */

export function prefersReducedMotion(): boolean {
  return typeof window !== "undefined" && !!window.matchMedia?.("(prefers-reduced-motion: reduce)").matches;
}

/** Calls `fn` every `ms` while `active`. Always cleans up. */
export function useInterval(fn: () => void, ms: number, active = true) {
  const saved = useRef(fn);
  saved.current = fn;
  useEffect(() => {
    if (!active) return;
    const id = setInterval(() => saved.current(), ms);
    return () => clearInterval(id);
  }, [ms, active]);
}

/** True while the element is on screen: start animations only when seen. */
export function useInView<T extends Element>(): [React.RefObject<T | null>, boolean] {
  const ref = useRef<T>(null);
  const [seen, setSeen] = useState(false);
  useEffect(() => {
    const el = ref.current;
    if (!el || typeof IntersectionObserver === "undefined") {
      setSeen(true);
      return;
    }
    const io = new IntersectionObserver(([e]) => setSeen(!!e?.isIntersecting), { threshold: 0.25 });
    io.observe(el);
    return () => io.disconnect();
  }, []);
  return [ref, seen];
}

export function Button({
  children,
  onClick,
  kind = "ghost",
  disabled,
  pressed,
}: {
  children: ReactNode;
  onClick?: () => void;
  kind?: "ghost" | "primary" | "danger";
  disabled?: boolean;
  pressed?: boolean;
}) {
  return (
    <button type="button" className={`dbtn ${kind} ${pressed ? "on" : ""}`} onClick={onClick} disabled={disabled} aria-pressed={pressed}>
      {children}
    </button>
  );
}