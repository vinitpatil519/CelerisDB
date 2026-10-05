// Starts a real single Celeris node for the tests. The binary comes from
// CELERIS_BIN, or the workspace's release/debug build.

import { spawn, spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");
const exe = process.platform === "win32" ? "celeris.exe" : "celeris";

function binary() {
  if (process.env.CELERIS_BIN) return process.env.CELERIS_BIN;
  for (const profile of ["release", "debug"]) {
    const path = join(root, "target", profile, exe);
    if (existsSync(path)) return path;
  }
  throw new Error("celeris binary not found: build it with `cargo build -p celeris-cli` or set CELERIS_BIN");
}

function freePort() {
  return new Promise((ok, fail) => {
    const server = createServer();
    server.once("error", fail);
    server.listen(0, "127.0.0.1", () => {
      const { port } = server.address();
      server.close(() => ok(port));
    });
  });
}

/** Starts a node; resolves to `{ url, stop() }` once it answers /health. */
export async function startNode() {
  const bin = binary();
  const dir = mkdtempSync(join(tmpdir(), "celeris-ts-"));
  const port = await freePort();
  const listen = `127.0.0.1:${port}`;
  const init = spawnSync(bin, ["init", "--dir", dir, "--listen", listen], { encoding: "utf8" });
  if (init.status !== 0) throw new Error(`celeris init failed: ${init.stderr}`);
  const child = spawn(bin, ["start", "--config", join(dir, "celeris.toml")], {
    env: { ...process.env, CELERIS_SYNC: "never", CELERIS_LOG_LEVEL: "warn" },
    stdio: ["ignore", "ignore", "pipe"],
  });
  let stderr = "";
  child.stderr.on("data", (d) => (stderr += d));
  const url = `http://${listen}`;
  const deadline = Date.now() + 15_000;
  for (;;) {
    if (child.exitCode !== null) throw new Error(`node exited early: ${stderr}`);
    try {
      const r = await fetch(`${url}/health`);
      if (r.ok) break;
    } catch {
      // not listening yet
    }
    if (Date.now() > deadline) {
      child.kill();
      throw new Error(`node did not start: ${stderr}`);
    }
    await new Promise((r) => setTimeout(r, 50));
  }
  return {
    url,
    async stop() {
      if (child.exitCode === null) {
        const exited = new Promise((r) => child.once("exit", r));
        child.kill();
        await exited;
      }
      rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
    },
  };
}
