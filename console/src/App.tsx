import { useEffect, useState } from "react";

import { useConnection } from "./connection";
import { Conflicts } from "./pages/Conflicts";
import { Explorer } from "./pages/Explorer";
import { Live } from "./pages/Live";
import { Overview } from "./pages/Overview";
import { Partitions } from "./pages/Partitions";

const PAGES = [
  { id: "overview", label: "Overview", component: Overview },
  { id: "partitions", label: "Partitions", component: Partitions },
  { id: "explorer", label: "Data", component: Explorer },
  { id: "live", label: "Live", component: Live },
  { id: "conflicts", label: "Conflicts", component: Conflicts },
] as const;

type PageId = (typeof PAGES)[number]["id"];

function currentPage(): PageId {
  const id = window.location.hash.replace(/^#\/?/, "");
  return (PAGES.find((p) => p.id === id)?.id ?? "overview") as PageId;
}

export function App() {
  const [page, setPage] = useState<PageId>(currentPage);
  useEffect(() => {
    const onHash = () => setPage(currentPage());
    window.addEventListener("hashchange", onHash);
    return () => window.removeEventListener("hashchange", onHash);
  }, []);
  const Page = PAGES.find((p) => p.id === page)!.component;

  return (
    <div className="shell">
      <aside className="sidebar">
        <div className="brand">
          <svg viewBox="0 0 32 32" aria-hidden="true">
            <rect x="1" y="1" width="30" height="30" rx="8" fill="#05070a" stroke="none" />
            <circle cx="16" cy="9" r="3.2" fill="#fff" stroke="none" />
            <circle cx="9" cy="21.5" r="3.2" fill="#fff" stroke="none" />
            <circle cx="23" cy="21.5" r="3.2" fill="#fff" stroke="none" />
            <path d="M16 9 9 21.5h14Z" fill="none" stroke="#fff" strokeWidth="1.6" strokeLinejoin="round" />
          </svg>
          <span>Celeris</span>
          <small>console</small>
        </div>
        <nav aria-label="Sections">
          {PAGES.map((p) => (
            <a key={p.id} href={`#/${p.id}`} aria-current={p.id === page ? "page" : undefined}>
              {p.label}
            </a>
          ))}
        </nav>
        <NodesForm />
      </aside>
      <main className="content">
        <Page />
      </main>
    </div>
  );
}

function NodesForm() {
  const { nodes, setNodes, token, setToken } = useConnection();
  const [text, setText] = useState(nodes.join("\n"));
  const [secret, setSecret] = useState(token);
  return (
    <form
      className="nodes-form"
      onSubmit={(e) => {
        e.preventDefault();
        setNodes(text);
        setToken(secret.trim());
      }}
    >
      <label htmlFor="nodes">Nodes</label>
      <textarea
        id="nodes"
        rows={3}
        spellCheck={false}
        value={text}
        onChange={(e) => setText(e.target.value)}
        placeholder="http://127.0.0.1:8080"
      />
      <label htmlFor="token">API token</label>
      <input
        id="token"
        type="password"
        autoComplete="off"
        spellCheck={false}
        value={secret}
        onChange={(e) => setSecret(e.target.value)}
        placeholder="only if the cluster requires one"
      />
      <button type="submit">Connect</button>
      <p className="hint">One API URL per line. Each node must allow this origin in http.cors_origins.</p>
    </form>
  );
}
