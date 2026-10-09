import { useState, type ReactNode } from "react";

import { Demo, DocLink } from "../kit";
import "./TuningAdvisor.css";

type Durability = "power" | "crash";
type Freshness = "strict" | "session" | "relaxed";

const WRITE_LABELS = ["Light", "Moderate", "Heavy", "Bulk load"] as const;
const READ_LABELS = ["Few reads", "Balanced", "Read heavy"] as const;

interface Rec {
  title: string;
  body: ReactNode;
  warn?: boolean;
}

/** Recommendations come only from trade-offs documented in these pages and in the repo. No invented numbers. */
function advise(write: number, read: number, durability: Durability, freshness: Freshness, filters: boolean, sorts: boolean, scans: boolean): Rec[] {
  const out: Rec[] = [];

  if (durability === "power") {
    out.push({
      title: "Keep storage.sync = \"always\"",
      body: (
        <>
          Every acknowledged write is on disk, so it survives power loss. This is the default.{" "}
          <DocLink to="performance:sync-modes">Sync modes</DocLink>
        </>
      ),
    });
    if (write >= 2) {
      out.push({
        title: "Use many concurrent writers and batches",
        body: (
          <>
            With sync always, writers that arrive while an fsync runs share the next one (group commit). A single serial
            writer pays one fsync per write. Send concurrent requests and group related writes into one{" "}
            <code>POST /v1/batch</code>. <DocLink to="performance:group-commit">Group commit</DocLink>
          </>
        ),
      });
      out.push({
        title: "Put the data directory on fast local storage",
        body: (
          <>
            Write latency under sync always is bounded by fsync latency on your disk. Prefer local NVMe or SSD over
            network volumes. <DocLink to="performance:hardware">Hardware</DocLink>
          </>
        ),
      });
    }
  } else {
    out.push({
      title: "storage.sync = \"never\" is possible, with a stated cost",
      warn: true,
      body: (
        <>
          A process crash still recovers every acknowledged write, but after power loss only a prefix of acknowledged
          writes is recovered. Only choose this for data you can rebuild.{" "}
          <DocLink to="performance:sync-modes">Sync modes</DocLink>
        </>
      ),
    });
    if (write >= 3) {
      out.push({
        title: "For a one-off bulk load, load first and tighten later",
        body: (
          <>
            You can run the load with sync never, then restart with sync always for normal operation. Keep the source
            data until the load is complete, because a power loss during the load may lose its tail.
          </>
        ),
      });
    }
  }

  if (write >= 2) {
    out.push({
      title: "Batch writes that belong together",
      body: (
        <>
          One batch is one atomic commit with one durability step. A batch holds up to 10,000 operations and 32 MiB. In a
          cluster, all keys in a batch must live in the same replica set.{" "}
          <DocLink to="performance:batching">Batching</DocLink>
        </>
      ),
    });
    out.push({
      title: "Watch write stalls",
      body: (
        <>
          <code>celeris_storage_write_stalls_total</code> counts writes that waited for an inline flush. If it grows,
          flushing is not keeping up with your write rate. <DocLink to="observability:metrics">Metrics</DocLink>
        </>
      ),
      warn: write >= 3,
    });
  }

  if (read >= 2) {
    out.push({
      title: "Check the block cache hit ratio",
      body: (
        <>
          <code>storage.block_cache_mb</code> defaults to 64. Compare{" "}
          <code>celeris_storage_block_cache_hits_total</code> with <code>..._misses_total</code> under real traffic before
          changing it. <DocLink to="performance:hardware">Hardware</DocLink>
        </>
      ),
    });
  }

  if (freshness === "strict") {
    out.push({
      title: "Strict reads are served by the group leader",
      body: (
        <>
          Strict (the default) reads go through the leader with a read barrier, so they cost a leader round trip. If some
          reads tolerate staleness, ask for a weaker mode on those requests only.{" "}
          <DocLink to="consistency">Consistency</DocLink>
        </>
      ),
    });
  } else if (freshness === "session") {
    out.push({
      title: "Session reads can use any caught-up replica",
      body: (
        <>
          A session read is served by any replica whose applied index has reached your session token, which spreads read
          load while keeping read-your-writes. <DocLink to="performance:consistency-cost">Consistency cost</DocLink>
        </>
      ),
    });
  } else {
    out.push({
      title: "Eventual and available reads are served by any replica",
      body: (
        <>
          They may return stale data, but they do not need the leader. Use them where staleness is acceptable.{" "}
          <DocLink to="performance:consistency-cost">Consistency cost</DocLink>
        </>
      ),
    });
  }

  if (filters) {
    out.push({
      title: "Declare a secondary index for equality filters",
      body: (
        <>
          A ready index on the filtered field lets <code>POST /v1/query</code> read only matching keys instead of the whole
          range. Every write to an indexed prefix also maintains the index, so index only fields you filter on.{" "}
          <DocLink to="performance:indexes">Indexes</DocLink>
        </>
      ),
    });
  }
  if (sorts) {
    out.push({
      title: "Sorting needs an index with the same order",
      body: (
        <>
          <code>sort</code> works only through a ready index on that field whose order matches. Otherwise the query fails
          with <code>sort_unavailable</code>. <DocLink to="queries">Queries</DocLink>
        </>
      ),
    });
  }
  if (scans) {
    out.push({
      title: "Shape keys for prefix scans",
      body: (
        <>
          Keys are ordered, and scans and queries take a prefix. Put the grouping first in the key (for example{" "}
          <code>orders/2026/...</code>) so related rows are adjacent. <DocLink to="performance:keys">Key design</DocLink>
        </>
      ),
    });
  }

  return out;
}

