import { Callout, Code, CodeTabs, DocLink, H2, H3, Table, type DocPage } from "../kit";

/* ── Shared helpers ───────────────────────────────────────────────────── */

const IDS_TS = `
// ids.ts: deterministic mutation IDs. The server requires a UUID.
import { createHash } from "node:crypto";

export function stableId(...parts: string[]): string {
  const h = createHash("sha256").update(JSON.stringify(parts)).digest();
  h[6] = (h[6]! & 0x0f) | 0x50; // version 5 style
  h[8] = (h[8]! & 0x3f) | 0x80; // RFC 4122 variant
  const x = h.subarray(0, 16).toString("hex");
  return [x.slice(0, 8), x.slice(8, 12), x.slice(12, 16), x.slice(16, 20), x.slice(20)].join("-");
}

export const pad = (n: number, width = 6) => String(n).padStart(width, "0");
export const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
`;

const IDS_PY = `
# ids.py
import uuid

_NS = uuid.UUID("5f0b6c1e-8f3a-4d57-9a4e-2f4a0e2c9b11")  # any fixed namespace of your own


def stable_id(*parts: str) -> str:
    """Same inputs, same UUID. Use it as a mutation ID."""
    return str(uuid.uuid5(_NS, "\\x1f".join(parts)))
`;

/* ── Chat memory ──────────────────────────────────────────────────────── */

const CHAT_TS = `
// chat-memory.ts: example adapter, copy and adapt.
import { CelerisError, type Client } from "@celeris/client";
import { pad } from "./ids.js";

export type Msg = { role: "system" | "user" | "assistant" | "tool"; content: string };

const MAX = 999_999;
const THIRTY_DAYS = 30 * 24 * 3600 * 1000;

// Layout: chat/<session>/<MAX - seq>. Keys sort ascending, so the NEWEST message
// is first and "the last N messages" is one small scan.
export class ChatMemory {
  constructor(
    private readonly db: Client,
    private readonly sessionId: string,
    private readonly ttlMs = THIRTY_DAYS,
  ) {}

  private prefix() {
    return "chat/" + this.sessionId + "/";
  }

  private async newest(limit: number) {
    const page = await this.db.scanPage<Msg & { seq: number }>({ prefix: this.prefix(), limit });
    return page.items.map((i) => i.value);
  }

  async append(msg: Msg): Promise<void> {
    for (let attempt = 0; attempt < 5; attempt++) {
      const [last] = await this.newest(1);
      const seq = (last?.seq ?? 0) + 1;
      try {
        // ifAbsent turns two concurrent writers of one conversation into a retry, not a lost message.
        await this.db.put(this.prefix() + pad(MAX - seq), { seq, ...msg }, { ifAbsent: true, ttlMs: this.ttlMs });
        return;
      } catch (e) {
        if (!(e instanceof CelerisError && e.code === "condition_failed")) throw e;
      }
    }
    throw new Error("too many concurrent writers on one conversation");
  }

  /** The last n messages, oldest first, ready to send to a model. */
  async last(n = 20): Promise<Msg[]> {
    const rows = await this.newest(n);
    return rows.reverse().map(({ role, content }) => ({ role, content }));
  }
}
`;

/* ── Agent state ──────────────────────────────────────────────────────── */

const AGENT_STATE_TS = `
import { CelerisError, type Client } from "@celeris/client";
import { pad, stableId } from "./ids.js";

export type AgentState = {
  step: number;
  status: "running" | "done" | "failed";
  messages: { role: string; content: string }[];
};

const stateKey = (run: string) => "agent/" + run + "/state";

export async function loadState(db: Client, run: string): Promise<{ state: AgentState; version: number } | null> {
  const item = await db.get<AgentState>(stateKey(run));
  return item ? { state: item.value, version: item.version } : null;
}

/** Compare-and-set: succeeds only if nobody else saved since you loaded. */
export async function saveState(db: Client, run: string, next: AgentState, expectedVersion: number | null) {
  return db.put(stateKey(run), next, expectedVersion === null ? { ifAbsent: true } : { ifVersion: expectedVersion });
}

/** An immutable checkpoint per step. Replaying the same step cannot change it. */
export async function checkpoint(db: Client, run: string, step: number, snapshot: unknown) {
  try {
    await db.put("agent/" + run + "/ckpt/" + pad(step), snapshot, {
      ifAbsent: true,
      mutationId: stableId(run, "ckpt", String(step)),
    });
  } catch (e) {
    if (!(e instanceof CelerisError && e.code === "condition_failed")) throw e; // already checkpointed
  }
}
`;

/* ── Tool idempotency ─────────────────────────────────────────────────── */

const TOOL_TS = `
// tool-once.ts: run a tool call at most once per (run, callId), and reuse its result.
import { CelerisError, type Client } from "@celeris/client";
import { sleep, stableId } from "./ids.js";

type ToolRecord = { status: "running" | "done"; result?: unknown };
const SEVEN_DAYS = 7 * 24 * 3600 * 1000;

export async function runToolOnce<T>(
  db: Client,
  run: string,
  callId: string,
  execute: (externalIdempotencyKey: string) => Promise<T>,
  leaseMs = 120_000,
): Promise<T> {
  const key = "agent/" + run + "/tool/" + callId;

  for (;;) {
    // 1. Try to claim the call. ifAbsent lets exactly one worker win.
    //    Do NOT give the claim a deterministic mutation ID: a lease that expired
    //    must be claimable again, and a repeated ID would be treated as a duplicate.
    let claimVersion: number | null = null;
    try {
      const claim = await db.put(key, { status: "running" } satisfies ToolRecord, { ifAbsent: true, ttlMs: leaseMs });
      claimVersion = claim.version;
    } catch (e) {
      if (!(e instanceof CelerisError && e.code === "condition_failed")) throw e;
    }

    if (claimVersion !== null) {
      // 2. We own the call: run it. Pass callId down as the provider's own idempotency key.
      const result = await execute(callId);
      // 3. Record the result. The deterministic mutation ID makes a retried
      //    write (lost response, SDK retry, redelivery) apply exactly once.
      await db.put(key, { status: "done", result } satisfies ToolRecord, {
        ifVersion: claimVersion,
        ttlMs: SEVEN_DAYS,
        mutationId: stableId(run, callId, "done"),
      });
      return result;
    }

    // 4. Someone else claimed it. If it is finished, reuse the stored result.
    const existing = await db.get<ToolRecord>(key);
    if (existing?.value.status === "done") return existing.value.result as T;
    // Still running (or the owner crashed): wait. When the lease expires the key
    // disappears and the next loop iteration claims it again.
    await sleep(500);
  }
}
`;

