import { useMemo, useState } from "react";

import { Button, Code, Demo, OsCode, Tabs } from "../kit";
import "./QueryBuilder.css";

/**
 * Evaluates the generated filter in the browser using the documented query
 * semantics (docs/API.md "POST /v1/query"): dotted paths, numbers compare by
 * value, comparisons only between two numbers or two strings, $ne/$nin match
 * missing fields, $and/$or/$not, sort through a ready index. The dataset is
 * made up.
 */

type J = null | boolean | number | string | J[] | { [k: string]: J };
type Doc = { [k: string]: J };

const DATA: [string, Doc][] = [
  ["orders/0001", { status: "paid", total: 120, customer: { id: 7, name: "Ada", tier: "gold" }, tags: ["gift", "express"], created: "2026-01-02" }],
  ["orders/0002", { status: "pending", total: 35.5, customer: { id: 9, name: "Bo", tier: "basic" }, tags: [], created: "2026-01-03" }],
  ["orders/0003", { status: "paid", total: 990, customer: { id: 7, name: "Ada", tier: "gold" }, tags: ["wholesale"], created: "2026-01-05" }],
  ["orders/0004", { status: "void", total: 60, customer: { id: 12, name: "Cy", tier: "basic" }, tags: ["gift"], created: "2026-01-06", refund: true }],
  ["orders/0005", { status: "paid", total: 100, customer: { id: 15, name: "Dee", tier: "platinum" }, tags: ["express"], created: "2026-01-09" }],
  ["orders/0006", { status: "shipped", total: 250, customer: { id: 9, name: "Bo", tier: "basic" }, tags: ["wholesale", "express"], created: "2026-01-11" }],
  ["orders/0007", { status: "paid", total: 18, customer: { id: 21, name: "Eli", tier: "basic" }, tags: [], created: "2026-01-12" }],
  ["orders/0008", { status: "pending", total: 410, customer: { id: 15, name: "Dee", tier: "platinum" }, tags: ["gift"], created: "2026-01-14" }],
  ["orders/0009", { status: "paid", total: 75.25, customer: { id: 30, name: "Fay", tier: "gold" }, tags: ["gift", "wholesale"], created: "2026-01-15" }],
  ["orders/0010", { status: "shipped", total: 100, customer: { id: 7, name: "Ada", tier: "gold" }, tags: ["express"], created: "2026-01-18" }],
  ["orders/0011", { status: "paid", total: "n/a", customer: { id: 44, name: "Gus" }, tags: [], created: "2026-01-20" }],
  ["orders/0012", { status: "void", customer: { id: 12, name: "Cy", tier: "basic" }, tags: ["gift"], created: "2026-01-21" }],
  ["users/1", { name: "Ada", tier: "gold" }],
];

const FIELDS = ["status", "total", "customer.tier", "customer.name", "customer.id", "tags", "created", "refund"];
const OPS: { id: string; label: string }[] = [
  { id: "$eq", label: "= (equals)" },
  { id: "$ne", label: "$ne" },
  { id: "$gt", label: "$gt" },
  { id: "$gte", label: "$gte" },
  { id: "$lt", label: "$lt" },
  { id: "$lte", label: "$lte" },
  { id: "$in", label: "$in" },
  { id: "$nin", label: "$nin" },
  { id: "$exists", label: "$exists" },
  { id: "$prefix", label: "$prefix" },
  { id: "$contains", label: "$contains" },
];

interface Index {
  name: string;
  prefix: string;
  field: string;
  order: "asc" | "desc";
}
const INDEXES: Index[] = [
  { name: "orders_by_status", prefix: "orders/", field: "status", order: "asc" },
  { name: "orders_by_total", prefix: "orders/", field: "total", order: "asc" },
  { name: "orders_by_total_desc", prefix: "orders/", field: "total", order: "desc" },
];

interface Row {
  id: number;
  field: string;
  op: string;
  value: string;
}

/* ---- value parsing and filter generation ---------------------------------- */

