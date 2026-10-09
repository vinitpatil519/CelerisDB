import { Callout, DocLink, H2, H3, OsCode, REPO, Table } from "../kit";
import type { DocPage } from "../kit";

function Body() {
  return (
    <>
      <p>
        This page describes how a CelerisDB deployment grows today, what is not possible yet, and how to plan capacity
        honestly around those limits. The short version: scale up a node first, use replicas to spread reads, and treat the
        set of cluster nodes as something you choose carefully at the start.
      </p>

      <H2 id="vertical-horizontal">Vertical and horizontal scaling</H2>
      <Table
        head={["Direction", "What it gives you", "Status"]}
        rows={[
          ["Vertical (bigger node)", "Faster disk, more memory for the block cache and memtable, more CPU for reads and filters", "Works today and is the first lever to pull"],
          ["Horizontal: more replicas of the same data", "More copies for durability and more places to serve relaxed reads", "Works today (replication factor, default 3)"],
          ["Horizontal: more nodes than voters", "Spreading data over additional nodes", "Not available yet (see limits below)"],
          ["Several independent clusters", "Isolation and growth beyond one cluster", "Works today, routed by your application"],
        ]}
      />

      <H2 id="what-scales">What scales today</H2>
      <H3 id="reads">Reads</H3>
      <p>
        Every key belongs to a replica set, which is a Raft group of nodes (three by default). Which replica may answer a
        read depends on the consistency mode you ask for:
      </p>
      <Table
        head={["Mode", "Served by", "Scales reads across replicas?"]}
        rows={[
          [<code key="s">strict</code>, "The group leader, after a read barrier", "No: one leader per replica set"],
          [<code key="b">bounded</code>, "The group leader, after a read barrier", "No"],
          [<code key="se">session</code>, "Any replica whose applied index has reached your session token", "Yes"],
          [<code key="a">available</code>, "Any replica, possibly stale", "Yes"],
          [<code key="e">eventual</code>, "Any replica, possibly stale", "Yes"],
        ]}
      />
      <p>
        To scale reads, use <code>session</code> where you need read-your-writes and <code>eventual</code> or{" "}
        <code>available</code> where staleness is fine, and spread requests across the nodes of the replica set. See{" "}
        <DocLink to="consistency">Consistency</DocLink> for the guarantee behind each mode.
      </p>

      <H3 id="writes">Writes</H3>
      <p>
        A strict write is a Raft commit in one replica set: a majority of that set (two of three) must accept it. All
        writes to keys of one replica set go through that set&apos;s leader, so one replica set has a single write path.
        Partitions that share the same three nodes share one Raft group, and the design notes are explicit that at three nodes
        with a replication factor of 3 there is exactly one group.
      </p>
      <p>
        Write throughput can therefore grow when partitions are spread over several different replica sets, each with its own
        leader. That requires more nodes than the replication factor, for example five voters with a replication factor of 3.
        Leaders for different replica sets can then sit on different nodes. Measure with{" "}
        <DocLink to="performance:load-testing">celeris bench</DocLink> on your own layout before relying on it, because the
        project has not published scaling numbers.
      </p>

      <H2 id="limits">What does not scale yet</H2>
      <Callout kind="warn" title="State these limits in your design documents">
        <ul>
          <li>
            <strong>The voter set is fixed.</strong> The control-plane voters are listed in <code>cluster.voters</code> when
            the cluster is created. Changing the set needs joint consensus, which is not implemented. Use three or five.
          </li>
          <li>
            <strong>Data nodes are the voters.</strong> Cluster data nodes must be control-plane voters. Non-voter data
            nodes are on the roadmap but not built, so you cannot add storage-only nodes. On Kubernetes, do not change{" "}
            <code>replicas</code> beyond the three voters, and never scale below three.
          </li>
          <li>
            <strong>Compaction is full.</strong> The engine merges all tables of a node into one run, so write amplification
            grows with data size. Leveled compaction is future work.
          </li>
          <li>
            <strong>Large replica-set snapshots are in memory.</strong> A catch-up snapshot for a group larger than 1 GiB is
            not streamed yet, and a partition export during migration is built in memory (up to 1 GiB per batch of
            partitions).
          </li>
          <li>
            <strong>Old groups are not cleaned up.</strong> Groups that no longer own partitions are not yet deleted from disk.
          </li>
        </ul>
      </Callout>
      <p>
        In practice this means the capacity of a cluster is the capacity of its three or five nodes. If you outgrow them,
        grow the nodes (bigger disks and machines) or run several clusters.
      </p>

      <H2 id="capacity-planning">Capacity planning</H2>
      <p>Plan from measured data rather than from rules of thumb. A workable method:</p>
      <ol>
        <li>
          <strong>Measure bytes per record.</strong> Load a representative sample (a day of data, or a few percent of a
          dataset) with your real keys and values, then read the size of the stored tables. The gauge{" "}
          <code>celeris_storage_table_bytes</code> in <code>/metrics</code> and the <code>table_bytes</code> field of{" "}
          <code>/v1/status</code> both report it. Divide by the number of records.
        </li>
        <li>
          <strong>Multiply out.</strong> Per-node data is roughly the total data size times the replication factor, divided
          by the number of nodes. With three nodes and a replication factor of 3, every node holds a full copy.
        </li>
        <li>
          <strong>Add indexes.</strong> Every secondary index adds an entry per indexed record. Measure with the indexes
          declared, since they are written into the same storage.
        </li>
        <li>
          <strong>Add headroom for compaction.</strong> Compaction writes a new merged run before the old tables are
          deleted, so a node needs free space for roughly another copy of its tables at the moment a full compaction runs.
          Leave generous free space and alert on disk usage well before it is full.
        </li>
        <li>
          <strong>Add log and retention space.</strong> The write-ahead log and the replication log are bounded (the group
          log is compacted after <code>cluster.snapshot_threshold</code> entries, 10,000 by default), but deleted and expired
          data is retained for <code>storage.tombstone_retention_secs</code> (24 hours by default) before it is purged.
        </li>
        <li>
          <strong>Size memory and IOPS from a load test.</strong> Use <code>celeris bench</code> with your value size and
          concurrency, and watch the cache hit ratio and write stalls.
        </li>
      </ol>
      <OsCode
        linux={`curl -s http://127.0.0.1:8080/metrics | grep -E "celeris_storage_(table_bytes|l0_tables|l1_tables)"
df -h ./celeris-data`}
        macos={`curl -s http://127.0.0.1:8080/metrics | grep -E "celeris_storage_(table_bytes|l0_tables|l1_tables)"
df -h ./celeris-data`}
        windows={`curl.exe -s http://127.0.0.1:8080/metrics | Select-String "celeris_storage_(table_bytes|l0_tables|l1_tables)"
Get-PSDrive C | Select-Object Used, Free   # or the drive that holds your data directory`}
        title="Table size and free disk"
      />
      <Callout kind="note">
        <p>
          Adjust the paths to your data directory (<code>celeris-data</code> is the default <code>node.data_dir</code>). Use
          the volume that actually holds it.
        </p>
      </Callout>

      <H2 id="rebalancing">Rebalancing</H2>
      <p>
        The 4096 logical partitions are fixed for the life of a cluster; keys are never re-hashed. Adding or losing a node
        changes which nodes hold which partitions, and the data for a changed partition moves to its new replica set.
      </p>
      <ul>
        <li>
          <strong>Automatic.</strong> The control-plane leader re-places partitions once the set of live members has differed
          from the current placement, unchanged, for <code>cluster.auto_rebalance_after_ms</code> (30 seconds by default;{" "}
          <code>0</code> disables it). The delay stops a flapping node from causing churn.
        </li>
        <li>
          <strong>On request.</strong> <code>celeris cluster rebalance --rf 3</code> proposes a new placement. Any voter
          accepts it and forwards it to the leader.
        </li>
        <li>
          <strong>One at a time.</strong> A new rebalance is refused with <code>409 migrations_pending</code> until the
          previous one has finished moving data. <code>/v1/status</code> shows running migrations by phase under{" "}
          <code>control.migrations</code>.
        </li>
        <li>
          <strong>What clients see.</strong> While a partition moves, writes to it fail with <code>503 partition_moving</code>{" "}
          (not applied, safe to retry) and reads keep working until the release. After the move, versions restart in the
          destination group, so a compare-and-set using an old version fails safely with <code>condition_failed</code> and
          must re-read. Mutation-ID records do not move, so a retry of a pre-move mutation after the move is not
          deduplicated by the new group.
        </li>
      </ul>
      <OsCode
        unix={`celeris partitions                 # placement summary: epoch, per-node replicas and leaders
celeris partitions --key users/42  # the partition, epoch and replicas for one key
celeris status                     # shows migrations and anti-entropy
celeris cluster rebalance --rf 3`}
        windows={`celeris partitions
celeris partitions --key users/42
celeris status
celeris cluster rebalance --rf 3`}
        title="Inspect and trigger rebalancing"
      />

      <H3 id="rolling">Rolling restarts and upgrades</H3>
      <p>
        Restart one node at a time and wait until it reports ready before touching the next. A replica set of three keeps
        accepting writes while one node is down, but two nodes down at once loses the majority. On Kubernetes the provided
        PodDisruptionBudget keeps a Raft majority up during voluntary disruptions. Upgrade every node before you add secondary
        indexes to the configuration, because a node without index support cannot apply them.
      </p>
      <OsCode
        unix={`# on each node in turn
celeris stop
# ... upgrade the binary ...
celeris start --config celeris.toml &
until curl -sf http://127.0.0.1:8080/ready >/dev/null; do sleep 1; done
celeris node list`}
        windows={`# on each node in turn
celeris stop
# ... upgrade the binary ...
Start-Process celeris -ArgumentList "start","--config","celeris.toml"
do { Start-Sleep 1; curl.exe -sf http://127.0.0.1:8080/ready | Out-Null } until ($LASTEXITCODE -eq 0)
celeris node list`}
        title="One node at a time"
      />

      <H2 id="hot-keys">Hot keys and hot partitions</H2>
      <p>
        A key always maps to one partition, a partition to one replica set, and writes to that replica set go through one
        leader. A single very hot key therefore cannot be spread across nodes by the database. Options:
      </p>
      <ul>
        <li>
          Serve reads of the hot key with <code>session</code> or <code>eventual</code> consistency so any replica can answer.
        </li>
        <li>
          Split the key in your application (for example a counter per shard, <code>counter/42/0</code> to{" "}
          <code>counter/42/7</code>) and combine on read.
        </li>
        <li>
          Remember that partitions come from hashing the whole key, so keys that share a prefix and sort together for scans are
          still spread across partitions. Hot spots come from single keys, not from shared prefixes.
        </li>
        <li>
          Find the owner of a key with <code>celeris partitions --key K</code> and compare per-node leader counts in{" "}
          <code>celeris partitions</code> to see whether leaders are balanced.
        </li>
      </ul>

      <H2 id="tenants">Multi-tenant layouts</H2>
      <p>
        Prefix every key with the tenant: <code>acme/users/42</code>. Prefix scans, queries, indexes and exports all take a
        prefix, so you can list, query or export one tenant without reading the others. An index declares a key prefix, so you can
        index every tenant at once (an empty or shared prefix) or only the tenants that need it.
      </p>
      <Callout kind="warn" title="Tokens are not scoped to a prefix">
        <p>
          API tokens carry the scopes <code>read</code>, <code>write</code> and <code>admin</code>. They do not restrict access
          to a key prefix. If tenants must be isolated from each other at the data layer, enforce it in your application or
          give each tenant its own cluster. See <DocLink to="security">Security</DocLink>.
        </p>
      </Callout>

      <H2 id="sharding">When to use several clusters</H2>
      <p>
        Because a cluster is bounded by its three or five nodes, running several independent clusters is a legitimate way to
        scale out today. Consider it when:
      </p>
      <ul>
        <li>one cluster&apos;s disk, memory or write path is saturated and a bigger machine is not an option;</li>
        <li>tenants or products need hard isolation, separate upgrade schedules or separate regions;</li>
        <li>a noisy workload should not affect a latency-sensitive one.</li>
      </ul>
      <p>
        Your application chooses the cluster, for example by hashing the tenant ID or looking it up in a small routing table.
        Keep that mapping stable, because moving a tenant means exporting from one cluster and importing into another (see{" "}
        <DocLink to="backup-restore:logical">logical export and import</DocLink>). Cross-cluster transactions do not exist.
      </p>

      <H2 id="roadmap">Roadmap pointers</H2>
      <p>
        The project roadmap lists the work that would lift the limits above: non-voter data nodes, voter-set changes through
        joint consensus, deleting groups that no longer own partitions, streaming large snapshots and partial compaction. Read{" "}
        <a href={`${REPO}/blob/main/docs/ROADMAP.md`} target="_blank" rel="noreferrer">
          docs/ROADMAP.md
        </a>{" "}
        for the current status; do not plan around an item until it is checked off there.
      </p>

      <H2 id="next">Next steps</H2>
      <ul>
        <li>
          <DocLink to="clustering">Clustering</DocLink> to set up voters, zones and replication.
        </li>
        <li>
          <DocLink to="performance">Performance tuning</DocLink> for single-node efficiency.
        </li>
        <li>
          <DocLink to="production-checklist">Production checklist</DocLink> to confirm the topology items.
        </li>
      </ul>
    </>
  );
}

export const page: DocPage = {
  slug: "scaling",
  title: "Scaling",
  group: "Operate",
  summary: "What scales today, what does not, and how to plan capacity, rebalance and use several clusters.",
  keywords: ["capacity planning", "horizontal", "vertical", "sharding", "rebalance", "hot key", "multi-tenant", "replicas", "voters", "disk size", "rolling restart", "upgrade"],
  Body,
};
