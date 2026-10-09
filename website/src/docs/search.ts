import type { ReactElement } from "react";

import { createElement } from "react";

import { PAGES } from "./registry";

export interface Entry {
  slug: string;
  title: string;
  group: string;
  summary: string;
  keywords: string;
  headings: { id: string; title: string }[];
  text: string;
}

export interface Hit {
  slug: string;
  title: string;
  group: string;
  anchor?: string;
  heading?: string;
  snippet: string;
  score: number;
}

let index: Promise<Entry[]> | null = null;

const decode = (s: string) =>
  s
    .replace(/&quot;/g, '"')
    .replace(/&#x27;|&#39;/g, "'")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&amp;/g, "&");

/** Renders every page once to static markup and keeps its text. Built lazily on first search. */
export function buildIndex(): Promise<Entry[]> {
  index ??= import("react-dom/server").then(({ renderToStaticMarkup }) =>
    PAGES.map((p) => {
      let html = "";
      try {
        html = renderToStaticMarkup(createElement(p.Body) as ReactElement);
      } catch {
        /* a page that cannot render statically is still searchable by title */
      }
      const headings = [...html.matchAll(/<h[234] id="([^"]+)"[^>]*>(.*?)<a class="hd-anchor"/g)].map((m) => ({
        id: m[1]!,
        title: decode(m[2]!.replace(/<[^>]+>/g, "")),
      }));
      const text = decode(html.replace(/<(script|style)[\s\S]*?<\/\1>/g, " ").replace(/<[^>]+>/g, " ")).replace(/\s+/g, " ").trim();
      return { slug: p.slug, title: p.title, group: p.group, summary: p.summary, keywords: (p.keywords ?? []).join(" "), headings, text };
    }),
  );
  return index;
}

export function search(entries: Entry[], query: string, limit = 8): Hit[] {
  const tokens = query.toLowerCase().split(/\s+/).filter(Boolean);
  if (!tokens.length) return [];
  const hits: Hit[] = [];
  for (const e of entries) {
    const title = e.title.toLowerCase();
    const summary = e.summary.toLowerCase();
    const kw = e.keywords.toLowerCase();
    const body = e.text.toLowerCase();
    let score = 0;
    let ok = true;
    for (const t of tokens) {
      let s = 0;
      if (title.includes(t)) s += 12;
      if (kw.includes(t)) s += 6;
      if (summary.includes(t)) s += 3;
      if (e.headings.some((h) => h.title.toLowerCase().includes(t))) s += 7;
      const n = body.split(t).length - 1;
      s += Math.min(n, 6);
      if (!s) ok = false;
      score += s;
    }
    if (!ok) continue;
    const head = e.headings.find((h) => tokens.every((t) => h.title.toLowerCase().includes(t))) ?? e.headings.find((h) => tokens.some((t) => h.title.toLowerCase().includes(t)));
    const at = body.indexOf(tokens[0]!);
    const from = Math.max(0, at - 50);
    const snippet = at >= 0 ? `${from > 0 ? "…" : ""}${e.text.slice(from, from + 150)}…` : e.summary;
    hits.push({ slug: e.slug, title: e.title, group: e.group, anchor: head?.id, heading: head?.title, snippet, score });
  }
  return hits.sort((a, b) => b.score - a.score).slice(0, limit);
}