import hashlib
import io
import json
from pathlib import Path
from urllib.error import HTTPError
from urllib.parse import parse_qs, urlsplit

import pytest

import pluto_sc2.remote as remote


REPLAY = b"MPQ\x1b" + b"test replay bytes" * 10
BASE = "https://api.sc2tools.test"
SIGNED = "https://objects.example.test/private-replay?signature=DO_NOT_PERSIST"


def item(game_id, **overrides):
    record = {"gameId": game_id, "myRace": "Protoss", "replayAvailable": True, "replaySizeBytes": len(REPLAY)}
    record.update(overrides)
    return record


def setup_network(monkeypatch, pages, *, replay=REPLAY, signed_extra=None):
    calls = []
    monkeypatch.setenv("SC2TOOLS_TOKEN", "PRIVATE_TOKEN")

    def read(url, **kwargs):
        calls.append((url, kwargs))
        if url.startswith(BASE + "/v1/replays?"):
            cursor = parse_qs(urlsplit(url).query).get("cursor", [None])[0]
            return json.dumps(pages[cursor]).encode()
        if url.startswith(BASE + "/v1/games/"):
            return json.dumps({"url": SIGNED, "filename": "../../malicious.SC2Replay", **(signed_extra or {})}).encode()
        assert url == SIGNED
        return replay

    monkeypatch.setattr(remote, "_read_url", read)
    return calls


def test_pagination_own_protoss_and_secret_free_atomic_files(monkeypatch, tmp_path):
    calls = setup_network(monkeypatch, {
        None: {"items": [item("one"), item("wrong-race", myRace="Zerg")], "page": {"nextCursor": "page2", "hasMore": True}},
        "page2": {"items": [item("two/with/path")], "page": {"nextCursor": None, "hasMore": False}},
    })
    result = remote.sync_remote(BASE, tmp_path, limit=5)
    assert result["downloaded"] == 2 and result["skipped"] == 1 and result["exhausted"]
    assert all(Path(path).parent == tmp_path for path in result["files"])
    assert all(Path(path).read_bytes() == REPLAY for path in result["files"])
    manifest_text = Path(result["manifest"]).read_text()
    assert "PRIVATE_TOKEN" not in manifest_text and "DO_NOT_PERSIST" not in manifest_text and SIGNED not in manifest_text
    for url, kwargs in calls:
        assert kwargs["token"] == ("PRIVATE_TOKEN" if url.startswith(BASE) else None)
    manifest = json.loads(manifest_text)
    assert manifest["replays"][0]["sha256"] == hashlib.sha256(REPLAY).hexdigest()
    assert manifest["replays"][0]["remote_checksum_verified"] is False
    assert not list(tmp_path.glob("*.part"))


def test_existing_valid_download_is_reused_without_storage_fetch(monkeypatch, tmp_path):
    calls = setup_network(monkeypatch, {None: {"items": [item("one")], "page": {"nextCursor": None, "hasMore": False}}})
    first = remote.sync_remote(BASE, tmp_path)
    calls.clear()
    second = remote.sync_remote(BASE + "/v1", tmp_path)
    assert second["existing"] == 1 and second["downloaded"] == 0
    assert not any(url == SIGNED for url, _ in calls)
    assert first["files"] == second["files"]


def test_bad_download_never_overwrites_existing_file(monkeypatch, tmp_path):
    setup_network(monkeypatch, {None: {"items": [item("one")], "page": {"nextCursor": None, "hasMore": False}}})
    filename = "sc2tools-" + hashlib.sha256(b"one").hexdigest()[:24] + ".SC2Replay"
    path = tmp_path / filename
    path.write_bytes(b"invalid original")
    result = remote.sync_remote(BASE, tmp_path)
    assert result["failed"] == 1
    assert path.read_bytes() == b"invalid original"


@pytest.mark.parametrize("data,checksum", [(b"<html>not replay", None), (REPLAY, "0" * 64)])
def test_rejects_html_and_checksum_mismatch(monkeypatch, tmp_path, data, checksum):
    setup_network(monkeypatch, {None: {"items": [item("one")], "page": {"nextCursor": None, "hasMore": False}}},
                  replay=data, signed_extra={"sha256": checksum} if checksum else {})
    result = remote.sync_remote(BASE, tmp_path)
    assert result["failed"] == 1 and not result["files"]
    assert not list(tmp_path.glob("*.SC2Replay"))


