import { useEffect, useState, type ReactNode } from "react";

import { REPO, SECTIONS } from "../data/site";
import { ScrollTrigger, scrollToId } from "../motion";

export function Logo() {
  return (
    <svg viewBox="0 0 32 32" className="logo" aria-hidden="true">
      <circle cx="16" cy="16" r="10" />
      <circle cx="16" cy="16" r="3" className="core" />
    </svg>
  );
}

export function Nav() {
  return (
    <header className="nav">
      <a className="nav-brand" href="#top" onClick={jump("top")}>
        <Logo />
        <span>Celeris</span>
      </a>
      <nav aria-label="Primary">
        <a href="#dial" onClick={jump("dial")}>
          Consistency
        </a>
        <a href="#route" onClick={jump("route")}>
          Architecture
        </a>
        <a href="#install" onClick={jump("install")}>
          Install
        </a>
        <a href={REPO} className="nav-cta">
          GitHub
        </a>
      </nav>
    </header>
  );
}

/** Click handler that scrolls to a section through Lenis. */
export function jump(id: string) {
  return (e: React.MouseEvent) => {
    e.preventDefault();
    scrollToId(id);
    history.replaceState(null, "", `#${id}`);
  };
}

/** The thin left rail naming the story's chapters. */
export function ProgressRail() {
  const [active, setActive] = useState<string | null>(null);
  useEffect(() => {
    const triggers = SECTIONS.map((s) => {
      const el = document.getElementById(s.id);
      if (!el) return null;
      return ScrollTrigger.create({
        trigger: el,
        start: "top center",
        end: "bottom center",
        onToggle: (self) => {
          if (self.isActive) setActive(s.id);
        },
      });
    });
    return () => triggers.forEach((t) => t?.kill());
  }, []);
  return (
    <nav className="rail" aria-label="Chapters">
      <ol>
        {SECTIONS.map((s) => (
          <li key={s.id}>
            <a href={`#${s.id}`} onClick={jump(s.id)} aria-current={active === s.id ? "step" : undefined}>
              <span className="rail-tick" aria-hidden="true" />
              {s.label}
            </a>
          </li>
        ))}
      </ol>
    </nav>
  );
}

/** A code panel with a copy button; keyboard reachable. */
export function CodeBlock({ code, label, language }: { code: string; label: string; language?: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <figure className="code panel">
      <figcaption>
        <span>{label}</span>
        <button
          type="button"
          className="copy"
          onClick={async () => {
            try {
              await navigator.clipboard.writeText(code);
              setCopied(true);
              setTimeout(() => setCopied(false), 1500);
            } catch {
              setCopied(false);
            }
          }}
          aria-label={`Copy ${label}`}
        >
          {copied ? "Copied" : "Copy"}
        </button>
      </figcaption>
      <pre tabIndex={0} aria-label={label} data-language={language}>
        <code>{code}</code>
      </pre>
    </figure>
  );
}

/** Section heading block: index, kicker, title, body. */
export function SectionHead({ index, kicker, title, children }: { index: string; kicker: string; title: ReactNode; children?: ReactNode }) {
  return (
    <div className="section-head">
      <p className="kicker">
        <span className="kicker-index">{index}</span> {kicker}
      </p>
      <h2>{title}</h2>
      {children ? <div className="lede">{children}</div> : null}
    </div>
  );
}

/**
 * A subtle light that follows the pointer over `.panel` elements, through
 * CSS variables. Off on touch devices.
 */
export function usePointerLight() {
  useEffect(() => {
    if (!window.matchMedia("(pointer: fine)").matches) return;
    const onMove = (e: PointerEvent) => {
      const panel = (e.target as Element | null)?.closest?.(".panel") as HTMLElement | null;
      if (!panel) return;
      const r = panel.getBoundingClientRect();
      panel.style.setProperty("--px", `${e.clientX - r.left}px`);
      panel.style.setProperty("--py", `${e.clientY - r.top}px`);
    };
    window.addEventListener("pointermove", onMove, { passive: true });
    return () => window.removeEventListener("pointermove", onMove);
  }, []);
}
