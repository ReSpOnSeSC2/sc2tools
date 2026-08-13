"""Tests for sc2tools_agent.updater."""

from __future__ import annotations

import hashlib
import http.server
import json
import socket
import threading
import time
from pathlib import Path
from typing import Optional

import pytest

import sc2tools_agent.updater as updater_module
from sc2tools_agent import __version__
from sc2tools_agent.config import AgentConfig
from sc2tools_agent.state import AgentState
from sc2tools_agent.updater import (
    INSTALLER_PARENT_EXIT_TIMEOUT_SEC,
    ReleaseArtifact,
    ReleaseInfo,
    UpdateError,
    Updater,
    _coerce_release,
    _detect_platform,
    _version_lt,
    install_release,
    update_is_mandatory,
)


def test_installer_wait_exceeds_longest_inflight_upload_timeout() -> None:
    """Auto-update must not force-close a still-finishing cloud upload."""
    assert INSTALLER_PARENT_EXIT_TIMEOUT_SEC >= 240


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
            trusted_hosts={"127.0.0.1"},
        )
        assert out.exists()
        assert out.read_bytes() == payload
    finally:
        stop()


def test_install_release_reuses_exact_cached_installer(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    payload = b"already-verified-installer"
    digest = hashlib.sha256(payload).hexdigest()
    target = tmp_path / "agent.exe"
    target.write_bytes(payload)
    release = _release_with_artifact(
        "https://github.com/example/agent.exe",
        payload,
        digest=digest,
    )

    def unexpected_download(*_args, **_kwargs):
        raise AssertionError("verified cache should not be downloaded again")

    monkeypatch.setattr(
        updater_module.urllib.request,
        "urlopen",
        unexpected_download,
    )
    out = install_release(
        release,
        download_dir=tmp_path,
        launch_installer=False,
    )

    assert out == target
    assert out.read_bytes() == payload


def test_install_release_serializes_overlapping_checks(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    payload = b"one-download-for-two-checks"
    digest = hashlib.sha256(payload).hexdigest()
    request_count = 0
    count_lock = threading.Lock()

    def record_request() -> None:
        nonlocal request_count
        with count_lock:
            request_count += 1

    server, port, stop = _serve_payload(
        payload,
        on_get=record_request,
        delay_sec=0.1,
    )
    release = _release_with_artifact(
        f"http://127.0.0.1:{port}/agent.exe",
        payload,
        digest=digest,
    )
    barrier = threading.Barrier(3)
    outputs: list[Path] = []
    failures: list[BaseException] = []
    launches: list[Path] = []
    monkeypatch.setattr(updater_module, "_running_frozen", lambda: True)
    monkeypatch.setattr(
        updater_module,
        "_spawn_installer_detached",
        lambda path: launches.append(path),
    )
    monkeypatch.setattr(updater_module, "_LAUNCHED_ARTIFACTS", set())

    def run_install() -> None:
        barrier.wait()
        try:
            outputs.append(
                install_release(
                    release,
                    download_dir=tmp_path,
                    trusted_hosts={"127.0.0.1"},
                ),
            )
        except BaseException as exc:  # test thread must report failures
            failures.append(exc)

    threads = [threading.Thread(target=run_install) for _ in range(2)]
    try:
        for thread in threads:
            thread.start()
        barrier.wait()
        for thread in threads:
            thread.join(timeout=5)
        assert all(not thread.is_alive() for thread in threads)
        assert failures == []
        assert request_count == 1
        assert outputs == [tmp_path / "agent.exe"] * 2
        assert launches == [tmp_path / "agent.exe"]
    finally:
        stop()


def test_install_release_uses_unique_verified_fallback_when_target_locked(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    payload = b"fresh-installer"
    digest = hashlib.sha256(payload).hexdigest()
    target = tmp_path / "agent.exe"
    target.write_bytes(b"stale-and-locked")
    server, port, stop = _serve_payload(payload)
    release = _release_with_artifact(
        f"http://127.0.0.1:{port}/agent.exe",
        payload,
        digest=digest,
    )
    real_replace = updater_module.os.replace

    def locked_target_replace(source, destination) -> None:
        if Path(destination) == target:
            raise PermissionError(32, "target is in use", str(target))
        real_replace(source, destination)

    monkeypatch.setattr(updater_module.os, "replace", locked_target_replace)
    try:
        out = install_release(
            release,
            download_dir=tmp_path,
            launch_installer=False,
            trusted_hosts={"127.0.0.1"},
        )
    finally:
        stop()

    assert out != target
    assert out.suffix == ".exe"
    assert out.read_bytes() == payload
    assert target.read_bytes() == b"stale-and-locked"
    assert list(tmp_path.glob("*.part")) == []


def test_windows_launcher_waits_for_agent_exit_without_cmd_shell(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    calls: list[tuple[list[str], dict]] = []

    def fake_popen(args, **kwargs):
        calls.append((args, kwargs))
        return object()

    monkeypatch.setattr(updater_module.subprocess, "Popen", fake_popen)
    monkeypatch.setenv("SystemRoot", r"C:\Windows")
    installer = Path(r"C:\Temp\SC2 installer & verified.exe")

    updater_module._spawn_windows_installer_detached(
        installer,
        parent_pid=4321,
        timeout_sec=37,
    )

    assert len(calls) == 1
    args, kwargs = calls[0]
    assert isinstance(args, list)
    assert args[0].lower().endswith(r"windowspowershell\v1.0\powershell.exe")
    assert "cmd.exe" not in " ".join(args).lower()
    assert "timeout /t" not in " ".join(args).lower()
    assert kwargs["shell"] is False
    assert kwargs["env"]["SC2TOOLS_UPDATE_INSTALLER_PATH"] == str(installer)
    assert kwargs["env"]["SC2TOOLS_UPDATE_PARENT_PID"] == "4321"
    assert kwargs["env"]["SC2TOOLS_UPDATE_EXIT_TIMEOUT_SEC"] == "37"
    program = args[-1]
    assert "Get-Process -Id $agentProcessId" in program
    assert "[DateTime]::UtcNow -lt $deadline" in program
    assert "Start-Process -FilePath $installer" in program
    # The path is data in the child environment, not executable script.
    assert str(installer) not in program


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
                trusted_hosts={"127.0.0.1"},
            )
    finally:
        stop()


def _release_with_url(url: str, current: str = "0.1.0") -> ReleaseInfo:
    return ReleaseInfo(
        channel="stable",
        update_available=True,
        current=current,
        latest="0.2.0",
        published_at=None,
        release_notes="",
        min_supported_version=None,
        artifact=ReleaseArtifact(
            platform="windows",
            download_url=url,
            sha256="a" * 64,
            size_bytes=1,
            signature=None,
        ),
    )


def _release_with_artifact(
    url: str,
    payload: bytes,
    *,
    digest: Optional[str] = None,
) -> ReleaseInfo:
    return ReleaseInfo(
        channel="stable",
        update_available=True,
        current="0.1.0",
        latest="0.2.0",
        published_at=None,
        release_notes="",
        min_supported_version=None,
        artifact=ReleaseArtifact(
            platform="windows",
            download_url=url,
            sha256=digest or hashlib.sha256(payload).hexdigest(),
            size_bytes=len(payload),
            signature=None,
        ),
    )


def test_install_release_rejects_untrusted_host(tmp_path: Path) -> None:
    """A (possibly compromised) feed cannot point the agent at an
    arbitrary download host — only GitHub + explicitly-trusted hosts."""
    release = _release_with_url("https://evil.example.com/agent.exe")
    with pytest.raises(UpdateError, match="untrusted_download_host"):
        install_release(release, download_dir=tmp_path, launch_installer=False)


def test_install_release_rejects_lookalike_github_host(tmp_path: Path) -> None:
    release = _release_with_url("https://evilgithub.com/agent.exe")
    with pytest.raises(UpdateError, match="untrusted_download_host"):
        install_release(release, download_dir=tmp_path, launch_installer=False)


def test_install_release_rejects_plain_http_github(tmp_path: Path) -> None:
    release = _release_with_url("http://github.com/agent.exe")
    with pytest.raises(UpdateError, match="untrusted_download_host"):
        install_release(release, download_dir=tmp_path, launch_installer=False)


def test_version_lt_orders_numeric_versions() -> None:
    assert _version_lt("0.9.9", "0.10.0")
    assert _version_lt("0.13.2", "1.0")
    assert not _version_lt("1.0.0", "1.0")
    assert not _version_lt("2.0", "1.9.9")
    # Unparseable input must never force an update.
    assert not _version_lt("garbage", "1.0.0")
    assert not _version_lt("1.0.0", "garbage")


def test_replay_archive_release_is_newer_than_previous_agent() -> None:
    """Existing 0.15.15 installs must see the archive-capable build."""
    assert _version_lt("0.15.15", __version__)


def test_update_is_mandatory_only_below_floor() -> None:
    def rel(current: str, floor: Optional[str]) -> ReleaseInfo:
        return ReleaseInfo(
            channel="stable",
            update_available=True,
            current=current,
            latest="9.9.9",
            published_at=None,
            release_notes="",
            min_supported_version=floor,
            artifact=None,
        )

    assert update_is_mandatory(rel("0.9.0", "0.10.0"))
    assert not update_is_mandatory(rel("0.10.0", "0.10.0"))
    assert not update_is_mandatory(rel("0.11.0", "0.10.0"))
    assert not update_is_mandatory(rel("0.9.0", None))


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


def _serve_payload(
    payload: bytes,
    *,
    on_get=None,
    delay_sec: float = 0,
):
    """Tiny HTTP server that returns ``payload`` for any GET."""

    class Handler(http.server.BaseHTTPRequestHandler):
        def do_GET(self) -> None:  # noqa: N802
            if on_get is not None:
                on_get()
            if delay_sec:
                time.sleep(delay_sec)
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