const LOOP_TS = `
// agent-loop.ts: a custom agent loop that can be killed and resumed at any point.
import { CelerisError, type Client } from "@celeris/client";
import { checkpoint, loadState, saveState, type AgentState } from "./agent-state.js";
import { pad, stableId } from "./ids.js";
import { runToolOnce } from "./tool-once.js";

type Decision =
  | { type: "tool"; toolCallId: string; name: string; args: unknown }
  | { type: "final"; text: string };

export async function runAgent(
  db: Client,
  run: string,
  goal: string,
  callModel: (messages: AgentState["messages"]) => Promise<Decision>, // your LLM call
  tools: Record<string, (args: any, idempotencyKey: string) => Promise<unknown>>, // your tools
) {
  const loaded = await loadState(db, run);
  let version = loaded?.version ?? null;
  let state: AgentState = loaded?.state ?? { step: 0, status: "running", messages: [{ role: "user", content: goal }] };

  while (state.status === "running" && state.step < 20) {
    const n = state.step;

    // The model's decision is made durable BEFORE any tool runs. After a crash we read
    // it back instead of asking the model again (which could pick a different tool call).
    const decisionKey = "agent/" + run + "/decision/" + pad(n);
    let decision: Decision;
    const saved = await db.get<Decision>(decisionKey);
    if (saved) {
      decision = saved.value;
    } else {
      const fresh = await callModel(state.messages);
      try {
        await db.put(decisionKey, fresh, { ifAbsent: true, mutationId: stableId(run, "decision", String(n)) });
        decision = fresh;
      } catch (e) {
        if (!(e instanceof CelerisError && e.code === "condition_failed")) throw e;
        decision = (await db.get<Decision>(decisionKey))!.value; // another worker was first: use its decision
      }
    }

    if (decision.type === "final") {
      state = { ...state, status: "done", messages: [...state.messages, { role: "assistant", content: decision.text }] };
    } else {
      const callId = pad(n) + "-" + decision.toolCallId;
      const result = await runToolOnce(db, run, callId, (idem) => tools[decision.name]!(decision.args, idem));
      state = {
        ...state,
        step: n + 1,
        messages: [...state.messages, { role: "tool", content: JSON.stringify(result) }],
      };
    }

    await checkpoint(db, run, n, state);
    const out = await saveState(db, run, state, version); // CAS: a second runner of this run loses here
    version = out.version;
  }
  return state;
}
`;

/* ── RAG ──────────────────────────────────────────────────────────────── */

const RAG_TS = `
// rag-ingest.ts: Celeris keeps documents, chunks and cached embeddings.
// The VECTOR SEARCH itself happens in a vector store you choose (pgvector, Qdrant, ...).
import { createHash } from "node:crypto";
import { CelerisError, type Client } from "@celeris/client";
import { pad } from "./ids.js";

const sha = (s: string) => createHash("sha256").update(s).digest("hex");

export async function ingest(
  db: Client,
  doc: { id: string; title: string; text: string },
  model: string, // the embedding model name, part of the cache key
  chunk: (text: string) => string[],
  embed: (texts: string[]) => Promise<number[][]>, // your embedding call
  vectorStore: { upsert(id: string, vector: number[], meta: object): Promise<void> }, // your vector DB
) {
  const hash = sha(doc.text);
  const existing = await db.get<{ hash: string }>("docs/" + doc.id);
  if (existing?.value.hash === hash) return { skipped: true }; // unchanged content: nothing to do

  const chunks = chunk(doc.text);
  const hashes = chunks.map(sha);

  // 1. Embedding cache, keyed by content hash: identical text is never embedded twice.
  const vectors: (number[] | null)[] = [];
  for (const h of hashes) vectors.push((await db.get<number[]>("emb/" + model + "/" + h))?.value ?? null);
  const missing = vectors.flatMap((v, i) => (v ? [] : [i]));
  if (missing.length) {
    const fresh = await embed(missing.map((i) => chunks[i]!));
    for (const [j, i] of missing.entries()) {
      vectors[i] = fresh[j]!;
      try {
        await db.put("emb/" + model + "/" + hashes[i], fresh[j]!, { ifAbsent: true });
      } catch (e) {
        if (!(e instanceof CelerisError && e.code === "condition_failed")) throw e; // a concurrent ingest cached it
      }
    }
  }

  // 2. Chunk text and ids live in Celeris, so retrieval results can be turned back into text.
  for (const [i, text] of chunks.entries()) {
    const chunkId = doc.id + "/" + pad(i);
    await db.put("chunks/" + chunkId, { text, hash: hashes[i] });
    await vectorStore.upsert(chunkId, vectors[i]!, { doc: doc.id });
  }

  // 3. Write the document record last: it marks the ingest as complete.
  await db.put("docs/" + doc.id, { title: doc.title, hash, chunkCount: chunks.length });
  return { skipped: false };
}

// Query time: the vector store returns chunk ids, Celeris returns their text.
export async function chunkTexts(db: Client, chunkIds: string[]) {
  const items = await Promise.all(chunkIds.map((id) => db.get<{ text: string }>("chunks/" + id)));
  return items.map((i) => i?.value.text ?? "");
}
`;

