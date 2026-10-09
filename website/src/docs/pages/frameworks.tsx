import {
  Callout,
  Code,
  CodeTabs,
  DocLink,
  H2,
  H3,
  OsCode,
  Step,
  Steps,
  Table,
  Tabs,
  type DocPage,
} from "../kit";
import { IntegrationMap } from "../demos/IntegrationMap";

/* ── Shared setup ─────────────────────────────────────────────────────── */

const TS_CLIENT = `
// celeris.ts: one client per process.
import { Client } from "@celeris/client";

export const db = new Client({
  // One URL, a list of node URLs, or one internal load balancer URL.
  nodes: (process.env.CELERIS_NODES ?? "http://127.0.0.1:8080").split(","),
  // Server side only. Never put this value in browser code.
  token: process.env.CELERIS_TOKEN,
  timeoutMs: 5000,
});
`;

const EXPRESS = `
// server.ts
import express from "express";
import { CelerisError, OutcomeUnknownError } from "@celeris/client";
import { db } from "./celeris.js";

const app = express();
app.use(express.json());

// Keys may contain "/", so never put raw user input into a key.
const ID = /^[A-Za-z0-9_-]{1,64}$/;

app.get("/users/:id", async (req, res) => {
  if (!ID.test(req.params.id)) return res.sendStatus(400);
  try {
    const item = await db.get("users/" + req.params.id);
    if (!item) return res.sendStatus(404);
    res.set("etag", String(item.version)).json(item.value);
  } catch (e) {
    fail(res, e);
  }
});

app.put("/users/:id", async (req, res) => {
  if (!ID.test(req.params.id)) return res.sendStatus(400);
  // Optional optimistic concurrency: If-Match carries the version you read.
  const ifMatch = req.header("if-match");
  try {
    const out = await db.put("users/" + req.params.id, req.body, {
      ifVersion: ifMatch ? Number(ifMatch) : undefined,
    });
    res.status(200).json({ version: out.version, deduplicated: out.deduplicated });
  } catch (e) {
    fail(res, e);
  }
});

function fail(res: express.Response, e: unknown) {
  // OutcomeUnknownError extends CelerisError, so test it first.
  if (e instanceof OutcomeUnknownError) {
    return res.status(202).json({ status: "unknown", mutationId: e.mutationId });
  }
  if (e instanceof CelerisError && e.code === "condition_failed") {
    return res.status(412).json({ error: "version changed" });
  }
  console.error(e);
  res.status(502).json({ error: "database unavailable" });
}

app.listen(3000, () => console.log("listening on http://127.0.0.1:3000"));
`;

const FASTIFY = `
// server.ts
import Fastify from "fastify";
import { Client, CelerisError } from "@celeris/client";

declare module "fastify" {
  interface FastifyInstance {
    celeris: Client;
  }
}

const app = Fastify({ logger: true });
app.decorate(
  "celeris",
  new Client({
    nodes: (process.env.CELERIS_NODES ?? "http://127.0.0.1:8080").split(","),
    token: process.env.CELERIS_TOKEN,
  }),
);

app.get<{ Params: { id: string } }>("/flags/:id", async (req, reply) => {
  // Flags tolerate a little staleness, so read from any replica.
  const item = await app.celeris.get("flags/" + req.params.id, { consistency: "eventual" });
  return item ? item.value : reply.code(404).send({ error: "unknown flag" });
});

app.setErrorHandler((err, _req, reply) => {
  if (err instanceof CelerisError) return reply.code(502).send({ error: err.code });
  return reply.send(err);
});

await app.listen({ port: 3000, host: "127.0.0.1" });
`;

const NEXT_LIB = `
// lib/celeris.ts
import { Client } from "@celeris/client";

const g = globalThis as unknown as { __celeris?: Client };

export const db =
  g.__celeris ??
  (g.__celeris = new Client({
    nodes: (process.env.CELERIS_NODES ?? "http://127.0.0.1:8080").split(","),
    token: process.env.CELERIS_TOKEN,
    // Next.js can cache fetch results. Database calls must never be cached.
    fetch: (url, init) => fetch(url, { ...init, cache: "no-store" }),
  }));
`;

const NEXT_ROUTE = `
// app/api/users/[id]/route.ts  (Next.js 15 style; in 14 "params" is a plain object)
import { NextResponse } from "next/server";
import { db } from "@/lib/celeris";

export const runtime = "nodejs"; // see the edge runtime note below
export const dynamic = "force-dynamic";

type Ctx = { params: Promise<{ id: string }> };

export async function GET(_req: Request, { params }: Ctx) {
  const { id } = await params;
  if (!/^[A-Za-z0-9_-]{1,64}$/.test(id)) return new NextResponse(null, { status: 400 });
  const item = await db.get("users/" + id, { consistency: "session" });
  return item ? NextResponse.json(item.value) : new NextResponse(null, { status: 404 });
}

export async function PUT(req: Request, { params }: Ctx) {
  const { id } = await params;
  if (!/^[A-Za-z0-9_-]{1,64}$/.test(id)) return new NextResponse(null, { status: 400 });
  const body = await req.json();
  const out = await db.put("users/" + id, body);
  return NextResponse.json({ version: out.version });
}
`;

const NEXT_ACTION = `
// app/profile/actions.ts
"use server";

import { revalidatePath } from "next/cache";
import { CelerisError } from "@celeris/client";
import { db } from "@/lib/celeris";

export async function renameUser(id: string, version: number, name: string) {
  try {
    // Compare-and-set: fails if someone else saved first.
    await db.put("users/" + id, { name }, { ifVersion: version });
  } catch (e) {
    if (e instanceof CelerisError && e.code === "condition_failed") {
      return { ok: false as const, reason: "Someone else changed this profile. Reload and try again." };
    }
    throw e;
  }
  revalidatePath("/profile/" + id);
  return { ok: true as const };
}
`;

const NEST = `
// celeris.module.ts
import { Global, Module } from "@nestjs/common";
import { Client } from "@celeris/client";

export const CELERIS = Symbol("CELERIS");

@Global()
@Module({
  providers: [
    {
      provide: CELERIS,
      useFactory: () =>
        new Client({
          nodes: (process.env.CELERIS_NODES ?? "http://127.0.0.1:8080").split(","),
          token: process.env.CELERIS_TOKEN,
        }),
    },
  ],
  exports: [CELERIS],
})
export class CelerisModule {}

// users.service.ts
import { Inject, Injectable, NotFoundException } from "@nestjs/common";
import { Client } from "@celeris/client";
import { CELERIS } from "./celeris.module";

@Injectable()
export class UsersService {
  constructor(@Inject(CELERIS) private readonly db: Client) {}

  async find(id: string) {
    const item = await this.db.get("users/" + id);
    if (!item) throw new NotFoundException();
    return item.value;
  }
}
`;