function parseScalar(text: string): J {
  const t = text.trim();
  if (/^-?\d+(\.\d+)?$/.test(t)) return Number(t);
  if (t === "true") return true;
  if (t === "false") return false;
  if (t === "null") return null;
  if (t.length >= 2 && t.startsWith('"') && t.endsWith('"')) return t.slice(1, -1);
  return t;
}

function argFor(op: string, text: string): J {
  if (op === "$in" || op === "$nin") {
    return text
      .split(",")
      .map((s) => s.trim())
      .filter((s) => s.length > 0)
      .map(parseScalar);
  }
  if (op === "$exists") return text.trim() !== "false";
  if (op === "$prefix") return text.trim().replace(/^"|"$/g, "");
  return parseScalar(text);
}

function buildWhere(rows: Row[], combine: "and" | "or", negate: boolean): Doc {
  const one = (r: Row): Doc => {
    const arg = argFor(r.op, r.value);
    return { [r.field]: r.op === "$eq" ? arg : { [r.op]: arg } };
  };
  let out: Doc;
  if (rows.length === 0) out = {};
  else if (combine === "or" && rows.length > 1) out = { $or: rows.map(one) };
  else {
    // AND: merge operators of one field into one object when they do not collide.
    const merged: Doc = {};
    const extra: Doc[] = [];
    for (const r of rows) {
      const arg = argFor(r.op, r.value);
      const cur = merged[r.field];
      if (cur === undefined) {
        merged[r.field] = r.op === "$eq" ? arg : { [r.op]: arg };
      } else if (typeof cur === "object" && cur !== null && !Array.isArray(cur) && r.op !== "$eq" && !(r.op in cur)) {
        (cur as Doc)[r.op] = arg;
      } else {
        extra.push(one(r));
      }
    }
    out = extra.length ? { $and: [merged, ...extra] } : merged;
  }
  return negate && rows.length > 0 ? { $not: out } : out;
}

/* ---- evaluation, following the documented semantics ------------------------ */

function lookup(v: J | undefined, path: string[]): J | undefined {
  let cur: J | undefined = v;
  for (const seg of path) {
    if (cur === null || cur === undefined) return undefined;
    if (Array.isArray(cur)) {
      const i = /^\d+$/.test(seg) ? Number(seg) : -1;
      cur = i >= 0 ? cur[i] : undefined;
    } else if (typeof cur === "object") {
      cur = (cur as Doc)[seg];
    } else return undefined;
  }
  return cur;
}

function jsonEq(a: J, b: J): boolean {
  if (typeof a === "number" && typeof b === "number") return a === b;
  if (Array.isArray(a) && Array.isArray(b)) return a.length === b.length && a.every((x, i) => jsonEq(x, b[i] as J));
  if (a && b && typeof a === "object" && typeof b === "object" && !Array.isArray(a) && !Array.isArray(b)) {
    const ka = Object.keys(a);
    return ka.length === Object.keys(b).length && ka.every((k) => k in b && jsonEq((a as Doc)[k] as J, (b as Doc)[k] as J));
  }
  return a === b;
}

function order(a: J, b: J): number | null {
  if (typeof a === "number" && typeof b === "number") return a < b ? -1 : a > b ? 1 : 0;
  if (typeof a === "string" && typeof b === "string") return a < b ? -1 : a > b ? 1 : 0;
  return null;
}

function opMatches(op: string, arg: J, f: J | undefined): boolean {
  if (op === "$exists") return (f !== undefined) === arg;
  if (op === "$ne") return !(f !== undefined && jsonEq(f, arg));
  if (op === "$nin") return !(f !== undefined && (arg as J[]).some((v) => jsonEq(f, v)));
  if (f === undefined) return false;
  switch (op) {
    case "$eq":
      return jsonEq(f, arg);
    case "$in":
      return (arg as J[]).some((v) => jsonEq(f, v));
    case "$gt":
      return order(f, arg) === 1;
    case "$gte": {
      const c = order(f, arg);
      return c === 1 || c === 0;
    }
    case "$lt":
      return order(f, arg) === -1;
    case "$lte": {
      const c = order(f, arg);
      return c === -1 || c === 0;
    }
    case "$prefix":
      return typeof f === "string" && f.startsWith(arg as string);
    case "$contains":
      if (Array.isArray(f)) return f.some((i) => jsonEq(i, arg));
      return typeof f === "string" && typeof arg === "string" && f.includes(arg);
    default:
      return false;
  }
}

