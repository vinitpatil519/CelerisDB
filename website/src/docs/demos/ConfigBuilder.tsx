import { useState } from "react";

import { Code, Demo, IMAGE, type Lang } from "../kit";
import "./ConfigBuilder.css";

/* ── Model ────────────────────────────────────────────────────────────── */

type NodeCount = 1 | 3 | 5;
type View = "toml" | "compose" | "env";

interface Opts {
  nodes: NodeCount;
  rf: number;
  zones: number;
  apiTls: boolean;
  clusterTls: boolean;
  auth: boolean;
  sync: "always" | "never";
  log: "pretty" | "json";
}

const INITIAL: Opts = {
  nodes: 3,
  rf: 3,
  zones: 3,
  apiTls: false,
  clusterTls: false,
  auth: true,
  sync: "always",
  log: "json",
};

const IDS = ["node-a", "node-b", "node-c", "node-d", "node-e"];
const LETTERS = ["a", "b", "c", "d", "e"];
const TOKEN_APP = "REPLACE_WITH_SHA256_OF_APP_TOKEN";
const TOKEN_OPS = "REPLACE_WITH_SHA256_OF_OPS_TOKEN";

function clamp(o: Opts): Opts {
  const rf = Math.max(1, Math.min(o.rf, o.nodes));
  const zones = Math.max(1, Math.min(o.zones, o.nodes));
  return { ...o, rf, zones, clusterTls: o.nodes > 1 ? o.clusterTls : false };
}

const isCluster = (o: Opts) => o.nodes > 1;
const ids = (o: Opts) => IDS.slice(0, o.nodes);
const zoneOf = (o: Opts, i: number) => `zone-${LETTERS[i % o.zones]}`;
const hostOf = (id: string) => `${id}.celeris.internal`;

/* ── celeris.toml ─────────────────────────────────────────────────────── */

function toml(o: Opts, i: number): string {
  const id = IDS[i]!;
  const cluster = isCluster(o);
  const exposed = cluster || o.auth || o.apiTls;
  const out: string[] = [];
  out.push(`# ${id}: save as /etc/celeris/celeris.toml`);
  out.push("[node]");
  out.push('data_dir = "/var/lib/celeris/data"');
  if (cluster) out.push(`id = "${id}"`);
  out.push("");
  out.push("[http]");
  out.push(`listen = "${exposed ? "0.0.0.0:8080" : "127.0.0.1:8080"}"`);
  if (o.apiTls) out.push('tls = { cert_file = "tls/api.crt", key_file = "tls/api.key" }');
  if (cluster) {
    const all = ids(o);
    out.push("");
    out.push("[cluster]");
    out.push('listen = "0.0.0.0:7000"');
    out.push(`advertise = "${hostOf(id)}:7000"`);
    out.push(`seeds = [${all.map((n) => `"${hostOf(n)}:7000"`).join(", ")}]`);
    out.push(`zone = "${zoneOf(o, i)}"`);
    out.push(`voters = [${all.map((n) => `"${n}"`).join(", ")}]`);
    out.push(`replication_factor = ${o.rf}`);
    if (o.clusterTls)
      out.push('tls = { cert_file = "tls/node.crt", key_file = "tls/node.key", ca_file = "tls/cluster-ca.crt" }');
  }
  out.push("");
  out.push("[storage]");
  out.push(`sync = "${o.sync}"`);
  out.push("");
  out.push("[log]");
  out.push(`format = "${o.log}"`);
  if (o.auth) {
    out.push("");
    out.push("# Paste the config lines printed by `celeris token create`.");
    out.push("[[auth.tokens]]");
    out.push('name = "app"');
    out.push(`sha256 = "${TOKEN_APP}"`);
    out.push('scopes = ["read", "write"]');
    out.push("");
    out.push("[[auth.tokens]]");
    out.push('name = "ops"');
    out.push(`sha256 = "${TOKEN_OPS}"`);
    out.push('scopes = ["admin"]');
  }
  return out.join("\n");
}

/* ── Environment variables (shared by the env and compose views) ──────── */

type Env = [string, string][];

