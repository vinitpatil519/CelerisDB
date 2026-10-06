"""Blocking Celeris client built on the standard library."""

from __future__ import annotations

import http.client
import json
import random
import time
import urllib.parse
import uuid
from dataclasses import dataclass
from typing import Any, Iterator, Literal, Mapping, Sequence

from ._websocket import WebSocket

Consistency = Literal["strict", "session", "bounded", "available", "eventual"]

SESSION_HEADER = "celeris-session-index"
MUTATION_HEADER = "celeris-mutation-id"

# Error codes after which the same request may go to another node.
_REDIRECTS = frozenset({"not_leader", "not_owner", "partition_moved"})
# 503 codes that guarantee nothing was applied: retry shortly.
_TRANSIENT = frozenset(
    {
        "proposal_lost",
        "partition_moving",
        "read_retry",
        "read_timeout",
        "session_behind",
        "no_partition_map",
        "epoch_ahead",
    }
)


class CelerisError(Exception):
    """An error answered by a node, or a transport failure (``status == 0``)."""

    def __init__(self, status: int, details: Mapping[str, Any]):
        self.status = status
        self.details = dict(details)
        self.code: str = str(details.get("code", "error"))
        outcome = details.get("outcome")
        #: For writes: ``"not_applied"`` (safe to treat as failed) or ``"unknown"``.
        self.outcome: str | None = outcome if outcome in ("not_applied", "unknown") else None
        mutation_id = details.get("mutation_id")
        self.mutation_id: str | None = mutation_id if isinstance(mutation_id, str) else None
        super().__init__(str(details.get("message") or self.code))


class OutcomeUnknownError(CelerisError):
    """The write may or may not have committed. Resolve it with
    :meth:`Client.mutation_status`."""

    def __init__(self, mutation_id: str, reason: str):
        super().__init__(
            0,
            {
                "code": "outcome_unknown",
                "message": reason,
                "outcome": "unknown",
                "mutation_id": mutation_id,
            },
        )


@dataclass(frozen=True)
class Item:
    key: str
    value: Any
    version: int
    expires_at_ms: int | None
    #: Consistency the server applied.
    consistency: str


@dataclass(frozen=True)
class WriteResult:
    key: str | None
    #: Commit version; ``None`` while an ``available`` write is pending.
    version: int | None
    mutation_id: str
    #: This mutation ID had already committed; nothing new was written.
    deduplicated: bool
    #: ``False`` when an ``available`` write was accepted but not yet replicated.
    replicated: bool
    consistency: str


@dataclass(frozen=True)
class ScanPage:
    items: list[Item]
    next_cursor: str | None
    #: Some data may be missing (unreachable replica sets).
    partial: bool


@dataclass(frozen=True)
class ChangeEvent:
    key: str
    kind: Literal["put", "delete"]
    value: Any
    version: int
    mutation_id: str


def encode_key(key: str) -> str:
    """Percent-encodes a key for a URL path, keeping ``/`` readable."""
    segments = key.split("/")
    if any(s in (".", "..") for s in segments):
        raise CelerisError(
            0,
            {
                "code": "invalid_key",
                "message": "keys with `.` or `..` path segments cannot be used over HTTP",
            },
        )
    return "/".join(urllib.parse.quote(s, safe="") for s in segments)


def _query(**params: Any) -> str:
    pairs = []
    for k, v in params.items():
        if v is None:
            continue
        if isinstance(v, bool):
            v = "true" if v else "false"
        pairs.append(f"{k}={urllib.parse.quote(str(v), safe='')}")
    return "?" + "&".join(pairs) if pairs else ""


@dataclass
class _Raw:
    status: int
    body: Any
    headers: Mapping[str, str]


