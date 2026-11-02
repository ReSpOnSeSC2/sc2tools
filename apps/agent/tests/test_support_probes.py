"""Synthetic transports and folders; no real network, OBS or system probes."""
import json
import os
import io
import threading
import time

import pytest
import requests
from urllib3.response import HTTPResponse
from urllib3.exceptions import ReadTimeoutError

from sc2tools_agent import support_probes as probes

windows_folders = pytest.mark.skipif(os.name != "nt", reason="Shipping folder scan requires pinned Windows directory handles")


def http(name="api", **options):
    return probes.http_probe(name, options.pop("base", "https://api.example.test"), is_current=options.pop("is_current", lambda: True),
        is_cancelled=lambda: False, deadline=time.monotonic() + 3, **options)


def test_real_session_options_ignore_ambient_netrc_proxy_and_credentials(tmp_path, monkeypatch):
    netrc = tmp_path / "synthetic-netrc"
    netrc.write_text("machine api.example.test login private-login password private-password\n")
    monkeypatch.setenv("NETRC", str(netrc))
    monkeypatch.setenv("HTTPS_PROXY", "https://private-proxy.example.test")
    captured = []

    class Session(requests.Session):
        def send(self, request, **kwargs):
            captured.append((self.trust_env, request, kwargs))
            response = requests.Response()
            response.status_code = 200
            response.raw = HTTPResponse(body=io.BytesIO(b'{"ok":true}'), preload_content=False, decode_content=False)
            return response

    assert http(session_factory=Session).row.status == "pass"
    assert http("profile", token="captured-token", session_factory=Session).row.status == "pass"
    # Check actual prepared credentials/proxy settings before the control flag.
    assert "Authorization" not in captured[0][1].headers
    assert captured[1][1].headers["Authorization"] == "Bearer captured-token"
    for trusted, request, kwargs in captured:
        assert kwargs["proxies"] == {} and kwargs["timeout"][0] <= 2 and kwargs["timeout"][1] <= 2
        assert "Cookie" not in request.headers
        assert request.headers["Accept-Encoding"] == "identity"
        assert request.body is None
        assert trusted is False and kwargs["allow_redirects"] is False and kwargs["stream"] is True
    assert captured[0][1].url == "https://api.example.test/v1/health"


@pytest.mark.parametrize("base", ["https://user:password@api.example.test", "https://api.example.test/?token=private",
    "https://api.example.test/#private", "https://api.example.test/private", "file:///private", "https://bad host.test"])
def test_probe_transport_rejects_unsafe_base_before_session_creation(base):
    calls = []
    result = http(base=base, session_factory=lambda: calls.append(True))
    assert result.row.code == "invalid_response" and calls == []


class Response:
    def __init__(self, body=b'{"ok":true}', status=200):
        self.body, self.status_code, self.closed = body, status, False
        self.headers = {}
        self.raw = HTTPResponse(body=io.BytesIO(body), preload_content=False, decode_content=False)

    def close(self):
        self.closed = True
        self.raw.close()


class Session:
    def __init__(self, response, callback=None):
        self.response, self.callback, self.closed = response, callback, False
        self.cookies, self.headers, self.proxies = {}, {}, {}

    def get(self, *_args, **kwargs):
        self.options = kwargs
        assert kwargs["allow_redirects"] is False and kwargs["stream"] is True
        assert self.trust_env is False and self.auth is None
        if self.callback:
            self.callback()
        return self.response

    def close(self):
        self.closed = True


def test_held_profile_response_after_retirement_is_closed_and_not_published():
    entered, release = threading.Event(), threading.Event()
    current = {"value": True}
    response = Response(b'{"battleTag":"private-player"}')
    session = Session(response, lambda: (entered.set(), release.wait(3)))
    result = []
    worker = threading.Thread(target=lambda: result.append(http("profile", token="private-token",
        is_current=lambda: current["value"], session_factory=lambda: session)))
    worker.start()
    try:
        assert entered.wait(3)
        current["value"] = False
    finally:
        release.set()
    worker.join(3)
    assert not worker.is_alive() and result[0].row.code == "cancelled"
    assert response.closed and session.closed and "private" not in repr(result)


