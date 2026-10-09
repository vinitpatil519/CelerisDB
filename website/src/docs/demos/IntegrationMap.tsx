import { useState } from "react";

import { Demo } from "../kit";
import "./IntegrationMap.css";

interface Stage {
  label: string;
  sub: string;
  zone: "public" | "private";
}

interface AppType {
  id: string;
  name: string;
  stages: Stage[];
  pattern: string;
  consistency: string;
  sdk: string;
  why: string;
}

const APPS: AppType[] = [
  {
    id: "web",
    name: "Web app",
    stages: [
      { label: "Browser", sub: "no token", zone: "public" },
      { label: "App server", sub: "holds token", zone: "private" },
      { label: "Internal LB", sub: "port 8080", zone: "private" },
    ],
    pattern: "Long-lived server process, one shared client, list every node URL (or one internal load balancer) in nodes.",
    consistency: "strict for money and inventory, session for the user who just wrote, eventual for public listings.",
    sdk: "TypeScript, Python, Go or Rust, called from the server only.",
    why: "The browser never sees a Celeris token. The server picks a consistency mode per call, so most pages stay fast while checkout stays strict.",
  },
  {
    id: "serverless",
    name: "Serverless",
    stages: [
      { label: "Function", sub: "short-lived", zone: "private" },
      { label: "VPC / private link", sub: "must reach 8080", zone: "private" },
      { label: "Internal LB", sub: "health: /ready", zone: "private" },
    ],
    pattern: "Create the client at module scope so warm invocations reuse it. Plain HTTP requests, no connection pool to exhaust.",
    consistency: "strict by default; session does not carry between invocations unless you pass state yourself.",
    sdk: "TypeScript or Python SDK, or raw HTTP with curl-style requests.",
    why: "Every invocation may land on a new instance, so do not rely on the in-process session token. Make writes idempotent with a mutation ID derived from the event ID.",
  },
  {
    id: "mobile",
    name: "Mobile / edge",
    stages: [
      { label: "Device", sub: "untrusted", zone: "public" },
      { label: "Your API", sub: "auth + limits", zone: "public" },
      { label: "Celeris", sub: "private network", zone: "private" },
    ],
    pattern: "Never ship a Celeris token in an app. Put your own authenticated API in front and call Celeris from there.",
    consistency: "session for the signed-in user, bounded or eventual for feeds that tolerate slight staleness.",
    sdk: "The SDK runs in your API, not on the device. Edge runtimes need fetch; use HTTP if they lack WebSocket.",
    why: "Token scopes are read, write and admin, not per key. Anyone holding a token can reach every key it is scoped for.",
  },
  {
    id: "agent",
    name: "AI agent",
    stages: [
      { label: "Agent loop", sub: "retries tools", zone: "private" },
      { label: "Adapter", sub: "your code", zone: "private" },
      { label: "Celeris", sub: "state + memory", zone: "private" },
    ],
    pattern: "A small adapter over the SDK stores history, checkpoints and tool results under keys per session and step.",
    consistency: "session for chat history, strict for checkpoints that use compare-and-set.",
    sdk: "Python or TypeScript SDK. Derive mutation IDs from run, step and tool-call IDs.",
    why: "Agents retry. A mutation ID that is a function of the step means a retried write is recognized and not applied twice.",
  },
  {
    id: "batch",
    name: "Batch job",
    stages: [
      { label: "Job runner", sub: "cron / queue", zone: "private" },
      { label: "Celeris nodes", sub: "any node", zone: "private" },
    ],
    pattern: "Point the client at several nodes. Page with scan or query, write in chunks, re-run safely.",
    consistency: "strict writes; eventual or bounded reads for large scans that tolerate staleness.",
    sdk: "Any SDK. For bulk moves, celeris export and import are idempotent.",
    why: "Re-running a job with the same mutation IDs is safe inside the retention window, which defaults to 24 hours.",
  },
];

export function IntegrationMap() {
  const [active, setActive] = useState("web");
  const app = APPS.find((a) => a.id === active) ?? APPS[0]!;
  const n = app.stages.length;
  const W = 640;
  const boxW = 118;
  const clusterW = 110;
  const gap = n > 1 ? (W - 20 - boxW * (n - 1) - clusterW) / (n - 1) : 0;

  const xs: number[] = [];
  let x = 10;
  for (let i = 0; i < n; i++) {
    xs.push(x);
    x += (i === n - 1 ? clusterW : boxW) + gap;
  }

  return (
    <Demo
      title="Which pattern fits your app?"
      note="Pick an application type. This is a static guide with a decorative animation, not a live connection."
    >
      <div className="im-root">
        <div className="im-tabs" role="group" aria-label="Application type">
          {APPS.map((a) => (
            <button key={a.id} type="button" className="im-tab" aria-pressed={a.id === active} onClick={() => setActive(a.id)}>
              {a.name}
            </button>
          ))}
        </div>

        <svg className="im-svg" viewBox="0 0 640 130" role="img" aria-label={"Connection path for " + app.name}>
          {app.stages.map((s, i) => {
            const bx = xs[i]!;
            const isLast = i === n - 1;
            const w = isLast ? clusterW : boxW;
            return (
              <g key={s.label}>
                <rect className={"im-box " + s.zone} x={bx} y={25} width={w} height={64} rx={8} />
                <text className="im-label" x={bx + w / 2} y={52} textAnchor="middle">
                  {s.label}
                </text>
                <text className="im-sub" x={bx + w / 2} y={70} textAnchor="middle">
                  {s.sub}
                </text>
                {isLast ? (
                  <>
                    <circle className="im-node" cx={bx + 30} cy={106} r={7} />
                    <circle className="im-node" cx={bx + 55} cy={106} r={7} />
                    <circle className="im-node" cx={bx + 80} cy={106} r={7} />
                  </>
                ) : null}
                {i < n - 1 ? (
                  <path className="im-wire" d={"M" + (bx + w + 4) + " 57 H" + (xs[i + 1]! - 4)} />
                ) : null}
              </g>
            );
          })}
          <text className="im-legend" x={10} y={12}>
            Orange outline: reachable from the internet. Accent outline: private network.
          </text>
        </svg>

        <div className="im-facts">
          <div className="im-fact">
            <h5>Connection pattern</h5>
            <p>{app.pattern}</p>
          </div>
          <div className="im-fact">
            <h5>Consistency</h5>
            <p>{app.consistency}</p>
          </div>
          <div className="im-fact">
            <h5>SDK</h5>
            <p>{app.sdk}</p>
          </div>
        </div>
        <p className="im-why">{app.why}</p>
      </div>
    </Demo>
  );
}
