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
import re
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
from typing import Any, Callable, Dict, Iterable, Optional

from . import __version__
from .config import AgentConfig
from .state import AgentState, save_state

log = logging.getLogger(__name__)

DEFAULT_POLL_INTERVAL_SEC = 12 * 60 * 60  # twice daily
USER_AGENT = f"sc2tools-agent/{__version__} updater"
HTTP_TIMEOUT_SEC = 30
DOWNLOAD_CHUNK = 1024 * 256
INSTALLER_LAUNCH_DELAY_SEC = 3
# UploadQueue deliberately lets a throttled/in-flight cloud request finish
# during shutdown (its longest bounded request is 150 seconds).  Keep the
# installer helper comfortably beyond that envelope so NSIS's taskkill
# backstop cannot cut off an accepted replay/archive write.
INSTALLER_PARENT_EXIT_TIMEOUT_SEC = 300

# A startup poll and a user-initiated "Check for updates" can overlap.
# Serialise the whole cache/download/launch transaction so two threads in
# one agent process never write the same installer (or staging file)
# concurrently. Unique staging paths below also protect against a stale
# competing agent process during an upgrade.
_INSTALL_LOCK = threading.Lock()
_LAUNCHED_ARTIFACTS: set[str] = set()

# Hosts an installer may be downloaded from when the caller doesn't
# extend the allowlist. Releases ship via GitHub Releases; the
# redirect target is *.githubusercontent.com. Anything else — even if
# the (attacker-controlled) version feed asks for it — is refused, so
# a compromised feed alone cannot point agents at an arbitrary exe.
GITHUB_DOWNLOAD_HOSTS = ("github.com",)
GITHUB_DOWNLOAD_HOST_SUFFIXES = (".github.com", ".githubusercontent.com")


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
        # Dedicated state field — earlier versions stashed a
        # ``_release_seen_<channel>`` marker inside ``state.uploaded``,
        # which count_synced() then counted as a synced replay.
        try:
            self._state.release_seen[release.channel] = release.latest
            save_state(self._cfg.state_dir, self._state)
        except Exception:  # noqa: BLE001
            log.debug("record_seen_failed", exc_info=True)


def update_is_mandatory(release: ReleaseInfo) -> bool:
    """True when the running version is below the feed's compatibility
    floor (``minSupportedVersion``) — the cloud no longer supports it,
    so the auto-update opt-out does not apply."""
    if not release.min_supported_version:
        return False
    return _version_lt(release.current, release.min_supported_version)


def _version_lt(a: str, b: str) -> bool:
    """Numeric dot-version comparison. Unparseable versions compare
    equal (never force an update off garbage input)."""
    ta, tb = _version_tuple(a), _version_tuple(b)
    if ta is None or tb is None:
        return False
    length = max(len(ta), len(tb))
    ta += (0,) * (length - len(ta))
    tb += (0,) * (length - len(tb))
    return ta < tb


def _version_tuple(v: str) -> Optional[tuple]:
    m = re.match(r"\s*v?(\d+(?:\.\d+)*)", v or "")
    if not m:
        return None
    return tuple(int(p) for p in m.group(1).split("."))


def _assert_trusted_download(
    artifact: ReleaseArtifact,
    trusted_hosts: Optional[Iterable[str]],
) -> None:
    """Refuse download URLs outside the allowlist.

    Trusted by default: github.com and *.githubusercontent.com over
    https. ``trusted_hosts`` extends the set (the runner passes the API
    host; tests pass loopback). Extra hosts are exempt from the https
    requirement so the localhost test fixtures keep working — GitHub
    hosts always require https.
    """
    parsed = urllib.parse.urlparse(artifact.download_url)
    host = (parsed.hostname or "").lower()
    extra = {h.lower() for h in (trusted_hosts or ()) if h}
    if host in extra:
        return
    github_host = host in GITHUB_DOWNLOAD_HOSTS or any(
        host.endswith(suffix) for suffix in GITHUB_DOWNLOAD_HOST_SUFFIXES
    )
    if github_host and parsed.scheme == "https":
        return
    raise UpdateError(f"untrusted_download_host: {host or '<none>'}")


