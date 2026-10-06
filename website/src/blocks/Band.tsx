import { useRef } from "react";

import { BrandLogo } from "../components/kit";
import { gsap, prefersReducedMotion, useGSAP } from "../motion";

const STATS = [
  { value: 4096, suffix: "", label: "partitions across zones" },
  { value: 5, suffix: "", label: "consistency modes per request" },
  { value: 5, prefix: "3–", suffix: "×", label: "write throughput from group commit" },
  { value: 0.26, suffix: " µs", label: "negative lookup via Bloom filters", decimals: 2 },
];

const ROW_A = ["react", "nextdotjs", "typescript", "nodedotjs", "python", "go", "rust", "vercel", "openai", "anthropic", "langchain"];
const ROW_B = ["aws", "googlecloud", "azure", "kubernetes", "docker", "prometheus", "grafana", "huggingface", "githubactions"];

function Marquee({ ids, reverse = false }: { ids: string[]; reverse?: boolean }) {
  const items = [...ids, ...ids];
  return (
    <div className={`marquee ${reverse ? "reverse" : ""}`}>
      <div className="marquee-track">
        {items.map((id, i) => (
          <BrandLogo key={`${id}-${i}`} id={id} size={22} />
        ))}
      </div>
    </div>
  );
}

export function Band() {
  const ref = useRef<HTMLElement>(null);
  useGSAP(
    () => {
      if (!ref.current || prefersReducedMotion()) return;
      ref.current.querySelectorAll<HTMLElement>("[data-count]").forEach((el) => {
        const target = Number(el.dataset.count);
        const decimals = Number(el.dataset.decimals ?? 0);
        const state = { v: 0 };
        gsap.to(state, {
          v: target,
          duration: 1.6,
          ease: "power2.out",
          scrollTrigger: { trigger: el, start: "top 90%", once: true },
          onUpdate: () => {
            el.textContent = state.v.toLocaleString("en-US", {
              minimumFractionDigits: decimals,
              maximumFractionDigits: decimals,
            });
          },
        });
      });
    },
    { scope: ref },
  );
  return (
    <section ref={ref} className="band" data-theme="light" aria-label="At a glance">
      <div className="container">
        <dl className="stats">
          {STATS.map((s) => (
            <div key={s.label} className="stat" data-reveal="fade">
              <dt>
                {s.prefix}
                <span data-count={s.value} data-decimals={s.decimals ?? 0}>
                  {s.value.toLocaleString("en-US", {
                    minimumFractionDigits: s.decimals ?? 0,
                    maximumFractionDigits: s.decimals ?? 0,
                  })}
                </span>
                {s.suffix}
              </dt>
              <dd>{s.label}</dd>
            </div>
          ))}
        </dl>
        <p className="band-label">Works with the stack you already run</p>
      </div>
      <Marquee ids={ROW_A} />
      <Marquee ids={ROW_B} reverse />
    </section>
  );
}
