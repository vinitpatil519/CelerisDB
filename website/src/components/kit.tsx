/// <reference types="vite/client" />
import { useEffect, useState, type ReactNode } from "react";

import { DOCS, DOCS_PAGE, REPO } from "../data/site";
import { jump } from "../motion";

/* ── Brand ─────────────────────────────────────────────────────────────── */

export function Mark({ size = 22 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 32 32" aria-hidden="true">
      <rect x="1" y="1" width="30" height="30" rx="8" fill="#05070a" />
      <circle cx="16" cy="9" r="3.2" fill="#fff" />
      <circle cx="9" cy="21.5" r="3.2" fill="#fff" />
      <circle cx="23" cy="21.5" r="3.2" fill="#fff" />
      <path d="M16 9 9 21.5h14Z" fill="none" stroke="#fff" strokeWidth="1.6" strokeLinejoin="round" />
    </svg>
  );
}

export function GitHubIcon({ size = 16 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 16 16" aria-hidden="true" fill="currentColor">
      <path d="M8 0C3.58 0 0 3.58 0 8a8 8 0 0 0 5.47 7.59c.4.07.55-.17.55-.38v-1.34c-2.23.48-2.7-1.07-2.7-1.07-.36-.92-.89-1.17-.89-1.17-.73-.5.06-.49.06-.49.8.06 1.23.83 1.23.83.72 1.22 1.87.87 2.33.66.07-.52.28-.87.5-1.07-1.78-.2-3.65-.89-3.65-3.95 0-.87.31-1.59.82-2.15-.08-.2-.36-1.02.08-2.12 0 0 .67-.22 2.2.82a7.6 7.6 0 0 1 4 0c1.53-1.04 2.2-.82 2.2-.82.44 1.1.16 1.92.08 2.12.51.56.82 1.27.82 2.15 0 3.07-1.87 3.75-3.66 3.95.29.25.54.73.54 1.48v2.2c0 .21.15.46.55.38A8 8 0 0 0 16 8c0-4.42-3.58-8-8-8Z" />
    </svg>
  );
}

/* ── Integration logos (monochrome, inlined) ──────────────────────────── */

const RAW_LOGOS = import.meta.glob("../assets/logos/*.svg", {
  query: "?raw",
  import: "default",
  eager: true,
}) as Record<string, string>;

const LOGOS: Record<string, string> = Object.fromEntries(
  Object.entries(RAW_LOGOS).map(([path, svg]) => [
    path.split("/").pop()!.replace(".svg", ""),
    svg.replace(/<title>.*?<\/title>/, ""),
  ]),
);

export const LOGO_NAMES: Record<string, string> = {
  react: "React",
  nextdotjs: "Next.js",
  typescript: "TypeScript",
  nodedotjs: "Node.js",
  python: "Python",
  go: "Go",
  rust: "Rust",
  docker: "Docker",
  kubernetes: "Kubernetes",
  aws: "AWS",
  googlecloud: "Google Cloud",
  azure: "Azure",
  prometheus: "Prometheus",
  grafana: "Grafana",
  openai: "OpenAI",
  anthropic: "Anthropic",
  langchain: "LangChain",
  huggingface: "Hugging Face",
  vercel: "Vercel",
  githubactions: "GitHub Actions",
  terraform: "Terraform",
  helm: "Helm",
};

export function BrandLogo({ id, size = 28, label = true }: { id: string; size?: number; label?: boolean }) {
  const svg = LOGOS[id];
  if (!svg) return null;
  return (
    <span className="brand" title={LOGO_NAMES[id]}>
      <span className="brand-svg" style={{ width: size, height: size }} dangerouslySetInnerHTML={{ __html: svg }} />
      {label ? <span className="brand-name">{LOGO_NAMES[id]}</span> : <span className="sr-only">{LOGO_NAMES[id]}</span>}
    </span>
  );
}

/* ── Layout ───────────────────────────────────────────────────────────── */

export function SectionHead({
  eyebrow,
  title,
  children,
  center = false,
  id,
}: {
  eyebrow: string;
  title: ReactNode;
  children?: ReactNode;
  center?: boolean;
  id?: string;
}) {
  return (
    <header className={`section-head ${center ? "center" : ""}`}>
      <p className="eyebrow" data-reveal="fade">
        {eyebrow}
      </p>
      <h2 id={id} data-reveal="lines">
        {title}
      </h2>
      {children ? (
        <div className="section-lede" data-reveal="fade" data-delay="0.1">
          {children}
        </div>
      ) : null}
    </header>
  );
}

const NAV = [
  { id: "cap", label: "CAP" },
  { id: "modes", label: "Consistency" },
  { id: "architecture", label: "Architecture" },
  { id: "features", label: "Features" },
  { id: "integrations", label: "Integrations" },
  { id: "developers", label: "Developers" },
];

