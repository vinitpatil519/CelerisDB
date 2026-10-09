import { Component, useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";

import { REPO, useStored } from "./kit";
import { PAGES, GROUPS, bySlug } from "./registry";
import { buildIndex, search, type Entry, type Hit } from "./search";

const DEFAULT = "introduction";

function parseHash(): { slug: string; anchor?: string } {
  const raw = decodeURIComponent(location.hash.replace(/^#\/?/, ""));
  const [slug, anchor] = raw.split(":");
  return { slug: slug && bySlug(slug) ? slug : DEFAULT, anchor: anchor || undefined };
}

function useRoute() {
  const [route, setRoute] = useState(parseHash);
  useEffect(() => {
    const on = () => setRoute(parseHash());
    addEventListener("hashchange", on);
    return () => removeEventListener("hashchange", on);
  }, []);
  return route;
}

class Boundary extends Component<{ children: ReactNode }, { failed: boolean }> {
  state = { failed: false };
  static getDerivedStateFromError() {
    return { failed: true };
  }
  render() {
    return this.state.failed ? (
      <div className="callout warn">
        <strong className="callout-title">This section failed to load</strong>
        <div>Reload the page. If it keeps happening, please open an issue on GitHub.</div>
      </div>
    ) : (
      this.props.children
    );
  }
}

function Logo() {
  return (
    <svg width="26" height="26" viewBox="0 0 32 32" aria-hidden="true">
      <rect x="1" y="1" width="30" height="30" rx="8" fill="#05070a" />
      <circle cx="16" cy="9" r="3.2" fill="#fff" />
      <circle cx="9" cy="21.5" r="3.2" fill="#fff" />
      <circle cx="23" cy="21.5" r="3.2" fill="#fff" />
      <path d="M16 9 9 21.5h14Z" fill="none" stroke="#fff" strokeWidth="1.6" strokeLinejoin="round" />
    </svg>
  );
}

function SearchModal({ onClose }: { onClose: () => void }) {
  const [q, setQ] = useState("");
  const [entries, setEntries] = useState<Entry[] | null>(null);
  const [sel, setSel] = useState(0);
  const input = useRef<HTMLInputElement>(null);
  useEffect(() => {
    input.current?.focus();
    buildIndex().then(setEntries);
  }, []);
  const hits: Hit[] = useMemo(() => (entries ? search(entries, q) : []), [entries, q]);
  const go = (h: Hit) => {
    location.hash = `#/${h.slug}${h.anchor ? `:${h.anchor}` : ""}`;
    onClose();
  };
  return (
    <div className="search-backdrop" onMouseDown={onClose}>
      <div
        className="search"
        role="dialog"
        aria-modal="true"
        aria-label="Search the docs"
        onMouseDown={(e) => e.stopPropagation()}
        onKeyDown={(e) => {
          if (e.key === "Escape") onClose();
          else if (e.key === "ArrowDown") {
            e.preventDefault();
            setSel((s) => Math.min(s + 1, hits.length - 1));
          } else if (e.key === "ArrowUp") {
            e.preventDefault();
            setSel((s) => Math.max(s - 1, 0));
          } else if (e.key === "Enter" && hits[sel]) go(hits[sel]!);
        }}
      >
        <input
          ref={input}
          value={q}
          onChange={(e) => {
            setQ(e.target.value);
            setSel(0);
          }}
          placeholder="Search the docs: try “retry”, “tls”, “kubernetes”, “langchain”…"
          aria-label="Search"
        />
        <div className="search-results">
          {!entries ? <p className="search-empty">Building the index…</p> : null}
          {entries && q && !hits.length ? <p className="search-empty">No results for “{q}”.</p> : null}
          {entries && !q ? <p className="search-empty">Type to search every page.</p> : null}
          {hits.map((h, i) => (
            <button type="button" key={h.slug + (h.anchor ?? "")} className={`hit ${i === sel ? "on" : ""}`} onMouseEnter={() => setSel(i)} onClick={() => go(h)}>
              <span className="hit-top">
                <strong>{h.title}</strong>
                {h.heading ? <span className="hit-head"> › {h.heading}</span> : null}
                <em>{h.group}</em>
              </span>
              <span className="hit-snip">{h.snippet}</span>
            </button>
          ))}
        </div>
      </div>
    </div>
  );
}

export function DocsApp() {
  const { slug, anchor } = useRoute();
  const page = bySlug(slug)!;
  const idx = PAGES.findIndex((p) => p.slug === slug);
  const prev = PAGES[idx - 1];
  const next = PAGES[idx + 1];
  const [theme, setTheme] = useStored("celeris-docs-theme", "light");
  const [menu, setMenu] = useState(false);
  const [searching, setSearching] = useState(false);
  const [toc, setToc] = useState<{ id: string; title: string; level: number }[]>([]);
  const [active, setActive] = useState("");
  const article = useRef<HTMLElement>(null);

  useEffect(() => {
    document.documentElement.setAttribute("data-theme", theme);
  }, [theme]);

  useEffect(() => {
    document.title = `${page.title} · CelerisDB Docs`;
    setMenu(false);
  }, [page]);

  // Scroll to the anchor, or to the top on a new page; then build the table of contents.
  useEffect(() => {
    const el = anchor ? document.getElementById(anchor) : null;
    if (el) el.scrollIntoView({ block: "start" });
    else window.scrollTo(0, 0);
    const heads = [...(article.current?.querySelectorAll<HTMLElement>("h2[id], h3[id]") ?? [])];
    setToc(heads.map((h) => ({ id: h.id, title: h.firstChild?.textContent ?? h.id, level: h.tagName === "H2" ? 2 : 3 })));
    setActive(heads[0]?.id ?? "");
    if (!heads.length || typeof IntersectionObserver === "undefined") return;
    const io = new IntersectionObserver(
      (entries) => {
        const top = entries.filter((e) => e.isIntersecting).sort((a, b) => a.boundingClientRect.top - b.boundingClientRect.top)[0];
        if (top) setActive(top.target.id);
      },
      { rootMargin: "-80px 0px -70% 0px" },
    );
    heads.forEach((h) => io.observe(h));
    return () => io.disconnect();
  }, [slug, anchor]);

  // Cmd/Ctrl+K or "/" opens search.
  useEffect(() => {
    const on = (e: KeyboardEvent) => {
      const typing = /input|textarea|select/i.test((e.target as HTMLElement)?.tagName ?? "") || (e.target as HTMLElement)?.isContentEditable;
      if ((e.key === "k" && (e.metaKey || e.ctrlKey)) || (e.key === "/" && !typing)) {
        e.preventDefault();
        setSearching(true);
      }
    };
    addEventListener("keydown", on);
    return () => removeEventListener("keydown", on);
  }, []);

  // Heading anchors keep the page route: #/page:heading.
  const onArticleClick = useCallback(
    (e: React.MouseEvent) => {
      const a = (e.target as HTMLElement).closest<HTMLAnchorElement>("a.hd-anchor");
      if (!a) return;
      e.preventDefault();
      const id = a.dataset.anchor!;
      history.replaceState(null, "", `#/${slug}:${id}`);
      document.getElementById(id)?.scrollIntoView({ block: "start", behavior: "smooth" });
    },
    [slug],
  );

  const Body = page.Body;
  return (
    <div className="docs">
      <a className="skip" href="#content">
        Skip to content
      </a>
      <header className="topbar">
        <button type="button" className="icon-btn menu-btn" aria-label="Toggle navigation" aria-expanded={menu} onClick={() => setMenu(!menu)}>
          <span />
          <span />
          <span />
        </button>
        <a className="brand" href="../" aria-label="CelerisDB home">
          <Logo />
          <span>CelerisDB</span>
          <em>Docs</em>
        </a>
        <button type="button" className="search-trigger" onClick={() => setSearching(true)}>
          <span>Search docs</span>
          <kbd>Ctrl K</kbd>
        </button>
        <nav className="top-links" aria-label="Site">
          <a href="../">Home</a>
          <a href={REPO}>GitHub</a>
          <button type="button" className="icon-btn" aria-label={`Switch to ${theme === "dark" ? "light" : "dark"} theme`} onClick={() => setTheme(theme === "dark" ? "light" : "dark")}>
            {theme === "dark" ? "☀" : "☾"}
          </button>
        </nav>
      </header>

      <div className="shell">
        <aside className={`sidebar ${menu ? "open" : ""}`} aria-label="Documentation">
          {GROUPS.map((g) => (
            <section key={g}>
              <h3>{g}</h3>
              <ul>
                {PAGES.filter((p) => p.group === g).map((p) => (
                  <li key={p.slug}>
                    <a href={`#/${p.slug}`} aria-current={p.slug === slug ? "page" : undefined}>
                      {p.title}
                    </a>
                  </li>
                ))}
              </ul>
            </section>
          ))}
        </aside>

        <main id="content" className="main">
          <article ref={article} onClick={onArticleClick} key={slug}>
            <header className="page-head">
              <p className="crumb">
                {page.group}
              </p>
              <h1>{page.title}</h1>
              <p className="lede">{page.summary}</p>
            </header>
            <div className="prose">
              <Boundary>
                <Body />
              </Boundary>
            </div>
            <nav className="pager" aria-label="Previous and next">
              {prev ? (
                <a href={`#/${prev.slug}`} className="prev">
                  <span>Previous</span>
                  <strong>{prev.title}</strong>
                </a>
              ) : (
                <span />
              )}
              {next ? (
                <a href={`#/${next.slug}`} className="next">
                  <span>Next</span>
                  <strong>{next.title}</strong>
                </a>
              ) : null}
            </nav>
            <p className="edit">
              <a href={`${REPO}/edit/main/website/src/docs/pages/${page.slug}.tsx`}>Edit this page on GitHub</a>
            </p>
          </article>
        </main>

        <aside className="toc" aria-label="On this page">
          {toc.length ? (
            <>
              <h3>On this page</h3>
              <ul>
                {toc.map((t) => (
                  <li key={t.id} className={`l${t.level}`}>
                    <a
                      href={`#/${slug}:${t.id}`}
                      className={active === t.id ? "on" : ""}
                      onClick={(e) => {
                        e.preventDefault();
                        history.replaceState(null, "", `#/${slug}:${t.id}`);
                        document.getElementById(t.id)?.scrollIntoView({ block: "start", behavior: "smooth" });
                        setActive(t.id);
                      }}
                    >
                      {t.title}
                    </a>
                  </li>
                ))}
              </ul>
            </>
          ) : null}
        </aside>
      </div>
      {menu ? <div className="scrim" onClick={() => setMenu(false)} /> : null}
      {searching ? <SearchModal onClose={() => setSearching(false)} /> : null}
    </div>
  );
}