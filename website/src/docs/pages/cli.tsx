import {
  Callout,
  Code,
  DocLink,
  H2,
  H3,
  OsCode,
  Params,
  Table,
  Tabs,
  type DocPage,
} from "../kit";

const raw = String.raw;

function Body() {
  return (
    <>
      <p>
        <code>celeris</code> is a single binary. It runs a node (<code>celeris start</code>) and it is also the client you use to
        operate one. It behaves the same on Linux, macOS and Windows. Every command except <code>init</code>, <code>start</code>,{" "}
        <code>restore</code>, <code>doctor</code>, <code>bench</code> and the two <code>token</code> commands talks to a node over its{" "}
        <DocLink to="http-api">HTTP API</DocLink> at <code>--addr</code>. For installation see <DocLink to="installation">Installation</DocLink>.
      </p>
      <Code lang="text" title="Synopsis">{`celeris [GLOBAL FLAGS] <command> [command flags] [arguments]
celeris --help
celeris <command> --help
celeris --version`}</Code>

      <H2 id="global-flags">Global flags</H2>
      <p>Global flags go before or after the command name. Each one has an environment variable.</p>
      <Params
        rows={[
          { name: "--addr <url>", type: "string", def: "http://127.0.0.1:8080", desc: <>Node API address. Env <code>CELERIS_ADDR</code>. A bare <code>host:port</code> is treated as <code>http://host:port</code>; a trailing slash is ignored.</> },
          { name: "--json", type: "flag", def: "off", desc: "Print the raw JSON response instead of the human-readable form." },
          { name: "--token <token>", type: "string", def: "none", desc: <>API token, sent as <code>Authorization: Bearer ...</code>. Env <code>CELERIS_TOKEN</code>. An empty value counts as no token.</> },
          { name: "--ca-cert <pem>", type: "path", def: "public web PKI", desc: <>PEM file with the CA certificates to trust for <code>https://</code> addresses (private CAs, self-signed). Env <code>CELERIS_CA_CERT</code>. Only the certificates in this file are trusted.</> },
          { name: "--help, -h", desc: "Show help for the command." },
          { name: "--version, -V", desc: "Print the version." },
        ]}
      />
      <p>
        The client connects with a 3 second connect timeout and gives each request 60 seconds in total.
      </p>

      <H2 id="exit-codes">Exit codes</H2>
      <Table
        head={["Code", "Meaning", "What to do"]}
        rows={[
          [<code key="c">0</code>, "Success. Also used for a write the server answered with 202 (accepted, not yet replicated).", "Nothing."],
          [<code key="c">1</code>, <>Error. For a write this means <strong>not applied</strong>: the node answered with an error, or was never reached.</>, "Read the message on stderr; fix the cause and run it again."],
          [<code key="c">2</code>, "Usage error: unknown flag, missing argument, bad value (from the argument parser).", "Run the command with --help."],
          [<code key="c">3</code>, <>Write outcome <strong>unknown</strong>: the write may have committed.</>, <>Run <code>celeris mutation &lt;id&gt;</code>, or re-run the same write with the same <code>--mutation-id</code>.</>],
          [<code key="c">4</code>, <>Not found: <code>get</code> for a missing key, or <code>mutation</code> for an ID with no commit record.</>, "Treat as a normal negative answer."],
        ]}
      />
      <p>
        Errors print on stderr as <code>error [code] (HTTP status): message</code>, followed by indented lines for <code>outcome</code>,{" "}
        <code>current version</code> and <code>mutation</code> when the server sent them. All codes are listed in <DocLink to="errors">Errors</DocLink>.
        Output meant for scripts (values, keys, JSON) goes to stdout; hints such as <code>-- more: ...</code> go to stderr.
      </p>

      <H2 id="retries">Retry semantics for writes</H2>
      <p>
        <code>put</code> and <code>delete</code> attach a mutation ID (a random UUID unless you pass <code>--mutation-id</code>) as the{" "}
        <code>celeris-mutation-id</code> header. If the transport fails, the CLI tries up to <strong>3 times in total</strong>, waiting 200 ms before the
        second attempt and 400 ms before the third, always with the same ID. The node remembers committed IDs (see{" "}
        <code>storage.mutation_retention_secs</code> in <DocLink to="configuration">Configuration</DocLink>), so a retry never applies a write twice.
      </p>
      <Table
        head={["What happened", "Report", "Exit"]}
        rows={[
          ["The node answered with success", <code key="a">OK version=N mutation=ID</code>, "0"],
          ["The node answered 202 for an available or eventual write on a non-leader replica", <code key="a">ACCEPTED (not yet replicated) mutation=ID timestamp_ms=T</code>, "0"],
          ["The node answered with an error whose outcome is not_applied", <>error line, <code>outcome: not applied</code></>, "1"],
          ["The node answered with an error whose outcome is unknown", <>error line, <code>outcome: unknown</code></>, "3"],
          ["Every attempt failed before a connection was made (refused, DNS)", <>node unreachable; nothing was written</>, "1"],
          ["A connection was made but no answer was read (timeout, reset)", <>outcome UNKNOWN, with the mutation ID and the <code>celeris mutation</code> hint</>, "3"],
        ]}
      />
      <Callout kind="tip" title="Scripting a safe retry loop">
        Generate the UUID yourself, pass it with <code>--mutation-id</code>, and on exit code 3 run the same command again. If the first attempt did commit,
        the second prints <code>(already committed; retry was deduplicated)</code> and exits 0.
      </Callout>

      <H2 id="quoting">Shell quoting</H2>
      <p>
        Values must be valid JSON, so a string needs its own quotes inside the shell quotes, and an object needs double quotes around every key. Shells
        disagree about how double quotes survive on the way to a program. The reliable rule on every shell: when a value is awkward to quote, send it on
        stdin with <code>--file -</code>.
      </p>
      <Tabs
        group="shell"
        label="Shell"
        items={[
          {
            id: "bash",
            label: "bash / zsh",
            content: (
              <Code lang="bash" flush>{`# Single quotes pass everything through literally.
celeris put greeting '"hello"'
celeris put users/42 '{"name":"Vinit"}'

# A filter with $ operators must use single quotes, or the shell expands $gte.
celeris query --prefix orders/ --where '{"total":{"$gte":100}}'

# From stdin or a file.
echo '{"name":"Vinit"}' | celeris put users/42 --file -
celeris put users/42 --file user.json`}</Code>
            ),
          },
          {
            id: "ps5",
            label: "PowerShell 5.1",
            content: (
              <Code lang="powershell" flush>{raw`# Windows PowerShell 5.1 drops embedded double quotes when it starts a program.
# Escape each one with a backslash:
celeris put greeting '\"hello\"'
celeris put users/42 '{\"name\":\"Vinit\"}'
celeris query --prefix orders/ --where '{\"total\":{\"$gte\":100}}'

# Or avoid the problem: pipe the value in.
'{"name":"Vinit"}' | celeris put users/42 --file -

# 5.1 pipes text as ASCII. For non-ASCII values use a file written without a byte-order mark.
celeris put users/42 --file user.json`}</Code>
            ),
          },
          {
            id: "ps7",
            label: "PowerShell 7",
            content: (
              <Code lang="powershell" flush>{`# PowerShell 7.3+ passes embedded quotes correctly. Plain single quotes work:
celeris put greeting '"hello"'
celeris put users/42 '{"name":"Vinit"}'
celeris query --prefix orders/ --where '{"total":{"$gte":100}}'

# Pipe or file input works in every version:
'{"name":"Vinit"}' | celeris put users/42 --file -

# If you copy 5.1-style backslash escapes into PowerShell 7, they arrive as literal backslashes
# and the value is rejected. To make 7 behave like 5.1 for the current session:
$PSNativeCommandArgumentPassing = 'Legacy'`}</Code>
            ),
          },
          {
            id: "cmd",
            label: "cmd.exe",
            content: (
              <Code lang="text" title="cmd.exe" flush>{raw`REM cmd has no single quotes. Use double quotes and escape inner quotes with a backslash.
celeris put greeting "\"hello\""
celeris put users/42 "{\"name\":\"Vinit\"}"
celeris query --prefix orders/ --where "{\"total\":{\"$gte\":100}}"

REM Piping works too (echo keeps the quotes, and a trailing space is harmless JSON whitespace).
echo {"name":"Vinit"} | celeris put users/42 --file -`}</Code>
            ),
          },
        ]}
      />
      <Callout kind="note" title="Keys are not JSON">
        Keys are plain strings, not JSON. They may contain <code>/</code>, are 1 to 1024 bytes of UTF-8, and are percent-encoded for you. A key with a{" "}
        <code>.</code> or <code>..</code> path segment is refused by the CLI because URL parsers collapse such segments.
      </Callout>

      <H2 id="environment">Environment variables</H2>
      <p>The client reads these. They apply to every command that contacts a node.</p>
      <Table
        head={["Variable", "Same as", "Notes"]}
        rows={[
          [<code key="v">CELERIS_ADDR</code>, <code key="f">--addr</code>, "Default http://127.0.0.1:8080."],
          [<code key="v">CELERIS_TOKEN</code>, <code key="f">--token</code>, "Prefer the variable: the flag value is visible in process listings and shell history."],
          [<code key="v">CELERIS_CA_CERT</code>, <code key="f">--ca-cert</code>, "Path to a PEM CA bundle."],
          [<code key="v">RUST_LOG</code>, "log filter", <>Read by <code>celeris start</code>. When set it takes precedence over <code>log.level</code>.</>],
        ]}
      />
      <p>
        <code>celeris start</code>, <code>doctor</code> and <code>restore</code> also read the node settings that override <code>celeris.toml</code> (
        <code>CELERIS_DATA_DIR</code>, <code>CELERIS_HTTP_LISTEN</code>, <code>CELERIS_CLUSTER_*</code>, ...). The complete list, with defaults, is in{" "}
        <DocLink to="configuration:environment">Configuration</DocLink>.
      </p>
      <OsCode
        title="Set the client variables for a session"
        unix={`export CELERIS_ADDR=https://db.example.com:8080
export CELERIS_TOKEN='paste-token-here'
export CELERIS_CA_CERT=./ca.pem
celeris status`}
        windows={`$env:CELERIS_ADDR = "https://db.example.com:8080"
$env:CELERIS_TOKEN = "paste-token-here"
$env:CELERIS_CA_CERT = ".\\ca.pem"
celeris status

# cmd.exe:
#   set CELERIS_ADDR=https://db.example.com:8080
#   set CELERIS_TOKEN=paste-token-here`}
      />

      <H2 id="commands">Command overview</H2>
      <Table
        head={["Command", "Contacts a node", "Purpose"]}
        rows={[
          [<a key="a" href="#init"><code>init</code></a>, "no", "Write a commented celeris.toml"],
          [<a key="a" href="#start"><code>start</code></a>, "no (it is the node)", "Run a node in the foreground"],
          [<a key="a" href="#stop"><code>stop</code></a>, "yes (loopback or admin token)", "Graceful shutdown"],
          [<a key="a" href="#status"><code>status</code></a>, "yes", "Health, uptime, storage, cluster"],
          [<a key="a" href="#node-list"><code>node list</code></a>, "yes", "Cluster members"],
          [<a key="a" href="#cluster-status"><code>cluster status</code></a>, "yes", "Membership counts by state"],
          [<a key="a" href="#cluster-rebalance"><code>cluster rebalance</code></a>, "yes (admin)", "Place partitions on current members"],
          [<a key="a" href="#put"><code>put</code></a>, "yes", "Write a value"],
          [<a key="a" href="#get"><code>get</code></a>, "yes", "Read a value"],
          [<a key="a" href="#delete"><code>delete</code></a>, "yes", "Delete a key"],
          [<a key="a" href="#scan"><code>scan</code></a>, "yes", "List keys in order"],
          [<a key="a" href="#query"><code>query</code></a>, "yes", "Filter, project, sort, aggregate"],
          [<a key="a" href="#mutation"><code>mutation</code></a>, "yes", "Did this mutation commit?"],
          [<a key="a" href="#conflicts"><code>conflicts list | clear</code></a>, "yes", "Writes that lost last-writer-wins"],
          [<a key="a" href="#partitions"><code>partitions</code></a>, "yes", "Partition map or one key's placement"],
          [<a key="a" href="#doctor"><code>doctor</code></a>, "optional", "Diagnose config, disk, port, node"],
          [<a key="a" href="#bench"><code>bench</code></a>, "yes", "Latency and throughput"],
          [<a key="a" href="#token"><code>token create | hash</code></a>, "no", "Create and hash API tokens"],
          [<a key="a" href="#backup"><code>backup</code></a>, "yes (admin)", "Physical backup of one node"],
          [<a key="a" href="#restore"><code>restore</code></a>, "no", "Rebuild a stopped node from a backup"],
          [<a key="a" href="#export"><code>export</code></a>, "yes", "JSON-lines export through the API"],
          [<a key="a" href="#import"><code>import</code></a>, "yes", "Load an export, safe to re-run"],
        ]}
      />

      <H3 id="init">celeris init</H3>
      <p>Writes a fully commented <code>celeris.toml</code>. It never overwrites a file unless you pass <code>--force</code>.</p>
      <Params
        rows={[
          { name: "--dir <path>", type: "path", def: ".", desc: "Directory to write into. Created if missing." },
          { name: "--listen <addr>", type: "host:port", def: "127.0.0.1:8080", desc: <>Value for <code>http.listen</code>. Must parse as a socket address (an IP, not a hostname).</> },
          { name: "--force", type: "flag", def: "off", desc: "Overwrite an existing file." },
        ]}
      />
      <OsCode
        unix={`celeris init
celeris init --dir ./node-a --listen 0.0.0.0:8080`}
        windows={`celeris init
celeris init --dir .\\node-a --listen 0.0.0.0:8080`}
      />

      <H3 id="start">celeris start</H3>
      <p>
        Runs a node in the foreground. Press <kbd>Ctrl</kbd>+<kbd>C</kbd> to stop it gracefully. Logs go to stderr. The only stdout line is the banner,
        so scripts can capture the bound address even when the port is <code>0</code>.
      </p>
      <Params
        rows={[
          { name: "--config, -c <path>", type: "path", def: "celeris.toml", desc: <>Config file. If the default name is missing, the node starts with built-in defaults and prints a note on stderr. A different path that is missing is an error. Environment variables are applied on top, then the result is validated.</> },
        ]}
      />
      <Code lang="text" title="Banner on stdout">{`celeris <version> node 4f1c... listening on http://127.0.0.1:8080
cluster port 127.0.0.1:7000      (only when cluster.listen is set)`}</Code>
      <p>The scheme in the banner is <code>https</code> when <code>http.tls</code> is configured.</p>
      <OsCode
        unix={`celeris start
celeris start --config ./node-a/celeris.toml
CELERIS_HTTP_LISTEN=127.0.0.1:0 celeris start      # let the OS pick a port`}
        windows={`celeris start
celeris start --config .\\node-a\\celeris.toml
$env:CELERIS_HTTP_LISTEN = "127.0.0.1:0"; celeris start   # let the OS pick a port`}
      />

      <H3 id="stop">celeris stop</H3>
      <p>
        Asks the node at <code>--addr</code> to shut down gracefully (<code>POST /v1/admin/shutdown</code>). Without API tokens the node accepts this only from
        a loopback address. With tokens configured, pass one with the <code>admin</code> scope. Prints <code>shutdown requested</code> on success.
      </p>
      <OsCode unix={`celeris stop\nceleris --addr https://db.example.com:8080 --token "$CELERIS_ADMIN_TOKEN" stop`} windows={`celeris stop\nceleris --addr https://db.example.com:8080 --token $env:CELERIS_ADMIN_TOKEN stop`} />

      <H3 id="status">celeris status</H3>
      <p>Node ID and health, version, uptime, cluster mode and node count, storage summary. A read-only node prints a <code>READ-ONLY</code> line with the reason.</p>
      <Code lang="text" title="Example output">{`node       4f1c0a9e (healthy)
version    <version>
uptime     1h 2m 14s
cluster    gossip, 3 node(s)
storage    version 18204  tables L0=1 L1=3  12.4 MiB on disk  memtable 1.1 MiB`}</Code>
      <p>
        With <code>--json</code> it prints the complete <code>/v1/status</code> document, which also includes Raft state, migrations and index states.
      </p>

      <H3 id="node-list">celeris node list</H3>
      <p>Lists cluster members with address, zone, state (<code>alive</code>, <code>suspect</code>, <code>unreachable</code>, <code>left</code>) and incarnation. The node you asked is marked <code>(this node)</code>. With <code>--json</code> it prints the member array.</p>

      <H3 id="cluster-status">celeris cluster status</H3>
      <p>Cluster mode (<code>single-node</code> or <code>gossip</code>) and how many nodes are in each state, from the answering node&apos;s point of view.</p>

      <H3 id="cluster-rebalance">celeris cluster rebalance</H3>
      <p>
        Asks the control plane to place partitions on the current members. Run it against a voter; a follower forwards the request to the leader. Needs the{" "}
        <code>admin</code> scope when tokens are configured. A rebalance is refused while the previous one is still moving data (<code>migrations_pending</code>).
      </p>
      <Params rows={[{ name: "--rf <n>", type: "0-255", desc: "Replicas per partition. Required. Capped by the number of members." }]} />
      <OsCode unix={`celeris cluster rebalance --rf 3`} windows={`celeris cluster rebalance --rf 3`} />
      <p>
        With <code>cluster.replication_factor</code> left at its default of 3, the leader places partitions by itself once every voter is up, so you normally
        run this only to change the factor or after a membership change. See <DocLink to="clustering">Clustering</DocLink> and{" "}
        <DocLink to="scaling">Scaling</DocLink>.
      </p>

      <H3 id="put">celeris put</H3>
      <p>
        Writes a JSON value. Pass the value as an argument or read it from a file or stdin with <code>--file</code>, never both. The CLI checks that the value
        parses as JSON before it sends anything.
      </p>
      <Params
        rows={[
          { name: "<key>", type: "string", desc: "Key, 1 to 1024 bytes of UTF-8." },
          { name: "[value]", type: "JSON", desc: "The value. Strings need their own quotes. Omit when using --file." },
          { name: "--file, -f <path|->", type: "path", desc: <>Read the value from a file, or from stdin when the path is <code>-</code>.</> },
          { name: "--ttl <duration>", type: "duration", desc: <>Expire the value after this long: <code>30s</code>, <code>10m</code>, <code>1h</code>, <code>1h30m</code>. Sent as milliseconds, so it must be at least 1 ms.</> },
          { name: "--if-version <n>", type: "u64", desc: <>Write only if the key&apos;s current version equals <code>n</code>. Conflicts with <code>--if-absent</code>.</> },
          { name: "--if-absent", type: "flag", desc: "Write only if the key does not exist." },
          { name: "--mutation-id <uuid>", type: "UUID", def: "random", desc: "Idempotency ID. Reuse it to retry safely. Reusing it with a different payload fails with mutation_id_reused." },
          { name: "--consistency, -c <mode>", type: "mode", def: "server default (strict)", desc: <>One of <code>strict</code>, <code>session</code>, <code>available</code>, <code>eventual</code>. <code>bounded</code> is for reads only. See <DocLink to="consistency">Consistency</DocLink>.</> },
        ]}
      />
      <OsCode
        unix={`celeris put users/42 '{"name":"Vinit","plan":"pro"}'
celeris put session/abc '{"user":42}' --ttl 30m
celeris put users/42 '{"name":"Vinit"}' --if-version 17
celeris put lock/deploy '{"by":"ci"}' --if-absent --ttl 5m
celeris put users/42 --file user.json
echo '{"name":"Vinit"}' | celeris put users/42 --file -
celeris put users/42 '{"name":"Vinit"}' --mutation-id 5d0c9a1e-6a1b-4c52-9a43-1f6c3d2e8b77 -c strict`}
        windows={`# Piping works in PowerShell 5.1 and 7. See Shell quoting for other forms.
'{"name":"Vinit","plan":"pro"}' | celeris put users/42 --file -
'{"user":42}' | celeris put session/abc --file - --ttl 30m
'{"name":"Vinit"}' | celeris put users/42 --file - --if-version 17
'{"by":"ci"}' | celeris put lock/deploy --file - --if-absent --ttl 5m
celeris put users/42 --file user.json
celeris put greeting --file greeting.json`}
      />
      <Code lang="text" title="Output">{`OK version=17 mutation=5d0c9a1e-6a1b-4c52-9a43-1f6c3d2e8b77
OK version=17 mutation=5d0c...  (already committed; retry was deduplicated)
error [condition_failed] (HTTP 409): ...
  outcome: not applied
  current version: 19`}</Code>

      <H3 id="get">celeris get</H3>
      <p>Reads a value and prints it as JSON. With <code>--json</code> it prints the whole record (key, value, version, mutation ID, timestamps, consistency). A missing, deleted or expired key prints <code>not found: &lt;key&gt;</code> on stderr and exits 4.</p>
      <Params
        rows={[
          { name: "<key>", type: "string", desc: "Key to read." },
          { name: "--consistency, -c <mode>", type: "mode", def: "server default (strict)", desc: <><code>strict</code>, <code>session</code>, <code>bounded</code>, <code>available</code> or <code>eventual</code>.</> },
          { name: "--max-staleness <duration>", type: "duration", desc: <>Staleness bound for <code>bounded</code> reads, such as <code>500ms</code>. Required with <code>-c bounded</code> and rejected with any other mode.</> },
        ]}
      />
      <OsCode
        unix={`celeris get users/42
celeris get users/42 -c eventual
celeris get users/42 -c bounded --max-staleness 500ms
celeris --json get users/42 | jq .version`}
        windows={`celeris get users/42
celeris get users/42 -c eventual
celeris get users/42 -c bounded --max-staleness 500ms
(celeris --json get users/42 | ConvertFrom-Json).version`}
      />

      <H3 id="delete">celeris delete</H3>
      <p>Deletes a key by writing a tombstone. Deleting a key that does not exist succeeds. Output and exit codes follow <code>put</code>.</p>
      <Params
        rows={[
          { name: "<key>", type: "string", desc: "Key to delete." },
          { name: "--if-version <n>", type: "u64", desc: "Delete only if the current version equals n." },
          { name: "--mutation-id <uuid>", type: "UUID", def: "random", desc: "Idempotency ID." },
          { name: "--consistency, -c <mode>", type: "mode", def: "strict", desc: "strict, session, available or eventual." },
        ]}
      />
      <OsCode unix={`celeris delete users/42\nceleris delete users/42 --if-version 17`} windows={`celeris delete users/42\nceleris delete users/42 --if-version 17`} />

      <H3 id="scan">celeris scan</H3>
      <p>
        Lists keys in order, one <code>key&lt;TAB&gt;value</code> per line. When more remain, stderr shows the exact command to continue. A scan is not a
        point-in-time snapshot. For filtering use <a href="#query"><code>query</code></a>.
      </p>
      <Params
        rows={[
          { name: "--prefix <p>", type: "string", desc: "Only keys that start with p." },
          { name: "--after <cursor>", type: "string", desc: "Continue after this key (the cursor printed by the previous page)." },
          { name: "--limit <n>", type: "1-1000", def: "100", desc: "Page size." },
        ]}
      />
      <OsCode
        unix={`celeris scan --prefix users/ --limit 20
celeris scan --prefix users/ --limit 20 --after users/0123`}
        windows={`celeris scan --prefix users/ --limit 20
celeris scan --prefix users/ --limit 20 --after users/0123`}
      />
      <p>
        <code>scan</code> has no <code>--consistency</code> flag and always uses the server default (<code>strict</code>). To scan with another mode, call{" "}
        <DocLink to="http-api:scan">the HTTP endpoint</DocLink>.
      </p>

      <H3 id="query">celeris query</H3>
      <p>
        Finds keys whose JSON values match a filter. The filter runs on the nodes that hold the data, so only matches cross the network. Filter syntax,
        operators, indexes and cost are explained in <DocLink to="queries">Queries</DocLink>.
      </p>
      <Params
        rows={[
          { name: "--prefix <p>", type: "string", desc: "Restrict to keys under this prefix. Always set it when you can." },
          { name: "--where <JSON>", type: "JSON", desc: <>Filter, for example <code>{`{"status":"paid","total":{"$gte":100}}`}</code>. Must be valid JSON (checked before sending).</> },
          { name: "--fields <a,b.c>", type: "list", desc: "Comma-separated field paths to return; values are rebuilt as nested objects." },
          { name: "--limit <n>", type: "1-1000", def: "100", desc: "Maximum items per page." },
          { name: "--max-scanned <n>", type: "1-100000", def: "10000 (server)", desc: "Rows one request may read, matching or not. A selective filter can return an empty page that still has a cursor." },
          { name: "--after <cursor>", type: "string", desc: "Continue after a cursor printed by a previous call." },
          { name: "--all", type: "flag", desc: "Follow cursors until the end of the range. Without it, one page is returned and a -- more: hint is printed." },
          { name: "--sort <field[:desc]>", type: "string", desc: <>Order by a field instead of by key. Needs a ready index on that field with the same order, else <code>sort_unavailable</code>. Order is <code>asc</code> unless you add <code>:desc</code>.</> },
          { name: "--count", type: "flag", desc: "Count the matches instead of listing them." },
          { name: "--sum <field>", type: "repeatable", desc: "Sum a numeric field over the matches." },
          { name: "--min <field>", type: "repeatable", desc: "Smallest value of a field over the matches." },
          { name: "--max <field>", type: "repeatable", desc: "Largest value of a field over the matches." },
          { name: "--consistency, -c <mode>", type: "mode", def: "strict", desc: "strict, session, bounded, available or eventual." },
        ]}
      />
      <p>
        The aggregate flags can be combined. Each response covers one page, so use <code>--all</code> to get totals for the whole range; without it the CLI
        prints the partial totals and a warning. With <code>--all</code> the CLI merges pages: counts and sums are added, the smallest minimum and the largest
        maximum are kept.
      </p>
      <Tabs
        group="shell"
        label="Shell"
        items={[
          {
            id: "bash",
            label: "bash / zsh",
            content: (
              <Code lang="bash" flush>{`celeris query --prefix orders/ --where '{"status":"paid","total":{"$gte":100}}' --fields total,customer.id --all
celeris query --prefix orders/ --where '{"status":"paid"}' --count --sum total --max total --all
celeris query --prefix orders/ --where '{"status":"paid"}' --sort total:desc --limit 20`}</Code>
            ),
          },
          {
            id: "ps5",
            label: "PowerShell 5.1",
            content: (
              <Code lang="powershell" flush>{raw`celeris query --prefix orders/ --where '{\"status\":\"paid\",\"total\":{\"$gte\":100}}' --fields total,customer.id --all
celeris query --prefix orders/ --where '{\"status\":\"paid\"}' --count --sum total --max total --all
celeris query --prefix orders/ --where '{\"status\":\"paid\"}' --sort total:desc --limit 20`}</Code>
            ),
          },
          {
            id: "ps7",
            label: "PowerShell 7",
            content: (
              <Code lang="powershell" flush>{`celeris query --prefix orders/ --where '{"status":"paid","total":{"$gte":100}}' --fields total,customer.id --all
celeris query --prefix orders/ --where '{"status":"paid"}' --count --sum total --max total --all
celeris query --prefix orders/ --where '{"status":"paid"}' --sort total:desc --limit 20`}</Code>
            ),
          },
          {
            id: "cmd",
            label: "cmd.exe",
            content: (
              <Code lang="text" title="cmd.exe" flush>{raw`celeris query --prefix orders/ --where "{\"status\":\"paid\",\"total\":{\"$gte\":100}}" --fields total,customer.id --all
celeris query --prefix orders/ --where "{\"status\":\"paid\"}" --count --sum total --max total --all
celeris query --prefix orders/ --where "{\"status\":\"paid\"}" --sort total:desc --limit 20`}</Code>
            ),
          },
        ]}
      />
      <Code lang="text" title="Output">{`orders/0042	{"total":120,"customer":{"id":7}}
-- 1 matched, 57 scanned via index orders_by_status

{ "count": 412, "sum": { "total": 18230.5 }, "min": {}, "max": { "total": 990 } }
-- 10000 scanned via index orders_by_status`}</Code>

      <H3 id="mutation">celeris mutation</H3>
      <p>Asks whether a mutation ID committed. This is how you resolve exit code 3.</p>
      <Table
        head={["Answer", "Output", "Exit"]}
        rows={[
          ["Committed", <code key="a">committed at version 17</code>, "0"],
          ["No commit record", <><code>unknown: no commit record ...</code></>, "4"],
        ]}
      />
      <p>
        <em>Unknown</em> means one of three things: the write did not commit, it is still in flight, or it is older than{" "}
        <code>storage.mutation_retention_secs</code> (24 hours by default). If it is still in flight, ask again after a moment.
      </p>
      <OsCode unix={`celeris mutation 5d0c9a1e-6a1b-4c52-9a43-1f6c3d2e8b77`} windows={`celeris mutation 5d0c9a1e-6a1b-4c52-9a43-1f6c3d2e8b77`} />

      <H3 id="conflicts">celeris conflicts</H3>
      <p>
        In a replicated cluster, <code>available</code> and <code>eventual</code> writes accepted by a non-leader are resolved by last-writer-wins. The losing
        writes are kept so your application can inspect them. See <DocLink to="available-mode">Available mode</DocLink>. On a single node the list is always
        empty.
      </p>
      <Params
        rows={[
          { name: "conflicts list --prefix <p>", type: "string", desc: "Only keys under this prefix." },
          { name: "conflicts list --limit <n>", type: "int", def: "100", desc: "Maximum conflicts (the server clamps to 1-1000)." },
          { name: "conflicts clear <key>", type: "string", desc: "Forget a key's recorded conflicts once you have handled them. Needs the write scope." },
        ]}
      />
      <OsCode unix={`celeris conflicts list --prefix carts/\nceleris conflicts clear carts/9`} windows={`celeris conflicts list --prefix carts/\nceleris conflicts clear carts/9`} />

      <H3 id="partitions">celeris partitions</H3>
      <p>
        Without flags, shows the partition map summary: partition count, map epoch, replication factor, how many partitions span more than one zone, and
        per-node replica and leader counts. With <code>--key</code>, shows the partition, epoch, leader and replicas for one key.
      </p>
      <Params rows={[{ name: "--key <k>", type: "string", desc: "Show where this key lives." }]} />
      <OsCode unix={`celeris partitions\nceleris partitions --key users/42`} windows={`celeris partitions\nceleris partitions --key users/42`} />

      <H3 id="doctor">celeris doctor</H3>
      <p>
        Checks, in order: platform, the config file (parses and validates), environment overrides, that the data directory is writable, that no other process
        holds the storage lock, that the listen port is free (or in use by a healthy node), and node health at <code>--addr</code>. Lines start with{" "}
        <code>[ ok ]</code>, <code>[info]</code> or <code>[FAIL]</code>. Exit 0 when nothing failed, 1 otherwise.
      </p>
      <Params rows={[{ name: "--config, -c <path>", type: "path", def: "celeris.toml", desc: "Config file to check. Missing file means defaults are checked." }]} />
      <OsCode unix={`celeris doctor\nceleris doctor --config ./node-a/celeris.toml`} windows={`celeris doctor\nceleris doctor --config .\\node-a\\celeris.toml`} />

      <H3 id="bench">celeris bench</H3>
      <p>
        A closed-loop load generator. It measures p50, p95 and p99 latency and throughput against <code>--addr</code> and never invents numbers. Results depend
        on your machine, <code>storage.sync</code> and client overhead, so compare only runs on the same setup. <code>benchmark</code> is an alias. See{" "}
        <DocLink to="performance">Performance</DocLink>.
      </p>
      <Params
        rows={[
          { name: "--workload <w>", type: "put | get | mixed", def: "mixed", desc: "put writes a new key per operation; get reads pre-loaded keys; mixed is 70% reads and 30% overwrites." },
          { name: "--ops <n>", type: "int", def: "10000", desc: "Total operations." },
          { name: "--concurrency, -c <n>", type: "int", def: "8", desc: "Concurrent client threads." },
          { name: "--value-size <bytes>", type: "int", def: "100", desc: "Approximate value size." },
          { name: "--keys <n>", type: "int", def: "1000", desc: "Distinct keys pre-loaded for get and mixed." },
        ]}
      />
      <OsCode unix={`celeris bench --workload put --ops 50000 -c 32 --value-size 256`} windows={`celeris bench --workload put --ops 50000 -c 32 --value-size 256`} />
      <Callout kind="warn" title="Benchmarks write data">
        <code>bench</code> writes real keys into the node you point it at. Use a scratch node, not production.
      </Callout>

      <H3 id="token">celeris token</H3>
      <p>
        Creates API tokens. A node stores only the SHA-256 of each token, so the plaintext is shown once and never again. See{" "}
        <DocLink to="security">Security</DocLink>.
      </p>
      <Params
        rows={[
          { name: "token create --name <label>", type: "string", desc: "Label for logs, 1 to 64 characters, such as web-app. Required." },
          { name: "token create --scope <s>", type: "read | write | admin", desc: "Required. Repeat the flag for several scopes: --scope read --scope write. A scope does not include the others." },
          { name: "token hash", desc: "Reads one token from stdin and prints its SHA-256, for tokens you generated yourself." },
        ]}
      />
      <OsCode
        unix={`celeris token create --name web-app --scope read --scope write
echo -n "$MY_TOKEN" | celeris token hash`}
        windows={`celeris token create --name web-app --scope read --scope write
$env:MY_TOKEN | celeris token hash`}
      />
      <Code lang="text" title="Output of token create">{`token      <random token, shown once>
           (shown once; give it to the client, e.g. CELERIS_TOKEN or the SDK \`token\` option)

Add to celeris.toml on every node:

[[auth.tokens]]
name = "web-app"
sha256 = "<64 hex characters>"
scopes = ["read", "write"]

or as an environment variable:

CELERIS_AUTH_TOKENS="web-app:read+write:<64 hex characters>"`}</Code>

      <H3 id="backup">celeris backup</H3>
      <p>
        Saves a consistent physical backup of one node (exact versions kept) through <code>GET /v1/admin/backup</code>, written to a temporary file and then
        renamed. The node keeps serving. It holds every write acknowledged before the command started. Not available in a replicated cluster (answers{" "}
        <code>not_supported</code>): use <a href="#export"><code>export</code></a> there. Needs the <code>admin</code> scope when tokens are configured.
      </p>
      <Params rows={[{ name: "--out, -o <file>", type: "path", desc: "File to write. Required." }]} />

      <H3 id="restore">celeris restore</H3>
      <p>
        Builds a <em>stopped</em> node&apos;s empty storage from a backup. It reads <code>node.data_dir</code> from the config (and environment) and refuses to
        run if the storage directory is not empty.
      </p>
      <Params
        rows={[
          { name: "--from <file>", type: "path", desc: "Backup file written by celeris backup. Required." },
          { name: "--config, -c <path>", type: "path", def: "celeris.toml", desc: "Config that names the data directory." },
        ]}
      />
      <OsCode
        title="Backup, then restore on the same host"
        unix={`celeris backup --out celeris.backup
celeris stop
mv celeris-data celeris-data.old
celeris restore --from celeris.backup
celeris start`}
        windows={`celeris backup --out celeris.backup
celeris stop
Rename-Item celeris-data celeris-data.old
celeris restore --from celeris.backup
celeris start`}
      />

      <H3 id="export">celeris export</H3>
      <p>
        Writes every key as one JSON object per line (<code>key</code>, <code>value</code>, <code>expires_at_ms</code>) by paging through the API, so it works on
        a cluster of any shape, over HTTPS and with tokens. It is not a point-in-time snapshot of the whole keyspace.
      </p>
      <Params
        rows={[
          { name: "--out, -o <file>", type: "path", desc: "File to write. Required." },
          { name: "--prefix <p>", type: "string", desc: "Only keys with this prefix." },
          { name: "--consistency <mode>", type: "mode", def: "strict", desc: "Read consistency for the scan." },
        ]}
      />

      <H3 id="import">celeris import</H3>
      <p>
        Loads an export in batches. Each batch&apos;s mutation ID is derived from the file&apos;s lines, so re-running after a failure skips what was already
        applied and prints <code>N already imported</code>. Keys that expired since the export are skipped; the rest keep their absolute expiry. Versions are
        reassigned.
      </p>
      <Params
        rows={[
          { name: "--from <file>", type: "path", desc: "Export file. Required." },
          { name: "--batch-size <n>", type: "int", def: "200", desc: "Keys per batch." },
          { name: "--threads <n>", type: "int", def: "8", desc: "Parallel writers when a batch spans replica sets." },
        ]}
      />
      <OsCode
        title="Copy a prefix to another cluster"
        unix={`celeris export --out orders.jsonl --prefix orders/
celeris --addr https://other.example.com:8080 --token "$OTHER_TOKEN" import --from orders.jsonl`}
        windows={`celeris export --out orders.jsonl --prefix orders/
celeris --addr https://other.example.com:8080 --token $env:OTHER_TOKEN import --from orders.jsonl`}
      />
      <p>The two backup styles compare as follows. More in <DocLink to="backup-restore">Backup and restore</DocLink>.</p>
      <Table
        head={["", "backup / restore", "export / import"]}
        rows={[
          ["Form", "Binary engine snapshot", "JSON lines"],
          ["Works on", "A single node", "Any node or cluster"],
          ["Versions", "Kept exactly", "Reassigned on import"],
          ["Restore", "Offline, into an empty data directory", "Online, through the API"],
        ]}
      />

      <H2 id="cluster-example">Starting a three-node cluster by hand</H2>
      <p>
        Give each node a fixed ID, a cluster port and the full list of voters. This runs three nodes on one machine for learning; see{" "}
        <DocLink to="clustering">Clustering</DocLink> for real deployments.
      </p>
      <OsCode
        linux={`mkdir -p a b c
CELERIS_NODE_ID=a CELERIS_HTTP_LISTEN=127.0.0.1:8080 CELERIS_CLUSTER_LISTEN=127.0.0.1:7000 CELERIS_CLUSTER_VOTERS=a,b,c \\
  CELERIS_DATA_DIR=./a celeris start &
CELERIS_NODE_ID=b CELERIS_HTTP_LISTEN=127.0.0.1:8081 CELERIS_CLUSTER_LISTEN=127.0.0.1:7001 CELERIS_CLUSTER_VOTERS=a,b,c \\
  CELERIS_CLUSTER_SEEDS=127.0.0.1:7000 CELERIS_DATA_DIR=./b celeris start &
CELERIS_NODE_ID=c CELERIS_HTTP_LISTEN=127.0.0.1:8082 CELERIS_CLUSTER_LISTEN=127.0.0.1:7002 CELERIS_CLUSTER_VOTERS=a,b,c \\
  CELERIS_CLUSTER_SEEDS=127.0.0.1:7000 CELERIS_DATA_DIR=./c celeris start &
sleep 5
celeris node list
celeris partitions`}
        macos={`mkdir -p a b c
CELERIS_NODE_ID=a CELERIS_HTTP_LISTEN=127.0.0.1:8080 CELERIS_CLUSTER_LISTEN=127.0.0.1:7000 CELERIS_CLUSTER_VOTERS=a,b,c \\
  CELERIS_DATA_DIR=./a celeris start &
CELERIS_NODE_ID=b CELERIS_HTTP_LISTEN=127.0.0.1:8081 CELERIS_CLUSTER_LISTEN=127.0.0.1:7001 CELERIS_CLUSTER_VOTERS=a,b,c \\
  CELERIS_CLUSTER_SEEDS=127.0.0.1:7000 CELERIS_DATA_DIR=./b celeris start &
CELERIS_NODE_ID=c CELERIS_HTTP_LISTEN=127.0.0.1:8082 CELERIS_CLUSTER_LISTEN=127.0.0.1:7002 CELERIS_CLUSTER_VOTERS=a,b,c \\
  CELERIS_CLUSTER_SEEDS=127.0.0.1:7000 CELERIS_DATA_DIR=./c celeris start &
sleep 5
celeris node list
celeris partitions`}
        windows={`# Run each block in its own PowerShell window.
# Window 1
$env:CELERIS_NODE_ID = "a"; $env:CELERIS_HTTP_LISTEN = "127.0.0.1:8080"; $env:CELERIS_CLUSTER_LISTEN = "127.0.0.1:7000"
$env:CELERIS_CLUSTER_VOTERS = "a,b,c"; $env:CELERIS_DATA_DIR = ".\\a"
celeris start

# Window 2
$env:CELERIS_NODE_ID = "b"; $env:CELERIS_HTTP_LISTEN = "127.0.0.1:8081"; $env:CELERIS_CLUSTER_LISTEN = "127.0.0.1:7001"
$env:CELERIS_CLUSTER_VOTERS = "a,b,c"; $env:CELERIS_CLUSTER_SEEDS = "127.0.0.1:7000"; $env:CELERIS_DATA_DIR = ".\\b"
celeris start

# Window 3: same with c, 8082, 7002, .\\c

# Window 4
celeris node list
celeris partitions`}
      />
      <p>
        Once <code>a</code>, <code>b</code> and <code>c</code> are all up, the control-plane leader places partitions with <code>cluster.replication_factor</code>{" "}
        (3 by default). To re-place later, run <code>celeris cluster rebalance --rf 3</code>. In this mode a <code>put -c available</code> on a replica that is
        not the group leader answers <code>ACCEPTED (not yet replicated)</code> and commits in the background.
      </p>

      <H2 id="not-available">Not available</H2>
      <ul>
        <li>There is no command to reload TLS certificates; restart the node after replacing them.</li>
        <li>There is no <code>get</code> or <code>scan</code> flag for <code>session</code> tokens; use the SDKs or the HTTP API to carry <code>celeris-session-index</code>.</li>
        <li>There is no command to remove a node from the cluster, to create indexes (they are declared in <code>celeris.toml</code>), or to edit configuration remotely.</li>
      </ul>

      <H2 id="next">Next steps</H2>
      <ul>
        <li><DocLink to="http-api">HTTP API</DocLink> for what each command sends.</li>
        <li><DocLink to="errors">Errors</DocLink> for every code the CLI can print.</li>
        <li><DocLink to="configuration">Configuration</DocLink> for every setting <code>celeris start</code> reads.</li>
        <li><DocLink to="troubleshooting">Troubleshooting</DocLink> when a command does not do what you expect.</li>
      </ul>
    </>
  );
}

export const page: DocPage = {
  slug: "cli",
  title: "CLI reference",
  group: "Reference",
  summary: "Every celeris command, flag, exit code and environment variable, with quoting for bash, zsh, PowerShell and cmd.",
  keywords: ["celeris command", "flags", "exit code", "put get delete scan query", "token create", "backup restore", "bench", "doctor", "powershell quoting", "cmd.exe", "bash", "zsh"],
  Body,
};