def install_release(
    release: ReleaseInfo,
    *,
    download_dir: Optional[Path] = None,
    launch_installer: bool = True,
    trusted_hosts: Optional[Iterable[str]] = None,
) -> Path:
    """Download + verify + (optionally) launch the installer.

    Returns the path to the downloaded artifact. Raises
    :class:`UpdateError` on any failure — including a download URL
    outside the trusted-host allowlist. The caller is responsible for
    quitting the running agent so the installer can replace files.
    """
    if not release.artifact:
        raise UpdateError("no artifact for current platform")
    artifact = release.artifact
    _assert_trusted_download(artifact, trusted_hosts)
    target = (
        download_dir or Path(tempfile.gettempdir())
    ) / _artifact_filename(artifact)

    with _INSTALL_LOCK:
        # Reusing a fully verified cached installer is both faster and
        # essential on Windows: an already-running installer (or an AV
        # scanner) may temporarily hold the .exe open, making unlink or
        # replacement fail with WinError 32. Never trust the filename
        # alone; both the advertised size and SHA-256 must match.
        selected = target if _artifact_matches(target, artifact) else None
        if selected is None:
            staged = _download_to_staging(artifact, target)
            try:
                _validate_artifact(staged, artifact)
                selected = _publish_staged_artifact(staged, target, artifact)
            except Exception:
                _remove_quietly(staged)
                raise

        if launch_installer and _running_frozen():
            launch_key = artifact.sha256.strip().lower()
            if launch_key not in _LAUNCHED_ARTIFACTS:
                _spawn_installer_detached(selected)
                # Only mark it after the detached helper was created. A
                # synchronous launch error must remain retryable.
                _LAUNCHED_ARTIFACTS.add(launch_key)
        return selected


def _download_to_staging(
    artifact: ReleaseArtifact,
    target: Path,
) -> Path:
    """Download into an exclusively-created sibling staging file."""
    target.parent.mkdir(parents=True, exist_ok=True)
    fd, raw_staged = tempfile.mkstemp(
        prefix=f".{target.stem}-",
        suffix=f"{target.suffix}.part",
        dir=str(target.parent),
    )
    staged = Path(raw_staged)
    req = urllib.request.Request(
        artifact.download_url,
        headers={"User-Agent": USER_AGENT, "Accept": "application/octet-stream"},
    )
    ctx = ssl.create_default_context()
    try:
        with urllib.request.urlopen(req, timeout=HTTP_TIMEOUT_SEC, context=ctx) as resp:
            with os.fdopen(fd, "wb") as fh:
                fd = -1
                while True:
                    chunk = resp.read(DOWNLOAD_CHUNK)
                    if not chunk:
                        break
                    fh.write(chunk)
                fh.flush()
                os.fsync(fh.fileno())
    except urllib.error.URLError as exc:
        if fd >= 0:
            os.close(fd)
        _remove_quietly(staged)
        raise UpdateError(f"download_failed: {exc}") from exc
    except OSError as exc:
        if fd >= 0:
            os.close(fd)
        _remove_quietly(staged)
        raise UpdateError(f"download_io_failed: {exc}") from exc
    return staged


def _validate_artifact(path: Path, artifact: ReleaseArtifact) -> None:
    try:
        actual_size = path.stat().st_size
    except OSError as exc:
        raise UpdateError(f"artifact_unreadable: {exc}") from exc
    if artifact.size_bytes is not None and actual_size != artifact.size_bytes:
        raise UpdateError(
            f"size_mismatch: expected={artifact.size_bytes} got={actual_size}",
        )
    try:
        digest = _sha256_file(path)
    except OSError as exc:
        raise UpdateError(f"artifact_unreadable: {exc}") from exc
    if digest.lower() != artifact.sha256.lower():
        raise UpdateError(
            f"sha256_mismatch: expected={artifact.sha256[:8]}…"
            f" got={digest[:8]}…",
        )


def _artifact_matches(path: Path, artifact: ReleaseArtifact) -> bool:
    if not path.is_file():
        return False
    try:
        _validate_artifact(path, artifact)
    except UpdateError:
        return False
    return True


def _publish_staged_artifact(
    staged: Path,
    target: Path,
    artifact: ReleaseArtifact,
) -> Path:
    """Atomically publish a verified download, with a lock-safe fallback."""
    # A separate agent process may have completed the same download.
    if _artifact_matches(target, artifact):
        _remove_quietly(staged)
        return target
    try:
        os.replace(staged, target)
        return target
    except OSError as exc:
        # The target can become valid between the pre-check and replace.
        if _artifact_matches(target, artifact):
            _remove_quietly(staged)
            return target

        # An invalid target may be temporarily locked by a scanner or a
        # previous installer. The staging name is already unique; remove
        # only its `.part` suffix and launch the verified copy from there.
        fallback = staged.with_suffix("")
        try:
            os.replace(staged, fallback)
        except OSError as fallback_exc:
            raise UpdateError(
                f"artifact_publish_failed: {fallback_exc}",
            ) from fallback_exc
        log.warning(
            "installer_cache_target_locked target=%s fallback=%s err=%s",
            target,
            fallback,
            exc,
        )
        return fallback


