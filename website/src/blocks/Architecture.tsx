import { useRef, useState } from "react";

import { SectionHead } from "../components/kit";
import { gsap, ScrollTrigger, useGSAP } from "../motion";

const LAYERS = [
  {
    name: "API",
    detail: "HTTP · JSON · WebSocket",
    title: "One plain HTTP API",
    text: "HTTPS, scoped tokens, WebSocket streams, Prometheus metrics.",
    side: [] as string[],
  },
  {
    name: "Query engine",
    detail: "filters · indexes · sort · totals",
    title: "Queries run where the data lives",
    text: "Filters, indexes, sorting and aggregates pushed to each replica set.",
    side: [],
  },
  {
    name: "Router",
    detail: "key → partition → replica set",
    title: "Every key has an address",
    text: "Key → partition → replica set. Epochs fence stale maps.",
    side: ["control"],
  },
  {
    name: "Replica groups",
    detail: "one Raft log per replica set",
    title: "Raft per replica set",
    text: "One Raft log per replica set. Parallel groups, automatic failover.",
    side: ["membership", "background"],
  },
  {
    name: "Storage engine",
    detail: "WAL · memtable · SSTables",
    title: "A storage engine built for this",
    text: "LSM engine in Rust: group-commit WAL, SSTables, Bloom filters, atomic indexes.",
    side: [],
  },
];

const SIDE = [
  { id: "control", name: "Control plane", detail: "Raft among 3–5 voters" },
  { id: "membership", name: "Membership", detail: "SWIM gossip" },
  { id: "background", name: "Background", detail: "repair · rebalance · index builds" },
];

export function Architecture() {
  const ref = useRef<HTMLElement>(null);
  const dot = useRef<HTMLDivElement>(null);
  const [active, setActive] = useState(0);

  useGSAP(
    () => {
      if (!ref.current) return;
      ref.current.querySelectorAll<HTMLElement>(".arch-step").forEach((el, i) => {
        ScrollTrigger.create({
          trigger: el,
          start: "top 60%",
          end: "bottom 60%",
          onToggle: (self) => {
            if (self.isActive) setActive(i);
          },
        });
      });
    },
    { scope: ref },
  );

  useGSAP(() => {
    const layer = ref.current?.querySelectorAll<HTMLElement>(".arch-layer")[active];
    if (!layer || !dot.current) return;
    gsap.to(dot.current, { y: layer.offsetTop + layer.offsetHeight / 2 - 5, duration: 0.6, ease: "power3.inOut" });
  }, [active]);

  const lit = LAYERS[active]!.side;

  return (
    <section id="architecture" ref={ref} className="section alt" data-theme="light">
      <div className="container">
        <SectionHead eyebrow="Architecture" title="Inside a node, layer by layer.">
          <p>One binary per machine. Five layers, one job each.</p>
        </SectionHead>

        <div className="arch">
          <div className="arch-visual">
            <div className="arch-sticky">
              <div className="arch-stack">
                <div className="arch-rail" aria-hidden="true">
                  <div className="arch-dot" ref={dot} />
                </div>
                <div className="arch-layers">
                  {LAYERS.map((l, i) => (
                    <div
                      key={l.name}
                      className={`arch-layer ${i === active ? "is-active" : ""} ${i < active ? "is-past" : ""}`}
                    >
                      <span className="arch-i">0{i + 1}</span>
                      <span className="arch-name">{l.name}</span>
                      <span className="arch-detail">{l.detail}</span>
                    </div>
                  ))}
                </div>
                <div className="arch-side">
                  {SIDE.map((s) => (
                    <div key={s.id} className={`arch-side-box ${lit.includes(s.id) ? "is-lit" : ""}`}>
                      <span className="arch-name">{s.name}</span>
                      <span className="arch-detail">{s.detail}</span>
                    </div>
                  ))}
                </div>
              </div>
              <p className="arch-foot">One process per machine · port 8080 for clients · port 7000 between nodes</p>
            </div>
          </div>
          <div className="arch-steps">
            {LAYERS.map((l, i) => (
              <article key={l.name} className={`arch-step ${i === active ? "is-active" : ""}`}>
                <span className="arch-i">0{i + 1}</span>
                <h3>{l.title}</h3>
                <p>{l.text}</p>
              </article>
            ))}
          </div>
        </div>
      </div>
    </section>
  );
}
