import { Client } from "@celeris/client";
import { createContext, useContext, useMemo, useState, type ReactNode } from "react";

const STORAGE_KEY = "celeris.console.nodes";
/** Tokens live for the browser session only, never in localStorage. */
const TOKEN_KEY = "celeris.console.token";
const DEFAULT_NODES = "http://127.0.0.1:8080";

function loadNodes(): string {
  try {
    return localStorage.getItem(STORAGE_KEY) ?? DEFAULT_NODES;
  } catch {
    return DEFAULT_NODES;
  }
}

export interface Connection {
  /** Node base URLs, as typed by the user. */
  nodes: string[];
  token: string;
  client: Client;
  setNodes(text: string): void;
  setToken(token: string): void;
}

function loadToken(): string {
  try {
    return sessionStorage.getItem(TOKEN_KEY) ?? "";
  } catch {
    return "";
  }
}

/** The API token for `getJson` (set by the provider). */
let currentToken = "";

const ConnectionContext = createContext<Connection | null>(null);

export function parseNodes(text: string): string[] {
  return text
    .split(/[\s,]+/)
    .map((n) => n.trim())
    .filter(Boolean)
    .map((n) => (/^https?:\/\//.test(n) ? n : `http://${n}`).replace(/\/+$/, ""));
}

export function ConnectionProvider({ children }: { children: ReactNode }) {
  const [text, setText] = useState(loadNodes);
  const [token, setTokenState] = useState(loadToken);
  const value = useMemo<Connection>(() => {
    const nodes = parseNodes(text);
    const list = nodes.length > 0 ? nodes : [DEFAULT_NODES];
    currentToken = token;
    return {
      nodes: list,
      token,
      client: new Client({
        nodes: list,
        timeoutMs: 5_000,
        attempts: Math.max(2, list.length),
        ...(token ? { token } : {}),
      }),
      setToken(next: string) {
        try {
          if (next) sessionStorage.setItem(TOKEN_KEY, next);
          else sessionStorage.removeItem(TOKEN_KEY);
        } catch {
          // storage unavailable: keep it in memory
        }
        setTokenState(next);
      },
      setNodes(next: string) {
        try {
          localStorage.setItem(STORAGE_KEY, next);
        } catch {
          // private mode: keep it for this session only
        }
        setText(next);
      },
    };
  }, [text, token]);
  return <ConnectionContext.Provider value={value}>{children}</ConnectionContext.Provider>;
}

export function useConnection(): Connection {
  const c = useContext(ConnectionContext);
  if (!c) throw new Error("useConnection outside ConnectionProvider");
  return c;
}

/** GETs JSON from one node, outside the client's retry logic (for per-node views). */
export async function getJson<T = any>(node: string, path: string, timeoutMs = 4_000): Promise<T> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const headers: Record<string, string> = currentToken ? { authorization: `Bearer ${currentToken}` } : {};
    const resp = await fetch(node + path, { signal: controller.signal, headers }).catch((e: unknown) => {
      if (controller.signal.aborted) throw new Error(`no answer within ${timeoutMs / 1000} s`);
      throw new Error(`cannot reach the node (${e instanceof Error ? e.message : String(e)}); check the URL and CORS`);
    });
    const body = await resp.json().catch(() => null);
    if (!resp.ok) {
      const message = body?.error?.message ?? `HTTP ${resp.status}`;
      throw new Error(message);
    }
    return body as T;
  } finally {
    clearTimeout(timer);
  }
}