function envFor(o: Opts, i: number, compose: boolean): Env {
  const id = IDS[i]!;
  const cluster = isCluster(o);
  const all = ids(o);
  const e: Env = [];
  if (cluster) e.push(["CELERIS_NODE_ID", id]);
  if (!compose) e.push(["CELERIS_DATA_DIR", "/var/lib/celeris/data"]);
  const exposed = compose || cluster || o.auth || o.apiTls;
  e.push(["CELERIS_HTTP_LISTEN", exposed ? "0.0.0.0:8080" : "127.0.0.1:8080"]);
  if (o.apiTls) {
    e.push(["CELERIS_TLS_CERT", "/etc/celeris/tls/api.crt"]);
    e.push(["CELERIS_TLS_KEY", "/etc/celeris/tls/api.key"]);
  }
  if (cluster) {
    const host = (n: string) => (compose ? n : hostOf(n));
    e.push(["CELERIS_CLUSTER_LISTEN", "0.0.0.0:7000"]);
    e.push(["CELERIS_CLUSTER_ADVERTISE", `${host(id)}:7000`]);
    e.push(["CELERIS_CLUSTER_SEEDS", all.map((n) => `${host(n)}:7000`).join(",")]);
    e.push(["CELERIS_CLUSTER_VOTERS", all.join(",")]);
    e.push(["CELERIS_ZONE", zoneOf(o, i)]);
    e.push(["CELERIS_REPLICATION_FACTOR", String(o.rf)]);
    if (o.clusterTls) {
      e.push(["CELERIS_CLUSTER_TLS_CERT", `/etc/celeris/tls/${compose ? id : "node"}.crt`]);
      e.push(["CELERIS_CLUSTER_TLS_KEY", `/etc/celeris/tls/${compose ? id : "node"}.key`]);
      e.push(["CELERIS_CLUSTER_TLS_CA", "/etc/celeris/tls/cluster-ca.crt"]);
    }
  }
  e.push(["CELERIS_SYNC", o.sync]);
  e.push(["CELERIS_LOG_FORMAT", o.log]);
  if (o.auth) e.push(["CELERIS_AUTH_TOKENS", `app:read+write:${TOKEN_APP},ops:admin:${TOKEN_OPS}`]);
  return e;
}

function envText(o: Opts, i: number): string {
  const lines = envFor(o, i, false).map(([k, v]) => `${k}=${v}`);
  return [`# ${IDS[i]}: one KEY=value per line (systemd EnvironmentFile, Docker --env-file, Kubernetes env)`, ...lines].join("\n");
}

/* ── docker-compose.yml ───────────────────────────────────────────────── */

function compose(o: Opts): string {
  const cluster = isCluster(o);
  const mountTls = o.apiTls || o.clusterTls;
  const loopbackOnly = !cluster && !o.auth && !o.apiTls;
  const out: string[] = ["services:"];
  ids(o).forEach((id, i) => {
    out.push(`  ${id}:`);
    out.push(`    image: ${IMAGE}`);
    out.push(`    hostname: ${id}`);
    out.push("    restart: unless-stopped");
    out.push("    security_opt: [\"no-new-privileges:true\"]");
    out.push("    cap_drop: [ALL]");
    out.push(`    ports: ["${loopbackOnly ? "127.0.0.1:" : ""}${8081 + i}:8080"]`);
    out.push("    environment:");
    for (const [k, v] of envFor(o, i, true)) out.push(`      ${k}: "${v}"`);
    out.push("    volumes:");
    out.push(`      - ${id}:/var/lib/celeris/data`);
    if (mountTls) out.push("      - ./tls:/etc/celeris/tls:ro");
  });
  out.push("");
  out.push("volumes:");
  for (const id of ids(o)) out.push(`  ${id}:`);
  return out.join("\n");
}

/* ── Warnings ─────────────────────────────────────────────────────────── */

function warnings(o: Opts): string[] {
  const w: string[] = [];
  if (isCluster(o) && !o.auth) w.push("Authentication is off: anyone who can reach port 8080 can read and write. Admin calls are limited to loopback connections.");
  if (isCluster(o) && !o.clusterTls) w.push("Cluster port 7000 is unencrypted and unauthenticated. Keep it on a private network.");
  if (o.sync === "never") w.push('sync = "never" survives a process crash but not power loss, and an acknowledged write can be lost.');
  if (o.nodes > 1 && o.rf === 2) w.push("Replication factor 2 needs both replicas for every write: it adds a failure point without tolerating one.");
  if (o.nodes > 1 && o.zones < o.rf) w.push("Fewer zones than replicas: some replicas of a partition share a zone, so a zone outage can cost you quorum.");
  if (o.auth) w.push("Replace the two REPLACE_WITH_SHA256 placeholders with hashes from celeris token create. A placeholder is not valid hex, so the node refuses to start until you do.");
  return w;
}