def test_remote_checksum_verified_when_available(monkeypatch, tmp_path):
    setup_network(monkeypatch, {None: {"items": [item("one")], "page": {"nextCursor": None, "hasMore": False}}},
                  signed_extra={"sha256": hashlib.sha256(REPLAY).hexdigest()})
    result = remote.sync_remote(BASE, tmp_path)
    assert json.loads(Path(result["manifest"]).read_text())["replays"][0]["remote_checksum_verified"]


def test_cursor_cycle_stops_with_partial_manifest(monkeypatch, tmp_path):
    setup_network(monkeypatch, {
        None: {"items": [], "page": {"nextCursor": "same", "hasMore": True}},
        "same": {"items": [], "page": {"nextCursor": "same", "hasMore": True}},
    })
    with pytest.raises(remote.RemoteSyncError, match="pagination"):
        remote.sync_remote(BASE, tmp_path)
    assert len(list(tmp_path.glob("sync-*.json"))) == 1


@pytest.mark.parametrize("url", ["http://api.sc2tools.test", "https://user:pass@api.sc2tools.test", "https://api.sc2tools.test?v=secret", "https://api.sc2tools.test/other"])
def test_rejects_unsafe_or_ambiguous_api_origins(url, tmp_path):
    with pytest.raises(remote.RemoteSyncError):
        remote.sync_remote(url, tmp_path)


def test_missing_token_does_not_make_requests(monkeypatch, tmp_path):
    monkeypatch.delenv("SC2TOOLS_TOKEN", raising=False)
    with pytest.raises(remote.RemoteSyncError, match="Set SC2TOOLS_TOKEN"):
        remote.sync_remote(BASE, tmp_path)


def test_public_handle_uses_owner_enabled_routes_without_any_token(monkeypatch, tmp_path):
    monkeypatch.setenv("SC2TOOLS_TOKEN", "MUST_NOT_READ_OR_SEND")
    calls = []

    def read(url, **kwargs):
        calls.append(url)
        assert kwargs["token"] is None
        if url.startswith(BASE + "/v1/public/replays/my-owned-archive?"):
            return json.dumps({"items": [item("one")], "page": {"hasMore": False, "nextCursor": None}}).encode()
        if url == BASE + "/v1/public/replays/my-owned-archive/one/download":
            return json.dumps({"url": SIGNED}).encode()
        assert url == SIGNED
        return REPLAY

    monkeypatch.setattr(remote, "_read_url", read)
    result = remote.sync_remote(BASE, tmp_path, public_handle="my-owned-archive")
    assert result["downloaded"] == 1
    assert len(calls) == 3
    assert "MUST_NOT_READ_OR_SEND" not in Path(result["manifest"]).read_text()


class Response(io.BytesIO):
    def __init__(self, data, headers=None):
        super().__init__(data)
        self.headers = headers or {}


def test_http_headers_never_forward_token_to_storage(monkeypatch):
    requests = []

    class Opener:
        def open(self, request, **kwargs):
            requests.append(request)
            return Response(b"data")

    monkeypatch.setattr(remote, "build_opener", lambda *_: Opener())
    for url, token in [(BASE, "secret"), (SIGNED, None)]:
        assert remote._read_url(url, token=token, maximum=100, timeout=2, retries=0, purpose="Test") == b"data"
    assert requests[0].get_header("Authorization") == "Bearer secret"
    assert requests[1].get_header("Authorization") is None


def test_retry_bound_and_errors_do_not_contain_signed_url(monkeypatch):
    calls = []

    class Opener:
        def open(self, request, **kwargs):
            calls.append(1)
            raise HTTPError(SIGNED, 503, "service unavailable", {}, None)

    monkeypatch.setattr(remote, "build_opener", lambda *_: Opener())
    monkeypatch.setattr(remote.time, "sleep", lambda _: None)
    with pytest.raises(remote.RemoteSyncError) as caught:
        remote._read_url(SIGNED, token=None, maximum=100, timeout=2, retries=2, purpose="Replay download")
    assert len(calls) == 3
    assert "DO_NOT_PERSIST" not in str(caught.value)


def test_redirects_are_refused_before_following(monkeypatch):
    with pytest.raises(remote.RemoteSyncError, match="Redirect refused"):
        remote._NoRedirect().redirect_request(None, None, 302, "", {}, "https://other.test")


def test_size_limit_applies_without_content_length(monkeypatch):
    class Opener:
        def open(self, request, **kwargs):
            return Response(b"x" * 101)

    monkeypatch.setattr(remote, "build_opener", lambda *_: Opener())
    with pytest.raises(remote.RemoteSyncError, match="size"):
        remote._read_url(SIGNED, token=None, maximum=100, timeout=2, retries=0, purpose="Replay download")
