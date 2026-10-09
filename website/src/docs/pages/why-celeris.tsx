import { useState } from "react";

import { Badge, Button, Callout, DocLink, H2, H3, Table, type DocPage } from "../kit";

interface Q {
  id: string;
  text: string;
  /** Which answer is a point in favour ("for") or a blocker ("block"). */
  yes?: "for" | "block";
  no?: "for" | "block";
  forReason?: string;
  blockReason?: string;
}

const QUESTIONS: Q[] = [
  {
    id: "keyed",
    text: "Is most of your access by key or by simple filters (look up a cart, list a user's items, sort by a field)?",
    yes: "for",
    no: "block",
    forReason: "Keyed access with JSON filters, indexes and sorting is exactly what it is built for.",
    blockReason: "Your access pattern does not look keyed. Without SQL or joins you would be working against the grain.",
  },
  {
    id: "sql",
    text: "Do you need SQL, joins, or transactions that span many unrelated keys?",
    yes: "block",
    blockReason: "No SQL, and a batch that spans replica sets is rejected rather than faked. A relational database fits better.",
  },
  {
    id: "mixed",
    text: "Do different parts of your data need different guarantees (say, payments must be exact while a feed must always accept writes)?",
    yes: "for",
    forReason: "Choosing consistency per request is the central idea: strict for the money, available for the feed, in one database.",
  },
  {
    id: "retry",
    text: "Do you retry failed requests, or have effects (charges, orders, counters) that must not be applied twice?",
    yes: "for",
    forReason: "Mutation IDs make retries safe and give you a way to ask whether a timed-out write committed.",
  },
  {
    id: "scans",
    text: "Is a large part of your workload analytics-style scans over huge ranges?",
    yes: "block",
    blockReason: "Scans are not point-in-time snapshots and this is not an analytics engine. Pair it with a warehouse instead.",
  },
  {
    id: "ops",
    text: "Are you comfortable running a self-hosted, pre-1.0 database and reading its known limits first?",
    yes: "for",
    no: "block",
    forReason: "Self-hosting is the only model, and you accept the pre-1.0 status.",
    blockReason: "It is self-hosted only, with no managed service, and it is pre-1.0. If you need either, wait or choose something managed.",
  },
];