function matches(filter: J, doc: Doc): boolean {
  const f = filter as Doc;
  return Object.entries(f).every(([name, cond]) => {
    if (name === "$and") return (cond as J[]).every((c) => matches(c, doc));
    if (name === "$or") return (cond as J[]).some((c) => matches(c, doc));
    if (name === "$not") return !matches(cond, doc);
    const v = lookup(doc, name.split("."));
    const isOps = cond !== null && typeof cond === "object" && !Array.isArray(cond) && Object.keys(cond).some((k) => k.startsWith("$"));
    if (!isOps) return opMatches("$eq", cond, v);
    return Object.entries(cond as Doc).every(([op, arg]) => opMatches(op, arg, v));
  });
}

function validate(filter: J): string | null {
  const f = filter as Doc;
  for (const [name, cond] of Object.entries(f)) {
    if (name === "$and" || name === "$or") {
      for (const c of cond as J[]) {
        const e = validate(c);
        if (e) return e;
      }
    } else if (name === "$not") {
      const e = validate(cond);
      if (e) return e;
    } else if (cond !== null && typeof cond === "object" && !Array.isArray(cond)) {
      for (const [op, arg] of Object.entries(cond as Doc)) {
        if (["$gt", "$gte", "$lt", "$lte"].includes(op) && typeof arg !== "number" && typeof arg !== "string") {
          return `${op} takes a number or a string`;
        }
        if ((op === "$in" || op === "$nin") && (!Array.isArray(arg) || arg.length === 0)) {
          return `${op} needs a comma-separated list`;
        }
      }
    }
  }
  return null;
}

function project(doc: Doc, fields: string[]): Doc {
  const out: Doc = {};
  const copy = (src: Doc, dst: Doc, path: string[]) => {
    const [head, ...rest] = path;
    if (head === undefined || !(head in src)) return;
    const child = src[head] as J;
    if (rest.length === 0 || child === null || typeof child !== "object" || Array.isArray(child)) {
      dst[head] = child;
      return;
    }
    const slot = (dst[head] ?? (dst[head] = {})) as Doc;
    copy(child as Doc, slot, rest);
  };
  for (const f of fields) copy(doc, out, f.split("."));
  return out;
}

const typeRank = (v: J): number => (v === null ? 0 : v === false ? 1 : v === true ? 2 : typeof v === "number" ? 3 : 4);
function cmpIndexed(a: J, b: J): number {
  const ra = typeRank(a);
  const rb = typeRank(b);
  if (ra !== rb) return ra - rb;
  if (typeof a === "number" && typeof b === "number") return a - b;
  if (typeof a === "string" && typeof b === "string") return a < b ? -1 : a > b ? 1 : 0;
  return 0;
}
const indexable = (v: J | undefined): v is null | boolean | number | string => v !== undefined && (v === null || typeof v !== "object");

interface Outcome {
  error?: string;
  rows: [string, Doc][];
  matched: number;
  scanned: number;
  index: string | null;
  more: boolean;
}

