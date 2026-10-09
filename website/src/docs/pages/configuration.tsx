import type { ReactNode } from "react";

import { Callout, Code, DocLink, H2, H3, OsCode, Table, Tabs, type DocPage } from "../kit";
import { FilterTable, type FilterRow } from "../demos/RefFilter";

const HEAD = ["Key", "Type", "Default", "Environment", "Description"];

function row(key: string, type: string, def: string, env: string, desc: ReactNode, text: string): FilterRow {
  return {
    search: [key, type, def, env, text].join(" "),
    cells: [<code key="k">{key}</code>, <code key="t">{type}</code>, def === "-" ? <span className="faint">-</span> : <code>{def}</code>, env === "-" ? <span className="faint">-</span> : <code>{env}</code>, desc],
  };
}

const NODE: FilterRow[] = [
  row("node.data_dir", "path", '"celeris-data"', "CELERIS_DATA_DIR", <>Root of everything the node persists. A relative path in a config file is resolved against that file&apos;s directory, so the node finds its data wherever you start it from. The storage engine uses the <code>storage</code> folder inside it.</>, "data directory root persists relative path"),
  row("node.id", "string", "random, generated on first start", "CELERIS_NODE_ID", <>Fixed node ID: 1 to 64 characters of <code>A-Z a-z 0-9 . _ -</code>. Required in practice for cluster voters, whose IDs must be known in advance. Once a data directory has an ID, the configured ID must match it.</>, "node id identifier voters"),
];

const HTTP: FilterRow[] = [
  row("http.listen", "host:port", '"127.0.0.1:8080"', "CELERIS_HTTP_LISTEN", <>Client API address (an IP and port, not a hostname). Loopback by default so nothing is exposed until you choose. Use <code>0.0.0.0:8080</code> to accept remote clients, and port <code>0</code> to let the OS pick one (printed in the start banner).</>, "listen address port bind api"),
  row("http.cors_origins", "string[]", "[]", "CELERIS_CORS_ORIGINS", <>Browser origins allowed by CORS. Empty disables CORS; <code>&quot;*&quot;</code> allows any. Env is comma-separated. Each non-wildcard entry must be a valid header value.</>, "cors origins browser"),
  row("http.tls", "table", "unset (plain HTTP)", "CELERIS_TLS_CERT + CELERIS_TLS_KEY", <>Serve HTTPS only: <code>{`{ cert_file = "...", key_file = "..." }`}</code>. See the TLS table below. The env vars must be set together.</>, "tls https certificate"),
];

const TLS: FilterRow[] = [
  row("http.tls.cert_file", "path", "required", "CELERIS_TLS_CERT", "PEM certificate chain, leaf first. Relative paths resolve against the config file.", "tls certificate chain pem"),
  row("http.tls.key_file", "path", "required", "CELERIS_TLS_KEY", "PEM private key: PKCS#8, PKCS#1 or SEC1.", "tls private key pem"),
];

const AUTH: FilterRow[] = [
  row("auth.tokens", "array of tables", "[] (auth off)", "CELERIS_AUTH_TOKENS", <>API tokens. With none, every request is allowed and admin endpoints are loopback-only. With any, all endpoints except <code>/health</code>, <code>/ready</code> and <code>/metrics</code> require a bearer token. The env form <strong>replaces</strong> the file&apos;s tokens: <code>name:scope+scope:sha256</code>, entries separated by commas.</>, "tokens authentication bearer"),
  row("auth.tokens[].name", "string", "required", "-", "Label for logs, 1 to 64 characters.", "token name label"),
  row("auth.tokens[].sha256", "string", "required", "-", <>Lowercase hex SHA-256 of the token, 64 characters. <code>celeris token create</code> prints it. Duplicates are rejected.</>, "token hash sha256"),
  row("auth.tokens[].scopes", "string[]", "required, non-empty", "-", <>Any of <code>&quot;read&quot;</code>, <code>&quot;write&quot;</code>, <code>&quot;admin&quot;</code>. Scopes do not include each other.</>, "token scopes read write admin"),
];

