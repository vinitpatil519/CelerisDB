import { useEffect, useRef, useState, type ReactNode } from "react";

import { REPO } from "../data/site";
import { gsap, jump, prefersReducedMotion, ScrollTrigger } from "../motion";

export function Logo({ size = 22 }: { size?: number }) {
  return (
    <svg viewBox="0 0 32 32" width={size} height={size} className="logo" aria-hidden="true">
      <circle cx="16" cy="16" r="11" className="logo-ring" />
      <path d="M 16 5 A 11 11 0 0 1 27 16" className="logo-arc" />
      <circle cx="16" cy="16" r="3.2" className="logo-core" />
    </svg>
  );
}

export function Nav() {
  const [scrolled, setScrolled] = useState(false);
  useEffect(() => {
    const t = ScrollTrigger.create({
      start: 80,
      end: "max",
      onToggle: (self) => setScrolled(self.isActive),
    });
    return () => t.kill();
  }, []);
  return (
    <header className={`nav ${scrolled ? "is-scrolled" : ""}`}>
      <div className="nav-inner">
        <a className="brand" href="#top" onClick={jump("top")}>
          <Logo />
          <span>Celeris</span>
        </a>
        <nav aria-label="Primary">
          <a href="#modes" onClick={jump("modes")}>
            Consistency
          </a>
          <a href="#journey" onClick={jump("journey")}>
            Architecture
          </a>
          <a href="#resilience" onClick={jump("resilience")}>
            Resilience
          </a>
          <a href="#developers" onClick={jump("developers")}>
            Developers
          </a>
        </nav>
        <div className="nav-actions">
          <a className="nav-link" href={REPO}>
            <GitHubIcon /> GitHub
          </a>
          <a className="btn btn-sm btn-primary" href="#start" onClick={jump("start")}>
            Get started
          </a>
        </div>
      </div>
    </header>
  );
}

export function GitHubIcon() {
  return (
    <svg viewBox="0 0 16 16" width="15" height="15" aria-hidden="true" fill="currentColor">
      <path d="M8 0C3.58 0 0 3.58 0 8a8 8 0 0 0 5.47 7.59c.4.07.55-.17.55-.38v-1.33c-2.23.48-2.7-1.07-2.7-1.07-.36-.92-.89-1.17-.89-1.17-.73-.5.06-.49.06-.49.8.06 1.23.83 1.23.83.72 1.22 1.87.87 2.33.66.07-.52.28-.87.5-1.07-1.78-.2-3.65-.89-3.65-3.95 0-.87.31-1.59.82-2.15-.08-.2-.36-1.02.08-2.12 0 0 .67-.21 2.2.82a7.6 7.6 0 0 1 4 0c1.53-1.04 2.2-.82 2.2-.82.44 1.1.16 1.92.08 2.12.51.56.82 1.27.82 2.15 0 3.07-1.87 3.75-3.65 3.95.29.25.54.73.54 1.48v2.2c0 .21.15.46.55.38A8 8 0 0 0 16 8c0-4.42-3.58-8-8-8Z" />
    </svg>
  );
}

/** Thin progress bar along the top of the viewport. */
export function ScrollProgress() {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!ref.current) return;
    const tween = gsap.fromTo(
      ref.current,
      { scaleX: 0 },
      { scaleX: 1, ease: "none", scrollTrigger: { start: 0, end: "max", scrub: 0.3 } },
    );
    return () => {
      tween.scrollTrigger?.kill();
      tween.kill();
    };
  }, []);
  return <div className="scroll-progress" ref={ref} aria-hidden="true" />;
}

/** Eyebrow chip, split heading and lede for a section. */
export function SectionHead({
  eyebrow,
  title,
  children,
  align = "left",
  id,
}: {
  eyebrow: string;
  title: ReactNode;
  children?: ReactNode;
  align?: "left" | "center";
  id?: string;
}) {
  return (
    <div className={`section-head ${align === "center" ? "center" : ""}`}>
      <span className="eyebrow" data-reveal="fade">
        <span className="eyebrow-dot" aria-hidden="true" />
        {eyebrow}
      </span>
      <h2 id={id} data-reveal="lines">
        {title}
      </h2>
      {children ? (
        <div className="lede" data-reveal="fade" data-delay="0.15">
          {children}
        </div>
      ) : null}
    </div>
  );
}

/** A number that counts up when it scrolls into view. */
export function CountUp({ to, decimals = 0, prefix = "", suffix = "" }: { to: number; decimals?: number; prefix?: string; suffix?: string }) {
  const ref = useRef<HTMLSpanElement>(null);
  const format = (v: number) =>
    `${prefix}${v.toLocaleString("en-US", { minimumFractionDigits: decimals, maximumFractionDigits: decimals })}${suffix}`;
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    if (prefersReducedMotion()) {
      el.textContent = format(to);
      return;
    }
    const state = { v: 0 };
    const tween = gsap.to(state, {
      v: to,
      duration: 2.2,
      ease: "power3.out",
      scrollTrigger: { trigger: el, start: "top 90%", once: true },
      onUpdate: () => {
        el.textContent = format(state.v);
      },
    });
    return () => {
      tween.scrollTrigger?.kill();
      tween.kill();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [to]);
  return (
    <span ref={ref} className="tabular">
      {format(0)}
    </span>
  );
}

