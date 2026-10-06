import { useEffect, useRef, useState } from "react";

import { gsap, ScrollTrigger, useGSAP, useReducedMotion } from "../motion";

const STEPS = [
  { title: "Healthy", text: "Majority commits. Every mode succeeds." },
  { title: "Partition", text: "Region 2 is cut off. Something must give." },
  { title: "Strict request", text: "No quorum here: refused, never wrong." },
  { title: "Available request", text: "Accepted locally. The app keeps going." },
  { title: "Heal", text: "Ordered through Raft. Conflicts kept, never lost." },
];

/** The two-region diagram, drawn for one step of the story. */
function Stage({ step }: { step: number }) {
  const split = step >= 1 && step <= 3;
  return (
    <svg className="stage" data-step={step} viewBox="0 0 560 360" role="img" aria-label={STEPS[step]!.title}>
      <rect x="16" y="20" width="286" height="320" rx="14" className="region" />
      <rect x="326" y="20" width="218" height="320" rx="14" className="region" />
      <text x="34" y="46" className="region-label">
        Region 1 · majority
      </text>
      <text x="344" y="46" className="region-label">
        Region 2 · minority
      </text>

      <line x1="110" y1="130" x2="110" y2="258" className="s-link" />
      <line x1="110" y1="130" x2="430" y2="130" className={`s-link ${split ? "is-broken" : ""}`} />
      <line x1="110" y1="258" x2="430" y2="130" className={`s-link ${split ? "is-broken" : ""}`} />

      <g className={`s-split ${split ? "on" : ""}`}>
        <path d="M314 24 L306 70 L322 110 L304 160 L322 210 L306 260 L320 300 L312 336" />
        <text x="314" y="352" textAnchor="middle">
          network partition
        </text>
      </g>

      <g className={`s-flow ${step === 0 ? "on" : ""}`}>
        <line x1="110" y1="152" x2="110" y2="236" className="s-arrow ok" />
        <line x1="154" y1="130" x2="386" y2="130" className="s-arrow ok" />
      </g>

      <g className={`s-req ${step === 2 ? "on" : ""}`}>
        <line x1="430" y1="266" x2="430" y2="152" className="s-arrow" />
        <rect x="438" y="196" width="84" height="22" rx="11" className="s-tag" />
        <text x="480" y="211" textAnchor="middle" className="s-tag-text">
          PUT · strict
        </text>
        <rect x="352" y="70" width="156" height="28" rx="8" className="s-bubble bad" />
        <text x="430" y="88" textAnchor="middle" className="s-bubble-text">
          503 · no quorum here
        </text>
      </g>

      <g className={`s-req ${step === 3 ? "on" : ""}`}>
        <line x1="430" y1="266" x2="430" y2="152" className="s-arrow" />
        <rect x="438" y="196" width="100" height="22" rx="11" className="s-tag" />
        <text x="488" y="211" textAnchor="middle" className="s-tag-text">
          PUT · available
        </text>
        <rect x="346" y="70" width="168" height="28" rx="8" className="s-bubble warn" />
        <text x="430" y="88" textAnchor="middle" className="s-bubble-text">
          202 · accepted, pending
        </text>
      </g>

      <g className={`s-heal ${step === 4 ? "on" : ""}`}>
        <line x1="386" y1="130" x2="154" y2="130" className="s-arrow ok" />
        <rect x="34" y="70" width="152" height="28" rx="8" className="s-bubble ok" />
        <text x="110" y="88" textAnchor="middle" className="s-bubble-text">
          ordered at log #1205
        </text>
        <text x="158" y="316" textAnchor="middle" className="s-note">
          concurrent loser → /v1/conflicts
        </text>
      </g>

      {[
        { x: 110, y: 130, name: "node A", role: "leader" },
        { x: 110, y: 258, name: "node B", role: "follower" },
        { x: 430, y: 130, name: "node C", role: step === 3 ? "1 pending" : split ? "isolated" : "follower" },
      ].map((n) => (
        <g
          key={n.name}
          className={`s-node ${n.name === "node C" && split ? "is-isolated" : ""}`}
          transform={`translate(${n.x} ${n.y})`}
        >
          <rect x="-44" y="-22" width="88" height="44" rx="10" />
          <text y="-3">{n.name}</text>
          <text y="13" className="s-role">
            {n.role}
          </text>
        </g>
      ))}
      <g className="s-app" transform="translate(430 284)">
        <rect x="-58" y="-16" width="116" height="32" rx="16" />
        <text y="5">app in region 2</text>
      </g>
    </svg>
  );
}

function Verdict({ step }: { step: number }) {
  const row = [
    { c: "kept", a: "kept" },
    { c: "at stake", a: "at stake" },
    { c: "kept", a: "refused here" },
    { c: "deferred", a: "kept" },
    { c: "restored", a: "kept" },
  ][step]!;
  const tone = (v: string) => (v === "kept" || v === "restored" ? "ok" : v === "refused here" ? "bad" : "warn");
  return (
    <div className="verdict" aria-live="polite">
      <span className={`pill ${tone(row.c)}`}>Consistency: {row.c}</span>
      <span className={`pill ${tone(row.a)}`}>Availability: {row.a}</span>
      <span className="pill ok">Partition tolerance: always</span>
    </div>
  );
}

