import { useState } from "react";

import { encodeKey } from "@celeris/client";

import { getJson, useConnection } from "../connection";
import { usePolling } from "../hooks";

interface PartitionMap {
  count: number;
  epoch: number;
  replication_factor: number;
  zone_diverse_partitions?: number;
  nodes: { id: string; zone: string; replicas: number; leaders: number }[];
}

interface Route {
  key: string;
  partition: number;
  partition_epoch: number;
  map_epoch: number;
  leader: string;
  replicas: string[];
}

export function Partitions() {
  const { nodes } = useConnection();
  const polled = usePolling<PartitionMap>(() => firstAnswer(nodes, "/v1/partitions"), 5_000, [nodes.join(",")]);
  const map = polled.data;
  const maxReplicas = Math.max(1, ...(map?.nodes ?? []).map((n) => n.replicas));

  return (
    <section>
      <header className="page-head">
        <h1>Partitions</h1>
        <p>
          Keys hash into {map?.count ?? 4096} partitions. Each partition lives on a replica set of{" "}
          {map?.replication_factor ?? "N"} nodes; one of them leads its Raft group.
        </p>
      </header>
      {polled.error ? <p className="error">{polled.error}</p> : null}
      {map ? (
        <>
          <div className="stats">
            <div className="stat">
              <div className="stat-value">{map.epoch}</div>
              <div className="stat-label">map epoch</div>
            </div>
            <div className="stat">
              <div className="stat-value">RF{map.replication_factor}</div>
              <div className="stat-label">replication factor</div>
            </div>
            <div className="stat">
              <div className="stat-value">{map.nodes.length}</div>
              <div className="stat-label">placed nodes</div>
            </div>
            {map.zone_diverse_partitions !== undefined ? (
              <div className={`stat ${map.zone_diverse_partitions === map.count ? "ok" : "warn"}`}>
                <div className="stat-value">
                  {Math.round((100 * map.zone_diverse_partitions) / Math.max(1, map.count))}%
                </div>
                <div className="stat-label">zone-diverse partitions</div>
              </div>
            ) : null}
          </div>
          <div className="card">
            <table className="table">
              <thead>
                <tr>
                  <th>node</th>
                  <th>zone</th>
                  <th>replicas</th>
                  <th>leads</th>
                  <th className="wide">share</th>
                </tr>
              </thead>
              <tbody>
                {map.nodes.map((n) => (
                  <tr key={n.id}>
                    <td className="mono">{n.id}</td>
                    <td>{n.zone}</td>
                    <td>{n.replicas}</td>
                    <td>{n.leaders}</td>
                    <td>
                      <div className="bar" title={`${n.replicas} replicas, ${n.leaders} leaders`}>
                        <span className="bar-fill" style={{ width: `${(100 * n.replicas) / maxReplicas}%` }} />
                        <span
                          className="bar-fill accent"
                          style={{ width: `${(100 * n.leaders) / maxReplicas}%` }}
                        />
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
            {map.nodes.length === 0 ? (
              <p className="muted">No partition map is committed yet. Is every voter up?</p>
            ) : null}
          </div>
        </>
      ) : null}
      <KeyLookup />
    </section>
  );
}

function KeyLookup() {
  const { nodes } = useConnection();
  const [key, setKey] = useState("users/42");
  const [route, setRoute] = useState<Route | null>(null);
  const [error, setError] = useState<string | null>(null);
  return (
    <div className="card">
      <h2>Where does a key live?</h2>
      <form
        className="row"
        onSubmit={async (e) => {
          e.preventDefault();
          setError(null);
          try {
            setRoute(await firstAnswer<Route>(nodes, `/v1/partitions/key/${encodeKey(key)}`));
          } catch (err) {
            setRoute(null);
            setError(err instanceof Error ? err.message : String(err));
          }
        }}
      >
        <input aria-label="Key" className="mono grow" value={key} onChange={(e) => setKey(e.target.value)} />
        <button type="submit">Look up</button>
      </form>
      {error ? <p className="error">{error}</p> : null}
      {route ? (
        <dl className="kv">
          <dt>Partition</dt>
          <dd className="mono">
            {route.partition} (epoch {route.partition_epoch})
          </dd>
          <dt>Leader</dt>
          <dd className="mono">{route.leader}</dd>
          <dt>Replicas</dt>
          <dd className="mono">{route.replicas.join(", ")}</dd>
        </dl>
      ) : null}
    </div>
  );
}

/** The first node that answers. */
async function firstAnswer<T>(nodes: string[], path: string): Promise<T> {
  let last: unknown;
  for (const node of nodes) {
    try {
      return await getJson<T>(node, path);
    } catch (e) {
      last = e;
    }
  }
  throw last instanceof Error ? last : new Error("no node answered");
}
