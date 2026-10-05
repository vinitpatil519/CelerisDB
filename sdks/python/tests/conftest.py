"""Starts a real single Celeris node for the tests. The binary comes from
CELERIS_BIN, or the workspace's release/debug build."""

from __future__ import annotations

import os
import shutil
import socket
import subprocess
import sys
import tempfile
import time
import urllib.request
from pathlib import Path

import pytest

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

ROOT = Path(__file__).resolve().parents[3]
EXE = "celeris.exe" if os.name == "nt" else "celeris"


def _binary() -> str:
    if os.environ.get("CELERIS_BIN"):
        return os.environ["CELERIS_BIN"]
    for profile in ("release", "debug"):
        path = ROOT / "target" / profile / EXE
        if path.exists():
            return str(path)
    pytest.skip("celeris binary not found: run `cargo build -p celeris-cli` or set CELERIS_BIN")


def _free_port() -> int:
    with socket.socket() as s:
        s.bind(("127.0.0.1", 0))
        return s.getsockname()[1]


@pytest.fixture(scope="session")
def node_url():
    binary = _binary()
    data = tempfile.mkdtemp(prefix="celeris-py-")
    listen = f"127.0.0.1:{_free_port()}"
    subprocess.run([binary, "init", "--dir", data, "--listen", listen], check=True, capture_output=True)
    env = {**os.environ, "CELERIS_SYNC": "never", "CELERIS_LOG_LEVEL": "warn"}
    proc = subprocess.Popen(
        [binary, "start", "--config", os.path.join(data, "celeris.toml")],
        env=env,
        stdout=subprocess.DEVNULL,
        stderr=subprocess.PIPE,
    )
    url = f"http://{listen}"
    deadline = time.monotonic() + 15
    while True:
        if proc.poll() is not None:
            raise RuntimeError(f"node exited early: {proc.stderr.read().decode()}")
        try:
            with urllib.request.urlopen(f"{url}/health", timeout=1) as r:
                if r.status == 200:
                    break
        except OSError:
            pass
        if time.monotonic() > deadline:
            proc.kill()
            raise RuntimeError("node did not start")
        time.sleep(0.05)
    yield url
    proc.kill()
    proc.wait()
    shutil.rmtree(data, ignore_errors=True)
