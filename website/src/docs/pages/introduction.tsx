import { Callout, Card, Cards, DocLink, H2, H3, Table, type DocPage } from "../kit";
import { ConsistencyTeaser } from "../demos/ConsistencyTeaser";

function Body() {
  return (
    <>
      <p>
        CelerisDB is a self-hosted, replicated key-value database for JSON documents, written in Rust. You run it as a
        single binary, on one machine or as a Raft-replicated cluster, and talk to it over an HTTP/JSON API, the{" "}
        <code>celeris</code> command line, or one of four SDKs (TypeScript and React, Python, Go and Rust). There is no
        hosted or managed service: you operate it yourself.
      </p>
      <p>
        Its central idea is that <strong>consistency is chosen on every request</strong>, not once for the whole
        database. A read of an account balance can be <code>strict</code> while a read of a dashboard counter is{" "}
        <code>eventual</code>, against the same cluster, in the same minute. Every response then tells you which mode
        was actually applied, so a request is never silently downgraded.
      </p>

      <H2 id="per-request-consistency">The idea: consistency per request</H2>
      <p>
        During a genuine network partition, no system can be both linearizable and unconditionally available. CelerisDB
        does not claim to escape that. It makes the trade-off an explicit argument to each operation instead of burying
        it in a cluster-wide setting. Pick a mode below to see what each one promises.
      </p>
      <ConsistencyTeaser />
      <p>
        The full semantics, with failure behavior for each mode, are on the <DocLink to="consistency">Consistency</DocLink>{" "}
        page. On a single node every mode behaves the same, because there is only one replica; the modes only diverge
        once you replicate.
      </p>

      <H2 id="features">What you get</H2>
      <Table
        head={["Area", "What it does"]}
        rows={[
          [
            "Data model",
            <>
              Keys up to 1024 bytes of UTF-8, JSON values up to 4 MiB, a commit version on every write, optional TTL.
              See <DocLink to="core-concepts">Core concepts</DocLink>.
            </>,
          ],
          [
            "Safe writes",
            <>
              Compare-and-set with <code>if_version</code> and <code>if_absent</code>, atomic batches, and mutation IDs
              that make retries idempotent. A timeout is reported as unknown, never as success.
            </>,
          ],
          [
            "Queries",
            <>
              Prefix and range scans, JSON filters evaluated on the nodes that hold the data, projections, aggregates
              (count, sum, min, max), secondary indexes and sorting. See <DocLink to="queries">Queries</DocLink>.
            </>,
          ],
          [
            "Replication",
            <>
              Keys map to partitions, partitions to replica sets, and each replica set is a Raft group. Writes need a
              majority. See <DocLink to="how-it-works">How it works</DocLink>.
            </>,
          ],
          [
            "Change streams",
            <>
              A WebSocket feed of applied changes by key prefix. See <DocLink to="change-streams">Change streams</DocLink>.
            </>,
          ],
          [
            "Security",
            <>
              Bearer tokens with read, write and admin scopes, TLS for the API, mutual TLS between nodes. See{" "}
              <DocLink to="security">Security</DocLink>.
            </>,
          ],
          [
            "Operations",
            <>
              Prometheus metrics, health and readiness endpoints, online backup and export/import, Docker, Docker
              Compose and a Kubernetes manifest. See <DocLink to="deployment">Deployment</DocLink>.
            </>,
          ],
        ]}
      />

      <H2 id="who-for">Who it is for</H2>
      <p>CelerisDB is a good fit when:</p>
      <ul>
        <li>
          You want to <strong>self-host</strong> a small, understandable database as one binary, without a JVM or an
          external coordination service.
        </li>
        <li>
          Different parts of your application genuinely need different guarantees: strong for money and inventory,
          relaxed for caches, feeds and counters.
        </li>
        <li>
          Your data is naturally key-addressed JSON: sessions, profiles, carts, feature flags, orders looked up by ID
          or by a key prefix.
        </li>
        <li>
          You care that retries are safe and that failures are reported honestly (applied, not applied, or unknown).
        </li>
        <li>You are comfortable adopting a pre-1.0 system and reading its documented limits.</li>
      </ul>

      <H2 id="who-not-for">Who it is not for</H2>
      <p>Be honest with yourself about these before you commit:</p>
      <ul>
        <li>
          <strong>You need a managed service.</strong> None exists. You run, upgrade, back up and monitor it.
        </li>
        <li>
          <strong>You need relational features.</strong> There are no joins, no SQL and no multi-table transactions.
          Batches are atomic only within one replica set; a batch spanning replica sets is rejected rather than
          faked.
        </li>
        <li>
          <strong>You need a 1.0-stable system today.</strong> CelerisDB is pre-1.0. Interfaces and on-disk
          behavior may still change between releases.
        </li>
        <li>
          <strong>You need point-in-time snapshots of scans.</strong> A scan reads committed versions but is not a
          snapshot of the whole keyspace.
        </li>
        <li>
          <strong>You need incremental backups or point-in-time recovery.</strong> Backups are full snapshots or JSON
          lines exports for now.
        </li>
        <li>
          <strong>You need to change the voter set of a running cluster freely.</strong> The control-plane voters
          (3 or 5) are fixed when the cluster is created.
        </li>
      </ul>
      <Callout kind="note" title="Language support">
        Official SDKs exist for TypeScript and React, Python, Go and Rust. Any other language uses the{" "}
        <DocLink to="http-api">HTTP API</DocLink> directly; it is plain JSON over HTTP.
      </Callout>

      <H2 id="shape">The shape of a deployment</H2>
      <p>
        A node serves the client API on port <code>8080</code> and, in a cluster, talks to its peers on a separate
        cluster port, <code>7000</code>. Clients only ever see the API port. A typical production cluster is three nodes
        in three zones with a replication factor of 3, so every write is acknowledged by two of three replicas. A
        laptop or a small service can run a single node with no cluster configuration at all.
      </p>
      <H3 id="first-minutes">Your first five minutes</H3>
      <p>
        Install the binary, run <code>celeris init</code> and <code>celeris start</code>, then store and read a value.
        The <DocLink to="quickstart">Quickstart</DocLink> walks through it, including a three-node cluster you can
        break on purpose. If you would rather poke at the commands first without installing anything, use the{" "}
        <DocLink to="playground">browser playground</DocLink>.
      </p>

      <H2 id="where-next">Where to go next</H2>
      <Cards>
        <Card title="Quickstart" to="quickstart">
          Install, start a node, write and read data, then form a three-node cluster.
        </Card>
        <Card title="Consistency" to="consistency">
          What each of the five modes guarantees and what it costs.
        </Card>
        <Card title="SDKs" to="sdk-typescript">
          Typed clients for TypeScript, Python, Go and Rust, plus the HTTP API for everything else.
        </Card>
        <Card title="Deployment" to="deployment">
          Docker, Compose, Kubernetes and a reference layout for running it in production.
        </Card>
        <Card title="Security" to="security">
          Tokens, scopes, TLS and mutual TLS between nodes.
        </Card>
        <Card title="How it works" to="how-it-works">
          Partitions, replica sets, Raft and the storage engine, at concept level.
        </Card>
        <Card title="Playground" to="playground">
          Try the CLI in your browser against a simulated node, with guided challenges.
        </Card>
        <Card title="Why CelerisDB" to="why-celeris">
          How it compares and when another database is the better choice.
        </Card>
      </Cards>
    </>
  );
}

export const page: DocPage = {
  slug: "introduction",
  title: "Introduction",
  group: "Get started",
  summary: "What CelerisDB is, the idea of per-request consistency, who it is for, and where to go next.",
  keywords: ["overview", "what is celeris", "about", "key-value", "json database", "self-hosted", "raft", "rust", "cap theorem"],
  Body,
};