/* ── Semantic cache ───────────────────────────────────────────────────── */

const CACHE_TS = `
import { createHash } from "node:crypto";
import type { Client } from "@celeris/client";

// Exact-match response cache. The key covers everything that changes the answer.
export function promptKey(model: string, params: object, prompt: string) {
  const norm = prompt.trim().replace(/\\s+/g, " ");
  return "llmcache/" + createHash("sha256").update(JSON.stringify([model, params, norm])).digest("hex");
}

export async function cachedCompletion(
  db: Client,
  key: string,
  ttlMs: number,
  call: () => Promise<{ text: string; usage?: unknown }>,
) {
  const hit = await db.get<{ text: string }>(key, { consistency: "eventual" });
  if (hit) return { ...hit.value, cached: true };
  const out = await call();
  await db.put(key, out, { ttlMs, consistency: "eventual" });
  return { ...out, cached: false };
}
`;

/* ── Prompt registry ──────────────────────────────────────────────────── */

const PROMPTS_TS = `
import { CelerisError, type Client } from "@celeris/client";
import { pad } from "./ids.js";

// prompts/<name>/v/<0001>   immutable versions
// prompts/<name>/latest     pointer to the live version, changed with compare-and-set

export async function publish(db: Client, name: string, version: number, template: string) {
  await db.put("prompts/" + name + "/v/" + pad(version, 4), { template }, { ifAbsent: true }); // never overwritten
}

export async function promote(db: Client, name: string, version: number) {
  const cur = await db.get("prompts/" + name + "/latest");
  try {
    await db.put("prompts/" + name + "/latest", { version }, cur ? { ifVersion: cur.version } : { ifAbsent: true });
  } catch (e) {
    if (e instanceof CelerisError && e.code === "condition_failed") throw new Error("another release changed the pointer");
    throw e;
  }
}

export async function loadPrompt(db: Client, name: string) {
  // bounded: any replica, never older than 5 seconds. A rollout takes effect within that window.
  const ptr = await db.get<{ version: number }>("prompts/" + name + "/latest", { consistency: "bounded", maxStalenessMs: 5000 });
  if (!ptr) throw new Error("no such prompt");
  const v = await db.get<{ template: string }>("prompts/" + name + "/v/" + pad(ptr.value.version, 4));
  return { version: ptr.value.version, template: v!.value.template };
}
`;

/* ── Budgets ──────────────────────────────────────────────────────────── */

const BUDGET_TS = `
import { CelerisError, type Client } from "@celeris/client";

// Daily token budget per user. Reserve before the call, correct afterwards.
export async function reserveTokens(db: Client, user: string, tokens: number, dailyLimit: number): Promise<boolean> {
  const day = new Date().toISOString().slice(0, 10);
  const key = "budget/" + user + "/" + day;
  for (let attempt = 0; attempt < 5; attempt++) {
    const cur = await db.get<{ used: number }>(key);
    const used = (cur?.value.used ?? 0) + tokens;
    if (used > dailyLimit) return false;
    try {
      const opts = { ttlMs: 2 * 24 * 3600 * 1000 };
      await db.put(key, { used }, cur ? { ...opts, ifVersion: cur.version } : { ...opts, ifAbsent: true });
      return true;
    } catch (e) {
      if (!(e instanceof CelerisError && e.code === "condition_failed")) throw e;
    }
  }
  return false; // contended: fail closed
}
`;

/* ── Streaming ────────────────────────────────────────────────────────── */

const STREAM_WORKER_TS = `
// worker: publish progress as ordinary writes (batch them, see the note below).
let text = "";
let last = 0;
for await (const piece of modelStream) {
  text += piece;
  if (Date.now() - last > 300) {
    await db.put("runs/" + runId + "/state", { status: "streaming", text });
    last = Date.now();
  }
}
await db.put("runs/" + runId + "/state", { status: "done", text });
`;

const STREAM_SSE_TS = `
// server: relay one run's changes to the browser as Server-Sent Events.
app.get("/runs/:id/events", (req, res) => {
  const prefix = "runs/" + req.params.id + "/"; // trailing slash: runs/1 must not match runs/10
  res.set({ "content-type": "text/event-stream", "cache-control": "no-cache" });
  res.flushHeaders();
  const send = (v: unknown) => res.write("data: " + JSON.stringify(v) + "\\n\\n");

  // Open the stream first, then read the current value, so no change falls in the gap.
  const watcher = db.watch<{ status: string; text: string }>(prefix, {
    onChange: (e) => e.value && send(e.value),
    onLagged: async () => {
      const cur = await db.get(prefix + "state"); // events were dropped: re-read
      if (cur) send(cur.value);
    },
    onClose: () => res.end(),
  });
  db.get(prefix + "state").then((cur) => cur && send(cur.value));
  req.on("close", () => watcher.close());
});
`;

/* ── Adapters ─────────────────────────────────────────────────────────── */

