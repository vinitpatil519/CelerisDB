import { Callout, DocLink, H2, H3, type DocPage } from "../kit";
import FailoverDemo from "../demos/FailoverDemo";
import PartitionRing from "../demos/PartitionRing";
import RetryDemo from "../demos/RetryDemo";
import StorageStack from "../demos/StorageStack";
import WriteJourney from "../demos/WriteJourney";

function Body() {
  return (
    <>
      <p>
        This is a guided tour of what happens to a request inside CelerisDB. It stays at the level of ideas: enough to
        predict how the database behaves when things go well and, more usefully, when they do not. Each section pairs a
        short explanation with something you can poke. Every demo is a simulation running in your browser, with no server
        behind it.
      </p>
      <p>
        If you only remember one thing from this page, make it this: every request tells the cluster how much coordination
        it is willing to pay for, and the cluster tells you honestly what it delivered.
      </p>

      <H2 id="shape">The shape of a cluster</H2>
      <p>
        A cluster is a set of <strong>nodes</strong>, each running the same single binary. Nodes are tagged with a{" "}
        <strong>zone</strong>, such as a rack or an availability zone, so the cluster can keep copies of data apart from
        each other's failures.
      </p>
      <p>
        Your keys are not placed one at a time. Every key is hashed into one of a fixed number of{" "}
        <strong>partitions</strong> (4096 in a real cluster), and the partition is the unit that moves around. Each
        partition is stored on a small group of nodes called its <strong>replica set</strong>: by default three copies,
        chosen from three different zones whenever the topology allows it. One member of the replica set is the{" "}
        <strong>leader</strong> for that partition, and the others are followers.
      </p>
      <p>
        Which nodes hold a partition is not stored in a central table that can fall out of date. It is computed from the
        list of nodes using a technique called <em>rendezvous hashing</em>: for each partition, every node gets a
        deterministic score, and the top scorers (one per zone) win. Any node can do this arithmetic on its own and get the
        same answer. The practical payoff is in the demo: when a node joins or leaves, only the partitions that node wins or
        loses are touched, roughly 1/N of all copies for a cluster of N nodes, instead of reshuffling everything.
      </p>

      <PartitionRing />

      <p>
        Type a key and watch it land in a partition, with its three replicas shown one per zone and the leader marked. Then
        add and remove nodes. The squares that flash are the partitions whose replica set changed; the readout compares the
        number of copies that moved against the ideal 1/N. The demo uses 64 partitions and a toy hash so you can see them
        all, so treat the exact squares as illustrative. The behaviour is the real design.
      </p>
      <Callout kind="note" title="Why a fixed partition count?">
        Keys never get re-hashed when the cluster grows. Only partition ownership moves. That keeps rebalancing predictable
        and lets a router answer &quot;who owns this?&quot; with a cheap local calculation. Ownership carries an epoch, so a
        router working from an out-of-date view is refused and told to refresh rather than being served stale data.
      </Callout>
      <p>
        You can inspect the real thing on a running node with <DocLink to="clustering">the clustering tools</DocLink>, and
        see how to grow a cluster in <DocLink to="scaling">Scaling</DocLink>.
      </p>

      <H2 id="write-journey">A write&apos;s journey</H2>
      <p>
        A write can arrive at any node. That node works out who leads the key&apos;s partition and, if it is not itself the
        leader, forwards the request. The leader then runs a small agreement protocol (Raft, one independent instance per
        replica set) so that the replicas agree on one order of writes. Once a majority of the replica set has made the
        write durable, it is <em>committed</em>, applied, and acknowledged.
      </p>
      <p>
        That is the <code>strict</code> path, and it is what gives you linearizability for a key: one up-to-date view,
        even across failovers. The price is a round trip to a majority. The <code>available</code> path skips that
        coordination: any reachable replica accepts the write, makes it durable locally, and shares it with the others in
        the background. It stays writable through a partition, and concurrent writes to the same key are reconciled
        deterministically, with the losers kept as conflicts you can read. See{" "}
        <DocLink to="consistency">Consistency</DocLink> and <DocLink to="available-mode">Available mode</DocLink> for the
        full contract.
      </p>

      <WriteJourney />

      <p>
        Try all four combinations. The telling one is strict plus partition: the isolated node refuses with an error that
        says no quorum was available, rather than quietly accepting a write it cannot guarantee. A strict request is never
        silently downgraded. Now switch to available with the partition on: the write is accepted and the client is told it
        is still pending. That honesty is deliberate. A pending write is not visible elsewhere until it is reconciled.
      </p>

      <H2 id="retries">Why a retry is safe</H2>
      <p>
        Networks lose responses. When a client times out, it faces a question it cannot answer from its side: did my write
        happen? If it retries and the first attempt did succeed, a naive system applies the operation twice. For a counter
        that is a wrong number, and for a payment it is a double charge.
      </p>
      <p>
        CelerisDB removes the ambiguity with <strong>mutation IDs</strong>. Every write carries one, and the SDKs generate
        it for you. The cluster remembers the outcome of each ID, so a repeated request is recognised and answered with the
        original result (the response says it was deduplicated) instead of being applied again. A timeout never means
        success, and it never means failure either: if you are unsure, you can ask what happened to an ID.
      </p>

      <RetryDemo />

      <p>
        Run it once with mutation IDs, then flip to the naive system and run the exact same sequence. The only difference
        is whether the retry can be recognised. In practice this is what makes it reasonable for client libraries to retry
        automatically. See <DocLink to="reads-writes">Reads and writes</DocLink> for how to supply your own ID and how to
        check an outcome.
      </p>
      <Callout kind="note" title="Remembered for a window, not forever">
        Outcomes are retained for a limited window, so deduplication covers realistic retry behaviour rather than a retry
        that arrives days later. One more caveat from the known limits: while a partition is moving between replica sets,
        its writes fail with a retryable error, and the ID history does not travel with it.
      </Callout>

      <H2 id="failure">When things break</H2>
      <p>
        Every node can fail. The design question is what each consistency level promises while it is happening, so here are
        the behaviours worth knowing.
      </p>
      <H3 id="failure-leader">The leader crashes</H3>
      <p>
        Followers notice missing heartbeats and hold an election. A candidate needs a majority of the replica set, which
        means a new leader always comes from nodes that already hold every committed write. For a short moment there is no
        leader, so strict writes are refused or wait; then a new leader takes over and writes resume. Anything that was
        acknowledged is still there. Writes that were in flight and never acknowledged are the ones whose outcome you
        resolve with their mutation ID.
      </p>
      <H3 id="failure-partition">A node is cut off</H3>
      <p>
        A node on the minority side of a partition cannot reach a quorum, so it cannot serve strict traffic. The majority
        side keeps working, electing a new leader if needed. Available and eventual writes keep being accepted on the
        minority side and are reconciled when the network heals.
      </p>

      <FailoverDemo />

      <p>
        Start the writes, then kill the leader and watch the counters: strict refusals appear during the election and stop
        once a new leader is chosen, while available writes never skip a beat. Reset, change which node the client is
        attached to, and use the partition button to see how the same cluster treats a client stuck on the minority side.
        The simulation is simplified, but the qualitative behaviour is the point.
      </p>
      <Callout kind="warn" title="Know the sharp edge">
        An available-mode write that has not been reconciled yet lives only on the node that accepted it. If that node is
        lost for good before reconciliation, the write is lost with it. If that matters for a piece of data, use strict for
        it.
      </Callout>

      <H2 id="durability">Durable by design</H2>
      <p>
        On each node, data is kept by a log-structured storage engine. The core idea is to turn random writes into
        sequential ones and to be able to recover from a crash at any moment.
      </p>
      <p>
        A write is first appended to a <strong>write-ahead log</strong> on disk, and only then placed into an{" "}
        <strong>in-memory table</strong> that serves fast reads. Because the log comes first, acknowledging a write means it
        can be rebuilt after a crash. Concurrent writers share a flush to disk, so durability does not mean one sync per
        write. When the in-memory table grows large, it is written out as an immutable <strong>sorted file</strong>, and the
        log it covered can be discarded. Over time, a background <strong>compaction</strong> merges those files, dropping
        overwritten and expired data, so reads stay fast.
      </p>

      <StorageStack />

      <p>
        Write a few values until a file appears, then pull the plug. Memory is wiped, but the log and sorted files are on
        disk. On restart the log is replayed and the acknowledged writes come back. The second crash button shows the other
        half of the guarantee: a write that dies before it is acknowledged is simply gone, which is safe because the client
        never heard success and can retry with the same mutation ID.
      </p>
      <p>
        This behaviour is tested rather than assumed: a crash test repeatedly kills a writing process and checks that every
        acknowledged write survives and the recovered data has no gaps. See{" "}
        <DocLink to="why-celeris:verified">how the project is verified</DocLink>, and{" "}
        <DocLink to="backup-restore">Backup and restore</DocLink> for protecting data beyond one machine.
      </p>

      <H2 id="recap">Putting it together</H2>
      <ul>
        <li>Keys map to a fixed set of partitions; partitions map to replica sets spread across zones.</li>
        <li>Placement is a pure calculation, so growing the cluster moves only about 1/N of the data.</li>
        <li>You choose per request: pay for a majority (strict) or stay writable through failures (available).</li>
        <li>Retries are safe because writes carry IDs and outcomes are remembered.</li>
        <li>Acknowledged data is on disk before you hear about it, and survives crashes.</li>
      </ul>
      <p>
        Next: <DocLink to="consistency">pick the right consistency level</DocLink>,{" "}
        <DocLink to="scaling">scale a cluster</DocLink>, or read the honest positioning in{" "}
        <DocLink to="why-celeris">Why CelerisDB</DocLink>.
      </p>
    </>
  );
}

export const page: DocPage = {
  slug: "how-it-works",
  title: "How CelerisDB works",
  group: "Under the hood",
  summary: "A guided, animated tour of partitions, replication, retries, failover and storage, at the level of ideas.",
  keywords: [
    "architecture",
    "internals",
    "raft",
    "replication",
    "partitions",
    "quorum",
    "leader election",
    "failover",
    "write path",
    "wal",
    "lsm",
    "idempotency",
    "rendezvous hashing",
    "durability",
  ],
  Body,
};
