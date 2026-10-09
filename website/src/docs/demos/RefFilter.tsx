import { useState, type ReactNode } from "react";

import { Table } from "../kit";

/**
 * Small filter boxes for long reference material. Rows carry a plain-text
 * `search` string; the box matches every word of the query against it.
 */

function matches(search: string, query: string): boolean {
  const words = query.toLowerCase().split(/\s+/).filter(Boolean);
  const hay = search.toLowerCase();
  return words.every((w) => hay.includes(w));
}

const boxStyle = {
  display: "flex",
  alignItems: "center",
  gap: "0.75rem",
  flexWrap: "wrap" as const,
  margin: "0.5rem 0 0.75rem",
};

const inputStyle = {
  flex: "1 1 14rem",
  minWidth: 0,
  padding: "0.5rem 0.75rem",
  border: "1px solid var(--d-line-2)",
  borderRadius: "8px",
  background: "var(--d-bg-2)",
  color: "var(--d-text)",
  font: "inherit",
};

function FilterBox({
  label,
  placeholder,
  value,
  onChange,
  shown,
  total,
}: {
  label: string;
  placeholder: string;
  value: string;
  onChange: (v: string) => void;
  shown: number;
  total: number;
}) {
  return (
    <div style={boxStyle}>
      <input
        type="search"
        aria-label={label}
        placeholder={placeholder}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        style={inputStyle}
      />
      <span role="status" aria-live="polite" style={{ color: "var(--d-muted)", fontSize: "0.85em" }}>
        {shown} of {total}
      </span>
    </div>
  );
}

export interface FilterRow {
  /** Plain text the filter box matches against. */
  search: string;
  cells: ReactNode[];
}

/** A reference table with a filter box above it. */
export function FilterTable({
  head,
  rows,
  label = "Filter the table",
  placeholder = "Filter rows...",
  filter = true,
}: {
  head: ReactNode[];
  rows: FilterRow[];
  label?: string;
  placeholder?: string;
  /** Pass false to render a plain table without the box. */
  filter?: boolean;
}) {
  const [q, setQ] = useState("");
  const shown = rows.filter((r) => matches(r.search, q));
  return (
    <div>
      {filter ? (
        <FilterBox label={label} placeholder={placeholder} value={q} onChange={setQ} shown={shown.length} total={rows.length} />
      ) : null}
      <Table head={head} rows={shown.map((r) => r.cells)} />
      {shown.length === 0 ? <p style={{ color: "var(--d-muted)" }}>Nothing matches that filter.</p> : null}
    </div>
  );
}

export interface FilterTerm {
  id: string;
  term: string;
  body: ReactNode;
  /** Extra words to match, such as synonyms. */
  also?: string;
}

/** A filterable definition list (glossary). */
export function FilterList({ items, label, placeholder }: { items: FilterTerm[]; label: string; placeholder: string }) {
  const [q, setQ] = useState("");
  const shown = items.filter((i) => matches(`${i.term} ${i.also ?? ""} ${textOf(i.body)}`, q));
  return (
    <div>
      <FilterBox label={label} placeholder={placeholder} value={q} onChange={setQ} shown={shown.length} total={items.length} />
      <dl>
        {shown.map((i) => (
          <div key={i.id} id={i.id} style={{ marginBottom: "1rem" }}>
            <dt style={{ fontWeight: 600 }}>{i.term}</dt>
            <dd style={{ margin: "0.15rem 0 0" }}>{i.body}</dd>
          </div>
        ))}
      </dl>
      {shown.length === 0 ? <p style={{ color: "var(--d-muted)" }}>No term matches that filter.</p> : null}
    </div>
  );
}

/** Best-effort plain text of a node made of strings and simple elements. */
function textOf(node: ReactNode): string {
  if (node == null || typeof node === "boolean") return "";
  if (typeof node === "string" || typeof node === "number") return String(node);
  if (Array.isArray(node)) return node.map(textOf).join(" ");
  if (typeof node === "object" && "props" in node) {
    return textOf((node as { props: { children?: ReactNode } }).props.children);
  }
  return "";
}