/* ── Component ────────────────────────────────────────────────────────── */

export function ConfigBuilder() {
  const [o, setO] = useState<Opts>(INITIAL);
  const [view, setView] = useState<View>("toml");
  const [nodeIdx, setNodeIdx] = useState(0);
  const set = (patch: Partial<Opts>) => setO((cur) => clamp({ ...cur, ...patch }));
  const idx = Math.min(nodeIdx, o.nodes - 1);
  const cluster = isCluster(o);

  const text = view === "toml" ? toml(o, idx) : view === "env" ? envText(o, idx) : compose(o);
  const lang: Lang = view === "toml" ? "toml" : view === "env" ? "bash" : "yaml";
  const title =
    view === "toml" ? `celeris.toml (${IDS[idx]})` : view === "env" ? `environment (${IDS[idx]})` : "docker-compose.yml";

  const tlsNote =
    view === "compose" && (o.apiTls || o.clusterTls)
      ? "Put the certificates in ./tls next to this file. In Compose, node certificates must name the service (for example DNS:node-a); the key files must be readable by uid 10001."
      : view !== "compose" && o.clusterTls
        ? "Node certificates must name the host in cluster.advertise (DNS:" + hostOf(IDS[idx]!) + "). The TLS and security pages show how to create them."
        : null;

  return (
    <Demo
      title="Config builder"
      note="Generated in your browser from the settings documented in the reference. Nothing is sent anywhere. Token hashes are placeholders you fill in."
    >
      <div className="cb">
        <div className="cb-grid">
          <label className="cb-field">
            <span>Nodes</span>
            <select value={o.nodes} onChange={(e) => set({ nodes: Number(e.target.value) as NodeCount })}>
              <option value={1}>1 (single node)</option>
              <option value={3}>3 voters</option>
              <option value={5}>5 voters</option>
            </select>
          </label>
          <label className="cb-field">
            <span>Replication factor</span>
            <select value={o.rf} disabled={!cluster} onChange={(e) => set({ rf: Number(e.target.value) })}>
              {Array.from({ length: o.nodes }, (_, k) => k + 1).map((n) => (
                <option key={n} value={n}>
                  {n}
                </option>
              ))}
            </select>
          </label>
          <label className="cb-field">
            <span>Zones</span>
            <select value={o.zones} disabled={!cluster} onChange={(e) => set({ zones: Number(e.target.value) })}>
              {Array.from({ length: o.nodes }, (_, k) => k + 1).map((n) => (
                <option key={n} value={n}>
                  {n}
                </option>
              ))}
            </select>
          </label>
          <label className="cb-field">
            <span>Sync mode</span>
            <select value={o.sync} onChange={(e) => set({ sync: e.target.value as Opts["sync"] })}>
              <option value="always">always (fsync every write)</option>
              <option value="never">never (OS flushes)</option>
            </select>
          </label>
          <label className="cb-field">
            <span>Log format</span>
            <select value={o.log} onChange={(e) => set({ log: e.target.value as Opts["log"] })}>
              <option value="json">json</option>
              <option value="pretty">pretty</option>
            </select>
          </label>
          <div className="cb-checks">
            <label>
              <input type="checkbox" checked={o.auth} onChange={(e) => set({ auth: e.target.checked })} /> API tokens
            </label>
            <label>
              <input type="checkbox" checked={o.apiTls} onChange={(e) => set({ apiTls: e.target.checked })} /> HTTPS on the API
            </label>
            <label>
              <input
                type="checkbox"
                checked={o.clusterTls}
                disabled={!cluster}
                onChange={(e) => set({ clusterTls: e.target.checked })}
              />{" "}
              mTLS between nodes
            </label>
          </div>
        </div>

        <div className="cb-bar" role="tablist" aria-label="Output format">
          {(
            [
              ["toml", "celeris.toml"],
              ["compose", "docker-compose.yml"],
              ["env", "Environment variables"],
            ] as [View, string][]
          ).map(([v, label]) => (
            <button key={v} type="button" role="tab" aria-selected={view === v} className={view === v ? "on" : ""} onClick={() => setView(v)}>
              {label}
            </button>
          ))}
        </div>

        {cluster && view !== "compose" ? (
          <div className="cb-bar cb-nodes" role="tablist" aria-label="Node">
            {ids(o).map((id, k) => (
              <button key={id} type="button" role="tab" aria-selected={idx === k} className={idx === k ? "on" : ""} onClick={() => setNodeIdx(k)}>
                {id}
              </button>
            ))}
          </div>
        ) : null}

        <Code lang={lang} title={title}>
          {text}
        </Code>
        {tlsNote ? <p className="cb-note">{tlsNote}</p> : null}

        {warnings(o).length ? (
          <ul className="cb-warn">
            {warnings(o).map((w) => (
              <li key={w}>{w}</li>
            ))}
          </ul>
        ) : null}

        {o.auth ? (
          <Code lang="bash" title="Create the tokens (prints each token once and its config line)">
            {"celeris token create app --scope read,write\nceleris token create ops --scope admin"}
          </Code>
        ) : null}
      </div>
    </Demo>
  );
}

