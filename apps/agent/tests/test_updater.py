"""Tests for sc2tools_agent.updater."""

from __future__ import annotations

import hashlib
import http.server
import json
import socket
import threading
from pathlib import Path
from typing import Optional

import pytest

from sc2tools_agent.config import AgentConfig
from sc2tools_agent.state import AgentState
from sc2tools_agent.updater import (
    ReleaseArtifact,
    ReleaseInfo,
    UpdateError,
    Updater,
    _coerce_release,
    _detect_platform,
    install_release,
)


def _make_cfg(tmp_path: Path, base_url: str = "http://localhost:1") -> AgentConfig:
    return AgentConfig(
        api_base=base_url,
        state_dir=tmp_path,
        replay_folder=None,
        poll_interval_sec=10,
        parse_concurrency=1,
    )


def test_coerce_release_handles_full_payload() -> None:
    payload = {
        "channel": "stable",
        "update_available": True,
        "current": "0.1.0",
        "latest": "0.2.0",
        "publishedAt": "2026-04-01T00:00:00Z",
        "releaseNotes": "shiny",
        "minSupportedVersion": "0.1.0",
        "artifact": {
            "platform": "windows",
            "downloadUrl": "https://example.com/x.exe",
            "sha256": "a" * 64,
            "sizeBytes": 1024,
            "signature": None,
        },
    }
    release = _coerce_release(payload, fallback_current="0.0.0")
    assert release.update_available
    assert release.latest == "0.2.0"
    assert release.artifact is not None
    assert release.artifact.platform == "windows"
    assert release.artifact.size_bytes == 1024


def test_coerce_release_drops_invalid_artifact() -> None:
    payload = {
        "channel": "stable",
        "update_available": False,
        "current": "0.1.0",
    }
    release = _coerce_release(payload, fallback_current="0.0.0")
    assert release.artifact is None
    assert release.latest is None


def test_detect_platform_returns_one_of_three() -> None:
    assert _detect_platform() in {"windows", "macos", "linux"}


def test_install_release_rejects_missing_artifact(tmp_path: Path) -> None:
    release = ReleaseInfo(
        channel="stable",
        update_available=True,
        current="0.1.0",
        latest="0.2.0",
        published_at=None,
        release_notes="",
        min_supported_version=None,
        artifact=None,
    )
    with pytest.raises(UpdateError):
        install_release(release, download_dir=tmp_path, launch_installer=False)


def test_install_release_verifies_sha256(tmp_path: Path) -> None:
    payload = b"installer-bytes"
    digest = hashlib.sha256(payload).hexdigest()

    server, port, stop = _serve_payload(payload)
    try:
        artifact = ReleaseArtifact(
            platform="windows",
            download_url=f"http://127.0.0.1:{port}/agent.exe",
            sha256=digest,
            size_bytes=len(payload),
            signature=None,
        )
        release = ReleaseInfo(
            channel="stable",
            update_available=True,
            current="0.1.0",
            latest="0.2.0",
            published_at=None,
            release_notes="",
            min_supported_version=None,
            artifact=artifact,
        )
        out = install_release(
            release,
            download_dir=tmp_path,
            launch_installer=False,
        )
        assert out.exists()
        assert out.read_bytes() == payload
    finally:
        stop()


def test_install_release_rejects_bad_sha256(tmp_path: Path) -> None:
    server, port, stop = _serve_payload(b"good-bytes")
    try:
        artifact = ReleaseArtifact(
            platform="windows",
            download_url=f"http://127.0.0.1:{port}/agent.exe",
            sha256="0" * 64,
            size_bytes=10,
            signature=None,
        )
        release = ReleaseInfo(
            channel="stable",
            update_available=True,
            current="0.1.0",
            latest="0.2.0",
            published_at=None,
            release_notes="",
            min_supported_version=None,
            artifact=artifact,
        )
        with pytest.raises(UpdateError, match="sha256_mismatch"):
            install_release(
                release,
                download_dir=tmp_path,
                launch_installer=False,
            )
    finally:
        stop()


def test_check_now_returns_release_when_server_responds(tmp_path: Path) -> None:
    payload = {
        "ok": True,
        "channel": "stable",
        "platform": _detect_platform(),
        "update_available": True,
        "current": "0.1.0",
        "latest": "0.2.0",
        "publishedAt": "2026-04-01T00:00:00Z",
        "releaseNotes": "",
        "minSupportedVersion": None,
        "artifact": {
            "platform": _detect_platform(),
            "downloadUrl": "https://example.com/agent.exe",
            "sha256": "a" * 64,
            "sizeBytes": 1024,
        },
    }
    server, port, stop = _serve_json(payload)
    try:
        cfg = _make_cfg(tmp_path, base_url=f"http://127.0.0.1:{port}")
        observed: list[Optional[ReleaseInfo]] = []
        updater = Updater(
            cfg=cfg,
            state=AgentState(),
            on_update_available=lambda r: observed.append(r),
        )
        release = updater.check_now()
        assert release is not None
        assert release.update_available
        assert observed and observed[0].latest == "0.2.0"
    finally:
        stop()


def test_check_now_swallows_network_error(tmp_path: Path) -> None:
    cfg = _make_cfg(tmp_path, base_url="http://127.0.0.1:1")
    updater = Updater(cfg=cfg, state=AgentState())
    assert updater.check_now() is None


# ---------------- helpers ----------------


def _serve_payload(payload: bytes):
    """Tiny HTTP server that returns ``payload`` for any GET."""

    class Handler(http.server.BaseHTTPRequestHandler):
        def do_GET(self) -> None:  # noqa: N802
            self.send_response(200)
            self.send_header("Content-Length", str(len(payload)))
            self.end_headers()
            self.wfile.write(payload)

        def log_message(self, *_args, **_kwargs) -> None:
            return None

    return _spawn_server(Handler)


def _serve_json(obj: dict):
    body = json.dumps(obj).encode("utf-8")

    class Handler(http.server.BaseHTTPRequestHandler):
        def do_GET(self) -> None:  # noqa: N802
            self.send_response(200)
            self.send_header("Content-Type", "application/json")
            self.send_header("Content-Length", str(len(body)))
            self.end_headers()
            self.wfile.write(body)

        def log_message(self, *_args, **_kwargs) -> None:
            return None

    return _spawn_server(Handler)


def _spawn_server(handler_cls):
    sock = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
    sock.bind(("127.0.0.1", 0))
    port = sock.getsockname()[1]
    sock.close()
    server = http.server.HTTPServer(("127.0.0.1", port), handler_cls)
    thread = threading.Thread(target=server.serve_forever, daemon=True)
    thread.start()

    def stop() -> None:
        server.shutdown()
        server.server_close()
        thread.join(timeout=2)

    return server, port, stop
