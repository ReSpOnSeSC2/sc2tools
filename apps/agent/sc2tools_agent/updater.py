"""Agent auto-update flow.

Polls ``GET /v1/agent/version`` on startup and on a periodic schedule.
When the cloud reports a newer release than the running agent, downloads
the installer to a temp dir, verifies the SHA-256, and launches it.

Compatible with both the PyInstaller-frozen .exe install AND the
``python -m sc2tools_agent`` source-run mode:

* Frozen mode: replaces the running .exe by spawning the installer with
  a short delay so the existing process can exit cleanly first. The
  installer (NSIS) handles the actual file replacement.

* Source-run mode: download is recorded in ``state.json`` under
  ``last_release_seen`` so the operator can install it manually. We
  never auto-replace a developer's checkout.

The check is best-effort: every failure path is swallowed and logged so
a flaky network never crashes the agent.
"""

from __future__ import annotations

import contextlib
import hashlib
import json
import logging
import os
import platform
import shutil
import ssl
import subprocess
import sys
import tempfile
import threading
import time
import urllib.error
import urllib.parse
import urllib.request
from dataclasses import dataclass
from pathlib import Path
from typing import Any, Callable, Dict, Optional

from . import __version__
from .config import AgentConfig
from .state import AgentState, save_state

log = logging.getLogger(__name__)

DEFAULT_POLL_INTERVAL_SEC = 12 * 60 * 60  # twice daily
USER_AGENT = f"sc2tools-agent/{__version__} updater"
HTTP_TIMEOUT_SEC = 30
DOWNLOAD_CHUNK = 1024 * 256
INSTALLER_LAUNCH_DELAY_SEC = 3


@dataclass(frozen=True)
class ReleaseArtifact:
    """The platform-specific download bundle the cloud returned."""

    platform: str
    download_url: str
    sha256: str
    size_bytes: Optional[int]
    signature: Optional[str]


@dataclass(frozen=True)
class ReleaseInfo:
    """The full ``GET /v1/agent/version`` payload, normalised."""

    channel: str
    update_available: bool
    current: str
    latest: Optional[str]
    published_at: Optional[str]
    release_notes: str
    min_supported_version: Optional[str]
    artifact: Optional[ReleaseArtifact]


class UpdateError(RuntimeError):
    """Raised on a hard update failure (verification, IO, exec)."""