function evaluate(
  filter: Doc,
  prefix: string,
  sort: { field: string; order: "asc" | "desc" } | null,
  fields: string[],
  limit: number,
  indexes: Index[],
  topAnd: boolean,
): Outcome {
  const bad = validate(filter);
  if (bad) return { error: `400 invalid_filter: ${bad}`, rows: [], matched: 0, scanned: 0, index: null, more: false };
  const inRange = DATA.filter(([k]) => k.startsWith(prefix));
  const covering = (ix: Index) => prefix.startsWith(ix.prefix);

  let candidates = inRange;
  let index: string | null = null;
  let scanned = inRange.length;
  let ordered: [string, Doc][] | null = null;

  if (sort) {
    const ix = indexes.find((i) => i.field === sort.field && i.order === sort.order && covering(i));
    if (!ix) {
      return {
        error: `400 sort_unavailable: sorting by ${sort.field} (${sort.order}) needs a ready index on that field with order = "${sort.order}" whose prefix covers the query range`,
        rows: [],
        matched: 0,
        scanned: 0,
        index: null,
        more: false,
      };
    }
    index = ix.name;
    let entries = inRange.filter(([, d]) => indexable(lookup(d, sort.field.split("."))));
    if (topAnd) {
      // Top-level conditions on the sort field narrow the part of the index that is read.
      const cond = filter[sort.field];
      if (cond !== undefined) {
        const isOps = cond !== null && typeof cond === "object" && !Array.isArray(cond);
        const ops = isOps ? Object.entries(cond as Doc).filter(([o]) => ["$eq", "$gt", "$gte", "$lt", "$lte"].includes(o)) : [["$eq", cond] as [string, J]];
        entries = entries.filter(([, d]) => ops.every(([o, a]) => opMatches(o, a, lookup(d, sort.field.split(".")))));
      }
    }
    scanned = entries.length;
    ordered = [...entries].sort((x, y) => {
      const c = cmpIndexed(lookup(x[1], sort.field.split(".")) as J, lookup(y[1], sort.field.split(".")) as J);
      if (c !== 0) return sort.order === "asc" ? c : -c;
      return x[0] < y[0] ? -1 : 1;
    });
    candidates = ordered;
  } else if (topAnd) {
    for (const ix of indexes) {
      if (!covering(ix)) continue;
      const cond = filter[ix.field];
      if (cond === undefined) continue;
      const plain = cond === null || typeof cond !== "object" || Array.isArray(cond);
      const eq = plain ? cond : (cond as Doc)["$eq"];
      if (eq === undefined || (eq !== null && typeof eq === "object")) continue;
      candidates = inRange.filter(([, d]) => {
        const v = lookup(d, ix.field.split("."));
        return indexable(v) && jsonEq(v, eq);
      });
      index = ix.name;
      scanned = candidates.length;
      break;
    }
  }

  const hits = candidates.filter(([, d]) => matches(filter, d));
  const page = hits.slice(0, limit);
  return {
    rows: page.map(([k, d]) => [k, fields.length ? project(d, fields) : d]),
    matched: hits.length,
    scanned,
    index,
    more: hits.length > limit,
  };
}

/* ---- component ------------------------------------------------------------ */

const shq = (s: string) => `'${s.replace(/'/g, "'\\''")}'`;