const STORAGE: FilterRow[] = [
  row("storage.sync", "\"always\" | \"never\"", '"always"', "CELERIS_SYNC", <><code>always</code> forces every write to stable storage before acknowledging it, so acknowledged writes survive power loss. <code>never</code> leaves flushing to the operating system and survives process crashes only. Much faster, but a power cut can lose recent acknowledged writes. Do not use <code>never</code> on a node that is the only copy of data.</>, "fsync durability sync always never"),
  row("storage.memtable_size_mb", "integer", "32", "-", "Size of the in-memory write buffer before it is flushed to disk. At least 1. Larger buffers absorb bursts and reduce flush frequency at the cost of memory and a longer recovery replay.", "memtable memory write buffer flush"),
  row("storage.block_cache_mb", "integer", "64", "-", "Cache for frequently read data. Raise it when your hot set is larger than 64 MB and the machine has spare memory.", "block cache memory read"),
  row("storage.tombstone_retention_secs", "integer", "86400 (24 h)", "-", "Deleted and expired data is remembered this long so a stale replica that returns cannot resurrect it. Keep it longer than the longest outage you expect a replica to recover from.", "tombstone retention delete resurrect"),
  row("storage.mutation_retention_secs", "integer", "86400 (24 h)", "-", <>How long mutation IDs are remembered, which is how long a retry of a write is guaranteed idempotent and <code>GET /v1/mutations/&#123;id&#125;</code> can answer. At least 1.</>, "mutation id retention idempotency"),
];

const CLUSTER: FilterRow[] = [
  row("cluster.listen", "host:port", "unset (single node)", "CELERIS_CLUSTER_LISTEN", <>Internal cluster port for node-to-node traffic. Never serve it to clients or browsers. Setting it turns on membership. <code>seeds</code> and <code>voters</code> require it.</>, "cluster port listen internal gossip"),
  row("cluster.advertise", "host:port", "the bound listen address", "CELERIS_CLUSTER_ADVERTISE", <>Address peers use to reach this node. <strong>Required when <code>listen</code> is a wildcard</strong> such as <code>0.0.0.0:7000</code>. With cluster TLS, the node certificate must name this host.</>, "advertise address peers"),
  row("cluster.seeds", "string[]", "[]", "CELERIS_CLUSTER_SEEDS", "Cluster addresses of existing members to join through. Env is comma-separated. The first node of a cluster has none.", "seeds join bootstrap"),
  row("cluster.zone", "string", '"default"', "CELERIS_ZONE", "Failure domain (rack or availability zone) used to spread replicas across zones.", "zone rack availability zone failure domain"),
  row("cluster.voters", "string[]", "[]", "CELERIS_CLUSTER_VOTERS", <>Node IDs of the control-plane Raft voters, fixed at bootstrap. Use 3 or 5. Each voter should set <code>node.id</code>. Env is comma-separated. Setting it turns on replicated mode; empty means membership only.</>, "voters raft control plane quorum"),
  row("cluster.replication_factor", "integer 0-255", "3", "CELERIS_REPLICATION_FACTOR", <>Replicas per partition for the first placement, which the control-plane leader proposes by itself once every voter is alive (capped at the node count). <code>0</code> disables automatic bootstrap; then run <code>celeris cluster rebalance --rf N</code>.</>, "replication factor rf replicas"),
  row("cluster.heartbeat_interval_ms", "integer", "500", "-", "How often the node sends membership heartbeats. Must be above 0.", "heartbeat gossip failure detection"),
  row("cluster.suspect_after_ms", "integer", "2000", "-", "Silence after which an alive peer is marked suspect. Must exceed heartbeat_interval_ms.", "suspect failure detection"),
  row("cluster.suspicion_timeout_ms", "integer", "5000", "-", "An unrefuted suspicion older than this turns the peer unreachable.", "suspicion unreachable failure detection"),
  row("cluster.raft_election_timeout_ms", "integer", "1000", "-", "Minimum Raft election timeout; the maximum is twice this. Must exceed twice raft_heartbeat_ms when voters are set. Raise on high-latency links.", "raft election timeout leader"),
  row("cluster.raft_heartbeat_ms", "integer", "250", "-", "Leader heartbeat interval. Must be above 0 when voters are set.", "raft heartbeat leader"),
  row("cluster.snapshot_threshold", "integer", "10000", "-", "A replica set snapshots its data and discards its applied log once the log holds more than this many entries. At least 1.", "snapshot raft log compaction"),
  row("cluster.auto_rebalance_after_ms", "integer", "30000", "-", "The control-plane leader re-places partitions on its own after the live member set has differed from the placement, unchanged, for this long. 0 disables it, so rebalances happen only on request.", "auto rebalance membership change"),
  row("cluster.anti_entropy_interval_ms", "integer", "60000", "-", "How often each group leader verifies that its replicas hold identical data and repairs diverged ones. 0 disables it.", "anti entropy repair verify"),
  row("cluster.tls", "table", "unset (cluster port unencrypted)", "CELERIS_CLUSTER_TLS_CERT + _KEY + _CA", <>Mutual TLS between nodes. Every node of a cluster must use it; a node without it cannot talk to one with it. The env vars must be set all together or not at all.</>, "mutual tls mtls cluster encryption"),
];

const CLUSTER_TLS: FilterRow[] = [
  row("cluster.tls.cert_file", "path", "required", "CELERIS_CLUSTER_TLS_CERT", <>PEM chain of this node. It must name the host of <code>cluster.advertise</code> (DNS name or IP SAN).</>, "cluster tls certificate san"),
  row("cluster.tls.key_file", "path", "required", "CELERIS_CLUSTER_TLS_KEY", "PEM private key.", "cluster tls key"),
  row("cluster.tls.ca_file", "path", "required", "CELERIS_CLUSTER_TLS_CA", "PEM CA that signed every node's certificate. Use a CA dedicated to the cluster: any certificate it signed is accepted as a peer.", "cluster tls ca authority"),
];

const LOG: FilterRow[] = [
  row("log.level", "string", '"info"', "CELERIS_LOG_LEVEL", <>A log filter such as <code>info</code>, <code>debug</code> or <code>celeris_server=debug,info</code>. <code>RUST_LOG</code>, when set, takes precedence over this value.</>, "log level verbosity rust_log"),
  row("log.format", "\"pretty\" | \"json\"", '"pretty"', "CELERIS_LOG_FORMAT", "Compact human-readable lines, or one JSON object per line for log pipelines. Logs go to stderr.", "log format json structured"),
];

const INDEXES: FilterRow[] = [
  row("indexes[].name", "string", "required", "-", "1 to 64 characters of a-z, 0-9, _ and -, starting with a letter or digit. Unique within the file.", "index name"),
  row("indexes[].prefix", "string", '""', "-", <>Only keys under this prefix are indexed. <code>&quot;&quot;</code> covers all keys. Must not start with a 0x00 byte.</>, "index prefix scope"),
  row("indexes[].field", "string", "required", "-", <>Dotted path into the JSON value, such as <code>status</code> or <code>customer.tier</code>. Strings, numbers, booleans and null are indexed; arrays and objects are not.</>, "index field path"),
  row("indexes[].order", "\"asc\" | \"desc\"", '"asc"', "-", <>The order <code>sort</code> reads values in. Declare a second index for the other direction.</>, "index order sort ascending descending"),
];

function Section({ rows, filter }: { rows: FilterRow[]; filter?: boolean }) {
  return <FilterTable head={HEAD} rows={rows} filter={filter ?? rows.length > 6} label="Filter settings" placeholder="Filter settings, for example raft or CELERIS_" />;
}

function Body() {
  return (
    <>
      <p>
        A node reads one TOML file, <code>celeris.toml</code>, then applies environment variables on top, then validates the result. <code>celeris init</code> writes a fully commented
        file; this page lists every key. Configuration is read once at start: change a value, then restart the node. Certificate reload without a restart is not available yet.
      </p>
      <Table
        head={["Order", "Source", "Notes"]}
        rows={[
          ["1", "Built-in defaults", "Used when no file exists at the default name. The node prints a note and runs."],
          ["2", <><code>celeris.toml</code> (or <code>--config path</code>)</>, <>Unknown keys are <strong>rejected</strong>, so typos fail at start instead of being ignored. A <code>--config</code> path that does not exist is an error.</>],
          ["3", <>Environment variables <code>CELERIS_*</code></>, "Override the file. Convenient for containers and Kubernetes."],
        ]}
      />
      <OsCode
        title="Create a config file"
        unix={`celeris init
celeris init --dir ./node-a --listen 0.0.0.0:8080`}
        windows={`celeris init
celeris init --dir .\\node-a --listen 0.0.0.0:8080`}
      />
      <Callout kind="tip" title="Paths and TOML on Windows">
        In TOML, a basic string treats backslashes as escapes. Write Windows paths with forward slashes (<code>&quot;C:/celeris/data&quot;</code>) or as single-quoted literal strings (
        <code>{`'C:\\celeris\\data'`}</code>). Both work.
      </Callout>

      <H2 id="node">[node]</H2>
      <Section rows={NODE} />

      <H2 id="http">[http]</H2>
      <Section rows={HTTP} />
      <H3 id="http-tls">[http.tls]</H3>
      <Section rows={TLS} />

      <H2 id="auth">[[auth.tokens]]</H2>
      <Section rows={AUTH} />
      <p>
        Create a token with <code>celeris token create --name app --scope read --scope write</code>; it prints the token once and the entry to paste. Only the SHA-256 is stored in
        the file, so a leaked config does not leak usable credentials. Every node of a cluster needs the same token list. See <DocLink to="security">Security</DocLink>.
      </p>
      <Code lang="toml">{`[[auth.tokens]]
name = "web-app"
sha256 = "<64 lowercase hex characters>"
scopes = ["read", "write"]`}</Code>
      <OsCode
        title="The same tokens through the environment"
        unix={`export CELERIS_AUTH_TOKENS="web-app:read+write:<sha256>,ops:admin:<sha256>"`}
        windows={`$env:CELERIS_AUTH_TOKENS = "web-app:read+write:<sha256>,ops:admin:<sha256>"`}
      />

      <H2 id="storage">[storage]</H2>
      <Section rows={STORAGE} />
      <p>
        Tuning guidance, including when <code>sync = &quot;never&quot;</code> is reasonable, is in <DocLink to="performance">Performance</DocLink>.
      </p>

      <H2 id="cluster">[cluster]</H2>
      <p>
        Without <code>cluster.listen</code> the node runs alone. Add <code>listen</code> for membership, and <code>voters</code> for replication. See{" "}
        <DocLink to="clustering">Clustering</DocLink> for how these fit together.
      </p>
      <Section rows={CLUSTER} />
      <H3 id="cluster-tls">[cluster.tls]</H3>
      <Section rows={CLUSTER_TLS} />

      <H2 id="log">[log]</H2>
      <Section rows={LOG} />

      <H2 id="indexes">[[indexes]]</H2>
      <p>
        Secondary indexes make equality filters and sorted queries read only matching keys. Every node of a cluster should list the same indexes. A new index is built in the background
        while the node serves traffic, and queries scan until it is ready; progress shows in <code>GET /v1/status</code>. See <DocLink to="queries">Queries</DocLink>.
      </p>
      <Section rows={INDEXES} />
      <Code lang="toml">{`[[indexes]]
name = "orders_by_status"
prefix = "orders/"
field = "status"
order = "asc"`}</Code>

      <H2 id="environment">Environment variables</H2>
      <p>
        Every variable below overrides its file setting. Lists are comma-separated. A variable set to an empty string clears <code>node.id</code>, <code>cluster.listen</code> and{" "}
        <code>cluster.advertise</code>.
      </p>
      <FilterTable
        label="Filter environment variables"
        placeholder="Filter variables, for example TLS"
        head={["Variable", "Overrides", "Values"]}
        rows={[
          ["CELERIS_DATA_DIR", "node.data_dir", "path"],
          ["CELERIS_NODE_ID", "node.id", "1-64 of A-Za-z0-9._-"],
          ["CELERIS_HTTP_LISTEN", "http.listen", "host:port"],
          ["CELERIS_CORS_ORIGINS", "http.cors_origins", "comma-separated origins, or *"],
          ["CELERIS_TLS_CERT", "http.tls.cert_file", "path; set together with CELERIS_TLS_KEY"],
          ["CELERIS_TLS_KEY", "http.tls.key_file", "path; set together with CELERIS_TLS_CERT"],
          ["CELERIS_AUTH_TOKENS", "auth.tokens (replaces)", "name:read+write:sha256,... "],
          ["CELERIS_SYNC", "storage.sync", "always | never"],
          ["CELERIS_CLUSTER_LISTEN", "cluster.listen", "host:port"],
          ["CELERIS_CLUSTER_ADVERTISE", "cluster.advertise", "host:port"],
          ["CELERIS_CLUSTER_SEEDS", "cluster.seeds", "comma-separated host:port"],
          ["CELERIS_ZONE", "cluster.zone", "string"],
          ["CELERIS_CLUSTER_VOTERS", "cluster.voters", "comma-separated node IDs"],
          ["CELERIS_REPLICATION_FACTOR", "cluster.replication_factor", "0-255"],
          ["CELERIS_CLUSTER_TLS_CERT", "cluster.tls.cert_file", "path; all three TLS variables or none"],
          ["CELERIS_CLUSTER_TLS_KEY", "cluster.tls.key_file", "path"],
          ["CELERIS_CLUSTER_TLS_CA", "cluster.tls.ca_file", "path"],
          ["CELERIS_LOG_LEVEL", "log.level", "log filter"],
          ["CELERIS_LOG_FORMAT", "log.format", "pretty | json"],
        ].map(([v, o, x]) => ({
          search: `${v} ${o} ${x}`,
          cells: [<code key="v">{v}</code>, <code key="o">{o}</code>, x],
        }))}
      />
      <p>
        Also read by the node: <code>RUST_LOG</code> (log filter, wins over <code>log.level</code>). Read by the client commands, not the node: <code>CELERIS_ADDR</code>,{" "}
        <code>CELERIS_TOKEN</code>, <code>CELERIS_CA_CERT</code> (see <DocLink to="cli:environment">CLI</DocLink>). A value that does not parse (for example <code>CELERIS_SYNC=sometimes</code>)
        stops the node at start with a message naming the variable.
      </p>

      <H2 id="validation">What the node checks at start</H2>
      <ul>
        <li><code>http.listen</code> and <code>cluster.listen</code> parse as socket addresses.</li>
        <li><code>cluster.listen</code> is not a wildcard address unless <code>cluster.advertise</code> is set.</li>
        <li><code>cluster.seeds</code> and <code>cluster.voters</code> require <code>cluster.listen</code>.</li>
        <li><code>cluster.heartbeat_interval_ms</code> is above 0 and <code>suspect_after_ms</code> exceeds it.</li>
        <li>With voters: <code>raft_heartbeat_ms</code> is above 0 and <code>raft_election_timeout_ms</code> exceeds twice <code>raft_heartbeat_ms</code>. Voter IDs and <code>node.id</code> are valid IDs.</li>
        <li><code>cluster.snapshot_threshold</code>, <code>storage.memtable_size_mb</code> and <code>storage.mutation_retention_secs</code> are at least 1.</li>
        <li>Index definitions are valid and names are unique. Token entries are valid and not duplicated. CORS origins are valid header values.</li>
        <li>TLS and cluster TLS variables are set in full or not at all.</li>
      </ul>
      <p><code>celeris doctor</code> runs the same checks without starting the node and also tests that the data directory is writable and the port is free.</p>

      <H2 id="examples">Complete examples</H2>

      <H3 id="ex-single">Minimal single node</H3>
      <p>Everything else takes the defaults above. Reachable only from the same machine.</p>
      <Code lang="toml" title="celeris.toml">{`[node]
data_dir = "celeris-data"

[http]
listen = "127.0.0.1:8080"`}</Code>

      <H3 id="ex-cluster">Three-node cluster</H3>
      <p>
        Three machines, one failure domain each. Every node lists the same voters and replication factor, has a fixed ID and advertises its own private address. Nodes b and c join through
        node a. When all three are up, the control-plane leader places partitions with a replication factor of 3 on its own. Open the HTTP port to clients and keep 7000 to the other
        nodes only.
      </p>
      <Tabs
        group="cluster-node"
        label="Node"
        items={[
          {
            id: "a",
            label: "node-a (10.0.0.4)",
            content: (
              <Code lang="toml" title="celeris.toml on node-a" flush>{`[node]
data_dir = "/var/lib/celeris"
id = "node-a"

[http]
listen = "0.0.0.0:8080"

[cluster]
listen = "0.0.0.0:7000"
advertise = "10.0.0.4:7000"
zone = "az-1"
voters = ["node-a", "node-b", "node-c"]
replication_factor = 3

[storage]
sync = "always"

[log]
format = "json"`}</Code>
            ),
          },
          {
            id: "b",
            label: "node-b (10.0.0.5)",
            content: (
              <Code lang="toml" title="celeris.toml on node-b" flush>{`[node]
data_dir = "/var/lib/celeris"
id = "node-b"

[http]
listen = "0.0.0.0:8080"

[cluster]
listen = "0.0.0.0:7000"
advertise = "10.0.0.5:7000"
seeds = ["10.0.0.4:7000"]
zone = "az-2"
voters = ["node-a", "node-b", "node-c"]
replication_factor = 3

[storage]
sync = "always"

[log]
format = "json"`}</Code>
            ),
          },
          {
            id: "c",
            label: "node-c (10.0.0.6)",
            content: (
              <Code lang="toml" title="celeris.toml on node-c" flush>{`[node]
data_dir = "/var/lib/celeris"
id = "node-c"

[http]
listen = "0.0.0.0:8080"

[cluster]
listen = "0.0.0.0:7000"
advertise = "10.0.0.6:7000"
seeds = ["10.0.0.4:7000"]
zone = "az-3"
voters = ["node-a", "node-b", "node-c"]
replication_factor = 3

[storage]
sync = "always"

[log]
format = "json"`}</Code>
            ),
          },
        ]}
      />
      <OsCode
        title="Start and check (on each node, then from anywhere)"
        unix={`celeris start --config /etc/celeris/celeris.toml
celeris --addr http://10.0.0.4:8080 node list
celeris --addr http://10.0.0.4:8080 partitions`}
        windows={`celeris start --config C:\\celeris\\celeris.toml
celeris --addr http://10.0.0.4:8080 node list
celeris --addr http://10.0.0.4:8080 partitions`}
      />
      <Callout kind="note">
        Cluster traffic on port 7000 is not encrypted unless you configure <code>[cluster.tls]</code>, and it does not use API tokens. Keep it on a private network or enable mutual TLS, as in
        the hardened file below.
      </Callout>

      <H3 id="ex-hardened">Hardened production node</H3>
      <p>
        One node of a three-node cluster with the API over HTTPS, mutual TLS between nodes, token authentication with least-privilege scopes, an explicit CORS origin, durable writes, structured
        logs and an index. Generate tokens with <code>celeris token create</code> and keep key files readable only by the service account. The walkthrough, with certificate creation, is in{" "}
        <DocLink to="security">Security</DocLink> and the checklist in <DocLink to="production-checklist">Production checklist</DocLink>.
      </p>
      <Code lang="toml" title="/etc/celeris/celeris.toml (node-a)">{`[node]
data_dir = "/var/lib/celeris"
id = "node-a"

[http]
listen = "0.0.0.0:8443"
cors_origins = ["https://app.example.com"]
tls = { cert_file = "/etc/celeris/tls/api.crt", key_file = "/etc/celeris/tls/api.key" }

[cluster]
listen = "10.0.0.4:7000"          # a private interface, not 0.0.0.0
advertise = "10.0.0.4:7000"
zone = "az-1"
voters = ["node-a", "node-b", "node-c"]
replication_factor = 3
tls = { cert_file = "/etc/celeris/tls/node.crt", key_file = "/etc/celeris/tls/node.key", ca_file = "/etc/celeris/tls/cluster-ca.crt" }

[storage]
sync = "always"
memtable_size_mb = 64
block_cache_mb = 512
tombstone_retention_secs = 172800    # 48 h: longer than any outage you expect a replica to survive
mutation_retention_secs = 86400

[[auth.tokens]]
name = "web-app"
sha256 = "<sha256 from celeris token create>"
scopes = ["read", "write"]

[[auth.tokens]]
name = "dashboards"
sha256 = "<sha256 from celeris token create>"
scopes = ["read"]

[[auth.tokens]]
name = "ops"
sha256 = "<sha256 from celeris token create>"
scopes = ["admin"]

[log]
level = "info"
format = "json"

[[indexes]]
name = "orders_by_status"
prefix = "orders/"
field = "status"`}</Code>
      <p>
        The cluster certificate must name <code>10.0.0.4</code> (an IP SAN) or the DNS name you advertise instead. Client commands then use <code>https://</code> and, for a private CA,{" "}
        <code>--ca-cert</code>.
      </p>
      <OsCode
        title="Check the file, then start"
        unix={`celeris doctor --config /etc/celeris/celeris.toml
celeris start --config /etc/celeris/celeris.toml`}
        windows={`celeris doctor --config C:\\celeris\\celeris.toml
celeris start --config C:\\celeris\\celeris.toml`}
      />

      <H2 id="next">Next steps</H2>
      <ul>
        <li><DocLink to="deployment">Deployment</DocLink>: systemd, Docker, Kubernetes and Windows services using these settings.</li>
        <li><DocLink to="clustering">Clustering</DocLink> and <DocLink to="scaling">Scaling</DocLink>.</li>
        <li><DocLink to="security">Security</DocLink>: TLS, tokens and network layout.</li>
        <li><DocLink to="observability">Observability</DocLink>: the log and metrics settings in practice.</li>
      </ul>
    </>
  );
}

export const page: DocPage = {
  slug: "configuration",
  title: "Configuration",
  group: "Reference",
  summary: "Every celeris.toml setting with its type, default, environment variable and meaning, plus complete single-node, cluster and hardened files.",
  keywords: ["celeris.toml", "settings", "environment variables", "CELERIS_", "tls", "tokens", "data_dir", "replication_factor", "sync", "cors", "log level", "indexes", "toml"],
  Body,
};
