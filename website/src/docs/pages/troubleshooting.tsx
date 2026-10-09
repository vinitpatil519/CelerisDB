import { Callout, Code, DocLink, H2, H3, OsCode, REPO, Table } from "../kit";
import type { DocPage } from "../kit";

function Body() {
  return (
    <>
      <p>
        Start with two commands: <code>celeris doctor</code> checks your configuration, data directory, storage lock, port and
        node health, and <code>celeris status</code> shows what a running node thinks of itself and its cluster. Most problems
        are visible in one of them. This page maps symptoms to causes and fixes, then walks through the common failures in
        more detail.
      </p>

      <H2 id="quick-table">Symptom to fix</H2>
      <Table
        head={["Symptom", "Likely cause", "Fix"]}
        rows={[
          ["Node exits at startup, mentions storage or lock", "Another process holds the data directory", "Stop the other process; run celeris doctor"],
          ["Address already in use", "Port 8080 (or 7000) taken", "Change http.listen or cluster.listen, or stop the other program"],
          ["unknown field in config", "A misspelled or unsupported key", "Fix the key; unknown keys are rejected on purpose"],
          ["503 no_partition_map", "No partition map committed yet", "Wait for every voter to start, or run celeris cluster rebalance --rf N"],
          ["421 not_leader or not_owner, repeatedly", "Client is not following routing hints, or leadership keeps changing", "Use an SDK, follow the leader hint, check cluster port connectivity"],
          ["500 outcome_unknown, CLI exit 3", "Write may have committed", "Check celeris mutation <id>, or retry with the same mutation ID"],
          ["503 read_timeout, or writes time out in a cluster", "A majority of the replica set is not reachable", "Check celeris node list, the cluster port and the logs"],
          ["503 read_only, /ready returns 503", "A WAL failure made the node read-only", "Fix the disk, restart the node"],
          ["Writes are slow", "Serial writers under sync always, write stalls, slow disk", "Concurrency, batching, faster disk; see Performance"],
          ["Disk full", "Data, compaction or logs filled the volume", "Free space, restart if read-only, plan headroom"],
          ["TLS handshake or certificate errors", "Private CA not trusted, wrong hostname, plain HTTP to an HTTPS port", "Trust the CA; match the certificate name; use https://"],
          ["401 unauthorized", "Missing or unknown token", "Send Authorization: Bearer <token>; check the configured hash"],
          ["403 forbidden", "Token lacks the scope, or admin call without tokens from a non-loopback address", "Use a token with the right scope, or run on the node"],
          ["PowerShell: curl prints weird output or JSON is rejected", "curl is an alias; JSON quoting differs", "Use curl.exe and the quoting forms below"],
        ]}
      />

      <H2 id="wont-start">The node will not start</H2>
      <H3 id="start-lock">Storage is locked</H3>
      <p>
        A node takes an exclusive lock on its storage directory. A second process pointed at the same directory fails to open
        it. This usually means a node is still running, a previous process did not exit, or two configs share one
        <code> node.data_dir</code>.
      </p>
      <OsCode
        linux={`celeris doctor            # reports "in use by a running node"
ps aux | grep "[c]eleris start"
celeris stop              # graceful, loopback only`}
        macos={`celeris doctor
ps aux | grep "[c]eleris start"
celeris stop`}
        windows={`celeris doctor
Get-Process celeris -ErrorAction SilentlyContinue
celeris stop`}
        title="Find what holds the lock"
      />
      <H3 id="start-port">Port in use</H3>
      <p>
        <code>doctor</code> reports whether the HTTP listen address is available. Find the owner of the port, or change{" "}
        <code>http.listen</code> (<code>CELERIS_HTTP_LISTEN</code>) or <code>cluster.listen</code>.
      </p>
      <OsCode
        linux={`ss -ltnp | grep -E ':(8080|7000)\\b'`}
        macos={`lsof -nP -iTCP:8080 -sTCP:LISTEN`}
        windows={`Get-NetTCPConnection -LocalPort 8080,7000 -State Listen | Select-Object LocalPort, OwningProcess
Get-Process -Id (Get-NetTCPConnection -LocalPort 8080 -State Listen).OwningProcess`}
        title="Who owns the port?"
      />
      <H3 id="start-config">Configuration rejected</H3>
      <ul>
        <li>
          Unknown keys are errors, so a typo such as <code>listen_addr</code> fails fast instead of being ignored.
        </li>
        <li>
          <code>cluster.seeds</code> and <code>cluster.voters</code> require <code>cluster.listen</code>.
        </li>
        <li>
          A wildcard <code>cluster.listen</code> such as <code>0.0.0.0:7000</code> requires <code>cluster.advertise</code>.
        </li>
        <li>
          <code>cluster.suspect_after_ms</code> must exceed <code>heartbeat_interval_ms</code>, and{" "}
          <code>raft_election_timeout_ms</code> must exceed twice <code>raft_heartbeat_ms</code>.
        </li>
        <li>
          Set both <code>CELERIS_TLS_CERT</code> and <code>CELERIS_TLS_KEY</code>, or neither. The cluster TLS variables need
          all three of cert, key and CA.
        </li>
        <li>
          <code>CELERIS_SYNC</code> accepts only <code>always</code> or <code>never</code>, and{" "}
          <code>CELERIS_LOG_FORMAT</code> only <code>pretty</code> or <code>json</code>.
        </li>
        <li>
          A fixed <code>node.id</code> must match the ID already stored in the data directory.
        </li>
      </ul>
      <H3 id="start-data">Storage refuses to open</H3>
      <p>
        The engine is strict about damage. It fails startup, rather than guess, if the table list is missing while table files
        exist, or if a log file other than the newest one is corrupt. A torn tail in the newest log is expected after a crash
        and is repaired automatically. If startup fails with a corruption message, restore from a backup (see{" "}
        <DocLink to="backup-restore">Backup and restore</DocLink>) and keep the damaged directory for diagnosis.
      </p>

      <H2 id="no-partition-map">503 no_partition_map</H2>
      <p>
        In a replicated cluster, data requests fail with this error until the control plane commits the first partition map.
        The control-plane leader does that on its own once <strong>every voter</strong> is alive, using{" "}
        <code>cluster.replication_factor</code> (3 by default).
      </p>
      <ol>
        <li>
          Run <code>celeris node list</code> and confirm all voters are <code>alive</code>.
        </li>
        <li>
          Check each voter&apos;s <code>node.id</code> against the <code>cluster.voters</code> list. A mismatch means a voter
          never appears.
        </li>
        <li>
          Check that nodes can reach each other on the cluster port (7000) and that seeds point at a running member.
        </li>
        <li>
          If <code>replication_factor = 0</code>, nothing is automatic: run <code>celeris cluster rebalance --rf 3</code> once
          (on any voter).
        </li>
      </ol>

      <H2 id="not-leader">421 not_leader or not_owner loops</H2>
      <p>
        Only the leader of a key&apos;s replica set accepts requests for it. Other nodes answer <code>421</code> with hints:{" "}
        <code>leader</code>, <code>replicas</code>, partition and epoch. The SDKs follow these hints automatically. A loop
        means something stops the client reaching the leader or the leader keeps changing.
      </p>
      <ul>
        <li>
          <strong>Raw HTTP clients</strong> must read the <code>leader</code> field and retry there. A plain load balancer
          cannot know which node leads a key.
        </li>
        <li>
          <strong>The leader is not reachable by the client.</strong> The hints name nodes by ID. Map them to addresses with{" "}
          <code>celeris node list</code> and check that clients can reach every node directly, not only the load balancer.
        </li>
        <li>
          <strong>Elections keep happening.</strong> Look for <code>cluster member state changed</code> warnings and a
          rising <code>control.raft.term</code> in <code>celeris status</code>. Common causes are a blocked or flaky cluster
          port, mismatched cluster TLS settings, overloaded disks and clock or network stalls.
        </li>
        <li>
          <strong>Routing changed.</strong> <code>421 partition_moved</code> means a rebalance moved the partition; refresh
          with <code>celeris partitions --key K</code> and retry. A <code>409 stale_epoch</code> says your cached routing is
          older than the partition&apos;s epoch.
        </li>
      </ul>
      <OsCode
        unix={`celeris partitions --key users/42     # partition, epoch, replicas (leader first)
celeris node list
celeris status | head -40`}
        windows={`celeris partitions --key users/42
celeris node list
celeris status`}
        title="Who should answer this key?"
      />

      <H2 id="outcome-unknown">Outcome unknown</H2>
      <p>
        <code>outcome: unknown</code> (HTTP 500 <code>outcome_unknown</code>, CLI exit code 3) means the write may have
        committed. It is never a plain failure. Do not assume it failed.
      </p>
      <OsCode
        unix={`celeris mutation 5d0c1c2e-0000-4000-8000-000000000000
# committed -> done; unknown -> not committed, still in flight, or older than the retention window`}
        windows={`celeris mutation 5d0c1c2e-0000-4000-8000-000000000000`}
        title="Resolve it"
      />
      <p>
        If it is not committed, retry <strong>with the same mutation ID</strong>: the server deduplicates, so it is applied
        once. Mutation IDs are remembered for <code>storage.mutation_retention_secs</code> (24 hours by default); after that
        the answer is unknown, never failed. The SDKs retry with the same ID and raise an unknown-outcome error carrying the
        ID when they cannot tell. See <DocLink to="errors">Errors</DocLink>.
      </p>

      <H2 id="timeouts">Strict timeouts and 503 read_timeout</H2>
      <p>
        A strict operation needs a majority of its replica set. A write waits up to 5 seconds for commit; if it is not
        confirmed it returns <code>outcome_unknown</code>. A strict read that cannot confirm leadership with a majority in time
        returns <code>503 read_timeout</code>, and <code>read_retry</code> means leadership changed mid-read and the read can
        be repeated. CelerisDB never silently weakens a strict request.
      </p>
      <ul>
        <li>Check that at least two of three replicas are alive: <code>celeris node list</code>.</li>
        <li>Check the cluster port between nodes (firewalls, security groups, mutual TLS settings).</li>
        <li>Check disks: slow flushes on a follower or leader delay commits. Look at write latency and stalls in the metrics.</li>
        <li>
          If your client timeout is shorter than 5 seconds you will see a client-side timeout before the server&apos;s
          answer. Resolve the write by mutation ID.
        </li>
        <li>
          If strictness is not required for a read path, ask for <code>session</code>, <code>bounded</code> or{" "}
          <code>eventual</code> on that path (see <DocLink to="consistency">Consistency</DocLink>).
        </li>
        <li>
          <code>503 session_behind</code> means the replica has not yet applied your session token: retry shortly or read from
          the leader. <code>503 scan_incomplete</code> means a strict scan could not reach every replica set.
        </li>
      </ul>

      <H2 id="read-only">read_only after a WAL failure</H2>
      <p>
        If appending to or flushing the write-ahead log fails, the on-disk state of the log is unknown, and retrying the flush
        can falsely report success. The engine therefore refuses further writes with <code>503 read_only</code>, reports the
        failed write as outcome-unknown, and keeps serving reads. <code>/ready</code> returns 503, <code>/v1/status</code>{" "}
        reports <code>health: read_only</code> with the reason, and <code>celeris_storage_read_only</code> is 1.
      </p>
      <Steps2 />
      <Callout kind="warn">
        <p>
          Writes that failed at the moment of the fault have unknown outcomes. After the restart, resolve them with their
          mutation IDs (see above) instead of blindly retrying new ones.
        </p>
      </Callout>

      <H2 id="slow-writes">Slow writes</H2>
      <p>Work through these in order:</p>
      <ol>
        <li>
          <strong>One writer at a time?</strong> With <code>sync = "always"</code> each serial write pays a disk flush. Send
          requests concurrently so they share flushes, and batch related writes.
        </li>
        <li>
          <strong>Slow disk?</strong> Measure flush latency on the data volume. Network volumes and busy shared disks are the
          usual cause.
        </li>
        <li>
          <strong>Write stalls?</strong> A rising <code>celeris_storage_write_stalls_total</code> means writes wait for flushing.
        </li>
        <li>
          <strong>Replication?</strong> Strict writes need a quorum round trip; cross-region replicas add their latency.
        </li>
        <li>
          <strong>Hot key?</strong> All writes to one key go through one leader.
        </li>
      </ol>
      <p>
        The full tuning method is on <DocLink to="performance">Performance tuning</DocLink>, and the metrics to watch are
        listed on <DocLink to="observability:metrics">Observability</DocLink>.
      </p>

      <H2 id="disk-full">Disk full</H2>
      <p>
        A full volume makes log writes fail, which turns the node read-only (see above). Compaction also needs temporary space
        for a merged copy of the tables, and deleted or expired data is retained for{" "}
        <code>storage.tombstone_retention_secs</code> (24 hours by default) before it is purged.
      </p>
      <OsCode
        linux={`df -h /path/to/celeris-data
du -sh /path/to/celeris-data/* | sort -h | tail`}
        macos={`df -h /path/to/celeris-data
du -sh /path/to/celeris-data/* | sort -h | tail`}
        windows={`Get-PSDrive C
Get-ChildItem C:\\celeris\\celeris-data -Recurse | Measure-Object -Property Length -Sum`}
        title="Where did the space go?"
      />
      <ul>
        <li>Free space first (old backups, logs, other data on the volume), or grow the volume.</li>
        <li>Restart the node if it went read-only, then confirm <code>/ready</code> is 200.</li>
        <li>
          Do not delete files inside the data directory by hand. Remove data through the API, or restore a smaller dataset.
        </li>
        <li>Plan headroom and add a disk-space alert; see <DocLink to="scaling:capacity-planning">capacity planning</DocLink>.</li>
      </ul>

      <H2 id="tls">TLS errors</H2>
      <Table
        head={["Symptom", "Cause", "Fix"]}
        rows={[
          ["Client reports an unknown or untrusted certificate", "Self-signed or private CA", "CLI: --ca-cert ca.pem or CELERIS_CA_CERT. Node.js: NODE_EXTRA_CA_CERTS. Python: SSL_CERT_FILE"],
          ["Hostname mismatch", "Certificate does not name the host you connect to", "Reissue with the right DNS name or IP SAN, or connect by the name on the certificate"],
          ["Connection reset or handshake failure with http://", "The node serves HTTPS only when TLS is configured; plain HTTP fails the handshake", "Use https:// in the address"],
          ["Warnings: cluster TLS handshake failed, rejected cluster connection", "Mutual TLS mismatch between nodes", "Every node needs cluster TLS; each certificate must name its cluster.advertise host and chain to the shared CA"],
          ["Certificate renewal not picked up", "Certificates are read at startup", "Restart the node (rolling, one at a time); reload without restart is not available yet"],
        ]}
      />
      <OsCode
        unix={`# inspect what the server presents
openssl s_client -connect db.example.com:8080 -servername db.example.com </dev/null 2>/dev/null | openssl x509 -noout -subject -dates -ext subjectAltName
celeris --addr https://db.example.com:8080 --ca-cert ca.pem status`}
        windows={`celeris --addr https://db.example.com:8080 --ca-cert ca.pem status
curl.exe --cacert ca.pem https://db.example.com:8080/health`}
        title="Check a certificate"
      />

      <H2 id="auth">401 and 403</H2>
      <ul>
        <li>
          <code>401 unauthorized</code> (with <code>WWW-Authenticate: Bearer</code>): the token is missing, wrong or not
          configured on this node. Send <code>Authorization: Bearer &lt;token&gt;</code>. Nodes store only the SHA-256 of
          each token, so the config needs the entry printed by <code>celeris token create</code>, not the raw token.
        </li>
        <li>
          <code>403 forbidden</code>: the token is valid but lacks the scope. Reads need <code>read</code>, writes{" "}
          <code>write</code>, admin endpoints and physical backup <code>admin</code>. With no tokens configured, admin endpoints
          accept loopback connections only, so remote admin calls get 403.
        </li>
        <li>
          <code>/health</code>, <code>/ready</code> and <code>/metrics</code> need no token. Browsers cannot set headers on a
          WebSocket, so <code>/v1/watch</code> also accepts <code>?access_token=</code>.
        </li>
        <li>
          Each node of a cluster must have the same tokens configured (<code>CELERIS_AUTH_TOKENS</code> can inject them).
        </li>
      </ul>
      <OsCode
        unix={`curl -i -H "Authorization: Bearer $CELERIS_TOKEN" http://127.0.0.1:8080/v1/status`}
        windows={`curl.exe -i -H "Authorization: Bearer $env:CELERIS_TOKEN" http://127.0.0.1:8080/v1/status`}
        title="Test a token"
      />

      <H2 id="windows">Windows-specific problems</H2>
      <H3 id="windows-curl">curl is not curl</H3>
      <p>
        In Windows PowerShell, <code>curl</code> is an alias for <code>Invoke-WebRequest</code> and does not accept curl
        flags. Type <code>curl.exe</code>.
      </p>
      <H3 id="windows-quoting">JSON quoting</H3>
      <p>
        Windows PowerShell 5.1 strips the double quotes of arguments passed to native programs. Either escape them, or avoid
        the problem by sending the value on standard input, which works in every shell.
      </p>
      <Code lang="powershell" title="PowerShell">{`# escaped quotes
celeris put users/42 '{\\"name\\":\\"Vinit\\"}'

# or read the value from stdin
'{"name":"Vinit"}' | celeris put users/42 --file -

# curl.exe: put the body in a file
Set-Content body.json '{"name":"Vinit"}' -Encoding ascii
curl.exe -X PUT http://127.0.0.1:8080/v1/kv/users/42 -H "content-type: application/json" --data-binary "@body.json"`}</Code>
      <H3 id="windows-firewall">Firewall</H3>
      <p>
        If a node is reachable locally but not from other machines, check that the listener is not bound to loopback only
        (<code>http.listen</code> defaults to <code>127.0.0.1:8080</code>) and that Windows Defender Firewall allows the port.
        Allow the cluster port only from your other nodes.
      </p>
      <Code lang="powershell" title="Elevated PowerShell">{`New-NetFirewallRule -DisplayName "CelerisDB API" -Direction Inbound -Protocol TCP -LocalPort 8080 -Action Allow
# cluster port: restrict to your node addresses
New-NetFirewallRule -DisplayName "CelerisDB cluster" -Direction Inbound -Protocol TCP -LocalPort 7000 -RemoteAddress 10.0.0.4,10.0.0.5,10.0.0.6 -Action Allow`}</Code>
      <H3 id="windows-docker">Docker, WSL and localhost</H3>
      <ul>
        <li>
          <strong>Inside a container</strong>, a node bound to <code>127.0.0.1</code> is invisible to published ports. The
          official image listens on <code>0.0.0.0:8080</code>; if you build your own config, set{" "}
          <code>CELERIS_HTTP_LISTEN=0.0.0.0:8080</code> and publish the port.
        </li>
        <li>
          <strong>Windows host to WSL, or WSL to Windows host</strong>: whether <code>localhost</code> crosses the boundary
          depends on your WSL networking mode. If <code>http://localhost:8080</code> fails, try{" "}
          <code>http://127.0.0.1:8080</code>, and for a node on the Windows side reached from WSL, bind it to{" "}
          <code>0.0.0.0</code> and use the Windows host address.
        </li>
        <li>
          Some tools resolve <code>localhost</code> to IPv6 <code>::1</code> first. The node listens on the IPv4 address you
          configure, so use <code>127.0.0.1</code> explicitly.
        </li>
      </ul>

      <H2 id="collect-diagnostics">Collecting a diagnostic bundle</H2>
      <p>
        When you ask for help, or open an issue, a bundle saves a round of questions. These commands only read state. They do
        not include data values, but review the output and redact tokens, hostnames and anything private before sharing.
      </p>
      <OsCode
        linux={`mkdir -p celeris-diag && cd celeris-diag
celeris doctor              > doctor.txt 2>&1
celeris --json status       > status.json 2>&1
celeris node list           > nodes.txt 2>&1
celeris partitions          > partitions.txt 2>&1
curl -s http://127.0.0.1:8080/metrics > metrics.txt
curl -s http://127.0.0.1:8080/ready   > ready.json
journalctl -u celeris --since "2 hours ago" -o cat > node.log 2>&1   # or: docker logs / kubectl logs
uname -a > os.txt
cd .. && tar czf celeris-diag.tgz celeris-diag`}
        macos={`mkdir -p celeris-diag && cd celeris-diag
celeris doctor              > doctor.txt 2>&1
celeris --json status       > status.json 2>&1
celeris node list           > nodes.txt 2>&1
celeris partitions          > partitions.txt 2>&1
curl -s http://127.0.0.1:8080/metrics > metrics.txt
curl -s http://127.0.0.1:8080/ready   > ready.json
sw_vers > os.txt; uname -a >> os.txt
cd .. && tar czf celeris-diag.tgz celeris-diag`}
        windows={`New-Item -ItemType Directory -Force celeris-diag | Out-Null
cmd /c "celeris doctor > celeris-diag\\doctor.txt 2>&1"
cmd /c "celeris --json status > celeris-diag\\status.json 2>&1"
cmd /c "celeris node list > celeris-diag\\nodes.txt 2>&1"
cmd /c "celeris partitions > celeris-diag\\partitions.txt 2>&1"
curl.exe -s http://127.0.0.1:8080/metrics -o celeris-diag\\metrics.txt
curl.exe -s http://127.0.0.1:8080/ready -o celeris-diag\\ready.json
Get-ComputerInfo | Select-Object OsName, OsVersion > celeris-diag\\os.txt
Copy-Item celeris.log celeris-diag\\node.log -ErrorAction SilentlyContinue
Compress-Archive celeris-diag celeris-diag.zip -Force`}
        title="Gather state"
      />
      <p>
        Add your <code>celeris.toml</code> with tokens and key paths removed, the time the problem started, what you expected
        and what happened, and any mutation IDs involved.
      </p>

      <H2 id="report-bug">Reporting a bug</H2>
      <p>
        Open an issue in the{" "}
        <a href={`${REPO}/issues`} target="_blank" rel="noreferrer">
          project repository
        </a>
        . A useful report contains:
      </p>
      <ol>
        <li>The CelerisDB version (shown by <code>celeris doctor</code> and <code>celeris status</code>) and how you installed it.</li>
        <li>The operating system, and whether you use Docker or Kubernetes.</li>
        <li>The topology: single node, or how many voters, the replication factor and zones.</li>
        <li>The exact commands or requests, the response including the error object and mutation ID, and the expected result.</li>
        <li>The diagnostic bundle above with secrets removed, and the relevant log lines (JSON logs are easiest).</li>
        <li>Whether it reproduces, and the smallest steps that reproduce it.</li>
      </ol>
      <Callout kind="warn" title="Security issues">
        <p>
          Do not post tokens, private keys or customer data in a public issue. For a suspected vulnerability, contact the
          maintainer privately using the contact details in the repository instead of opening a public issue.
        </p>
      </Callout>

      <H2 id="next">Next steps</H2>
      <ul>
        <li>
          <DocLink to="observability">Observability</DocLink> for metrics and alerts that catch these early.
        </li>
        <li>
          <DocLink to="errors">Errors</DocLink> for every error code and what it means.
        </li>
        <li>
          <DocLink to="production-checklist">Production checklist</DocLink> to prevent the common ones.
        </li>
      </ul>
    </>
  );
}

function Steps2() {
  return (
    <ol>
      <li>
        Read the reason in <code>celeris status</code> (<code>read_only_reason</code>) and the node log: disk full, I/O error,
        a failing device or a permissions change.
      </li>
      <li>Fix the underlying problem (free space, replace the device, restore permissions).</li>
      <li>
        Restart the node. Recovery replays whatever reached disk, truncates a torn tail, and the node accepts writes again.
        Confirm with <code>curl -s -o /dev/null -w "%&#123;http_code&#125;" http://127.0.0.1:8080/ready</code>.
      </li>
      <li>In a cluster, the other replicas keep serving. Restart only the affected node and let it catch up.</li>
    </ol>
  );
}

export const page: DocPage = {
  slug: "troubleshooting",
  title: "Troubleshooting",
  group: "Operate",
  summary: "Symptom, cause and fix for startup failures, routing errors, unknown outcomes, read-only nodes, TLS, auth and Windows quirks.",
  keywords: ["error", "problem", "debug", "not working", "503", "421", "read only", "outcome unknown", "timeout", "disk full", "lock", "port in use", "tls", "401", "403", "powershell", "wsl", "docker", "bug report", "diagnostics"],
  Body,
};