const LANGCHAIN = `
# celeris_history.py: example adapter, not a published package.
# Check the langchain_core docs for your version: these class and function names have moved before.
from celeris import CelerisError, Client
from langchain_core.chat_history import BaseChatMessageHistory
from langchain_core.messages import BaseMessage, message_to_dict, messages_from_dict

THIRTY_DAYS_MS = 30 * 24 * 3600 * 1000


class CelerisChatHistory(BaseChatMessageHistory):
    def __init__(self, db: Client, session_id: str, ttl_ms: int = THIRTY_DAYS_MS):
        self.db = db
        self.key = f"langchain/{session_id}"
        self.ttl_ms = ttl_ms

    @property
    def messages(self) -> list[BaseMessage]:
        item = self.db.get(self.key, consistency="session")
        return messages_from_dict(item.value["messages"]) if item else []

    def add_messages(self, messages) -> None:
        for _ in range(5):
            item = self.db.get(self.key)
            stored = (item.value["messages"] if item else []) + [message_to_dict(m) for m in messages]
            cond = {"if_version": item.version} if item else {"if_absent": True}
            try:
                self.db.put(self.key, {"messages": stored}, ttl_ms=self.ttl_ms, **cond)
                return
            except CelerisError as e:
                if e.code != "condition_failed":
                    raise
        raise RuntimeError("conversation is too contended")

    def clear(self) -> None:
        self.db.delete(self.key)


# Usage with RunnableWithMessageHistory:
#   chain = RunnableWithMessageHistory(
#       runnable, lambda sid: CelerisChatHistory(db, sid),
#       input_messages_key="input", history_messages_key="history")
#   chain.invoke({"input": "hi"}, config={"configurable": {"session_id": "abc"}})
`;

const LLAMAINDEX = `
# celeris_chat_store.py: a skeleton. BaseChatStore's exact fields and abstract methods
# differ between LlamaIndex versions, so compare with the version you have installed.
from typing import Any, List, Optional

from celeris import CelerisError, Client
from llama_index.core.llms import ChatMessage
from llama_index.core.storage.chat_store import BaseChatStore
from pydantic import PrivateAttr


class CelerisChatStore(BaseChatStore):
    _db: Client = PrivateAttr()

    def __init__(self, db: Client, **kwargs: Any):
        super().__init__(**kwargs)
        self._db = db

    @classmethod
    def class_name(cls) -> str:
        return "CelerisChatStore"

    def _k(self, key: str) -> str:
        return f"llamaindex/{key}"

    def set_messages(self, key: str, messages: List[ChatMessage]) -> None:
        self._db.put(self._k(key), [{"role": m.role.value, "content": m.content} for m in messages])

    def get_messages(self, key: str) -> List[ChatMessage]:
        item = self._db.get(self._k(key))
        return [ChatMessage(role=m["role"], content=m["content"]) for m in (item.value if item else [])]

    def add_message(self, key: str, message: ChatMessage) -> None:
        for _ in range(5):
            item = self._db.get(self._k(key))
            rows = (item.value if item else []) + [{"role": message.role.value, "content": message.content}]
            cond = {"if_version": item.version} if item else {"if_absent": True}
            try:
                self._db.put(self._k(key), rows, **cond)
                return
            except CelerisError as e:
                if e.code != "condition_failed":
                    raise
        raise RuntimeError("conversation is too contended")

    def delete_messages(self, key: str) -> Optional[List[ChatMessage]]:
        old = self.get_messages(key)
        self._db.delete(self._k(key))
        return old

    def delete_message(self, key: str, idx: int) -> Optional[ChatMessage]:
        msgs = self.get_messages(key)
        if not 0 <= idx < len(msgs):
            return None
        gone = msgs.pop(idx)
        self.set_messages(key, msgs)
        return gone

    def delete_last_message(self, key: str) -> Optional[ChatMessage]:
        msgs = self.get_messages(key)
        return self.delete_message(key, len(msgs) - 1) if msgs else None

    def get_keys(self) -> List[str]:
        return [i.key.removeprefix("llamaindex/") for i in self._db.scan(prefix="llamaindex/")]
`;

const VERCEL_AI = `
// app/api/chat/route.ts (Next.js + the Vercel AI SDK). The SDK's API differs between major
// versions: here "streamText" returns a result synchronously and "onFinish" receives the text.
import { streamText } from "ai";
import { openai } from "@ai-sdk/openai";
import { db } from "@/lib/celeris";
import { ChatMemory } from "@/lib/chat-memory";

export const runtime = "nodejs";

export async function POST(req: Request) {
  const { sessionId, text } = (await req.json()) as { sessionId: string; text: string };
  if (!/^[A-Za-z0-9_-]{1,64}$/.test(sessionId)) return new Response(null, { status: 400 });

  const memory = new ChatMemory(db, sessionId);
  await memory.append({ role: "user", content: text });

  const result = streamText({
    model: openai(process.env.OPENAI_MODEL!), // choose your model
    messages: await memory.last(30),
    onFinish: async ({ text }) => {
      await memory.append({ role: "assistant", content: text });
    },
  });
  return result.toTextStreamResponse();
}
`;

const OPENAI_TS = `
import OpenAI from "openai";
import { db } from "./celeris.js";
import { cachedCompletion, promptKey } from "./llm-cache.js";

const openai = new OpenAI(); // reads OPENAI_API_KEY from the environment
const MODEL = process.env.OPENAI_MODEL!;

export async function ask(prompt: string) {
  const key = promptKey(MODEL, { temperature: 0 }, prompt);
  return cachedCompletion(db, key, 24 * 3600 * 1000, async () => {
    const r = await openai.chat.completions.create({
      model: MODEL,
      temperature: 0,
      messages: [{ role: "user", content: prompt }],
    });
    return { text: r.choices[0]?.message.content ?? "", usage: r.usage };
  });
}
`;

const ANTHROPIC_TS = `
import Anthropic from "@anthropic-ai/sdk";
import { db } from "./celeris.js";
import { cachedCompletion, promptKey } from "./llm-cache.js";

const anthropic = new Anthropic(); // reads ANTHROPIC_API_KEY from the environment
const MODEL = process.env.ANTHROPIC_MODEL!;

export async function ask(prompt: string) {
  const key = promptKey(MODEL, { max_tokens: 1024 }, prompt);
  return cachedCompletion(db, key, 24 * 3600 * 1000, async () => {
    const r = await anthropic.messages.create({
      model: MODEL,
      max_tokens: 1024,
      messages: [{ role: "user", content: prompt }],
    });
    const text = r.content.flatMap((b) => (b.type === "text" ? [b.text] : [])).join("");
    return { text, usage: r.usage };
  });
}
`;