const REACT = `
// Profile.tsx (browser). The token below must be a read-scoped token that you
// are comfortable exposing, or use a same-origin proxy that adds the token.
import { Client } from "@celeris/client";
import { useCeleris } from "@celeris/client/react";

const db = new Client({ nodes: "https://celeris.example.com" /* no token: proxy adds it */ });

type User = { name: string };

export function Profile({ id }: { id: string }) {
  const { data, loading, error, refresh } = useCeleris<User>(db, "users/" + id);
  if (loading) return <p>Loading...</p>;
  if (error) return <button onClick={() => refresh()}>Retry</button>;
  return <h1>{data?.name ?? "No such user"}</h1>;
}
`;

const FASTAPI = `
# main.py
import os
from contextlib import asynccontextmanager

from celeris import CelerisError, Client, OutcomeUnknownError
from fastapi import Depends, FastAPI, HTTPException, Request
from pydantic import BaseModel


@asynccontextmanager
async def lifespan(app: FastAPI):
    app.state.db = Client(
        os.environ.get("CELERIS_NODES", "http://127.0.0.1:8080").split(","),
        token=os.environ.get("CELERIS_TOKEN"),
        timeout=5.0,
    )
    yield
    # The client holds no open sockets, so there is nothing to close.


app = FastAPI(lifespan=lifespan)


def get_db(request: Request) -> Client:
    return request.app.state.db


class User(BaseModel):
    name: str


# Plain "def" handlers run in FastAPI's thread pool. The Python client is
# synchronous, so "async def" handlers would block the event loop.
@app.get("/users/{user_id}")
def read_user(user_id: str, db: Client = Depends(get_db)):
    item = db.get(f"users/{user_id}", consistency="session")
    if item is None:
        raise HTTPException(404)
    return {"version": item.version, **item.value}


@app.put("/users/{user_id}")
def write_user(user_id: str, user: User, db: Client = Depends(get_db)):
    try:
        out = db.put(f"users/{user_id}", user.model_dump())
    except OutcomeUnknownError as e:
        raise HTTPException(202, {"status": "unknown", "mutation_id": e.mutation_id})
    except CelerisError as e:
        raise HTTPException(502, e.code)
    return {"version": out.version}
`;

const FLASK = `
# app.py
import os

from celeris import CelerisError, Client
from flask import Flask, abort, jsonify, request

app = Flask(__name__)
# Module level: with gunicorn each worker process builds one client.
db = Client(
    os.environ.get("CELERIS_NODES", "http://127.0.0.1:8080").split(","),
    token=os.environ.get("CELERIS_TOKEN"),
)


@app.get("/notes/<note_id>")
def get_note(note_id: str):
    item = db.get(f"notes/{note_id}")
    if item is None:
        abort(404)
    return jsonify(item.value)


@app.put("/notes/<note_id>")
def put_note(note_id: str):
    out = db.put(f"notes/{note_id}", request.get_json(force=True), ttl_ms=7 * 24 * 3600 * 1000)
    return jsonify(version=out.version)


@app.errorhandler(CelerisError)
def celeris_error(e: CelerisError):
    return jsonify(error=e.code), 502
`;

const DJANGO = `
# myproject/celeris_cache.py  (a sketch, not a published package)
import json
from django.core.cache.backends.base import DEFAULT_TIMEOUT, BaseCache
from celeris import CelerisError, Client

NAMESPACE = "dj/"


class CelerisCache(BaseCache):
    """Django cache backed by Celeris. Values must be JSON-serializable."""

    def __init__(self, server, params):
        super().__init__(params)
        opts = params.get("OPTIONS", {})
        self._db = Client(server.split(","), token=opts.get("token"), consistency=opts.get("consistency"))

    def _key(self, key, version):
        return NAMESPACE + self.make_key(key, version=version)

    def _ttl_ms(self, timeout):
        if timeout == DEFAULT_TIMEOUT:
            timeout = self.default_timeout
        if timeout is None:
            return None  # no expiry
        if timeout <= 0:
            return 0  # Django semantics: do not keep
        return max(1, int(timeout * 1000))

    def get(self, key, default=None, version=None):
        item = self._db.get(self._key(key, version))
        return default if item is None else item.value

    def set(self, key, value, timeout=DEFAULT_TIMEOUT, version=None):
        ttl = self._ttl_ms(timeout)
        if ttl == 0:
            self.delete(key, version)
            return
        self._db.put(self._key(key, version), value, ttl_ms=ttl)

    def add(self, key, value, timeout=DEFAULT_TIMEOUT, version=None):
        ttl = self._ttl_ms(timeout)
        if ttl == 0:
            return False
        try:
            self._db.put(self._key(key, version), value, ttl_ms=ttl, if_absent=True)
            return True
        except CelerisError as e:
            if e.code == "condition_failed":
                return False
            raise

    def touch(self, key, timeout=DEFAULT_TIMEOUT, version=None):
        k = self._key(key, version)
        item = self._db.get(k)
        if item is None:
            return False
        try:
            self._db.put(k, item.value, ttl_ms=self._ttl_ms(timeout), if_version=item.version)
            return True
        except CelerisError as e:
            if e.code == "condition_failed":
                return False
            raise

    def delete(self, key, version=None):
        self._db.delete(self._key(key, version))
        return True

    def clear(self):
        for item in self._db.scan(prefix=NAMESPACE):
            self._db.delete(item.key)
`;

const DJANGO_SETTINGS = `
# settings.py
CACHES = {
    "default": {
        "BACKEND": "myproject.celeris_cache.CelerisCache",
        "LOCATION": "http://10.0.1.10:8080,http://10.0.2.10:8080,http://10.0.3.10:8080",
        "KEY_PREFIX": "shop",
        "TIMEOUT": 300,
        "OPTIONS": {"token": os.environ.get("CELERIS_TOKEN"), "consistency": "session"},
    }
}

# Sessions in the cache (they must stay JSON-serializable).
SESSION_ENGINE = "django.contrib.sessions.backends.cache"
SESSION_CACHE_ALIAS = "default"
`;

