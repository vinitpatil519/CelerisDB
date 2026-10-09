import {
  Callout,
  Code,
  CodeTabs,
  Details,
  DocLink,
  H2,
  H3,
  IMAGE,
  OsCode,
  Params,
  Step,
  Steps,
  Table,
  type DocPage,
} from "../kit";
import { ConfigBuilder } from "../demos/ConfigBuilder";

const raw = String.raw;

const SYSTEMD = `[Unit]
Description=CelerisDB node
After=network-online.target
Wants=network-online.target

[Service]
User=celeris
Group=celeris
ExecStart=/usr/local/bin/celeris start --config /etc/celeris/celeris.toml
Restart=always
RestartSec=2
TimeoutStopSec=30
LimitNOFILE=65536
NoNewPrivileges=true
ProtectSystem=strict
ProtectHome=true
PrivateTmp=true
ReadWritePaths=/var/lib/celeris

[Install]
WantedBy=multi-user.target`;

const LAUNCHD = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>dev.celeris.node</string>
  <key>ProgramArguments</key>
  <array>
    <string>/usr/local/bin/celeris</string>
    <string>start</string>
    <string>--config</string>
    <string>/usr/local/etc/celeris/celeris.toml</string>
  </array>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
  <key>SoftResourceLimits</key><dict><key>NumberOfFiles</key><integer>65536</integer></dict>
  <key>StandardErrorPath</key><string>/usr/local/var/log/celeris.log</string>
</dict>
</plist>`;

const NGINX = `map $http_upgrade $connection_upgrade {
    default upgrade;
    ""      "";
}

upstream celeris {
    least_conn;
    server 10.0.0.1:8080 max_fails=3 fail_timeout=10s;
    server 10.0.0.2:8080 max_fails=3 fail_timeout=10s;
    server 10.0.0.3:8080 max_fails=3 fail_timeout=10s;
    keepalive 32;
}

