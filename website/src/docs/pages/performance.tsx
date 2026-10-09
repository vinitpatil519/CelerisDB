import { Callout, Code, CodeTabs, DocLink, H2, H3, OsCode, Steps, Step, Table } from "../kit";
import { TuningAdvisor } from "../demos/TuningAdvisor";
import type { DocPage } from "../kit";

function Body() {
  return (
    <>
      <p>
        Most CelerisDB performance comes from four choices: how durable each write must be, how many writes you send at
        once, how your keys and indexes are shaped, and which consistency mode each read asks for. This page explains each
        trade-off, shows how to measure your own setup with <code>celeris bench</code>, and ends with a tuning workflow.
      </p>

      <Callout kind="warn" title="About the numbers on this page">
        <p>
          The only figures here are the ones recorded in the repository, measured on one Windows 11 laptop with an NVMe SSD.
          The micro-benchmarks run against the storage engine alone (no HTTP, no network, no replication). Treat them as a
          way to compare changes, not as capacity promises. Your hardware, operating system, value sizes and sync mode will
          give different results, so always measure your own workload.
        </p>
      </Callout>

      <TuningAdvisor />

      <H2 id="sync-modes">Sync modes: always or never</H2>
      <p>
        The setting <code>storage.sync</code> (environment variable <code>CELERIS_SYNC</code>) decides when a write is
        forced to stable storage before the server acknowledges it.
      </p>
      <Table
        head={["Event", "sync = always (default)", "sync = never"]}
        rows={[
          ["Process crash", "Every acknowledged write is recovered", "Every acknowledged write is recovered"],
          ["Power loss", "Every acknowledged write is recovered", "A prefix of acknowledged writes is recovered"],
          ["Crash in the middle of a batch", "Batch is recovered entirely or not at all", "Batch is recovered entirely or not at all"],
          ["Cost", "One disk flush (fsync) per group of writes", "No flush on the write path; the OS decides"],
        ]}
      />
      <p>
        With <code>always</code>, a write waits for the disk. That is the safe default and the right choice whenever the
        data matters. With <code>never</code>, the process hands data to the operating system and moves on, which removes
        the fsync from the write path. Choose it only when you can rebuild the data or can tolerate losing the most recent
        writes after a power failure. The power-loss rows follow from the ordering of flushes; they are not yet exercised
        by a filesystem fault-injection harness, which the project lists as future work.
      </p>
      <OsCode
        unix={`# one-off, for a bulk load you can redo
CELERIS_SYNC=never celeris start --config celeris.toml`}
        windows={`# one-off, for a bulk load you can redo
$env:CELERIS_SYNC = "never"
celeris start --config celeris.toml`}
        title="Choose the sync mode at start"
      />
      <Code lang="toml" title="celeris.toml">{`[storage]
sync = "always"   # or "never"`}</Code>

      <H2 id="group-commit">Group commit and concurrency</H2>
      <p>
        With <code>sync = "always"</code>, the engine does not flush once per write. Each writer appends its record to the
        write-ahead log, then queues for a flush. The first writer in the queue performs one flush, and that flush covers
        every record appended before it started. Writers behind it find their data already durable and return. While one
        flush runs, new writers keep appending, and the next flush covers all of them.
      </p>
      <p>
        The practical consequence: throughput under sync always grows with the number of concurrent writers, because
        they share flushes. A single client sending one write at a time pays a full flush per write. A write is only visible
        to readers after its flush, so a reader never sees data that a crash would lose.
      </p>
      <Table
        head={["Measurement (development laptop, NVMe, flush on every batch)", "Before group commit", "With group commit"]}
        rows={[
          ["Puts per second, 8 clients", "1,551", "4,967"],
          ["Puts per second, 32 clients", "1,844", "8,581"],
          ["p99 latency, 8 clients", "10.3 ms", "3.8 ms"],
        ]}
      />
      <p>
        The storage micro-benchmark shows the same shape: about 2.5 K puts/s with one writer under sync always, and about
        5.5 K puts/s with eight writers sharing flushes. With <code>sync = "never"</code> the same benchmark records about
        156 K single puts/s, which shows how much of the always-mode cost is the flush itself.
      </p>
      <Callout kind="tip">
        <p>
          If your application writes serially in a loop, parallelize it (several connections or in-flight requests) or
          batch the writes. Both let the engine amortize the flush.
        </p>
      </Callout>

      <H2 id="batching">Batch writes</H2>
      <p>
        <code>POST /v1/batch</code> applies a group of puts and deletes atomically, under one mutation ID and one commit
        version. It is also the cheapest way to write many keys: one request, one log record and one durability step for
        the whole group.
      </p>
      <Table
        head={["Limit", "Value"]}
        rows={[
          ["Operations per batch", "10,000"],
          ["Keys plus values per batch", "32 MiB"],
          ["Single value", "4 MiB"],
          ["Key", "1 to 1024 bytes of UTF-8"],
        ]}
      />
      <p>
        In the storage micro-benchmark, a batch of ten keys took about 30 microseconds against 6.4 microseconds for a single
        put (sync never), which is roughly 330 K keys/s against 156 K. Larger batches stop helping once the memtables
        fill; the benchmark for batches of 100 mostly measures flush cost, because it disables background work.
      </p>
      <CodeTabs
        group="sdk-lang"
        items={[
          {
            id: "ts",
            label: "TypeScript",
            lang: "ts",
            code: `const res = await fetch("http://127.0.0.1:8080/v1/batch", {
  method: "POST",
  headers: { "content-type": "application/json" },
  body: JSON.stringify({
    ops: [
      { op: "put", key: "orders/1", value: { total: 3 } },
      { op: "put", key: "orders/2", value: { total: 9 } },
    ],
  }),
});
console.log(res.status, await res.json());`,
          },
          {
            id: "py",
            label: "Python",
            lang: "py",
            code: `import json, urllib.request

body = json.dumps({"ops": [
    {"op": "put", "key": "orders/1", "value": {"total": 3}},
    {"op": "put", "key": "orders/2", "value": {"total": 9}},
]}).encode()
req = urllib.request.Request("http://127.0.0.1:8080/v1/batch", data=body,
                             headers={"content-type": "application/json"}, method="POST")
print(urllib.request.urlopen(req).read().decode())`,
          },
          {
            id: "go",
            label: "Go",
            lang: "go",
            code: `package main

import (
	"fmt"
	"io"
	"net/http"
	"strings"
)

func main() {
	body := \`{"ops":[{"op":"put","key":"orders/1","value":{"total":3}},{"op":"put","key":"orders/2","value":{"total":9}}]}\`
	res, err := http.Post("http://127.0.0.1:8080/v1/batch", "application/json", strings.NewReader(body))
	if err != nil {
		panic(err)
	}
	defer res.Body.Close()
	out, _ := io.ReadAll(res.Body)
	fmt.Println(res.Status, string(out))
}`,
          },
          {
            id: "rust",
            label: "Rust",
            lang: "rust",
            code: `// Cargo.toml: reqwest = { version = "0.12", features = ["blocking", "json"] }, serde_json = "1"
fn main() -> Result<(), Box<dyn std::error::Error>> {
    let body = serde_json::json!({"ops": [
        {"op": "put", "key": "orders/1", "value": {"total": 3}},
        {"op": "put", "key": "orders/2", "value": {"total": 9}},
    ]});
    let res = reqwest::blocking::Client::new()
        .post("http://127.0.0.1:8080/v1/batch")
        .json(&body)
        .send()?;
    println!("{} {}", res.status(), res.text()?);
    Ok(())
}`,
          },
        ]}
      />
      <Callout kind="note">
        <p>
          The snippets above call the HTTP API directly so they are self-contained. The language SDKs wrap the same endpoint;
          see <DocLink to="reads-writes">Reads and writes</DocLink> and the SDK pages for the typed helpers. In a cluster, a
          batch must stay within one replica set or it is refused with <code>cross_group_batch</code>.
        </p>
      </Callout>

      <H2 id="values">Value size</H2>
      <p>
        Values are stored as JSON documents, up to 4 MiB each. Smaller values mean smaller log records, smaller memtables
        and tables, and cheaper compaction, because every rewrite of the data moves every byte. The micro-benchmarks use 128
        byte values. If you keep large blobs, store them in object storage and keep the reference in CelerisDB.
      </p>
      <p>
        Also remember that an update replaces the whole value. Splitting a hot, large document into several keys that change
        independently reduces the bytes written per change.
      </p>

      <H2 id="keys">Key design</H2>
      <p>
        Keys are ordered bytes, and scans, queries and indexes all work on key ranges. Design keys so that data you read
        together sits together:
      </p>
      <ul>
        <li>
          Put the grouping first: <code>orders/2026-10/0042</code> keeps one month of orders adjacent, so a prefix scan reads
          them in one pass.
        </li>
        <li>
          Use fixed-width or zero-padded numbers where order matters: <code>orders/0042</code> sorts before{" "}
          <code>orders/0100</code>, whereas <code>orders/42</code> sorts after <code>orders/100</code>.
        </li>
        <li>
          Use a tenant or entity prefix (<code>tenant-7/users/42</code>) so one tenant can be listed, exported or queried
          without touching others.
        </li>
        <li>
          Avoid keys that all start the same way and are written in strictly increasing order if a single client produces
          nearly all your writes; see <DocLink to="scaling:hot-keys">hot keys</DocLink>.
        </li>
      </ul>
      <p>
        Point reads of keys that do not exist are cheap: the micro-benchmark records about 0.26 microseconds per miss thanks
        to bloom filters, against about 1.9 microseconds for a hit in a table on disk and about 1.1 microseconds for a hit
        in the in-memory table.
      </p>

      <H2 id="consistency-cost">Consistency mode and its cost</H2>
      <p>
        Consistency is chosen per request, so you can pay for strong guarantees only where you need them. On a single node
        every mode behaves the same, because there is one replica. In a replicated cluster they differ:
      </p>
      <Table
        head={["Mode", "Who serves a read", "Cost compared with the others"]}
        rows={[
          ["strict (default)", "The group leader, after a read barrier", "Linearizable; needs the leader to confirm it still leads"],
          ["bounded", "The leader, after a read barrier", "Same path as strict, with a staleness bound you provide"],
          ["session", "Any replica that has applied your session token", "Read-your-writes without always going to the leader"],
          ["available / eventual", "Any replica, possibly stale", "No leader round trip; may return older data"],
        ]}
      />
      <p>
        Writes in <code>strict</code> mode commit through the Raft group of the key (two of three replicas must accept). In{" "}
        <code>available</code> and <code>eventual</code> mode, a write sent to a node that is not the group leader is accepted
        locally and answered with <code>202</code>, then committed in the background with last-writer-wins resolution;
        losing writes are recorded as conflicts. See <DocLink to="consistency">Consistency</DocLink> and{" "}
        <DocLink to="available-mode">Available mode</DocLink> for the guarantees you give up. The server counts operations
        per mode in <code>celeris_operations_by_consistency_total</code>, so you can see which modes your traffic actually
        uses.
      </p>

      <H2 id="indexes">Indexes: cost on writes, benefit on queries</H2>
      <p>
        Without an index, <code>POST /v1/query</code> reads the whole key range it is given, <code>max_scanned</code> rows at
        a time, and filters as it goes. A secondary index on a field lets an equality filter read only the keys that match.
      </p>
      <Code lang="toml" title="celeris.toml">{`[[indexes]]
name = "orders_by_status"
prefix = "orders/"
field = "status"
order = "asc"   # or "desc", for sorted queries`}</Code>
      <Table
        head={["Aspect", "What to know"]}
        rows={[
          ["Write cost", "The engine updates index entries in the same atomic commit as the data: one extra delete and one extra put per indexed field that changes. Index only fields you actually filter or sort on."],
          ["Query benefit", "A top-level equality condition on an indexed field (and a range inside the index prefix) reads only the listed keys. The response names the index in use, or null for a plain scan."],
          ["Sorting", "sort needs a ready index on that field with the same order, otherwise the query fails with sort_unavailable."],
          ["Building", "A new index is built in the background, 1,000 keys per step, while the node serves traffic. Queries scan until it is ready. GET /v1/status shows each index as building, ready or dropping."],
          ["Coverage", "String, number, boolean and null values are indexed. Arrays and objects are not."],
          ["Cluster", "Declare the same indexes on every node, and upgrade all nodes before configuring indexes."],
        ]}
      />

      <H3 id="query-tips">Query tips</H3>
      <ul>
        <li>
          Always pass a <code>prefix</code> (or <code>start</code> and <code>end</code>) to narrow the range. It is the
          cheapest filter there is.
        </li>
        <li>
          <code>max_scanned</code> (1 to 100,000, default 10,000) caps the rows read per request. A selective filter may
          return a short page, or none, with a <code>next_cursor</code>; keep paging until the cursor is null.
        </li>
        <li>
          Use <code>fields</code> to project only the paths you need, so less data crosses the network.
        </li>
        <li>
          Page with <code>limit</code> (1 to 1000 for scans) and <code>next_cursor</code> rather than fetching everything in
          one go.
        </li>
        <li>
          Prefer aggregates (<code>aggregate</code> with count, sum, min, max) over downloading rows to add them up client
          side. In a cluster each replica set filters its own data, so only matches cross the network.
        </li>
      </ul>
      <p>
        Scans are not point-in-time snapshots: writes made during a scan may or may not be seen. See{" "}
        <DocLink to="queries">Queries</DocLink> for the full filter syntax.
      </p>

      <H2 id="clients">Clients: connection reuse and retries</H2>
      <ul>
        <li>
          Create one client object per process and reuse it. Building a new client or connection for every request adds
          connection setup (and a TLS handshake over HTTPS) to every call. The server speaks HTTP/1.1 and, with TLS,
          negotiates HTTP/2.
        </li>
        <li>
          The SDKs attach a mutation ID to every write and retry network failures, redirects (<code>not_leader</code>,{" "}
          <code>not_owner</code>) and errors that guarantee nothing was applied, always with the same ID. The server
          deduplicates, so retries are safe and a write is never applied twice.
        </li>
        <li>
          If the outcome of a write cannot be determined, the SDKs surface an unknown-outcome error that carries the
          mutation ID. Resolve it with the mutation status call rather than blindly retrying.
        </li>
        <li>
          The TypeScript SDK has a per-request timeout (10 seconds by default, <code>timeoutMs</code>). In a replicated
          cluster the node waits up to 5 seconds for a write to commit, so do not set the client timeout below that if you
          want to see the server&apos;s answer instead of timing out first.
        </li>
        <li>
          Route by key when you can. A request for a key is accepted only by its partition leader; other nodes answer{" "}
          <code>421</code> with routing hints. The SDKs follow these hints, and <code>GET /v1/partitions/key/&#123;key&#125;</code>{" "}
          tells you the owner.
        </li>
      </ul>

      <H2 id="hardware">Hardware</H2>
      <ul>
        <li>
          <strong>Disk.</strong> Under sync always, write latency is dominated by fsync latency, so the single most useful
          upgrade is a fast local disk. Prefer local NVMe or a high-IOPS SSD volume. The AWS reference layout in the
          deployment docs starts a gp3 volume at 3000 IOPS and 125 MiB/s and raises IOPS for write-heavy workloads, because
          every write is flushed. Instance-store NVMe is faster but is lost when the instance stops; use it only with
          replication factor 3 and backups.
        </li>
        <li>
          <strong>Memory.</strong> The block cache is configurable: <code>storage.block_cache_mb</code> (default 64) holds
          recently read table blocks, and <code>storage.memtable_size_mb</code> (default 32) is the size at which the
          in-memory write buffer is flushed to disk. A larger memtable means fewer flushes and uses more RAM. Compare{" "}
          <code>celeris_storage_block_cache_hits_total</code> with <code>celeris_storage_block_cache_misses_total</code>{" "}
          before raising the cache.
        </li>
        <li>
          <strong>CPU.</strong> Reads that hit memory and filter evaluation are CPU work. Watch CPU during{" "}
          <code>celeris bench</code> before adding cores.
        </li>
        <li>
          <strong>Network.</strong> Keep nodes of a replica set in the same region. Every strict write needs a quorum round
          trip, so cross-region latency adds directly to write latency.
        </li>
      </ul>
      <Code lang="toml" title="celeris.toml">{`[storage]
sync = "always"
memtable_size_mb = 32     # default
block_cache_mb = 64       # default`}</Code>

      <H2 id="os-tuning">Operating system tuning</H2>
      <p>
        None of these are required, and the project has not published numbers for any of them. Change one thing at a time
        and compare with <code>celeris bench</code> before and after.
      </p>
      <Steps>
        <Step title="Measure what your disk can do">
          <p>Check synchronous write latency on the volume that will hold the data directory.</p>
          <OsCode
            linux={`# 1000 synchronous 4 KiB writes; divide the elapsed time by 1000
dd if=/dev/zero of=./fsync-test bs=4k count=1000 oflag=dsync
rm ./fsync-test`}
            macos={`# macOS dd has no oflag; measure with a real run instead
celeris bench --workload put --ops 5000 -c 1 --value-size 128`}
            windows={`# Measure with a real run on the data volume
celeris bench --workload put --ops 5000 -c 1 --value-size 128`}
            title="Disk flush latency"
          />
        </Step>
        <Step title="Raise the open file limit">
          <p>The reference systemd unit in the deployment docs uses a limit of 65536 open files.</p>
          <OsCode
            linux={`# in the [Service] section of the unit
LimitNOFILE=65536

# or, for a shell session
ulimit -n 65536`}
            macos={`# for the current shell
ulimit -n 65536`}
            windows={`# Windows does not use ulimit; no change is normally needed.`}
            lang="text"
            title="Open files"
          />
        </Step>
        <Step title="Keep the machine from throttling">
          <OsCode
            linux={`# optional: use the performance CPU governor (needs the cpupower tool)
sudo cpupower frequency-set -g performance`}
            macos={`# optional on laptops: prevent sleep while a benchmark runs
caffeinate -i celeris bench --workload mixed --ops 20000 -c 16`}
            windows={`# optional: use the High performance power plan
powercfg /setactive SCHEME_MIN`}
            title="Power and frequency"
          />
        </Step>
        <Step title="Keep other software away from the data directory">
          <p>
            Antivirus scanners and backup agents that scan every file touched can add latency. If your policy allows, exclude
            the data directory from real-time scanning, and measure the difference.
          </p>
          <OsCode
            linux={`# nothing to do unless an on-access scanner is installed`}
            macos={`# nothing to do unless an endpoint security tool scans the folder`}
            windows={`# example: exclude the data directory from Microsoft Defender real-time scanning
Add-MpPreference -ExclusionPath "C:\\celeris\\celeris-data"`}
            lang="text"
            title="Scanners"
          />
        </Step>
      </Steps>
      <Callout kind="note">
        <p>
          Run the data directory on a local filesystem. Network filesystems and some synced folders do not give reliable
          flush behavior, which defeats the durability that <code>sync = "always"</code> promises.
        </p>
      </Callout>

      <H2 id="load-testing">Load testing with celeris bench</H2>
      <p>
        <code>celeris bench</code> is a closed-loop HTTP load generator built into the CLI. Each client thread sends a
        request, waits for the answer, then sends the next one. It supports three workloads:
      </p>
      <Table
        head={["Workload", "What each operation does"]}
        rows={[
          [<code key="a">put</code>, "Writes a new key"],
          [<code key="b">get</code>, "Reads a pre-loaded key"],
          [<code key="c">mixed</code>, "70% reads and 30% overwrites of pre-loaded keys (the default)"],
        ]}
      />
      <Table
        head={["Flag", "Default", "Meaning"]}
        rows={[
          [<code key="a">--workload put|get|mixed</code>, "mixed", "Operation mix"],
          [<code key="b">--ops N</code>, "10000", "Total operations"],
          [<code key="c">-c N, --concurrency N</code>, "8", "Concurrent client threads"],
          [<code key="d">--value-size B</code>, "100", "Approximate value size in bytes"],
          [<code key="e">--keys N</code>, "1000", "Keys pre-loaded for get and mixed"],
        ]}
      />
      <OsCode
        linux={`# start a node in one terminal, then in another:
celeris bench --workload put --ops 20000 -c 32 --value-size 256
celeris bench --workload get --ops 50000 -c 16 --keys 10000
celeris bench --workload mixed --ops 20000 -c 16

# machine-readable output
celeris --json bench --workload mixed --ops 20000 -c 16`}
        macos={`# start a node in one terminal, then in another:
celeris bench --workload put --ops 20000 -c 32 --value-size 256
celeris bench --workload get --ops 50000 -c 16 --keys 10000
celeris bench --workload mixed --ops 20000 -c 16

# machine-readable output
celeris --json bench --workload mixed --ops 20000 -c 16`}
        windows={`# start a node in one terminal, then in another:
celeris bench --workload put --ops 20000 -c 32 --value-size 256
celeris bench --workload get --ops 50000 -c 16 --keys 10000
celeris bench --workload mixed --ops 20000 -c 16

# machine-readable output
celeris --json bench --workload mixed --ops 20000 -c 16 | ConvertFrom-Json`}
        title="Run a benchmark"
      />
      <p>
        Point it at another node with <code>--addr</code>, and pass <code>--token</code> if authentication is on (global
        flags go before the subcommand): <code>celeris --addr https://db.example.com:8080 --token $TOKEN bench ...</code>.
      </p>

      <H3 id="reading-results">Reading the results</H3>
      <Code lang="text" title="Output shape">{`workload    Mixed  ops=20000  concurrency=16  value~100B
elapsed     <seconds>   throughput <n> ops/s   errors <n>
latency     p50 <t>  p95 <t>  p99 <t>  max <t>`}</Code>
      <ul>
        <li>
          <strong>p50</strong> is the typical request: half were faster, half slower.
        </li>
        <li>
          <strong>p95 and p99</strong> are the tail. One request in 20 (p95) or in 100 (p99) was slower than this. Users feel
          the tail, so tune against p99, not the average.
        </li>
        <li>
          <strong>max</strong> is the single slowest request and is noisy; use it to spot stalls, not to compare runs.
        </li>
        <li>
          <strong>errors</strong> should be zero. A non-zero count means the number above it describes a partly failing run.
        </li>
        <li>
          Because the loop is closed, raising <code>-c</code> raises offered load. Throughput rises until the server
          saturates; after that latency rises and throughput stays flat. The knee of that curve is your practical limit.
        </li>
      </ul>
      <Callout kind="warn">
        <p>
          The benchmark runs from one machine over HTTP and includes client overhead. It states this itself: compare only
          runs on the same hardware, operating system and sync mode. Run it from a separate machine for realistic network
          behavior, and watch <DocLink to="observability:metrics">the server metrics</DocLink> while it runs.
        </p>
      </Callout>

      <H2 id="reference">Reference micro-benchmarks</H2>
      <p>
        These come from the storage engine&apos;s criterion benchmarks (128 byte values, 50,000 preloaded keys, sync never
        unless noted), one run on a Windows 11 laptop with an NVMe SSD. Use them to see relative costs.
      </p>
      <Table
        head={["Benchmark", "Time", "Rate"]}
        rows={[
          ["Single put", "6.4 us", "156 K puts/s"],
          ["Batch of 10 puts", "30 us", "330 K keys/s"],
          ["Put, sync always, 1 writer", "403 us", "2.5 K puts/s"],
          ["Put, sync always, 8 writers (group commit)", "183 us per put", "5.5 K puts/s"],
          ["Get, hit in memory", "1.1 us", "920 K/s"],
          ["Get, hit in a table", "1.9 us", "540 K/s"],
          ["Get, miss (bloom filter)", "0.26 us", "3.8 M/s"],
          ["Scan of 100 rows, tables", "23 us", "4.3 M rows/s"],
          ["Flush 50 K keys", "62 ms", "800 K keys/s"],
          ["Compact 50 K keys (4 tables)", "57 ms", "880 K keys/s"],
        ]}
      />
      <p>
        Compaction rewrites data: the engine merges all tables into one sorted run, so write amplification grows with data
        size. Leave disk headroom for it (see <DocLink to="scaling:capacity-planning">capacity planning</DocLink>) and watch{" "}
        <code>celeris_storage_compaction_bytes_in_total</code> and <code>..._out_total</code>.
      </p>

      <H2 id="workflow">A tuning workflow</H2>
      <Steps>
        <Step title="Define the target">
          <p>Write down the operation mix, value size, concurrency and the p99 latency you need. Without a target you cannot tell when to stop.</p>
        </Step>
        <Step title="Baseline with the defaults">
          <p>Run <code>celeris bench</code> with your numbers against a production-like node. Save the output (use <code>--json</code>).</p>
        </Step>
        <Step title="Watch the server while it runs">
          <p>
            Scrape <code>/metrics</code> or open <code>celeris status</code>. Look at write stalls, immutable memtables, level
            0 table count and cache misses. See <DocLink to="observability">Observability</DocLink>.
          </p>
        </Step>
        <Step title="Change one thing">
          <p>
            Raise concurrency, batch writes, add an index, pick a weaker consistency mode for a read path, or adjust one
            storage setting. Repeat the same run.
          </p>
        </Step>
        <Step title="Keep or revert">
          <p>Keep a change only if p99 or throughput improved and nothing you care about (durability, freshness) got worse. Record why.</p>
        </Step>
        <Step title="Test the failure case">
          <p>Repeat with a node stopped or with <code>celeris bench</code> running during a restart, because that is when tail latency matters most.</p>
        </Step>
      </Steps>

      <H2 id="next">Next steps</H2>
      <ul>
        <li>
          <DocLink to="observability">Observability</DocLink> to see what the server is doing during a test.
        </li>
        <li>
          <DocLink to="scaling">Scaling</DocLink> for what adding nodes does and does not do.
        </li>
        <li>
          <DocLink to="production-checklist">Production checklist</DocLink> before go-live.
        </li>
      </ul>
    </>
  );
}

export const page: DocPage = {
  slug: "performance",
  title: "Performance tuning",
  group: "Operate",
  summary: "Make it fast: durability settings, group commit, batching, indexes, consistency cost, OS tuning and benchmarking with celeris bench.",
  keywords: ["latency", "throughput", "fsync", "benchmark", "bench", "p99", "tuning", "speed", "slow", "group commit", "cache", "memtable", "optimize"],
  Body,
};
