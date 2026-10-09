import { Callout, Code, DocLink, H2, H3, OsCode, Steps, Step, Table, Tabs } from "../kit";
import type { DocPage } from "../kit";

function Body() {
  return (
    <>
      <p>
        CelerisDB has two backup tools, built for two different jobs. A <strong>physical backup</strong> is a binary snapshot
        of a single node that restores with exact versions. A <strong>logical export</strong> writes every key as JSON lines
        through the public API, works on any node or cluster, and loads back with an idempotent import. This page covers both,
        how to schedule and ship them, how to verify and rehearse a restore, and what to do in the common disaster scenarios.
      </p>

      <H2 id="choose">Which one do I use?</H2>
      <Table
        head={["", "backup / restore", "export / import"]}
        rows={[
          ["Form", "Binary engine snapshot", "JSON lines: key, value, expires_at_ms"],
          ["Works on", "Single-node mode only (the endpoint answers 501 in a replicated cluster)", "Any node or cluster, over HTTP or HTTPS, with tokens"],
          ["Versions", "Kept exactly", "Reassigned on import"],
          ["Consistency", "A consistent cut at one point; writes after it starts are excluded", "Pages through scan; not a point-in-time snapshot of the whole keyspace"],
          ["Restore", "Offline, into an empty data directory", "Online, through the API; safe to re-run"],
          ["Token scope", "admin", "read to export, write to import"],
        ]}
      />
      <Callout kind="warn" title="Clusters use exports">
        <p>
          In a replicated cluster each replica set has its own log and placement, so a per-node snapshot cannot be restored
          on its own. The physical backup endpoint refuses with <code>501 not_supported</code> instead of producing a file
          you could not use. Incremental backups, point-in-time recovery and a coordinated cluster-wide physical snapshot do
          not exist yet.
        </p>
      </Callout>

      <H2 id="physical">Physical backup and restore (single node)</H2>
      <p>
        <code>celeris backup</code> streams a consistent snapshot from the running node: it holds every write acknowledged
        before the command started and nothing torn. The node keeps serving while it runs. The file is written to a temporary
        name and renamed when complete, so you never see a half-written backup under the final name.
      </p>
      <Steps>
        <Step title="Take the backup">
          <OsCode
            unix={`celeris backup --out /var/backups/celeris/celeris.backup
# backup     /var/backups/celeris/celeris.backup (<bytes> bytes, consistent at version <n>)`}
            windows={`celeris backup --out C:\\celeris\\backups\\celeris.backup`}
            title="Back up a running node"
          />
          <p>
            With API tokens enabled the endpoint needs the <code>admin</code> scope, so pass{" "}
            <code>--token</code> (or set <code>CELERIS_TOKEN</code>). Without tokens, admin endpoints accept loopback
            connections only, so run the command on the node itself.
          </p>
        </Step>
        <Step title="Stop the node and move the old data aside">
          <OsCode
            linux={`celeris stop
mv celeris-data celeris-data.old`}
            macos={`celeris stop
mv celeris-data celeris-data.old`}
            windows={`celeris stop
Rename-Item celeris-data celeris-data.old`}
            title="Make room for an empty data directory"
          />
          <p>
            Restore refuses a non-empty storage directory, so it can never mix a backup with old state.
          </p>
        </Step>
        <Step title="Restore">
          <OsCode
            unix={`celeris restore --from /var/backups/celeris/celeris.backup --config celeris.toml
# restored   ... into celeris-data/storage (last version <n>)`}
            windows={`celeris restore --from C:\\celeris\\backups\\celeris.backup --config celeris.toml`}
            title="Rebuild the storage directory"
          />
          <p>
            The target directory comes from the configuration (the file plus any <code>CELERIS_*</code> variables). The
            restored data has the same versions as the original, so compare-and-set callers keep working.
          </p>
        </Step>
        <Step title="Start and check">
          <OsCode
            unix={`celeris start --config celeris.toml &
celeris status`}
            windows={`Start-Process celeris -ArgumentList "start","--config","celeris.toml"
celeris status`}
            title="Bring the node back"
          />
        </Step>
      </Steps>

      <H2 id="logical">Logical export and import (clusters)</H2>
      <p>
        <code>celeris export</code> reads every key through <code>GET /v1/scan</code> and writes one JSON object per line. It
        refuses to finish if a replica set did not answer, rather than writing an incomplete file, and it writes to a
        temporary <code>.partial</code> file that is renamed on success.
      </p>
      <OsCode
        unix={`# whole keyspace, strict reads (the default)
celeris export --out all.jsonl

# only one prefix
celeris export --out orders.jsonl --prefix orders/

# against a remote cluster with a read token
celeris --addr https://db.example.com:8080 --token "$CELERIS_TOKEN" export --out all.jsonl`}
        windows={`celeris export --out all.jsonl
celeris export --out orders.jsonl --prefix orders/
celeris --addr https://db.example.com:8080 --token $env:CELERIS_TOKEN export --out all.jsonl`}
        title="Export"
      />
      <Code lang="json" title="One line of an export">{`{"key":"users/42","value":{"name":"Vinit"},"expires_at_ms":null}`}</Code>
      <p>
        <code>celeris import</code> loads an export into any node or cluster, with a <code>write</code>-scoped token if
        authentication is on. It sends each batch with a mutation ID derived from the batch&apos;s lines, so running the same
        import again skips what was already applied and reports it (<code>N already imported</code>). Keys that expired since
        the export are skipped, and the others keep their absolute expiry time.
      </p>
      <OsCode
        unix={`celeris import --from all.jsonl

# tune it
celeris import --from all.jsonl --batch-size 200 --threads 8

# into another cluster
celeris --addr https://other.example.com:8080 --token "$CELERIS_TOKEN" import --from all.jsonl`}
        windows={`celeris import --from all.jsonl
celeris import --from all.jsonl --batch-size 200 --threads 8
celeris --addr https://other.example.com:8080 --token $env:CELERIS_TOKEN import --from all.jsonl`}
        title="Import (safe to re-run)"
      />
      <ul>
        <li>
          Versions are reassigned on import, so callers holding old <code>if_version</code> values must re-read.
        </li>
        <li>
          In a cluster, a batch whose keys span replica sets is written key by key in parallel (<code>--threads</code>),
          each with its own content-derived ID, so it stays idempotent.
        </li>
        <li>
          The import reads the whole file before sending, so plan memory for the file size. Decompress a compressed export
          first.
        </li>
        <li>
          If an import fails or the outcome of a batch is unknown, fix the cause and re-run the same command.
        </li>
      </ul>
      <Callout kind="note">
        <p>
          An export pages through a scan, and a scan is not a point-in-time snapshot. Writes made while the export runs may
          or may not be in the file. For a clean cut, export during a quiet period or pause writers briefly.
        </p>
      </Callout>

      <H2 id="scheduling">Scheduling backups</H2>
      <p>
        Wrap the command in a small script that names the file with a timestamp, records a checksum and removes old files, then
        run the script on a schedule. The scripts below take a physical backup; replace the <code>celeris backup</code> line
        with <code>celeris export --out ...</code> for a cluster.
      </p>
      <OsCode
        linux={`#!/usr/bin/env bash
# /usr/local/bin/celeris-backup.sh
set -euo pipefail
dir=/var/backups/celeris
mkdir -p "$dir"
out="$dir/celeris-$(date +%Y%m%d-%H%M%S).backup"
celeris backup --out "$out"
sha256sum "$out" > "$out.sha256"
find "$dir" -name 'celeris-*' -mtime +14 -delete`}
        macos={`#!/usr/bin/env bash
# /usr/local/bin/celeris-backup.sh
set -euo pipefail
dir="$HOME/celeris-backups"
mkdir -p "$dir"
out="$dir/celeris-$(date +%Y%m%d-%H%M%S).backup"
celeris backup --out "$out"
shasum -a 256 "$out" > "$out.sha256"
find "$dir" -name 'celeris-*' -mtime +14 -delete`}
        windows={`# C:\\celeris\\backup.ps1
$ErrorActionPreference = "Stop"
$dir = "C:\\celeris\\backups"
New-Item -ItemType Directory -Force $dir | Out-Null
$out = Join-Path $dir ("celeris-" + (Get-Date -Format "yyyyMMdd-HHmmss") + ".backup")
celeris backup --out $out
if ($LASTEXITCODE -ne 0) { throw "celeris backup failed" }
$hash = (Get-FileHash $out -Algorithm SHA256).Hash.ToLower()
"$hash  $(Split-Path $out -Leaf)" | Set-Content "$out.sha256"
Get-ChildItem $dir -Filter "celeris-*" | Where-Object { $_.LastWriteTime -lt (Get-Date).AddDays(-14) } | Remove-Item`}
        title="Backup script"
      />
      <Tabs
        group="backup-scheduler"
        items={[
          {
            id: "cron",
            label: "cron (Linux, macOS)",
            content: (
              <Code lang="bash" title="crontab -e" flush>{`# every day at 02:00
0 2 * * * /usr/local/bin/celeris-backup.sh >> /var/log/celeris-backup.log 2>&1`}</Code>
            ),
          },
          {
            id: "systemd",
            label: "systemd timer (Linux)",
            content: (
              <>
                <Code lang="text" title="/etc/systemd/system/celeris-backup.service" flush>{`[Unit]
Description=CelerisDB backup

[Service]
Type=oneshot
ExecStart=/usr/local/bin/celeris-backup.sh`}</Code>
                <Code lang="text" title="/etc/systemd/system/celeris-backup.timer">{`[Unit]
Description=Daily CelerisDB backup

[Timer]
OnCalendar=*-*-* 02:00:00
Persistent=true

[Install]
WantedBy=timers.target`}</Code>
                <Code lang="bash">{`sudo systemctl daemon-reload
sudo systemctl enable --now celeris-backup.timer
systemctl list-timers celeris-backup.timer`}</Code>
              </>
            ),
          },
          {
            id: "windows",
            label: "Task Scheduler (Windows)",
            content: (
              <Code lang="powershell" title="Run once in an elevated PowerShell" flush>{`$action  = New-ScheduledTaskAction -Execute "powershell.exe" -Argument "-NoProfile -ExecutionPolicy Bypass -File C:\\celeris\\backup.ps1"
$trigger = New-ScheduledTaskTrigger -Daily -At 2:00am
Register-ScheduledTask -TaskName "CelerisBackup" -Action $action -Trigger $trigger -User "SYSTEM" -RunLevel Highest

# run it now to test
Start-ScheduledTask -TaskName "CelerisBackup"
Get-ScheduledTaskInfo -TaskName "CelerisBackup"`}</Code>
            ),
          },
        ]}
      />
      <p>
        If authentication is on, give the scheduled job a token through its environment (<code>CELERIS_TOKEN</code>) from your
        secret store. Create a dedicated token for backups with only the scope it needs.
      </p>

      <H2 id="offsite">Shipping backups off the machine</H2>
      <p>
        A backup on the same disk as the data protects against mistakes, not against losing the machine. Copy files to storage
        in another failure domain with whatever tool you already use. Enable versioning or object lock on the bucket if you
        want protection against accidental deletion.
      </p>
      <Tabs
        group="backup-cloud"
        items={[
          {
            id: "s3",
            label: "AWS S3",
            content: (
              <Code lang="bash" title="aws cli" flush>{`aws s3 cp celeris-20261008-020000.backup s3://my-bucket/celeris/
aws s3 cp celeris-20261008-020000.backup.sha256 s3://my-bucket/celeris/`}</Code>
            ),
          },
          {
            id: "gcs",
            label: "Google Cloud Storage",
            content: (
              <Code lang="bash" title="gcloud" flush>{`gcloud storage cp celeris-20261008-020000.backup gs://my-bucket/celeris/
gcloud storage cp celeris-20261008-020000.backup.sha256 gs://my-bucket/celeris/`}</Code>
            ),
          },
          {
            id: "azure",
            label: "Azure Blob Storage",
            content: (
              <Code lang="bash" title="az cli" flush>{`az storage blob upload --account-name myaccount --container-name celeris \\
  --name celeris-20261008-020000.backup --file celeris-20261008-020000.backup --auth-mode login`}</Code>
            ),
          },
        ]}
      />
      <p>
        Add the upload as the last line of your backup script, and make the script fail loudly if the upload fails. On Windows,
        use the same commands from PowerShell with Windows paths. These are the cloud providers&apos; own tools; CelerisDB
        does not integrate with them directly.
      </p>

      <H2 id="verifying">Verifying a backup</H2>
      <p>
        A backup you have never restored is a hope, not a backup. Verify in layers:
      </p>
      <ol>
        <li>
          <strong>The command succeeded.</strong> <code>celeris backup</code> prints the size and the version it is consistent
          at. A non-zero exit code means no file was produced.
        </li>
        <li>
          <strong>The file is intact.</strong> Compare the checksum recorded at creation with the one of the copy you stored.
        </li>
        <li>
          <strong>It restores.</strong> Restore into a scratch directory and start a throwaway node on another port, then read
          some known keys.
        </li>
      </ol>
      <OsCode
        linux={`sha256sum -c celeris-20261008-020000.backup.sha256

# restore into a scratch directory and start a throwaway node
export CELERIS_DATA_DIR=/tmp/celeris-verify
celeris restore --from celeris-20261008-020000.backup
CELERIS_HTTP_LISTEN=127.0.0.1:18080 celeris start &
celeris --addr http://127.0.0.1:18080 status
celeris --addr http://127.0.0.1:18080 get users/42
celeris --addr http://127.0.0.1:18080 stop`}
        macos={`shasum -a 256 -c celeris-20261008-020000.backup.sha256

export CELERIS_DATA_DIR=/tmp/celeris-verify
celeris restore --from celeris-20261008-020000.backup
CELERIS_HTTP_LISTEN=127.0.0.1:18080 celeris start &
celeris --addr http://127.0.0.1:18080 status
celeris --addr http://127.0.0.1:18080 get users/42
celeris --addr http://127.0.0.1:18080 stop`}
        windows={`Get-FileHash .\\celeris-20261008-020000.backup -Algorithm SHA256   # compare with the .sha256 file

$env:CELERIS_DATA_DIR = "$env:TEMP\\celeris-verify"
celeris restore --from .\\celeris-20261008-020000.backup
$env:CELERIS_HTTP_LISTEN = "127.0.0.1:18080"
Start-Process celeris -ArgumentList "start"
celeris --addr http://127.0.0.1:18080 status
celeris --addr http://127.0.0.1:18080 get users/42
celeris --addr http://127.0.0.1:18080 stop`}
        title="Verify a physical backup"
      />
      <p>
        If a <code>celeris.toml</code> is in the current directory the commands load it first, and the environment variables
        override it. For an export, check that every line parses and that the count matches what the command printed:
      </p>
      <OsCode
        unix={`wc -l all.jsonl
jq -c . all.jsonl > /dev/null && echo "all lines are valid JSON"`}
        windows={`(Get-Content all.jsonl | Measure-Object -Line).Lines
Get-Content all.jsonl | ForEach-Object { $null = $_ | ConvertFrom-Json }; "all lines are valid JSON"`}
        title="Verify an export"
      />

      <H2 id="drills">Restore drills</H2>
      <p>Run a drill after setting up backups and on a regular schedule afterwards. Each drill should answer: does it restore, how long does it take, and is the data what we expect?</p>
      <Steps>
        <Step title="Pick a recent backup from your off-site storage">
          <p>Use the stored copy, not the local one, so you test the whole path.</p>
        </Step>
        <Step title="Restore into an isolated environment">
          <p>
            A scratch machine or container, or a scratch directory and a different port as shown above. Never restore over a
            production data directory during a drill.
          </p>
        </Step>
        <Step title="Time it and check the contents">
          <p>
            Record the time from download to a node answering reads. Compare a few known keys, a prefix scan count, and the
            version printed by <code>celeris restore</code>.
          </p>
        </Step>
        <Step title="Write down what you learned">
          <p>Update the runbook: commands, who has the tokens, how long it took, and what surprised you.</p>
        </Step>
      </Steps>

      <H2 id="rpo-rto">RPO and RTO</H2>
      <ul>
        <li>
          <strong>Recovery point objective (how much data you can lose).</strong> It is the time since the last good backup,
          because there are no incremental backups and no point-in-time recovery. A backup every hour means up to an hour of
          writes can be lost if you restore from it. Replication (a replication factor of 3) protects against losing one
          node without losing recent writes, but it does not replace backups: a bad delete is replicated too.
        </li>
        <li>
          <strong>Recovery time objective (how long you are down).</strong> It is the time to fetch the file, restore or import
          it, start the node and confirm health. A physical restore is a local rebuild of the storage directory. An import
          goes through the API, so it takes as long as writing the data would. Measure both in a drill with your data size
          instead of guessing.
        </li>
        <li>
          Choose the backup frequency from your RPO, and size the machine and bandwidth of the restore path from your RTO.
        </li>
      </ul>

      <H2 id="disasters">Disaster scenarios</H2>
      <H3 id="lose-node">One node is lost (in a three-node cluster)</H3>
      <p>
        A replica set keeps a majority with two of three nodes, so reads and writes continue. After the node has been missing
        for <code>cluster.auto_rebalance_after_ms</code> (30 seconds by default), the control-plane leader re-places
        partitions on the surviving nodes. The usual recovery is to bring the node back with its data directory intact: it
        rejoins and catches up from the leader, using a snapshot if it is far behind. Keep the node ID and the advertise
        address stable.
      </p>
      <Callout kind="note">
        <p>
          Replacing a node with a brand-new empty disk under the same node ID relies on the same catch-up mechanism, but it is
          the less rehearsed path. Try it in staging before you depend on it. Do not scale the voter set up or down: it is
          fixed at creation.
        </p>
      </Callout>
      <H3 id="lose-quorum">Quorum is lost (two of three nodes down)</H3>
      <p>
        The remaining node cannot commit strict writes or serve strict reads, and the API says so rather than answering
        stale data. <code>eventual</code> and <code>available</code> reads can still be served from the local replica, and
        such writes are accepted locally and reconciled later. The fix is to bring the failed nodes back. Their data is intact
        on disk, so nothing is lost when they return. Do not rebuild the cluster while the disks still exist.
      </p>
      <H3 id="lose-disks">Quorum disks are permanently lost</H3>
      <p>
        If two nodes lose their data for good, the remaining node cannot elect a leader on its own and the voter set cannot be
        changed in place. Create a new cluster, and load your latest export into it with <code>celeris import</code>. If you
        have no recent export, try <code>celeris export --consistency eventual</code> against the survivor to salvage what it
        holds; that path is not covered by a documented guarantee, so treat the result as best effort and verify it.
      </p>
      <H3 id="lose-all">Everything is lost</H3>
      <p>
        Single node: provision a machine, install CelerisDB, restore the latest physical backup as in the steps above. Cluster:
        create the new cluster (see <DocLink to="clustering">Clustering</DocLink>), wait until partitions are placed, then{" "}
        <code>celeris import</code> the latest export. Re-create secondary indexes in the configuration before or right after
        the import; they are built in the background from the data.
      </p>
      <H3 id="mistake">A bad write or delete</H3>
      <p>
        Replication copies mistakes as faithfully as good data. There is no point-in-time recovery, so the fix is to restore
        the affected keys from a backup. For an export, filter the lines you need (for example with <code>jq</code> or{" "}
        <code>Select-String</code>) into a smaller file and import that into the live cluster. Importing overwrites the
        current values of those keys.
      </p>

      <H2 id="next">Next steps</H2>
      <ul>
        <li>
          <DocLink to="production-checklist">Production checklist</DocLink> for the backup items.
        </li>
        <li>
          <DocLink to="cli">CLI reference</DocLink> for every backup flag.
        </li>
        <li>
          <DocLink to="troubleshooting">Troubleshooting</DocLink> if a restore or import fails.
        </li>
      </ul>
    </>
  );
}

export const page: DocPage = {
  slug: "backup-restore",
  title: "Backup and restore",
  group: "Operate",
  summary: "Physical backups for single nodes, logical export and import for clusters, scheduling, off-site copies, drills and disaster recovery.",
  keywords: ["backup", "restore", "export", "import", "disaster recovery", "rpo", "rto", "cron", "s3", "snapshot", "jsonl", "task scheduler", "systemd timer", "dr"],
  Body,
};
