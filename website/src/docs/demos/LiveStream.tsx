import { useEffect, useRef, useState } from "react";

import { Button, Demo, prefersReducedMotion } from "../kit";
import "./LiveStream.css";

/**
 * A simulated single node with two WebSocket subscribers. Message shapes and
 * rules (prefix filter, hello first, no replay, deduplicated retries publish
 * nothing, lagged notices) follow docs/API.md. Nothing here talks to a server.
 */

interface Ev {
  type: "change";
  key: string;
  kind: "put" | "delete";
  value: unknown;
  version: number;
  mutation_id: string;
}
interface Sub {
  prefix: string;
  connected: boolean;
  msgs: { text: string; cls: string; id: number }[];
  filtered: number;
}
interface Dot {
  id: number;
  from: [number, number];
  to: [number, number];
  cls: string;
  go: boolean;
}

const NODE: [number, number] = [270, 70];
const WRITER: [number, number] = [60, 70];
const SUBS: [number, number][] = [
  [490, 30],
  [490, 110],
];

const uuid = (n: number) => `00000000-0000-4000-8000-${n.toString(16).padStart(12, "0")}`;
const hello = (prefix: string) => JSON.stringify({ type: "hello", node: "node-a", prefix, groups: [], partial: false });

export default function LiveStream() {
  const [key, setKey] = useState("orders/1");
  const [value, setValue] = useState('{"status":"paid"}');
  const [err, setErr] = useState("");
  const [note, setNote] = useState("");
  const [subs, setSubs] = useState<Sub[]>([
    { prefix: "orders/", connected: false, msgs: [], filtered: 0 },
    { prefix: "", connected: false, msgs: [], filtered: 0 },
  ]);
  const [hit, setHit] = useState<boolean[]>([false, false]);
  const [dots, setDots] = useState<Dot[]>([]);
  const ver = useRef(0);
  const mut = useRef(0);
  const ids = useRef(0);
  const last = useRef<{ id: string; evs: Ev[] } | null>(null);
  const timers = useRef<ReturnType<typeof setTimeout>[]>([]);
  const subsRef = useRef(subs);
  subsRef.current = subs;

  useEffect(
    () => () => {
      timers.current.forEach(clearTimeout);
    },
    [],
  );
  const later = (fn: () => void, ms: number) => {
    timers.current.push(setTimeout(fn, ms));
  };

  const fly = (from: [number, number], to: [number, number], cls: string, delay: number, half = false) => {
    if (prefersReducedMotion()) return;
    later(() => {
      const id = ++ids.current;
      setDots((d) => [...d, { id, from, to: half ? [(from[0] + to[0]) / 2, (from[1] + to[1]) / 2] : to, cls, go: false }]);
      later(() => setDots((d) => d.map((x) => (x.id === id ? { ...x, go: true } : x))), 30);
      later(() => setDots((d) => d.filter((x) => x.id !== id)), 650);
    }, delay);
  };

  const publish = (evs: Ev[]) => {
    fly(WRITER, NODE, "", 0);
    const cur = subsRef.current;
    cur.forEach((s, i) => {
      if (!s.connected) return;
      const any = evs.some((e) => e.key.startsWith(s.prefix));
      fly(NODE, SUBS[i]!, any ? "yes" : "no drop", 500, !any);
      if (any) {
        later(() => setHit((h) => h.map((x, j) => (j === i ? true : x))), 950);
        later(() => setHit((h) => h.map((x, j) => (j === i ? false : x))), 1500);
      }
    });
    const delay = prefersReducedMotion() ? 0 : 950;
    later(() => {
      setSubs((prev) =>
        prev.map((s) => {
          if (!s.connected) return s;
          let msgs = s.msgs;
          let filtered = s.filtered;
          for (const e of evs) {
            if (e.key.startsWith(s.prefix)) {
              msgs = [{ text: JSON.stringify(e), cls: e.kind === "delete" ? "del" : "put", id: ++ids.current }, ...msgs].slice(0, 12);
            } else filtered++;
          }
          return { ...s, msgs, filtered };
        }),
      );
    }, delay);
  };

  const write = (kind: "put" | "delete", k: string, raw: string) => {
    let parsed: unknown = null;
    if (kind === "put") {
      try {
        parsed = JSON.parse(raw);
      } catch {
        setErr("400 invalid_json: the value must be valid JSON");
        return;
      }
    }
    if (!k || k.length > 1024) {
      setErr("400 invalid_key: keys are 1 to 1024 bytes");
      return;
    }
    setErr("");
    const v = ++ver.current;
    const id = uuid(++mut.current);
    const ev: Ev = { type: "change", key: k, kind, value: parsed, version: v, mutation_id: id };
    last.current = { id, evs: [ev] };
    setNote(`committed version ${v}`);
    publish([ev]);
  };

  const batch = () => {
    setErr("");
    const v = ++ver.current;
    const id = uuid(++mut.current);
    const evs: Ev[] = [
      { type: "change", key: "orders/7", kind: "put", value: { status: "new" }, version: v, mutation_id: id },
      { type: "change", key: "users/9", kind: "delete", value: null, version: v, mutation_id: id },
    ];
    last.current = { id, evs };
    setNote(`batch committed as version ${v}: one event per operation, same version and mutation_id`);
    publish(evs);
  };

  const retry = () => {
    if (!last.current) {
      setNote("nothing to retry yet");
      return;
    }
    setNote(`retry of ${last.current.id.slice(-4)} answered deduplicated: true, nothing new was written, so no event is published`);
  };

  const connect = (i: number) => {
    setSubs((prev) =>
      prev.map((s, j) =>
        j === i ? { ...s, connected: true, filtered: 0, msgs: [{ text: hello(s.prefix), cls: "hello", id: ++ids.current }] } : s,
      ),
    );
  };
  const disconnect = (i: number) => setSubs((prev) => prev.map((s, j) => (j === i ? { ...s, connected: false } : s)));
  const setPrefix = (i: number, p: string) => setSubs((prev) => prev.map((s, j) => (j === i ? { ...s, prefix: p } : s)));
  const lag = () => {
    setSubs((prev) =>
      prev.map((s, j) =>
        j === 0 && s.connected
          ? { ...s, msgs: [{ text: JSON.stringify({ type: "lagged", missed: 812 }), cls: "lag", id: ++ids.current }, ...s.msgs].slice(0, 12) }
          : s,
      ),
    );
    setNote("a slow watcher fell behind the buffer: re-read the keys you depend on, do not assume you saw everything");
  };

  const box = (p: [number, number], w: number, h: number, label: string, sub: string, cls = "") => (
    <g>
      <rect x={p[0] - w / 2} y={p[1] - h / 2} width={w} height={h} rx="10" className={`ls-box ${cls}`} />
      <text x={p[0]} y={p[1] - 2} textAnchor="middle">
        {label}
      </text>
      <text x={p[0]} y={p[1] + 13} textAnchor="middle" className="ls-sub">
        {sub}
      </text>
    </g>
  );

  return (
    <Demo
      title="Live change stream"
      note="Simulated in your browser: one node, two WebSocket subscribers. The message shapes are the real ones; there is no server."
      controls={
        <Button
          onClick={() => {
            timers.current.forEach(clearTimeout);
            timers.current = [];
            setSubs((p) => p.map((s) => ({ ...s, connected: false, msgs: [], filtered: 0 })));
            setDots([]);
            setHit([false, false]);
            setNote("");
            setErr("");
          }}
        >
          Reset
        </Button>
      }
    >
      <div className="ls-top">
        <svg viewBox="0 0 560 140" className="ls-svg" role="img" aria-label="A writer sends changes to a node, which forwards each one only to subscribers whose prefix matches the key">
          <line x1={WRITER[0] + 45} y1={WRITER[1]} x2={NODE[0] - 55} y2={NODE[1]} className="ls-pipe" />
          {SUBS.map((s, i) => (
            <line key={i} x1={NODE[0] + 55} y1={NODE[1]} x2={s[0] - 55} y2={s[1]} className="ls-pipe" />
          ))}
          {box(WRITER, 90, 44, "writer", "PUT / DELETE")}
          {box(NODE, 110, 50, "node", "applies, then publishes")}
          {box(SUBS[0]!, 110, 44, "subscriber 1", `prefix "${subs[0]!.prefix}"`, `${hit[0] ? "hit" : ""} ${subs[0]!.connected ? "" : "off"}`)}
          {box(SUBS[1]!, 110, 44, "subscriber 2", `prefix "${subs[1]!.prefix}"`, `${hit[1] ? "hit" : ""} ${subs[1]!.connected ? "" : "off"}`)}
          {dots.map((d) => (
            <g
              key={d.id}
              className={`ls-dot ${d.cls} ${d.go && d.cls.includes("drop") ? "drop" : ""}`}
              style={{ transform: `translate(${d.go ? d.to[0] : d.from[0]}px, ${d.go ? d.to[1] : d.from[1]}px)` }}
            >
              <circle r="6" />
            </g>
          ))}
        </svg>

        <div className="ls-panels">
          <div className="ls-panel">
            <h4>Write something</h4>
            <label className="ls-f">
              key
              <input value={key} onChange={(e) => setKey(e.target.value)} list="ls-keys" spellCheck={false} />
            </label>
            <datalist id="ls-keys">
              <option value="orders/1" />
              <option value="orders/2" />
              <option value="users/42" />
              <option value="carts/9" />
            </datalist>
            <label className="ls-f">
              value (JSON)
              <input value={value} onChange={(e) => setValue(e.target.value)} spellCheck={false} />
            </label>
            <div className="ls-btns">
              <Button kind="primary" onClick={() => write("put", key, value)}>
                PUT
              </Button>
              <Button onClick={() => write("delete", key, "")}>DELETE</Button>
              <Button onClick={batch}>Batch of two</Button>
              <Button onClick={retry}>Retry last write</Button>
              <Button onClick={lag}>Simulate lag</Button>
            </div>
            {err ? (
              <p className="ls-err" role="alert">
                {err}
              </p>
            ) : null}
            <p className="ls-note" aria-live="polite">
              {note || "Connect a subscriber first: streams start at now and are not replayed."}
            </p>
          </div>
          {subs.map((s, i) => (
            <div className="ls-panel" key={i}>
              <h4>Subscriber {i + 1}</h4>
              <label className="ls-f">
                prefix
                <input value={s.prefix} onChange={(e) => setPrefix(i, e.target.value)} disabled={s.connected} spellCheck={false} placeholder="(empty = every key)" />
              </label>
              <div className="ls-btns">
                {s.connected ? <Button onClick={() => disconnect(i)}>Disconnect</Button> : <Button kind="primary" onClick={() => connect(i)}>Connect</Button>}
              </div>
              <p className="ls-count">
                {s.connected ? `${s.filtered} change(s) filtered out by the prefix` : "Disconnected: changes now are never delivered later."}
              </p>
              <ul className="ls-feed" aria-label={`Messages for subscriber ${i + 1}`}>
                {s.msgs.map((m) => (
                  <li key={m.id} className={m.cls}>
                    {m.text}
                  </li>
                ))}
              </ul>
            </div>
          ))}
        </div>
      </div>
    </Demo>
  );
}