export function TuningAdvisor() {
  const [write, setWrite] = useState(1);
  const [read, setRead] = useState(1);
  const [durability, setDurability] = useState<Durability>("power");
  const [freshness, setFreshness] = useState<Freshness>("strict");
  const [filters, setFilters] = useState(false);
  const [sorts, setSorts] = useState(false);
  const [scans, setScans] = useState(false);

  const recs = advise(write, read, durability, freshness, filters, sorts, scans);

  return (
    <Demo
      title="Tuning advisor"
      note="Simulated in your browser. It maps your answers to trade-offs documented in these pages. It does not measure anything and produces no performance numbers."
    >
      <div className="ta-wrap">
        <div className="ta-inputs">
          <div className="ta-field">
            <label htmlFor="ta-write">
              Write load<output>{WRITE_LABELS[write]}</output>
            </label>
            <input id="ta-write" type="range" min={0} max={3} step={1} value={write} onChange={(e) => setWrite(Number(e.target.value))} />
            <div className="ta-ticks" aria-hidden="true">
              <span>Light</span>
              <span>Bulk load</span>
            </div>
          </div>
          <div className="ta-field">
            <label htmlFor="ta-read">
              Read load<output>{READ_LABELS[read]}</output>
            </label>
            <input id="ta-read" type="range" min={0} max={2} step={1} value={read} onChange={(e) => setRead(Number(e.target.value))} />
            <div className="ta-ticks" aria-hidden="true">
              <span>Few</span>
              <span>Heavy</span>
            </div>
          </div>
          <div className="ta-field" role="group" aria-label="Durability need">
            <span className="ta-label">Durability need</span>
            <div className="ta-seg">
              <button type="button" aria-pressed={durability === "power"} onClick={() => setDurability("power")}>
                Survive power loss
              </button>
              <button type="button" aria-pressed={durability === "crash"} onClick={() => setDurability("crash")}>
                Process crash is enough
              </button>
            </div>
          </div>
          <div className="ta-field" role="group" aria-label="Read freshness">
            <span className="ta-label">Read freshness</span>
            <div className="ta-seg">
              <button type="button" aria-pressed={freshness === "strict"} onClick={() => setFreshness("strict")}>
                Always latest
              </button>
              <button type="button" aria-pressed={freshness === "session"} onClick={() => setFreshness("session")}>
                My own writes
              </button>
              <button type="button" aria-pressed={freshness === "relaxed"} onClick={() => setFreshness("relaxed")}>
                Stale is fine
              </button>
            </div>
          </div>
          <div className="ta-field" role="group" aria-label="Query patterns">
            <span className="ta-label">Query patterns</span>
            <div className="ta-checks">
              <label>
                <input type="checkbox" checked={filters} onChange={(e) => setFilters(e.target.checked)} />
                Filter by a field value
              </label>
              <label>
                <input type="checkbox" checked={sorts} onChange={(e) => setSorts(e.target.checked)} />
                Sort results by a field
              </label>
              <label>
                <input type="checkbox" checked={scans} onChange={(e) => setScans(e.target.checked)} />
                List keys under a prefix
              </label>
            </div>
          </div>
        </div>

        <div className="ta-out" aria-live="polite">
          <h4>Recommendations</h4>
          {recs.map((r) => (
            <div className={`ta-rec ${r.warn ? "warn" : ""}`} key={r.title}>
              <strong>{r.title}</strong>
              <p>{r.body}</p>
            </div>
          ))}
        </div>
      </div>
    </Demo>
  );
}