/** The CAP triangle: which edge a request travels. */
function Triangle() {
  const [pick, setPick] = useState<"cp" | "ap">("cp");
  const [auto, setAuto] = useState(true);
  useEffect(() => {
    if (!auto) return;
    const t = setInterval(() => setPick((p) => (p === "cp" ? "ap" : "cp")), 3200);
    return () => clearInterval(t);
  }, [auto]);
  const choose = (p: "cp" | "ap") => {
    setAuto(false);
    setPick(p);
  };
  const lit = (l: string) => (pick === "cp" ? l !== "A" : l !== "C");
  return (
    <div className="tri">
      <svg viewBox="0 0 280 230" aria-hidden="true">
        <line x1="140" y1="30" x2="62" y2="196" className={`tri-edge ${pick === "cp" ? "on" : ""}`} />
        <line x1="140" y1="30" x2="218" y2="196" className="tri-edge dim" />
        <line x1="62" y1="196" x2="218" y2="196" className={`tri-edge ${pick === "ap" ? "on" : ""}`} />
        {[
          { x: 140, y: 30, l: "C", t: "Consistency", dx: 0, dy: -26 },
          { x: 62, y: 196, l: "P", t: "Partition tolerance", dx: 0, dy: 34 },
          { x: 218, y: 196, l: "A", t: "Availability", dx: 0, dy: 34 },
        ].map((v) => (
          <g key={v.l} transform={`translate(${v.x} ${v.y})`}>
            <circle r="17" className={`tri-v ${lit(v.l) ? "on" : ""}`} />
            <text y="5" textAnchor="middle" className="tri-l">
              {v.l}
            </text>
            <text x={v.dx} y={v.dy} textAnchor="middle" className="tri-t">
              {v.t}
            </text>
          </g>
        ))}
      </svg>
      <div className="tri-switch" role="group" aria-label="Request type">
        <button type="button" className={pick === "cp" ? "is-on" : ""} onClick={() => choose("cp")}>
          strict request → CP
        </button>
        <button type="button" className={pick === "ap" ? "is-on" : ""} onClick={() => choose("ap")}>
          available request → AP
        </button>
      </div>
    </div>
  );
}

export function Cap() {
  const pinRef = useRef<HTMLDivElement>(null);
  const [step, setStep] = useState(0);
  const [stacked, setStacked] = useState(false);
  const reduced = useReducedMotion();

  useEffect(() => {
    const mq = matchMedia("(max-width: 899px)");
    const on = () => setStacked(mq.matches || reduced);
    on();
    mq.addEventListener("change", on);
    return () => mq.removeEventListener("change", on);
  }, [reduced]);

  useGSAP(
    () => {
      if (stacked || !pinRef.current) return;
      const st = ScrollTrigger.create({
        trigger: pinRef.current,
        start: "top top",
        end: `+=${STEPS.length * 70}%`,
        pin: true,
        scrub: true,
        onUpdate: (self) => setStep(Math.min(STEPS.length - 1, Math.floor(self.progress * STEPS.length))),
      });
      gsap.from(pinRef.current.querySelector(".stage-wrap"), {
        opacity: 0,
        y: 30,
        duration: 1,
        scrollTrigger: { trigger: pinRef.current, start: "top 80%", once: true },
      });
      return () => st.kill();
    },
    { dependencies: [stacked], revertOnUpdate: true },
  );

  return (
    <section id="cap" className="cap" data-theme="dark">
      <div className="container cap-head">
        <div>
          <p className="eyebrow" data-reveal="fade">
            The CAP theorem
          </p>
          <h2 data-reveal="lines">CAP, decided per request.</h2>
          <div className="section-lede" data-reveal="fade" data-delay="0.1">
            <p>Partitions force a trade-off. Others make it once, for everything. CelerisDB makes it per request.</p>
          </div>
          <ul className="cap-points" data-reveal="fade" data-delay="0.15">
            <li>
              <b>Payments</b> stay strict
            </li>
            <li>
              <b>Likes</b> stay available
            </li>
            <li>
              <b>Same cluster</b>, same moment
            </li>
          </ul>
        </div>
        <div data-reveal="fade" data-delay="0.15">
          <Triangle />
        </div>
      </div>

      {stacked ? (
        <div className="container cap-stack">
          {STEPS.map((s, i) => (
            <article key={s.title} className="cap-card">
              <span className="cap-n">0{i + 1}</span>
              <h3>{s.title}</h3>
              <p>{s.text}</p>
              <Stage step={i} />
              <Verdict step={i} />
            </article>
          ))}
        </div>
      ) : (
        <div ref={pinRef} className="cap-pin">
          <div className="container cap-grid">
            <ol className="cap-steps">
              {STEPS.map((s, i) => (
                <li key={s.title} className={i === step ? "is-active" : i < step ? "is-done" : ""}>
                  <span className="cap-n">0{i + 1}</span>
                  <div>
                    <h3>{s.title}</h3>
                    <p>{s.text}</p>
                  </div>
                </li>
              ))}
            </ol>
            <div className="stage-wrap">
              <Stage step={step} />
              <Verdict step={step} />
              <div className="cap-progress" aria-hidden="true">
                {STEPS.map((_, i) => (
                  <span key={i} className={i <= step ? "on" : ""} />
                ))}
              </div>
            </div>
          </div>
        </div>
      )}
    </section>
  );
}
