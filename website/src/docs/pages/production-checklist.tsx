import { Callout, Code, DocLink, H2 } from "../kit";
import { Checklist, type CheckGroup } from "../demos/Checklist";
import type { DocPage } from "../kit";

const GROUPS: CheckGroup[] = [
  {
    id: "security",
    title: "Security",
    items: [
      {
        id: "sec-tokens",
        text: "API tokens are configured, so authentication is on",
        why: "With no tokens configured, every request is allowed.",
        to: "security",
      },
      {
        id: "sec-scopes",
        text: "Each application has its own token with the narrowest scope (read, write, admin)",
        why: "Keep admin tokens out of application code. Export needs read, import needs write, backup needs admin.",
        to: "security",
      },
      {
        id: "sec-tls",
        text: "The client API is served over HTTPS, or sits behind a TLS terminating proxy you control",
        to: "security",
      },
      {
        id: "sec-cluster-port",
        text: "The cluster port (7000) is reachable only from other nodes, and mutual TLS is enabled between nodes",
        why: "The cluster port is for node-to-node traffic and must never be exposed to clients.",
        to: "security",
      },
      {
        id: "sec-listen",
        text: "http.listen binds only the interfaces you intend; CORS origins are an explicit list, not a wildcard",
        to: "configuration",
      },
      {
        id: "sec-secrets",
        text: "Tokens and private keys come from a secret store or environment, not from files in a repository",
        to: "security",
      },
    ],
  },
  {
    id: "durability",
    title: "Durability",
    items: [
      {
        id: "dur-sync",
        text: "storage.sync is \"always\" unless you have decided that losing the last writes on power loss is acceptable",
        why: "With \"never\", a process crash is survived but power loss keeps only a prefix of acknowledged writes.",
        to: "performance:sync-modes",
      },
      {
        id: "dur-disk",
        text: "The data directory is on a local SSD or NVMe volume with low fsync latency",
        to: "performance:hardware",
      },
      {
        id: "dur-rf",
        text: "Replication factor is 3 for data you cannot afford to lose",
        to: "clustering",
      },
      {
        id: "dur-unknown",
        text: "Application code handles outcome unknown by retrying with the same mutation ID or checking the mutation",
        to: "errors",
      },
      {
        id: "dur-indexes",
        text: "Secondary indexes are declared identically on every node",
        to: "queries",
      },
    ],
  },
  {
    id: "topology",
    title: "Topology",
    items: [
      {
        id: "top-voters",
        text: "Three (or five) voters are listed in cluster.voters with fixed node IDs and stable advertise addresses",
        why: "The voter set is fixed when the cluster is created and cannot be changed later.",
        to: "clustering",
      },
      {
        id: "top-zones",
        text: "Each node sets cluster.zone to its rack or availability zone",
        to: "clustering",
      },
      {
        id: "top-placement",
        text: "Partitions are placed: celeris partitions shows the expected replicas on every node",
        to: "scaling:rebalancing",
      },
      {
        id: "top-lb",
        text: "A load balancer checks /ready and sends traffic only to ready nodes",
        to: "deployment",
      },
      {
        id: "top-k8s",
        text: "On Kubernetes, the StatefulSet stays at three voters and a PodDisruptionBudget protects the Raft majority",
        to: "deployment",
      },
    ],
  },
  {
    id: "capacity",
    title: "Capacity",
    items: [
      {
        id: "cap-plan",
        text: "Disk is sized from data size times replication factor, plus headroom for compaction",
        to: "scaling:capacity-planning",
      },
      {
        id: "cap-fds",
        text: "The process file descriptor limit is raised (the reference systemd unit uses LimitNOFILE=65536)",
        to: "performance:os-tuning",
      },
      {
        id: "cap-bench",
        text: "You ran celeris bench on production-like hardware with your value size and concurrency",
        to: "performance:load-testing",
      },
      {
        id: "cap-hot",
        text: "You checked your key design for hot keys and for scans that need an index",
        to: "scaling:hot-keys",
      },
    ],
  },
  {
    id: "backups",
    title: "Backups",
    items: [
      {
        id: "bak-schedule",
        text: "Backups or exports run on a schedule that matches the data you can afford to lose",
        to: "backup-restore:scheduling",
      },
      {
        id: "bak-offsite",
        text: "Backup files are copied off the node, to storage in another failure domain",
        to: "backup-restore:offsite",
      },
      {
        id: "bak-verify",
        text: "Every backup file is verified after it is written",
        to: "backup-restore:verifying",
      },
      {
        id: "bak-drill",
        text: "You have restored a backup into a scratch environment and timed it",
        to: "backup-restore:drills",
      },
    ],
  },
  {
    id: "monitoring",
    title: "Monitoring",
    items: [
      {
        id: "mon-scrape",
        text: "Prometheus scrapes /metrics from every node",
        to: "observability:prometheus",
      },
      {
        id: "mon-alerts",
        text: "Alerts exist for readiness, WAL failures, write stalls and node loss",
        to: "observability:alerts",
      },
      {
        id: "mon-logs",
        text: "Logs are JSON (CELERIS_LOG_FORMAT=json) and shipped somewhere searchable",
        to: "observability:logs",
      },
      {
        id: "mon-doctor",
        text: "Operators know celeris status, doctor and partitions, and where the logs live on each OS",
        to: "observability:cli",
      },
    ],
  },
  {
    id: "rollout",
    title: "Rollout",
    items: [
      {
        id: "roll-staging",
        text: "The whole configuration was rehearsed in a staging cluster, including killing a node",
        to: "troubleshooting",
      },
      {
        id: "roll-rolling",
        text: "Upgrades restart one node at a time and wait for /ready before the next",
        why: "Upgrade every node before configuring indexes: a node without index support cannot apply them.",
        to: "scaling:rolling",
      },
      {
        id: "roll-runbook",
        text: "The team has the troubleshooting page and a diagnostic bundle recipe in the runbook",
        to: "troubleshooting:collect-diagnostics",
      },
      {
        id: "roll-clients",
        text: "SDK clients use the default retry behavior and a request timeout suited to your latency targets",
        to: "performance:clients",
      },
    ],
  },
];

