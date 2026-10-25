from contextlib import contextmanager
from dataclasses import replace
import http.client
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
import threading
from types import SimpleNamespace

import pytest

from sc2tools_agent import updater
from tests.test_updater import _release_with_artifact


@pytest.mark.parametrize("url", [
    "http://api.example.test/agent.exe",
    "ftp://api.example.test/agent.exe",
    "file://api.example.test/agent.exe",
    "https://user:password@github.com/agent.exe",
    "https://github.com/agent.exe#unexpected",
    "https://github.com/agent.exe\n",
])
def test_download_policy_rejects_unsafe_urls_even_for_extra_hosts(url):
    artifact = _release_with_artifact(url, b"installer").artifact
    with pytest.raises(updater.UpdateError):
        updater._assert_trusted_download(artifact, {"api.example.test"})


@pytest.mark.parametrize("url,hosts", [
    ("https://github.com/owner/repo/agent.exe", ()),
    ("https://release-assets.githubusercontent.com/agent.exe?token=example", ()),
    ("https://api.example.test/agent.exe", ("api.example.test",)),
    ("http://127.0.0.1:8123/agent.exe", ("127.0.0.1",)),
    ("http://localhost:8123/agent.exe", ("localhost",)),
    ("http://[::1]:8123/agent.exe", ("::1",)),
])
def test_download_policy_keeps_https_and_explicit_loopback_development(url, hosts):
    updater._assert_trusted_download(_release_with_artifact(url, b"installer").artifact, hosts)


@contextmanager
def serve_installer(payload, *, redirect=None):
    requests = []

    class Handler(BaseHTTPRequestHandler):
        def do_GET(self):
            requests.append(self.path)
            if redirect and self.path == "/start":
                self.send_response(302)
                self.send_header("Location", redirect)
                self.end_headers()
                return
            self.send_response(200)
            self.send_header("Content-Length", str(len(payload)))
            self.end_headers()
            self.wfile.write(payload)

        def log_message(self, *_args):
            pass

    server = ThreadingHTTPServer(("127.0.0.1", 0), Handler)
    thread = threading.Thread(target=server.serve_forever, daemon=True)
    thread.start()
    try:
        yield f"http://127.0.0.1:{server.server_port}", requests
    finally:
        server.shutdown()
        server.server_close()
        thread.join(timeout=2)


def test_redirect_is_checked_before_contacting_an_untrusted_host(tmp_path):
    payload = b"installer"
    with serve_installer(payload) as (destination, received):
        untrusted = destination.replace("127.0.0.1", "localhost") + "/agent.exe"
        with serve_installer(payload, redirect=untrusted) as (source, _requests):
            release = _release_with_artifact(source + "/start", payload)
            with pytest.raises(updater.UpdateError, match="untrusted_download_host"):
                updater.install_release(release, download_dir=tmp_path, launch_installer=False,
                                        trusted_hosts={"127.0.0.1"})
    assert not received
    assert not list(tmp_path.iterdir())


def test_allowed_redirect_still_downloads_and_verifies(tmp_path):
    payload = b"installer"
    with serve_installer(payload, redirect="/agent.exe") as (source, received):
        release = _release_with_artifact(source + "/start", payload)
        result = updater.install_release(release, download_dir=tmp_path, launch_installer=False,
                                         trusted_hosts={"127.0.0.1"})
    assert result.read_bytes() == payload
    assert received == ["/start", "/agent.exe"]


def fake_download(monkeypatch, response):
    monkeypatch.setattr(updater.urllib.request, "urlopen", lambda *_args, **_kwargs: response)
    monkeypatch.setattr(updater.urllib.request, "build_opener",
                        lambda *_args: SimpleNamespace(open=lambda *_args, **_kwargs: response))


class BrokenResponse:
    def __enter__(self):
        return self

    def __exit__(self, *_args):
        return False

    def read(self, _size):
        raise http.client.IncompleteRead(b"partial", 100)


def test_interrupted_http_body_is_retryable_and_leaves_no_staging_file(tmp_path, monkeypatch):
    fake_download(monkeypatch, BrokenResponse())
    release = _release_with_artifact("https://github.com/agent.exe", b"installer")
    with pytest.raises(updater.UpdateError, match="download_failed"):
        updater.install_release(release, download_dir=tmp_path, launch_installer=False)
    assert not list(tmp_path.iterdir())


def test_download_stops_before_writing_beyond_advertised_size(tmp_path, monkeypatch):
    class OversizedResponse(BrokenResponse):
        reads = 0

        def read(self, _size):
            self.reads += 1
            if self.reads > 1:
                raise AssertionError("Oversized download was not stopped")
            return b"oversized-installer"

    response = OversizedResponse()
    fake_download(monkeypatch, response)
    release = _release_with_artifact("https://github.com/agent.exe", b"small")
    with pytest.raises(updater.UpdateError, match="size_mismatch"):
        updater.install_release(release, download_dir=tmp_path, launch_installer=False)
    assert response.reads == 1
    assert not list(tmp_path.iterdir())


@pytest.mark.parametrize("digest,size", [("missing", 12), ("a" * 64, -1), ("a" * 64, True), ("a" * 64, 2 ** 40)])
def test_invalid_download_metadata_is_rejected_before_network(tmp_path, monkeypatch, digest, size):
    release = _release_with_artifact("https://github.com/agent.exe", b"installer")
    release = replace(release, artifact=replace(release.artifact, sha256=digest, size_bytes=size))
    calls = []
    monkeypatch.setattr(updater.urllib.request, "urlopen", lambda *_args, **_kwargs: calls.append(True))
    monkeypatch.setattr(updater.urllib.request, "build_opener", lambda *_args: calls.append(True))
    with pytest.raises(updater.UpdateError, match="invalid_artifact"):
        updater.install_release(release, download_dir=tmp_path, launch_installer=False)
    assert not calls
    assert not list(tmp_path.iterdir())


@pytest.mark.parametrize("size", [True, False, -1, 1.5, "1024", 2 ** 40])
def test_feed_cannot_coerce_malformed_size_into_trusted_metadata(size):
    release = updater._coerce_release({"artifact": {"platform": "windows", "downloadUrl": "https://github.com/agent.exe",
                                                    "sha256": "a" * 64, "sizeBytes": size}}, fallback_current="0.23.1")
    assert release.artifact is None
