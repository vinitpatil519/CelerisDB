import { Callout, Code, DocLink, H2, H3, OsCode, Steps, Step, REPO, type DocPage } from "../kit";

const r = String.raw;

function Body() {
  return (
    <>
      <p>
        This guide takes you from nothing to a running node, through every basic operation, and then to a three-node
        cluster that you will deliberately break. Budget about fifteen minutes. If you would rather try the commands
        before installing anything, the <DocLink to="playground">browser playground</DocLink> simulates the same CLI.
      </p>

      <H2 id="install">1. Install</H2>
      <p>
        The shortest path is the install script; other options (Docker, release binaries, building from source) are on
        the <DocLink to="installation">Installation</DocLink> page.
      </p>
      <OsCode
        linux="curl -fsSL https://raw.githubusercontent.com/vinitpatil519/CelerisDB/main/install.sh | sh"
        macos="curl -fsSL https://raw.githubusercontent.com/vinitpatil519/CelerisDB/main/install.sh | sh"
        windows="irm https://raw.githubusercontent.com/vinitpatil519/CelerisDB/main/install.ps1 | iex"
      />
      <Code lang="bash">{`celeris --version`}</Code>

      <H2 id="start">2. Create a config and start a node</H2>
      <p>
        <code>celeris init</code> writes a commented <code>celeris.toml</code> in the current directory.{" "}
        <code>celeris start</code> runs a node in the foreground; stop it with Ctrl-C. By default the node listens on{" "}
        <code>127.0.0.1:8080</code> and stores data in <code>./celeris-data</code>.
      </p>
      <Code lang="bash" title="Terminal 1">{`mkdir celeris-demo && cd celeris-demo
celeris init
celeris start`}</Code>
      <p>
        The node prints one line to standard output when it is ready, for example{" "}
        <code>celeris 0.1.0 node 7f3a... listening on http://127.0.0.1:8080</code>. Logs go to standard error. Leave this
        terminal running and open a second one.
      </p>
      <Code lang="bash" title="Terminal 2">{`celeris status`}</Code>
      <p>
        You can also run <code>celeris start</code> with no config file at all; it prints a note and uses the defaults.
      </p>

      <H2 id="write-read">3. Write and read data</H2>
      <p>
        A value is any JSON document, so a string needs its quotes. Quoting differs between shells, which is why the
        examples below have a Windows variant.
      </p>
      <OsCode
        title="Put and get"
        unix={`celeris put users/42 '{"name":"Vinit","plan":"pro"}'
celeris get users/42
celeris put greeting '"hello"'
celeris get greeting`}
        windows={r`celeris put users/42 '{\"name\":\"Vinit\",\"plan\":\"pro\"}'
celeris get users/42
celeris put greeting '\"hello\"'
celeris get greeting`}
      />
      <Code lang="text" title="Output">{`OK version=3 mutation=5d0c3b52-...
{
  "name": "Vinit",
  "plan": "pro"
}`}</Code>
      <p>
        Every write prints <code>OK</code> with the new <strong>version</strong> and a <strong>mutation ID</strong>. The
        version is the commit that wrote the key; you will use it for compare-and-set below. Your version numbers will
        differ.
      </p>
      <Callout kind="tip" title="PowerShell quoting">
        <p>
          Windows PowerShell 5.1 strips the double quotes inside a single-quoted argument, so it needs{" "}
          <code>\&quot;</code> as shown. PowerShell 7.3 and later pass them through correctly, so there you write plain
          JSON like <code>{`'{"name":"Vinit"}'`}</code> and the backslashes would be wrong. The form that works in every
          shell and every PowerShell version is to pipe the value in:
        </p>
        <Code lang="powershell" flush>{`'{"name":"Vinit","plan":"pro"}' | celeris put users/42 --file -`}</Code>
      </Callout>
      <H3 id="scan-query">Scan and query</H3>
      <p>
        <code>scan</code> lists keys in order, optionally by prefix. <code>query</code> filters on the JSON values and runs
        on the node that holds the data.
      </p>
      <OsCode
        title="Load some orders, then list and filter them"
        unix={`celeris put orders/1 '{"status":"paid","total":120}'
celeris put orders/2 '{"status":"pending","total":45}'
celeris put orders/3 '{"status":"paid","total":250}'

celeris scan --prefix orders/
celeris query --prefix orders/ --where '{"status":"paid","total":{"$gte":100}}'
celeris query --prefix orders/ --where '{"status":"paid"}' --count --sum total --all`}
        windows={r`celeris put orders/1 '{\"status\":\"paid\",\"total\":120}'
celeris put orders/2 '{\"status\":\"pending\",\"total\":45}'
celeris put orders/3 '{\"status\":\"paid\",\"total\":250}'

celeris scan --prefix orders/
celeris query --prefix orders/ --where '{\"status\":\"paid\",\"total\":{\"$gte\":100}}'
celeris query --prefix orders/ --where '{\"status\":\"paid\"}' --count --sum total --all`}
      />
      <p>
        Results are tab-separated <code>key</code> and value lines. Operators include <code>$eq $ne $gt $gte $lt $lte $in $prefix</code>{" "}
        and more; see <DocLink to="queries">Queries</DocLink>.
      </p>

      <H2 id="cas">4. Compare-and-set</H2>
      <p>
        Pass <code>--if-version N</code> to write only if the key is still at version N, or <code>--if-absent</code> to
        create a key only if it does not exist. If the condition fails, nothing is written and the error tells you the
        current version.
      </p>
      <OsCode
        title="Conditional writes"
        unix={`celeris put counter 0 --if-absent          # creates it
celeris put counter 1 --if-absent          # fails: it exists now
celeris get counter --json                  # note the version
celeris put counter 1 --if-version 999      # fails: wrong version`}
        windows={`celeris put counter 0 --if-absent
celeris put counter 1 --if-absent
celeris get counter --json
celeris put counter 1 --if-version 999`}
      />
      <Code lang="text" title="A failed condition (exit code 1)">{`error [condition_failed] (HTTP 409): condition \`absent\` failed for key \`counter\`: current version is 7
  outcome: not applied
  current version: 7
  mutation: 9c1e...`}</Code>
      <p>
        A typical pattern: read a value and its version (<code>get --json</code>), compute the new value, write with{" "}
        <code>--if-version</code>, and on <code>condition_failed</code> read again and retry.
      </p>

      <H2 id="ttl">5. Expiring keys (TTL)</H2>
      <p>
        <code>--ttl</code> takes a duration such as <code>30s</code>, <code>10m</code> or <code>1h</code>. After it passes, the
        key behaves as if it was deleted.
      </p>
      <Code lang="bash">{`celeris put session/abc '"token"' --ttl 30s
celeris get session/abc --json     # expires_at_ms shows the absolute expiry
# wait 30 seconds
celeris get session/abc            # not found: session/abc  (exit code 4)`}</Code>

      <H2 id="idempotent">6. Safe retries with mutation IDs</H2>
      <p>
        Every write carries a mutation ID; the CLI generates one if you do not. Reusing the same ID for the same write
        never applies it twice. If the same ID arrives with a different payload, it is rejected. This is what makes
        retrying after a timeout safe.
      </p>
      <OsCode
        title="Retry the same write"
        unix={`ID=3f2b8c1e-5d4a-4c7e-9b1a-0a1b2c3d4e5f
celeris put orders/9 '{"status":"new","total":10}' --mutation-id $ID
celeris put orders/9 '{"status":"new","total":10}' --mutation-id $ID   # deduplicated
celeris mutation $ID`}
        windows={r`$ID = '3f2b8c1e-5d4a-4c7e-9b1a-0a1b2c3d4e5f'
celeris put orders/9 '{\"status\":\"new\",\"total\":10}' --mutation-id $ID
celeris put orders/9 '{\"status\":\"new\",\"total\":10}' --mutation-id $ID
celeris mutation $ID`}
      />
      <p>
        The second write answers <code>OK version=... (already committed; retry was deduplicated)</code>, and{" "}
        <code>celeris mutation</code> prints <code>committed at version ...</code>. If a write ever exits with code 3, its
        outcome is unknown: run <code>celeris mutation &lt;id&gt;</code> to find out. See{" "}
        <DocLink to="core-concepts:mutation-ids">mutation IDs</DocLink>.
      </p>

      <H2 id="consistency-flag">7. Choose a consistency mode</H2>
      <p>
        <code>-c</code> (or <code>--consistency</code>) selects the mode per request. The default is <code>strict</code>. A{" "}
        <code>bounded</code> read also needs the staleness you accept.
      </p>
      <Code lang="bash">{`celeris get users/42 -c strict
celeris get users/42 -c eventual
celeris get users/42 -c bounded --max-staleness 500ms
celeris put cache/home '"<html>"' -c eventual
celeris get users/42 -c eventual --json     # the body reports the mode actually applied`}</Code>
      <p>
        On a single node all modes give the same result, because there is only one replica. They start to differ in a
        cluster, which is next. See <DocLink to="consistency">Consistency</DocLink>.
      </p>
      <Code lang="bash" title="Stop the node when you are done (Terminal 2, or Ctrl-C in Terminal 1)">{`celeris stop`}</Code>

      <H2 id="cluster">8. A three-node cluster with Docker Compose</H2>
      <p>
        The repository ships a compose file with three voters in three zones. You need Docker with Compose, plus the{" "}
        <code>celeris</code> binary you installed (it doubles as the client). The APIs are exposed on host ports{" "}
        <code>8081</code> (node-a), <code>8082</code> (node-b) and <code>8083</code> (node-c).
      </p>
      <OsCode
        unix={`git clone ${REPO}.git
cd CelerisDB
docker compose up -d --build
docker compose ps`}
        windows={`git clone ${REPO}.git
cd CelerisDB
docker compose up -d --build
docker compose ps`}
      />
      <p>
        The first build compiles the Rust workspace, which takes a few minutes. Once all three nodes are up, the control
        plane places partitions with three replicas automatically. Check that the cluster formed:
      </p>
      <Code lang="bash">{`celeris --addr http://127.0.0.1:8081 node list
celeris --addr http://127.0.0.1:8081 partitions`}</Code>
      <p>
        You should see three nodes in the <code>alive</code> state and a partition map with replication factor 3.
      </p>

      <H3 id="cluster-write">Write to the leader</H3>
      <p>
        In a replicated cluster each key belongs to a replica set, and only that set's leader accepts its writes.
        Ask where a key lives, then write to the leader's port.
      </p>
      <Code lang="bash">{`celeris --addr http://127.0.0.1:8081 partitions --key hello`}</Code>
      <Code lang="text" title="Example output (your leader may differ)">{`key        hello
partition  2210 (epoch 1)
leader     node-b
replicas   node-b, node-c, node-a`}</Code>
      <p>
        Here the leader is <code>node-b</code>, which is on port <code>8082</code>. Substitute the port of whichever node
        your output names. If you ever send a write to a node that is not the leader, you get an error such as{" "}
        <code>not_leader</code> that names the current leader; resend it there.
      </p>
      <OsCode
        title="Write via the leader, read from another node"
        unix={`celeris --addr http://127.0.0.1:8082 put hello '"world"'
celeris --addr http://127.0.0.1:8081 get hello -c eventual
celeris --addr http://127.0.0.1:8083 get hello -c eventual`}
        windows={`'"world"' | celeris --addr http://127.0.0.1:8082 put hello --file -
celeris --addr http://127.0.0.1:8081 get hello -c eventual
celeris --addr http://127.0.0.1:8083 get hello -c eventual`}
      />
      <p>
        <code>strict</code> writes are acknowledged once a majority of the replica set (two of three) has them.{" "}
        <code>eventual</code> reads can be answered by any replica, so they work from every node.
      </p>

      <H3 id="failover">Try a failover</H3>
      <p>
        Stop the node that leads your key and watch the cluster carry on with the remaining two, which are still a
        majority.
      </p>
      <Steps>
        <Step title="Stop the leader">
          <Code lang="bash">{`docker compose stop node-b`}</Code>
          <p>Use the service name of your key's leader.</p>
        </Step>
        <Step title="Look at the cluster from a survivor">
          <Code lang="bash">{`celeris --addr http://127.0.0.1:8081 node list`}</Code>
          <p>
            The stopped node moves from <code>alive</code> to <code>suspect</code> and then <code>unreachable</code> after a
            few seconds.
          </p>
        </Step>
        <Step title="Find the new leader and keep writing">
          <p>
            Leader election takes a short moment, so a write in the first seconds may fail; the failure says whether the
            write was applied. Reuse one mutation ID so retrying is safe.
          </p>
          <OsCode
            unix={`celeris --addr http://127.0.0.1:8081 partitions --key hello
# write to the new leader's port (8081 or 8083)
celeris --addr http://127.0.0.1:8083 put hello '"still here"' \\
  --mutation-id 3f2b8c1e-5d4a-4c7e-9b1a-0a1b2c3d4e5f
celeris --addr http://127.0.0.1:8083 get hello`}
            windows={`celeris --addr http://127.0.0.1:8081 partitions --key hello
# write to the new leader's port (8081 or 8083)
'"still here"' | celeris --addr http://127.0.0.1:8083 put hello --file - --mutation-id 3f2b8c1e-5d4a-4c7e-9b1a-0a1b2c3d4e5f
celeris --addr http://127.0.0.1:8083 get hello`}
          />
        </Step>
        <Step title="Bring the node back">
          <Code lang="bash">{`docker compose start node-b
celeris --addr http://127.0.0.1:8081 node list`}</Code>
          <p>
            It rejoins and catches up from its replicas. Stop a <em>second</em> node as well and a strict write will fail,
            by design: with only one of three replicas left there is no majority, and a <code>strict</code> request is never
            silently downgraded.
          </p>
        </Step>
      </Steps>
      <Callout kind="warn" title="Clean up">
        <code>docker compose down</code> stops the cluster and keeps the data; <code>docker compose down -v</code> deletes it.
      </Callout>

      <H2 id="next">Next steps</H2>
      <ul>
        <li>
          <DocLink to="core-concepts">Core concepts</DocLink>: keys, values, versions, TTL, batches and the five modes.
        </li>
        <li>
          <DocLink to="sdk-typescript">SDKs</DocLink>: use CelerisDB from TypeScript, Python, Go or Rust, which handle routing and retries for you.
        </li>
        <li>
          <DocLink to="clustering">Clustering</DocLink> and <DocLink to="deployment">Deployment</DocLink> for real topologies.
        </li>
        <li>
          <DocLink to="security">Security</DocLink> before you expose a node beyond localhost.
        </li>
      </ul>
    </>
  );
}

export const page: DocPage = {
  slug: "quickstart",
  title: "Quickstart",
  group: "Get started",
  summary: "From zero to a running node, your first reads and writes, and a three-node cluster you can fail over.",
  keywords: ["getting started", "tutorial", "first steps", "hello world", "put get", "cas", "ttl", "cluster", "failover", "docker compose", "powershell quoting"],
  Body,
};
