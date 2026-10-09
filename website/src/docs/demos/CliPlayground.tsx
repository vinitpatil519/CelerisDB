import { useEffect, useRef, useState, type FormEvent, type KeyboardEvent } from "react";

import { Button, Demo } from "../kit";
import "./CliPlayground.css";

/* ------------------------------------------------------------------ *
 * A small in-browser simulation of the `celeris` CLI against one node.
 * Output formats follow crates/celeris-cli (put/get/scan/query/mutation/
 * status). Nothing here talks to a server.
 * ------------------------------------------------------------------ */

type Json = null | boolean | number | string | Json[] | { [k: string]: Json };
type JObj = { [k: string]: Json };

interface Entry {
  value: Json;
  version: number;
  mid: string;
  ts: number;
  exp: number | null;
}

interface Store {
  data: Map<string, Entry>;
  version: number;
  clock: number;
  muts: Map<string, { version: number; fp: string }>;
  seq: number;
}

type Kind = "in" | "out" | "err" | "ok" | "dim";
interface Line {
  k: Kind;
  s: string;
}
interface Result {
  out: Line[];
  code: number;
}

const T0 = 1760000000000;
const MODES = ["strict", "session", "bounded", "available", "eventual"];

/* ── helpers ──────────────────────────────────────────────────────────── */

const isObj = (v: Json | undefined): v is JObj => typeof v === "object" && v !== null && !Array.isArray(v);

function canon(v: Json): Json {
  if (Array.isArray(v)) return v.map(canon);
  if (isObj(v)) {
    const o: JObj = {};
    for (const k of Object.keys(v).sort()) o[k] = canon(v[k] as Json);
    return o;
  }
  return v;
}
const compact = (v: Json) => JSON.stringify(canon(v));
const pretty = (v: Json) => JSON.stringify(canon(v), null, 2);

