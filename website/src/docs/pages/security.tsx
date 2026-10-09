import {
  Callout,
  Code,
  DocLink,
  H2,
  H3,
  OsCode,
  Table,
  type DocPage,
} from "../kit";

const raw = String.raw;

const MTLS_BASH = `set -euo pipefail
mkdir -p tls && cd tls

# 1. A CA used for nothing but this cluster. Anything it signs counts as a cluster member.
openssl req -x509 -newkey ec -pkeyopt ec_paramgen_curve:prime256v1 -nodes \\
  -keyout cluster-ca.key -out cluster-ca.crt -days 3650 \\
  -subj "/CN=celeris-cluster-ca" \\
  -addext "basicConstraints=critical,CA:TRUE" \\
  -addext "keyUsage=critical,keyCertSign,cRLSign"

# 2. One certificate per node. The SAN must name the host in that node's cluster.advertise.
#    Use DNS:name for hostnames and IP:1.2.3.4 for IP addresses (comma separated).
issue() {
  name="$1"; san="$2"
  openssl req -newkey ec -pkeyopt ec_paramgen_curve:prime256v1 -nodes \\
    -keyout "$name.key" -out "$name.csr" -subj "/CN=$name"
  printf "subjectAltName=%s\\nbasicConstraints=CA:FALSE\\nkeyUsage=digitalSignature\\nextendedKeyUsage=serverAuth,clientAuth\\n" "$san" > "$name.ext"
  openssl x509 -req -in "$name.csr" -CA cluster-ca.crt -CAkey cluster-ca.key -CAcreateserial \\
    -out "$name.crt" -days 825 -extfile "$name.ext"
  rm "$name.csr" "$name.ext"
}
issue node-a "DNS:node-a.celeris.internal"
issue node-b "DNS:node-b.celeris.internal"
issue node-c "DNS:node-c.celeris.internal"

chmod 600 *.key
ls -l`;

const MTLS_MAC_PREFIX = `# macOS ships LibreSSL. Use Homebrew OpenSSL for these options (brew install openssl).
export PATH="$(brew --prefix openssl)/bin:$PATH"
`;

const MTLS_PS = raw`$ErrorActionPreference = "Stop"
# Needs OpenSSL: winget install ShiningLight.OpenSSL.Light, or the copy inside Git for Windows
# (add C:\Program Files\Git\usr\bin to PATH for this session).
function ossl { & openssl @args; if ($LASTEXITCODE -ne 0) { throw "openssl failed" } }

New-Item -ItemType Directory -Force tls | Out-Null
Set-Location tls

# 1. A CA used for nothing but this cluster. Anything it signs counts as a cluster member.
ossl req -x509 -newkey ec -pkeyopt ec_paramgen_curve:prime256v1 -nodes -keyout cluster-ca.key -out cluster-ca.crt -days 3650 -subj "/CN=celeris-cluster-ca" -addext "basicConstraints=critical,CA:TRUE" -addext "keyUsage=critical,keyCertSign,cRLSign"

# 2. One certificate per node. The SAN must name the host in that node's cluster.advertise.
#    Use DNS:name for hostnames and IP:1.2.3.4 for IP addresses (comma separated).
function Issue($name, $san) {
  ossl req -newkey ec -pkeyopt ec_paramgen_curve:prime256v1 -nodes -keyout "$name.key" -out "$name.csr" -subj "/CN=$name"
  $ext = @("subjectAltName=$san", "basicConstraints=CA:FALSE", "keyUsage=digitalSignature", "extendedKeyUsage=serverAuth,clientAuth")
  [IO.File]::WriteAllLines("$PWD\$name.ext", $ext)   # UTF-8 without a BOM, which OpenSSL needs
  ossl x509 -req -in "$name.csr" -CA cluster-ca.crt -CAkey cluster-ca.key -CAcreateserial -out "$name.crt" -days 825 -extfile "$name.ext"
  Remove-Item "$name.csr", "$name.ext"
}
Issue "node-a" "DNS:node-a.celeris.internal"
Issue "node-b" "DNS:node-b.celeris.internal"
Issue "node-c" "DNS:node-c.celeris.internal"

# Keep the files private to your account and the service account that runs celeris.
icacls . /inheritance:r /grant:r "$($env:USERNAME):(OI)(CI)F" "SYSTEM:(OI)(CI)F" | Out-Null
Get-ChildItem`;

