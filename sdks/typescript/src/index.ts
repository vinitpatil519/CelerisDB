/**
 * Celeris client for browsers and Node.js (>= 22). No dependencies: it uses
 * the platform `fetch` and `WebSocket`.
 *
 * Guarantees the client keeps:
 * - Every write carries a mutation ID. Retries (after network errors, or
 *   on another node) reuse it, so a write is never applied twice.
 * - A write whose outcome cannot be determined rejects with
 *   {@link OutcomeUnknownError}, carrying the mutation ID. It is never
 *   reported as a plain failure; check it with {@link Client.mutationStatus}.
 * - The consistency the server actually applied is reported on every
 *   result. The client never weakens a requested mode.
 */

export type Consistency = "strict" | "session" | "bounded" | "available" | "eventual";

export interface ClientOptions {
  /** One or more node base URLs, e.g. `http://localhost:8080`. */
  nodes: string | string[];
  /** Default consistency for reads and writes (server default: strict). */
  consistency?: Consistency;
  /** Per-request timeout. Default 10 s. */
  timeoutMs?: number;
  /** Attempts per request across nodes and transient errors. Default 4. */
  attempts?: number;
  /** API token, sent as `Authorization: Bearer <token>` (and as
   * `access_token` on change streams, where browsers cannot set headers). */
  token?: string;
  /** Extra headers on every request. */
  headers?: Record<string, string>;
  /** Custom fetch, for tests or special runtimes. */
  fetch?: typeof fetch;
}

export interface ReadOptions {
  consistency?: Consistency;
  /** Staleness bound for `bounded` reads. */
  maxStalenessMs?: number;
}

export interface WriteOptions {
  consistency?: Consistency;
  /** Reuse a mutation ID to retry a write safely. Default: random. */
  mutationId?: string;
}

export interface PutOptions extends WriteOptions {
  ttlMs?: number;
  /** Write only if the current version equals this (compare-and-set). */
  ifVersion?: number;
  /** Write only if the key does not exist. */
  ifAbsent?: boolean;
}

export interface DeleteOptions extends WriteOptions {
  ifVersion?: number;
}

export interface Item<T = unknown> {
  key: string;
  value: T;
  version: number;
  expiresAtMs: number | null;
  /** Consistency applied by the server. */
  consistency: string;
}

export interface WriteResult {
  key?: string;
  /** Commit version; `null` while an `available` write is pending. */
  version: number | null;
  mutationId: string;
  /** This mutation ID had already committed; nothing new was written. */
  deduplicated: boolean;
  /** `false` when an `available` write was accepted but is not yet replicated (HTTP 202). */
  replicated: boolean;
  consistency: string;
}

export type BatchOp =
  | { op: "put"; key: string; value: unknown; ttl_ms?: number; if_version?: number; if_absent?: boolean }
  | { op: "delete"; key: string; if_version?: number };

export interface ScanOptions {
  prefix?: string;
  start?: string;
  end?: string;
  /** Page size, 1–1000. */
  limit?: number;
  consistency?: Consistency;
}

export interface ScanPage<T = unknown> {
  items: Item<T>[];
  nextCursor: string | null;
  /** Some data may be missing (unreachable replica sets). */
  partial: boolean;
}

export interface Conflict {
  key: string;
  value: string | null;
  timestamp_ms: number;
  mutation_id: string;
  origin: string | null;
  winner_version: number | null;
  winner_timestamp_ms: number;
  winner_mutation_id: string;
}

export interface ChangeEvent<T = unknown> {
  key: string;
  kind: "put" | "delete";
  value: T | null;
  version: number;
  mutation_id: string;
}

export interface WatchHandlers<T = unknown> {
  onChange: (event: ChangeEvent<T>) => void;
  /** First message: which replica sets this node covers. */
  onHello?: (hello: { node: string; groups: string[]; partial: boolean }) => void;
  /** Events were dropped; re-read what you depend on. */
  onLagged?: (missed: number) => void;
  onClose?: () => void;
  onError?: (error: unknown) => void;
}

export interface Watcher {
  close(): void;
}

/** An error answered by a node, or a transport failure. */
export class CelerisError extends Error {
  /** HTTP status, or 0 for transport errors. */
  readonly status: number;
  /** Server error code, e.g. `condition_failed`, `not_found`. */
  readonly code: string;
  /** For writes: `not_applied` (safe to treat as failed) or `unknown`. */
  readonly outcome?: "not_applied" | "unknown";
  readonly mutationId?: string;
  /** The full error object from the server. */
  readonly details: Record<string, unknown>;

