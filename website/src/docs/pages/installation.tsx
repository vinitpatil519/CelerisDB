import { Callout, Code, DocLink, Details, H2, H3, IMAGE, OsCode, OsOnly, Params, RAW, REPO, Steps, Step, Table, type DocPage } from "../kit";

const r = String.raw;

function Body() {
  return (
    <>
      <p>
        CelerisDB ships as one executable, <code>celeris</code>, which both runs a node and operates it (<code>put</code>,{" "}
        <code>get</code>, <code>status</code>, <code>backup</code> and so on). Pick whichever install path suits you; they
        all produce the same program.
      </p>
      <Table
        head={["Path", "Best for", "Platforms"]}
        rows={[
          ["Install script", "Trying it, laptops, simple servers", "Linux, macOS, Windows x64"],
          ["Release binary", "Air-gapped hosts, pinned versions, packaging", "Linux, macOS, Windows x64"],
          ["Docker image", "Containers, Kubernetes", "Anything Docker runs"],
          ["Docker Compose", "A 3-node cluster on one machine", "Anything Docker runs"],
          ["Build from source", "Contributing, unreleased changes", "Linux, macOS, Windows"],
        ]}
      />

      <H2 id="install-script">Install script</H2>
      <p>
        The scripts download the latest release for your platform, verify its SHA-256 checksum and put the binary in a
        per-user directory. They never need administrator rights.
      </p>
      <OsCode
        title="Install the latest release"
        linux={`curl -fsSL ${RAW}/install.sh | sh`}
        macos={`curl -fsSL ${RAW}/install.sh | sh`}
        windows={`irm ${RAW}/install.ps1 | iex`}
      />
      <H3 id="script-details">What the script does</H3>
      <OsOnly>
        {{
          linux: (
            <ul>
              <li>
                Requires <code>curl</code>, <code>tar</code> and <code>uname</code>. It supports Linux on x86_64 and
                aarch64 (the release target is <code>*-unknown-linux-gnu</code>).
              </li>
              <li>
                Downloads <code>celeris-&lt;target&gt;.tar.gz</code> and its <code>.sha256</code> file from the GitHub
                release, and stops with an error if the checksum does not match.
              </li>
              <li>
                Installs the binary as <code>~/.local/bin/celeris</code> with mode 0755, and tells you to add that
                directory to <code>PATH</code> if it is not already there.
              </li>
            </ul>
          ),
          macos: (
            <ul>
              <li>
                Requires <code>curl</code>, <code>tar</code> and <code>uname</code>, all present on macOS. It supports
                Intel (x86_64) and Apple silicon (aarch64); the release target is <code>*-apple-darwin</code>.
              </li>
              <li>
                Downloads <code>celeris-&lt;target&gt;.tar.gz</code> and its <code>.sha256</code> file from the GitHub
                release, and stops with an error if the checksum does not match (it uses <code>shasum -a 256</code>{" "}
                when <code>sha256sum</code> is absent).
              </li>
              <li>
                Installs the binary as <code>~/.local/bin/celeris</code> and tells you to add that directory to{" "}
                <code>PATH</code> if it is not already there.
              </li>
            </ul>
          ),
          windows: (
            <ul>
              <li>
                Needs a 64-bit Windows. It downloads <code>celeris-x86_64-pc-windows-msvc.zip</code> and its{" "}
                <code>.sha256</code> file and stops if the checksum does not match.
              </li>
              <li>
                Copies <code>celeris.exe</code> to <code>%LOCALAPPDATA%\Programs\Celeris</code>.
              </li>
              <li>
                Adds that directory to your <em>user</em> <code>PATH</code> if missing. Open a new terminal to pick it
                up.
              </li>
            </ul>
          ),
        }}
      </OsOnly>
      <Params
        rows={[
          {
            name: "CELERIS_VERSION",
            type: "string",
            def: "latest",
            desc: (
              <>
                A release tag such as <code>v0.1.0</code> to install instead of the latest.
              </>
            ),
          },
          {
            name: "CELERIS_INSTALL_DIR",
            type: "path",
            def: "~/.local/bin  |  %LOCALAPPDATA%\\Programs\\Celeris",
            desc: "Directory to put the binary in. It is created if missing.",
          },
        ]}
      />
      <OsCode
        title="Pin a version and choose a directory"
        linux={`curl -fsSL ${RAW}/install.sh | CELERIS_VERSION=v0.1.0 CELERIS_INSTALL_DIR=/usr/local/bin sh`}
        macos={`curl -fsSL ${RAW}/install.sh | CELERIS_VERSION=v0.1.0 CELERIS_INSTALL_DIR="$HOME/bin" sh`}
        windows={r`$env:CELERIS_VERSION = 'v0.1.0'
$env:CELERIS_INSTALL_DIR = 'C:\Tools\Celeris'
irm ${RAW}/install.ps1 | iex`}
      />
      <Callout kind="tip" title="Read before you pipe">
        Piping a script into a shell runs it immediately. If you prefer to inspect it first, download{" "}
        <a href={`${RAW}/install.sh`}>install.sh</a> or <a href={`${RAW}/install.ps1`}>install.ps1</a>, read it (it is
        short), then run the local copy. Installing to <code>/usr/local/bin</code> as shown above needs{" "}
        <code>sudo</code> on most systems.
      </Callout>

      <H2 id="release-binaries">Prebuilt release binaries</H2>
      <p>
        Every version tag publishes archives on the <a href={`${REPO}/releases`}>GitHub releases page</a>, each with a
        matching <code>.sha256</code> file.
      </p>
      <Table
        head={["Platform", "Asset"]}
        rows={[
          ["Linux x86_64", <code key="a">celeris-x86_64-unknown-linux-gnu.tar.gz</code>],
          ["Linux aarch64", <code key="b">celeris-aarch64-unknown-linux-gnu.tar.gz</code>],
          ["macOS Intel", <code key="c">celeris-x86_64-apple-darwin.tar.gz</code>],
          ["macOS Apple silicon", <code key="d">celeris-aarch64-apple-darwin.tar.gz</code>],
          ["Windows x64", <code key="e">celeris-x86_64-pc-windows-msvc.zip</code>],
        ]}
      />
      <p>Each archive contains a folder named after the asset, holding the binary and the README.</p>
      <OsCode
        title="Download, verify and install by hand (example: v0.1.0)"
        linux={`V=v0.1.0
T=x86_64-unknown-linux-gnu   # or aarch64-unknown-linux-gnu
curl -fsSLO ${REPO}/releases/download/$V/celeris-$T.tar.gz
curl -fsSLO ${REPO}/releases/download/$V/celeris-$T.tar.gz.sha256
echo "$(cut -d ' ' -f 1 celeris-$T.tar.gz.sha256)  celeris-$T.tar.gz" | sha256sum -c -
tar xzf celeris-$T.tar.gz
sudo install -m 0755 celeris-$T/celeris /usr/local/bin/celeris`}
        macos={`V=v0.1.0
T=aarch64-apple-darwin   # or x86_64-apple-darwin
curl -fsSLO ${REPO}/releases/download/$V/celeris-$T.tar.gz
curl -fsSLO ${REPO}/releases/download/$V/celeris-$T.tar.gz.sha256
echo "$(cut -d ' ' -f 1 celeris-$T.tar.gz.sha256)  celeris-$T.tar.gz" | shasum -a 256 -c -
tar xzf celeris-$T.tar.gz
sudo install -m 0755 celeris-$T/celeris /usr/local/bin/celeris`}
        windows={r`$v = 'v0.1.0'
$t = 'x86_64-pc-windows-msvc'
$base = "${REPO}/releases/download/$v"
Invoke-WebRequest "$base/celeris-$t.zip" -OutFile "celeris-$t.zip"
Invoke-WebRequest "$base/celeris-$t.zip.sha256" -OutFile "celeris-$t.zip.sha256"
$expected = ((Get-Content "celeris-$t.zip.sha256" -Raw).Trim() -split '\s+')[0].ToLower()
if ((Get-FileHash "celeris-$t.zip" -Algorithm SHA256).Hash.ToLower() -ne $expected) { throw 'checksum mismatch' }
Expand-Archive "celeris-$t.zip" -DestinationPath .
New-Item -ItemType Directory C:\Tools\Celeris -Force | Out-Null
Copy-Item "celeris-$t\celeris.exe" C:\Tools\Celeris\celeris.exe`}
      />

      <H2 id="docker">Docker image</H2>
      <p>
        The container image is <code>{IMAGE}</code>, published when a version tag is pushed. It runs as an unprivileged
        user (uid 10001) under <code>tini</code>, listens on <code>0.0.0.0:8080</code> inside the container, logs JSON,
        and keeps its data in the volume <code>/var/lib/celeris/data</code>.
      </p>
      <OsCode
        title="Run a single node"
        linux={`docker run -d --name celeris \\
  -p 127.0.0.1:8080:8080 \\
  -v celeris-data:/var/lib/celeris/data \\
  ${IMAGE}`}
        macos={`docker run -d --name celeris \\
  -p 127.0.0.1:8080:8080 \\
  -v celeris-data:/var/lib/celeris/data \\
  ${IMAGE}`}
        windows={r`docker run -d --name celeris `+"`"+r`
  -p 127.0.0.1:8080:8080 `+"`"+r`
  -v celeris-data:/var/lib/celeris/data `+"`"+r`
  ${IMAGE}`}
      />
      <p>
        Binding the published port to <code>127.0.0.1</code> keeps the node private to your machine. Without any
        configured tokens the API accepts every request, so only expose it more widely after reading{" "}
        <DocLink to="security">Security</DocLink>. Configure the container with <code>CELERIS_*</code> environment
        variables (<code>-e CELERIS_SYNC=always</code>) or mount a <code>celeris.toml</code> and start it with{" "}
        <code>celeris start --config /path/celeris.toml</code>; see <DocLink to="configuration">Configuration</DocLink>.
      </p>
      <Code lang="bash" title="Build the image yourself (any OS)">{`git clone ${REPO}.git
cd CelerisDB
docker build -t celeris .`}</Code>

      <H2 id="docker-compose">Docker Compose: a three-node cluster</H2>
      <p>
        The repository includes a <code>docker-compose.yml</code> that starts three voters (<code>node-a</code>,{" "}
        <code>node-b</code>, <code>node-c</code>) in three zones, with the APIs on host ports <code>8081</code>,{" "}
        <code>8082</code> and <code>8083</code>. Each node has its own named volume.
      </p>
      <OsCode
        unix={`git clone ${REPO}.git
cd CelerisDB
docker compose up -d --build`}
        windows={`git clone ${REPO}.git
cd CelerisDB
docker compose up -d --build`}
      />
      <p>
        <code>docker compose down</code> keeps the data; <code>docker compose down -v</code> erases it. The{" "}
        <DocLink to="quickstart:cluster">Quickstart</DocLink> uses this cluster for a failover experiment.
      </p>

      <H2 id="from-source">Build from source</H2>
      <p>
        You need Rust 1.89 or newer (<a href="https://rustup.rs">rustup</a> is the easiest way to get it) and Git.
      </p>
      <OsCode
        unix={`git clone ${REPO}.git
cd CelerisDB
cargo build --release -p celeris-cli
./target/release/celeris --version`}
        windows={`git clone ${REPO}.git
cd CelerisDB
cargo build --release -p celeris-cli
.\\target\\release\\celeris.exe --version`}
      />
      <p>
        To put the binary on your <code>PATH</code> in one step, run{" "}
        <code>cargo install --path crates/celeris-cli --locked</code> from the repository root.
      </p>
      <H3 id="windows-toolchains">Windows: MSVC or GNU toolchain</H3>
      <ul>
        <li>
          <strong>MSVC (<code>x86_64-pc-windows-msvc</code>)</strong> works out of the box once Visual Studio Build
          Tools are installed. This is also the toolchain the official Windows release is built with, so prefer it.
        </li>
        <li>
          <strong>GNU (<code>x86_64-pc-windows-gnu</code>)</strong> needs a 64-bit mingw-w64, for example{" "}
          <code>winget install BrechtSanders.WinLibs.POSIX.UCRT</code>. Put its <code>bin</code> directory{" "}
          <em>before</em> any older 32-bit MinGW on your <code>PATH</code>, or the link step fails.
        </li>
      </ul>
      <Details summary="Run the test suite (contributors)">
        <Code lang="bash">{`cargo test --workspace
cargo clippy --workspace --all-targets -- -D warnings
cargo fmt --all -- --check`}</Code>
      </Details>

      <H2 id="verify">Verify the install</H2>
      <p>
        <code>celeris --version</code> prints the version. <code>celeris doctor</code> checks your configuration file,
        that the data directory is writable, that the storage is not locked by another process, that the listen port is
        free, and, if a node is running, that it answers <code>/health</code> and <code>/ready</code>.
      </p>
      <Code lang="bash">{`celeris --version
celeris doctor`}</Code>
      <Code lang="text" title="Example output (yours will differ)">{`[info] platform: linux x86_64 (celeris 0.1.0)
[info] config: celeris.toml not found; checking defaults
[ ok ] data directory: celeris-data is writable
[info] storage: not initialised yet (created on first start)
[ ok ] listen address: 127.0.0.1:8080 is available
[info] node: no node reachable at http://127.0.0.1:8080 (...)`}</Code>
      <p>
        Lines start with <code>[ ok ]</code>, <code>[info]</code> or <code>[FAIL]</code>, and the command exits non-zero if
        any check fails. A <code>[info]</code> line about no reachable node is normal before you have started one.
      </p>

      <H2 id="ports">Ports to open</H2>
      <Table
        head={["Port", "Purpose", "Expose to"]}
        rows={[
          [<code key="p">8080</code>, "HTTP/JSON API, WebSocket change streams, /metrics, /health, /ready", "Clients, your load balancer, Prometheus"],
          [<code key="q">7000</code>, "Node-to-node: gossip, Raft, snapshots, data movement", "Other nodes only"],
        ]}
      />
      <p>
        A single node needs only <code>8080</code>, and by default it listens on <code>127.0.0.1</code> so nothing leaves
        the machine. Set <code>http.listen = &quot;0.0.0.0:8080&quot;</code> (or <code>CELERIS_HTTP_LISTEN</code>) to accept
        remote clients. The cluster port is only active when <code>cluster.listen</code> is set. Keep it on a private
        network: it should be reachable by the other nodes and nobody else.
      </p>
      <OsCode
        title="Open the API port on the host firewall (example)"
        linux={`# ufw
sudo ufw allow 8080/tcp
# firewalld
sudo firewall-cmd --permanent --add-port=8080/tcp && sudo firewall-cmd --reload`}
        macos={`# macOS prompts to allow incoming connections the first time a non-loopback
# listener starts. To pre-approve the binary:
sudo /usr/libexec/ApplicationFirewall/socketfilterfw --add "$(command -v celeris)"
sudo /usr/libexec/ApplicationFirewall/socketfilterfw --unblockapp "$(command -v celeris)"`}
        windows={`New-NetFirewallRule -DisplayName "CelerisDB API" -Direction Inbound -Protocol TCP -LocalPort 8080 -Action Allow`}
      />

      <H2 id="service">Run it as a service</H2>
      <Callout kind="warn" title="Examples, not shipped files">
        CelerisDB does not ship a service definition. The units below are examples to adapt: check the paths, the user,
        and the limits against your own layout. Test a restart and a reboot before you rely on them.
      </Callout>
      <p>
        The node shuts down gracefully when it receives Ctrl-C (SIGINT) or when you run <code>celeris stop</code>, so the
        examples use those paths where the service manager lets them.
      </p>
      <OsCode
        title="Service definition (example)"
        linux={`# 1. a dedicated user and directories
sudo useradd --system --home-dir /var/lib/celeris --create-home celeris
sudo install -m 0755 "$(command -v celeris)" /usr/local/bin/celeris
sudo mkdir -p /etc/celeris /var/lib/celeris/data
sudo chown celeris: /var/lib/celeris/data
sudo celeris init --dir /etc/celeris --listen 0.0.0.0:8080

# 2. /etc/systemd/system/celeris.service
sudo tee /etc/systemd/system/celeris.service >/dev/null <<'EOF'
[Unit]
Description=CelerisDB node
After=network-online.target
Wants=network-online.target

[Service]
User=celeris
Environment=CELERIS_DATA_DIR=/var/lib/celeris/data
ExecStart=/usr/local/bin/celeris start --config /etc/celeris/celeris.toml
# The node stops gracefully on SIGINT (same as Ctrl-C).
KillSignal=SIGINT
TimeoutStopSec=60
Restart=always
RestartSec=2
LimitNOFILE=65536

[Install]
WantedBy=multi-user.target
EOF

# 3. start it
sudo systemctl daemon-reload
sudo systemctl enable --now celeris
journalctl -u celeris -f`}
        macos={`# ~/Library/LaunchAgents/com.celerisdb.node.plist  (runs while you are logged in)
mkdir -p ~/Library/LaunchAgents ~/celeris/data
celeris init --dir ~/celeris
cat > ~/Library/LaunchAgents/com.celerisdb.node.plist <<EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>com.celerisdb.node</string>
  <key>ProgramArguments</key>
  <array>
    <string>$HOME/.local/bin/celeris</string>
    <string>start</string>
    <string>--config</string>
    <string>$HOME/celeris/celeris.toml</string>
  </array>
  <key>EnvironmentVariables</key>
  <dict>
    <key>CELERIS_DATA_DIR</key><string>$HOME/celeris/data</string>
  </dict>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
  <key>StandardErrorPath</key><string>$HOME/celeris/celeris.log</string>
</dict>
</plist>
EOF
launchctl bootstrap gui/$(id -u) ~/Library/LaunchAgents/com.celerisdb.node.plist
# stop and remove:
# launchctl bootout gui/$(id -u)/com.celerisdb.node`}
        windows={r`# Option A: NSSM (https://nssm.cc), a service wrapper. Run in an elevated PowerShell.
New-Item -ItemType Directory C:\celeris\data -Force | Out-Null
celeris init --dir C:\celeris
nssm install CelerisDB "$env:LOCALAPPDATA\Programs\Celeris\celeris.exe" start --config C:\celeris\celeris.toml
nssm set CelerisDB AppDirectory C:\celeris
nssm set CelerisDB AppEnvironmentExtra CELERIS_DATA_DIR=C:\celeris\data
nssm set CelerisDB AppStderr C:\celeris\celeris.log
nssm start CelerisDB

# Option B: Task Scheduler, no extra software. Runs at logon.
$action = New-ScheduledTaskAction -Execute "$env:LOCALAPPDATA\Programs\Celeris\celeris.exe" ` + "`" + r`
  -Argument "start --config C:\celeris\celeris.toml" -WorkingDirectory C:\celeris
$trigger = New-ScheduledTaskTrigger -AtLogOn
Register-ScheduledTask -TaskName CelerisDB -Action $action -Trigger $trigger
Start-ScheduledTask -TaskName CelerisDB`}
      />
      <p>
        On Windows, if you register the service under a different account than the one that installed the binary, use
        an absolute path to <code>celeris.exe</code> instead of <code>%LOCALAPPDATA%</code>, which is per user.
      </p>

      <H2 id="upgrade">Upgrade</H2>
      <p>
        Take a backup first (see <DocLink to="backup-restore">Backup and restore</DocLink>), stop the node, replace the
        binary and start it again. Re-running the install script replaces the binary in place.
      </p>
      <OsCode
        title="Upgrade a single node"
        linux={`celeris backup --out before-upgrade.backup
celeris stop
curl -fsSL ${RAW}/install.sh | sh
celeris --version
celeris start`}
        macos={`celeris backup --out before-upgrade.backup
celeris stop
curl -fsSL ${RAW}/install.sh | sh
celeris --version
celeris start`}
        windows={`celeris backup --out before-upgrade.backup
celeris stop
irm ${RAW}/install.ps1 | iex
celeris --version
celeris start`}
      />
      <p>
        For a cluster, upgrade one node at a time and wait until <code>celeris status</code> reports it healthy before
        moving to the next, so a majority of every replica set stays available throughout. CelerisDB is pre-1.0, so read
        the release notes for each version before upgrading and test the new version on a copy of your data first.
        Docker users pull a new tag and recreate the container; the data volume is preserved.
      </p>

      <H2 id="uninstall">Uninstall</H2>
      <Steps>
        <Step title="Stop the node and any service">
          <OsCode
            linux={`celeris stop
sudo systemctl disable --now celeris   # only if you installed the unit above`}
            macos={`celeris stop
launchctl bootout gui/$(id -u)/com.celerisdb.node   # only if you installed the plist above`}
            windows={`celeris stop
nssm remove CelerisDB confirm                # only if you used NSSM
Unregister-ScheduledTask CelerisDB -Confirm:$false   # only if you used Task Scheduler`}
          />
        </Step>
        <Step title="Remove the binary">
          <OsCode
            linux={`rm -f ~/.local/bin/celeris        # or /usr/local/bin/celeris`}
            macos={`rm -f ~/.local/bin/celeris        # or /usr/local/bin/celeris`}
            windows={r`Remove-Item "$env:LOCALAPPDATA\Programs\Celeris" -Recurse -Force
# then remove that folder from your user PATH (System settings > Environment variables)`}
          />
        </Step>
        <Step title="Delete the data (optional, irreversible)">
          <p>
            The data lives in the <code>node.data_dir</code> you configured (<code>celeris-data</code> next to{" "}
            <code>celeris.toml</code> by default). For Docker, <code>docker volume rm celeris-data</code>, or{" "}
            <code>docker compose down -v</code> for the compose cluster. Export or back up anything you want to keep
            first.
          </p>
        </Step>
      </Steps>

      <H2 id="next">Next steps</H2>
      <ul>
        <li>
          <DocLink to="quickstart">Quickstart</DocLink>: write and read your first data.
        </li>
        <li>
          <DocLink to="configuration">Configuration</DocLink>: every setting and environment variable.
        </li>
        <li>
          <DocLink to="production-checklist">Production checklist</DocLink> before you put real traffic on it.
        </li>
        <li>
          <DocLink to="troubleshooting">Troubleshooting</DocLink> if something does not start.
        </li>
      </ul>
    </>
  );
}

export const page: DocPage = {
  slug: "installation",
  title: "Installation",
  group: "Get started",
  summary: "Install CelerisDB on Linux, macOS or Windows: script, release binary, Docker, Compose or from source, plus running it as a service.",
  keywords: ["install", "download", "setup", "docker", "compose", "build from source", "cargo", "systemd", "launchd", "nssm", "windows service", "upgrade", "uninstall", "ports", "doctor", "version"],
  Body,
};