class Client:
    """A Celeris client.

    Guarantees:

    * Every write carries a mutation ID. Retries (after network errors, or on
      another node) reuse it, so a write is never applied twice.
    * A write whose outcome cannot be determined raises
      :class:`OutcomeUnknownError`; it is never reported as a plain failure.
    * Every result reports the consistency the server applied. The client
      never weakens a requested mode.
    """

    def __init__(
        self,
        nodes: str | Sequence[str],
        *,
        consistency: Consistency | None = None,
        timeout: float = 10.0,
        attempts: int = 4,
        headers: Mapping[str, str] | None = None,
        token: str | None = None,
    ):
        if isinstance(nodes, str):
            nodes = [nodes]
        if not nodes:
            raise ValueError("at least one node URL is required")
        self._nodes = [
            (n if n.startswith(("http://", "https://")) else f"http://{n}").rstrip("/")
            for n in nodes
        ]
        self._consistency = consistency
        self._timeout = timeout
        self._attempts = attempts
        self._headers = dict(headers or {})
        if token:
            self._headers["authorization"] = f"Bearer {token}"
        self._preferred = 0
        self._session: str | None = None

    @property
    def session(self) -> str | None:
        """The session token from the latest write or read (``<index>@<group>``)."""
        return self._session

    # -- key-value ---------------------------------------------------------

    def get(
        self,
        key: str,
        *,
        consistency: Consistency | None = None,
        max_staleness_ms: int | None = None,
    ) -> Item | None:
        """Reads a key. Returns ``None`` if it does not exist."""
        consistency = consistency or self._consistency
        headers = {}
        if consistency == "session" and self._session:
            headers[SESSION_HEADER] = self._session
        path = f"/v1/kv/{encode_key(key)}" + _query(
            consistency=consistency, max_staleness_ms=max_staleness_ms
        )
        raw = self._read("GET", path, headers)
        if raw.status == 404:
            return None
        _expect_ok(raw)
        return _item(raw.body)

    def put(
        self,
        key: str,
        value: Any,
        *,
        consistency: Consistency | None = None,
        ttl_ms: int | None = None,
        if_version: int | None = None,
        if_absent: bool = False,
        mutation_id: str | None = None,
    ) -> WriteResult:
        """Writes a JSON-serializable value."""
        path = f"/v1/kv/{encode_key(key)}" + _query(
            consistency=consistency or self._consistency,
            ttl_ms=ttl_ms,
            if_version=if_version,
            if_absent=True if if_absent else None,
        )
        return self._write("PUT", path, json.dumps(value).encode(), mutation_id)

    def delete(
        self,
        key: str,
        *,
        consistency: Consistency | None = None,
        if_version: int | None = None,
        mutation_id: str | None = None,
    ) -> WriteResult:
        """Deletes a key. Deleting an absent key succeeds."""
        path = f"/v1/kv/{encode_key(key)}" + _query(
            consistency=consistency or self._consistency, if_version=if_version
        )
        return self._write("DELETE", path, None, mutation_id)

    def batch(
        self,
        ops: Sequence[Mapping[str, Any]],
        *,
        consistency: Consistency | None = None,
        mutation_id: str | None = None,
    ) -> WriteResult:
        """Applies operations atomically under one mutation ID.

        Each op is ``{"op": "put", "key", "value", "ttl_ms"?, "if_version"?,
        "if_absent"?}`` or ``{"op": "delete", "key", "if_version"?}``.
        """
        mutation_id = mutation_id or str(uuid.uuid4())
        body = {"mutation_id": mutation_id, "ops": list(ops)}
        if consistency or self._consistency:
            body["consistency"] = consistency or self._consistency
        return self._write("POST", "/v1/batch", json.dumps(body).encode(), mutation_id)

    # -- scans -------------------------------------------------------------

    def scan_page(
        self,
        *,
        prefix: str | None = None,
        start: str | None = None,
        end: str | None = None,
        limit: int | None = None,
        consistency: Consistency | None = None,
        after: str | None = None,
    ) -> ScanPage:
        """One page of a scan. Pass ``after`` from the previous page's ``next_cursor``."""
        path = "/v1/scan" + _query(
            prefix=prefix,
            start=start,
            end=end,
            limit=limit,
            consistency=consistency or self._consistency,
            after=after,
        )
        raw = self._read("GET", path)
        _expect_ok(raw)
        applied = raw.body.get("consistency")
        return ScanPage(
            items=[_item({**i, "consistency": applied}) for i in raw.body["items"]],
            next_cursor=raw.body.get("next_cursor"),
            partial=bool(raw.body.get("partial")),
        )

    def scan(self, **options: Any) -> Iterator[Item]:
        """Iterates every item in key order, fetching pages as needed.

        Takes the keyword arguments of :meth:`scan_page` except ``after``.
        """
        after = None
        while True:
            page = self.scan_page(**options, after=after)
            yield from page.items
            if page.next_cursor is None:
                return
            after = page.next_cursor

    # -- mutations, conflicts, status --------------------------------------

    def mutation_status(self, mutation_id: str) -> tuple[bool, int | None]:
        """``(committed, version)`` within the server's retention window."""
        raw = self._read("GET", f"/v1/mutations/{urllib.parse.quote(mutation_id, safe='')}")
        if raw.status == 404:
            return (False, None)
        _expect_ok(raw)
        return (True, raw.body.get("version"))

    def conflicts(self, *, prefix: str | None = None, limit: int | None = None) -> dict[str, Any]:
        """Writes that lost last-writer-wins under ``available`` consistency.

        Returns ``{"conflicts": [...], "partial": bool}``.
        """
        raw = self._read("GET", "/v1/conflicts" + _query(prefix=prefix, limit=limit))
        _expect_ok(raw)
        return {"conflicts": raw.body["conflicts"], "partial": bool(raw.body.get("partial"))}

    def clear_conflicts(self, key: str) -> None:
        """Forgets the recorded conflicts of a key."""
        _expect_ok(self._read("DELETE", f"/v1/conflicts/{encode_key(key)}"))

    def status(self) -> dict[str, Any]:
        """Node, cluster and storage status."""
        raw = self._read("GET", "/v1/status")
        _expect_ok(raw)
        return raw.body

    # -- change stream -----------------------------------------------------

    def watch(self, prefix: str = "", *, timeout: float | None = None) -> "Watch":
        """Opens a change stream for keys starting with ``prefix`` on one node.

        Use it as a context manager and iterate it::

            with client.watch("orders/") as w:
                for event in w:
                    ...
        """
        base = self._nodes[self._preferred]
        url = base.replace("http", "ws", 1) + "/v1/watch" + _query(prefix=prefix)
        return Watch(WebSocket.connect(url, timeout=timeout or self._timeout, headers=self._headers))

    # -- transport ---------------------------------------------------------

    def _send(self, node: int, method: str, path: str, headers: Mapping[str, str], body: bytes | None) -> _Raw:
        url = urllib.parse.urlsplit(self._nodes[node])
        cls = http.client.HTTPSConnection if url.scheme == "https" else http.client.HTTPConnection
        conn = cls(url.hostname or "localhost", url.port, timeout=self._timeout)
        try:
            try:
                conn.connect()
            except OSError as e:
                # Nothing reached the node.
                raise _NotSent(e) from e
            conn.request(
                method,
                url.path + path,
                body=body,
                headers={"content-type": "application/json", **self._headers, **headers},
            )
            resp = conn.getresponse()
            status, text, resp_headers = resp.status, resp.read(), resp.headers
        finally:
            conn.close()
        try:
            parsed = json.loads(text) if text else None
        except ValueError:
            parsed = {"error": {"code": "invalid_response", "message": text.decode(errors="replace")}}
        return _Raw(status, parsed, resp_headers)

    def _remember(self, raw: _Raw) -> None:
        token = raw.headers.get(SESSION_HEADER)
        if token:
            self._session = token

    def _read(self, method: str, path: str, headers: Mapping[str, str] | None = None) -> _Raw:
        """Reads and other idempotent calls: retried on any failure."""
        last: BaseException | None = None
        for i in range(self._attempts):
            node = (self._preferred + i) % len(self._nodes)
            try:
                raw = self._send(node, method, path, headers or {}, None)
            except OSError as e:
                last = e
                _backoff(i, 0.05)
                continue
            code = _error(raw).get("code")
            if (raw.status == 421 and code in _REDIRECTS) or (raw.status == 503 and code in _TRANSIENT):
                last = CelerisError(raw.status, _error(raw))
                _backoff(i, 0.05)
                continue
            self._preferred = node
            self._remember(raw)
            return raw
        if isinstance(last, CelerisError):
            raise last
        raise CelerisError(0, {"code": "unreachable", "message": f"no node answered: {last}"})

    def _write(self, method: str, path: str, body: bytes | None, mutation_id: str | None) -> WriteResult:
        """Writes: retried with the same mutation ID after network failures
        (the server deduplicates), on another node after redirects, and after
        errors that guarantee nothing was applied."""
        mutation_id = mutation_id or str(uuid.uuid4())
        maybe_sent = False
        last: BaseException | None = None
        for i in range(self._attempts):
            node = (self._preferred + i) % len(self._nodes)
            try:
                raw = self._send(node, method, path, {MUTATION_HEADER: mutation_id}, body)
            except OSError as e:
                # A failed connect never reached the node; anything later might have.
                if not isinstance(e, _NotSent):
                    maybe_sent = True
                last = e
                _backoff(i, 0.1)
                continue
            error = _error(raw)
            if raw.status == 421 and error.get("code") in _REDIRECTS:
                last = CelerisError(raw.status, error)
                continue
            if raw.status == 503 and error.get("code") in _TRANSIENT:
                last = CelerisError(raw.status, error)
                _backoff(i, 0.1)
                continue
            if error.get("outcome") == "unknown":
                # Retrying with the same ID is safe and may resolve it.
                maybe_sent = True
                last = CelerisError(raw.status, error)
                _backoff(i, 0.1)
                continue
            _expect_ok(raw)
            self._preferred = node
            self._remember(raw)
            b = raw.body
            return WriteResult(
                key=b.get("key"),
                version=b.get("version"),
                mutation_id=b.get("mutation_id", mutation_id),
                deduplicated=bool(b.get("deduplicated")),
                replicated=raw.status != 202,
                consistency=b.get("consistency"),
            )
        if maybe_sent:
            raise OutcomeUnknownError(
                mutation_id, f"no confirmation after {self._attempts} attempts: {last}"
            )
        if isinstance(last, CelerisError):
            raise last
        raise CelerisError(
            0,
            {"code": "unreachable", "message": str(last), "outcome": "not_applied", "mutation_id": mutation_id},
        )