export function Nav() {
  const [solid, setSolid] = useState(false);
  const [theme, setTheme] = useState<"dark" | "light">("dark");
  useEffect(() => {
    const onScroll = () => {
      setSolid(scrollY > 24);
      // The nav takes the colour of the section underneath it.
      const under = document
        .elementsFromPoint(innerWidth / 2, 34)
        .find((el) => !el.closest(".nav") && el.closest("[data-theme]"));
      const dark = under?.closest("[data-theme]")?.getAttribute("data-theme") !== "light";
      setTheme(dark ? "dark" : "light");
    };
    onScroll();
    addEventListener("scroll", onScroll, { passive: true });
    return () => removeEventListener("scroll", onScroll);
  }, []);
  return (
    <nav className={`nav ${solid ? "is-solid" : ""} nav-${theme}`} aria-label="Primary">
      <div className="container nav-inner">
        <a className="nav-brand" href="#top" onClick={jump("top")}>
          <Mark />
          <span>CelerisDB</span>
        </a>
        <div className="nav-links">
          {NAV.map((n) => (
            <a key={n.id} href={`#${n.id}`} onClick={jump(n.id)}>
              {n.label}
            </a>
          ))}
        </div>
        <div className="nav-actions">
          <a className="nav-docs" href={DOCS}>
            Docs
          </a>
          <a className="nav-gh" href={REPO}>
            <GitHubIcon /> <span>GitHub</span>
          </a>
          <a className="btn btn-sm btn-primary" href="#start" onClick={jump("start")}>
            Get started
          </a>
        </div>
      </div>
    </nav>
  );
}

/* ── Code ─────────────────────────────────────────────────────────────── */

const KEYWORDS =
  /\b(await|async|const|let|import|from|export|function|return|for|in|with|as|if|else|def|fn|use|mut|func|package|defer|nil|true|false|None|True|False|new|struct|impl|pub)\b/g;

/** A tiny highlighter: comments, strings, numbers and keywords. */
function highlight(code: string): ReactNode[] {
  const out: ReactNode[] = [];
  const pattern = /((?<![:\w])\/\/.*$|#\s.*$)|("(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*'|`(?:[^`\\]|\\.)*`)|(\b\d[\d_.]*\b)/gm;
  let last = 0;
  let key = 0;
  const pushPlain = (text: string) => {
    let l = 0;
    for (const m of text.matchAll(KEYWORDS)) {
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
    if (m.index! > last) pushPlain(code.slice(last, m.index));
    const cls = m[1] ? "tk-c" : m[2] ? "tk-s" : "tk-n";
    out.push(
      <span key={key++} className={cls}>
        {m[0]}
      </span>,
    );
    last = m.index! + m[0].length;
  }
  if (last < code.length) pushPlain(code.slice(last));
  return out;
}

export function CodeBlock({ code, label, className = "" }: { code: string; label?: string; className?: string }) {
  const [copied, setCopied] = useState(false);
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(code);
      setCopied(true);
      setTimeout(() => setCopied(false), 1400);
    } catch {
      /* clipboard unavailable */
    }
  };
  return (
    <div className={`code ${className}`}>
      <div className="code-bar">
        <span className="code-label">{label}</span>
        <button type="button" className="code-copy" onClick={copy} aria-label="Copy code">
          {copied ? "Copied" : "Copy"}
        </button>
      </div>
      <pre>
        <code>{highlight(code)}</code>
      </pre>
    </div>
  );
}

/* ── Footer ───────────────────────────────────────────────────────────── */

export function Footer() {
  const cols = [
    {
      title: "Product",
      links: [
        ["Consistency modes", "#modes"],
        ["Architecture", "#architecture"],
        ["Features", "#features"],
        ["Integrations", "#integrations"],
      ],
    },
    {
      title: "Documentation",
      links: [
        ["Quickstart", DOCS_PAGE("quickstart")],
        ["HTTP API reference", DOCS_PAGE("http-api")],
        ["CLI reference", DOCS_PAGE("cli")],
        ["Deployment", DOCS_PAGE("deployment")],
        ["Design decisions", `${REPO}/blob/main/docs/DECISIONS.md`],
      ],
    },
    {
      title: "Project",
      links: [
        ["GitHub", REPO],
        ["Roadmap", `${REPO}/blob/main/docs/ROADMAP.md`],
        ["All docs", DOCS],
      ],
    },
    {
      title: "Connect",
      links: [
        ["Vinit Patil", "https://www.linkedin.com/in/vinit-patil-a3384728a/"],
        ["vinitonterminal@gmail.com", "mailto:vinitonterminal@gmail.com"],
        ["LinkedIn", "https://www.linkedin.com/in/vinit-patil-a3384728a/"],
      ],
    },
  ];
  return (
    <footer className="footer" data-theme="dark">
      <div className="container footer-grid">
        <div className="footer-brand">
          <a className="nav-brand" href="#top" onClick={jump("top")}>
            <Mark />
            <span>CelerisDB</span>
          </a>
          <p>A distributed JSON database where every request chooses its consistency.</p>
          <p className="muted">Apache-2.0 · self-hosted · written in Rust</p>
          <p className="muted">Built by Vinit Patil, Mumbai</p>
          <p className="muted">© 2026 Vinit Patil. Licensed under Apache-2.0; attribution required.</p>
        </div>
        {cols.map((c) => (
          <div key={c.title} className="footer-col">
            <h4>{c.title}</h4>
            {c.links.map(([label, href]) => (
              <a key={label} href={href} onClick={href!.startsWith("#") ? jump(href!.slice(1)) : undefined}>
                {label}
              </a>
            ))}
          </div>
        ))}
      </div>
    </footer>
  );
}
