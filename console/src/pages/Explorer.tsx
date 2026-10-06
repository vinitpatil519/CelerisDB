import { useEffect, useState } from "react";

import { CelerisError, OutcomeUnknownError, type Consistency, type Item } from "@celeris/client";

import { useConnection } from "../connection";

const MODES: Consistency[] = ["strict", "session", "bounded", "available", "eventual"];
const PAGE = 50;

export function Explorer() {
  const { client } = useConnection();
  const [prefix, setPrefix] = useState("");
  const [filter, setFilter] = useState("");
  const [scanned, setScanned] = useState<number | null>(null);
  const [consistency, setConsistency] = useState<Consistency>("strict");
  const [items, setItems] = useState<Item[]>([]);
  const [cursor, setCursor] = useState<string | null>(null);
  const [partial, setPartial] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [selected, setSelected] = useState<Item | "new" | null>(null);

  const load = async (after?: string) => {
    setBusy(true);
    setError(null);
    try {
      const range = { prefix: prefix || undefined, limit: PAGE, consistency };
      let page;
      if (filter.trim()) {
        let where: Record<string, unknown>;
        try {
          where = JSON.parse(filter);
        } catch (e) {
          throw new Error(`Filter is not valid JSON: ${describe(e)}`);
        }
        const result = await client.queryPage({ ...range, where }, after);
        setScanned((prev) => (after ? (prev ?? 0) : 0) + result.scanned);
        page = result;
      } else {
        setScanned(null);
        page = await client.scanPage(range, after);
      }
      setItems((prev) => (after ? [...prev, ...page.items] : page.items));
      setCursor(page.nextCursor);
      setPartial(page.partial);
    } catch (e) {
      setError(describe(e));
    } finally {
      setBusy(false);
    }
  };

  useEffect(() => {
    void load();
    // Reload when the connection changes.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [client]);

  return (
    <section>
      <header className="page-head">
        <h1>Data</h1>
        <p>Browse or filter keys in order, read and edit JSON values with compare-and-set.</p>
      </header>
      <form
        className="row card"
        onSubmit={(e) => {
          e.preventDefault();
          void load();
        }}
      >
        <input
          aria-label="Key prefix"
          className="mono grow"
          placeholder="prefix, e.g. users/"
          value={prefix}
          onChange={(e) => setPrefix(e.target.value)}
        />
        <input
          aria-label="Filter"
          className="mono grow"
          placeholder='filter, e.g. {"status":"paid","total":{"$gte":100}}'
          value={filter}
          onChange={(e) => setFilter(e.target.value)}
        />
        <select aria-label="Consistency" value={consistency} onChange={(e) => setConsistency(e.target.value as Consistency)}>
          {MODES.map((m) => (
            <option key={m}>{m}</option>
          ))}
        </select>
        <button type="submit" disabled={busy}>
          {filter.trim() ? "Query" : "Scan"}
        </button>
        <button type="button" className="secondary" onClick={() => setSelected("new")}>
          New key
        </button>
      </form>
      {error ? <p className="error">{error}</p> : null}
      {partial ? <p className="warn-text">Partial results: some replica sets did not answer.</p> : null}
      <div className="split">
        <div className="card list">
          <table className="table">
            <thead>
              <tr>
                <th>key</th>
                <th>version</th>
                <th>value</th>
              </tr>
            </thead>
            <tbody>
              {items.map((item) => (
                <tr
                  key={item.key}
                  className={selected !== "new" && selected?.key === item.key ? "selected" : ""}
                  onClick={() => setSelected(item)}
                  onKeyDown={(e) => e.key === "Enter" && setSelected(item)}
                  tabIndex={0}
                >
                  <td className="mono">{item.key}</td>
                  <td>{item.version}</td>
                  <td className="mono truncate">{JSON.stringify(item.value)}</td>
                </tr>
              ))}
            </tbody>
          </table>
          {items.length === 0 && !busy ? <p className="muted">No keys.</p> : null}
          {scanned !== null ? (
            <p className="muted">
              {items.length} matched, {scanned} rows scanned{cursor ? " so far" : ""}.
            </p>
          ) : null}
          {cursor ? (
            <button type="button" className="secondary" disabled={busy} onClick={() => void load(cursor)}>
              Load more
            </button>
          ) : null}
        </div>
        {selected ? (
          <Editor
            key={selected === "new" ? "new" : `${selected.key}@${selected.version}`}
            item={selected === "new" ? null : selected}
            consistency={consistency}
            onChanged={() => void load()}
            onClose={() => setSelected(null)}
          />
        ) : null}
      </div>
    </section>
  );
}

function Editor({
  item,
  consistency,
  onChanged,
  onClose,
}: {
  item: Item | null;
  consistency: Consistency;
  onChanged(): void;
  onClose(): void;
}) {
  const { client } = useConnection();
  const [key, setKey] = useState(item?.key ?? "");
  const [text, setText] = useState(item ? JSON.stringify(item.value, null, 2) : "{\n  \n}");
  const [version, setVersion] = useState<number | null>(item?.version ?? null);
  const [cas, setCas] = useState(true);
  const [message, setMessage] = useState<{ tone: "ok" | "bad" | "warn"; text: string } | null>(null);
  const writeMode = consistency === "available" ? "available" : "strict";

  const save = async () => {
    let value: unknown;
    try {
      value = JSON.parse(text);
    } catch (e) {
      setMessage({ tone: "bad", text: `Not valid JSON: ${describe(e)}` });
      return;
    }
    try {
      const result = await client.put(key, value, {
        consistency: writeMode,
        ...(item === null ? { ifAbsent: cas } : cas && version !== null ? { ifVersion: version } : {}),
      });
      setVersion(result.version);
      setMessage({
        tone: result.replicated ? "ok" : "warn",
        text: result.replicated
          ? `Saved at version ${result.version}.`
          : `Accepted locally (available); replicating. Mutation ${result.mutationId}.`,
      });
      onChanged();
    } catch (e) {
      setMessage({ tone: e instanceof OutcomeUnknownError ? "warn" : "bad", text: describe(e) });
    }
  };

  const remove = async () => {
    try {
      await client.delete(key, {
        consistency: writeMode,
        ...(cas && version !== null ? { ifVersion: version } : {}),
      });
      onChanged();
      onClose();
    } catch (e) {
      setMessage({ tone: "bad", text: describe(e) });
    }
  };

  return (
    <div className="card editor">
      <div className="card-head">
        <h2>{item ? "Edit" : "New key"}</h2>
        <button type="button" className="ghost" onClick={onClose} aria-label="Close editor">
          ×
        </button>
      </div>
      <label htmlFor="editor-key">Key</label>
      <input
        id="editor-key"
        className="mono"
        value={key}
        readOnly={item !== null}
        onChange={(e) => setKey(e.target.value)}
      />
      <label htmlFor="editor-value">Value (JSON)</label>
      <textarea
        id="editor-value"
        className="mono"
        rows={14}
        spellCheck={false}
        value={text}
        onChange={(e) => setText(e.target.value)}
      />
      <label className="check">
        <input type="checkbox" checked={cas} onChange={(e) => setCas(e.target.checked)} />
        {item ? `Only if still at version ${version ?? "?"} (compare-and-set)` : "Only if the key does not exist"}
      </label>
      <div className="row">
        <button type="button" onClick={() => void save()} disabled={!key}>
          Save ({writeMode})
        </button>
        {item ? (
          <button type="button" className="danger" onClick={() => void remove()}>
            Delete
          </button>
        ) : null}
      </div>
      {message ? <p className={`${message.tone}-text`}>{message.text}</p> : null}
    </div>
  );
}

function describe(e: unknown): string {
  if (e instanceof OutcomeUnknownError) {
    return `Outcome unknown for mutation ${e.mutationId}: it may have been applied. Re-read the key before retrying.`;
  }
  if (e instanceof CelerisError) {
    if (e.code === "condition_failed") return "Someone changed this key first (version mismatch). Reload and retry.";
    return `${e.code}: ${e.message}`;
  }
  return e instanceof Error ? e.message : String(e);
}