const GO_HTTP = `
// main.go
package main

import (
	"encoding/json"
	"errors"
	"log"
	"net/http"
	"os"
	"regexp"
	"strings"

	celeris "github.com/vinitpatil519/CelerisDB/sdks/go"
)

var idRe = regexp.MustCompile("^[A-Za-z0-9_-]{1,64}$")

func main() {
	nodes := os.Getenv("CELERIS_NODES")
	if nodes == "" {
		nodes = "http://127.0.0.1:8080"
	}
	// One client for the whole process. It is safe for concurrent use.
	db, err := celeris.New(celeris.Options{
		Nodes: strings.Split(nodes, ","),
		Token: os.Getenv("CELERIS_TOKEN"),
	})
	if err != nil {
		log.Fatal(err)
	}

	mux := http.NewServeMux()

	mux.HandleFunc("GET /users/{id}", func(w http.ResponseWriter, r *http.Request) {
		id := r.PathValue("id")
		if !idRe.MatchString(id) {
			http.Error(w, "bad id", http.StatusBadRequest)
			return
		}
		item, err := db.Get(r.Context(), "users/"+id, &celeris.ReadOptions{Consistency: celeris.Session})
		if err != nil {
			http.Error(w, "database unavailable", http.StatusBadGateway)
			return
		}
		if item == nil {
			http.NotFound(w, r)
			return
		}
		w.Header().Set("Content-Type", "application/json")
		w.Write(item.Value) // already JSON
	})

	mux.HandleFunc("PUT /users/{id}", func(w http.ResponseWriter, r *http.Request) {
		id := r.PathValue("id")
		if !idRe.MatchString(id) {
			http.Error(w, "bad id", http.StatusBadRequest)
			return
		}
		var body map[string]any
		if err := json.NewDecoder(http.MaxBytesReader(w, r.Body, 1<<20)).Decode(&body); err != nil {
			http.Error(w, "invalid json", http.StatusBadRequest)
			return
		}
		res, err := db.Put(r.Context(), "users/"+id, body, nil)
		var unknown *celeris.OutcomeUnknownError
		switch {
		case errors.As(err, &unknown):
			// The write may have committed. Report it as such.
			w.WriteHeader(http.StatusAccepted)
			json.NewEncoder(w).Encode(map[string]string{"status": "unknown", "mutationId": unknown.MutationID})
		case err != nil:
			http.Error(w, "database unavailable", http.StatusBadGateway)
		default:
			json.NewEncoder(w).Encode(map[string]any{"version": res.Version})
		}
	})

	log.Fatal(http.ListenAndServe("127.0.0.1:3000", mux))
}
`;

const GO_ROUTERS = `
// Chi: the handler body is identical, only the router differs.
r := chi.NewRouter()
r.Get("/users/{id}", func(w http.ResponseWriter, req *http.Request) {
	id := chi.URLParam(req, "id")
	item, err := db.Get(req.Context(), "users/"+id, nil)
	// ... same as above
})

// Gin: share db through a closure or c.Set.
g := gin.Default()
g.GET("/users/:id", func(c *gin.Context) {
	item, err := db.Get(c.Request.Context(), "users/"+c.Param("id"), nil)
	if err != nil {
		c.Status(http.StatusBadGateway)
		return
	}
	if item == nil {
		c.Status(http.StatusNotFound)
		return
	}
	c.Data(http.StatusOK, "application/json", item.Value)
})
`;

const RUST_AXUM = `
// src/main.rs
use std::{env, sync::Arc};

use axum::{
    extract::{FromRequestParts, Path, State},
    http::{request::Parts, StatusCode},
    routing::get,
    Json, Router,
};
use celeris_client::{Client, Error};
use serde::{Deserialize, Serialize};

#[derive(Serialize, Deserialize)]
struct User {
    name: String,
}

// Client is not Clone: share it in an Arc.
type Db = Arc<Client>;

// An extractor that turns the x-session-id header into a session stored in Celeris.
struct SessionUser(serde_json::Value);

impl FromRequestParts<Db> for SessionUser {
    type Rejection = StatusCode;

    async fn from_request_parts(parts: &mut Parts, db: &Db) -> Result<Self, Self::Rejection> {
        let sid = parts
            .headers
            .get("x-session-id")
            .and_then(|v| v.to_str().ok())
            .filter(|s| s.len() <= 64 && s.chars().all(|c| c.is_ascii_alphanumeric() || c == '-'))
            .ok_or(StatusCode::UNAUTHORIZED)?;
        match db.get::<serde_json::Value>(&format!("sessions/{sid}")).await {
            Ok(Some(item)) => Ok(SessionUser(item.value)),
            Ok(None) => Err(StatusCode::UNAUTHORIZED),
            Err(_) => Err(StatusCode::BAD_GATEWAY),
        }
    }
}

async fn me(SessionUser(session): SessionUser) -> Json<serde_json::Value> {
    Json(session)
}

async fn get_user(State(db): State<Db>, Path(id): Path<String>) -> Result<Json<User>, StatusCode> {
    match db.get::<User>(&format!("users/{id}")).await {
        Ok(Some(item)) => Ok(Json(item.value)),
        Ok(None) => Err(StatusCode::NOT_FOUND),
        Err(_) => Err(StatusCode::BAD_GATEWAY),
    }
}

async fn put_user(
    State(db): State<Db>,
    Path(id): Path<String>,
    Json(user): Json<User>,
) -> StatusCode {
    match db.put(&format!("users/{id}"), &user).await {
        Ok(_) => StatusCode::NO_CONTENT,
        // May have committed: tell the caller instead of claiming failure.
        Err(Error::OutcomeUnknown { .. }) => StatusCode::ACCEPTED,
        Err(_) => StatusCode::BAD_GATEWAY,
    }
}

#[tokio::main]
async fn main() -> Result<(), Box<dyn std::error::Error>> {
    let nodes = env::var("CELERIS_NODES").unwrap_or_else(|_| "http://127.0.0.1:8080".into());
    let mut builder = Client::builder().nodes(nodes.split(',').map(str::to_owned));
    if let Ok(token) = env::var("CELERIS_TOKEN") {
        builder = builder.token(token);
    }
    let db: Db = Arc::new(builder.build()?);

    // axum 0.8 path syntax. In 0.7 write "/users/:id".
    let app = Router::new()
        .route("/users/{id}", get(get_user).put(put_user))
        .route("/me", get(me))
        .with_state(db);

    let listener = tokio::net::TcpListener::bind("127.0.0.1:3000").await?;
    axum::serve(listener, app).await?;
    Ok(())
}
`;

const RUST_CARGO = `
# Cargo.toml
[package]
name = "celeris-axum-example"
version = "0.1.0"
edition = "2024"

[dependencies]
axum = "0.8"
tokio = { version = "1", features = ["full"] }
serde = { version = "1", features = ["derive"] }
serde_json = "1"
# Install the SDK from the repository (or use a path = "..." dependency on a clone).
celeris-client = { git = "https://github.com/vinitpatil519/CelerisDB" }
`;