@pytest.mark.parametrize("body,status,code", [(b"x" * (64 * 1024 + 1), 200, "invalid_response"),
    (b"\xff", 200, "invalid_response"), (b"[]", 200, "invalid_response"), (b"{}", 302, "invalid_response")],
    ids=("oversize", "invalid-utf8", "wrong-shape", "redirect"))
def test_response_body_and_redirects_fail_closed(body, status, code):
    response = Response(body, status)
    result = http(session_factory=lambda: Session(response))
    assert result.row.code == code and response.closed and "private" not in repr(result)


def test_profile_signed_out_and_public_version_unauthenticated():
    response = Response(status=403)
    assert http("profile", token="private", session_factory=lambda: Session(response)).row.code == "signed_out"
    response = Response(json.dumps({"latest": "0.24.8", "notes": "private-remote-notes"}).encode())
    session = Session(response)
    result = http("version", token="must-not-send", version="0.24.8", session_factory=lambda: session)
    assert result.row.status == "pass" and "private" not in repr(result)
    assert "Authorization" not in session.options["headers"]


def test_encoded_urllib3_body_is_rejected_before_any_read():
    # A gzip header with an unfinished optional filename produces no decoded
    # output. Rejection must happen before entering urllib3's decoder loop.
    response = Response()
    response.headers["Content-Encoding"] = "gzip"
    raw = HTTPResponse(body=io.BytesIO(b"\x1f\x8b\x08\x08" + b"\x00" * 6 + b"x" * 8192),
        headers={"Content-Encoding": "gzip"}, preload_content=False)
    response.raw = raw
    reads = []
    original = raw.read
    def counted(*args, **kwargs):
        reads.append((args, kwargs))
        return original(*args, **kwargs)
    raw.read = counted
    result = http(session_factory=lambda: Session(response))
    assert result.row.code == "invalid_response" and response.closed
    assert reads == []


def test_identity_body_uses_bounded_raw_reads_without_decoding():
    response = Response(b'{"ok":true}')
    reads = []
    original = response.raw.read
    def counted(amount, *, decode_content):
        reads.append((amount, decode_content))
        return original(amount, decode_content=decode_content)
    response.raw.read = counted
    assert http(session_factory=lambda: Session(response)).row.status == "pass"
    assert reads and all(value == (1, False) for value in reads)


@pytest.mark.parametrize("retired", [False, True])
def test_raw_timeout_is_classified_without_detail_and_retired_output_is_suppressed(retired):
    response = Response()
    session = Session(response)
    owner = {"current": True}
    def timeout(*_args, **_kwargs):
        if retired:
            owner["current"] = False
        raise ReadTimeoutError(None, None, "private-transport-detail")
    response.raw.read = timeout
    result = http(is_current=lambda: owner["current"], session_factory=lambda: session)
    assert result.row.code == ("cancelled" if retired else "timeout")
    assert response.closed and session.closed and "private" not in repr(result)


@pytest.mark.parametrize("channel", ["stable", "beta", "dev"])
def test_actual_empty_release_feed_is_reachable_and_notice_is_discarded(channel):
    # Exact no-release branch of apps/api/src/routes/agentVersion.js.
    payload = {"ok": True, "channel": channel, "platform": "windows",
        "update_available": False, "notice": {"body": "private-remote-notice"}}
    response = Response(json.dumps(payload).encode())
    result = http("version", version="0.24.8", channel=channel, session_factory=lambda: Session(response))
    assert result.row.status == "pass" and result.row.code == "ok"
    assert "private" not in repr(result)


@pytest.mark.parametrize("changed", [{"ok": False}, {"update_available": True},
    {"channel": "other"}, {"platform": "other"}, {"latest": None}])
def test_malformed_empty_release_shape_is_not_accepted(changed):
    payload = {"ok": True, "channel": "stable", "platform": "windows", "update_available": False, **changed}
    response = Response(json.dumps(payload).encode())
    assert http("version", version="0.24.8", session_factory=lambda: Session(response)).row.code == "invalid_response"


