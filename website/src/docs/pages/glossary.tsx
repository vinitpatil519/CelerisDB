import type { ReactNode } from "react";

import { DocLink, H2, type DocPage } from "../kit";
import { FilterList, type FilterTerm } from "../demos/RefFilter";

function t(term: string, body: ReactNode, also?: string): FilterTerm {
  return { id: term.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, ""), term, body, also };
}

const TERMS: FilterTerm[] = [
  t("Aggregate", <>A query that returns a count, sum, minimum or maximum over the matching records instead of the records themselves. Each page is partial, so totals are merged across pages. See <DocLink to="queries">Queries</DocLink>.</>, "count sum min max"),
  t("Anti-entropy", <>A background check in which each replica set&apos;s leader verifies that its replicas hold identical data and repairs any that have diverged. It runs every <code>cluster.anti_entropy_interval_ms</code>. See <DocLink to="how-it-works">How it works</DocLink>.</>, "repair divergence"),
  t("Available (consistency mode)", <>A mode that keeps accepting reads and writes during a partition or without a quorum, at the cost of possible staleness and of conflicts resolved by last-writer-wins. See <DocLink to="available-mode">Available mode</DocLink>.</>, "ap"),
  t("Backoff", <>Waiting longer between each retry, usually exponentially and with random jitter, so a recovering cluster is not hit by every client at once. See <DocLink to="errors:g-503">Errors</DocLink>.</>, "jitter retry"),
  t("Backup", <>A physical, exact copy of one node&apos;s storage taken online with <code>celeris backup</code>. Cluster-wide copies use <em>export</em>. See <DocLink to="backup-restore">Backup and restore</DocLink>.</>),
  t("Bearer token", <>A secret string sent in the <code>Authorization: Bearer</code> header. The node stores only its SHA-256. See <DocLink to="security">Security</DocLink>.</>, "api key authentication"),
  t("Block cache", <>Memory that keeps recently read data blocks so repeat reads avoid the disk. Sized by <code>storage.block_cache_mb</code>. See <DocLink to="performance">Performance</DocLink>.</>, "cache"),
  t("Bloom filter", <>A small in-memory structure that can say a key is <em>definitely not</em> in a data file, letting reads skip files without touching the disk.</>),
  t("Bounded staleness", <>A read mode that may be behind the latest write by at most a stated number of milliseconds (<code>max_staleness_ms</code>). On a replicated cluster it is served by the leader and so is never stale. See <DocLink to="consistency">Consistency</DocLink>.</>, "bounded"),
  t("CAP theorem", <>When a network partition splits a distributed system, it must choose between staying consistent (refusing some requests) and staying available (answering, possibly with stale data). CelerisDB lets you choose per request. See <DocLink to="core-concepts">Core concepts</DocLink> and <DocLink to="consistency">Consistency</DocLink>.</>, "consistency availability partition tolerance"),
  t("Change stream", <>A WebSocket feed of the changes a node applies, filtered by key prefix. Also called <em>watch</em>. See <DocLink to="change-streams">Change streams</DocLink>.</>, "watch websocket subscribe"),
  t("Compaction", <>Background merging of immutable data files into fewer, larger ones. It removes overwritten values and expired tombstones and keeps reads fast. See <DocLink to="how-it-works">How it works</DocLink>.</>, "merge lsm"),
  t("Compare-and-set", <>A write that applies only if the key still has the version you read (<code>if_version</code>), or does not exist (<code>if_absent</code>). Use it for counters, locks and safe read-modify-write. See <DocLink to="reads-writes">Reads and writes</DocLink>.</>, "cas conditional write optimistic concurrency"),
  t("Conflict", <>Two writes to one key that could not both win. In <em>available</em> mode the loser is kept and listed by <code>celeris conflicts list</code> until you clear it. See <DocLink to="available-mode">Available mode</DocLink>.</>),
  t("Consistency mode", <>The per-request choice of how fresh a read must be or how widely a write must be confirmed: <code>strict</code>, <code>session</code>, <code>bounded</code>, <code>available</code> or <code>eventual</code>. See <DocLink to="consistency">Consistency</DocLink>.</>),
  t("Control plane", <>The small Raft group, made up of the voters, that decides cluster-wide facts such as which nodes hold which partitions. Data requests do not go through it. See <DocLink to="clustering">Clustering</DocLink>.</>, "voters raft metadata"),
  t("CORS", <>A browser rule that lets a web page call an API on another origin. Off by default; enable with <code>http.cors_origins</code>. See <DocLink to="configuration:http">Configuration</DocLink>.</>, "cross-origin"),
  t("Cursor", <>An opaque position returned as <code>next_cursor</code> to fetch the next page of a scan or query. <code>null</code> means the last page. See <DocLink to="http-api:scan">HTTP API</DocLink>.</>, "pagination next_cursor after"),
  t("Data directory", <>The folder where a node keeps everything it persists (<code>node.data_dir</code>). A node ID is tied to its directory. See <DocLink to="configuration:node">Configuration</DocLink>.</>),
  t("Deduplicated", <>A response flag meaning the mutation ID had already committed, so the original result was returned and nothing was written again. See <DocLink to="http-api:put">HTTP API</DocLink>.</>),
  t("Durability", <>The promise that an acknowledged write survives a crash. With <code>storage.sync = &quot;always&quot;</code> each write reaches stable storage before it is acknowledged. See <DocLink to="performance">Performance</DocLink>.</>, "fsync"),
  t("Election", <>The Raft process by which the members of a group pick a new leader after the old one fails. Controlled by the election timeout settings. See <DocLink to="how-it-works">How it works</DocLink>.</>, "leader election term"),
  t("Epoch", <>A counter that increases whenever a map changes. The partition map has one, and each partition has its own. Clients that send <code>celeris-partition-epoch</code> are rejected if their routing is stale. See <DocLink to="http-api:routing">HTTP API</DocLink>.</>, "partition epoch map epoch"),
  t("Epoch fencing", <>Rejecting a request that was routed using an out-of-date map (<code>stale_epoch</code>), so an old view of the cluster can never cause a write to the wrong place.</>, "stale epoch"),
  t("Eventual consistency", <>Replicas converge to the same value if writes stop, but a read may return an older value in the meantime. The fastest, most available read mode. See <DocLink to="consistency">Consistency</DocLink>.</>, "eventual"),
  t("Export / import", <>Logical copy of keys as JSON lines through the API. Works on any cluster, is safe to re-run, and reassigns versions. See <DocLink to="backup-restore">Backup and restore</DocLink>.</>),
  t("Failure domain", <>A set of machines likely to fail together, such as a rack or an availability zone. Set with <code>cluster.zone</code> so replicas are spread across domains.</>, "zone rack availability zone"),
  t("Follower", <>A replica that is not the leader of its Raft group. It replicates the leader&apos;s log and can serve <code>session</code>, <code>available</code> and <code>eventual</code> reads.</>),
  t("Gossip", <>The peer-to-peer exchange by which nodes learn who is alive, suspect, unreachable or has left. See <DocLink to="clustering">Clustering</DocLink>.</>, "membership failure detection heartbeat"),
  t("Hot key", <>A key (or narrow range of keys) that receives far more traffic than the rest, so one partition becomes a bottleneck. See <DocLink to="scaling">Scaling</DocLink>.</>),
  t("Idempotent", <>An operation that has the same effect whether it runs once or many times. A write with a fixed mutation ID is idempotent, so it is safe to retry. See <DocLink to="reads-writes">Reads and writes</DocLink>.</>, "retry safe"),
  t("Last-writer-wins", <>A conflict rule in which the write with the later timestamp survives. Applies to <em>available</em> and <em>eventual</em> writes accepted off-leader. See <DocLink to="available-mode">Available mode</DocLink>.</>, "lww"),
  t("Leader", <>The one member of a Raft group that accepts writes and orders them. A strict read is also served by the leader. If it fails, an election picks another. See <DocLink to="how-it-works">How it works</DocLink>.</>),
  t("Linearizable", <>The strongest single-key guarantee: every operation appears to take effect at one instant between its start and finish, so a read always sees the latest acknowledged write. This is what <code>strict</code> provides in a cluster. See <DocLink to="consistency">Consistency</DocLink>.</>, "strict linearizability strong consistency"),
  t("Loopback", <>An address that only the same machine can reach (127.0.0.1 or ::1). Admin endpoints accept only loopback connections when no API tokens are set. See <DocLink to="http-api:admin-loopback">HTTP API</DocLink>.</>, "localhost 127.0.0.1"),
  t("LSM (log-structured merge)", <>A storage design in which writes go to a log and an in-memory buffer, then are flushed to sorted immutable files that are merged in the background. CelerisDB&apos;s engine is of this family. See <DocLink to="how-it-works">How it works</DocLink>.</>, "storage engine"),
  t("Membership view", <>A node&apos;s current picture of which cluster members exist and their states. Shown by <code>celeris node list</code> and <code>GET /v1/status</code>.</>),
  t("Memtable", <>The in-memory write buffer. When it reaches <code>storage.memtable_size_mb</code> it is flushed to disk as a sorted file.</>, "write buffer"),
  t("Migration", <>Moving a partition&apos;s data to new replicas after a rebalance. While it runs, writes to that partition may answer <code>partition_moving</code>. See <DocLink to="scaling">Scaling</DocLink>.</>, "data movement"),
  t("Mutation ID", <>A UUID that identifies one write. Sending the same ID again never applies the write twice, and <code>GET /v1/mutations/&#123;id&#125;</code> tells you whether it committed. See <DocLink to="reads-writes">Reads and writes</DocLink>.</>, "idempotency key uuid celeris-mutation-id"),
  t("Mutual TLS (mTLS)", <>TLS in which both sides present certificates. Used on the cluster port so only nodes holding a certificate from the cluster CA can join. See <DocLink to="security">Security</DocLink>.</>, "mtls cluster tls"),
  t("Network partition", <>A failure that splits nodes into groups that cannot talk to each other. Not the same as a <em>data partition</em>; context tells them apart. See <DocLink to="core-concepts">Core concepts</DocLink>.</>, "split brain netsplit"),
  t("Node", <>One running <code>celeris</code> process with its own data directory. A cluster is several nodes.</>),
  t("Optimistic concurrency", <>Allowing concurrent writers and detecting conflicts at write time instead of locking. In CelerisDB it uses <code>if_version</code> and the <code>condition_failed</code> error. See <DocLink to="errors:g-condition">Errors</DocLink>.</>),
  t("Outcome", <>What a failed write tells you about its effect: <code>not_applied</code> (nothing changed) or <code>unknown</code> (it may have committed). See <DocLink to="errors:outcome">Errors</DocLink>.</>, "not_applied unknown"),
  t("Partition", <>One of a fixed number of slices of the key space. Each key hashes to exactly one partition, and partitions are assigned to replica sets. Not to be confused with a network partition. See <DocLink to="how-it-works">How it works</DocLink> and <DocLink to="scaling">Scaling</DocLink>.</>, "shard slice"),
  t("Partition map", <>The table of which replicas hold which partitions, committed through the control plane. <code>celeris partitions</code> shows it. See <DocLink to="cli:partitions">CLI</DocLink>.</>),
  t("Prefix", <>The leading part of a key, such as <code>users/</code>. Scans, queries, indexes and change streams all narrow by prefix, so choose key names with prefixes in mind. See <DocLink to="core-concepts">Core concepts</DocLink>.</>, "key namespace"),
  t("Projection", <>Returning only chosen fields of each matching value (<code>fields</code> in a query). See <DocLink to="queries">Queries</DocLink>.</>),
  t("Quorum", <>A majority of a group (2 of 3, 3 of 5). A strict write commits only when a quorum has it, and any two quorums overlap, which is why an acknowledged write is never lost to a new leader. See <DocLink to="consistency">Consistency</DocLink>.</>, "majority"),
  t("Raft", <>The consensus protocol that keeps a group of replicas agreeing on one ordered log, electing a leader and surviving the loss of a minority. CelerisDB runs one Raft group per replica set plus one for the control plane. See <DocLink to="how-it-works">How it works</DocLink>.</>, "consensus"),
  t("Read barrier", <>A confirmation from a quorum that the leader is still the leader, performed before a strict read so the answer cannot be stale after a leadership change.</>),
  t("Read-only mode", <>The state a node enters after a storage failure: it refuses writes (<code>read_only</code>) but still serves reads, and <code>/ready</code> returns 503. See <DocLink to="errors:g-readonly">Errors</DocLink>.</>),
  t("Read-your-writes", <>The guarantee that a client sees its own earlier writes. The <code>session</code> mode provides it from any replica using <code>celeris-session-index</code>. See <DocLink to="consistency">Consistency</DocLink>.</>, "session"),
  t("Rebalance", <>Re-placing partitions on the current members, for example after adding a node. Automatic after membership changes, or on request with <code>celeris cluster rebalance</code>. See <DocLink to="scaling">Scaling</DocLink>.</>),
  t("Replica", <>One copy of a partition&apos;s data on one node.</>),
  t("Replica set", <>The group of nodes that hold copies of the same partitions and run one Raft group together. Also called a replication group. See <DocLink to="clustering">Clustering</DocLink>.</>, "replication group raft group"),
  t("Replication factor (RF)", <>How many replicas each partition has. 3 tolerates the loss of one replica per set. Set with <code>cluster.replication_factor</code>. See <DocLink to="scaling">Scaling</DocLink>.</>, "rf"),
  t("Scan", <>Listing keys in order, optionally by prefix or range, one page at a time. A scan is not a point-in-time snapshot. See <DocLink to="http-api:scan">HTTP API</DocLink>.</>),
  t("Scope", <>What an API token may do: <code>read</code>, <code>write</code> or <code>admin</code>. Scopes do not include each other. See <DocLink to="http-api:auth">HTTP API</DocLink>.</>, "permission role"),
  t("Secondary index", <>A background-maintained lookup on one field of the JSON values, declared in <code>[[indexes]]</code>. It lets equality filters and sorted queries read only matching keys. See <DocLink to="queries">Queries</DocLink>.</>, "index"),
  t("Seed", <>The address of an existing member a new node contacts to join the cluster (<code>cluster.seeds</code>).</>, "bootstrap join"),
  t("Session token", <>The value of <code>celeris-session-index</code>: how far a replica set had applied when you last wrote or read. Send it back so a <code>session</code> read never goes backwards. See <DocLink to="http-api:headers">HTTP API</DocLink>.</>, "celeris-session-index"),
  t("Snapshot (Raft)", <>A compact copy of a replica set&apos;s data that lets the log be trimmed and lets a lagging or new replica catch up quickly. Triggered by <code>cluster.snapshot_threshold</code>.</>),
  t("SSTable (sorted table)", <>Conceptually, an immutable file of key-sorted records written when the in-memory buffer is flushed. Many such files make up the on-disk state, merged by compaction.</>, "sorted string table"),
  t("Strict (consistency mode)", <>The default. Reads and writes go through the leader and a quorum, so results are linearizable. See <DocLink to="consistency">Consistency</DocLink>.</>, "default"),
  t("Tombstone", <>A marker written by a delete (or an expired TTL) that hides older values until every replica has seen it and it can be purged. Kept for <code>storage.tombstone_retention_secs</code> so a stale replica cannot resurrect deleted data.</>, "delete marker"),
  t("Term", <>A Raft counter that increases with each election. A leader from an older term is ignored. Visible in <code>GET /v1/status</code>.</>),
  t("TTL (time to live)", <>An expiry set on a write with <code>ttl_ms</code> (or <code>--ttl</code>). After it, the key reads as not found and is cleaned up later. See <DocLink to="reads-writes">Reads and writes</DocLink>.</>, "expire expiration"),
  t("Version", <>A number that increases with each commit and identifies a value. Returned as <code>celeris-version</code> and used by <code>if_version</code>.</>, "celeris-version etag"),
  t("Voter", <>A node that takes part in the control-plane Raft group (<code>cluster.voters</code>). Use 3 or 5.</>),
  t("WAL (write-ahead log)", <>A sequential log in which every write is recorded before it is applied, so a crash can be recovered by replaying it. With <code>sync = &quot;always&quot;</code> the log is flushed to stable storage before the write is acknowledged. See <DocLink to="how-it-works">How it works</DocLink>.</>, "write ahead log journal"),
  t("Watch", <>See <em>Change stream</em>.</>),
  t("Write stall", <>Writes briefly slowed or paused because background flushing or compaction has fallen behind. Counted in the storage metrics. See <DocLink to="observability">Observability</DocLink>.</>, "backpressure"),
  t("Zone", <>See <em>Failure domain</em>.</>),
].sort((a, b) => a.term.localeCompare(b.term));

function Body() {
  return (
    <>
      <p>
        Short definitions of the terms used across these docs, with a link to the page that explains each one properly. Two words are easy to confuse: a <strong>partition</strong> is a slice of the
        key space, while a <strong>network partition</strong> is a failure that splits nodes from each other.
      </p>
      <H2 id="terms">Terms</H2>
      <FilterList items={TERMS} label="Filter glossary terms" placeholder="Search terms, for example quorum or retry" />
    </>
  );
}

export const page: DocPage = {
  slug: "glossary",
  title: "Glossary",
  group: "Reference",
  summary: "Plain-language definitions of CAP, quorum, Raft, partition, epoch, mutation ID, tombstone, TTL, WAL and every other term used in these docs.",
  keywords: ["definitions", "terminology", "CAP", "quorum", "raft", "linearizable", "tombstone", "wal", "anti-entropy", "epoch"],
  Body,
};