class Updater:
    """Driving thread for the auto-update poller.

    Construction is cheap; the real work happens once :meth:`start` is
    called from the agent runner. The thread is a daemon, so process
    exit kills it without further cleanup.
    """

    def __init__(
        self,
        *,
        cfg: AgentConfig,
        state: AgentState,
        on_update_available: Optional[Callable[[ReleaseInfo], None]] = None,
        on_check: Optional[Callable[[Optional[ReleaseInfo]], None]] = None,
        poll_interval_sec: int = DEFAULT_POLL_INTERVAL_SEC,
        channel: str = "stable",
    ) -> None:
        self._cfg = cfg
        self._state = state
        self._on_update_available = on_update_available or (lambda _r: None)
        self._on_check = on_check or (lambda _r: None)
        self._poll_interval_sec = max(60, int(poll_interval_sec))
        self._channel = channel
        self._stop = threading.Event()
        self._thread: Optional[threading.Thread] = None

    # ---------------- lifecycle ----------------

    def start(self, *, run_immediately: bool = True) -> None:
        if self._thread and self._thread.is_alive():
            return
        self._stop.clear()
        self._thread = threading.Thread(
            target=self._loop,
            name="sc2tools-updater",
            daemon=True,
            kwargs={"run_immediately": run_immediately},
        )
        self._thread.start()

    def stop(self) -> None:
        self._stop.set()
        if self._thread:
            self._thread.join(timeout=3)

    # ---------------- public API for tests + tray UI ----------------

    def check_now(self) -> Optional[ReleaseInfo]:
        """Synchronous one-shot poll. Used by the tray's "Check for
        updates" menu item and by the tests. Never raises."""
        try:
            release = self._fetch_release()
        except Exception as exc:  # noqa: BLE001
            log.warning("update_check_failed err=%s", exc)
            return None
        try:
            self._on_check(release)
        except Exception:  # noqa: BLE001
            log.exception("update_check_listener_raised")
        if release and release.update_available:
            try:
                self._on_update_available(release)
            except Exception:  # noqa: BLE001
                log.exception("update_available_listener_raised")
            self._record_seen(release)
        return release

    # ---------------- internals ----------------

    def _loop(self, *, run_immediately: bool) -> None:
        if run_immediately:
            self.check_now()
        while not self._stop.wait(self._poll_interval_sec):
            self.check_now()

    def _fetch_release(self) -> Optional[ReleaseInfo]:
        url = self._build_url()
        req = urllib.request.Request(
            url, headers={"User-Agent": USER_AGENT, "Accept": "application/json"}
        )
        ctx = ssl.create_default_context()
        with urllib.request.urlopen(req, timeout=HTTP_TIMEOUT_SEC, context=ctx) as resp:
            body = resp.read()
        try:
            payload: Dict[str, Any] = json.loads(body.decode("utf-8"))
        except json.JSONDecodeError as exc:
            raise UpdateError(f"invalid_json: {exc}") from exc
        if not isinstance(payload, dict):
            raise UpdateError("invalid_response: not an object")
        return _coerce_release(payload, fallback_current=__version__)

    def _build_url(self) -> str:
        base = self._cfg.api_base.rstrip("/")
        params = urllib.parse.urlencode(
            {
                "channel": self._channel,
                "platform": _detect_platform(),
                "current": __version__,
            }
        )
        return f"{base}/v1/agent/version?{params}"

    def _record_seen(self, release: ReleaseInfo) -> None:
        if not release.latest:
            return
        # Mutating AgentState (a frozen dataclass) requires a small
        # workaround: write through `__dict__` since the field isn't
        # part of the formal schema. Persist via save_state.
        try:
            self._state.uploaded[f"_release_seen_{release.channel}"] = release.latest
            save_state(self._cfg.state_dir, self._state)
        except Exception:  # noqa: BLE001
            log.debug("record_seen_failed", exc_info=True)


def install_release(
    release: ReleaseInfo,
    *,
    download_dir: Optional[Path] = None,
    launch_installer: bool = True,
) -> Path:
    """Download + verify + (optionally) launch the installer.

    Returns the path to the downloaded artifact. Raises
    :class:`UpdateError` on any failure. The caller is responsible for
    quitting the running agent so the installer can replace files.
    """
    if not release.artifact:
        raise UpdateError("no artifact for current platform")
    artifact = release.artifact
    target = (download_dir or Path(tempfile.gettempdir())) / _artifact_filename(artifact)
    _download_with_progress(artifact, target)
    digest = _sha256_file(target)
    if digest.lower() != artifact.sha256.lower():
        try:
            target.unlink(missing_ok=True)
        except OSError:
            pass
        raise UpdateError(
            f"sha256_mismatch: expected={artifact.sha256[:8]}…"
            f" got={digest[:8]}…",
        )
    if launch_installer and _running_frozen():
        _spawn_installer_detached(target)
    return target


def _download_with_progress(artifact: ReleaseArtifact, target: Path) -> None:
    target.parent.mkdir(parents=True, exist_ok=True)
    if target.exists():
        try:
            target.unlink()
        except OSError:
            pass
    req = urllib.request.Request(
        artifact.download_url,
        headers={"User-Agent": USER_AGENT, "Accept": "application/octet-stream"},
    )
    ctx = ssl.create_default_context()
    try:
        with urllib.request.urlopen(req, timeout=HTTP_TIMEOUT_SEC, context=ctx) as resp:
            tmp_target = target.with_suffix(target.suffix + ".part")
            with tmp_target.open("wb") as fh:
                while True:
                    chunk = resp.read(DOWNLOAD_CHUNK)
                    if not chunk:
                        break
                    fh.write(chunk)
            shutil.move(str(tmp_target), str(target))
    except urllib.error.URLError as exc:
        raise UpdateError(f"download_failed: {exc}") from exc


