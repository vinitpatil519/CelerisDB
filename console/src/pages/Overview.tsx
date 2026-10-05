import { getJson, useConnection } from "../connection";
import { formatBytes, formatDuration, usePolling } from "../hooks";

interface Status {
  node_id: string;
  version: string;
  uptime_secs: number;
  health: string;
  partitions: { count: number; epoch: number; replication_factor?: number };
  storage: {
    memtable_bytes: number;
    table_bytes: number;
    l0_tables: number;
    l1_tables: number;
    read_only_reason: string | null;
    background_error: string | null;
  };
  cluster?: {
    mode: string;
    view_epoch?: number;
    nodes: { id: string; address: string; state: string; zone: string; incarnation: number; self: boolean }[];
  };
  control?: {
    raft?: { role: string; term: number; leader: string | null; commit_index: number };
    migrations?: { running: number; by_phase: Record<string, number> };
    anti_entropy?: Record<
      string,
      { at_ms: number; compared: string[]; diverged: string[]; missing: string[]; partitions_differing: number }
    >;
  };
}

type NodeResult = { url: string; status: Status | null; error: string | null };

export function Overview() {
  const { nodes } = useConnection();
  const polled = usePolling<NodeResult[]>(
    () =>
      Promise.all(
        nodes.map(async (url) => {
          try {
            return { url, status: await getJson<Status>(url, "/v1/status"), error: null };
          } catch (e) {
            return { url, status: null, error: e instanceof Error ? e.message : String(e) };
          }
        }),
      ),
    2_000,
    [nodes.join(",")],
  );
  const results = polled.data ?? [];
  const first = results.find((r) => r.status)?.status ?? null;

  return (
    <section>
      <header className="page-head">
        <h1>Overview</h1>
        <p>Health, membership and the Raft control plane, refreshed every 2 s.</p>
      </header>

      {first?.cluster ? <Members status={first} /> : null}

      <div className="grid">
        {results.map((r) => (
          <NodeCard key={r.url} result={r} />
        ))}
        {polled.loading && results.length === 0 ? <div className="card muted">Connecting…</div> : null}
      </div>
    </section>
  );
}

function Members({ status }: { status: Status }) {
  const raft = status.control?.raft;
  const members = status.cluster?.nodes ?? [];
  const alive = members.filter((m) => m.state === "alive").length;
  const running = status.control?.migrations?.running ?? 0;
  return (
    <div className="stats">
      <Stat label="members alive" value={`${alive}/${members.length}`} tone={alive === members.length ? "ok" : "warn"} />
      <Stat label="control leader" value={raft?.leader ?? "—"} />
      <Stat label="raft term" value={raft ? String(raft.term) : "—"} />
      <Stat label="map epoch" value={String(status.partitions.epoch)} />
      <Stat
        label="replication"
        value={status.partitions.replication_factor ? `RF${status.partitions.replication_factor}` : "—"}
      />
      <Stat label="migrations" value={String(running)} tone={running > 0 ? "warn" : "ok"} />
    </div>
  );
}

function Stat({ label, value, tone }: { label: string; value: string; tone?: "ok" | "warn" | "bad" }) {
  return (
    <div className={`stat ${tone ?? ""}`}>
      <div className="stat-value">{value}</div>
      <div className="stat-label">{label}</div>
    </div>
  );
}

function NodeCard({ result }: { result: NodeResult }) {
  const s = result.status;
  if (!s) {
    return (
      <div className="card bad">
        <h2 className="mono">{result.url}</h2>
        <p className="error">{result.error ?? "unreachable"}</p>
      </div>
    );
  }
  const readOnly = s.storage.read_only_reason ?? s.storage.background_error;
  const raft = s.control?.raft;
  const checks = Object.entries(s.control?.anti_entropy ?? {});
  return (
    <div className={`card ${readOnly ? "bad" : ""}`}>
      <div className="card-head">
        <h2 className="mono">{s.node_id}</h2>
        <span className={`badge ${s.health === "healthy" ? "ok" : "bad"}`}>{s.health}</span>
      </div>
      <dl className="kv">
        <dt>URL</dt>
        <dd className="mono">{result.url}</dd>
        <dt>Version</dt>
        <dd>{s.version}</dd>
        <dt>Uptime</dt>
        <dd>{formatDuration(s.uptime_secs)}</dd>
        {raft ? (
          <>
            <dt>Raft</dt>
            <dd>
              <span className={`badge ${raft.role === "leader" ? "accent" : ""}`}>{raft.role}</span> term {raft.term},
              commit {raft.commit_index}
            </dd>
          </>
        ) : null}
        <dt>Memtable</dt>
        <dd>{formatBytes(s.storage.memtable_bytes)}</dd>
        <dt>Tables</dt>
        <dd>
          {formatBytes(s.storage.table_bytes)} · L0 {s.storage.l0_tables} · L1 {s.storage.l1_tables}
        </dd>
      </dl>
      {readOnly ? <p className="error">Storage is read-only: {readOnly}</p> : null}
      {checks.length > 0 ? (
        <div className="checks">
          <h3>Anti-entropy (groups this node leads)</h3>
          <ul>
            {checks.map(([group, c]) => (
              <li key={group}>
                <span className="mono">{group}</span>{" "}
                {c.diverged.length === 0 && c.missing.length === 0 ? (
                  <span className="badge ok">in sync</span>
                ) : (
                  <span className="badge warn">
                    {c.partitions_differing} partitions differ ({[...c.diverged, ...c.missing].join(", ")})
                  </span>
                )}
              </li>
            ))}
          </ul>
        </div>
      ) : null}
      {s.cluster ? (
        <table className="table compact">
          <thead>
            <tr>
              <th>member</th>
              <th>zone</th>
              <th>state</th>
            </tr>
          </thead>
          <tbody>
            {s.cluster.nodes.map((m) => (
              <tr key={m.id}>
                <td className="mono">
                  {m.id}
                  {m.self ? " (self)" : ""}
                </td>
                <td>{m.zone}</td>
                <td>
                  <span className={`badge ${m.state === "alive" ? "ok" : m.state === "suspect" ? "warn" : "bad"}`}>
                    {m.state}
                  </span>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      ) : null}
    </div>
  );
}
