export const REPO = "https://github.com/vinitpatil519/CelerisDB";
export const RAW = "https://raw.githubusercontent.com/vinitpatil519/CelerisDB/main";
export const IMAGE = "ghcr.io/vinitpatil519/celeris:latest";
export const DOCS = `${REPO}/tree/main/docs`;
export const ARCHITECTURE = `${REPO}/blob/main/docs/CONSISTENCY.md`;
export const DEPLOYMENT = `${REPO}/blob/main/docs/DEPLOYMENT.md`;

export interface Mode {
  id: "strict" | "session" | "bounded" | "available" | "eventual";
  label: string;
  /** 0..1 scores for the meters. */
  availability: number;
  staleRisk: number;
  coordination: number;
  summary: string;
  useCase: string;
}

export const MODES: Mode[] = [
  {
    id: "strict",
    label: "STRICT",
    availability: 0.55,
    staleRisk: 0,
    coordination: 1,
    summary: "Linearizable. Reads and writes go through the Raft leader of the key's replica set and need a majority.",
    useCase: "Balances, inventory, uniqueness, anything you cannot get wrong.",
  },
  {
    id: "session",
    label: "SESSION",
    availability: 0.7,
    staleRisk: 0.2,
    coordination: 0.6,
    summary: "Read your own writes and never go backwards, using a session token the SDK carries for you.",
    useCase: "User profiles, carts, settings: one user sees a consistent story.",
  },
  {
    id: "bounded",
    label: "BOUNDED",
    availability: 0.8,
    staleRisk: 0.4,
    coordination: 0.4,
    summary: "Reads may lag, but never by more than the staleness bound you set; otherwise they fail.",
    useCase: "Dashboards, feeds and leaderboards with a freshness budget.",
  },
  {
    id: "available",
    label: "AVAILABLE",
    availability: 0.97,
    staleRisk: 0.7,
    coordination: 0.15,
    summary: "Accepted locally even without a quorum, reconciled later with deterministic last-writer-wins. Losers are recorded, never silently dropped.",
    useCase: "Telemetry, presence, likes: keep writing through a partition.",
  },
  {
    id: "eventual",
    label: "EVENTUAL",
    availability: 1,
    staleRisk: 0.9,
    coordination: 0,
    summary: "Read whatever the nearest replica has. The cheapest and fastest read.",
    useCase: "Caches, recommendations, analytics.",
  },
];

export interface ClusterNode {
  id: string;
  zone: string;
  partitions: string;
}

export const NODES: ClusterNode[] = [
  { id: "node-a", zone: "ap-south-1a", partitions: "0–1365" },
  { id: "node-b", zone: "ap-south-1b", partitions: "1366–2730" },
  { id: "node-c", zone: "ap-south-1c", partitions: "2731–4095" },
];

export const SECTIONS = [
  { id: "cap", label: "CAP" },
  { id: "route", label: "ROUTE" },
  { id: "partition", label: "PARTITION" },
  { id: "store", label: "STORE" },
  { id: "reconcile", label: "RECONCILE" },
  { id: "deploy", label: "DEPLOY" },
] as const;

export const INSTALL = {
  unix: `curl -fsSL ${RAW}/install.sh | sh
celeris init
celeris start`,
  windows: `irm ${RAW}/install.ps1 | iex
celeris init
celeris start`,
  docker: `docker run --rm -p 8080:8080 -p 7000:7000 ${IMAGE}`,
  cluster: `git clone ${REPO} && cd CelerisDB
docker compose up -d --build   # 3 nodes on :8081-8083`,
};