function FitQuiz() {
  const [ans, setAns] = useState<Record<string, boolean>>({});
  const answered = Object.keys(ans).length;
  const done = answered === QUESTIONS.length;

  const reasonsFor: string[] = [];
  const blockers: string[] = [];
  if (done) {
    for (const q of QUESTIONS) {
      const a = ans[q.id];
      const effect = a ? q.yes : q.no;
      if (effect === "for" && q.forReason) reasonsFor.push(q.forReason);
      if (effect === "block" && q.blockReason) blockers.push(q.blockReason);
    }
  }
  const verdict = blockers.length > 0 ? "not-yet" : reasonsFor.length >= 3 ? "fit" : "pilot";

  return (
    <section className="demo" aria-label="Should I use CelerisDB?">
      <header className="demo-head">
        <div>
          <span className="demo-tag">Interactive</span>
          <strong>Should I use it?</strong>
        </div>
        <div className="demo-controls">
          <Button onClick={() => setAns({})} disabled={answered === 0}>
            Start over
          </Button>
        </div>
      </header>
      <div className="demo-stage">
        <ol style={{ listStyle: "none", margin: 0, padding: 0, display: "flex", flexDirection: "column", gap: 10 }}>
          {QUESTIONS.map((q, i) => (
            <li
              key={q.id}
              style={{
                display: "flex",
                flexWrap: "wrap",
                gap: 8,
                alignItems: "center",
                justifyContent: "space-between",
                padding: "10px 12px",
                borderRadius: 10,
                background: "var(--d-bg-2)",
              }}
            >
              <span style={{ flex: "1 1 260px", fontSize: 14, lineHeight: 1.5 }}>
                <strong style={{ color: "var(--d-faint)" }}>{i + 1}. </strong>
                {q.text}
              </span>
              <span style={{ display: "inline-flex", gap: 6 }}>
                <Button pressed={ans[q.id] === true} onClick={() => setAns((a) => ({ ...a, [q.id]: true }))}>
                  Yes
                </Button>
                <Button pressed={ans[q.id] === false} onClick={() => setAns((a) => ({ ...a, [q.id]: false }))}>
                  No
                </Button>
              </span>
            </li>
          ))}
        </ol>
        <div aria-live="polite" style={{ marginTop: 14 }}>
          {!done ? (
            <p style={{ margin: 0, color: "var(--d-muted)", fontSize: 14 }}>
              {answered} of {QUESTIONS.length} answered. Answer all of them to get a recommendation.
            </p>
          ) : (
            <Callout
              kind={verdict === "fit" ? "tip" : verdict === "pilot" ? "note" : "warn"}
              title={
                verdict === "fit" ? "Looks like a good fit" : verdict === "pilot" ? "Worth a small pilot" : "Probably not the right tool yet"
              }
            >
              {blockers.length > 0 ? (
                <>
                  <p>What points away from it:</p>
                  <ul>
                    {blockers.map((b) => (
                      <li key={b}>{b}</li>
                    ))}
                  </ul>
                </>
              ) : null}
              {reasonsFor.length > 0 ? (
                <>
                  <p>What points toward it:</p>
                  <ul>
                    {reasonsFor.map((r) => (
                      <li key={r}>{r}</li>
                    ))}
                  </ul>
                </>
              ) : null}
              {verdict === "pilot" ? <p>Nothing blocks you, but not much argues strongly for it either. Try one workload and measure.</p> : null}
              <p>
                This is a rough guide, not a verdict. Read <a href="#known-limits">the known limits</a> before deciding.
              </p>
            </Callout>
          )}
        </div>
      </div>
      <footer className="demo-foot">Runs in your browser. Nothing is sent anywhere.</footer>
    </section>
  );
}

