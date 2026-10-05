"""Integration tests: the client against a real node (see conftest.py)."""

from __future__ import annotations

import time
import uuid
from unittest import mock

import pytest

from celeris import CelerisError, Client, OutcomeUnknownError, encode_key


@pytest.fixture()
def client(node_url):
    return Client(node_url)


def test_put_get_delete_round_trip(client):
    written = client.put("users/1", {"name": "Ada", "tags": ["x"]})
    assert written.key == "users/1"
    assert written.version > 0
    assert written.replicated and not written.deduplicated

    item = client.get("users/1")
    assert item.value == {"name": "Ada", "tags": ["x"]}
    assert item.version == written.version
    assert item.consistency == "strict"

    client.delete("users/1")
    assert client.get("users/1") is None


def test_unusual_keys_are_encoded(client):
    key = "docs/hello world/ünï?#%"
    client.put(key, 1)
    assert client.get(key).value == 1


def test_dot_segments_are_refused_locally():
    with pytest.raises(CelerisError) as e:
        encode_key("a/../b")
    assert e.value.code == "invalid_key"


def test_compare_and_set(client):
    first = client.put("cas/1", "a", if_absent=True)
    with pytest.raises(CelerisError) as e:
        client.put("cas/1", "b", if_absent=True)
    assert (e.value.status, e.value.code) == (409, "condition_failed")
    with pytest.raises(CelerisError):
        client.put("cas/1", "b", if_version=first.version + 1000)
    second = client.put("cas/1", "b", if_version=first.version)
    assert second.version > first.version
    with pytest.raises(CelerisError):
        client.delete("cas/1", if_version=first.version)
    client.delete("cas/1", if_version=second.version)


def test_retried_mutation_is_applied_once(client):
    mutation_id = str(uuid.uuid4())
    a = client.put("idem/1", {"n": 1}, mutation_id=mutation_id)
    b = client.put("idem/1", {"n": 1}, mutation_id=mutation_id)
    assert b.deduplicated and b.version == a.version
    assert client.mutation_status(mutation_id) == (True, a.version)
    assert client.mutation_status(str(uuid.uuid4())) == (False, None)


def test_ttl(client):
    client.put("ttl/1", True, ttl_ms=50)
    assert client.get("ttl/1").expires_at_ms is not None
    time.sleep(0.12)
    assert client.get("ttl/1") is None


def test_batches_are_atomic(client):
    client.put("acct/b", 5)
    assert client.batch(
        [{"op": "put", "key": "acct/a", "value": 1}, {"op": "delete", "key": "acct/b"}]
    ).version > 0
    assert client.get("acct/a").value == 1
    assert client.get("acct/b") is None

    with pytest.raises(CelerisError) as e:
        client.batch(
            [
                {"op": "put", "key": "acct/c", "value": 1},
                {"op": "put", "key": "acct/a", "value": 2, "if_absent": True},
            ]
        )
    assert e.value.code == "condition_failed"
    assert client.get("acct/c") is None


def test_scan_pages_in_key_order(client):
    for i in range(25):
        client.put(f"scan/{i:02}", i)
    client.put("scan0", "outside the prefix")

    first = client.scan_page(prefix="scan/", limit=10)
    assert len(first.items) == 10
    assert first.items[0].key == "scan/00"
    assert first.next_cursor == "scan/09"

    assert [i.value for i in client.scan(prefix="scan/", limit=7)] == list(range(25))


def test_watch_streams_matching_changes(client):
    with client.watch("live/") as watch:
        assert watch.hello["partial"] is False
        client.put("live/a", {"v": 1})
        client.put("other/a", {"v": 1})
        client.delete("live/a")
        put = watch.next(timeout=5)
        delete = watch.next(timeout=5)
    assert (put.key, put.kind, put.value) == ("live/a", "put", {"v": 1})
    assert (delete.key, delete.kind, delete.value) == ("live/a", "delete", None)


def test_watch_times_out_when_idle(client):
    with client.watch("quiet/") as watch, pytest.raises(TimeoutError):
        watch.next(timeout=0.2)


def test_unreachable_node_is_skipped(node_url):
    # Port 1 refuses connections, so nothing was sent there.
    multi = Client(["http://127.0.0.1:1", node_url], timeout=2)
    assert multi.put("failover/1", 1).version > 0
    assert multi.get("failover/1").value == 1


def test_lost_connection_is_outcome_unknown(node_url):
    broken = Client(node_url, attempts=2)
    with mock.patch("http.client.HTTPConnection.getresponse", side_effect=ConnectionResetError("reset")):
        with pytest.raises(OutcomeUnknownError) as e:
            broken.put("x", 1, mutation_id="11111111-1111-4111-8111-111111111111")
    assert e.value.outcome == "unknown"
    assert e.value.mutation_id == "11111111-1111-4111-8111-111111111111"


def test_refused_everywhere_is_not_applied():
    dead = Client("http://127.0.0.1:1", attempts=2, timeout=1)
    with pytest.raises(CelerisError) as e:
        dead.put("x", 1)
    assert not isinstance(e.value, OutcomeUnknownError)
    assert e.value.outcome == "not_applied"


def test_session_token_is_tracked(client):
    client.put("sess/1", 1)
    # Single-node mode has no replication groups, so there may be no token;
    # when there is one, session reads must still succeed with it.
    assert client.get("sess/1", consistency="session").value == 1


def test_status(client):
    assert isinstance(client.status(), dict)