/** A card with a pointer spotlight and a glowing border on hover. */
export function Card({ children, className, ...rest }: { children: ReactNode; className?: string } & React.HTMLAttributes<HTMLDivElement>) {
  const ref = useRef<HTMLDivElement>(null);
  return (
    <div
      ref={ref}
      className={`card ${className ?? ""}`}
      onPointerMove={(e) => {
        const el = ref.current;
        if (!el) return;
        const r = el.getBoundingClientRect();
        el.style.setProperty("--mx", `${e.clientX - r.left}px`);
        el.style.setProperty("--my", `${e.clientY - r.top}px`);
      }}
      {...rest}
    >
      {children}
    </div>
  );
}

/** A button that leans toward the pointer. */
export function Magnetic({ children, className, href, onClick }: { children: ReactNode; className?: string; href: string; onClick?: (e: React.MouseEvent) => void }) {
  const ref = useRef<HTMLAnchorElement>(null);
  return (
    <a
      ref={ref}
      href={href}
      onClick={onClick}
      className={className}
      onPointerMove={(e) => {
        if (prefersReducedMotion() || !ref.current) return;
        const r = ref.current.getBoundingClientRect();
        gsap.to(ref.current, {
          x: (e.clientX - r.left - r.width / 2) * 0.18,
          y: (e.clientY - r.top - r.height / 2) * 0.25,
          duration: 0.4,
          ease: "power3.out",
        });
      }}
      onPointerLeave={() => ref.current && gsap.to(ref.current, { x: 0, y: 0, duration: 0.6, ease: "elastic.out(1,0.4)" })}
    >
      {children}
    </a>
  );
}

/* ------------------------------------------------------------ code */

const KEYWORDS = new Set(
  "import from export const let function return async await if else for in of new type interface use fn mut pub struct impl match def with as package func go defer var nil None True False null true false while".split(
    " ",
  ),
);

/** Minimal syntax colouring: strings, comments, keywords, numbers, types, calls. */
export function highlight(code: string): ReactNode[] {
  const out: ReactNode[] = [];
  const re = /(\/\/[^\n]*|#[^\n[]*|"(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*'|`(?:[^`\\]|\\.)*`|\b\d+(?:\.\d+)?\b|\b[A-Za-z_]\w*\b)/g;
  let last = 0;
  let m: RegExpExecArray | null;
  let i = 0;
  while ((m = re.exec(code))) {
    if (m.index > last) out.push(code.slice(last, m.index));
    const t = m[0];
    let cls = "";
    if (t.startsWith("//") || t.startsWith("#")) cls = "tok-comment";
    else if (/^["'`]/.test(t)) cls = "tok-string";
    else if (/^\d/.test(t)) cls = "tok-number";
    else if (KEYWORDS.has(t)) cls = "tok-keyword";
    else if (/^[A-Z]/.test(t)) cls = "tok-type";
    else if (code[re.lastIndex] === "(") cls = "tok-fn";
    out.push(
      cls ? (
        <span key={i++} className={cls}>
          {t}
        </span>
      ) : (
        t
      ),
    );
    last = re.lastIndex;
  }
  if (last < code.length) out.push(code.slice(last));
  return out;
}

export function CodeBlock({ code, label, className }: { code: string; label: string; className?: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <figure className={`code ${className ?? ""}`}>
      <figcaption>
        <span className="code-dots" aria-hidden="true">
          <i />
          <i />
          <i />
        </span>
        <span className="code-label">{label}</span>
        <button
          type="button"
          className="copy"
          onClick={async () => {
            try {
              await navigator.clipboard.writeText(code);
              setCopied(true);
              setTimeout(() => setCopied(false), 1400);
            } catch {
              setCopied(false);
            }
          }}
          aria-label={`Copy ${label}`}
        >
          {copied ? "Copied" : "Copy"}
        </button>
      </figcaption>
      <pre tabIndex={0} aria-label={label}>
        <code>{highlight(code)}</code>
      </pre>
    </figure>
  );
}

/** An infinitely scrolling row. */
export function Marquee({ items }: { items: ReactNode[] }) {
  return (
    <div className="marquee" aria-hidden="true">
      <div className="marquee-track">
        {[...items, ...items].map((item, i) => (
          <span className="marquee-item" key={i}>
            {item}
          </span>
        ))}
      </div>
    </div>
  );
}
