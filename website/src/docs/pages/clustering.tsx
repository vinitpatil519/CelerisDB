import { Callout, Code, DocLink, H2, H3, OsCode, Params, Steps, Step, Table, type DocPage } from "../kit";
import { QuorumCalc } from "../demos/ConfigBuilder";

function Body() {
  return (
    <>
      <p>
        A CelerisDB cluster is a set of nodes that agree on who owns which data and keep several copies of every key. You choose
        how many copies, where they live, and, per request, how much agreement a read or write needs before it returns. This page
        explains the moving parts at a conceptual level, how to start and operate a cluster, and exactly what happens when nodes
        fail. For the machinery behind it, see <DocLink to="how-it-works">How it works</DocLink>.
      </p>

      <H2 id="vocabulary">Vocabulary</H2>
      <Table
        head={["Term", "Meaning"]}
        rows={[
          ["Node", "One running celeris process with its own data directory."],
          [
            "Voter",
            <>
              A node that takes part in the control plane, a small Raft group that decides which nodes own which partitions. The voter set
              is listed in <code>cluster.voters</code> and fixed when the cluster is created. Use 3 or 5.
            </>,
          ],
          ["Partition", "A slice of the key space. Every key belongs to exactly one partition."],
          [
            "Replica set",
            "The nodes that hold copies of a group of partitions. The size of the set is the replication factor. Each replica set runs its own Raft group, so a write is committed by a majority of its replicas.",
          ],
          ["Zone", "A failure domain such as a rack or availability zone, set per node with cluster.zone. Placement spreads each replica set across zones."],
          ["Partition map", "The control plane's committed record of which nodes serve which partitions, with an epoch that increases on every change."],
        ]}
      />
      <Callout kind="note" title="Two layers of agreement">
        The control plane (voters) decides placement and changes it rarely. The data plane (one replica set per group of partitions)
        handles every read and write. Losing the control plane's majority stops placement changes but does not stop reads and
        writes for replica sets that still have their own majority.
      </Callout>

      <H2 id="quorum">Quorum math</H2>
      <p>
        A group of <em>n</em> members needs a majority, <code>floor(n / 2) + 1</code>, to commit anything. It tolerates{" "}
        <code>n - majority</code> members being down. Even sizes cost a node without buying tolerance.
      </p>
      <Table
        head={["Members", "Majority", "Failures tolerated", "Notes"]}
        rows={[
          ["1", "1", "0", "Single node"],
          ["2", "2", "0", "Worse than 1 node: either failure stops writes"],
          ["3", "2", "1", "The default for voters and for replication factor"],
          ["4", "3", "1", "Same tolerance as 3"],
          ["5", "3", "2", "Control plane or replica set that survives two failures"],
        ]}
      />
      <p>
        The voter count and the replication factor are separate numbers. With five voters and a replication factor of three, the
        control plane tolerates two failures, but each replica set still tolerates one. Try it:
      </p>
      <QuorumCalc />

      <H2 id="bootstrap">Bootstrapping a cluster</H2>
      <p>
        Give every node a fixed ID, a cluster listen address, an address peers can reach it on, the same list of voters, and a
        list of seeds to find each other through. The full three-node configuration for your environment is easiest to produce with
        the <DocLink to="deployment:topologies">config builder</DocLink>; the essential keys are:
      </p>
      <Code lang="toml" title="celeris.toml on node-a">{`[node]
id = "node-a"

[http]
listen = "0.0.0.0:8080"

[cluster]
listen = "0.0.0.0:7000"
advertise = "node-a.example.internal:7000"
seeds = ["node-a.example.internal:7000", "node-b.example.internal:7000", "node-c.example.internal:7000"]
voters = ["node-a", "node-b", "node-c"]
zone = "zone-a"
replication_factor = 3`}</Code>
      <p>
        <code>advertise</code> is required whenever <code>listen</code> is a wildcard address. The seeds are only used to discover members;
        the voters decide the control plane. A node with <code>cluster.voters</code> or <code>cluster.seeds</code> but no{" "}
        <code>cluster.listen</code> refuses to start.
      </p>
      <Steps>
        <Step title="Start every voter">
          <p>
            Start all three nodes in any order. Until the first placement exists, the cluster has a membership view but serves no data
            (requests get <code>503 no_partition_map</code>).
          </p>
        </Step>
        <Step title="Wait for automatic first placement">
          <p>
            Once <em>every</em> configured voter is alive, the control-plane leader places partitions on its own with{" "}
            <code>cluster.replication_factor</code> replicas, capped at the node count. It waits for all voters on purpose: placing on the
            first quorum would immediately cause a migration when the rest arrive. Set the factor to 0 to disable this and place manually.
          </p>
        </Step>
        <Step title="Verify">
          <OsCode
            unix={`celeris --addr http://127.0.0.1:8080 node list
celeris --addr http://127.0.0.1:8080 partitions
celeris --addr http://127.0.0.1:8080 status`}
            windows={`celeris --addr http://127.0.0.1:8080 node list
celeris --addr http://127.0.0.1:8080 partitions
celeris --addr http://127.0.0.1:8080 status`}
          />
          <p>
            <code>node list</code> shows each node&apos;s state and zone, <code>partitions</code> shows the placement and epoch, and{" "}
            <code>status</code> shows Raft, migrations and anti-entropy results.
          </p>
        </Step>
      </Steps>
      <Code lang="bash" title="Manual first placement (replication_factor = 0)">{`celeris cluster rebalance --rf 3`}</Code>

      <H2 id="zones">Zones and replication factor</H2>
      <p>
        Placement picks replicas for each partition so that they land in different zones first, then fills in with the
        next-best nodes if there are fewer zones than replicas. With three nodes in three zones and a factor of three, every zone
        holds one copy of everything: you can lose a whole zone and keep strict consistency. Load is spread so that nodes stay
        within a small margin of the mean.
      </p>
      <Params
        rows={[
          { name: "cluster.replication_factor", type: "integer", def: "3", desc: <>Replicas per partition for the first placement, capped at the node count. <code>CELERIS_REPLICATION_FACTOR</code>. Change it later with <code>celeris cluster rebalance --rf N</code>.</> },
          { name: "cluster.zone", type: "string", def: "default", desc: <>Failure domain of this node. <code>CELERIS_ZONE</code>.</> },
          { name: "cluster.voters", type: "string[]", def: "[]", desc: <>Node IDs of the control-plane voters. <code>CELERIS_CLUSTER_VOTERS</code>.</> },
          { name: "cluster.seeds", type: "string[]", def: "[]", desc: <>Cluster addresses used to discover members. <code>CELERIS_CLUSTER_SEEDS</code>.</> },
          { name: "cluster.advertise", type: "string", desc: <>Address peers use to reach this node. <code>CELERIS_CLUSTER_ADVERTISE</code>.</> },
          { name: "cluster.raft_election_timeout_ms", type: "integer", def: "1000", desc: "Minimum election timeout; the maximum is twice this. Must exceed twice the heartbeat." },
          { name: "cluster.raft_heartbeat_ms", type: "integer", def: "250", desc: "Raft heartbeat interval." },
          { name: "cluster.snapshot_threshold", type: "integer", def: "10000", desc: "A replica set snapshots its data and discards its applied log after it grows past this many entries." },
          { name: "cluster.auto_rebalance_after_ms", type: "integer", def: "30000", desc: "How long a changed member set must persist before the leader re-places partitions. 0 disables automatic rebalancing." },
          { name: "cluster.anti_entropy_interval_ms", type: "integer", def: "60000", desc: "How often each replica set verifies that its replicas are identical. 0 disables it." },
        ]}
      />
      <Callout kind="tip">
        Prefer a replication factor of 3 on three or five nodes. A factor of 2 needs both replicas for every strict write, which
        adds a failure point without adding tolerance.
      </Callout>

      <H2 id="rebalancing">Adding, removing and rebalancing</H2>
      <p>
        Placement follows the set of live members. The control-plane leader checks every second whether the members that look
        healthy differ from the nodes in the committed map. If the <em>same</em> difference holds continuously for{" "}
        <code>cluster.auto_rebalance_after_ms</code> (30 seconds by default), it proposes a new placement. This hysteresis exists for
        three reasons:
      </p>
      <ul>
        <li>A node that is merely slow is only suspected and keeps its partitions, so brief stalls do not move data.</li>
        <li>A flapping node resets the timer every time the set changes, so it cannot cause churn.</li>
        <li>It never starts while migrations are running, and never before a first placement exists.</li>
      </ul>
      <p>
        The trade-off is that after a node dies its replicas stay under-replicated for at least that long. Set the delay to 0 if you
        prefer an operator to decide, then trigger placement yourself:
      </p>
      <Code lang="bash">{`celeris cluster rebalance --rf 3`}</Code>
      <p>
        Any voter accepts the command; followers forward it to the leader. Without tokens it must come from a loopback connection
        (run it on the node or inside its container); with tokens, use a token with the <code>admin</code> scope.
      </p>
      <H3 id="migration">What a migration costs</H3>
      <p>
        When a partition gets a new replica set, its data is moved by fencing the old copy, copying it to the new group and then
        releasing the old one. Routing changes only after the old copy is gone, so a strict read can never be served stale.
      </p>
      <ul>
        <li>Writes to a moving partition fail with a retryable <code>503 partition_moving</code>. They were not applied. Reads keep working until release.</li>
        <li>Versions restart in the destination group. A compare-and-set with an old <code>if_version</code> fails safely with <code>condition_failed</code>, and the client must re-read.</li>
        <li>A new rebalance is refused with <code>409 migrations_pending</code> until the current moves finish.</li>
        <li>If the source group has lost its majority, its migrations wait until it recovers.</li>
      </ul>
      <Callout kind="warn" title="Current limits">
        The voter set is fixed at bootstrap, and data nodes must be voters. So you cannot yet add a brand-new data node to a running
        cluster or grow from 3 to 5 voters in place. Nodes that leave or die are re-placed around, and a voter that returns is
        brought back into the placement. Non-voter data nodes are on the roadmap. To resize today, build the new cluster and
        move data with <code>celeris export</code> and <code>celeris import</code> (see{" "}
        <DocLink to="backup-restore">Backup and restore</DocLink>).
      </Callout>

      <H2 id="failure">Failure behaviour by consistency mode</H2>
      <p>
        This table assumes a replication factor of 3. A &quot;minority side&quot; is the part of a partitioned network that cannot reach a
        majority of a replica set; &quot;majority side&quot; can. The rules are the same for a crashed node: the survivors are the majority
        side.
      </p>
      <Table
        head={["Mode", "Majority side", "Minority side or no quorum"]}
        rows={[
          [
            <code key="s">strict</code>,
            "Reads and writes succeed. Linearizable.",
            "Fail or time out with an error that says why. Never silently downgraded.",
          ],
          [
            <code key="se">session</code>,
            "Served by a replica that has applied your session's writes.",
            "Served only by a replica that has caught up to your token; otherwise routed to the leader or fails.",
          ],
          [
            <code key="b">bounded</code>,
            "Served by a replica fresh enough for your bound.",
            "Fails if no reachable replica is fresh enough.",
          ],
          [
            <code key="a">available</code>,
            "Committed through the group: 200 with a version.",
            <>Accepted locally and answered <code>202</code> with <code>replicated: false</code>. Reconciled when a quorum returns.</>,
          ],
          [
            <code key="e">eventual</code>,
            "Reads from local state of any replica.",
            "Reads local state, possibly stale. Writes behave like available.",
          ],
        ]}
      />
      <H3 id="failure-details">The details that matter</H3>
      <ul>
        <li>
          <strong>Timeouts are not failures.</strong> If a write gets no confirmation in 5 seconds the answer is{" "}
          <code>outcome_unknown</code>. Resolve it with the mutation ID; retries with the same ID are safe. See{" "}
          <DocLink to="reads-writes">Reads and writes</DocLink>.
        </li>
        <li>
          <strong>A cut-off node cannot hurt the majority.</strong> A returning isolated node does not depose a healthy leader, and a leader that
          cannot reach a majority steps down instead of accepting writes that can never commit.
        </li>
        <li>
          <strong>Available writes are accepted, not replicated.</strong> They are visible only after reconciliation, even on the accepting
          node, and if that node is lost before reconciliation its pending writes are lost. Conflicts are resolved deterministically
          (newest timestamp wins) and the loser is recorded, never discarded silently. See{" "}
          <DocLink to="available-mode">Available mode</DocLink>.
        </li>
        <li>
          <strong>Quorum lost entirely.</strong> A replica set that loses its majority serves no strict operations and pending available writes
          queue up. It recovers on its own when enough members return.
        </li>
      </ul>

      <H3 id="restart">Restarts and catch-up</H3>
      <p>
        A restarted node keeps its identity and data and rejoins through its seeds. It never re-applies entries it already applied.
        If it was down briefly, the leader sends the entries it missed. If it was down long enough that the log has since been
        compacted, the leader sends a snapshot of the current state instead, and the node resumes from there. Deleted data is remembered for{" "}
        <code>storage.tombstone_retention_secs</code> (24 hours by default) so stale copies cannot bring it back, so avoid leaving a
        node down longer than that window.
        </p>
      <OsCode
        unix={`# rolling restart check: wait until the node is ready, then confirm membership
curl -fs http://127.0.0.1:8080/ready && celeris node list`}
        windows={`curl.exe -fs http://127.0.0.1:8080/ready; celeris node list`}
      />

      <H2 id="anti-entropy">Anti-entropy</H2>
      <p>
        Replicas should be identical, but disks and bugs are imperfect. Every <code>cluster.anti_entropy_interval_ms</code> (60
        seconds by default) each replica set's leader asks every replica for a compact digest of its data taken at the same point in the
        log, and compares them. A replica that disagrees with a majority that includes the leader is repaired from the leader&apos;s
        state, and no acknowledged entry is dropped. If the leader itself is in the minority, nothing is repaired automatically.
        Results appear in <code>celeris status</code> and <code>GET /v1/status</code> under <code>control.anti_entropy</code>.
      </p>

      <H2 id="limits">Current limits</H2>
      <ul>
        <li>The voter set is fixed at bootstrap (3 or 5). Changing it needs a new cluster.</li>
        <li>Data nodes must be voters.</li>
        <li>
          <code>celeris backup</code> works on a single node only. In a cluster use <code>celeris export</code> and <code>celeris import</code>.
        </li>
        <li>Certificates for the cluster port are read at start. Rotating them needs a restart.</li>
        <li>Snapshots and migration exports are built in memory, up to 1 GiB per group.</li>
        <li>A change stream sees the changes of its own node&apos;s replica sets. Watch a node in each replica set, or use a replication factor equal to the node count.</li>
        <li>Groups that no longer own anything are not yet deleted from disk.</li>
      </ul>

      <H2 id="next">Next steps</H2>
      <ul>
        <li>
          <DocLink to="deployment">Deployment</DocLink> to run the cluster on Docker, Kubernetes or VMs.
        </li>
        <li>
          <DocLink to="security:cluster-mtls">Mutual TLS</DocLink> to protect the cluster port.
        </li>
        <li>
          <DocLink to="consistency">Consistency modes</DocLink> to choose the right trade-off per request.
        </li>
        <li>
          <DocLink to="scaling">Scaling</DocLink> and <DocLink to="observability">Observability</DocLink>.
        </li>
      </ul>
    </>
  );
}

export const page: DocPage = {
  slug: "clustering",
  title: "Clustering",
  group: "Operate",
  summary: "Voters, replica sets, zones, rebalancing and what happens to each consistency mode when nodes fail.",
  keywords: [
    "raft",
    "quorum",
    "voters",
    "replication factor",
    "replicas",
    "zones",
    "availability zone",
    "failover",
    "partition",
    "split brain",
    "node failure",
    "rebalance",
    "migration",
    "anti-entropy",
    "bootstrap",
    "seeds",
    "high availability",
  ],
  Body,
};