function Body() {
  return (
    <>
      <p>
        Most databases make you pick one consistency level for the whole system, and then hide what happens when the
        network breaks. CelerisDB takes a different position: each request says what it needs, and each response says what
        it actually got. This page explains what that buys you, where it does not help, and how to decide for yourself.
      </p>

      <H2 id="idea">The idea: consistency is per request</H2>
      <p>
        No system can be both linearizable and unconditionally available during a genuine network partition. CelerisDB does
        not claim to break that rule. It makes the trade explicit and lets you make it per operation, instead of burying it
        in a cluster-wide setting.
      </p>
      <p>
        So the same database can hold a payment that must be exactly right and a feed that must always accept writes. The
        payment asks for <code>strict</code>: it needs a majority, and if a majority is unreachable it fails with an error
        that says so. The feed asks for <code>available</code>: it is accepted by any reachable replica and reconciled
        later. A strict request is never quietly downgraded, and every response reports the mode that was applied.
      </p>
      <Table
        head={["Mode", "Choose it when", "During a partition"]}
        rows={[
          [<code key="s">strict</code>, "Correctness first: balances, inventory, uniqueness", "May refuse or wait for a quorum"],
          [<code key="se">session</code>, "Users must see their own writes", "Routes to a replica that has them, or waits"],
          [<code key="b">bounded</code>, "Slightly stale is fine, unbounded is not", "Fails if nothing is fresh enough"],
          [<code key="a">available</code>, "Must always accept writes", "Accepts anywhere, conflicts surfaced"],
          [<code key="e">eventual</code>, "Cheapest path, tolerant data", "Accepts and reconciles"],
        ]}
      />
      <p>
        The details live in <DocLink to="consistency">Consistency</DocLink>, and{" "}
        <DocLink to="how-it-works">How it works</DocLink> shows each path animated.
      </p>

      <H2 id="what-you-get">What you get</H2>
      <ul>
        <li>
          <strong>Writes you can retry.</strong> Every write carries a mutation ID and retries are deduplicated. A timeout
          never turns into a duplicate charge, and you can ask whether a given ID committed.
        </li>
        <li>
          <strong>No silent conflicts.</strong> Concurrent available writes are ordered by a deterministic rule, and every
          loser is kept where you can read it. Background repair keeps replicas converging.
        </li>
        <li>
          <strong>Honest responses.</strong> You get the applied mode, a version, and for bounded reads the staleness. You
          never have to guess whether a read was fresh.
        </li>
        <li>
          <strong>Safe elasticity.</strong> Partitions are fixed in number and placed by a pure calculation, so adding or
          losing a node moves only about 1/N of the data, and ownership changes are fenced so a stale router cannot be
          served wrong data.
        </li>
        <li>
          <strong>Replicas that agree exactly.</strong> Each replica set runs its own consensus log, so versions match on
          every replica and compare-and-set keeps working across a failover.
        </li>
        <li>
          <strong>Useful queries without a query language.</strong> JSON filters, secondary indexes, sorting and
          aggregates, evaluated where the data lives so only matches cross the network. See{" "}
          <DocLink to="queries">Queries</DocLink>.
        </li>
        <li>
          <strong>Live data.</strong> Change streams over WebSocket by key prefix, so a UI can follow data without a
          separate message bus. See <DocLink to="change-streams">Change streams</DocLink>.
        </li>
        <li>
          <strong>Easy to run.</strong> One binary, a container image, a Kubernetes manifest, Prometheus metrics, token
          scopes and TLS. No JVM and no separate coordination service.
        </li>
      </ul>

      <H2 id="verified">Verified, not just asserted</H2>
      <p>The claims above have tests behind them, layered from small to adversarial:</p>
      <ul>
        <li>
          <strong>Linearizability checker.</strong> Concurrent histories on the strict path are recorded under leader
          failure and checked against the rule they must satisfy.
        </li>
        <li>
          <strong>Chaos suite.</strong> Seeded, replayable runs inject partitions, crashes and restarts while clients do
          read-then-compare-and-set increments. The invariant is that no acknowledged write is lost or applied twice, and
          that all replicas converge afterwards.
        </li>
        <li>
          <strong>Crash tests.</strong> A writing process is killed mid-stream repeatedly. Every acknowledged write must
          survive, and the recovered data must have no gaps.
        </li>
        <li>
          <strong>Model-based property tests</strong> compare the storage engine against a simple in-memory model across
          random operations, flushes, compactions and restarts.
        </li>
      </ul>
      <p>
        Tests are evidence, not proof, and the suite has gaps that the limits below list. The project README describes the
        verification layers in more detail.
      </p>

      <H2 id="choose">When to choose it, and when not to</H2>
      <div className="cards">
        <div className="card">
          <strong>A good fit</strong>
          <span>
            Session and user state, carts, feature flags, counters, inventory, device state, collaboration data: keyed data
            that needs a dial between &quot;always correct&quot; and &quot;always up&quot;. Teams that want to run their own
            database as a single binary.
          </span>
        </div>
        <div className="card">
          <strong>Not a fit (yet)</strong>
          <span>
            Relational workloads that need SQL and joins, multi-key ACID transactions across partitions, analytics scans
            over huge ranges, or anyone who needs a managed service or a 1.0 stability guarantee today.
          </span>
        </div>
      </div>

      <FitQuiz />

      <H2 id="compare">Comparing it with something else</H2>
      <p>
        Instead of a feature matrix, which goes stale and rarely tells you what you need, ask each candidate the same
        questions, including this one. Check the answers against that product&apos;s own documentation.
      </p>
      <ol>
        <li>Can I choose consistency per request, or is it one setting for the whole system or table?</li>
        <li>When the network partitions, what exactly does each option do, and does it ever downgrade silently?</li>
        <li>If a write times out, how do I find out whether it was applied? Is a retry safe by construction?</li>
        <li>When two writes conflict, is one silently discarded, or can I see both?</li>
        <li>What does adding or removing a node cost: how much data moves, and are writes blocked while it does?</li>
        <li>Which guarantees are covered by automated fault-injection tests, and which are only documented intent?</li>
        <li>What does it take to operate: processes, dependencies, upgrade story, backups?</li>
        <li>What is the maturity level, and who supports it if something goes wrong at 3 a.m.?</li>
      </ol>
      <p>
        The last two are where CelerisDB is honestly weakest today. It is a young, pre-1.0 project with no commercial
        support offering, so weigh those the way you would for any early-stage dependency.
      </p>

      <H2 id="known-limits">Known limits</H2>
      <p>CelerisDB is pre-1.0 and says so plainly. The current limits, in short:</p>
      <ul>
        <li>
          <strong>Cluster shape.</strong> The control-plane voters are fixed when the cluster is bootstrapped, at 3 or 5, and
          data nodes must be voters. Changing the voter set is deferred work.
        </li>
        <li>
          <strong>Transactions.</strong> Batches are atomic within one replica set. A batch spanning replica sets is
          rejected, not faked.
        </li>
        <li>
          <strong>Scans</strong> are not point-in-time snapshots: concurrent writes may or may not be seen.
        </li>
        <li>
          <strong>Compaction</strong> merges in two levels, so write amplification grows with data size.
        </li>
        <li>
          <strong>Snapshots and exports</strong> are built in memory, up to 1 GiB per group or batch of partitions.
        </li>
        <li>
          <strong>Migration.</strong> Writes to a partition that is moving fail with a retryable error, and mutation-ID
          history does not move with the data.
        </li>
        <li>
          <strong>Available mode.</strong> A pending write is invisible until reconciled, and is lost if its accepting node
          is lost first.
        </li>
        <li>
          <strong>Fault testing.</strong> There is no filesystem harness that drops fsyncs yet, so power-loss guarantees
          follow from write ordering rather than automated tests. Clock skew, disk faults and long soak runs are not yet in
          the chaos suite.
        </li>
        <li>
          <strong>Backups.</strong> No incremental backups or point-in-time recovery yet.
        </li>
      </ul>
      <Callout kind="warn" title="Read before betting production data on it">
        This list is a summary. The project&apos;s design-decisions document explains the reasoning behind each item and is
        the authoritative source.
      </Callout>

      <H2 id="next">Where to go next</H2>
      <H3 id="next-try">Try it</H3>
      <p>
        <DocLink to="quickstart">Quickstart</DocLink> gets a node running in minutes, and the{" "}
        <DocLink to="playground">Playground</DocLink> lets you experiment without installing anything.
      </p>
      <H3 id="next-learn">Learn it</H3>
      <p>
        <DocLink to="core-concepts">Core concepts</DocLink>, <DocLink to="consistency">Consistency</DocLink> and{" "}
        <DocLink to="how-it-works">How it works</DocLink> give you the mental model.
      </p>
      <H3 id="next-run">Run it</H3>
      <p>
        <DocLink to="deployment">Deployment</DocLink>, <DocLink to="production-checklist">the production checklist</DocLink>{" "}
        and <DocLink to="troubleshooting">Troubleshooting</DocLink> cover running it for real.
      </p>
      <p>
        <Badge tone="warn">pre-1.0</Badge> <Badge tone="accent">self-hosted</Badge> <Badge tone="ok">tested under faults</Badge>
      </p>
    </>
  );
}

export const page: DocPage = {
  slug: "why-celeris",
  title: "Why CelerisDB",
  group: "Under the hood",
  summary: "What per-request consistency buys you, who it is for, and an honest look at the trade-offs.",
  keywords: [
    "comparison",
    "alternatives",
    "versus",
    "trade-offs",
    "limitations",
    "known limits",
    "use cases",
    "should i use",
    "cap theorem",
    "pre-1.0",
    "positioning",
  ],
  Body,
};