class Watch:
    """An open change stream. Iterating yields :class:`ChangeEvent`.

    ``hello`` holds the first message (``node``, ``groups``, ``partial``).
    ``lagged`` counts events the server dropped because this watcher fell
    behind; when it grows, re-read the keys you depend on.
    """

    def __init__(self, socket: WebSocket):
        self._socket = socket
        self.lagged = 0
        self.hello: dict[str, Any] = {}
        first = self._message()
        if first is None or first.get("type") != "hello":
            socket.close()
            raise CelerisError(0, {"code": "watch_failed", "message": f"unexpected first message: {first}"})
        self.hello = first

    def _message(self) -> dict[str, Any] | None:
        text = self._socket.recv()
        return None if text is None else json.loads(text)

    def next(self, timeout: float | None = None) -> ChangeEvent | None:
        """The next change, or ``None`` if the stream closed. Raises
        ``TimeoutError`` if nothing arrives within ``timeout`` seconds."""
        self._socket.settimeout(timeout)
        while True:
            msg = self._message()
            if msg is None:
                return None
            kind = msg.get("type")
            if kind == "change":
                return ChangeEvent(
                    key=msg["key"],
                    kind=msg["kind"],
                    value=msg.get("value"),
                    version=msg["version"],
                    mutation_id=msg["mutation_id"],
                )
            if kind == "lagged":
                self.lagged += int(msg.get("missed", 0))

    def __iter__(self) -> Iterator[ChangeEvent]:
        while (event := self.next()) is not None:
            yield event

    def close(self) -> None:
        self._socket.close()

    def __enter__(self) -> "Watch":
        return self

    def __exit__(self, *exc: object) -> None:
        self.close()


def _error(raw: _Raw) -> dict[str, Any]:
    if isinstance(raw.body, dict) and isinstance(raw.body.get("error"), dict):
        return raw.body["error"]
    return {}


def _expect_ok(raw: _Raw) -> None:
    if not 200 <= raw.status < 300:
        raise CelerisError(raw.status, _error(raw) or {"code": "http_error", "message": f"HTTP {raw.status}"})


def _item(body: Mapping[str, Any]) -> Item:
    return Item(
        key=body["key"],
        value=body.get("value"),
        version=body["version"],
        expires_at_ms=body.get("expires_at_ms"),
        consistency=body.get("consistency"),
    )


class _NotSent(OSError):
    """The connection could not be opened, so the request was never sent."""


def _backoff(attempt: int, base: float) -> None:
    time.sleep(base * (attempt + 1) * (0.5 + random.random()))
