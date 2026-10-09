import { Button, Demo, useStored } from "../kit";
import "./Checklist.css";

export interface CheckItem {
  /** Stable id, stored as `celeris-docs-check-<id>`. */
  id: string;
  text: string;
  why?: string;
  /** Docs target, `slug` or `slug:section`. */
  to: string;
  linkLabel?: string;
}

export interface CheckGroup {
  id: string;
  title: string;
  items: CheckItem[];
}

const key = (id: string) => `celeris-docs-check-${id}`;

/**
 * Reads the stored state of every item. The list of items is constant for the
 * life of the component, so the hook order never changes.
 */
function useChecks(groups: CheckGroup[]) {
  const all = groups.flatMap((g) => g.items);
  const states = all.map((i) => {
    // eslint-disable-next-line react-hooks/rules-of-hooks
    return useStored(key(i.id), "0");
  });
  const checked = new Map<string, boolean>();
  all.forEach((i, n) => checked.set(i.id, states[n]![0] === "1"));
  const set = (id: string, on: boolean) => {
    const n = all.findIndex((i) => i.id === id);
    if (n >= 0) states[n]![1](on ? "1" : "0");
  };
  const reset = () => states.forEach(([, write]) => write("0"));
  return { checked, set, reset, total: all.length };
}

export function Checklist({ groups }: { groups: CheckGroup[] }) {
  const { checked, set, reset, total } = useChecks(groups);
  const done = [...checked.values()].filter(Boolean).length;
  const pct = total === 0 ? 0 : Math.round((done / total) * 100);

  return (
    <Demo
      title="Production readiness checklist"
      note="Your ticks are saved in this browser only (local storage). Nothing is sent anywhere and nothing checks your cluster."
      controls={
        <Button onClick={reset} disabled={done === 0}>
          Reset all
        </Button>
      }
    >
      <div className="ck-wrap">
        <div className="ck-top">
          <div className="ck-top-row">
            <span className="ck-total">
              {done} of {total} done ({pct}%)
            </span>
            <span className="ck-count">{done === total && total > 0 ? "All items ticked" : `${total - done} remaining`}</span>
          </div>
          <div
            className="ck-bar"
            role="progressbar"
            aria-label="Checklist progress"
            aria-valuemin={0}
            aria-valuemax={100}
            aria-valuenow={pct}
          >
            <span className={done === total && total > 0 ? "done" : ""} style={{ width: `${pct}%` }} />
          </div>
        </div>

        {groups.map((g) => {
          const n = g.items.filter((i) => checked.get(i.id)).length;
          const full = n === g.items.length;
          return (
            <section className="ck-group" key={g.id} aria-label={g.title}>
              <header>
                <h3>{g.title}</h3>
                <span className={`ck-count ${full ? "full" : ""}`}>
                  {n}/{g.items.length}
                </span>
              </header>
              <ul className="ck-list">
                {g.items.map((i) => {
                  const on = !!checked.get(i.id);
                  const inputId = `ck-${i.id}`;
                  return (
                    <li className={`ck-item ${on ? "on" : ""}`} key={i.id}>
                      <input id={inputId} type="checkbox" checked={on} onChange={(e) => set(i.id, e.target.checked)} />
                      <label htmlFor={inputId}>
                        <span className="ck-text">{i.text}</span>
                        {i.why ? <span className="ck-why">{i.why}</span> : null}
                      </label>
                      <a className="ck-link" href={`#/${i.to}`}>
                        {i.linkLabel ?? "How"}
                      </a>
                    </li>
                  );
                })}
              </ul>
            </section>
          );
        })}
      </div>
    </Demo>
  );
}