export default function QueryBuilder() {
  const [rows, setRows] = useState<Row[]>([
    { id: 1, field: "status", op: "$eq", value: "paid" },
    { id: 2, field: "total", op: "$gte", value: "100" },
  ]);
  const [nextId, setNextId] = useState(3);
  const [combine, setCombine] = useState<"and" | "or">("and");
  const [negate, setNegate] = useState(false);
  const [prefix, setPrefix] = useState("orders/");
  const [sortKey, setSortKey] = useState("none");
  const [fields, setFields] = useState<string[]>([]);
  const [limit, setLimit] = useState(10);
  const [useIdx, setUseIdx] = useState(true);

  const where = useMemo(() => buildWhere(rows, combine, negate), [rows, combine, negate]);
  const sort = sortKey === "none" ? null : { field: sortKey.split(":")[0]!, order: sortKey.split(":")[1] as "asc" | "desc" };
  const topAnd = !negate && !(combine === "or" && rows.length > 1) && !("$and" in where);

  const body: Record<string, unknown> = {};
  if (prefix) body.prefix = prefix;
  if (rows.length) body.where = where;
  if (fields.length) body.fields = fields;
  if (sort) body.sort = sort;
  body.limit = limit;
  const pretty = JSON.stringify(body, null, 2);
  const compact = JSON.stringify(body);

  const cli = ["celeris query"];
  if (prefix) cli.push(`--prefix ${prefix}`);
  const whereJson = JSON.stringify(where);
  const cliArgs: string[] = [];
  if (fields.length) cliArgs.push(`--fields ${fields.join(",")}`);
  if (sort) cliArgs.push(`--sort ${sort.field}${sort.order === "desc" ? ":desc" : ""}`);
  cliArgs.push(`--limit ${limit}`);
  const cliUnix = [...cli, ...(rows.length ? [`--where ${shq(whereJson)}`] : []), ...cliArgs].join(" ");
  const cliWin = [...cli, ...(rows.length ? [`--where '${whereJson.replace(/"/g, '\\"')}'`] : []), ...cliArgs].join(" ");

  const out = useMemo(
    () => evaluate(where, prefix, sort, fields, limit, useIdx ? INDEXES : [], topAnd),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [where, prefix, sortKey, fields, limit, useIdx, topAnd],
  );

  const setRow = (id: number, patch: Partial<Row>) => setRows((rs) => rs.map((r) => (r.id === id ? { ...r, ...patch } : r)));
  const toggleField = (f: string) => setFields((fs) => (fs.includes(f) ? fs.filter((x) => x !== f) : [...fs, f]));

  return (
    <Demo
      title="Query builder"
      note="The filter is evaluated in your browser over 13 made-up records using the documented query rules. The request shown is exactly what you would send."
      controls={
        <Button
          onClick={() => {
            setRows([{ id: 1, field: "status", op: "$eq", value: "paid" }]);
            setNextId(2);
            setCombine("and");
            setNegate(false);
            setPrefix("orders/");
            setSortKey("none");
            setFields([]);
            setLimit(10);
            setUseIdx(true);
          }}
        >
          Reset
        </Button>
      }
    >
      <div className="qb-grid">
        <div className="qb-col">
          <fieldset className="qb-fs">
            <legend>Filter (where)</legend>
            {rows.map((r) => (
              <div className="qb-row" key={r.id}>
                <select aria-label="Field" value={r.field} onChange={(e) => setRow(r.id, { field: e.target.value })}>
                  {FIELDS.map((f) => (
                    <option key={f}>{f}</option>
                  ))}
                </select>
                <select aria-label="Operator" value={r.op} onChange={(e) => setRow(r.id, { op: e.target.value })}>
                  {OPS.map((o) => (
                    <option key={o.id} value={o.id}>
                      {o.label}
                    </option>
                  ))}
                </select>
                <input
                  type="text"
                  aria-label="Value"
                  value={r.value}
                  placeholder={r.op === "$in" || r.op === "$nin" ? "a, b, c" : r.op === "$exists" ? "true or false" : "value"}
                  onChange={(e) => setRow(r.id, { value: e.target.value })}
                />
                <Button onClick={() => setRows((rs) => rs.filter((x) => x.id !== r.id))}>Remove</Button>
              </div>
            ))}
            <div className="qb-line">
              <Button
                disabled={rows.length >= 5}
                onClick={() => {
                  setRows((rs) => [...rs, { id: nextId, field: "total", op: "$lt", value: "500" }]);
                  setNextId(nextId + 1);
                }}
              >
                Add condition
              </Button>
              <label>
                Combine with
                <select aria-label="Combine conditions" value={combine} onChange={(e) => setCombine(e.target.value as "and" | "or")}>
                  <option value="and">AND (default)</option>
                  <option value="or">$or</option>
                </select>
              </label>
              <label>
                <input type="checkbox" checked={negate} onChange={(e) => setNegate(e.target.checked)} /> wrap in $not
              </label>
            </div>
            <p className="qb-hint">
              Numbers, true, false and null are typed automatically. Put a string in double quotes to force a string, for example &quot;100&quot;.
            </p>
          </fieldset>

          <fieldset className="qb-fs">
            <legend>Range, sort, projection</legend>
            <div className="qb-line">
              <label>
                prefix
                <select value={prefix} onChange={(e) => setPrefix(e.target.value)}>
                  <option value="orders/">orders/</option>
                  <option value="">(all keys)</option>
                </select>
              </label>
              <label>
                sort
                <select value={sortKey} onChange={(e) => setSortKey(e.target.value)}>
                  <option value="none">key order</option>
                  <option value="total:asc">total, ascending</option>
                  <option value="total:desc">total, descending</option>
                  <option value="created:asc">created, ascending</option>
                </select>
              </label>
              <label>
                limit
                <select value={limit} onChange={(e) => setLimit(Number(e.target.value))}>
                  {[3, 5, 10, 100].map((n) => (
                    <option key={n}>{n}</option>
                  ))}
                </select>
              </label>
            </div>
            <div className="qb-chips" role="group" aria-label="Projection fields">
              {FIELDS.map((f) => (
                <label key={f} className={fields.includes(f) ? "on" : ""}>
                  <input type="checkbox" checked={fields.includes(f)} onChange={() => toggleField(f)} />
                  {f}
                </label>
              ))}
            </div>
            <p className="qb-hint">Tick fields to project (fields). None ticked returns whole values.</p>
          </fieldset>

          <fieldset className="qb-fs">
            <legend>Indexes declared on the node</legend>
            <div className="qb-line">
              <label>
                <input type="checkbox" checked={useIdx} onChange={(e) => setUseIdx(e.target.checked)} /> pretend these three indexes are ready
              </label>
            </div>
            <Code lang="toml">
              {INDEXES.map((i) => `[[indexes]]\nname = "${i.name}"\nprefix = "${i.prefix}"\nfield = "${i.field}"\norder = "${i.order}"`).join("\n\n")}
            </Code>
          </fieldset>
        </div>

        <div className="qb-col qb-out">
          <Tabs
            group="qb-out"
            label="Generated request"
            items={[
              { id: "json", label: "JSON body", content: <Code lang="json" flush>{pretty}</Code> },
              {
                id: "curl",
                label: "curl",
                content: (
                  <OsCode
                    unix={`curl -X POST http://localhost:8080/v1/query \\\n  -H 'content-type: application/json' \\\n  -d ${shq(compact)}`}
                    windows={`@'\n${compact}\n'@ | curl.exe -X POST http://localhost:8080/v1/query -H "content-type: application/json" --data-binary "@-"`}
                  />
                ),
              },
              {
                id: "cli",
                label: "CLI",
                content: <OsCode unix={cliUnix} windows={cliWin} />,
              },
            ]}
          />
          <div>
            <div className="qb-meta" aria-live="polite">
              {out.error ? null : (
                <>
                  <span>
                    matched <b>{out.matched}</b>
                  </span>
                  <span>
                    scanned <b>{out.scanned}</b>
                  </span>
                  <span>
                    index <b>{out.index ?? "null (scan)"}</b>
                  </span>
                  <span>
                    next_cursor <b>{out.more ? "set" : "null"}</b>
                  </span>
                </>
              )}
            </div>
            {out.error ? (
              <p className="qb-err" role="alert">
                {out.error}
              </p>
            ) : out.rows.length === 0 ? (
              <div className="qb-scroll">
                <p className="qb-empty">No record matches.</p>
              </div>
            ) : (
              <div className="qb-scroll">
                <table className="qb-res">
                  <thead>
                    <tr>
                      <th>key</th>
                      <th>value</th>
                    </tr>
                  </thead>
                  <tbody>
                    {out.rows.map(([k, v]) => (
                      <tr key={k}>
                        <td className="k">{k}</td>
                        <td className="v">{JSON.stringify(v)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </div>
        </div>
      </div>
      <p className="qb-hint">
        Try: sort by total descending, then switch the indexes off to see sort_unavailable. Add <code>customer.tier</code> <code>$exists</code> false to find the record without a tier. Record
        0011 has a string total and 0012 has none: see where they land when sorting.
      </p>
    </Demo>
  );
}