def _sha256_file(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as fh:
        while True:
            chunk = fh.read(DOWNLOAD_CHUNK)
            if not chunk:
                break
            digest.update(chunk)
    return digest.hexdigest()


def _spawn_installer_detached(installer_path: Path) -> None:
    """Launch the installer with a short delay and detach so this
    process can exit immediately. Windows-only path uses
    ``DETACHED_PROCESS | CREATE_NEW_PROCESS_GROUP`` so the installer
    survives our SIGTERM."""
    delay = INSTALLER_LAUNCH_DELAY_SEC
    if os.name == "nt":
        # `cmd /c timeout & path-to-installer` runs the timeout
        # synchronously then launches the installer. We start cmd in a
        # detached process group.
        cmd = (
            f'cmd.exe /c timeout /t {delay} > NUL && '
            f'start "" /B "{installer_path}" /S'
        )
        creationflags = 0
        if hasattr(subprocess, "DETACHED_PROCESS"):
            creationflags = subprocess.DETACHED_PROCESS  # type: ignore[attr-defined]
        if hasattr(subprocess, "CREATE_NEW_PROCESS_GROUP"):
            creationflags |= subprocess.CREATE_NEW_PROCESS_GROUP
        subprocess.Popen(
            cmd,
            shell=True,
            close_fds=True,
            creationflags=creationflags,
            stdin=subprocess.DEVNULL,
            stdout=subprocess.DEVNULL,
            stderr=subprocess.DEVNULL,
        )
    else:
        # Generic POSIX path used by macOS / Linux dev installs. Sleeps
        # then runs the artifact directly. The installer itself is
        # platform-specific so we just hand it off.
        subprocess.Popen(
            ["/bin/sh", "-c", f"sleep {delay} && '{installer_path}'"],
            stdin=subprocess.DEVNULL,
            stdout=subprocess.DEVNULL,
            stderr=subprocess.DEVNULL,
            start_new_session=True,
            close_fds=True,
        )


def _coerce_release(payload: Dict[str, Any], *, fallback_current: str) -> ReleaseInfo:
    artifact_raw = payload.get("artifact") or None
    artifact: Optional[ReleaseArtifact] = None
    if isinstance(artifact_raw, dict):
        with contextlib.suppress(Exception):
            artifact = ReleaseArtifact(
                platform=str(artifact_raw.get("platform", "")),
                download_url=str(artifact_raw.get("downloadUrl", "")),
                sha256=str(artifact_raw.get("sha256", "")),
                size_bytes=_coerce_int(artifact_raw.get("sizeBytes")),
                signature=_coerce_str(artifact_raw.get("signature")),
            )
    return ReleaseInfo(
        channel=str(payload.get("channel", "stable")),
        update_available=bool(payload.get("update_available")),
        current=str(payload.get("current", fallback_current)),
        latest=_coerce_str(payload.get("latest")),
        published_at=_coerce_str(payload.get("publishedAt")),
        release_notes=str(payload.get("releaseNotes", "") or ""),
        min_supported_version=_coerce_str(payload.get("minSupportedVersion")),
        artifact=artifact,
    )


def _coerce_str(value: Any) -> Optional[str]:
    if value is None or value == "":
        return None
    return str(value)


def _coerce_int(value: Any) -> Optional[int]:
    try:
        return int(value)
    except (TypeError, ValueError):
        return None


def _artifact_filename(artifact: ReleaseArtifact) -> str:
    parsed = urllib.parse.urlparse(artifact.download_url)
    base = os.path.basename(parsed.path) or "sc2tools-installer"
    safe = "".join(c for c in base if c.isalnum() or c in "._-")
    if not safe:
        safe = "sc2tools-installer"
    return safe


def _detect_platform() -> str:
    system = platform.system().lower()
    if system == "windows":
        return "windows"
    if system == "darwin":
        return "macos"
    return "linux"


def _running_frozen() -> bool:
    """True when running under PyInstaller — the agent has been
    packaged into an .exe. Source-run installs leave this False."""
    return getattr(sys, "frozen", False) is True


__all__ = [
    "Updater",
    "ReleaseInfo",
    "ReleaseArtifact",
    "UpdateError",
    "install_release",
]