  constructor(status: number, details: Record<string, unknown>) {
    super(String(details["message"] ?? details["code"] ?? `HTTP ${status}`));
    this.name = "CelerisError";
    this.status = status;
    this.code = String(details["code"] ?? "error");
    const outcome = details["outcome"];
    if (outcome === "not_applied" || outcome === "unknown") {
      this.outcome = outcome;
    }
    if (typeof details["mutation_id"] === "string") {
      this.mutationId = details["mutation_id"];
    }
    this.details = details;
  }
}

/** The write may or may not have committed. Resolve with `mutationStatus`. */
export class OutcomeUnknownError extends CelerisError {
  constructor(mutationId: string, reason: string) {
    super(0, { code: "outcome_unknown", message: reason, outcome: "unknown", mutation_id: mutationId });
    this.name = "OutcomeUnknownError";
  }
}

const SESSION_HEADER = "celeris-session-index";
const MUTATION_HEADER = "celeris-mutation-id";
/** Error codes after which the same request may be tried on another node. */
const REDIRECTS = new Set(["not_leader", "not_owner", "partition_moved"]);
/** 503 codes that guarantee the write was not applied: retry shortly. */
const TRANSIENT = new Set([
  "proposal_lost",
  "partition_moving",
  "read_retry",
  "read_timeout",
  "session_behind",
  "no_partition_map",
  "epoch_ahead",
]);

/** Percent-encodes a key for a URL path, keeping `/` readable. */
export function encodeKey(key: string): string {
  if (key.split("/").some((s) => s === "." || s === "..")) {
    throw new CelerisError(0, {
      code: "invalid_key",
      message: "keys with `.` or `..` path segments cannot be used over HTTP",
    });
  }
  return key.split("/").map(encodeURIComponent).join("/");
}

function query(params: Record<string, string | number | boolean | undefined>): string {
  const pairs = Object.entries(params).filter(([, v]) => v !== undefined);
  if (pairs.length === 0) return "";
  return "?" + pairs.map(([k, v]) => `${k}=${encodeURIComponent(String(v))}`).join("&");
}

