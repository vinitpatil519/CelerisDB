import { useLayoutEffect, useRef, useState, type KeyboardEvent } from "react";

import { CodeBlock, SectionHead } from "../components/kit";
import { MODES } from "../data/site";
import { gsap } from "../motion";

function Meter({ label, value }: { label: string; value: number }) {
  return (
    <div className="meter">
      <div className="meter-head">
        <span>{label}</span>
        <span className="meter-val">{Math.round(value * 100)}</span>
      </div>
      <div className="meter-track">
        <div className="meter-fill" style={{ transform: `scaleX(${value})` }} />
      </div>
    </div>
  );
}

export function Modes() {
  const [i, setI] = useState(0);
  const bar = useRef<HTMLDivElement>(null);
  const tabs = useRef<(HTMLButtonElement | null)[]>([]);
  const mode = MODES[i]!;

  useLayoutEffect(() => {
    const tab = tabs.current[i];
    if (!tab || !bar.current) return;
    gsap.to(bar.current, { x: tab.offsetLeft, width: tab.offsetWidth, duration: 0.45, ease: "power3.out" });
  }, [i]);

  const onKey = (e: KeyboardEvent) => {
    if (e.key === "ArrowRight") setI((x) => (x + 1) % MODES.length);
    if (e.key === "ArrowLeft") setI((x) => (x - 1 + MODES.length) % MODES.length);
  };

  return (
    <section id="modes" className="section" data-theme="light">
      <div className="container">
        <SectionHead eyebrow="Consistency" title="Five guarantees. One cluster.">
          <p>Every request names its guarantee. Every response confirms it.</p>
        </SectionHead>

        <div className="modes" data-reveal="fade">
          <div className="seg" role="tablist" aria-label="Consistency mode" onKeyDown={onKey}>
            <div className="seg-bar" ref={bar} aria-hidden="true" />
            {MODES.map((m, k) => (
              <button
                key={m.id}
                ref={(el) => {
                  tabs.current[k] = el;
                }}
                role="tab"
                type="button"
                aria-selected={k === i}
                tabIndex={k === i ? 0 : -1}
                onClick={() => setI(k)}
              >
                {m.label}
              </button>
            ))}
          </div>

          <div className="modes-panel" role="tabpanel" key={mode.id}>
            <div className="modes-copy">
              <h3>{mode.label}</h3>
              <p className="modes-guarantee">{mode.guarantee}</p>
              <dl className="modes-facts">
                <div>
                  <dt>During a partition</dt>
                  <dd>{mode.during}</dd>
                </div>
                <div>
                  <dt>Use it for</dt>
                  <dd>{mode.useCase}</dd>
                </div>
              </dl>
              <div className="meters">
                <Meter label="Freshness" value={mode.freshness} />
                <Meter label="Serves during a partition" value={mode.partition} />
                <Meter label="Speed" value={mode.speed} />
              </div>
            </div>
            <CodeBlock code={mode.code} label={`${mode.id}.ts`} />
          </div>
        </div>
      </div>
    </section>
  );
}
