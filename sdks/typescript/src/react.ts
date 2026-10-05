/**
 * React bindings: `useCeleris(client, key)` keeps a component in sync with
 * one key, live, through the node's change stream.
 *
 * ```tsx
 * const client = new Client({ nodes: "http://localhost:8080" });
 * function Profile() {
 *   const { data, loading, error } = useCeleris<User>(client, "users/42");
 *   ...
 * }
 * ```
 */

import { useEffect, useMemo, useSyncExternalStore } from "react";

import type { Client, Consistency } from "./index.js";
import { createKeyStore, type KeyState } from "./store.js";

export type { KeyState } from "./store.js";

export interface UseCelerisResult<T> extends KeyState<T> {
  refresh(): Promise<void>;
}

export function useCeleris<T = unknown>(
  client: Client,
  key: string,
  options: { consistency?: Consistency; live?: boolean } = {},
): UseCelerisResult<T> {
  const { consistency, live } = options;
  const store = useMemo(
    () => createKeyStore<T>(client, key, { ...(consistency ? { consistency } : {}), live: live !== false }),
    [client, key, consistency, live],
  );
  useEffect(() => () => store.close(), [store]);
  const state = useSyncExternalStore(store.subscribe, store.getSnapshot, store.getSnapshot);
  return { ...state, refresh: store.refresh };
}