function parseJson(raw: string): Json {
  try {
    return JSON.parse(raw) as Json;
  } catch (e) {
    // PowerShell 5.1 style: '{\"a\":1}'
    try {
      return JSON.parse(raw.replace(/\\"/g, '"')) as Json;
    } catch {
      throw e;
    }
  }
}

function newId(store: Store): string {
  const h = () => Math.floor(Math.random() * 0x10000).toString(16).padStart(4, "0");
  store.seq++;
  return `${h()}${h()}-${h()}-4${h().slice(1)}-a${h().slice(1)}-${h()}${h()}${h()}`;
}

const UUID_RE = /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/;

function parseDur(s: string): number | null {
  const re = /(\d+(?:\.\d+)?)\s*(ms|s|m|h|d)/gy;
  let total = 0;
  let pos = 0;
  const unit: Record<string, number> = { ms: 1, s: 1000, m: 60000, h: 3600000, d: 86400000 };
  const t = s.trim();
  if (!t) return null;
  while (pos < t.length) {
    re.lastIndex = pos;
    const m = re.exec(t);
    if (!m) return null;
    total += parseFloat(m[1]!) * unit[m[2]!]!;
    pos = re.lastIndex;
    while (t[pos] === " ") pos++;
  }
  return Math.round(total);
}

function fmtDur(ms: number): string {
  let s = Math.floor(ms / 1000);
  const parts: string[] = [];
  for (const [n, u] of [
    [86400, "d"],
    [3600, "h"],
    [60, "m"],
    [1, "s"],
  ] as [number, string][]) {
    if (s >= n) {
      parts.push(`${Math.floor(s / n)}${u}`);
      s %= n;
    }
  }
  return parts.length ? parts.join(" ") : "0s";
}

function fmtBytes(n: number): string {
  const u = ["B", "KiB", "MiB", "GiB"];
  let v = n;
  let i = 0;
  while (v >= 1024 && i < u.length - 1) {
    v /= 1024;
    i++;
  }
  return i === 0 ? `${n} B` : `${v.toFixed(1)} ${u[i]}`;
}

function tokenize(src: string): string[] | string {
  const out: string[] = [];
  let cur = "";
  let has = false;
  let q: string | null = null;
  for (let i = 0; i < src.length; i++) {
    const c = src[i]!;
    if (q) {
      if (c === q) q = null;
      else if (q === '"' && c === "\\" && (src[i + 1] === '"' || src[i + 1] === "\\")) cur += src[++i]!;
      else cur += c;
    } else if (c === "'" || c === '"') {
      q = c;
      has = true;
    } else if (c === " " || c === "\t") {
      if (has || cur) out.push(cur);
      cur = "";
      has = false;
    } else if (c === "\\" && src[i + 1] === '"') {
      cur += '"';
      i++;
      has = true;
    } else {
      cur += c;
      has = true;
    }
  }
  if (q) return `error: unterminated ${q === "'" ? "single" : "double"} quote`;
  if (has || cur) out.push(cur);
  return out;
}

interface Spec {
  val: string[];
  bool: string[];
  multi?: string[];
}
interface Args {
  pos: string[];
  o: Map<string, string[]>;
  f: Set<string>;
}
const ALIAS: Record<string, string> = { "-c": "--consistency", "-f": "--file" };

function parseArgs(tokens: string[], spec: Spec): Args | string {
  const pos: string[] = [];
  const o = new Map<string, string[]>();
  const f = new Set<string>();
  for (let i = 0; i < tokens.length; i++) {
    let t = tokens[i]!;
    if (t.startsWith("-") && t.length > 1 && !/^-\d/.test(t)) {
      let inline: string | undefined;
      if (t.startsWith("--") && t.includes("=")) {
        inline = t.slice(t.indexOf("=") + 1);
        t = t.slice(0, t.indexOf("="));
      }
      t = ALIAS[t] ?? t;
      if (spec.bool.includes(t)) f.add(t);
      else if (spec.val.includes(t)) {
        const v = inline ?? tokens[++i];
        if (v === undefined) return `error: a value is required for '${t} <VALUE>' but none was supplied`;
        if (spec.multi?.includes(t)) o.set(t, [...(o.get(t) ?? []), v]);
        else o.set(t, [v]);
      } else return `error: unexpected argument '${t}' found`;
    } else pos.push(t);
  }
  return { pos, o, f };
}

const one = (a: Args, k: string) => a.o.get(k)?.[0];

/* ── result builders ──────────────────────────────────────────────────── */

const ok = (...s: string[]): Result => ({ out: s.map((x) => ({ k: "out", s: x })), code: 0 });
const usage = (msg: string): Result => ({ out: [{ k: "err", s: msg }], code: 2 });
const fail = (msg: string, code = 1): Result => ({ out: [{ k: "err", s: msg }], code });

function apiErr(status: number, code: string, message: string, extra: string[] = []): Result {
  return {
    out: [{ k: "err", s: `error [${code}] (HTTP ${status}): ${message}` }, ...extra.map((s) => ({ k: "err" as Kind, s }))],
    code: 1,
  };
}

/* ── store ────────────────────────────────────────────────────────────── */

function live(store: Store, key: string): Entry | undefined {
  const e = store.data.get(key);
  if (!e) return undefined;
  if (e.exp !== null && e.exp <= store.clock) {
    store.data.delete(key);
    return undefined;
  }
  return e;
}

function liveKeys(store: Store): string[] {
  for (const k of [...store.data.keys()]) live(store, k);
  return [...store.data.keys()].sort();
}

function seedStore(): Store {
  const s: Store = { data: new Map(), version: 0, clock: 0, muts: new Map(), seq: 0 };
  const put = (key: string, value: Json, ttl: number | null = null) => {
    s.version++;
    s.seq++;
    s.data.set(key, {
      value,
      version: s.version,
      mid: `00000000-0000-4000-8000-${String(s.seq).padStart(12, "0")}`,
      ts: T0,
      exp: ttl === null ? null : ttl,
    });
  };
  put("users/1", { name: "Ada", plan: "pro", age: 36 });
  put("users/2", { name: "Grace", plan: "free", age: 29 });
  put("users/3", { name: "Linus", plan: "team", age: 41 });
  put("orders/1001", { customer: { id: 1, tier: "gold" }, status: "paid", total: 120 });
  put("orders/1002", { customer: { id: 2, tier: "silver" }, status: "paid", total: 45 });
  put("orders/1003", { customer: { id: 1, tier: "gold" }, status: "pending", total: 300 });
  put("orders/1004", { customer: { id: 3, tier: "gold" }, status: "paid", total: 250 });
  put("orders/1005", { customer: { id: 2, tier: "silver" }, status: "refunded", total: 80 });
  put("orders/1006", { customer: { id: 3, tier: "gold" }, status: "pending", total: 15 });
  put("sessions/abc", "token-abc", 10 * 60000);
  put("sessions/def", "token-def", 60 * 60000);
  return s;
}

/* ── query engine ─────────────────────────────────────────────────────── */

function getPath(v: Json, path: string): Json | undefined {
  let cur: Json | undefined = v;
  for (const seg of path.split(".")) {
    if (Array.isArray(cur)) cur = /^\d+$/.test(seg) ? cur[Number(seg)] : undefined;
    else if (isObj(cur)) cur = cur[seg];
    else return undefined;
    if (cur === undefined) return undefined;
  }
  return cur;
}

function setPath(target: JObj, path: string, value: Json) {
  const segs = path.split(".");
  let cur = target;
  segs.forEach((seg, i) => {
    if (i === segs.length - 1) cur[seg] = value;
    else {
      const next = cur[seg];
      if (isObj(next)) cur = next;
      else {
        const created: JObj = {};
        cur[seg] = created;
        cur = created;
      }
    }
  });
}

function deepEq(a: Json, b: Json): boolean {
  return JSON.stringify(canon(a)) === JSON.stringify(canon(b));
}

function cmp(a: Json, b: Json): number | null {
  if (typeof a === "number" && typeof b === "number") return a - b;
  if (typeof a === "string" && typeof b === "string") return a < b ? -1 : a > b ? 1 : 0;
  return null;
}

const OPS = ["$eq", "$ne", "$gt", "$gte", "$lt", "$lte", "$in", "$nin", "$exists", "$prefix", "$contains"];

function validateFilter(f: Json, depth = 0): void {
  if (!isObj(f)) throw new Error("a filter must be a JSON object");
  if (depth > 16) throw new Error("filter nests deeper than 16 levels");
  for (const [k, c] of Object.entries(f)) {
    if (k === "$and" || k === "$or") {
      if (!Array.isArray(c)) throw new Error(`${k} takes an array of filters`);
      c.forEach((x) => validateFilter(x, depth + 1));
    } else if (k === "$not") validateFilter(c, depth + 1);
    else if (k.startsWith("$")) throw new Error(`unknown operator \`${k}\``);
    else if (isObj(c) && Object.keys(c).length && Object.keys(c).every((x) => x.startsWith("$"))) {
      for (const [op, arg] of Object.entries(c)) {
        if (!OPS.includes(op)) throw new Error(`unknown operator \`${op}\``);
        if ((op === "$in" || op === "$nin") && (!Array.isArray(arg) || arg.length > 1000))
          throw new Error(`${op} takes an array of at most 1000 values`);
        if (op === "$exists" && typeof arg !== "boolean") throw new Error("$exists takes true or false");
      }
    }
  }
}

function matches(v: Json, f: JObj): boolean {
  for (const [k, c] of Object.entries(f)) {
    if (k === "$and") {
      if (!(c as Json[]).every((x) => matches(v, x as JObj))) return false;
    } else if (k === "$or") {
      if (!(c as Json[]).some((x) => matches(v, x as JObj))) return false;
    } else if (k === "$not") {
      if (matches(v, c as JObj)) return false;
    } else {
      const field = getPath(v, k);
      if (isObj(c) && Object.keys(c).length && Object.keys(c).every((x) => x.startsWith("$"))) {
        for (const [op, arg] of Object.entries(c)) if (!applyOp(field, op, arg as Json)) return false;
      } else if (field === undefined || !deepEq(field, c)) return false;
    }
  }
  return true;
}

function applyOp(field: Json | undefined, op: string, arg: Json): boolean {
  switch (op) {
    case "$ne":
      return field === undefined || !deepEq(field, arg);
    case "$nin":
      return field === undefined || !(arg as Json[]).some((x) => deepEq(field, x));
    case "$exists":
      return (field !== undefined) === arg;
  }
  if (field === undefined) return false;
  switch (op) {
    case "$eq":
      return deepEq(field, arg);
    case "$in":
      return (arg as Json[]).some((x) => deepEq(field, x));
    case "$prefix":
      return typeof field === "string" && typeof arg === "string" && field.startsWith(arg);
    case "$contains":
      if (Array.isArray(field)) return field.some((x) => deepEq(x, arg));
      return typeof field === "string" && typeof arg === "string" && field.includes(arg);
  }
  const c = cmp(field, arg);
  if (c === null) return false;
  return op === "$gt" ? c > 0 : op === "$gte" ? c >= 0 : op === "$lt" ? c < 0 : c <= 0;
}

/* ── commands ─────────────────────────────────────────────────────────── */

function checkMode(raw: string | undefined, forWrite: boolean): { mode: string } | Result {
  const mode = (raw ?? "strict").toLowerCase();
  if (!MODES.includes(mode))
    return apiErr(
      400,
      "invalid_consistency",
      `unknown consistency mode \`${raw}\` (expected strict, session, bounded, available or eventual)`,
    );
  if (forWrite && mode === "bounded")
    return apiErr(
      400,
      "invalid_consistency",
      "bounded applies to reads only; writes accept strict, session, available or eventual",
    );
  return { mode };
}

function checkKey(key: string | undefined): Result | null {
  if (key === undefined || key === "") return key === undefined ? usage("error: the following required argument was not provided: <KEY>") : apiErr(400, "invalid_key", "key must not be empty");
  const n = new TextEncoder().encode(key).length;
  if (n > 1024) return apiErr(400, "invalid_key", `key is ${n} bytes; maximum is 1024`);
  return null;
}

function write(store: Store, op: "put" | "delete", tokens: string[]): Result {
  const spec: Spec =
    op === "put"
      ? { val: ["--ttl", "--if-version", "--mutation-id", "--consistency", "--file"], bool: ["--if-absent", "--json"] }
      : { val: ["--if-version", "--mutation-id", "--consistency"], bool: ["--json"] };
  const a = parseArgs(tokens, spec);
  if (typeof a === "string") return usage(a);
  const [key, raw, extra] = a.pos;
  const keyErr = checkKey(key);
  if (keyErr) return keyErr;
  if (extra !== undefined || (op === "delete" && raw !== undefined)) return usage(`error: unexpected argument '${extra ?? raw}' found`);

  let value: Json = null;
  if (op === "put") {
    if (one(a, "--file") !== undefined) return fail("error: --file is not available in the playground; pass the JSON value as an argument");
    if (raw === undefined) return fail("error: missing value: pass JSON as an argument, or --file <path|->");
    try {
      value = parseJson(raw);
    } catch {
      return fail("error: value must be JSON (strings need quotes, e.g. '\"hello\"')");
    }
  }
  let ifVersion: number | undefined;
  const iv = one(a, "--if-version");
  if (iv !== undefined) {
    if (!/^\d+$/.test(iv)) return usage(`error: invalid value '${iv}' for '--if-version <IF_VERSION>': invalid digit found in string`);
    ifVersion = Number(iv);
  }
  const ifAbsent = a.f.has("--if-absent");
  if (ifAbsent && ifVersion !== undefined)
    return usage("error: the argument '--if-absent' cannot be used with '--if-version <IF_VERSION>'");
  let ttl: number | null = null;
  const tv = one(a, "--ttl");
  if (tv !== undefined) {
    const d = parseDur(tv);
    if (d === null) return usage(`error: invalid value '${tv}' for '--ttl <TTL>': expected a duration such as 30s, 10m or 1h`);
    if (d < 1) return apiErr(400, "invalid_argument", "ttl_ms must be at least 1");
    ttl = d;
  }
  const m = checkMode(one(a, "--consistency"), true);
  if ("out" in m) return m;
  let mid = one(a, "--mutation-id");
  if (mid !== undefined && !UUID_RE.test(mid))
    return usage(`error: invalid value '${mid}' for '--mutation-id <MUTATION_ID>': expected a UUID such as 3f2b8c1e-5d4a-4c7e-9b1a-0a1b2c3d4e5f`);
  mid = (mid ?? newId(store)).toLowerCase();

  const fp = JSON.stringify([op, key, value === null && op === "delete" ? null : canon(value), ttl, ifVersion ?? null, ifAbsent]);
  const prior = store.muts.get(mid);
  let version: number;
  let dedup = false;
  if (prior) {
    if (prior.fp !== fp)
      return apiErr(422, "mutation_id_reused", `mutation id ${mid} was already used for a different mutation`, [
        "  outcome: not applied",
        `  mutation: ${mid}`,
      ]);
    version = prior.version;
    dedup = true;
  } else {
    const cur = live(store, key!);
    if (ifVersion !== undefined && cur?.version !== ifVersion)
      return apiErr(
        409,
        "condition_failed",
        `condition \`version == ${ifVersion}\` failed for key \`${key}\`: current version is ${cur ? cur.version : "absent"}`,
        ["  outcome: not applied", `  current version: ${cur ? cur.version : "null"}`, `  mutation: ${mid}`],
      );
    if (ifAbsent && cur)
      return apiErr(
        409,
        "condition_failed",
        `condition \`absent\` failed for key \`${key}\`: current version is ${cur.version}`,
        ["  outcome: not applied", `  current version: ${cur.version}`, `  mutation: ${mid}`],
      );
    version = ++store.version;
    if (op === "put") store.data.set(key!, { value, version, mid, ts: T0 + store.clock, exp: ttl === null ? null : store.clock + ttl });
    else store.data.delete(key!);
    store.muts.set(mid, { version, fp });
  }
  if (a.f.has("--json"))
    return ok(...pretty({ consistency: m.mode, deduplicated: dedup, key: key!, mutation_id: mid, version }).split("\n"));
  const r = ok(`OK version=${version} mutation=${mid}${dedup ? "  (already committed; retry was deduplicated)" : ""}`);
  r.out[0]!.k = "ok";
  return r;
}

function read(store: Store, tokens: string[]): Result {
  const a = parseArgs(tokens, { val: ["--consistency", "--max-staleness"], bool: ["--json"] });
  if (typeof a === "string") return usage(a);
  const [key, extra] = a.pos;
  const keyErr = checkKey(key);
  if (keyErr) return keyErr;
  if (extra !== undefined) return usage(`error: unexpected argument '${extra}' found`);
  const m = checkMode(one(a, "--consistency"), false);
  if ("out" in m) return m;
  const ms = one(a, "--max-staleness");
  let bound: number | null = null;
  if (ms !== undefined) {
    bound = parseDur(ms);
    if (bound === null) return usage(`error: invalid value '${ms}' for '--max-staleness <MAX_STALENESS>': expected a duration such as 500ms`);
  }
  if (m.mode === "bounded" && bound === null) return apiErr(400, "invalid_argument", "bounded reads require max_staleness_ms");
  if (m.mode !== "bounded" && bound !== null)
    return apiErr(400, "invalid_argument", "max_staleness_ms only applies to consistency=bounded");
  const e = live(store, key!);
  if (!e) return fail(`not found: ${key}`, 4);
  if (a.f.has("--json")) {
    const body: JObj = {
      consistency: m.mode,
      expires_at_ms: e.exp === null ? null : T0 + e.exp,
      key: key!,
      mutation_id: e.mid,
      timestamp_ms: e.ts,
      value: e.value,
      version: e.version,
    };
    if (m.mode === "bounded") body.staleness_ms = 0;
    return ok(...pretty(body).split("\n"));
  }
  return ok(...pretty(e.value).split("\n"));
}

function rangeKeys(store: Store, prefix: string | undefined, after: string | undefined): string[] {
  return liveKeys(store).filter((k) => (prefix === undefined || k.startsWith(prefix)) && (after === undefined || k > after));
}

function scan(store: Store, tokens: string[]): Result {
  const a = parseArgs(tokens, { val: ["--prefix", "--after", "--limit"], bool: ["--json"] });
  if (typeof a === "string") return usage(a);
  if (a.pos.length) return usage(`error: unexpected argument '${a.pos[0]}' found`);
  const lim = one(a, "--limit");
  let limit = 100;
  if (lim !== undefined) {
    if (!/^\d+$/.test(lim)) return usage(`error: invalid value '${lim}' for '--limit <LIMIT>': invalid digit found in string`);
    limit = Number(lim);
    if (limit < 1 || limit > 1000) return apiErr(400, "invalid_argument", "limit must be between 1 and 1000");
  }
  const prefix = one(a, "--prefix");
  const keys = rangeKeys(store, prefix, one(a, "--after"));
  const page = keys.slice(0, limit);
  const cursor = keys.length > limit ? page[page.length - 1]! : null;
  const out: Line[] = [];
  if (a.f.has("--json")) {
    const body: JObj = {
      consistency: "strict",
      items: page.map((k) => {
        const e = store.data.get(k)!;
        return { expires_at_ms: e.exp === null ? null : T0 + e.exp, key: k, value: e.value, version: e.version };
      }),
      next_cursor: cursor,
    };
    return ok(...pretty(body).split("\n"));
  }
  for (const k of page) out.push({ k: "out", s: `${k}\t${compact(store.data.get(k)!.value)}` });
  if (cursor !== null) out.push({ k: "dim", s: `-- more: celeris scan${prefix ? ` --prefix ${prefix}` : ""} --after ${cursor}` });
  return { out, code: 0 };
}

interface Aggs {
  count: boolean;
  sum: string[];
  min: string[];
  max: string[];
}

function query(store: Store, tokens: string[]): Result {
  const a = parseArgs(tokens, {
    val: ["--prefix", "--where", "--fields", "--limit", "--max-scanned", "--after", "--sort", "--sum", "--min", "--max", "--consistency"],
    bool: ["--all", "--count", "--json"],
    multi: ["--sum", "--min", "--max"],
  });
  if (typeof a === "string") return usage(a);
  if (a.pos.length) return usage(`error: unexpected argument '${a.pos[0]}' found`);
  if (one(a, "--sort") !== undefined)
    return fail("playground: --sort needs a secondary index declared on the field, which this simulation does not model");
  const m = checkMode(one(a, "--consistency"), false);
  if ("out" in m) return m;
  const int = (flag: string, def: number, lo: number, hi: number): number | Result => {
    const raw = one(a, flag);
    if (raw === undefined) return def;
    if (!/^\d+$/.test(raw)) return usage(`error: invalid value '${raw}' for '${flag} <N>': invalid digit found in string`);
    const n = Number(raw);
    if (n < lo || n > hi) return apiErr(400, "invalid_argument", `${flag.slice(2).replace("-", "_")} must be between ${lo} and ${hi}`);
    return n;
  };
  const limit = int("--limit", 100, 1, 1000);
  if (typeof limit !== "number") return limit;
  const maxScanned = int("--max-scanned", 10000, 1, 100000);
  if (typeof maxScanned !== "number") return maxScanned;

  let filter: JObj | null = null;
  const w = one(a, "--where");
  if (w !== undefined) {
    let parsed: Json;
    try {
      parsed = parseJson(w);
    } catch (e) {
      return fail(`error: --where is not valid JSON: ${(e as Error).message}`);
    }
    try {
      validateFilter(parsed);
    } catch (e) {
      return apiErr(400, "invalid_filter", (e as Error).message);
    }
    filter = parsed as JObj;
  }
  const fields = (one(a, "--fields") ?? "").split(",").filter(Boolean);
  const aggs: Aggs = {
    count: a.f.has("--count"),
    sum: a.o.get("--sum") ?? [],
    min: a.o.get("--min") ?? [],
    max: a.o.get("--max") ?? [],
  };
  const isAgg = aggs.count || aggs.sum.length > 0 || aggs.min.length > 0 || aggs.max.length > 0;
  const all = a.f.has("--all");
  const json = a.f.has("--json");
  const prefix = one(a, "--prefix");

  const out: Line[] = [];
  let after = one(a, "--after");
  let matched = 0;
  let scanned = 0;
  let count = 0;
  const sums = new Map<string, number | null>();
  const mins = new Map<string, Json | null>();
  const maxs = new Map<string, Json | null>();
  const better = (x: Json, y: Json) => {
    // numbers order before strings
    if (typeof x === "number" && typeof y === "number") return x - y;
    if (typeof x === "string" && typeof y === "string") return x < y ? -1 : x > y ? 1 : 0;
    return typeof x === "number" ? -1 : 1;
  };

  for (;;) {
    const rows = rangeKeys(store, prefix, after);
    let seen = 0;
    let last: string | null = null;
    const items: JObj[] = [];
    let next: string | null = null;
    for (const k of rows) {
      if (seen >= maxScanned || (!isAgg && items.length >= limit)) {
        next = last;
        break;
      }
      seen++;
      last = k;
      const e = store.data.get(k)!;
      if (filter && !matches(e.value, filter)) continue;
      if (isAgg) {
        count++;
        for (const f of aggs.sum) {
          const v = getPath(e.value, f);
          if (typeof v === "number") sums.set(f, (sums.get(f) ?? 0) + v);
          else if (!sums.has(f)) sums.set(f, null);
        }
        for (const [list, map, want] of [
          [aggs.min, mins, -1],
          [aggs.max, maxs, 1],
        ] as [string[], Map<string, Json | null>, number][])
          for (const f of list) {
            const v = getPath(e.value, f);
            if (typeof v !== "number" && typeof v !== "string") {
              if (!map.has(f)) map.set(f, null);
              continue;
            }
            const cur = map.get(f);
            if (cur === undefined || cur === null || Math.sign(better(v, cur)) === want) map.set(f, v);
          }
      } else {
        let shown: Json = e.value;
        if (fields.length) {
          const p: JObj = {};
          for (const f of fields) {
            const v = getPath(e.value, f);
            if (v !== undefined) setPath(p, f, v);
          }
          shown = p;
        }
        items.push({ expires_at_ms: e.exp === null ? null : T0 + e.exp, key: k, value: shown, version: e.version });
        matched++;
        if (!json) out.push({ k: "out", s: `${k}\t${compact(shown)}` });
      }
    }
    scanned += seen;
    if (json) {
      const body: JObj = { consistency: m.mode, index: null, items, next_cursor: next, partial: false, scanned: seen };
      if (isAgg) body.aggregates = aggJson();
      out.push(...pretty(body).split("\n").map((s) => ({ k: "out" as Kind, s })));
    }
    after = next ?? undefined;
    if (next !== null && !all) {
      if (!json) {
        if (isAgg) {
          out.push(...pretty(aggJson()).split("\n").map((s) => ({ k: "out" as Kind, s })));
          out.push({ k: "dim", s: "-- partial: the range is not done; use --all for totals" });
        }
        out.push({ k: "dim", s: `-- more: add --after ${next} (or use --all)` });
      }
      return { out, code: 0 };
    }
    if (next === null) break;
  }
  if (!json) {
    if (isAgg) {
      out.push(...pretty(aggJson()).split("\n").map((s) => ({ k: "out" as Kind, s })));
      out.push({ k: "dim", s: `-- ${scanned} scanned` });
    } else out.push({ k: "dim", s: `-- ${matched} matched, ${scanned} scanned` });
  }
  return { out, code: 0 };

  function aggJson(): JObj {
    const o: JObj = {};
    if (aggs.count) o.count = count;
    if (aggs.sum.length) o.sum = Object.fromEntries(aggs.sum.map((f) => [f, sums.get(f) ?? null]));
    if (aggs.min.length) o.min = Object.fromEntries(aggs.min.map((f) => [f, mins.get(f) ?? null]));
    if (aggs.max.length) o.max = Object.fromEntries(aggs.max.map((f) => [f, maxs.get(f) ?? null]));
    return o;
  }
}

function mutation(store: Store, tokens: string[]): Result {
  const a = parseArgs(tokens, { val: [], bool: ["--json"] });
  if (typeof a === "string") return usage(a);
  const id = a.pos[0];
  if (!id) return usage("error: the following required argument was not provided: <ID>");
  if (!UUID_RE.test(id)) return usage(`error: invalid value '${id}' for '<ID>': expected a UUID`);
  const rec = store.muts.get(id.toLowerCase());
  if (rec) {
    if (a.f.has("--json")) return ok(...pretty({ status: "committed", version: rec.version }).split("\n"));
    return ok(`committed at version ${rec.version}`);
  }
  if (a.f.has("--json")) return { out: pretty({ status: "unknown" }).split("\n").map((s) => ({ k: "out" as Kind, s })), code: 4 };
  return {
    out: [{ k: "out", s: "unknown: the mutation did not commit, is still in flight, or is older than the retention window" }],
    code: 4,
  };
}

function status(store: Store, tokens: string[]): Result {
  const a = parseArgs(tokens, { val: [], bool: ["--json"] });
  if (typeof a === "string") return usage(a);
  const keys = liveKeys(store);
  const mem = keys.reduce((n, k) => n + k.length + compact(store.data.get(k)!.value).length + 24, 0);
  if (a.f.has("--json"))
    return ok(
      ...pretty({
        cluster: { mode: "single-node", nodes: [{ id: "sim-node", self: true, state: "alive" }] },
        health: "ok",
        node_id: "sim-node",
        storage: { l0_tables: 0, l1_tables: 0, last_version: store.version, memtable_bytes: mem, table_bytes: 0 },
        uptime_secs: Math.floor(store.clock / 1000),
        version: "0.1.0",
      }).split("\n"),
    );
  return ok(
    "node       sim-node (ok)",
    "version    0.1.0",
    `uptime     ${fmtDur(store.clock)}`,
    "cluster    single-node, 1 node(s)",
    `storage    version ${store.version}  tables L0=0 L1=0  0 B on disk  memtable ${fmtBytes(mem)}`,
  );
}

const HELP = `Playground commands (a subset of the real CLI):
  put <key> <json> [--ttl 10m] [--if-version N | --if-absent] [--mutation-id UUID] [-c mode]
  get <key> [-c mode] [--max-staleness 500ms]
  delete <key> [--if-version N] [--mutation-id UUID]
  scan [--prefix p] [--after cursor] [--limit N]
  query [--prefix p] [--where JSON] [--fields a,b.c] [--limit N] [--max-scanned N] [--all]
        [--count] [--sum f] [--min f] [--max f]
  mutation <uuid>
  status
Add --json to put, get, delete, scan, query, mutation or status for raw responses.
Playground only:
  wait <duration>   advance the simulated clock (30s, 10m, 1h) so TTLs can expire
  reset             restore the sample data
  clear             clear the screen
  help              this text
Strings need JSON quotes: put greeting '"hello"'`;

function run(store: Store, line: string): Result | "clear" | "reset" {
  const toks = tokenize(line);
  if (typeof toks === "string") return fail(toks, 2);
  if (toks[0] === "$") toks.shift();
  if (toks[0]?.toLowerCase() === "celeris") toks.shift();
  const cmd = toks.shift();
  if (cmd === undefined) return ok();
  switch (cmd) {
    case "clear":
    case "cls":
      return "clear";
    case "reset":
      return "reset";
    case "help":
    case "--help":
    case "-h":
      return ok(...HELP.split("\n"));
    case "--version":
    case "-V":
      return ok("celeris 0.1.0");
    case "put":
      return write(store, "put", toks);
    case "delete":
      return write(store, "delete", toks);
    case "get":
      return read(store, toks);
    case "scan":
      return scan(store, toks);
    case "query":
      return query(store, toks);
    case "mutation":
      return mutation(store, toks);
    case "status":
      return status(store, toks);
    case "wait": {
      const d = parseDur(toks.join(" "));
      if (d === null || d < 1) return usage("usage: wait <duration>, for example: wait 30s");
      store.clock += d;
      const dropped = liveKeys(store).length;
      return { out: [{ k: "dim", s: `(simulated clock +${fmtDur(d)}; now t+${fmtDur(store.clock)}; ${dropped} live key(s))` }], code: 0 };
    }
    case "init":
    case "start":
    case "stop":
    case "doctor":
    case "node":
    case "cluster":
    case "partitions":
    case "conflicts":
    case "bench":
    case "benchmark":
    case "token":
    case "backup":
    case "restore":
    case "export":
    case "import":
      return fail(`${cmd}: real command, but not simulated here. It runs against a real node (see the Installation page).`);
    default:
      return usage(`error: unrecognized subcommand '${cmd}'\nType help for the commands this playground supports.`);
  }
}

/* ── UI ───────────────────────────────────────────────────────────────── */

const WELCOME: Line[] = [
  { k: "dim", s: "CelerisDB CLI playground (browser simulation, one node). Sample data is loaded:" },
  { k: "dim", s: "users/1..3, orders/1001..1006, sessions/abc, sessions/def. Type help, or click a command below." },
];

const EXAMPLES: string[] = [
  "scan --prefix users/",
  "get users/1 --json",
  `put users/4 '{"name":"Alan","plan":"free"}' --if-absent`,
  `put users/1 '{"name":"Ada","plan":"team"}' --if-version 1`,
  `put cache/x '"hot"' --ttl 30s`,
  "wait 31s",
  "get users/9 -c bounded --max-staleness 500ms",
  `query --prefix orders/ --where '{"status":"paid","total":{"$gte":100}}'`,
  `query --prefix orders/ --where '{"status":{"$in":["paid","pending"]}}' --count --sum total --max total --all`,
  `query --prefix orders/ --where '{"customer.tier":"gold"}' --fields total,customer.id`,
  "status",
];

const ID_A = "11111111-1111-4111-8111-111111111111";

interface Challenge {
  title: string;
  teaches: string;
  steps: { cmd: string; why: string }[];
}

const CHALLENGES: Challenge[] = [
  {
    title: "1. A compare-and-set conflict",
    teaches: "Conditional writes protect you from overwriting a change you have not seen.",
    steps: [
      { cmd: "get users/1 --json", why: "Note the version of users/1. A version is the commit that last wrote the key." },
      { cmd: `put users/1 '{"name":"Ada","plan":"team"}' --if-version 1`, why: "The condition holds, so the write commits and the key gets a new version." },
      { cmd: `put users/1 '{"name":"Ada","plan":"free"}' --if-version 1`, why: "A second writer still holds version 1. It fails with condition_failed, outcome not applied, and tells you the current version." },
    ],
  },
  {
    title: "2. An idempotent retry",
    teaches: "Reusing a mutation ID makes a retry safe: the write never applies twice.",
    steps: [
      { cmd: `put orders/2001 '{"status":"new","total":42}' --mutation-id ${ID_A}`, why: "First attempt commits and reports a version." },
      { cmd: `put orders/2001 '{"status":"new","total":42}' --mutation-id ${ID_A}`, why: "Same ID, same payload: the original outcome comes back, marked as deduplicated. Nothing new is written." },
      { cmd: `put orders/2001 '{"status":"new","total":99}' --mutation-id ${ID_A}`, why: "Same ID with a different payload is rejected (mutation_id_reused). An ID names exactly one mutation." },
      { cmd: `mutation ${ID_A}`, why: "After a timeout, this is how you ask whether a write committed." },
    ],
  },
  {
    title: "3. A key that expires",
    teaches: "TTLs are absolute times. Expired keys vanish from reads, scans and queries.",
    steps: [
      { cmd: `put session/tmp '"hello"' --ttl 30s`, why: "Write a value that lives for 30 simulated seconds." },
      { cmd: "get session/tmp --json", why: "expires_at_ms shows the absolute expiry time." },
      { cmd: "wait 31s", why: "Advance the simulated clock past the TTL." },
      { cmd: "get session/tmp", why: "Not found, exit code 4. The key is gone from the point of view of every read." },
    ],
  },
  {
    title: "4. Filter and aggregate on the node",
    teaches: "Queries filter JSON values where the data lives and can total the matches.",
    steps: [
      { cmd: `query --prefix orders/ --where '{"status":"paid"}'`, why: "Plain equality on a field." },
      { cmd: `query --prefix orders/ --where '{"status":"paid","total":{"$gte":100}}' --fields total`, why: "Conditions are ANDed. --fields trims the returned value." },
      { cmd: `query --prefix orders/ --where '{"status":"paid"}' --count --sum total --min total --max total --all`, why: "Aggregates instead of rows. --all follows cursors to the end." },
      { cmd: `query --prefix orders/ --max-scanned 2`, why: "Each request reads at most max-scanned rows, so you get a cursor. This is paging." },
    ],
  },
  {
    title: "5. Pick a consistency mode per request",
    teaches: "Every response reports the mode that was applied. bounded needs a staleness bound.",
    steps: [
      { cmd: `put flags/beta 'true' -c eventual`, why: "Writes accept strict, session, available or eventual." },
      { cmd: "get flags/beta --json -c session", why: "The response body names the applied consistency." },
      { cmd: "get flags/beta -c bounded", why: "bounded without a bound is refused." },
      { cmd: "get flags/beta -c bounded --max-staleness 500ms --json", why: "With a bound it works, and staleness_ms is reported. On one node it is 0." },
    ],
  },
];

export function CliPlayground() {
  const storeRef = useRef<Store | null>(null);
  if (storeRef.current === null) storeRef.current = seedStore();
  const [lines, setLines] = useState<Line[]>(WELCOME);
  const [input, setInput] = useState("");
  const [hist, setHist] = useState<string[]>([]);
  const [hIdx, setHIdx] = useState(-1);
  const [clock, setClock] = useState(0);
  const termRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    const el = termRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [lines]);

  const exec = (raw: string) => {
    const line = raw.trim();
    if (!line) return;
    const store = storeRef.current!;
    const res = run(store, line);
    setHist((h) => (h[h.length - 1] === line ? h : [...h, line]));
    setHIdx(-1);
    setInput("");
    if (res === "clear") {
      setLines([]);
      return;
    }
    if (res === "reset") {
      storeRef.current = seedStore();
      setClock(0);
      setLines([...WELCOME, { k: "in", s: line }, { k: "dim", s: "sample data restored, clock back to t+0s" }]);
      return;
    }
    const extra: Line[] = res.code !== 0 ? [{ k: "dim", s: `exit ${res.code}` }] : [];
    setLines((l) => [...l, { k: "in", s: line }, ...res.out, ...extra]);
    setClock(store.clock);
  };

  const onSubmit = (e: FormEvent) => {
    e.preventDefault();
    exec(input);
  };

  const onKey = (e: KeyboardEvent<HTMLInputElement>) => {
    if (e.key === "ArrowUp") {
      if (!hist.length) return;
      e.preventDefault();
      const i = hIdx === -1 ? hist.length - 1 : Math.max(0, hIdx - 1);
      setHIdx(i);
      setInput(hist[i] ?? "");
    } else if (e.key === "ArrowDown") {
      if (hIdx === -1) return;
      e.preventDefault();
      if (hIdx >= hist.length - 1) {
        setHIdx(-1);
        setInput("");
      } else {
        setHIdx(hIdx + 1);
        setInput(hist[hIdx + 1] ?? "");
      }
    }
  };

  const runChip = (cmd: string) => {
    exec(cmd);
    inputRef.current?.focus({ preventScroll: true });
  };

  return (
    <>
      <Demo
        title="celeris CLI playground"
        note="A simulation: a small engine in your browser mimics the CLI's commands and output formats on one node. Nothing is sent anywhere, and replication, auth and secondary indexes are not modelled."
        controls={
          <>
            <span className="cp-clock" aria-label="Simulated clock">
              clock t+{fmtDur(clock)}
            </span>
            <Button onClick={() => exec("wait 10s")}>+10s</Button>
            <Button onClick={() => exec("wait 1m")}>+1m</Button>
            <Button onClick={() => exec("reset")}>Reset</Button>
          </>
        }
      >
        <div className="cp">
          <div
            ref={termRef}
            className="cp-term"
            role="log"
            aria-live="polite"
            aria-label="Terminal output"
            onClick={() => inputRef.current?.focus({ preventScroll: true })}
          >
            {lines.map((l, i) => (
              <div key={i} className={`cp-line cp-${l.k}`}>
                {l.k === "in" ? (
                  <>
                    <span className="cp-ps">$ celeris </span>
                    {l.s}
                  </>
                ) : (
                  l.s
                )}
              </div>
            ))}
          </div>
          <form className="cp-form" onSubmit={onSubmit}>
            <label htmlFor="cp-input" className="cp-ps">
              $ celeris
            </label>
            <input
              id="cp-input"
              ref={inputRef}
              className="cp-input"
              value={input}
              onChange={(e) => {
                setInput(e.target.value);
                setHIdx(-1);
              }}
              onKeyDown={onKey}
              placeholder="get users/1"
              autoComplete="off"
              autoCapitalize="off"
              autoCorrect="off"
              spellCheck={false}
              aria-label="celeris command"
            />
            <button type="submit" className="dbtn primary">
              Run
            </button>
          </form>
          <p className="cp-hint">
            Press the up and down arrow keys to recall earlier commands. Click any example to run it.
          </p>
          <div className="cp-chips" role="group" aria-label="Example commands">
            {EXAMPLES.map((c) => (
              <button key={c} type="button" className="cp-chip" onClick={() => runChip(c)} title="Run this command">
                {c}
              </button>
            ))}
          </div>
        </div>
      </Demo>

      <div className="cp-challenges">
        {CHALLENGES.map((c) => (
          <section key={c.title} className="cp-challenge" aria-label={c.title}>
            <h4>{c.title}</h4>
            <p>{c.teaches}</p>
            <ol>
              {c.steps.map((s) => (
                <li key={s.cmd}>
                  <button type="button" className="cp-chip" onClick={() => runChip(s.cmd)} title="Run this command in the playground">
                    {s.cmd}
                  </button>
                  <span className="cp-why">{s.why}</span>
                </li>
              ))}
            </ol>
          </section>
        ))}
      </div>
    </>
  );
}