function Body() {
  return (
    <>
      <p>
        Use this list before you point real traffic at a cluster, and again after significant changes. Each item links to
        the page that explains it. Ticks are stored in your browser, so you can come back to the list later. They do not
        inspect your cluster: they are a memory aid, not a health check.
      </p>

      <Checklist groups={GROUPS} />

      <H2 id="how-to-use">How to use the list</H2>
      <p>
        Not every item applies to every deployment. A single node on a development laptop does not need a replication
        factor of 3, and a private network may not need mutual TLS. Tick an item when you have either done it or decided
        deliberately that it does not apply, and write the decision down.
      </p>

      <H2 id="verify">Quick verification commands</H2>
      <p>
        These read-only commands confirm several items at once. See <DocLink to="observability">Observability</DocLink>{" "}
        for what each one prints.
      </p>
      <Code lang="bash">{`celeris doctor
celeris status
celeris node list
celeris partitions`}</Code>

      <Callout kind="warn" title="Two limits to plan around">
        <p>
          The control-plane voter set is fixed when the cluster is created, and data nodes are currently the same nodes as
          the voters. Choose three or five nodes you intend to keep. See <DocLink to="scaling:limits">Scaling</DocLink>.
        </p>
      </Callout>

      <H2 id="next">Next steps</H2>
      <ul>
        <li>
          <DocLink to="deployment">Deployment</DocLink> for Docker, Compose, Kubernetes and AWS layouts.
        </li>
        <li>
          <DocLink to="troubleshooting">Troubleshooting</DocLink> for the first things to check when something is wrong.
        </li>
        <li>
          <DocLink to="backup-restore">Backup and restore</DocLink> to complete the Backups group.
        </li>
      </ul>
    </>
  );
}

export const page: DocPage = {
  slug: "production-checklist",
  title: "Production checklist",
  group: "Operate",
  summary: "A checkable, saved list of everything to settle before running CelerisDB in production.",
  keywords: ["go live", "launch", "readiness", "hardening", "pre-flight", "runbook", "ops checklist"],
  Body,
};