function Body() {
  return (
    <>
      <p>
        CelerisDB is secure by default in one narrow sense: a new node listens only on loopback and exposes nothing to the network. As
        soon as you open it up, security is yours to configure. This page covers the controls the database provides (API tokens
        with scopes, TLS for clients, mutual TLS between nodes), how to operate them on every platform, and, just as important, what
        it does not provide.
      </p>

      <H2 id="defaults">Defaults</H2>
      <Table
        head={["Setting", "Default", "Effect"]}
        rows={[
          [<code key="1">http.listen</code>, <code key="1b">127.0.0.1:8080</code>, "Only local processes can reach the API."],
          [<code key="2">auth.tokens</code>, "none", "Authentication is off: every request is allowed, and admin endpoints accept loopback connections only."],
          [<code key="3">http.tls</code>, "none", "Plain HTTP."],
          [<code key="4">http.cors_origins</code>, <code key="4b">[]</code>, "CORS disabled: browsers on other origins are blocked."],
          [<code key="5">cluster.tls</code>, "none", "The cluster port is neither encrypted nor authenticated."],
        ]}
      />

      <H2 id="tokens">API tokens and scopes</H2>
      <p>
        Authentication turns on as soon as one token exists. Clients send <code>Authorization: Bearer &lt;token&gt;</code>. The node stores
        only the SHA-256 hash of each token, so a leaked config file does not leak usable credentials, and requests are checked by
        comparing hashes.
      </p>
      <Table
        head={["Scope", "Allows"]}
        rows={[
          [<code key="r">read</code>, "Reads, scans, queries, change streams, status, partitions, conflicts, mutation status."],
          [<code key="w">write</code>, "Puts, deletes, batches, clearing conflicts."],
          [<code key="a">admin</code>, <>Everything under <code>/v1/admin/*</code> (rebalance, shutdown, backup), from any address.</>],
        ]}
      />
      <p>
        Scopes are independent: <code>write</code> does not include <code>read</code>, and <code>admin</code> does not include either. Give an
        application that reads and writes both scopes, and keep <code>admin</code> on a separate token that only operators hold.
      </p>
      <H3 id="create-token">Create a token</H3>
      <OsCode
        unix={`celeris token create app --scope read,write
celeris token create ops --scope admin`}
        windows={`celeris token create app --scope read,write
celeris token create ops --scope admin`}
      />
      <p>
        Each command prints the new random token once, and the config line holding its hash. Give the token to the client and
        paste the line into the node&apos;s configuration (<code>celeris token hash</code> hashes a token you already have, read from
        stdin):
      </p>
      <Code lang="toml" title="celeris.toml">{`[[auth.tokens]]
name = "app"
sha256 = "<64 lowercase hex characters>"
scopes = ["read", "write"]

[[auth.tokens]]
name = "ops"
sha256 = "<64 lowercase hex characters>"
scopes = ["admin"]`}</Code>
      <p>
        The same tokens can come from the environment, which suits containers. The format is{" "}
        <code>name:scope+scope:sha256</code>, comma separated, and it replaces any tokens in the file:
      </p>
      <Code lang="bash">{`CELERIS_AUTH_TOKENS='app:read+write:<sha256>,ops:admin:<sha256>'`}</Code>
      <H3 id="using-tokens">Using a token</H3>
      <OsCode
        unix={`export CELERIS_TOKEN=<token>          # used by the celeris CLI
celeris get users/42
curl -H "Authorization: Bearer $CELERIS_TOKEN" http://127.0.0.1:8080/v1/kv/users/42`}
        windows={`$env:CELERIS_TOKEN = "<token>"      # used by the celeris CLI
celeris get users/42
curl.exe -H "Authorization: Bearer $env:CELERIS_TOKEN" http://127.0.0.1:8080/v1/kv/users/42`}
      />
      <p>
        A missing or unknown token gets <code>401 unauthorized</code> with <code>WWW-Authenticate: Bearer</code>. A valid token without the
        needed scope gets <code>403 forbidden</code>. Three probes stay open so that load balancers and Prometheus work:{" "}
        <code>/health</code>, <code>/ready</code> and <code>/metrics</code>. They carry no data, but <code>/metrics</code> does describe your
        workload, so expose it on a private network only.
      </p>
      <Callout kind="note" title="WebSocket tokens">
        Browsers cannot set headers on a WebSocket, so <code>/v1/watch</code> also accepts <code>?access_token=&lt;token&gt;</code>. It is the
        only route that does, because tokens in URLs end up in logs. Prefer a header from servers, and scrub query strings in proxy
        logs.
      </Callout>
      <H3 id="rotation">Rotation</H3>
      <p>
        Tokens load when the node starts and do not expire. To rotate: create the new token, add its hash next to the old one, roll the
        nodes one at a time, switch clients to the new token, then remove the old hash and roll again. Names are labels for logs
        and metrics; name rotated tokens distinctly (for example <code>app-2026-10</code>). The same hash cannot be listed twice.
      </p>
      <Details2 />

      <H2 id="api-tls">TLS for the API</H2>
      <p>
        Point <code>http.tls</code> at a PEM certificate chain (leaf first) and a PEM private key (PKCS#8, PKCS#1 or SEC1). The node then
        serves HTTPS only, negotiating HTTP/2 or HTTP/1.1, and change streams use <code>wss://</code>. A plain HTTP request to the port fails
        the handshake. Paths in a config file are relative to that file.
      </p>
      <Code lang="toml">{`[http]
listen = "0.0.0.0:8443"
tls = { cert_file = "tls/api.crt", key_file = "tls/api.key" }`}</Code>
      <p>
        or <code>CELERIS_TLS_CERT</code> and <code>CELERIS_TLS_KEY</code> (set both or neither).
      </p>
      <H3 id="api-cert">Create a certificate</H3>
      <p>
        For production, use a certificate from your organization&apos;s CA or a public one. CelerisDB does not speak ACME and does not reload
        certificates without a restart, so after a renewal, restart the node (rolling, one at a time). Alternatively, terminate TLS at
        a proxy such as Caddy that renews automatically (see <DocLink to="deployment:reverse-proxy">Deployment</DocLink>).
      </p>
      <p>For development and tests, create a self-signed certificate (OpenSSL 1.1.1 or newer, or LibreSSL 3.1 or newer):</p>
      <OsCode
        linux={`mkdir -p tls
openssl req -x509 -newkey ec -pkeyopt ec_paramgen_curve:prime256v1 -nodes \\
  -keyout tls/api.key -out tls/api.crt -days 365 \\
  -subj "/CN=localhost" \\
  -addext "subjectAltName=DNS:localhost,IP:127.0.0.1,IP:::1"
chmod 600 tls/api.key`}
        macos={`mkdir -p tls
# If this fails on the system LibreSSL, use Homebrew OpenSSL: brew install openssl
openssl req -x509 -newkey ec -pkeyopt ec_paramgen_curve:prime256v1 -nodes \\
  -keyout tls/api.key -out tls/api.crt -days 365 \\
  -subj "/CN=localhost" \\
  -addext "subjectAltName=DNS:localhost,IP:127.0.0.1,IP:::1"
chmod 600 tls/api.key`}
        windows={`# Needs OpenSSL: winget install ShiningLight.OpenSSL.Light (or the copy inside Git for Windows)
New-Item -ItemType Directory -Force tls | Out-Null
openssl req -x509 -newkey ec -pkeyopt ec_paramgen_curve:prime256v1 -nodes -keyout tls/api.key -out tls/api.crt -days 365 -subj "/CN=localhost" -addext "subjectAltName=DNS:localhost,IP:127.0.0.1,IP:::1"`}
        title="Self-signed certificate for localhost"
      />
      <p>
        <a href="https://github.com/FiloSottile/mkcert">mkcert</a> is more convenient for development: it creates a local CA that your
        browser and tools already trust, so you need no <code>--ca-cert</code> flags.
      </p>
      <OsCode
        linux={`# install mkcert from your package manager or its releases page, then:
mkcert -install
mkdir -p tls && mkcert -cert-file tls/api.crt -key-file tls/api.key localhost 127.0.0.1 ::1`}
        macos={`brew install mkcert
mkcert -install
mkdir -p tls && mkcert -cert-file tls/api.crt -key-file tls/api.key localhost 127.0.0.1 ::1`}
        windows={`winget install FiloSottile.mkcert    # or: choco install mkcert
mkcert -install
New-Item -ItemType Directory -Force tls | Out-Null
mkcert -cert-file tls/api.crt -key-file tls/api.key localhost 127.0.0.1 ::1`}
        title="mkcert (development only)"
      />
      <H3 id="trust">Making clients trust a private CA</H3>
      <OsCode
        unix={`celeris --addr https://127.0.0.1:8443 --ca-cert tls/api.crt status   # or CELERIS_CA_CERT
export NODE_EXTRA_CA_CERTS=$PWD/tls/ca.pem        # Node.js and the TypeScript SDK
export SSL_CERT_FILE=$PWD/tls/ca.pem              # Python SDK`}
        windows={`celeris --addr https://127.0.0.1:8443 --ca-cert tls/api.crt status   # or CELERIS_CA_CERT
$env:NODE_EXTRA_CA_CERTS = "$PWD\\tls\\ca.pem"        # Node.js and the TypeScript SDK
$env:SSL_CERT_FILE = "$PWD\\tls\\ca.pem"              # Python SDK`}
      />
      <p>
        The CLI trusts the public web PKI by default. SDKs use the platform trust store. With a self-signed certificate, the
        certificate itself is the CA file; with a private CA, use the CA certificate.
      </p>

      <H2 id="cluster-mtls">Mutual TLS between nodes</H2>
      <p>
        The cluster port carries consensus, replication, snapshots and data migration. With <code>cluster.tls</code>, every
        node-to-node connection is wrapped in TLS and <em>both</em> sides present certificates:
      </p>
      <ul>
        <li>An incoming connection must present a client certificate that chains to the cluster CA.</li>
        <li>An outgoing connection verifies the server certificate against the same CA and against the address it dialed.</li>
        <li>
          Therefore each node certificate must name the host of that node&apos;s <code>cluster.advertise</code> address, as a DNS or IP
          subject alternative name (SAN), and must be valid for both server and client use.
        </li>
      </ul>
      <Callout kind="danger" title="Use a CA dedicated to the cluster">
        Any certificate signed by the CA you configure is accepted as a cluster member. Do not reuse your organization&apos;s general CA or
        the CA that signs public API certificates. Protect the CA key like a root credential and keep it off the nodes.
      </Callout>
      <Code lang="toml" title="celeris.toml">{`[cluster]
listen = "0.0.0.0:7000"
advertise = "node-a.celeris.internal:7000"
tls = { cert_file = "tls/node.crt", key_file = "tls/node.key", ca_file = "tls/cluster-ca.crt" }`}</Code>
      <p>
        or <code>CELERIS_CLUSTER_TLS_CERT</code>, <code>CELERIS_CLUSTER_TLS_KEY</code> and <code>CELERIS_CLUSTER_TLS_CA</code> (all three or none).
        The setting is all or nothing: a TLS node and a plain node cannot talk, so enable it on every node together, with a brief
        outage.
      </p>
      <H3 id="mtls-script">Create the CA and node certificates</H3>
      <p>
        This script makes a cluster CA and one certificate per node. Edit the hostnames to match each node&apos;s{" "}
        <code>cluster.advertise</code>. Then copy <code>cluster-ca.crt</code>, <code>&lt;node&gt;.crt</code> and <code>&lt;node&gt;.key</code> to each
        node (renamed to the paths in its config), and never copy <code>cluster-ca.key</code> to a node.
      </p>
      <OsCode
        linux={MTLS_BASH}
        macos={MTLS_MAC_PREFIX + MTLS_BASH}
        windows={MTLS_PS}
        title="Cluster CA and per-node certificates"
        lang="bash"
      />
      <Code lang="bash" title="Verify a certificate before deploying it">{`openssl verify -CAfile tls/cluster-ca.crt tls/node-a.crt
openssl x509 -in tls/node-a.crt -noout -subject -ext subjectAltName,extendedKeyUsage -dates`}</Code>
      <Callout kind="tip" title="Common mutual TLS failures">
        A peer that cannot connect almost always has a SAN that does not match its advertise address (an IP in the config but only a DNS
        name in the certificate, or the reverse), a certificate without client-auth usage, or a different CA on one node. Check the node logs
        on both ends first.
      </Callout>
      <p>
        Certificates are read at startup, so rotation means a rolling restart. Issue certificates with a lifetime you are willing to
        rotate, and note the expiry dates in your monitoring. The node does not check a peer&apos;s node ID against its certificate.
      </p>

      <H2 id="admin">Admin access</H2>
      <p>
        With no tokens, the admin endpoints (rebalance, shutdown, backup) accept loopback connections only, judged by the connection&apos;s
        peer address. That is why the examples run <code>celeris cluster rebalance</code> inside a container or on the node itself. With
        tokens, the <code>admin</code> scope replaces the loopback rule, so operators can run admin commands remotely.
      </p>
      <Callout kind="warn">
        A reverse proxy on the same machine connects from loopback. With no tokens configured, a local proxy would make admin
        endpoints reachable to everyone who can reach the proxy. Always configure tokens when anything non-local can reach a node, and
        block <code>/v1/admin/</code> at the proxy.
      </Callout>

      <H2 id="secrets">Secrets handling</H2>
      <ul>
        <li>
          <strong>Token hashes are not raw secrets</strong>, so they may live in <code>celeris.toml</code>, in a Compose file or in a Secret. The raw
          token lives only with the client; keep it in the client&apos;s secret store.
        </li>
        <li>
          <strong>TLS private keys are the real secrets.</strong> The configuration holds only their paths. Store keys as files with mode{" "}
          <code>0600</code> owned by the service account, and never bake them into an image.
        </li>
        <li>
          <strong>Environment variables</strong> are visible to anyone who can read the process environment or a container&apos;s
          inspect output. They are fine for hashes and paths; use files for keys.
        </li>
        <li>
          <strong>Do not commit</strong> tokens, <code>*.key</code> files or the CA key. Add them to <code>.gitignore</code>.
        </li>
      </ul>
      <Code lang="bash" title="Kubernetes: keys as mounted Secrets">{`kubectl create secret generic celeris-tls \\
  --from-file=node.crt --from-file=node.key --from-file=cluster-ca.crt`}</Code>
      <Code lang="yaml" title="StatefulSet pod spec (excerpt)">{`containers:
  - name: celeris
    env:
      - { name: CELERIS_CLUSTER_TLS_CERT, value: /etc/celeris/tls/node.crt }
      - { name: CELERIS_CLUSTER_TLS_KEY,  value: /etc/celeris/tls/node.key }
      - { name: CELERIS_CLUSTER_TLS_CA,   value: /etc/celeris/tls/cluster-ca.crt }
    volumeMounts:
      - { name: tls, mountPath: /etc/celeris/tls, readOnly: true }
volumes:
  - name: tls
    secret: { secretName: celeris-tls, defaultMode: 0440 }`}</Code>
      <p>
        Every pod needs a certificate naming its own address (<code>&lt;pod&gt;.celeris-peers.&lt;namespace&gt;.svc.cluster.local</code>). Use
        cert-manager to issue them, or one certificate with a wildcard SAN for the headless service; test the wildcard against your CA
        before relying on it. The pod&apos;s <code>fsGroup</code> in the stock manifest makes mounted files readable by the service
        user.
      </p>

      <H2 id="network">Network segmentation</H2>
      <Table
        head={["Port", "Who needs it", "Rule"]}
        rows={[
          [<code key="1">8080</code>, "Clients, load balancer, Prometheus", "Allow from application subnets and the proxy only. Never the open internet."],
          [<code key="2">7000</code>, "Other nodes", "Allow from the nodes themselves only, in a private subnet or security group, even with mutual TLS."],
        ]}
      />
      <OsCode
        linux={`# ufw example: nodes at 10.0.0.1-3, application subnet 10.1.0.0/24
sudo ufw allow from 10.0.0.0/24 to any port 7000 proto tcp
sudo ufw allow from 10.1.0.0/24 to any port 8080 proto tcp
sudo ufw enable`}
        macos={`# macOS is best used for development. Bind http.listen and cluster.listen to 127.0.0.1
# or a private interface address; use the application firewall or pf for anything more.`}
        windows={`New-NetFirewallRule -DisplayName "Celeris cluster" -Direction Inbound -Protocol TCP -LocalPort 7000 -RemoteAddress 10.0.0.0/24 -Action Allow
New-NetFirewallRule -DisplayName "Celeris API" -Direction Inbound -Protocol TCP -LocalPort 8080 -RemoteAddress 10.1.0.0/24 -Action Allow`}
        title="Host firewall"
      />
      <Code lang="yaml" title="Kubernetes NetworkPolicy">{`apiVersion: networking.k8s.io/v1
kind: NetworkPolicy
metadata: { name: celeris }
spec:
  podSelector: { matchLabels: { app.kubernetes.io/name: celeris } }
  policyTypes: [Ingress]
  ingress:
    - from: [{ podSelector: { matchLabels: { app.kubernetes.io/name: celeris } } }]
      ports: [{ port: 7000 }]
    - from: [{ namespaceSelector: { matchLabels: { celeris-client: "true" } } }]
      ports: [{ port: 8080 }]`}</Code>
      <p>
        Label the namespaces that hold your applications with <code>celeris-client=true</code> (or adjust the selector), and add a rule for
        your ingress controller and Prometheus if they live elsewhere.
      </p>

      <H2 id="cors">CORS</H2>
      <p>
        CORS decides which browser origins may call the API. It is not authentication: it only affects browsers. Leave it empty if
        browsers never call the node directly.
      </p>
      <Code lang="toml">{`[http]
cors_origins = ["https://app.example.com"]   # [] disables CORS, ["*"] allows any origin`}</Code>
      <p>
        Environment form: <code>CELERIS_CORS_ORIGINS=https://app.example.com,https://admin.example.com</code>. Origins must be valid header
        values. Remember that a token embedded in browser JavaScript is visible to every user of the page: give browsers a{" "}
        <code>read</code> token at most, or route writes through your backend.
      </p>

      <H2 id="isolation">Running as non-root and container hardening</H2>
      <ul>
        <li>The official image runs as uid 10001 under <code>tini</code>, and the Kubernetes manifest sets <code>runAsNonRoot</code>. Never run the node as root.</li>
        <li>On bare metal, use a dedicated account that owns the data directory only (the systemd unit on the deployment page also restricts the filesystem and blocks privilege escalation).</li>
        <li>Both ports are above 1024, so the node needs no capabilities.</li>
      </ul>
      <Code lang="yaml" title="docker-compose.yml (per service)">{`security_opt: ["no-new-privileges:true"]
cap_drop: [ALL]
read_only: false   # test true: the data volume is the only path the node needs to write
volumes:
  - node-a:/var/lib/celeris/data`}</Code>
      <Code lang="yaml" title="Kubernetes container securityContext">{`securityContext:
  allowPrivilegeEscalation: false
  capabilities: { drop: [ALL] }
  seccompProfile: { type: RuntimeDefault }`}</Code>
      <p>
        Pin image tags, scan images in CI, and rebuild on base-image updates. Set resource limits so one node cannot starve its
        neighbours.
      </p>

      <H2 id="not-provided">What CelerisDB does not provide</H2>
      <p>These gaps are real. Plan around them rather than assuming them away.</p>
      <ul>
        <li>
          <strong>Encryption at rest.</strong> Data files are not encrypted by the database. Use volume or disk encryption (LUKS, EBS or cloud
          disk encryption, FileVault, BitLocker). Backups and exports are plain data too, so encrypt them before storing them.
        </li>
        <li>
          <strong>Per-key or per-prefix access control.</strong> Scopes are global: a token with <code>read</code> can read every key. Separate tenants
          with separate clusters, or enforce access in your application.
        </li>
        <li>
          <strong>Users, SSO or token expiry.</strong> There are no accounts or expiring tokens. Tokens are long-lived bearer secrets.
        </li>
        <li>
          <strong>Audit logging and rate limiting.</strong> Neither is built in. Use your proxy or gateway for rate limits, and log at the proxy for
          an access trail. Request bodies are capped at 40 MiB.
        </li>
        <li>
          <strong>Client certificates for the API.</strong> API TLS is server-side only; mutual TLS exists on the cluster port, not for clients.
        </li>
        <li>
          <strong>Certificate hot reload and ACME.</strong> Renewals need a restart. Terminate TLS at a proxy if you need automatic renewal.
        </li>
        <li>
          <strong>Peer identity binding.</strong> The cluster accepts any certificate from its CA. It does not check that a peer&apos;s node ID matches its certificate.
        </li>
      </ul>

      <H2 id="threat-model">Threat model summary</H2>
      <Table
        head={["Threat", "Mitigation", "Remaining risk"]}
        rows={[
          ["Stranger on the network reads or writes data", "Loopback default, tokens, firewall, TLS", "Stolen or leaked bearer tokens are valid until removed"],
          ["Eavesdropping or tampering on the wire", "API TLS and cluster mTLS", "Plain HTTP and plain cluster port are the default"],
          ["Rogue node joins the cluster", "Mutual TLS with a dedicated CA, private network", "Anyone holding a CA-signed key is a member"],
          ["Application bug or compromised client", "Least-privilege scopes, one token per client", "Scopes are global, not per key"],
          ["Stolen disk or backup", "Disk encryption, encrypted backups", "No encryption at rest in the database"],
          ["Stolen configuration file", "Only token hashes are stored", "TLS key files still need protecting"],
          ["Denial of service", "Network limits and proxy rate limits", "No built-in rate limiting"],
        ]}
      />

      <H2 id="checklist">Hardening checklist</H2>
      <ul>
        <li>Tokens enabled, one per client, with the smallest scopes. The <code>admin</code> token is held by operators only.</li>
        <li>API served over HTTPS, either by the node or by a proxy in front of it.</li>
        <li>Cluster mutual TLS on, with a CA used for nothing else and its key kept offline.</li>
        <li>Port 7000 reachable only between nodes; port 8080 reachable only from clients and the proxy; <code>/metrics</code> kept private.</li>
        <li><code>/v1/admin/</code> blocked at the proxy.</li>
        <li><code>http.cors_origins</code> empty or an explicit list, never <code>*</code> with browser-held write tokens.</li>
        <li>Runs as a non-root user; container capabilities dropped; image tag pinned.</li>
        <li>Keys stored as <code>0600</code> files or mounted Secrets, not in images or Git.</li>
        <li>Disk encryption on data volumes and backup storage.</li>
        <li>Certificate expiry and token rotation tracked, with a rolling-restart runbook.</li>
        <li><code>storage.sync = &quot;always&quot;</code> unless the data is disposable.</li>
      </ul>

      <H2 id="next">Next steps</H2>
      <ul>
        <li>
          <DocLink to="deployment">Deployment</DocLink> for proxies, services and Kubernetes manifests.
        </li>
        <li>
          <DocLink to="production-checklist">Production checklist</DocLink> for the full pre-launch review.
        </li>
        <li>
          <DocLink to="http-api">HTTP API</DocLink> and <DocLink to="errors">Errors</DocLink> for the 401 and 403 responses.
        </li>
      </ul>
    </>
  );
}

/** Computing a hash without the CLI, for scripts that already hold a token. */
function Details2() {
  return (
    <OsCode
      linux={`printf '%s' "$TOKEN" | sha256sum | cut -d' ' -f1`}
      macos={`printf '%s' "$TOKEN" | shasum -a 256 | cut -d' ' -f1`}
      windows={`$bytes = [Text.Encoding]::UTF8.GetBytes($env:TOKEN)
-join ([Security.Cryptography.SHA256]::Create().ComputeHash($bytes) | ForEach-Object { $_.ToString("x2") })`}
      title="Compute the stored hash yourself (lowercase hex SHA-256 of the token, no newline)"
    />
  );
}

export const page: DocPage = {
  slug: "security",
  title: "Security",
  group: "Operate",
  summary: "API tokens and scopes, TLS, mutual TLS between nodes, secrets, network rules, and an honest list of what is not provided.",
  keywords: [
    "authentication",
    "authorization",
    "token",
    "bearer",
    "scopes",
    "tls",
    "https",
    "mtls",
    "certificate",
    "openssl",
    "mkcert",
    "ca",
    "encryption",
    "encryption at rest",
    "cors",
    "firewall",
    "secrets",
    "kubernetes secret",
    "networkpolicy",
    "hardening",
    "threat model",
    "acl",
    "audit",
  ],
  Body,
};
