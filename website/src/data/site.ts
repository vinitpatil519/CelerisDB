export const REPO = "https://github.com/vinitpatil519/CelerisDB";
export const RAW = "https://raw.githubusercontent.com/vinitpatil519/CelerisDB/main";
export const IMAGE = "ghcr.io/vinitpatil519/celeris:latest";
export const DOCS = `${REPO}/tree/main/docs`;
export const DOC = (file: string) => `${REPO}/blob/main/docs/${file}`;

export type ModeId = "strict" | "session" | "bounded" | "available" | "eventual";

export interface Mode {
  id: ModeId;
  label: string;
  /** 0..1, for the meters. */
  freshness: number;
  partition: number;
  speed: number;
  guarantee: string;
  during: string;
  useCase: string;
  code: string;
}

export const MODES: Mode[] = [
  {
    id: "strict",
    label: "Strict",
    freshness: 1,
    partition: 0.35,
    speed: 0.45,
    guarantee: "Linearizable reads and writes through the Raft leader.",
    during: "Majority side serves. Minority side refuses.",
    useCase: "Balances, inventory, bookings, uniqueness",
    code: `await db.put("accounts/42", acct, { ifVersion: 17 });
const a = await db.get("accounts/42", { consistency: "strict" });`,
  },
  {
    id: "session",
    label: "Session",
    freshness: 0.8,
    partition: 0.5,
    speed: 0.65,
    guarantee: "Read your own writes, on any replica.",
    during: "Any caught-up replica answers.",
    useCase: "Profiles, carts, settings, per-user timelines",
    code: `await db.put("carts/7", cart);           // token remembered by the SDK
const c = await db.get("carts/7", { consistency: "session" });`,
  },
  {
    id: "bounded",
    label: "Bounded",
    freshness: 0.6,
    partition: 0.65,
    speed: 0.8,
    guarantee: "Stale by at most the bound you set.",
    during: "Replicas within the bound answer.",
    useCase: "Dashboards, leaderboards, feeds with a freshness budget",
    code: `const board = await db.get("leaderboard/today", {
  consistency: "bounded", maxStalenessMs: 500,
});`,
  },
  {
    id: "available",
    label: "Available",
    freshness: 0.35,
    partition: 1,
    speed: 0.9,
    guarantee: "Accepted without quorum, reconciled on heal.",
    during: "Both sides accept writes. Losers are recorded.",
    useCase: "Likes, presence, telemetry, offline-tolerant carts",
    code: `const r = await db.put("likes/post-9", n, {
  consistency: "available",
});
r.replicated; // false while split: accepted, reconciled later`,
  },
  {
    id: "eventual",
    label: "Eventual",
    freshness: 0.15,
    partition: 1,
    speed: 1,
    guarantee: "Nearest replica, fastest read.",
    during: "Every reachable replica answers.",
    useCase: "Caches, recommendations, analytics",
    code: `const recs = await db.get("recs/user-42", { consistency: "eventual" });`,
  },
];

export const INSTALL = [
  {
    id: "unix",
    label: "macOS / Linux",
    code: `curl -fsSL ${RAW}/install.sh | sh
celeris init && celeris start`,
  },
  {
    id: "windows",
    label: "Windows",
    code: `irm ${RAW}/install.ps1 | iex
celeris init; celeris start`,
  },
  { id: "docker", label: "Docker", code: `docker run -p 8080:8080 ${IMAGE}` },
  {
    id: "cluster",
    label: "3-node cluster",
    code: `git clone ${REPO} && cd CelerisDB
docker compose up -d    # nodes on :8081, :8082, :8083`,
  },
];