const LAMBDA = `
// handler.ts (AWS Lambda, Node.js 22 runtime, SQS trigger)
import { createHash } from "node:crypto";
import type { SQSEvent } from "aws-lambda";
import { Client, OutcomeUnknownError } from "@celeris/client";

// Module scope: warm invocations reuse the client and its preferred node.
const db = new Client({
  nodes: process.env.CELERIS_NODES!.split(","),
  token: process.env.CELERIS_TOKEN,
  timeoutMs: 3000,
  attempts: 3,
});

// A mutation ID must be a UUID. Derive it from the message so a redelivered
// SQS message produces the same ID and the write is applied once.
function uuidFrom(text: string): string {
  const h = createHash("sha256").update(text).digest();
  h[6] = (h[6]! & 0x0f) | 0x50;
  h[8] = (h[8]! & 0x3f) | 0x80;
  const x = h.subarray(0, 16).toString("hex");
  return [x.slice(0, 8), x.slice(8, 12), x.slice(12, 16), x.slice(16, 20), x.slice(20)].join("-");
}

export const handler = async (event: SQSEvent) => {
  const failures: { itemIdentifier: string }[] = [];
  for (const record of event.Records) {
    try {
      const order = JSON.parse(record.body);
      await db.put("orders/" + order.id, order, { mutationId: uuidFrom(record.messageId) });
    } catch (e) {
      // OutcomeUnknownError: let SQS redeliver. The same ID makes the retry safe.
      if (!(e instanceof OutcomeUnknownError)) console.error(e);
      failures.push({ itemIdentifier: record.messageId });
    }
  }
  return { batchItemFailures: failures };
};
`;

const WORKER = `
// Cloudflare Workers / Vercel Edge: plain HTTP with fetch. No SDK needed.
export default {
  async fetch(request: Request, env: { CELERIS_URL: string; CELERIS_TOKEN: string }) {
    const key = new URL(request.url).pathname.slice(1); // e.g. "flags/new-checkout"
    const res = await fetch(env.CELERIS_URL + "/v1/kv/" + key + "?consistency=eventual", {
      headers: { authorization: "Bearer " + env.CELERIS_TOKEN },
    });
    if (res.status === 404) return new Response("not found", { status: 404 });
    const body = (await res.json()) as { value: unknown };
    return Response.json(body.value);
  },
};
`;

/* ── Patterns ─────────────────────────────────────────────────────────── */

const P_SESSION_TS = `
import { Client } from "@celeris/client";

const SESSION_TTL_MS = 30 * 60 * 1000;

export async function createSession(db: Client, userId: string) {
  const sid = crypto.randomUUID();
  await db.put("sessions/" + sid, { userId }, { ttlMs: SESSION_TTL_MS });
  return sid;
}

// "session" consistency reads your own writes without paying for a leader read.
export async function loadSession(db: Client, sid: string) {
  const item = await db.get<{ userId: string }>("sessions/" + sid, { consistency: "session" });
  if (!item) return null;
  // Sliding expiry: rewrite with a fresh TTL (only if the session is old enough to matter).
  await db.put("sessions/" + sid, item.value, { ttlMs: SESSION_TTL_MS, ifVersion: item.version });
  return item.value;
}
`;

const P_RATE_TS = `
import { CelerisError, type Client } from "@celeris/client";

// Fixed-window counter built on compare-and-set (there is no server-side increment).
export async function allow(db: Client, id: string, limit: number, windowMs: number): Promise<boolean> {
  const window = Math.floor(Date.now() / windowMs);
  const key = "ratelimit/" + id + "/" + window;
  const ttlMs = windowMs * 2;
  for (let attempt = 0; attempt < 5; attempt++) {
    const cur = await db.get<{ n: number }>(key);
    const n = (cur?.value.n ?? 0) + 1;
    if (n > limit) return false;
    try {
      await db.put(key, { n }, cur ? { ifVersion: cur.version, ttlMs } : { ifAbsent: true, ttlMs });
      return true;
    } catch (e) {
      if (e instanceof CelerisError && e.code === "condition_failed") continue; // lost the race, retry
      throw e;
    }
  }
  return false; // heavy contention: fail closed
}
`;

const P_RATE_PY = `
from celeris import CelerisError, Client


def allow(db: Client, ident: str, limit: int, window_ms: int) -> bool:
    import time

    window = int(time.time() * 1000) // window_ms
    key = f"ratelimit/{ident}/{window}"
    ttl = window_ms * 2
    for _ in range(5):
        cur = db.get(key)
        n = (cur.value["n"] if cur else 0) + 1
        if n > limit:
            return False
        try:
            if cur:
                db.put(key, {"n": n}, ttl_ms=ttl, if_version=cur.version)
            else:
                db.put(key, {"n": n}, ttl_ms=ttl, if_absent=True)
            return True
        except CelerisError as e:
            if e.code != "condition_failed":
                raise
    return False
`;

const P_FLAGS = `
const flagCache = new Map<string, { value: boolean; until: number }>();

export async function flag(db: Client, name: string): Promise<boolean> {
  const hit = flagCache.get(name);
  if (hit && hit.until > Date.now()) return hit.value;
  // bounded: any replica, but never older than 5 seconds.
  const item = await db.get<{ on: boolean }>("flags/" + name, { consistency: "bounded", maxStalenessMs: 5000 });
  const value = item?.value.on ?? false;
  flagCache.set(name, { value, until: Date.now() + 5000 });
  return value;
}

// Optional: drop the local cache the moment a flag changes.
db.watch("flags/", { onChange: (e) => flagCache.delete(e.key.slice("flags/".length)), onLagged: () => flagCache.clear() });
`;

const P_CART = `
// The whole cart is one key, so updates are one atomic compare-and-set write.
type Cart = { items: { sku: string; qty: number }[] };

export async function addToCart(db: Client, userId: string, sku: string, qty: number) {
  const key = "carts/" + userId;
  for (let attempt = 0; attempt < 5; attempt++) {
    const cur = await db.get<Cart>(key);
    const cart: Cart = cur?.value ?? { items: [] };
    const line = cart.items.find((i) => i.sku === sku);
    if (line) line.qty += qty;
    else cart.items.push({ sku, qty });
    try {
      await db.put(key, cart, {
        ttlMs: 14 * 24 * 3600 * 1000, // abandoned carts disappear on their own
        ...(cur ? { ifVersion: cur.version } : { ifAbsent: true }),
      });
      return cart;
    } catch (e) {
      if (!(e instanceof CelerisError && e.code === "condition_failed")) throw e;
    }
  }
  throw new Error("cart is too contended, try again");
}
`;