interface Raw {
  status: number;
  body: any;
  headers: Headers;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export class Client {
  private readonly nodes: string[];
  private readonly options: ClientOptions;
  private readonly fetchImpl: typeof fetch;
  /** Index of the node that last answered successfully. */
  private preferred = 0;
  /** Latest session token seen, for `session` reads. */
  private sessionToken: string | null = null;

  constructor(options: ClientOptions) {
    const nodes = Array.isArray(options.nodes) ? options.nodes : [options.nodes];
    if (nodes.length === 0) throw new Error("at least one node URL is required");
    this.nodes = nodes.map((n) => (/^https?:\/\//.test(n) ? n : `http://${n}`).replace(/\/+$/, ""));
    this.options = options;
    this.fetchImpl = options.fetch ?? globalThis.fetch.bind(globalThis);
  }

  /** The session token from the latest write or read (`<index>@<group>`). */
  get session(): string | null {
    return this.sessionToken;
  }

  /** Reads a key. Resolves to `null` if it does not exist. */
  async get<T = unknown>(key: string, options: ReadOptions = {}): Promise<Item<T> | null> {
    const consistency = options.consistency ?? this.options.consistency;
    const headers: Record<string, string> = {};
    if (consistency === "session" && this.sessionToken) headers[SESSION_HEADER] = this.sessionToken;
    const path =
      `/v1/kv/${encodeKey(key)}` + query({ consistency, max_staleness_ms: options.maxStalenessMs });
    const raw = await this.read("GET", path, headers);
    if (raw.status === 404) return null;
    this.expectOk(raw);
    return toItem<T>(raw.body);
  }

  /** Writes a JSON value. */
  async put<T = unknown>(key: string, value: T, options: PutOptions = {}): Promise<WriteResult> {
    const path =
      `/v1/kv/${encodeKey(key)}` +
      query({
        consistency: options.consistency ?? this.options.consistency,
        ttl_ms: options.ttlMs,
        if_version: options.ifVersion,
        if_absent: options.ifAbsent ? true : undefined,
      });
    return this.write("PUT", path, JSON.stringify(value), options.mutationId);
  }

  /** Deletes a key. Deleting an absent key succeeds. */
  async delete(key: string, options: DeleteOptions = {}): Promise<WriteResult> {
    const path =
      `/v1/kv/${encodeKey(key)}` +
      query({ consistency: options.consistency ?? this.options.consistency, if_version: options.ifVersion });
    return this.write("DELETE", path, undefined, options.mutationId);
  }

  /** Applies operations atomically under one mutation ID. */
  async batch(ops: BatchOp[], options: WriteOptions = {}): Promise<WriteResult> {
    const mutationId = options.mutationId ?? crypto.randomUUID();
    const body = JSON.stringify({
      mutation_id: mutationId,
      consistency: options.consistency ?? this.options.consistency,
      ops,
    });
    return this.write("POST", "/v1/batch", body, mutationId);
  }

  /** One page of a scan. Pass `after` from the previous page's `nextCursor`. */
  async scanPage<T = unknown>(options: ScanOptions = {}, after?: string): Promise<ScanPage<T>> {
    const path =
      "/v1/scan" +
      query({
        prefix: options.prefix,
        start: options.start,
        end: options.end,
        limit: options.limit,
        consistency: options.consistency ?? this.options.consistency,
        after,
      });
    const raw = await this.read("GET", path);
    this.expectOk(raw);
    return {
      items: (raw.body.items as any[]).map((i) => toItem<T>({ ...i, consistency: raw.body.consistency })),
      nextCursor: raw.body.next_cursor ?? null,
      partial: Boolean(raw.body.partial),
    };
  }

  /** Iterates every item in key order, fetching pages as needed. */
  async *scan<T = unknown>(options: ScanOptions = {}): AsyncGenerator<Item<T>> {
    let after: string | undefined;
    for (;;) {
      const page: ScanPage<T> = await this.scanPage<T>(options, after);
      yield* page.items;
      if (page.nextCursor === null) return;
      after = page.nextCursor;
    }
  }

  /** Whether a mutation committed (within the server's retention window). */
  async mutationStatus(mutationId: string): Promise<{ committed: boolean; version: number | null }> {
    const raw = await this.read("GET", `/v1/mutations/${encodeURIComponent(mutationId)}`);
    if (raw.status === 404) return { committed: false, version: null };
    this.expectOk(raw);
    return { committed: true, version: raw.body.version ?? null };
  }

  /** Writes that lost last-writer-wins under `available` consistency. */
  async conflicts(options: { prefix?: string; limit?: number } = {}): Promise<{ conflicts: Conflict[]; partial: boolean }> {
    const raw = await this.read("GET", "/v1/conflicts" + query({ prefix: options.prefix, limit: options.limit }));
    this.expectOk(raw);
    return { conflicts: raw.body.conflicts, partial: Boolean(raw.body.partial) };
  }

  /** Forgets the recorded conflicts of a key. */
  async clearConflicts(key: string): Promise<void> {
    const raw = await this.read("DELETE", `/v1/conflicts/${encodeKey(key)}`);
    this.expectOk(raw);
  }

  /** Node, cluster and storage status. */
  async status(): Promise<any> {
    const raw = await this.read("GET", "/v1/status");
    this.expectOk(raw);
    return raw.body;
  }

  /**
   * Streams changes to keys starting with `prefix` from one node (see the
   * API docs for coverage in clusters). Uses the platform WebSocket.
   */
  watch<T = unknown>(prefix: string, handlers: WatchHandlers<T>): Watcher {
    const base = this.nodes[this.preferred]!.replace(/^http/, "ws");
    const socket = new WebSocket(`${base}/v1/watch${query({ prefix, access_token: this.options.token })}`);
    socket.onmessage = (msg: MessageEvent) => {
      let data: any;
      try {
        data = JSON.parse(String(msg.data));
      } catch (e) {
        handlers.onError?.(e);
        return;
      }
      if (data.type === "change") handlers.onChange(data as ChangeEvent<T>);
      else if (data.type === "hello") handlers.onHello?.(data);
      else if (data.type === "lagged") handlers.onLagged?.(data.missed);
    };
    socket.onerror = (e: Event) => handlers.onError?.(e);
    socket.onclose = () => handlers.onClose?.();
    return { close: () => socket.close() };
  }

  // ---------------------------------------------------------------------

  private expectOk(raw: Raw): void {
    if (raw.status < 200 || raw.status >= 300) {
      throw new CelerisError(raw.status, raw.body?.error ?? { code: "http_error", message: `HTTP ${raw.status}` });
    }
  }

  private remember(raw: Raw): void {
    const token = raw.headers.get(SESSION_HEADER);
    if (token) this.sessionToken = token;
  }

  private async send(
    node: number,
    method: string,
    path: string,
    headers: Record<string, string>,
    body?: string,
  ): Promise<Raw> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.options.timeoutMs ?? 10_000);
    try {
      const init: RequestInit = {
        method,
        headers: {
          "content-type": "application/json",
          ...(this.options.token ? { authorization: `Bearer ${this.options.token}` } : {}),
          ...this.options.headers,
          ...headers,
        },
        signal: controller.signal,
      };
      if (body !== undefined) init.body = body;
      const resp = await this.fetchImpl(this.nodes[node]! + path, init);
      const text = await resp.text();
      let parsed: any = null;
      try {
        parsed = text ? JSON.parse(text) : null;
      } catch {
        parsed = { error: { code: "invalid_response", message: text } };
      }
      return { status: resp.status, body: parsed, headers: resp.headers };
    } finally {
      clearTimeout(timer);
    }
  }

  /** Reads and other idempotent calls: retried on any failure. */
  private async read(method: string, path: string, headers: Record<string, string> = {}): Promise<Raw> {
    const attempts = this.options.attempts ?? 4;
    let last: unknown;
    for (let i = 0; i < attempts; i++) {
      const node = (this.preferred + i) % this.nodes.length;
      try {
        const raw = await this.send(node, method, path, headers);
        const code = raw.body?.error?.code;
        if ((raw.status === 421 && REDIRECTS.has(code)) || (raw.status === 503 && TRANSIENT.has(code))) {
          last = new CelerisError(raw.status, raw.body.error);
          await sleep(50 * (i + 1));
          continue;
        }
        this.preferred = node;
        this.remember(raw);
        return raw;
      } catch (e) {
        last = e;
        await sleep(50 * (i + 1));
      }
    }
    if (last instanceof CelerisError) throw last;
    throw new CelerisError(0, { code: "unreachable", message: `no node answered: ${String(last)}` });
  }

  /**
   * Writes: retried with the same mutation ID after network failures (the
   * server deduplicates), on another node after redirects, and after
   * errors that guarantee nothing was applied.
   */
  private async write(method: string, path: string, body: string | undefined, mutationId?: string): Promise<WriteResult> {
    const id = mutationId ?? crypto.randomUUID();
    const attempts = this.options.attempts ?? 4;
    let maybeSent = false;
    let last: unknown;
    for (let i = 0; i < attempts; i++) {
      const node = (this.preferred + i) % this.nodes.length;
      let raw: Raw;
      try {
        raw = await this.send(node, method, path, { [MUTATION_HEADER]: id }, body);
      } catch (e) {
        // fetch cannot tell "never connected" from "lost after sending".
        maybeSent = true;
        last = e;
        await sleep(100 * (i + 1));
        continue;
      }
      const error = raw.body?.error;
      if (raw.status === 421 && REDIRECTS.has(error?.code)) {
        last = new CelerisError(raw.status, error);
        continue;
      }
      if (raw.status === 503 && TRANSIENT.has(error?.code)) {
        last = new CelerisError(raw.status, error);
        await sleep(100 * (i + 1));
        continue;
      }
      if (error?.outcome === "unknown") {
        // Retrying with the same ID is safe and may resolve it.
        maybeSent = true;
        last = new CelerisError(raw.status, error);
        await sleep(100 * (i + 1));
        continue;
      }
      this.expectOk(raw);
      this.preferred = node;
      this.remember(raw);
      return {
        key: raw.body.key,
        version: raw.body.version ?? null,
        mutationId: raw.body.mutation_id ?? id,
        deduplicated: Boolean(raw.body.deduplicated),
        replicated: raw.status !== 202,
        consistency: raw.body.consistency,
      };
    }
    if (maybeSent) {
      throw new OutcomeUnknownError(id, `no confirmation after ${attempts} attempts: ${String(last)}`);
    }
    if (last instanceof CelerisError) throw last;
    throw new CelerisError(0, { code: "unreachable", message: String(last), outcome: "not_applied", mutation_id: id });
  }
}

function toItem<T>(body: any): Item<T> {
  return {
    key: body.key,
    value: body.value as T,
    version: body.version,
    expiresAtMs: body.expires_at_ms ?? null,
    consistency: body.consistency,
  };
}
export { createKeyStore } from "./store.js";
export type { KeyState, KeyStore } from "./store.js";