def _remove_quietly(path: Path) -> None:
    try:
        path.unlink(missing_ok=True)
    except OSError:
        pass


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
    """Launch the installer with a short delay in a background helper.

    The Windows helper uses ``CREATE_NO_WINDOW`` to stay invisible and a
    separate process group so it survives the agent's orderly exit.
    """
    delay = INSTALLER_LAUNCH_DELAY_SEC
    if os.name == "nt":
        _spawn_windows_installer_detached(
            installer_path,
            parent_pid=os.getpid(),
            timeout_sec=INSTALLER_PARENT_EXIT_TIMEOUT_SEC,
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


def _spawn_windows_installer_detached(
    installer_path: Path,
    *,
    parent_pid: int,
    timeout_sec: int,
) -> None:
    """Start a detached, delayed Windows installer helper safely.

    The former ``cmd /c timeout ... && start`` command was launched with
    stdin redirected to ``DEVNULL``. Windows ``timeout`` rejects redirected
    input and can therefore make ``&&`` skip the installer completely. Use
    a fixed PowerShell program with ``shell=False``. The helper waits until
    this agent process has exited so orderly uploader shutdown can finish;
    a bounded timeout still launches NSIS if shutdown gets stuck.

    ``DETACHED_PROCESS`` is deliberately not used here. It proved unreliable
    for the frozen agent's PowerShell hand-off: the agent could close after a
    successful ``Popen`` while the helper disappeared before starting NSIS.
    ``CREATE_NO_WINDOW`` keeps normal child-process semantics without flashing
    a console, and ``CREATE_NEW_PROCESS_GROUP`` isolates the helper from the
    agent's control events. Untrusted values are passed only through the child
    environment, never interpolated into the program text.
    """
    system_root = Path(os.environ.get("SystemRoot") or r"C:\Windows")
    powershell = (
        system_root
        / "System32"
        / "WindowsPowerShell"
        / "v1.0"
        / "powershell.exe"
    )
    helper_env = os.environ.copy()
    helper_env["SC2TOOLS_UPDATE_INSTALLER_PATH"] = str(installer_path)
    helper_env["SC2TOOLS_UPDATE_PARENT_PID"] = str(int(parent_pid))
    helper_env["SC2TOOLS_UPDATE_EXIT_TIMEOUT_SEC"] = str(
        max(1, int(timeout_sec)),
    )
    program = (
        "$ErrorActionPreference = 'Stop'; "
        "$agentProcessId = [int][Environment]::GetEnvironmentVariable("
        "'SC2TOOLS_UPDATE_PARENT_PID', 'Process'); "
        "$timeoutSeconds = [int][Environment]::GetEnvironmentVariable("
        "'SC2TOOLS_UPDATE_EXIT_TIMEOUT_SEC', 'Process'); "
        "$deadline = [DateTime]::UtcNow.AddSeconds($timeoutSeconds); "
        "while ([DateTime]::UtcNow -lt $deadline -and "
        "(Get-Process -Id $agentProcessId -ErrorAction SilentlyContinue)) { "
        "Start-Sleep -Milliseconds 250 }; "
        "$installer = [Environment]::GetEnvironmentVariable("
        "'SC2TOOLS_UPDATE_INSTALLER_PATH', 'Process'); "
        "Start-Process -FilePath $installer -ArgumentList @('/S') "
        "-WindowStyle Hidden"
    )
    creationflags = 0
    if hasattr(subprocess, "CREATE_NO_WINDOW"):
        creationflags = subprocess.CREATE_NO_WINDOW  # type: ignore[attr-defined]
    if hasattr(subprocess, "CREATE_NEW_PROCESS_GROUP"):
        creationflags |= subprocess.CREATE_NEW_PROCESS_GROUP
    subprocess.Popen(
        [
            str(powershell),
            "-NoLogo",
            "-NoProfile",
            "-NonInteractive",
            "-WindowStyle",
            "Hidden",
            "-Command",
            program,
        ],
        shell=False,
        close_fds=True,
        creationflags=creationflags,
        env=helper_env,
        stdin=subprocess.DEVNULL,
        stdout=subprocess.DEVNULL,
        stderr=subprocess.DEVNULL,
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
    "update_is_mandatory",
]
