import { useState } from "react";

import { BrandLogo, CodeBlock, SectionHead } from "../components/kit";

const SDKS = [
  {
    id: "typescript",
    label: "TypeScript",
    file: "app.ts",
    code: `import { Client } from "@celeris/client";

const db = new Client({ nodes: ["https://db.acme.dev"], token });

await db.put("orders/9281", { status: "paid", total: 120 });
for await (const o of db.query({ prefix: "orders/", where: { status: "paid" },
                                 sort: { field: "total", order: "desc" } }))
  console.log(o.key, o.value.total);`,
  },
  {
    id: "python",
    label: "Python",
    file: "app.py",
    code: `from celeris import Client, OutcomeUnknownError

db = Client(["https://db.acme.dev"], token=TOKEN)

try:
    db.put("orders/9281", {"status": "paid", "total": 120})
except OutcomeUnknownError as e:
    db.mutation_status(e.mutation_id)   # did it commit? ask, don't guess`,
  },
  {
    id: "go",
    label: "Go",
    file: "main.go",
    code: `db, _ := celeris.New(celeris.Options{Nodes: []string{"https://db.acme.dev"}})

// Keeps working through a partition; reconciled when it heals.
_, err := db.Put(ctx, "likes/77", 1,
    &celeris.PutOptions{Consistency: celeris.Available})`,
  },
  {
    id: "rust",
    label: "Rust",
    file: "main.rs",
    code: `let db = Client::builder().nodes(["https://db.acme.dev"]).build()?;

// Retries reuse the mutation ID: applied exactly once.
let written = db.put("orders/9281", &order).await?;
let mut stream = db.watch("orders/").await?;`,
  },
  {
    id: "curl",
    label: "HTTP",
    file: "terminal",
    code: `curl -X PUT https://db.acme.dev/v1/kv/orders/9281 \\
  -H "authorization: Bearer $TOKEN" \\
  -d '{"status":"paid","total":120}'

curl -X POST https://db.acme.dev/v1/query \\
  -d '{"prefix":"orders/","aggregate":{"count":true,"sum":["total"]}}'`,
  },
];

const POINTS = [
  ["Safe retries", "Applied exactly once."],
  ["Honest outcomes", "Unknown means unknown."],
  ["Read your writes", "Sessions across replicas."],
  ["Live data", "Change streams and a React hook."],
];

export function Developers() {
  const [tab, setTab] = useState(0);
  const sdk = SDKS[tab]!;
  return (
    <section id="developers" className="section alt" data-theme="light">
      <div className="container dev-grid">
        <div>
          <SectionHead eyebrow="Developers" title="One API. Four SDKs. The same guarantees.">
            <p>Identical failure semantics in every language.</p>
          </SectionHead>
          <dl className="dev-points" data-reveal="fade">
            {POINTS.map(([t, d]) => (
              <div key={t}>
                <dt>{t}</dt>
                <dd>{d}</dd>
              </div>
            ))}
          </dl>
        </div>
        <div className="dev-code" data-reveal="fade" data-delay="0.1">
          <div className="seg" role="tablist" aria-label="Language">
            {SDKS.map((s, k) => (
              <button key={s.id} type="button" role="tab" aria-selected={k === tab} onClick={() => setTab(k)}>
                {s.id !== "curl" ? <BrandLogo id={s.id} size={14} label={false} /> : null}
                {s.label}
              </button>
            ))}
          </div>
          <CodeBlock code={sdk.code} label={sdk.file} key={sdk.id} />
        </div>
      </div>
    </section>
  );
}
