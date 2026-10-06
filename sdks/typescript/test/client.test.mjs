// Integration tests: the compiled client (dist/) against a real node.

import assert from "node:assert/strict";
import { createHash, randomBytes } from "node:crypto";
import { after, before, describe, test } from "node:test";

import { CelerisError, Client, OutcomeUnknownError, createKeyStore, encodeKey } from "../dist/index.js";
import { startNode } from "./node.mjs";

let node;
let client;

before(async () => {
  node = await startNode();
  client = new Client({ nodes: node.url });
});

after(async () => {
  await node?.stop();
});

/** Resolves once `predicate()` holds, polling briefly. */
async function eventually(predicate, timeoutMs = 5_000) {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error("condition not reached in time");
    await new Promise((r) => setTimeout(r, 10));
  }
}

describe("key-value", () => {
  test("put, get and delete round-trip JSON values", async () => {
    const written = await client.put("users/1", { name: "Ada", tags: ["x"] });
    assert.equal(written.key, "users/1");
    assert.ok(written.version > 0);
    assert.equal(written.replicated, true);
    assert.equal(written.deduplicated, false);

    const item = await client.get("users/1");
    assert.deepEqual(item.value, { name: "Ada", tags: ["x"] });
    assert.equal(item.version, written.version);
    assert.equal(item.consistency, "strict");

    await client.delete("users/1");
    assert.equal(await client.get("users/1"), null);
  });

  test("keys with spaces and unicode are encoded", async () => {
    const key = "docs/hello world/ünï?#";
    await client.put(key, 1);
    assert.equal((await client.get(key)).value, 1);
  });

  test("keys with dot segments are refused locally", () => {
    assert.throws(() => encodeKey("a/../b"), CelerisError);
  });

  test("compare-and-set and if-absent", async () => {
    const first = await client.put("cas/1", "a", { ifAbsent: true });
    await assert.rejects(client.put("cas/1", "b", { ifAbsent: true }), (e) => {
      assert.ok(e instanceof CelerisError);
      assert.equal(e.status, 409);
      assert.equal(e.code, "condition_failed");
      return true;
    });
    await assert.rejects(client.put("cas/1", "b", { ifVersion: first.version + 1000 }), { code: "condition_failed" });
    const second = await client.put("cas/1", "b", { ifVersion: first.version });
    assert.ok(second.version > first.version);
    await assert.rejects(client.delete("cas/1", { ifVersion: first.version }), { code: "condition_failed" });
    await client.delete("cas/1", { ifVersion: second.version });
  });

  test("a retried mutation ID is applied once", async () => {
    const mutationId = crypto.randomUUID();
    const a = await client.put("idem/1", { n: 1 }, { mutationId });
    const b = await client.put("idem/1", { n: 1 }, { mutationId });
    assert.equal(b.deduplicated, true);
    assert.equal(b.version, a.version);
    assert.deepEqual(await client.mutationStatus(mutationId), { committed: true, version: a.version });
    assert.deepEqual(await client.mutationStatus(crypto.randomUUID()), { committed: false, version: null });
  });

  test("ttl expires values", async () => {
    await client.put("ttl/1", true, { ttlMs: 50 });
    const item = await client.get("ttl/1");
    assert.ok(item.expiresAtMs !== null);
    await new Promise((r) => setTimeout(r, 120));
    assert.equal(await client.get("ttl/1"), null);
  });

  test("batches are atomic", async () => {
    await client.put("acct/b", 5);
    const result = await client.batch([
      { op: "put", key: "acct/a", value: 1 },
      { op: "delete", key: "acct/b" },
    ]);
    assert.ok(result.version > 0);
    assert.equal((await client.get("acct/a")).value, 1);
    assert.equal(await client.get("acct/b"), null);

    // One failed condition rejects the whole batch.
    await assert.rejects(
      client.batch([
        { op: "put", key: "acct/c", value: 1 },
        { op: "put", key: "acct/a", value: 2, if_absent: true },
      ]),
      { code: "condition_failed" },
    );
    assert.equal(await client.get("acct/c"), null);
  });
});

describe("scans", () => {
  test("pages through a prefix in key order", async () => {
    for (let i = 0; i < 25; i++) await client.put(`scan/${String(i).padStart(2, "0")}`, i);
    await client.put("scan0", "outside the prefix");

    const first = await client.scanPage({ prefix: "scan/", limit: 10 });
    assert.equal(first.items.length, 10);
    assert.equal(first.items[0].key, "scan/00");
    assert.equal(first.nextCursor, "scan/09");

    const all = [];
    for await (const item of client.scan({ prefix: "scan/", limit: 7 })) all.push(item);
    assert.deepEqual(
      all.map((i) => i.value),
      Array.from({ length: 25 }, (_, i) => i),
    );
  });
});