const P_ORDER = `
// Idempotent order creation. The client sends an Idempotency-Key header.
// The order key IS the idempotency key, so a second attempt cannot create a second order.
export async function createOrder(db: Client, idemKey: string, order: object) {
  const key = "orders/" + idemKey;
  try {
    const res = await db.put(key, { ...order, status: "created" }, { ifAbsent: true });
    return { created: true, version: res.version };
  } catch (e) {
    if (e instanceof CelerisError && e.code === "condition_failed") {
      const existing = await db.get(key);
      return { created: false, order: existing?.value };
    }
    throw e;
  }
}
`;

const P_ORDER_PY = `
from celeris import CelerisError, Client


def create_order(db: Client, idem_key: str, order: dict):
    key = f"orders/{idem_key}"
    try:
        res = db.put(key, {**order, "status": "created"}, if_absent=True)
        return {"created": True, "version": res.version}
    except CelerisError as e:
        if e.code == "condition_failed":
            existing = db.get(key)
            return {"created": False, "order": existing.value if existing else None}
        raise
`;

const P_LEADER_TOML = `
# celeris.toml on every node
[[indexes]]
name = "players_by_score"
prefix = "players/"
field = "score"
order = "desc"
`;

const P_LEADER_TS = `
// players/<id> = { "name": "Ada", "score": 1200 }
const page = await db.queryPage<{ name: string; score: number }>({
  prefix: "players/",
  sort: { field: "score", order: "desc" },
  limit: 10,
});
for (const p of page.items) console.log(p.value.name, p.value.score);
`;

const P_TENANT = `
// Every key of a tenant lives under t/<tenant>/. Isolation is enforced here, in your code.
const TENANT = /^[a-z0-9-]{1,40}$/;

export function forTenant(db: Client, tenant: string) {
  if (!TENANT.test(tenant)) throw new Error("bad tenant");
  const k = (key: string) => "t/" + tenant + "/" + key;
  return {
    get: <T>(key: string) => db.get<T>(k(key)),
    put: (key: string, value: unknown, ttlMs?: number) => db.put(k(key), value, { ttlMs }),
    // Trailing slash matters: "t/acme/" must not match "t/acme2/".
    list: (prefix = "") => db.scan({ prefix: k(prefix) }),
  };
}
`;

const P_CACHE = `
export async function cached<T>(db: Client, key: string, ttlMs: number, load: () => Promise<T>): Promise<T> {
  const hit = await db.get<T>("cache/" + key, { consistency: "eventual" });
  if (hit) return hit.value;
  const value = await load(); // the slow source of truth
  await db.put("cache/" + key, value, { ttlMs, consistency: "eventual" });
  return value;
}
`;

/* ── Run commands ─────────────────────────────────────────────────────── */

const RUN_NODE_LINUX = `
mkdir my-app && cd my-app
npm init -y
npm install express
npm install --save-dev typescript tsx @types/node @types/express

# Install the SDK from a clone of the repository (it is built into dist/).
git clone https://github.com/vinitpatil519/CelerisDB ../CelerisDB
(cd ../CelerisDB/sdks/typescript && npm install && npm run build)
npm install ../CelerisDB/sdks/typescript

export CELERIS_NODES=http://127.0.0.1:8080
npx tsx server.ts
`;
const RUN_NODE_WIN = `
mkdir my-app; cd my-app
npm init -y
npm install express
npm install --save-dev typescript tsx @types/node @types/express

# Install the SDK from a clone of the repository (it is built into dist/).
git clone https://github.com/vinitpatil519/CelerisDB ..\\CelerisDB
Push-Location ..\\CelerisDB\\sdks\\typescript; npm install; npm run build; Pop-Location
npm install ..\\CelerisDB\\sdks\\typescript

$env:CELERIS_NODES = "http://127.0.0.1:8080"
npx tsx server.ts
`;

const RUN_PY_UNIX = `
python3 -m venv .venv
source .venv/bin/activate
git clone https://github.com/vinitpatil519/CelerisDB ../CelerisDB
pip install ../CelerisDB/sdks/python fastapi "uvicorn[standard]"

export CELERIS_NODES=http://127.0.0.1:8080
uvicorn main:app --port 3000
`;
const RUN_PY_WIN = `
py -m venv .venv
.venv\\Scripts\\Activate.ps1
git clone https://github.com/vinitpatil519/CelerisDB ..\\CelerisDB
pip install ..\\CelerisDB\\sdks\\python fastapi "uvicorn[standard]"

$env:CELERIS_NODES = "http://127.0.0.1:8080"
uvicorn main:app --port 3000
`;

const RUN_GO_UNIX = `
mkdir my-app && cd my-app
go mod init example.com/my-app
go get github.com/vinitpatil519/CelerisDB/sdks/go@main
export CELERIS_NODES=http://127.0.0.1:8080
go run .
`;
const RUN_GO_WIN = `
mkdir my-app; cd my-app
go mod init example.com/my-app
go get github.com/vinitpatil519/CelerisDB/sdks/go@main
$env:CELERIS_NODES = "http://127.0.0.1:8080"
go run .
`;

const RUN_RUST_UNIX = `
cargo new my-app && cd my-app
# paste the Cargo.toml dependencies and src/main.rs from above
export CELERIS_NODES=http://127.0.0.1:8080
cargo run
`;
const RUN_RUST_WIN = `
cargo new my-app; cd my-app
# paste the Cargo.toml dependencies and src/main.rs from above
$env:CELERIS_NODES = "http://127.0.0.1:8080"
cargo run
`;

const TOKEN_LINUX = `
# Start a node (data goes to ./celeris-data), then create a token for your app.
celeris init
celeris start
`;
const TOKEN_CREATE = `
celeris token create --name web-app --scope read --scope write
`;
const TOKEN_ENV = `
# Paste the printed [[auth.tokens]] block into celeris.toml (or set
# CELERIS_AUTH_TOKENS), restart the node, then give the app the token:
export CELERIS_TOKEN=<the token that was printed once>
`;
const TOKEN_ENV_WIN = `
# Paste the printed [[auth.tokens]] block into celeris.toml (or set
# CELERIS_AUTH_TOKENS), restart the node, then give the app the token:
$env:CELERIS_TOKEN = "<the token that was printed once>"
`;