const OPENAI_PY = `
import os
from celeris import Client
from openai import OpenAI
from anthropic import Anthropic

db = Client(os.environ.get("CELERIS_NODES", "http://127.0.0.1:8080").split(","), token=os.environ.get("CELERIS_TOKEN"))


def cached(key: str, ttl_ms: int, call):
    hit = db.get(key, consistency="eventual")
    if hit:
        return hit.value
    out = call()
    db.put(key, out, ttl_ms=ttl_ms, consistency="eventual")
    return out


def ask_openai(prompt: str, key: str):
    client = OpenAI()
    def call():
        r = client.chat.completions.create(model=os.environ["OPENAI_MODEL"], messages=[{"role": "user", "content": prompt}])
        return {"text": r.choices[0].message.content or ""}
    return cached(key, 24 * 3600 * 1000, call)


def ask_anthropic(prompt: str, key: str):
    client = Anthropic()
    def call():
        r = client.messages.create(model=os.environ["ANTHROPIC_MODEL"], max_tokens=1024,
                                   messages=[{"role": "user", "content": prompt}])
        return {"text": "".join(b.text for b in r.content if b.type == "text")}
    return cached(key, 24 * 3600 * 1000, call)
`;

const MCP_TS = `
// mcp-notes-server.ts: a sketch of a tool server that gives a model a small memory in Celeris.
// The MCP SDK evolves quickly: check its current docs for the registration call and imports.
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { Client } from "@celeris/client";

const db = new Client({
  nodes: (process.env.CELERIS_NODES ?? "http://127.0.0.1:8080").split(","),
  token: process.env.CELERIS_TOKEN, // a token scoped read+write, never admin
});

const topic = z.string().regex(/^[a-z0-9-]{1,40}$/); // the model cannot choose arbitrary keys
const server = new McpServer({ name: "celeris-notes", version: "0.1.0" });

server.tool("remember", { topic, text: z.string().max(4000) }, async ({ topic, text }) => {
  await db.put("mcp/notes/" + topic, { text }, { ttlMs: 30 * 24 * 3600 * 1000 });
  return { content: [{ type: "text" as const, text: "saved " + topic }] };
});

server.tool("recall", { topic }, async ({ topic }) => {
  const item = await db.get<{ text: string }>("mcp/notes/" + topic);
  return { content: [{ type: "text" as const, text: item ? item.value.text : "nothing stored for " + topic }] };
});

// On stdio, stdout carries the protocol: log to stderr only.
await server.connect(new StdioServerTransport());
`;

const PII_TS = `
// Encrypt a sensitive field before it reaches Celeris (AES-256-GCM, key from your secret manager).
import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";

export function seal(plain: string, key: Buffer /* 32 bytes */) {
  const iv = randomBytes(12);
  const c = createCipheriv("aes-256-gcm", key, iv);
  const data = Buffer.concat([c.update(plain, "utf8"), c.final()]);
  return { iv: iv.toString("base64"), tag: c.getAuthTag().toString("base64"), data: data.toString("base64") };
}

export function open(box: { iv: string; tag: string; data: string }, key: Buffer) {
  const d = createDecipheriv("aes-256-gcm", key, Buffer.from(box.iv, "base64"));
  d.setAuthTag(Buffer.from(box.tag, "base64"));
  return Buffer.concat([d.update(Buffer.from(box.data, "base64")), d.final()]).toString("utf8");
}

// await db.put("chat/" + sid + "/...", { role: "user", content: seal(text, key) }, { ttlMs });
`;