describe("queries", () => {
  test("filters and projects on the server", async () => {
    for (let i = 0; i < 12; i++) {
      await client.put(`q/${String(i).padStart(2, "0")}`, { n: i, tags: i % 3 === 0 ? ["fizz"] : [] });
    }
    const page = await client.queryPage({
      prefix: "q/",
      where: { tags: { $contains: "fizz" }, n: { $gt: 0 } },
      fields: ["n"],
    });
    assert.deepEqual(
      page.items.map((i) => i.value),
      [{ n: 3 }, { n: 6 }, { n: 9 }],
    );
    assert.equal(page.nextCursor, null);
    assert.equal(page.scanned, 12);

    const all = [];
    for await (const item of client.query({ prefix: "q/", where: { n: { $lt: 5 } }, maxScanned: 2 })) all.push(item.key);
    assert.deepEqual(all, ["q/00", "q/01", "q/02", "q/03", "q/04"]);

    await assert.rejects(client.queryPage({ where: { n: { $nope: 1 } } }), { code: "invalid_filter" });

    const agg = await client.aggregate({
      prefix: "q/",
      maxScanned: 5,
      aggregate: { count: true, sum: ["n"], min: ["n"], max: ["n"] },
    });
    assert.deepEqual(agg, { count: 12, sum: { n: 66 }, min: { n: 0 }, max: { n: 11 } });
  });
});

describe("watch", () => {
  test("streams matching changes", async () => {
    const events = [];
    let hello = null;
    const watcher = client.watch("live/", {
      onHello: (h) => (hello = h),
      onChange: (e) => events.push(e),
    });
    await eventually(() => hello !== null);
    assert.equal(hello.partial, false);

    await client.put("live/a", { v: 1 });
    await client.put("other/a", { v: 1 });
    await client.delete("live/a");
    await eventually(() => events.length === 2);
    assert.deepEqual(
      events.map((e) => [e.key, e.kind, e.value]),
      [
        ["live/a", "put", { v: 1 }],
        ["live/a", "delete", null],
      ],
    );
    watcher.close();
  });

  test("a key store follows one key", async () => {
    await client.put("store/k", "initial");
    const store = createKeyStore(client, "store/k");
    let notified = 0;
    store.subscribe(() => notified++);
    await eventually(() => !store.getSnapshot().loading);
    assert.equal(store.getSnapshot().data, "initial");

    await client.put("store/k2", "a sibling with the same prefix");
    await client.put("store/k", "updated");
    await eventually(() => store.getSnapshot().data === "updated");
    await client.delete("store/k");
    await eventually(() => store.getSnapshot().data === null);
    assert.equal(store.getSnapshot().version, null);
    assert.ok(notified >= 3);
    store.close();
  });
});

describe("failures", () => {
  test("an unreachable node is skipped", async () => {
    const multi = new Client({ nodes: ["http://127.0.0.1:1", node.url], timeoutMs: 2_000 });
    const written = await multi.put("failover/1", 1);
    assert.ok(written.version > 0);
    assert.equal((await multi.get("failover/1")).value, 1);
  });

  test("a write that may have been sent is reported as outcome-unknown", async () => {
    const broken = new Client({
      nodes: node.url,
      attempts: 2,
      fetch: async () => {
        throw new TypeError("connection reset");
      },
    });
    await assert.rejects(broken.put("x", 1, { mutationId: "11111111-1111-4111-8111-111111111111" }), (e) => {
      assert.ok(e instanceof OutcomeUnknownError);
      assert.equal(e.outcome, "unknown");
      assert.equal(e.mutationId, "11111111-1111-4111-8111-111111111111");
      return true;
    });
  });

  test("status reports the node", async () => {
    const status = await client.status();
    assert.equal(typeof status, "object");
  });
});

describe("authentication", () => {
  const token = "cel_" + randomBytes(32).toString("hex");
  const sha256 = createHash("sha256").update(token).digest("hex");
  let secured;
  before(async () => {
    secured = await startNode({ CELERIS_AUTH_TOKENS: `sdk:read+write:${sha256}` });
  });
  after(async () => {
    await secured?.stop();
  });

  test("requests without the token are refused", async () => {
    const anonymous = new Client({ nodes: secured.url, attempts: 1 });
    await assert.rejects(anonymous.get("a"), { status: 401, code: "unauthorized" });
  });

  test("the token authorizes requests and change streams", async () => {
    const db = new Client({ nodes: secured.url, token });
    await db.put("auth/a", 1);
    assert.equal((await db.get("auth/a")).value, 1);
    const events = [];
    let hello = false;
    const watcher = db.watch("auth/", { onHello: () => (hello = true), onChange: (e) => events.push(e) });
    await eventually(() => hello);
    await db.put("auth/b", 2);
    await eventually(() => events.length === 1);
    watcher.close();
  });
});