/* ── Quorum calculator ────────────────────────────────────────────────── */

export function QuorumCalc() {
  const [n, setN] = useState(3);
  const [rf, setRf] = useState(3);
  const [down, setDown] = useState<boolean[]>(() => Array.from({ length: 9 }, () => false));
  const eff = Math.min(rf, n);
  const majority = (k: number) => Math.floor(k / 2) + 1;
  const toggle = (i: number) => setDown((d) => d.map((v, k) => (k === i ? !v : v)));
  const nodes = Array.from({ length: n }, (_, i) => i);
  const upVoters = nodes.filter((i) => !down[i]).length;
  const set0 = nodes.slice(0, eff);
  const upSet = set0.filter((i) => !down[i]).length;
  const ctlOk = upVoters >= majority(n);
  const dataOk = upSet >= majority(eff);

  return (
    <Demo
      title="Quorum calculator"
      note="Counting only. It shows the majority arithmetic, not a running cluster."
    >
      <div className="qc">
        <div className="cb-grid">
          <label className="cb-field">
            <span>Voters (cluster size)</span>
            <input
              type="range"
              min={1}
              max={9}
              value={n}
              aria-label="Number of voters"
              onChange={(e) => setN(Number(e.target.value))}
            />
            <b>{n}</b>
          </label>
          <label className="cb-field">
            <span>Replication factor</span>
            <input
              type="range"
              min={1}
              max={9}
              value={eff}
              aria-label="Replication factor"
              onChange={(e) => setRf(Number(e.target.value))}
            />
            <b>{eff}</b>
          </label>
        </div>

        <p className="qc-hint">Click a node to take it down or bring it back. The outlined nodes hold one example replica set.</p>
        <div className="qc-nodes">
          {nodes.map((i) => (
            <button
              key={i}
              type="button"
              aria-pressed={!!down[i]}
              aria-label={`Node ${i + 1}: ${down[i] ? "down" : "up"}`}
              className={`qc-node ${down[i] ? "down" : "up"} ${i < eff ? "in-set" : ""}`}
              onClick={() => toggle(i)}
            >
              {i + 1}
              <small>{down[i] ? "down" : "up"}</small>
            </button>
          ))}
        </div>

        <div className="qc-results">
          <div className={`qc-card ${ctlOk ? "ok" : "bad"}`}>
            <strong>Control plane ({n} voters)</strong>
            <span>
              Majority {majority(n)}, tolerates {n - majority(n)} down. {upVoters} up:{" "}
              {ctlOk ? "can place and rebalance partitions" : "cannot change placement"}
            </span>
          </div>
          <div className={`qc-card ${dataOk ? "ok" : "bad"}`}>
            <strong>Replica set (RF {eff})</strong>
            <span>
              Majority {majority(eff)}, tolerates {eff - majority(eff)} down. {upSet} of {eff} up:{" "}
              {dataOk ? "strict writes and reads succeed" : "strict operations fail; available and eventual writes are only accepted, not replicated"}
            </span>
          </div>
        </div>
      </div>
    </Demo>
  );
}