function Body() {
  return (
    <>
      <p>
        AI applications are mostly state: conversation history, agent progress, tool results, cached model output, prompts, budgets and metadata about
        documents. That state needs to survive crashes, be safe to retry (agents retry constantly), and expire on its own. CelerisDB fits that job. It
        stores JSON values under keys, with TTLs, compare-and-set, idempotent writes with mutation IDs, prefix scans, filtered queries and live change
        streams, and lets you pick a consistency level per call.
      </p>
      <Callout kind="danger" title="CelerisDB is not a vector database">
        There is no vector type, no similarity search and no nearest-neighbor index. Do not store embeddings in Celeris and expect to search them.
        What you can do is keep the documents, chunk text, metadata and a cache of computed embeddings in Celeris, and run the actual similarity
        search in a vector store such as pgvector, Qdrant or an in-memory index. The RAG section below shows that division of labor.
      </Callout>
      <p>
        Everything on this page is an <strong>example pattern</strong> built on the public SDKs (TypeScript and Python here; Go and Rust work the same
        way) and the <DocLink to="http-api">HTTP API</DocLink>. The adapters for LangChain, LlamaIndex, the Vercel AI SDK, OpenAI, Anthropic and MCP
        are small files you copy into your project and own. They are not published packages, they are not official integrations, and the third-party
        libraries they touch change often, so verify each against the version you use. Model names are left as environment variables on purpose.
      </p>

      <H2 id="map">What goes where</H2>
      <Table
        head={["Need", "Key layout", "Consistency", "Why"]}
        rows={[
          ["Chat history", "chat/<session>/<n>", "session or strict", "Read-your-writes within a conversation; per-message TTL"],
          ["Agent state", "agent/<run>/state", "strict", "Compare-and-set so two runners cannot both advance a run"],
          ["Tool results", "agent/<run>/tool/<call>", "strict", "Claim with ifAbsent, record with a deterministic mutation ID"],
          ["Document metadata, chunks", "docs/<id>, chunks/<id>/<n>", "strict or bounded", "Source of truth for text behind vector hits"],
          ["Embedding cache", "emb/<model>/<hash>", "eventual", "A miss only costs a recompute"],
          ["Response cache", "llmcache/<hash>", "eventual", "Stale or missing entries are harmless"],
          ["Prompt registry", "prompts/<name>/...", "bounded", "Rollouts visible within a bounded delay"],
          ["Token budgets", "budget/<user>/<day>", "strict", "A counter must not be read stale"],
          ["Live run updates", "runs/<id>/state", "strict, plus a change stream", "UI follows the run"],
        ]}
      />

      <H2 id="chat">Chat history and conversation memory</H2>
      <p>
        Store one key per message, ordered so that the last N messages are one cheap scan. Scans return keys in ascending order and cannot be
        reversed, so the sequence number is stored inverted (<code>999999 - seq</code>), which puts the newest message first. A TTL on every message
        means old conversations expire without a cleanup job. Because the TTL is per message, the oldest messages of a conversation disappear
        first.
      </p>
      <p>
        <code>ifAbsent</code> on each append is the safety net for two writers on one conversation: the second one gets{" "}
        <code>condition_failed</code>, recomputes the sequence number and retries, so no message overwrites another. Reads use the same client, which
        remembers the session token, so an assistant reply written a moment ago is visible to the next read even if it lands on a different replica.
        See <DocLink to="consistency">Consistency</DocLink>.
      </p>
      <Code lang="ts" title="ids.ts">
        {IDS_TS}
      </Code>
      <Code lang="ts" title="chat-memory.ts">
        {CHAT_TS}
      </Code>
      <Callout kind="note" title="Long conversations">
        Do not send an unbounded history to a model. Load the last N messages, and when a conversation grows, write a summary under a separate
        key (for example <code>chat-summary/&lt;session&gt;</code>) and drop the summarized messages. Keep each value well under the 4 MiB per-value limit.
      </Callout>

      <H2 id="agent-state">Agent state and checkpoints</H2>
      <p>
        An agent run is a loop: ask the model, run a tool, append the result, repeat. If the process dies mid-loop you want to resume, and if two
        workers pick up the same run you want exactly one of them to win. Compare-and-set does both. The run state is one key; every save says{" "}
        <em>write only if the version is still the one I loaded</em>. A second worker that tries to advance the same step gets{" "}
        <code>condition_failed</code> and stops. Immutable per-step checkpoints (<code>ifAbsent</code>) give you a trail to inspect or rewind.
      </p>
      <Code lang="ts" title="agent-state.ts">
        {AGENT_STATE_TS}
      </Code>

      <H2 id="tool-idempotency">Tool-call idempotency</H2>
      <p>
        The worst agent bug is a retried tool call that runs twice: two emails, two charges, two tickets. Here is exactly what protects you, in
        layers, and where the protection ends.
      </p>
      <H3 id="tool-layers">The layers</H3>
      <ol>
        <li>
          <strong>A stable identity for the call.</strong> The call ID is derived from the run and the step, not generated on each attempt. After a
          crash the loop reads back the model{"'"}s saved decision (see the loop below) so the call ID is the same one as before.
        </li>
        <li>
          <strong>A claim record.</strong> The worker writes <code>agent/&lt;run&gt;/tool/&lt;call&gt;</code> with <code>ifAbsent</code> and a TTL
          (the lease). Exactly one worker wins that write, even if several run the same step at once. The others get <code>condition_failed</code>{" "}
          and look at the record instead of running the tool.
        </li>
        <li>
          <strong>A result record with a deterministic mutation ID.</strong> The winner runs the tool and records the result with a mutation ID that is
          a function of (run, call, "done"). Celeris remembers mutation IDs (24 hours by default, <code>storage.mutation_retention_secs</code>) and commits
          the ID atomically with the data. If the response is lost and the SDK or your framework resends, the server answers with{" "}
          <code>deduplicated: true</code> and the original version instead of writing again. If the same ID arrives with a different payload, it is
          rejected with <code>mutation_id_reused</code> and nothing is overwritten, so the first recorded result wins.
        </li>
        <li>
          <strong>Replays read the record.</strong> A replayed step finds status <code>done</code> and returns the stored result without calling the
          tool.
        </li>
      </ol>
      <H3 id="tool-limits">Where the guarantee ends</H3>
      <p>
        Celeris can make the <em>bookkeeping</em> exactly-once. It cannot see inside your tool. If a worker crashes after the tool ran but before the
        result was recorded, the lease eventually expires, the key disappears and the next worker runs the tool again. For that window the tool has
        run at-least-once. Close it by passing the call ID as the provider{"'"}s own idempotency key (Stripe, most payment and many email APIs support
        one) which the example does through the <code>execute(callId)</code> argument. Choose the lease longer than the tool{"'"}s worst-case run time.
      </p>
      <Callout kind="warn" title="Do not give the claim a deterministic mutation ID">
        If the claim used a fixed ID, then after a lease expired the second claim would be treated as a duplicate of the first (same ID, already
        committed) and would not recreate the key. The claim uses a fresh ID per attempt, which the SDK still reuses across its own network retries.
        Only the result write uses the deterministic ID, because that write should happen once per call no matter how many times it is attempted.
      </Callout>
      <Code lang="ts" title="tool-once.ts">
        {TOOL_TS}
      </Code>
      <p>
        The loop saves the model{"'"}s decision <em>before</em> executing it. Without that, a crash followed by a fresh model call could produce a
        different tool call with a different ID and defeat the whole scheme. Resuming then costs nothing: finished steps return stored results.
      </p>
      <Code lang="ts" title="agent-loop.ts">
        {LOOP_TS}
      </Code>
      <CodeTabs
        group="sdk-lang"
        items={[
          { id: "ts", label: "TypeScript", lang: "ts", code: IDS_TS, title: "stable IDs" },
          { id: "py", label: "Python", lang: "py", code: IDS_PY, title: "stable IDs" },
        ]}
      />
      <p>
        Mutation IDs must be UUIDs, which is why the helpers hash the parts into one. See{" "}
        <DocLink to="reads-writes">Reads and writes</DocLink> for mutation IDs and <code>mutationStatus</code>.
      </p>

      <H2 id="rag">RAG: document metadata, chunks and an embedding cache</H2>
      <p>
        In a retrieval pipeline Celeris holds the parts that are ordinary data: the document record, the chunk text, and a cache of embeddings keyed by
        a hash of the chunk text and the model name. The cache means re-ingesting an unchanged document, or two documents that share a paragraph, never
        pays for the same embedding twice. Queries work like this: your vector store finds the nearest chunk ids, and Celeris turns ids back into text
        and metadata.
      </p>
      <Code lang="ts" title="rag-ingest.ts">
        {RAG_TS}
      </Code>
      <p>
        Because the document record is written last, a crash mid-ingest leaves no completed record, and the next run redoes the work cheaply from the
        embedding cache. To list or filter documents by metadata, use a prefix scan or a <DocLink to="queries">filtered query</DocLink> over{" "}
        <code>docs/</code>. A stored embedding is a JSON array of numbers, so size it accordingly (the limit is 4 MiB per value) and do not scan the
        embedding cache expecting a vector search.
      </p>

      <H2 id="semantic-cache">Prompt response cache</H2>
      <p>
        An exact-match cache stores the response under a hash of the model, parameters and normalized prompt, with a TTL. It is simple and always
        correct for repeated identical requests. A cache miss or an expired entry only costs a model call, so reads and writes use{" "}
        <code>eventual</code> consistency, the fastest mode.
      </p>
      <Callout kind="note" title="Exact, not semantic">
        Matching paraphrases (a true semantic cache) requires comparing embeddings, which Celeris cannot do. If you want that, find the nearest earlier
        prompt in a vector store and use its id to look up the stored response in Celeris.
      </Callout>
      <Code lang="ts" title="llm-cache.ts">
        {CACHE_TS}
      </Code>

      <H2 id="prompts">Prompt and version registry</H2>
      <p>
        Prompt versions are immutable keys written with <code>ifAbsent</code>, and a single <code>latest</code> pointer moves between them with
        compare-and-set. Rolling back is moving the pointer. Services read the pointer with <code>bounded</code> consistency, so a rollout reaches
        every replica within the bound you choose, with no restart.
      </p>
      <Code lang="ts" title="prompts.ts">
        {PROMPTS_TS}
      </Code>

      <H2 id="budgets">Rate limits and token budgets</H2>
      <p>
        A budget is a counter, and Celeris has no server-side increment, so counters are a compare-and-set loop. That is fine for per-user daily
        budgets, where contention on one key is low. It is the wrong tool for a global counter that every request touches. Reserve tokens before the
        call using an estimate, and optionally correct the figure afterwards with the real usage. For per-minute request limits see the{" "}
        <DocLink to="frameworks:pattern-rate-limit">rate-limit pattern</DocLink>.
      </p>
      <Code lang="ts" title="budget.ts">
        {BUDGET_TS}
      </Code>

      <H2 id="streaming">Streaming UI updates through change streams</H2>
      <p>
        Change streams push every change under a key prefix over a WebSocket. A background worker writes the state of a run, and any number of
        browser sessions watch it. The server opens the stream and then reads the current value, so no update falls into the gap, and re-reads on a{" "}
        <code>lagged</code> notice, which means events were dropped.
      </p>
      <Code lang="ts" title="worker">
        {STREAM_WORKER_TS}
      </Code>
      <Code lang="ts" title="Express relay to Server-Sent Events">
        {STREAM_SSE_TS}
      </Code>
      <Callout kind="warn" title="Batch your writes, and know what the stream is">
        Every write is a durable, replicated commit (with the default settings, an fsync on a quorum of replicas). Writing once per token is wasteful
        and slow; write every few hundred milliseconds or per sentence, as above, and stream raw tokens to the user directly from the model call if
        you need token-level latency. Change streams are best-effort and start at "now": they do not replay history, and a node may cover only some
        replica sets (<code>hello.partial</code>). Treat them as a hint to re-read, not as a log. See{" "}
        <DocLink to="change-streams">Change streams</DocLink>.
      </Callout>

      <H2 id="adapters">Framework adapters (copy and adapt)</H2>
      <p>
        These are small adapters over the Python and TypeScript SDKs. They are written conservatively against the libraries{"'"} documented
        interfaces, but those interfaces move between releases, so treat them as a starting point and run them against your versions.
      </p>
      <H3 id="langchain">LangChain: chat message history</H3>
      <Code lang="py" title="celeris_history.py">
        {LANGCHAIN}
      </Code>
      <H3 id="llamaindex">LlamaIndex: chat store</H3>
      <Code lang="py" title="celeris_chat_store.py">
        {LLAMAINDEX}
      </Code>
      <H3 id="vercel-ai">Vercel AI SDK: route handler with memory</H3>
      <p>
        Uses the <code>ChatMemory</code> class from the chat section.
      </p>
      <Code lang="ts" title="app/api/chat/route.ts">
        {VERCEL_AI}
      </Code>
      <H3 id="custom-loop">Custom agent loop</H3>
      <p>
        The <a href="#tool-idempotency">tool-call idempotency</a> section contains a complete resumable loop. It does not depend on any agent
        framework: pass in your own <code>callModel</code> and tool functions.
      </p>

      <H2 id="providers">OpenAI and Anthropic call wrappers</H2>
      <p>
        These wrap a provider call in the response cache above, so a repeated request is answered from Celeris. They use each vendor{"'"}s official
        client in its basic documented form; set the model in an environment variable. Concurrent identical requests can both miss the cache and both
        call the provider. If the call is expensive, put a claim around it as <code>runToolOnce</code> does.
      </p>
      <CodeTabs
        group="ai-provider"
        items={[
          { id: "openai", label: "OpenAI (TS)", lang: "ts", code: OPENAI_TS },
          { id: "anthropic", label: "Anthropic (TS)", lang: "ts", code: ANTHROPIC_TS },
          { id: "py", label: "Both (Python)", lang: "py", code: OPENAI_PY },
        ]}
      />

      <H2 id="mcp">An MCP-style tool server</H2>
      <p>
        The Model Context Protocol lets a model client call tools that you host. A small tool server can give a model durable notes backed by Celeris. The
        important design rules matter more than the exact SDK calls: expose a few narrow tools instead of generic get and put, constrain the keys the
        model can touch to one prefix, validate input, cap sizes, use a read and write token rather than an admin one, and add TTLs so memory does not
        grow forever.
      </p>
      <Code lang="ts" title="mcp-notes-server.ts">
        {MCP_TS}
      </Code>

      <H2 id="regions">Multi-region considerations</H2>
      <p>
        Be careful with global AI deployments. A Celeris cluster is a single group of nodes with Raft-replicated data. A strict write or read
        needs a quorum round trip, so putting nodes in far-apart regions adds that distance to every strict operation. The recommended shape is one
        region, with nodes spread over availability zones. Nothing in the repository provides automatic cross-cluster replication.
      </p>
      <ul>
        <li>
          <strong>Route by home region.</strong> Keep each user or tenant{"'"}s conversations in the cluster of their home region and route requests
          there at the application layer.
        </li>
        <li>
          <strong>Do not use <code>available</code> writes for agent state or chat appends.</strong> Concurrent writes on different nodes are resolved
          by last-writer-wins and the loser is discarded (recorded as a conflict), and conditional writes are refused in that mode. Fine for caches,
          wrong for checkpoints.
        </li>
        <li>
          <strong>Caches can be regional.</strong> Response and embedding caches are safe to recompute, so a cluster per region is fine.
        </li>
        <li>
          <strong>Moving data</strong> between clusters is a job for <code>celeris export</code> and <code>import</code> (see{" "}
          <DocLink to="backup-restore">Backup and restore</DocLink>).
        </li>
      </ul>

      <H2 id="privacy">Privacy: what Celeris does and does not do</H2>
      <p>Conversations contain personal data. Plan for these facts rather than assuming more than the database provides.</p>
      <Table
        head={["Topic", "What CelerisDB does", "What it does not do"]}
        rows={[
          [
            "Expiry (TTL)",
            "Expired values stop being returned. Set ttlMs on every key that holds user content.",
            "It does not instantly erase bytes. Expired and deleted data is kept for storage.tombstone_retention_secs (24 hours by default) before compaction may drop it.",
          ],
          [
            "Deletion",
            "delete removes a key from reads.",
            "It does not remove copies in backups, exports (which carry absolute expiry times) or snapshots you took. Include them in your retention policy.",
          ],
          [
            "Encryption in transit",
            "HTTPS for the client API (CELERIS_TLS_CERT and CELERIS_TLS_KEY) and mutual TLS for the cluster port (CELERIS_CLUSTER_TLS_*).",
            "TLS is off until you configure it. Plain HTTP is the default.",
          ],
          [
            "Encryption at rest",
            "Nothing: data files are not encrypted by the database.",
            "There is no built-in at-rest encryption or key management. Use an encrypted disk or volume (BitLocker, FileVault, LUKS, or your cloud provider's volume encryption) and encrypt backups.",
          ],
          [
            "Authentication",
            "Bearer tokens with read, write and admin scopes. Only the SHA-256 of each token is stored.",
            "Scopes are not per key or per tenant, and there are no per-user permissions.",
          ],
          [
            "Field-level protection",
            "Stores whatever JSON you give it.",
            "It cannot encrypt or redact fields for you. Encrypt sensitive fields in your app (example below). Encrypted fields cannot be filtered or sorted by queries.",
          ],
        ]}
      />
      <Code lang="ts" title="Application-level field encryption">
        {PII_TS}
      </Code>
      <p>
        Practical defaults for AI data: keep a TTL on every message and tool result, avoid putting secrets or raw credentials into tool results, minimise
        what you log, scope tokens to the least privilege that works, and put the whole cluster on a private network. See{" "}
        <DocLink to="security">Security</DocLink> for the full hardening list.
      </p>

      <H2 id="next">Next steps</H2>
      <ul>
        <li>
          The mechanics behind this page: <DocLink to="reads-writes">Reads and writes</DocLink>, <DocLink to="consistency">Consistency</DocLink> and{" "}
          <DocLink to="change-streams">Change streams</DocLink>.
        </li>
        <li>
          Web framework wiring: <DocLink to="frameworks">Frameworks and runtimes</DocLink>.
        </li>
        <li>
          Production deployment: <DocLink to="cloud">Cloud platforms</DocLink> and <DocLink to="production-checklist">Production checklist</DocLink>.
        </li>
      </ul>
    </>
  );
}

export const page: DocPage = {
  slug: "ai",
  title: "AI and LLM applications",
  group: "Integrations",
  summary: "Chat memory, agent checkpoints, safe tool-call retries and RAG metadata as example patterns. Not a vector database.",
  keywords: [
    "llm",
    "agent",
    "chatbot",
    "conversation memory",
    "chat history",
    "rag",
    "retrieval",
    "embeddings cache",
    "vector",
    "semantic cache",
    "langchain",
    "llamaindex",
    "vercel ai sdk",
    "openai",
    "anthropic",
    "claude",
    "mcp",
    "tool call",
    "idempotency",
    "checkpoint",
    "prompt registry",
    "token budget",
    "pii",
    "privacy",
  ],
  Body,
};