@windows_folders
def test_folders_report_generated_index_counts_newest_and_scan_cap(tmp_path, monkeypatch):
    root = tmp_path / "private-folder-name"
    root.mkdir()
    (root / "private-player.SC2Replay").write_bytes(b"synthetic")
    result = probes.folders_probe((root,), is_current=lambda: True, is_cancelled=lambda: False, deadline=time.monotonic() + 3)
    assert result.row.status == "pass" and result.row.count == 1
    assert result.folders[0].index == 1 and result.folders[0].replay_count == 1
    assert result.folders[0].newest_utc.endswith("Z") and result.folders[0].complete
    assert "private" not in repr(result) and str(tmp_path) not in repr(result)
    monkeypatch.setattr(probes, "FOLDER_ENTRY_MAX", 0)
    capped = probes.folders_probe((root,), is_current=lambda: True, is_cancelled=lambda: False, deadline=time.monotonic() + 3)
    assert capped.row.status == "warn" and capped.folders[0].complete is False


def test_obs_probe_is_disposable_readonly_and_disabled_never_connects():
    calls = []

    class Client:
        def __init__(self, **options):
            calls.append(options)

        def get_version(self):
            calls.append("get_version")

        def disconnect(self):
            calls.append("disconnect")

    options = dict(is_current=lambda: True, is_cancelled=lambda: False, deadline=time.monotonic() + 3, client_factory=Client)
    assert probes.obs_probe(False, ("private-host", 4455, "private-password"), **options).row.code == "disabled"
    assert calls == []
    result = probes.obs_probe(True, ("private-host", 4455, "private-password"), **options)
    assert result.row.status == "pass" and calls[1:] == ["get_version", "disconnect"]
    assert calls[0]["timeout"] <= 2 and "private" not in repr(result)


@windows_folders
def test_recursive_folder_probe_counts_nested_replays_and_newest_metadata(tmp_path):
    import os
    root = tmp_path / "private-root"
    nested = root / "private-one" / "private-two"
    nested.mkdir(parents=True)
    old = root / "private-old.SC2Replay"
    recent = nested / "private-new.SC2Replay"
    old.write_bytes(b"synthetic")
    recent.write_bytes(b"synthetic")
    os.utime(old, (1_700_000_000, 1_700_000_000))
    os.utime(recent, (1_700_000_100, 1_700_000_100))
    result = probes.folders_probe((root,), is_current=lambda: True, is_cancelled=lambda: False, deadline=time.monotonic() + 3)
    assert result.row.status == "pass" and result.folders[0].replay_count == 2 and result.folders[0].complete
    assert result.folders[0].newest_utc == "2023-11-14T22:15:00Z"
    assert "private" not in repr(result)


@windows_folders
def test_recursive_folder_probe_depth_and_shared_entry_caps_report_incomplete(tmp_path, monkeypatch):
    root = tmp_path / "root"
    nested = root / "child"
    nested.mkdir(parents=True)
    (nested / "sample.SC2Replay").write_bytes(b"synthetic")
    monkeypatch.setattr(probes, "FOLDER_DEPTH_MAX", 0)
    options = dict(is_current=lambda: True, is_cancelled=lambda: False, deadline=time.monotonic() + 3)
    result = probes.folders_probe((root,), **options)
    assert result.row.status == "warn" and result.folders[0].complete is False and result.folders[0].replay_count == 0
    monkeypatch.setattr(probes, "FOLDER_DEPTH_MAX", 6)
    monkeypatch.setattr(probes, "FOLDER_ENTRY_MAX", 1)
    capped = probes.folders_probe((root, nested), **options)
    assert capped.row.status == "warn" and not any(item.complete for item in capped.folders)


@windows_folders
def test_recursive_folder_probe_unreadable_descendant_never_claims_complete(tmp_path, monkeypatch):
    root = tmp_path / "root"
    blocked = root / "private-blocked"
    blocked.mkdir(parents=True)
    original = probes.os.scandir

    def scan(path):
        if path == blocked:
            raise PermissionError("private-path-and-error")
        return original(path)

    monkeypatch.setattr(probes.os, "scandir", scan)
    result = probes.folders_probe((root,), is_current=lambda: True, is_cancelled=lambda: False, deadline=time.monotonic() + 3)
    assert result.row.status == "warn" and result.folders[0].readable and not result.folders[0].complete
    assert "private" not in repr(result)


