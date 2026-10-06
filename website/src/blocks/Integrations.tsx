import { useRef, useState } from "react";

import { BrandLogo, CodeBlock, SectionHead } from "../components/kit";
import { gsap, useGSAP } from "../motion";

const GROUPS = [
  {
    id: "frontend",
    title: "Frontend and edge",
    logos: ["react", "nextdotjs", "vercel"],
    text: "A React hook streams live data. Edge and server code call HTTPS directly.",
    file: "Order.tsx",
    code: `import { useCeleris } from "@celeris/client/react";

export function Order({ id }: { id: string }) {
  // Reads once, then follows every committed change.
  const { data } = useCeleris(db, \`orders/\${id}\`, { consistency: "session" });
  return <OrderCard order={data} />;
}`,
  },
  {
    id: "backend",
    title: "Backend services",
    logos: ["typescript", "nodedotjs", "python", "go", "rust"],
    text: "Typed SDKs with safe retries, sessions and change streams.",
    file: "checkout.py",
    code: `from celeris import Client

db = Client(["https://db.internal:8080"], token=TOKEN)

cart = db.get("carts/7")
db.put("carts/7", {**cart.value, "paid": True}, if_version=cart.version)`,
  },
  {
    id: "ai",
    title: "AI agents and LLM apps",
    logos: ["openai", "anthropic", "langchain", "huggingface"],
    text: "Durable agent memory and state, next to any model provider.",
    file: "agent_memory.py",
    code: `# Works with any LLM SDK: CelerisDB stores the agent's state.
memory = db.get(f"agents/{agent_id}/thread")
messages = memory.value["messages"] if memory else []

reply = llm.chat(messages + [user_msg])   # OpenAI, Anthropic, ...
db.put(f"agents/{agent_id}/thread",
       {"messages": messages + [user_msg, reply]},
       consistency="session")`,
  },
  {
    id: "cloud",
    title: "Cloud and orchestration",
    logos: ["aws", "googlecloud", "azure", "kubernetes", "docker"],
    text: "One image. Kubernetes manifest, Compose cluster, AWS reference architecture.",
    file: "deploy.sh",
    code: `# Kubernetes: three voters, one per zone
kubectl apply -f deploy/kubernetes/celeris.yaml
kubectl rollout status statefulset/celeris

# Or locally: a three-node cluster
docker compose up -d`,
  },
  {
    id: "ops",
    title: "Observability and CI",
    logos: ["prometheus", "grafana", "githubactions"],
    text: "Prometheus metrics, health probes, JSON logs, CI-built releases.",
    file: "prometheus.yml",
    code: `scrape_configs:
  - job_name: celeris
    static_configs:
      - targets: ["node-a:8080", "node-b:8080", "node-c:8080"]`,
  },
];

export function Integrations() {
  const [i, setI] = useState(0);
  const panel = useRef<HTMLDivElement>(null);
  const g = GROUPS[i]!;

  useGSAP(() => {
    if (!panel.current) return;
    gsap.fromTo(panel.current, { opacity: 0, y: 10 }, { opacity: 1, y: 0, duration: 0.45, ease: "power2.out" });
  }, [i]);

  return (
    <section id="integrations" className="section" data-theme="light">
      <div className="container">
        <SectionHead eyebrow="Integrations" title="Adopt it without rewiring your stack.">
          <p>HTTPS and JSON, plus native SDKs. Nothing to rewire.</p>
        </SectionHead>

        <div className="integ" data-reveal="fade">
          <div className="integ-list" role="tablist" aria-label="Integration area">
            {GROUPS.map((x, k) => (
              <button
                key={x.id}
                type="button"
                role="tab"
                aria-selected={k === i}
                className={`integ-tab ${k === i ? "is-active" : ""}`}
                onClick={() => setI(k)}
              >
                <span className="integ-title">{x.title}</span>
                <span className="integ-logos">
                  {x.logos.map((l) => (
                    <BrandLogo key={l} id={l} size={20} label={false} />
                  ))}
                </span>
              </button>
            ))}
          </div>
          <div className="integ-panel" ref={panel} role="tabpanel">
            <div className="integ-logos big">
              {g.logos.map((l) => (
                <BrandLogo key={l} id={l} size={26} />
              ))}
            </div>
            <p>{g.text}</p>
            <CodeBlock code={g.code} label={g.file} />
          </div>
        </div>
        <p className="fineprint">
          Product names and logos belong to their owners and are shown to indicate compatibility, not endorsement.
        </p>
      </div>
    </section>
  );
}