server {
    listen 443 ssl;
    server_name celeris.example.com;
    ssl_certificate     /etc/nginx/tls/celeris.crt;
    ssl_certificate_key /etc/nginx/tls/celeris.key;

    client_max_body_size 41m;      # the node itself accepts bodies up to 40 MiB

    location /v1/admin/ { return 404; }   # keep admin calls off the public listener

    location / {
        proxy_pass http://celeris;
        proxy_http_version 1.1;
        proxy_set_header Host $host;
        proxy_set_header Upgrade $http_upgrade;       # WebSocket change streams
        proxy_set_header Connection $connection_upgrade;
        proxy_read_timeout 1h;                        # idle watchers
        proxy_send_timeout 1h;
        proxy_buffering off;
    }
}`;

const CADDY = `celeris.example.com {
	@admin path /v1/admin/*
	handle @admin {
		respond 404
	}
	handle {
		reverse_proxy 10.0.0.1:8080 10.0.0.2:8080 10.0.0.3:8080 {
			lb_policy least_conn
			health_uri /ready
			health_interval 5s
			health_status 200
		}
	}
}`;

const HAPROXY = `frontend celeris_in
    bind :443 ssl crt /etc/haproxy/certs/celeris.pem
    mode http
    http-request deny if { path_beg /v1/admin }
    default_backend celeris

backend celeris
    mode http
    balance leastconn
    timeout tunnel 1h              # WebSocket change streams stay open
    option httpchk
    http-check send meth GET uri /ready
    http-check expect status 200
    server a 10.0.0.1:8080 check inter 3s fall 3 rise 2
    server b 10.0.0.2:8080 check inter 3s fall 3 rise 2
    server c 10.0.0.3:8080 check inter 3s fall 3 rise 2`;

function Body() {
  return (
    <>
      <p>
        CelerisDB is a single binary, <code>celeris</code>. The same binary runs a node, operates it, and talks to it. A
        deployment is one or more nodes, each with a data directory on a fast disk and two network ports. This page covers
        every way to run it, from a laptop to a three-zone cluster, and what to put in front of it.
      </p>
      <Table
        head={["Port", "Purpose", "Expose to"]}
        rows={[
          [<code key="a">8080</code>, "HTTP/JSON API, WebSocket change streams, /metrics, /health, /ready", "Clients, load balancer, Prometheus"],
          [<code key="b">7000</code>, "Node-to-node traffic (cluster port)", "Other nodes only"],
        ]}
      />
      <Callout kind="warn" title="Defaults are private on purpose">
        A new node listens on <code>127.0.0.1:8080</code> and has no tokens, so nothing is reachable from the network
        until you change <code>http.listen</code>. Before you bind to <code>0.0.0.0</code>, turn on API tokens and TLS (see{" "}
        <DocLink to="security">Security</DocLink>).
      </Callout>

      <H2 id="topologies">Choose a topology</H2>
      <Table
        head={["Topology", "Use it for", "Survives"]}
        rows={[
          ["1 node", "Development, tests, small internal tools, edge devices", "Process crashes. Not the loss of the machine or its disk, so keep backups"],
          ["3 voters, RF 3", "Production default. One node per zone or rack", "Loss of any one node or zone, while keeping strict consistency"],
          ["5 voters, RF 3 or 5", "Larger fault budget for the control plane", "Two voters down for placement; the data tolerance depends on the replication factor"],
        ]}
      />
      <p>
        Voters are the nodes that run the control plane, and every data node must currently be a voter. The voter set is
        fixed when the cluster is created, so decide between 3 and 5 up front. The <DocLink to="clustering">clustering</DocLink> page
        explains the trade-offs. Use the builder below to generate matching configuration for any of these shapes.
      </p>

      <ConfigBuilder />

      <Callout kind="tip">
        The builder uses the exact keys of <code>celeris.toml</code> and the matching <code>CELERIS_*</code> variables, so
        its output is also a quick reference. The full list of settings is on <DocLink to="configuration">Configuration</DocLink>.
      </Callout>

      <H2 id="single-node">Single node</H2>
      <H3 id="single-install">Install and run</H3>
      <p>
        The installers download the release for your platform, verify its SHA-256 checksum and put <code>celeris</code> on your
        PATH. Set <code>CELERIS_VERSION</code> to pin a release tag, or <code>CELERIS_INSTALL_DIR</code> to choose the
        destination.
      </p>
      <OsCode
        linux={`curl -fsSL https://raw.githubusercontent.com/vinitpatil519/CelerisDB/main/install.sh | sh
celeris init
celeris start`}
        macos={`curl -fsSL https://raw.githubusercontent.com/vinitpatil519/CelerisDB/main/install.sh | sh
celeris init
celeris start`}
        windows={`irm https://raw.githubusercontent.com/vinitpatil519/CelerisDB/main/install.ps1 | iex
celeris init
celeris start`}
      />
      <p>
        <code>celeris init</code> writes a commented <code>celeris.toml</code> in the current directory. <code>celeris start</code> runs
        the node in the foreground; Ctrl-C stops it gracefully. <code>celeris doctor</code> checks the config, data directory,
        storage lock, port and node health, and is the first thing to run when a start fails.
      </p>

      <H3 id="service">Run it as a service</H3>
      <p>
        In production, run the node under a supervisor that restarts it and gives it a higher open-file limit. Stop it with a
        normal termination signal or <code>celeris stop</code>; the node flushes and leaves the cluster cleanly.
      </p>
      <H4Os />

      <H2 id="docker">Docker</H2>
      <p>
        The image runs as uid 10001 under <code>tini</code>, listens on <code>0.0.0.0:8080</code> and keeps data in the{" "}
        <code>/var/lib/celeris/data</code> volume. It logs JSON by default and has a built-in health check. Configure it with
        <code> CELERIS_*</code> variables, or mount a <code>celeris.toml</code> and pass <code>--config</code>.
      </p>
      <OsCode
        unix={`docker run -d --name celeris \\
  -p 8080:8080 \\
  -v celeris-data:/var/lib/celeris/data \\
  -e CELERIS_AUTH_TOKENS='app:read+write:<sha256-from-celeris-token-create>' \\
  ${IMAGE}`}
        windows={raw`docker run -d --name celeris -p 8080:8080 -v celeris-data:/var/lib/celeris/data -e "CELERIS_AUTH_TOKENS=app:read+write:<sha256-from-celeris-token-create>" ${IMAGE}`}
      />
      <p>
        To use a config file instead, mount it read-only and start with <code>start --config</code>:
      </p>
      <OsCode
        unix={`docker run -d --name celeris -p 8080:8080 \\
  -v celeris-data:/var/lib/celeris/data \\
  -v "$PWD/celeris.toml:/etc/celeris/celeris.toml:ro" \\
  ${IMAGE} start --config /etc/celeris/celeris.toml`}
        windows={raw`docker run -d --name celeris -p 8080:8080 -v celeris-data:/var/lib/celeris/data -v "${"${PWD}"}\celeris.toml:/etc/celeris/celeris.toml:ro" ${IMAGE} start --config /etc/celeris/celeris.toml`}
      />
      <p>
        Raise the file limit with <code>--ulimit nofile=65536:65536</code> if you expect many connections. Use a named volume or a
        bind mount on local SSD for the data directory, and make sure uid 10001 can write to it.
      </p>

      <H2 id="compose">Docker Compose: a three-node cluster</H2>
      <p>
        The repository ships a Compose file that starts <code>node-a</code>, <code>node-b</code> and <code>node-c</code> as voters in
        three zones, with the API on host ports 8081, 8082 and 8083. Once all three are up, the control-plane leader places
        partitions with three replicas on its own.
      </p>
      <OsCode
        unix={`git clone https://github.com/vinitpatil519/CelerisDB && cd CelerisDB
docker compose up -d --build
curl -X PUT localhost:8081/v1/kv/hello -d '"world"'
curl "localhost:8083/v1/kv/hello?consistency=eventual"`}
        windows={raw`git clone https://github.com/vinitpatil519/CelerisDB; cd CelerisDB
docker compose up -d --build
curl.exe -X PUT localhost:8081/v1/kv/hello -d '\"world\"'
curl.exe "localhost:8083/v1/kv/hello?consistency=eventual"`}
      />
      <p>
        Admin endpoints accept loopback connections only when no tokens are configured, so run them inside a container. Any voter
        works; followers forward the request to the leader.
      </p>
      <Code lang="bash">{`docker compose exec node-a celeris --addr http://127.0.0.1:8080 cluster rebalance --rf 3`}</Code>
      <p>
        <code>docker compose down</code> keeps the data volumes; <code>docker compose down -v</code> deletes them. For your own
        Compose file with tokens and TLS, generate it with the builder above.
      </p>

      <H2 id="kubernetes">Kubernetes</H2>
      <p>
        <code>deploy/kubernetes/celeris.yaml</code> defines a StatefulSet of three voters, a headless Service for the cluster
        port, a client Service and a PodDisruptionBudget that keeps a Raft majority running during voluntary disruptions.
      </p>
      <Code lang="bash">{`kubectl apply -f deploy/kubernetes/celeris.yaml
kubectl rollout status statefulset/celeris
kubectl port-forward svc/celeris 8080:8080`}</Code>
      <p>In another terminal, check the cluster:</p>
      <OsCode
        unix={`curl localhost:8080/v1/status
curl localhost:8080/ready`}
        windows={`curl.exe localhost:8080/v1/status
curl.exe localhost:8080/ready`}
      />
      <H3 id="k8s-how">How the manifest fits together</H3>
      <ul>
        <li>
          Pod names (<code>celeris-0</code>, <code>-1</code>, <code>-2</code>) are the node IDs and the voters, so identity survives restarts.
        </li>
        <li>
          Each pod advertises <code>&lt;pod&gt;.celeris-peers.&lt;namespace&gt;.svc.cluster.local:7000</code>. The headless Service
          publishes addresses before pods are ready, so peers find each other while starting.
        </li>
        <li>
          <code>podManagementPolicy: Parallel</code> starts all voters at once, because the first placement waits for every voter.
        </li>
        <li>
          Each pod gets a 10 GiB <code>ReadWriteOnce</code> volume and requests 250m CPU and 512 MiB of memory with a 2 GiB memory
          limit. Edit <code>volumeClaimTemplates</code> and <code>resources</code> for your workload.
        </li>
        <li>
          Pods run as non-root (uid 10001), prefer different hosts through pod anti-affinity, and use <code>/ready</code> for
          readiness and <code>/health</code> for liveness.
        </li>
        <li>
          The manifest references <code>{IMAGE}</code> with <code>imagePullPolicy: IfNotPresent</code>. Pin a release tag in
          production so a restart never changes the version by surprise.
        </li>
      </ul>
      <p>For a local cluster, build the image and load it instead of pulling:</p>
      <Code lang="bash">{`docker build -t ghcr.io/vinitpatil519/celeris:latest .
kind load docker-image ghcr.io/vinitpatil519/celeris:latest`}</Code>

      <H3 id="k8s-secrets">Tokens, TLS and zones</H3>
      <p>Put the token hashes in a Secret and read them into the environment of the container:</p>
      <Code lang="bash">{`kubectl create secret generic celeris-auth \\
  --from-literal=tokens='app:read+write:<sha256>,ops:admin:<sha256>'`}</Code>
      <Code lang="yaml" title="Add under the container's env">{`- name: CELERIS_AUTH_TOKENS
  valueFrom:
    secretKeyRef: { name: celeris-auth, key: tokens }`}</Code>
      <p>
        For mutual TLS between pods, issue each pod a certificate for{" "}
        <code>&lt;pod&gt;.celeris-peers.&lt;namespace&gt;.svc.cluster.local</code> (cert-manager works well), mount it from a Secret and set
        the three <code>CELERIS_CLUSTER_TLS_*</code> variables to the mounted paths. The{" "}
        <DocLink to="security:cluster-mtls">security page</DocLink> explains what the certificates must contain.
      </p>
      <p>
        To spread replicas across availability zones, give each pod its zone in <code>CELERIS_ZONE</code>. Kubernetes does not
        expose node labels to pods, so use one StatefulSet per zone, or an init container that reads the node&apos;s{" "}
        <code>topology.kubernetes.io/zone</code> label.
      </p>
      <Callout kind="warn" title="Scaling limits, stated plainly">
        The StatefulSet is three voters, and that is also the data-node set. Changing <code>replicas</code> does not add data
        capacity: data nodes must be voters, and the voter set is fixed at bootstrap. Never scale below three. To go from 3 to 5
        voters, create a new five-node cluster and move data with <code>celeris export</code> and <code>celeris import</code>. Scale up
        by giving pods more CPU, memory and disk (expand the volume if your storage class allows it). See{" "}
        <DocLink to="scaling">Scaling</DocLink>.
      </Callout>

      <H2 id="bare-metal">Bare metal and VMs: sizing and tuning</H2>
      <H3 id="sizing">Sizing</H3>
      <ul>
        <li>
          <strong>Nodes:</strong> three, in three failure domains. Each node needs a stable node ID (<code>node.id</code>) and a stable
          cluster address (<code>cluster.advertise</code>).
        </li>
        <li>
          <strong>CPU and memory:</strong> the Kubernetes manifest starts at 250m CPU and 512 MiB, and the engine defaults are a 32 MiB
          write buffer (<code>storage.memtable_size_mb</code>) and a 64 MiB read cache (<code>storage.block_cache_mb</code>). Raise the cache
          to hold your hot set, and leave the rest of the RAM to the operating system page cache.
        </li>
        <li>
          <strong>Disk:</strong> SSD or NVMe. With the default <code>storage.sync = &quot;always&quot;</code>, every write is fsynced before it is
          acknowledged, so fsync latency is your write latency. Concurrent writers share one fsync, so throughput scales with
          concurrency.
        </li>
        <li>
          <strong>Network:</strong> 1 Gbit/s is plenty for most workloads. Keep nodes in one region: replicas acknowledge every
          strict write, so cross-region latency is paid on each one.
        </li>
      </ul>
      <p>
        On AWS, a reasonable start is three <code>m7g.large</code> or <code>i4i.large</code> instances, one per availability zone, in
        private subnets, each with a gp3 volume (3000 IOPS and 125 MiB/s as a floor) for the data directory and a security group
        that allows port 7000 only from the group itself. Instance-store NVMe is fast but disappears when the instance stops, so use
        it only with replication factor 3 and tested backups. This is a reference, not a managed offering.
      </p>

      <H3 id="os-tuning">Operating system tuning</H3>
      <Table
        head={["Area", "What to do"]}
        rows={[
          ["Open files", <>Set the limit to 65536 or more (<code>LimitNOFILE</code> in systemd, <code>NumberOfFiles</code> in launchd, <code>--ulimit</code> in Docker).</>],
          ["Disks", <>Put <code>node.data_dir</code> on a local SSD or NVMe volume with ext4 or XFS (Linux), APFS (macOS) or NTFS (Windows). Avoid NFS and SMB shares: they weaken fsync guarantees.</>],
          ["Sync mode", <><code>always</code> survives power loss. <code>never</code> leaves flushing to the OS and survives only process crashes. Use <code>never</code> for scratch data, not for anything you cannot lose.</>],
          ["Clocks", <>Run NTP or chrony. Strict operations do not depend on clocks, but last-writer-wins resolution in <DocLink to="available-mode">available mode</DocLink> uses timestamps.</>],
          ["Firewall", <>Allow 8080 from clients or the load balancer, and 7000 only between nodes.</>],
          ["Logs", <>Set <code>log.format = &quot;json&quot;</code> for log shippers. <code>RUST_LOG</code> also controls verbosity.</>],
        ]}
      />
      <p>
        The data directory is bound to the node ID: a node refuses to start with a different <code>node.id</code> than the one already
        recorded in its directory. The directory also holds a lock, so only one process can use it. Treat it as opaque, and use{" "}
        <DocLink to="backup-restore">backups and exports</DocLink> rather than copying files by hand.
      </p>

      <H2 id="reverse-proxy">Reverse proxies and load balancers</H2>
      <p>
        You can send clients straight to nodes, but a proxy gives you TLS from a public certificate authority, one address, and
        health-based routing. Three things matter for every proxy:
      </p>
      <ul>
        <li>
          <strong>WebSockets.</strong> Change streams use <code>/v1/watch</code> over a WebSocket, so the proxy must pass the{" "}
          <code>Upgrade</code> and <code>Connection</code> headers and allow long idle times.
        </li>
        <li>
          <strong>Health checks.</strong> Probe <code>GET /ready</code>. It returns 200 while the node is writable and 503 after a storage
          failure. <code>/health</code> is a liveness check only.
        </li>
        <li>
          <strong>Admin endpoints.</strong> Without tokens, admin calls are accepted only from loopback addresses, judged by the
          connection&apos;s peer address. A proxy running on the same host as a node connects from loopback, so it would make{" "}
          <code>/v1/admin/*</code> reachable to everyone. Block that path in the proxy (the snippets below do), and keep tokens on.
        </li>
      </ul>
      <CodeTabs
        group="proxy"
        items={[
          { id: "nginx", label: "nginx", lang: "text", code: NGINX, title: "nginx.conf (http context)" },
          { id: "caddy", label: "Caddy", lang: "text", code: CADDY, title: "Caddyfile" },
          { id: "haproxy", label: "HAProxy", lang: "text", code: HAPROXY, title: "haproxy.cfg" },
        ]}
      />
      <p>
        Open-source nginx has passive health checks only (<code>max_fails</code>); probing <code>/ready</code> actively needs nginx Plus or a
        different balancer. If nodes serve HTTPS themselves, switch the upstream to <code>https://</code> and give the proxy the CA
        that signed their certificates. Cloud balancers work the same way: an internal Network Load Balancer on 8080 with a
        health check on <code>/ready</code>.
      </p>
      <Callout kind="note">
        The <code>/v1/watch</code> endpoint also accepts <code>?access_token=</code> for browsers. Query strings often end up in proxy
        access logs, so scrub them or avoid that form in production.
      </Callout>

      <H2 id="upgrades">Upgrades</H2>
      <p>
        Upgrade a cluster one node at a time and keep a majority running throughout. The Kubernetes PodDisruptionBudget does this for
        voluntary disruptions.
      </p>
      <Steps>
        <Step title="Take a safety copy">
          <p>
            Run <code>celeris export --out before-upgrade.jsonl</code> (any token needs the <code>read</code> scope), or{" "}
            <code>celeris backup --out file</code> on a single node. Exports work across versions and cluster shapes.
          </p>
        </Step>
        <Step title="Check health">
          <p>
            <code>celeris node list</code> should show every node alive, and <code>celeris status</code> should show no running
            migrations.
          </p>
        </Step>
        <Step title="Upgrade followers first">
          <p>
            For each node: stop it, replace the binary or image, start it, and wait until <code>/ready</code> returns 200 and{" "}
            <code>celeris node list</code> shows it alive before moving to the next. Do the current control-plane leader last (find it
            in <code>celeris status</code>).
          </p>
        </Step>
      </Steps>
      <OsCode
        linux={`sudo systemctl stop celeris
curl -fsSL https://raw.githubusercontent.com/vinitpatil519/CelerisDB/main/install.sh | sudo CELERIS_INSTALL_DIR=/usr/local/bin sh
sudo systemctl start celeris
curl -fs localhost:8080/ready`}
        macos={`launchctl bootout system/dev.celeris.node
curl -fsSL https://raw.githubusercontent.com/vinitpatil519/CelerisDB/main/install.sh | sudo CELERIS_INSTALL_DIR=/usr/local/bin sh
sudo launchctl bootstrap system /Library/LaunchDaemons/dev.celeris.node.plist
curl -fs localhost:8080/ready`}
        windows={raw`Stop-Service CelerisDB
$env:CELERIS_INSTALL_DIR = "$env:ProgramData\Celeris"
irm https://raw.githubusercontent.com/vinitpatil519/CelerisDB/main/install.ps1 | iex
Start-Service CelerisDB
curl.exe -fs localhost:8080/ready`}
      />
      <p>
        On Kubernetes, change the image with <code>kubectl set image statefulset/celeris celeris={IMAGE.replace(":latest", ":<tag>")}</code>. A
        StatefulSet updates one pod at a time and waits for readiness, even with the Parallel start policy.
      </p>
      <H3 id="compat">Compatibility caveats</H3>
      <ul>
        <li>
          <strong>Mixed versions are a transition state.</strong> An older node receiving frames from a newer one may drop some until every
          node runs the new version. Consensus and gossip retransmit, so this delays progress rather than losing data, but do not
          leave a cluster half-upgraded.
        </li>
        <li>
          <strong>Upgrade every node before you add secondary indexes.</strong> Nodes without index support cannot apply index build steps.
        </li>
        <li>
          <strong>Config files are strict.</strong> Unknown keys are rejected at startup. A config using a setting from a newer release
          will not start on an older binary, so upgrade binaries before editing configs.
        </li>
        <li>
          <strong>TLS is all or nothing.</strong> A node with cluster TLS cannot talk to one without it. Turning on cluster mTLS is a
          whole-cluster change with a short outage, not a rolling one.
        </li>
        <li>
          The project is pre-1.0 and does not promise on-disk compatibility between every release. Read the release notes and take
          an export first.
        </li>
      </ul>

      <H2 id="data-dir">The data directory</H2>
      <p>
        <code>node.data_dir</code> (default <code>celeris-data</code>, relative paths resolve against the config file) holds everything a
        node persists: its identity, its storage engine files with the write-ahead log, and, in a cluster, the data of every replica
        set it belongs to. Keep it on a dedicated volume, give the service account sole write access, and never share it between two
        processes. Do not edit or copy its contents; the supported ways out are <code>celeris backup</code> (single node) and{" "}
        <code>celeris export</code> (anywhere).
      </p>
      <Params
        rows={[
          { name: "node.data_dir", type: "path", def: "celeris-data", desc: <>Root of everything the node stores. <code>CELERIS_DATA_DIR</code>.</> },
          { name: "node.id", type: "string", def: "random on first start", desc: <>1 to 64 characters of <code>A-Za-z0-9._-</code>. Required in practice for voters. <code>CELERIS_NODE_ID</code>.</> },
          { name: "storage.sync", type: "always | never", def: "always", desc: <>Fsync every write, or leave flushing to the OS. <code>CELERIS_SYNC</code>.</> },
        ]}
      />

      <Details summary="What does a shutdown do?">
        <p>
          On SIGTERM, Ctrl-C or <code>celeris stop</code>, the node stops accepting work, flushes its storage, tells the cluster it is
          leaving, and drains open HTTPS connections for up to 10 seconds. Give your supervisor at least 30 seconds before it
          kills the process (<code>TimeoutStopSec</code>, <code>terminationGracePeriodSeconds</code>).
        </p>
      </Details>

      <H2 id="next">Next steps</H2>
      <ul>
        <li>
          <DocLink to="security">Security</DocLink> for tokens, TLS and mutual TLS between nodes.
        </li>
        <li>
          <DocLink to="clustering">Clustering</DocLink> for voters, replication, rebalancing and failure behaviour.
        </li>
        <li>
          <DocLink to="observability">Observability</DocLink> for metrics, logs and alerts, and{" "}
          <DocLink to="backup-restore">Backup and restore</DocLink>.
        </li>
        <li>
          <DocLink to="production-checklist">Production checklist</DocLink> before you go live.
        </li>
      </ul>
    </>
  );
}

/** Per-OS service definitions. */
function H4Os() {
  return (
    <>
      <OsCode
        linux={`sudo useradd --system --home-dir /var/lib/celeris --create-home --shell /usr/sbin/nologin celeris
sudo install -d -o celeris -g celeris /var/lib/celeris/data
sudo install -d /etc/celeris
sudo install -m 0755 "$(command -v celeris)" /usr/local/bin/celeris
sudo /usr/local/bin/celeris init --dir /etc/celeris --listen 0.0.0.0:8080
# edit /etc/celeris/celeris.toml: set data_dir = "/var/lib/celeris/data", add auth tokens
sudo chgrp celeris /etc/celeris/celeris.toml && sudo chmod 640 /etc/celeris/celeris.toml`}
        macos={`sudo install -d /usr/local/etc/celeris /usr/local/var/celeris /usr/local/var/log
sudo install -m 0755 "$(command -v celeris)" /usr/local/bin/celeris
sudo /usr/local/bin/celeris init --dir /usr/local/etc/celeris --listen 127.0.0.1:8080
# edit /usr/local/etc/celeris/celeris.toml: set data_dir = "/usr/local/var/celeris", add auth tokens`}
        windows={raw`$dir = "$env:ProgramData\Celeris"
New-Item -ItemType Directory -Force "$dir\data" | Out-Null
Copy-Item (Get-Command celeris).Source "$dir\celeris.exe"
& "$dir\celeris.exe" init --dir $dir --listen 0.0.0.0:8080
# edit C:\ProgramData\Celeris\celeris.toml: set data_dir = 'C:\ProgramData\Celeris\data' (single quotes), add auth tokens`}
        title="Prepare directories and config"
      />
      <OsCode
        linux={SYSTEMD}
        macos={LAUNCHD}
        windows={raw`# CelerisDB is a console program, so run it through a service wrapper. NSSM is a
# third-party tool (winget install NSSM.NSSM); it sends Ctrl-C on stop, which the node handles gracefully.
nssm install CelerisDB "C:\ProgramData\Celeris\celeris.exe" start --config "C:\ProgramData\Celeris\celeris.toml"
nssm set CelerisDB AppExit Default Restart
nssm set CelerisDB AppStopMethodConsole 20000
nssm start CelerisDB

# Without a wrapper: a scheduled task that starts at boot and restarts on failure.
$action = New-ScheduledTaskAction -Execute "C:\ProgramData\Celeris\celeris.exe" -Argument 'start --config "C:\ProgramData\Celeris\celeris.toml"'
$trigger = New-ScheduledTaskTrigger -AtStartup
$settings = New-ScheduledTaskSettingsSet -RestartCount 5 -RestartInterval (New-TimeSpan -Minutes 1) -ExecutionTimeLimit ([TimeSpan]::Zero)
Register-ScheduledTask -TaskName CelerisDB -Action $action -Trigger $trigger -Settings $settings -User SYSTEM -RunLevel Highest`}
        title="Service definition"
        lang="text"
      />
      <OsCode
        linux={`sudo cp celeris.service /etc/systemd/system/celeris.service   # the unit above
sudo systemctl daemon-reload
sudo systemctl enable --now celeris
journalctl -u celeris -f`}
        macos={`# save the plist as /Library/LaunchDaemons/dev.celeris.node.plist
sudo chown root:wheel /Library/LaunchDaemons/dev.celeris.node.plist
sudo launchctl bootstrap system /Library/LaunchDaemons/dev.celeris.node.plist
tail -f /usr/local/var/log/celeris.log`}
        windows={`Get-Service CelerisDB   # if you used NSSM
Get-ScheduledTask CelerisDB | Start-ScheduledTask   # if you used the task`}
        title="Enable and watch"
      />
      <Callout kind="note">
        The Windows service wrapper above is a convention, not something the project ships: CelerisDB does not register itself as a
        Windows service. The Windows task runs as SYSTEM, so give <code>C:\ProgramData\Celeris</code> an access list that only
        SYSTEM and Administrators can read once tokens and TLS keys live there. On macOS, prefer Linux for production. The macOS
        unit is meant for development servers and small installations.
      </Callout>
    </>
  );
}

export const page: DocPage = {
  slug: "deployment",
  title: "Deployment",
  group: "Operate",
  summary: "Run CelerisDB from one node to a multi-zone cluster: services, Docker, Compose, Kubernetes, proxies and upgrades.",
  keywords: [
    "install",
    "systemd",
    "launchd",
    "windows service",
    "docker",
    "compose",
    "kubernetes",
    "statefulset",
    "helm",
    "nginx",
    "caddy",
    "haproxy",
    "load balancer",
    "websocket",
    "health check",
    "ulimit",
    "upgrade",
    "rolling",
    "bare metal",
    "config builder",
  ],
  Body,
};