@windows_folders
def test_real_recursive_folder_depth_policy_omits_deeper_subtrees(tmp_path):
    root = tmp_path / "root"
    path = root
    for _ in range(7):
        path = path / "nested"
    path.mkdir(parents=True)
    (path / "private.SC2Replay").write_bytes(b"synthetic")
    result = probes.folders_probe((root,), is_current=lambda: True, is_cancelled=lambda: False, deadline=time.monotonic() + 3)
    assert result.row.status == "warn" and result.folders[0].replay_count == 0
    assert not result.folders[0].complete and "private" not in repr(result)


@windows_folders
def test_folder_reparse_metadata_is_not_traversed(tmp_path, monkeypatch):
    import stat
    from types import SimpleNamespace
    calls = []

    class Entries:
        def __enter__(self):
            return iter((SimpleNamespace(name="private-link", path=str(tmp_path / "private-link"),
                stat=lambda **_kwargs: SimpleNamespace(st_mode=stat.S_IFDIR, st_file_attributes=0x400)),))

        def __exit__(self, *_args):
            pass

    monkeypatch.setattr(probes.os, "scandir", lambda path: calls.append(path) or Entries())
    result = probes.folders_probe((tmp_path,), is_current=lambda: True, is_cancelled=lambda: False, deadline=time.monotonic() + 3)
    assert calls == [tmp_path] and result.row.status == "warn" and not result.folders[0].complete
    assert result.folders[0].replay_count == 0 and "private" not in repr(result)


def test_folder_scan_has_no_path_fallback_when_handle_adapter_is_unavailable(tmp_path, monkeypatch):
    monkeypatch.setattr(probes, "_folder_files", lambda: (_ for _ in ()).throw(OSError("unsupported platform")))
    inspected = []
    monkeypatch.setattr(probes.os, "scandir", lambda path: inspected.append(path))
    result = probes.folders_probe((tmp_path,), is_current=lambda: True, is_cancelled=lambda: False, deadline=time.monotonic() + 3)
    assert result.row.status == "unavailable" and result.row.count is None and inspected == []


@windows_folders
def test_real_windows_directory_and_ancestor_renames_are_blocked_during_scan_and_metadata(tmp_path, monkeypatch):
    root = tmp_path / "owned-root"
    child = root / "owned-child"
    child.mkdir(parents=True)
    (child / "private.SC2Replay").write_bytes(b"synthetic")
    original, blocked = probes.os.scandir, []

    def cannot_rename(directory, operation):
        with pytest.raises(OSError):
            directory.rename(directory.with_name(directory.name + "-moved"))
        blocked.append((directory, operation))

    class Entry:
        def __init__(self, entry, directory):
            self.entry, self.directory = entry, directory
            self.name, self.path = entry.name, entry.path

        def stat(self, **options):
            cannot_rename(self.directory, "metadata")
            return self.entry.stat(**options)

    class Entries:
        def __init__(self, directory):
            self.directory, self.inner = directory, original(directory)

        def __enter__(self):
            return (Entry(entry, self.directory) for entry in self.inner.__enter__())

        def __exit__(self, *args):
            return self.inner.__exit__(*args)

    def scan(directory):
        directory = type(root)(directory)
        cannot_rename(directory, "enumeration")
        return Entries(directory)

    monkeypatch.setattr(probes.os, "scandir", scan)
    result = probes.folders_probe((root,), is_current=lambda: True, is_cancelled=lambda: False, deadline=time.monotonic() + 3)
    assert result.row.status == "pass" and result.folders[0].replay_count == 1
    assert (root, "enumeration") in blocked and (child, "enumeration") in blocked and (child, "metadata") in blocked
    assert root.is_dir() and child.is_dir() and not child.with_name("owned-child-moved").exists()
    assert "private" not in repr(result)
