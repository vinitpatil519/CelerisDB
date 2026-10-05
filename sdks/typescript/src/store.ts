/**
 * A live view of one key: an initial read, then updates from the change
 * stream. It has no framework dependency; `useCeleris` wraps it for React,
 * and other frameworks can subscribe directly.
 */

import type { Client, Consistency, Watcher } from "./index.js";

export interface KeyState<T> {
  /** Current value, `null` if the key does not exist. */
  data: T | null;
  /** Version of `data`, `null` if unknown or absent. */
  version: number | null;
  loading: boolean;
  error: unknown;
}

export interface KeyStore<T> {
  getSnapshot(): KeyState<T>;
  subscribe(listener: () => void): () => void;
  /** Re-reads the key (also done automatically after a `lagged` notice). */
  refresh(): Promise<void>;
  close(): void;
}

export function createKeyStore<T>(
  client: Client,
  key: string,
  options: { consistency?: Consistency; live?: boolean } = {},
): KeyStore<T> {
  let state: KeyState<T> = { data: null, version: null, loading: true, error: null };
  const listeners = new Set<() => void>();
  let watcher: Watcher | null = null;
  let closed = false;

  const set = (next: Partial<KeyState<T>>) => {
    state = { ...state, ...next };
    for (const l of listeners) l();
  };

  const refresh = async () => {
    try {
      const item = await client.get<T>(key, options.consistency ? { consistency: options.consistency } : {});
      if (closed) return;
      // Never go backwards: a change event may have arrived meanwhile.
      if (item && state.version !== null && item.version < state.version) {
        set({ loading: false });
        return;
      }
      set({ data: item ? item.value : null, version: item ? item.version : null, loading: false, error: null });
    } catch (error) {
      if (!closed) set({ loading: false, error });
    }
  };

  if (options.live !== false) {
    watcher = client.watch<T>(key, {
      onChange(event) {
        if (event.key !== key) return; // the watch is a prefix watch
        if (state.version !== null && event.version < state.version) return;
        set({
          data: event.kind === "delete" ? null : event.value,
          version: event.kind === "delete" ? null : event.version,
          loading: false,
          error: null,
        });
      },
      onLagged() {
        void refresh();
      },
    });
  }
  void refresh();

  return {
    getSnapshot: () => state,
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    refresh,
    close() {
      closed = true;
      watcher?.close();
      listeners.clear();
    },
  };
}
