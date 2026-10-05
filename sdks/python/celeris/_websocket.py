"""A minimal blocking WebSocket client (RFC 6455), enough for change streams.

It receives text messages, answers pings and closes cleanly. Using the
standard library keeps the SDK free of dependencies.
"""

from __future__ import annotations

import base64
import hashlib
import os
import socket
import ssl
import struct
import urllib.parse
from typing import Mapping

_GUID = "258EAFA5-E914-47DA-95CA-C5AB0DC85B11"

_CONT, _TEXT, _BINARY, _CLOSE, _PING, _PONG = 0x0, 0x1, 0x2, 0x8, 0x9, 0xA


class WebSocketError(OSError):
    pass


class WebSocket:
    def __init__(self, sock: socket.socket, buffered: bytes):
        self._sock = sock
        self._buf = bytearray(buffered)
        self._closed = False

    @classmethod
    def connect(cls, url: str, *, timeout: float, headers: Mapping[str, str] | None = None) -> "WebSocket":
        parts = urllib.parse.urlsplit(url)
        if parts.scheme not in ("ws", "wss"):
            raise ValueError(f"not a WebSocket URL: {url}")
        secure = parts.scheme == "wss"
        host = parts.hostname or "localhost"
        port = parts.port or (443 if secure else 80)
        sock = socket.create_connection((host, port), timeout=timeout)
        if secure:
            sock = ssl.create_default_context().wrap_socket(sock, server_hostname=host)
        key = base64.b64encode(os.urandom(16)).decode()
        target = parts.path or "/"
        if parts.query:
            target += "?" + parts.query
        lines = [
            f"GET {target} HTTP/1.1",
            f"Host: {parts.netloc}",
            "Upgrade: websocket",
            "Connection: Upgrade",
            f"Sec-WebSocket-Key: {key}",
            "Sec-WebSocket-Version: 13",
        ]
        lines += [f"{k}: {v}" for k, v in (headers or {}).items()]
        sock.sendall(("\r\n".join(lines) + "\r\n\r\n").encode())

        response = bytearray()
        while b"\r\n\r\n" not in response:
            chunk = sock.recv(4096)
            if not chunk:
                sock.close()
                raise WebSocketError("connection closed during the WebSocket handshake")
            response += chunk
            if len(response) > 65536:
                sock.close()
                raise WebSocketError("WebSocket handshake response too large")
        head, _, rest = bytes(response).partition(b"\r\n\r\n")
        status_line, *header_lines = head.decode("latin-1").split("\r\n")
        if " 101 " not in status_line + " ":
            sock.close()
            raise WebSocketError(f"WebSocket upgrade refused: {status_line}")
        received = {
            name.strip().lower(): value.strip()
            for name, _, value in (h.partition(":") for h in header_lines)
        }
        expected = base64.b64encode(hashlib.sha1((key + _GUID).encode()).digest()).decode()
        if received.get("sec-websocket-accept") != expected:
            sock.close()
            raise WebSocketError("invalid Sec-WebSocket-Accept")
        return cls(sock, rest)

    def settimeout(self, timeout: float | None) -> None:
        self._sock.settimeout(timeout)

    def _read(self, n: int) -> bytes:
        while len(self._buf) < n:
            try:
                chunk = self._sock.recv(65536)
            except socket.timeout as e:
                raise TimeoutError("no WebSocket message in time") from e
            if not chunk:
                raise EOFError
            self._buf += chunk
        out = bytes(self._buf[:n])
        del self._buf[:n]
        return out

    def _frame(self) -> tuple[bool, int, bytes]:
        b0, b1 = self._read(2)
        fin, opcode = bool(b0 & 0x80), b0 & 0x0F
        length = b1 & 0x7F
        if length == 126:
            (length,) = struct.unpack("!H", self._read(2))
        elif length == 127:
            (length,) = struct.unpack("!Q", self._read(8))
        mask = self._read(4) if b1 & 0x80 else None
        payload = self._read(length)
        if mask:
            payload = bytes(c ^ mask[i % 4] for i, c in enumerate(payload))
        return fin, opcode, payload

    def _send(self, opcode: int, payload: bytes = b"") -> None:
        # Client frames must be masked.
        header = bytearray([0x80 | opcode])
        n = len(payload)
        if n < 126:
            header.append(0x80 | n)
        elif n < 65536:
            header.append(0x80 | 126)
            header += struct.pack("!H", n)
        else:
            header.append(0x80 | 127)
            header += struct.pack("!Q", n)
        mask = os.urandom(4)
        header += mask
        self._sock.sendall(bytes(header) + bytes(c ^ mask[i % 4] for i, c in enumerate(payload)))

    def recv(self) -> str | None:
        """The next text message, or ``None`` once the connection closed."""
        if self._closed:
            return None
        message = bytearray()
        try:
            while True:
                fin, opcode, payload = self._frame()
                if opcode == _PING:
                    self._send(_PONG, payload)
                    continue
                if opcode == _PONG:
                    continue
                if opcode == _CLOSE:
                    self.close()
                    return None
                if opcode in (_TEXT, _BINARY, _CONT):
                    message += payload
                    if fin:
                        return message.decode()
        except (EOFError, ConnectionError):
            self._closed = True
            self._sock.close()
            return None

    def close(self) -> None:
        if self._closed:
            return
        self._closed = True
        try:
            self._send(_CLOSE, struct.pack("!H", 1000))
        except OSError:
            pass
        self._sock.close()