function Body() {
  return (
    <>
      <p>
        This page shows how to use CelerisDB from common web frameworks and runtimes. Everything here is an{" "}
        <strong>example pattern</strong> built on the public SDKs and the <DocLink to="http-api">HTTP API</DocLink>. There are no official
        framework plugins, and nothing on this page is a published integration package. You copy the snippet, adapt it, and own it.
        Third-party framework APIs change, so check each framework{"'"}s own documentation for the version you use.
      </p>
      <p>
        Celeris has SDKs for TypeScript (with a React hook), Python, Go and Rust. For anything else, call the HTTP API directly with an HTTP client
        (see <DocLink to="sdk-http">HTTP without an SDK</DocLink>).
      </p>

      <IntegrationMap />

      <H2 id="ground-rules">Ground rules for every framework</H2>
      <ul>
        <li>
          <strong>One client per process.</strong> The clients are cheap, remember which node answered last, and retry across nodes for you. Create
          one at startup and share it. In serverless, create it at module scope so warm invocations reuse it.
        </li>
        <li>
          <strong>Tokens stay on the server.</strong> A token has a scope (<code>read</code>, <code>write</code>, <code>admin</code>), not a key
          prefix. Anyone who holds a <code>read</code> token can read every key. Keep it in an environment variable or secret manager and never
          bundle it into browser or mobile code.
        </li>
        <li>
          <strong>Never build keys from raw input.</strong> Keys may contain <code>/</code>, so a user id such as <code>x/../admin</code> could
          walk out of your prefix. Validate ids against a strict pattern, as the examples do. Keys with <code>.</code> or <code>..</code> path
          segments cannot be used over HTTP at all.
        </li>
        <li>
          <strong>Choose consistency per call.</strong> Use the default (<code>strict</code>) for money, inventory and counters, <code>session</code>{" "}
          to read your own writes, <code>bounded</code> or <code>eventual</code> for dashboards and caches. See{" "}
          <DocLink to="consistency">Consistency</DocLink>.
        </li>
        <li>
          <strong>Surface unknown outcomes.</strong> If a write times out in a way that cannot be resolved, the SDK raises{" "}
          <code>OutcomeUnknownError</code> (carrying the mutation ID) instead of a plain failure. Do not report it as failed. Return 202, queue a
          retry with the same ID, or check <code>mutationStatus</code>. See <DocLink to="reads-writes">Reads and writes</DocLink>.
        </li>
        <li>
          <strong>Conditional writes need strict mode.</strong> <code>ifVersion</code> and <code>ifAbsent</code> (and their Python, Go and Rust
          equivalents) are refused with <code>available</code> and <code>eventual</code> writes.
        </li>
        <li>
          <strong>Batches stay within one replica set.</strong> In a cluster, keys are spread over partitions, and a batch that spans replica sets
          is rejected (<code>cross_group_batch</code>). The patterns below keep each logical object in a single key for this reason.
        </li>
      </ul>

      <H2 id="setup">Before you start: a node, a token, an SDK</H2>
      <Steps>
        <Step title="Run a node">
          <p>
            Install Celeris (see <DocLink to="installation">Installation</DocLink>) and start a local node. It listens on{" "}
            <code>127.0.0.1:8080</code> by default.
          </p>
          <Code lang="bash">{TOKEN_LINUX}</Code>
        </Step>
        <Step title="Create a token (optional locally, required in production)">
          <p>
            Authentication is off until at least one token is configured. The command prints the token once and the config entry that holds only its
            SHA-256.
          </p>
          <Code lang="bash">{TOKEN_CREATE}</Code>
          <OsCode unix={TOKEN_ENV} windows={TOKEN_ENV_WIN} />
        </Step>
        <Step title="Get an SDK">
          <p>
            The SDKs live in the repository under <code>sdks/</code>. The commands in{" "}
            <a href="#run-it">Run the examples</a> install each one from a clone. See the pages for{" "}
            <DocLink to="sdk-typescript">TypeScript</DocLink>, <DocLink to="sdk-python">Python</DocLink>, <DocLink to="sdk-go">Go</DocLink> and{" "}
            <DocLink to="sdk-rust">Rust</DocLink> for details.
          </p>
        </Step>
      </Steps>

      <H2 id="typescript">TypeScript and Node.js</H2>
      <p>
        The TypeScript client needs Node.js 22 or later and has no dependencies: it uses the platform <code>fetch</code> and{" "}
        <code>WebSocket</code>. Put the client in one module and import it everywhere.
      </p>
      <Code lang="ts" title="celeris.ts">
        {TS_CLIENT}
      </Code>

      <H3 id="express">Express</H3>
      <Code lang="ts" title="server.ts">
        {EXPRESS}
      </Code>
      <p>
        Note the order of the <code>instanceof</code> checks: <code>OutcomeUnknownError</code> is a subclass of <code>CelerisError</code>, so it must
        be tested first. The <code>ETag</code> and <code>If-Match</code> pair maps HTTP optimistic concurrency straight onto the Celeris item version.
      </p>

      <H3 id="fastify">Fastify</H3>
      <Code lang="ts" title="server.ts">
        {FASTIFY}
      </Code>

      <H3 id="nextjs">Next.js (App Router)</H3>
      <p>
        Create the client once, on the server, and reuse it across hot reloads in development by hanging it off <code>globalThis</code>. The custom{" "}
        <code>fetch</code> option matters: Next.js can cache <code>fetch</code> results, and a database read must never be served from that cache.
      </p>
      <Code lang="ts" title="lib/celeris.ts">
        {NEXT_LIB}
      </Code>
      <Code lang="ts" title="app/api/users/[id]/route.ts">
        {NEXT_ROUTE}
      </Code>
      <p>A server action can use compare-and-set to avoid overwriting someone else{"'"}s edit:</p>
      <Code lang="ts" title="app/profile/actions.ts">
        {NEXT_ACTION}
      </Code>
      <Callout kind="warn" title="Edge runtime caveat">
        The SDK only needs <code>fetch</code>, <code>AbortController</code> and <code>crypto.randomUUID</code>, which edge runtimes provide, and{" "}
        <code>watch()</code> additionally needs <code>WebSocket</code>. Support differs per platform and version, so test it on yours before relying
        on it, and prefer <code>export const runtime = "nodejs"</code> for routes that talk to Celeris. Whatever the runtime, the Celeris node must
        be reachable from where the code runs. A private address such as <code>10.0.1.10</code> is not reachable from a public edge network.
      </Callout>
      <Callout kind="danger" title="Never use the admin token client-side">
        Anything imported into a Client Component, or exposed with a <code>NEXT_PUBLIC_</code> variable, ships to every visitor. Only Server
        Components, route handlers and server actions should import <code>lib/celeris.ts</code>. An <code>admin</code>-scoped token can rebalance or
        shut down nodes, so it should live in your operations tooling and in no application at all.
      </Callout>

      <H3 id="nestjs">NestJS</H3>
      <Code lang="ts" title="celeris.module.ts and users.service.ts">
        {NEST}
      </Code>

      <H3 id="react">React with useCeleris</H3>
      <p>
        <code>useCeleris(client, key)</code> reads a key once and then follows it live through the node{"'"}s change stream. It never moves backwards
        in version and re-reads after a <code>lagged</code> notice.
      </p>
      <Code lang="tsx" title="Profile.tsx">
        {REACT}
      </Code>
      <Callout kind="warn" title="Browser access">
        Browsers cannot set headers on a WebSocket, so the client sends the token as an <code>access_token</code> query parameter on change
        streams, which can end up in proxy and server logs. If you cannot accept that, put a same-origin reverse proxy in front that adds the
        token, and set <code>CELERIS_CORS_ORIGINS</code> only for origins you control. Remember that a browser-visible token can read every key its
        scope allows.
      </Callout>

      <H2 id="python">Python</H2>
      <p>
        The Python client (3.10+) is synchronous and has no dependencies. It opens a connection per request, so it holds no sockets that need
        closing. Its only shared state is the preferred node and the latest session token.
      </p>
      <Callout kind="note" title="One session token per client">
        With <code>consistency="session"</code> the client sends the latest session token it has seen. A client shared by many users therefore
        waits for the newest write of any user. That is correct, only slightly stronger (and occasionally slower) than per-user read-your-writes.
        If you need strict per-user behavior, keep a client per user or per request.
      </Callout>

      <H3 id="fastapi">FastAPI</H3>
      <p>
        Build the client in the <code>lifespan</code> handler, expose it through a dependency, and write handlers as plain <code>def</code> so that
        FastAPI runs them in its thread pool. (If you need <code>async def</code>, wrap calls in <code>asyncio.to_thread</code>.)
      </p>
      <Code lang="py" title="main.py">
        {FASTAPI}
      </Code>

      <H3 id="flask">Flask</H3>
      <Code lang="py" title="app.py">
        {FLASK}
      </Code>

      <H3 id="django">Django (cache and session backend sketch)</H3>
      <p>
        Django has a pluggable cache API, so Celeris can serve as a cache and, through the cache session engine, as a session store. This is a
        sketch to adapt: it keeps values as JSON, so cached objects must be JSON-serializable (Django{"'"}s built-in backends pickle instead).
        TTLs map to <code>ttl_ms</code> and expire on their own.
      </p>
      <Code lang="py" title="celeris_cache.py">
        {DJANGO}
      </Code>
      <Code lang="py" title="settings.py">
        {DJANGO_SETTINGS}
      </Code>
      <p>
        <code>clear()</code> walks every key under the <code>dj/</code> namespace, which is slow for large caches. Use short TTLs and let entries
        expire instead of clearing.
      </p>

      <H2 id="go">Go</H2>
      <p>
        The Go client (Go 1.22+) uses only the standard library and is safe for concurrent use. <code>Get</code> returns <code>(nil, nil)</code>{" "}
        for a missing key, and a value is a <code>json.RawMessage</code> that you can write straight to the response or <code>Decode</code> into a
        struct.
      </p>
      <Code lang="go" title="main.go (net/http, Go 1.22 routing)">
        {GO_HTTP}
      </Code>
      <p>With Chi or Gin only the routing changes:</p>
      <Code lang="go" title="Chi and Gin">
        {GO_ROUTERS}
      </Code>

      <H2 id="rust">Rust (Axum)</H2>
      <p>
        The Rust client is async (tokio and reqwest), and <code>Client</code> is not <code>Clone</code>, so share it in an <code>Arc</code>. Values
        are anything that implements <code>Serialize</code> on the way in and <code>DeserializeOwned</code> on the way out. For HTTPS endpoints
        enable the SDK{"'"}s <code>rustls</code> feature.
      </p>
      <Code lang="toml" title="Cargo.toml">
        {RUST_CARGO}
      </Code>
      <Code lang="rust" title="src/main.rs">
        {RUST_AXUM}
      </Code>

      <H2 id="serverless">Serverless and edge</H2>
      <p>
        Function platforms suit Celeris well in one way and badly in another. The clients speak plain HTTP, so there is no connection pool to
        exhaust when thousands of instances start. But each instance is short-lived and stateless, which has consequences:
      </p>
      <ul>
        <li>
          <strong>The endpoint must be reachable.</strong> Run the function in the same VPC or private network as the cluster, or expose the client
          API (port 8080 only) over HTTPS with a token. Never expose the cluster port 7000. A function on a public edge network cannot reach a
          private IP.
        </li>
        <li>
          <strong>Mind latency.</strong> Every call is an HTTP round trip to a node, and strict reads and all writes involve the leader and a
          quorum. Keep the function and the cluster in the same region and availability-zone family, and set a short <code>timeoutMs</code> so a
          slow node fails over quickly.
        </li>
        <li>
          <strong>Do not rely on in-process state.</strong> The session token and preferred node reset with a cold start. If a flow needs
          read-your-writes across invocations, pass state yourself or use strict reads.
        </li>
        <li>
          <strong>Make writes idempotent.</strong> Platforms redeliver events. A mutation ID derived from the event ID (it must be a UUID) turns a
          redelivery into a no-op.
        </li>
      </ul>
      <Code lang="ts" title="AWS Lambda with SQS">
        {LAMBDA}
      </Code>
      <p>
        On Vercel or Cloudflare, an edge function can call the HTTP API with <code>fetch</code> directly. This works only if the node is reachable
        over HTTPS from that network:
      </p>
      <Code lang="ts" title="Worker reading a key over HTTP">
        {WORKER}
      </Code>
      <Callout kind="note">
        Public HTTPS exposure needs TLS on the node (<code>CELERIS_TLS_CERT</code> and <code>CELERIS_TLS_KEY</code>) or a TLS-terminating load
        balancer in front, plus a least-privilege token. See <DocLink to="security">Security</DocLink> and <DocLink to="cloud">Cloud</DocLink>.
      </Callout>

      <H2 id="patterns">Patterns you will reuse</H2>
      <p>
        The storage model is plain keys and JSON values, with TTLs, conditional writes and prefix scans. These recipes combine those pieces. They
        are examples, not library code.
      </p>
      <Table
        head={["Pattern", "Key layout", "Consistency", "Built from"]}
        rows={[
          ["Sessions", "sessions/<id>", "session reads", "TTL, ifVersion"],
          ["Rate limit counter", "ratelimit/<id>/<window>", "strict", "ifVersion / ifAbsent loop, TTL"],
          ["Feature flags", "flags/<name>", "bounded or eventual", "Reads, optional watch"],
          ["Shopping cart", "carts/<user>", "strict", "One key, compare-and-set"],
          ["Idempotent order", "orders/<idempotency key>", "strict", "ifAbsent"],
          ["Leaderboard", "players/<id>", "strict or bounded", "Secondary index + sorted query"],
          ["Multi-tenant data", "t/<tenant>/...", "any", "Prefix scans"],
          ["Cache-aside", "cache/<key>", "eventual", "TTL"],
        ]}
      />

      <H3 id="pattern-sessions">Sessions</H3>
      <Code lang="ts">{P_SESSION_TS}</Code>

      <H3 id="pattern-rate-limit">Rate-limiting counters</H3>
      <p>
        Celeris has no atomic increment, so a counter is a read, an increment and a conditional write that retries when another request got there
        first. That costs two round trips per check and degrades under heavy contention on one key. For very high request rates, limit in memory
        per instance and use Celeris for coarser, shared limits such as per-user-per-minute.
      </p>
      <CodeTabs
        group="sdk-lang"
        items={[
          { id: "ts", label: "TypeScript", lang: "ts", code: P_RATE_TS },
          { id: "py", label: "Python", lang: "py", code: P_RATE_PY },
        ]}
      />

      <H3 id="pattern-flags">Feature flags</H3>
      <Code lang="ts">{P_FLAGS}</Code>

      <H3 id="pattern-cart">Shopping cart</H3>
      <p>
        Keeping the whole cart in one key makes every update a single atomic compare-and-set, and avoids multi-key batches that a cluster may
        reject. The TTL removes abandoned carts without a cleanup job.
      </p>
      <Code lang="ts">{P_CART}</Code>

      <H3 id="pattern-order">Idempotent order creation</H3>
      <p>
        Make the idempotency key part of the order key and write with <code>ifAbsent</code>. Exactly one request creates the order. Every
        duplicate gets <code>condition_failed</code> and reads the existing one.
      </p>
      <CodeTabs
        group="sdk-lang"
        items={[
          { id: "ts", label: "TypeScript", lang: "ts", code: P_ORDER },
          { id: "py", label: "Python", lang: "py", code: P_ORDER_PY },
        ]}
      />

      <H3 id="pattern-leaderboard">Leaderboards</H3>
      <p>
        Scans return keys in key order and cannot be reversed, so a sorted query on a score needs a secondary index declared in the node
        configuration. Updating a score is then an ordinary write to the player{"'"}s key.
      </p>
      <Code lang="toml" title="celeris.toml">
        {P_LEADER_TOML}
      </Code>
      <Code lang="ts">{P_LEADER_TS}</Code>
      <p>
        See <DocLink to="queries">Queries</DocLink> for index behavior, including that a new index builds in the background and that queries scan
        until it is ready.
      </p>

      <H3 id="pattern-tenants">Multi-tenant key prefixes</H3>
      <Code lang="ts">{P_TENANT}</Code>
      <Callout kind="warn">
        Prefixes organize data, they are not a security boundary. A token is scoped by operation, not by prefix, so every tenant{"'"}s data is
        reachable by any process holding the token. Enforce tenant isolation in your code, and use separate clusters (or at least separate tokens
        and networks) when tenants must be strongly isolated.
      </Callout>

      <H3 id="pattern-cache">Cache-aside</H3>
      <Code lang="ts">{P_CACHE}</Code>

      <H2 id="run-it">Run the examples</H2>
      <p>
        Every snippet above expects a node at <code>http://127.0.0.1:8080</code> (override with <code>CELERIS_NODES</code>, a comma-separated list)
        and, if you enabled authentication, a token in <code>CELERIS_TOKEN</code>. Pick your stack:
      </p>
      <Tabs
        group="frameworks-run"
        items={[
          {
            id: "node",
            label: "Node.js",
            content: <OsCode linux={RUN_NODE_LINUX} macos={RUN_NODE_LINUX} windows={RUN_NODE_WIN} />,
          },
          { id: "py", label: "Python", content: <OsCode unix={RUN_PY_UNIX} windows={RUN_PY_WIN} /> },
          { id: "go", label: "Go", content: <OsCode unix={RUN_GO_UNIX} windows={RUN_GO_WIN} /> },
          { id: "rust", label: "Rust", content: <OsCode unix={RUN_RUST_UNIX} windows={RUN_RUST_WIN} /> },
        ]}
      />
      <p>Then try it:</p>
      <OsCode
        unix={`curl -X PUT localhost:3000/users/ada -H 'content-type: application/json' -d '{"name":"Ada"}'\ncurl localhost:3000/users/ada`}
        windows={`curl.exe -X PUT localhost:3000/users/ada -H "content-type: application/json" -d '{\\"name\\":\\"Ada\\"}'\ncurl.exe localhost:3000/users/ada`}
      />
      <Callout kind="tip">
        In PowerShell use <code>curl.exe</code>, because plain <code>curl</code> is an alias for <code>Invoke-WebRequest</code>, and escape the
        inner quotes of JSON as shown.
      </Callout>

      <H2 id="next">Next steps</H2>
      <ul>
        <li>
          Building an AI app? See <DocLink to="ai">AI and LLM applications</DocLink>.
        </li>
        <li>
          Deploying to a cloud? See <DocLink to="cloud">Cloud platforms</DocLink> and <DocLink to="production-checklist">Production checklist</DocLink>.
        </li>
        <li>
          Choosing modes? <DocLink to="consistency">Consistency</DocLink> and <DocLink to="performance">Performance</DocLink>.
        </li>
        <li>
          Handling errors well: <DocLink to="errors">Errors</DocLink>.
        </li>
      </ul>
    </>
  );
}

export const page: DocPage = {
  slug: "frameworks",
  title: "Frameworks and runtimes",
  group: "Integrations",
  summary: "Example patterns for Next.js, Express, FastAPI, Django, Go, Axum and serverless, built on the public SDKs.",
  keywords: [
    "nextjs",
    "next.js",
    "express",
    "fastify",
    "nestjs",
    "react",
    "fastapi",
    "flask",
    "django",
    "gin",
    "chi",
    "axum",
    "lambda",
    "cloudflare workers",
    "vercel",
    "serverless",
    "session store",
    "rate limit",
    "feature flags",
    "shopping cart",
    "leaderboard",
    "multi-tenant",
    "cache aside",
    "idempotent",
  ],
  Body,
};
