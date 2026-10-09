import { useState } from "react";

import { Button, Demo } from "../kit";
import "./StorageStack.css";

interface Item {
  id: number;
  key: string;
  ver: number;
}
interface St {
  seq: number;
  wal: Item[];
  mem: Item[];
  files: Item[][];
  down: boolean;
  lost: Item | null;
  msg: string;
  flash: string;
}

const KEYS = ["cart", "user", "flag", "seat", "plan", "tab"];
const FLUSH_AT = 4;

const INIT: St = {
  seq: 0,
  wal: [],
  mem: [],
  files: [],
  down: false,
  lost: null,
  msg: "Write a few values and watch where each one lands. Overwrites reuse a key.",
  flash: "",
};

function chipColor(key: string): string {
  const i = KEYS.indexOf(key);
  return `hsl(${(i * 57 + 190) % 360} 50% 45%)`;
}

function Chip({ it, dim }: { it: Item; dim?: boolean }) {
  return (
    <span className={`ss-chip ${dim ? "dim" : ""}`} style={{ background: chipColor(it.key) }} title={`${it.key}, version ${it.ver}`}>
      {it.key}
      <small>v{it.ver}</small>
    </span>
  );
}

export default function StorageStack() {
  const [s, setS] = useState<St>(INIT);

  const write = () =>
    setS((p) => {
      if (p.down) return p;
      const seq = p.seq + 1;
      const key = KEYS[(seq * 7 + (seq >> 1)) % KEYS.length]!;
      const ver = seq;
      const it: Item = { id: seq, key, ver };
      const wal = [...p.wal, it];
      let mem = [...p.mem, it];
      let files = p.files;
      let walOut = wal;
      let msg = `${key} v${ver}: recorded in the log first, so it is safely acknowledged. Then it is placed in the in-memory table.`;
      if (mem.length >= FLUSH_AT) {
        const newest = new Map<string, Item>();
        for (const m of mem) newest.set(m.key, m);
        const sorted = [...newest.values()].sort((a, b) => a.key.localeCompare(b.key));
        files = [...files, sorted];
        mem = [];
        walOut = [];
        msg = "The in-memory table filled up, so it was written out as a sorted, immutable file. The log entries it covered are no longer needed.";
      }
      return { ...p, seq, wal: walOut, mem, files, msg, flash: "write", lost: null };
    });

  const compact = () =>
    setS((p) => {
      if (p.down || p.files.length < 2) return p;
      const newest = new Map<string, Item>();
      for (const f of p.files) for (const it of f) {
        const old = newest.get(it.key);
        if (!old || old.ver < it.ver) newest.set(it.key, it);
      }
      const merged = [...newest.values()].sort((a, b) => a.key.localeCompare(b.key));
      return {
        ...p,
        files: [merged],
        msg: `Compaction merged ${p.files.length} files into 1 and dropped the overwritten older versions. Reads now check fewer places.`,
        flash: "compact",
      };
    });

  const plug = (midWrite: boolean) =>
    setS((p) => {
      if (p.down) return p;
      const seq = midWrite ? p.seq + 1 : p.seq;
      const lost = midWrite ? { id: seq, key: "cart", ver: seq } : null;
      return {
        ...p,
        seq,
        down: true,
        mem: [],
        lost,
        flash: "plug",
        msg: midWrite
          ? "Power cut in the middle of a write, before it reached the log. It was never acknowledged, so the client knows to retry. Memory is gone."
          : "Power cut. Everything in memory vanished. The log and the sorted files are on disk and survive.",
      };
    });

  const restart = () =>
    setS((p) => {
      if (!p.down) return p;
      return {
        ...p,
        down: false,
        mem: [...p.wal],
        flash: "recover",
        msg:
          p.wal.length > 0
            ? `Restarted. The log was replayed: ${p.wal.length} acknowledged write${p.wal.length === 1 ? "" : "s"} are back in the in-memory table. Nothing acknowledged was lost.`
            : "Restarted. Everything acknowledged was already in sorted files, so there was nothing to replay.",
      };
    });

  const reset = () => setS(INIT);

  return (
    <Demo
      title="Durable by design"
      note="A conceptual picture, not the real file layout. It shows the idea behind a log-structured storage engine."
      controls={
        <>
          <Button kind="primary" onClick={write} disabled={s.down}>
            Write a value
          </Button>
          <Button onClick={compact} disabled={s.down || s.files.length < 2}>
            Compact
          </Button>
          <Button kind="danger" onClick={() => plug(false)} disabled={s.down}>
            Pull the plug
          </Button>
          <Button kind="danger" onClick={() => plug(true)} disabled={s.down}>
            Crash mid-write
          </Button>
          <Button onClick={restart} disabled={!s.down}>
            Restart
          </Button>
          <Button onClick={reset}>Reset</Button>
        </>
      }
    >
      <div className={`ss-root ${s.down ? "down" : ""} f-${s.flash}`}>
        <div className="ss-layer mem">
          <div className="ss-lh">
            <strong>In-memory table</strong>
            <span className="ss-tag volatile">in RAM: fast, lost on power cut</span>
          </div>
          <div className="ss-items">
            {s.down ? <span className="ss-void">wiped</span> : null}
            {!s.down && s.mem.length === 0 ? <span className="ss-void">empty</span> : null}
            {s.lost ? <span className="ss-ghost">{s.lost.key} v{s.lost.ver} (never acked)</span> : null}
            {!s.down && s.mem.map((it) => <Chip key={it.id} it={it} />)}
          </div>
        </div>

        <div className="ss-arrow" aria-hidden="true">
          <span>every write is logged first</span>
        </div>

        <div className="ss-layer wal">
          <div className="ss-lh">
            <strong>Write-ahead log</strong>
            <span className="ss-tag durable">on disk: append-only, survives</span>
          </div>
          <div className="ss-items">
            {s.wal.length === 0 ? <span className="ss-void">empty</span> : null}
            {s.wal.map((it) => (
              <Chip key={it.id} it={it} />
            ))}
          </div>
        </div>

        <div className="ss-arrow" aria-hidden="true">
          <span>when memory fills, write it out sorted</span>
        </div>

        <div className="ss-layer files">
          <div className="ss-lh">
            <strong>Sorted files</strong>
            <span className="ss-tag durable">on disk: immutable, survive</span>
          </div>
          <div className="ss-items files">
            {s.files.length === 0 ? <span className="ss-void">none yet</span> : null}
            {s.files.map((f, i) => (
              <div className="ss-file" key={`${i}-${f.length}-${f[0]?.id ?? 0}`}>
                {f.map((it) => (
                  <Chip key={it.id} it={it} />
                ))}
              </div>
            ))}
          </div>
        </div>

        <p className="ss-msg" aria-live="polite">
          {s.msg}
        </p>
      </div>
    </Demo>
  );
}
