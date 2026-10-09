import { useSyncExternalStore } from "react";

/** Tiny persisted key/value store shared by every docs component (OS tab, language tab, theme). */

const listeners = new Set<() => void>();
const memory = new Map<string, string>();

function read(key: string): string | null {
  const mem = memory.get(key);
  if (mem !== undefined) return mem;
  try {
    return localStorage.getItem(key);
  } catch {
    return null;
  }
}

function write(key: string, value: string): void {
  memory.set(key, value);
  try {
    localStorage.setItem(key, value);
  } catch {
    /* storage unavailable: memory copy still works for this visit */
  }
  listeners.forEach((l) => l());
}

const subscribe = (cb: () => void) => {
  listeners.add(cb);
  return () => listeners.delete(cb);
};

export function useStored(key: string, fallback: string): [string, (value: string) => void] {
  const value = useSyncExternalStore(
    subscribe,
    () => read(key) ?? fallback,
    () => fallback,
  );
  return [value, (next: string) => write(key, next)];
}

export type Os = "linux" | "macos" | "windows";

export function detectOs(): Os {
  if (typeof navigator === "undefined") return "linux";
  const ua = `${navigator.userAgent} ${navigator.platform ?? ""}`;
  if (/Win/i.test(ua)) return "windows";
  if (/Mac/i.test(ua)) return "macos";
  return "linux";
}

export function useOs(): [Os, (os: Os) => void] {
  const [os, setOs] = useStored("celeris-docs-os", "linux");
  // First visit: nothing stored yet, so show the visitor's own platform.
  const effective = (read("celeris-docs-os") ? os : detectOs()) as Os;
  return [effective, (next) => setOs(next)];
}
