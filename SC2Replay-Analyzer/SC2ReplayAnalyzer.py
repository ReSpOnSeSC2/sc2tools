"""SC2 Tools desktop launcher.

Entry point invoked by ``START_SC2_TOOLS.bat`` and by anyone double-
clicking the installer-generated shortcut. Replaces the legacy Tkinter
analyzer GUI with a thin shim that:

  1. Spins up the Express backend (``npm start`` in
     ``reveal-sc2-opponent-main/stream-overlay-backend``).
  2. Spins up the live replay watcher
     (``python -m watchers.replay_watcher``) so new ladder games are
     auto-parsed and posted to ``/api/replay``.
  3. Spins up the SC2Pulse opponent poller (PowerShell
     ``Reveal-Sc2Opponent.ps1``) with character IDs, player name, and
     active regions read from ``data/config.json`` -- no more
     hardcoded values in ``reveal-sc2-opponent.bat``.
  4. Waits for ``/api/health`` to respond.
  5. Opens the SPA in the user''s default browser.
  6. Forwards lifecycle events so closing this terminal cleanly stops
     all three children.

Children that fail to spawn are logged and skipped -- the launcher
prefers a partial start over a hard fail, because the backend on its
own is still useful (you can browse the analyzer; just no live
ingestion). The Tkinter GUI under ``SC2Replay-Analyzer/ui/`` is
archived as ``*.deprecated`` and is not imported here.

Configuration knobs (``data/config.json``)::

    {
      "runtime": {
        "spawn_watcher": true,    // default true
        "spawn_poller":  true     // default true; auto-false if no IDs
      },
      "identities": [...],         // pulse_id, region, name
      "stream_overlay": { "pulse_character_ids": [...] }
    }

Example:
    $ python SC2ReplayAnalyzer.py
    [launcher] backend up on :3000; opened http://127.0.0.1:3000/analyzer/
    [launcher] watcher started (pid=12345)
    [launcher] poller started (pid=12346) ids=2 regions=us,eu
"""

from __future__ import annotations

import atexit
import os
import signal
import subprocess
import sys
import time
import urllib.error
import urllib.request
import webbrowser
from pathlib import Path
from typing import Any, Dict, List, Optional

# Local helper: pure config-shaping (no IO once config is loaded).
sys.path.insert(0, str(Path(__file__).resolve().parent))
import launcher_config  # noqa: E402  -- needs sys.path tweak above.

# --- Constants ------------------------------------------------------------
ROOT: Path = Path(__file__).resolve().parent.parent
BACKEND_REPO: Path = ROOT / "reveal-sc2-opponent-main"
BACKEND_DIR: Path = BACKEND_REPO / "stream-overlay-backend"
DATA_DIR: Path = BACKEND_REPO / "data"
CONFIG_PATH: Path = DATA_DIR / launcher_config.CONFIG_FILENAME
POLLER_SCRIPT: Path = BACKEND_REPO / "Reveal-Sc2Opponent.ps1"

DEFAULT_PORT: int = 3000
PORT_ENV_VAR: str = "SC2_TOOLS_PORT"
HEALTH_PATH: str = "/api/health"
SPA_PATH: str = "/analyzer/"

READY_TIMEOUT_SEC: int = 30
SHUTDOWN_TIMEOUT_SEC: int = 5
HEALTH_POLL_INTERVAL_SEC: float = 1.0
HEALTH_REQUEST_TIMEOUT_SEC: float = 1.0

EXIT_CODE_BACKEND_MISSING: int = 1
EXIT_CODE_NOT_READY: int = 2

_IS_WINDOWS: bool = os.name == "nt"
_NPM_CMD: str = "npm.cmd" if _IS_WINDOWS else "npm"

# Windows-only flag: place each child in a new process group so we can
# deliver CTRL_BREAK_EVENT for a clean shutdown without killing our own
# console. CREATE_NEW_CONSOLE on the poller gives PowerShell its own
# window (matches the legacy ``start powershell`` behaviour from the
# old reveal-sc2-opponent.bat).
_PROCESS_GROUP_FLAG: int = (
    subprocess.CREATE_NEW_PROCESS_GROUP if _IS_WINDOWS else 0
)
_NEW_CONSOLE_FLAG: int = (
    getattr(subprocess, "CREATE_NEW_CONSOLE", 0) if _IS_WINDOWS else 0
)

# Poller is Windows-only because Reveal-Sc2Opponent.ps1 is PowerShell.
_POWERSHELL_EXE: str = "powershell.exe"

# Tag used in log lines. Keeps grep predictable.
_LOG_TAG: str = "[launcher]"


def _log(msg: str) -> None:
    """Print ``msg`` with the launcher tag and flush stdout.

    Centralised so output lands in the .bat console in real time when
    Python is buffering. Not for verbose tracing -- this is the
    user-visible launcher narration.
    """
    print(f"{_LOG_TAG} {msg}", flush=True)


def get_port() -> int:
    """Resolve the backend port from ``SC2_TOOLS_PORT`` or fall back to 3000.

    Example:
        >>> os.environ.pop("SC2_TOOLS_PORT", None)
        >>> get_port()
        3000
    """
    raw = os.environ.get(PORT_ENV_VAR, str(DEFAULT_PORT))
    try:
        return int(raw)
    except ValueError:
        print(
            f"WARN: invalid {PORT_ENV_VAR}={raw!r}; using {DEFAULT_PORT}",
            file=sys.stderr,
        )
        return DEFAULT_PORT


def start_backend(port: int) -> subprocess.Popen:
    """Spawn ``npm start`` inside the backend directory and return the process.

    On Windows the child is placed in a new process group so we can later
    deliver ``CTRL_BREAK_EVENT`` for a clean shutdown without killing our
    own console.

    Example:
        >>> proc = start_backend(3000)  # doctest: +SKIP
        >>> proc.poll() is None         # doctest: +SKIP
        True
    """
    if not BACKEND_DIR.exists():
        print(
            f"FATAL: stream-overlay-backend not found at {BACKEND_DIR}",
            file=sys.stderr,
        )
        sys.exit(EXIT_CODE_BACKEND_MISSING)

    env = {**os.environ, "PORT": str(port)}
    return subprocess.Popen(
        [_NPM_CMD, "start"],
        cwd=str(BACKEND_DIR),
        env=env,
        creationflags=_PROCESS_GROUP_FLAG,
    )


def start_watcher() -> Optional[subprocess.Popen]:
    """Spawn ``python -m watchers.replay_watcher`` in the backend repo.

    Uses the *same* Python interpreter that''s running the launcher
    (``sys.executable``) so a shipped install picks up the bundled
    Python and its sc2reader. Returns ``None`` if the watchers module
    is missing on disk (e.g. partial install) -- the backend should
    still come up, just without live ingestion.

    Example:
        >>> proc = start_watcher()  # doctest: +SKIP
        >>> proc and proc.poll() is None  # doctest: +SKIP
        True
    """
    watchers_pkg = BACKEND_REPO / "watchers" / "__init__.py"
    if not watchers_pkg.exists():
        _log(f"watcher skipped: {watchers_pkg.parent} not found")
        return None
    proc = subprocess.Popen(
        [sys.executable, "-m", "watchers.replay_watcher"],
        cwd=str(BACKEND_REPO),
        creationflags=_PROCESS_GROUP_FLAG,
    )
    _log(f"watcher started (pid={proc.pid})")
    return proc


def _build_poller_argv(pulse: Dict[str, Any]) -> Optional[List[str]]:
    """Thin wrapper over :func:`launcher_config.build_poller_argv`.

    Kept for callsite-readability inside ``main`` and to centralise
    the constants (``_POWERSHELL_EXE`` and ``POLLER_SCRIPT``) that
    differ between the launcher and the standalone helper.

    Example:
        >>> _build_poller_argv({"character_ids": ["1"], "regions": ["us"],
        ...                     "player_name": None}) is not None
        True
    """
    return launcher_config.build_poller_argv(
        _POWERSHELL_EXE, pulse, POLLER_SCRIPT
    )


def start_poller(pulse: Dict[str, Any]) -> Optional[subprocess.Popen]:
    """Spawn ``Reveal-Sc2Opponent.ps1`` with config-derived arguments.

    Windows-only: the PS1 script and the subprocess flags assume a
    Windows host. On other platforms returns ``None``.

    The poller runs in a new console window so the user can see its
    output and close it independently -- matches the legacy
    ``start powershell`` behaviour from ``reveal-sc2-opponent.bat``.

    Example:
        >>> start_poller({"character_ids": ["994428"],
        ...               "player_name": "ReSpOnSe",
        ...               "regions": ["us"]})  # doctest: +SKIP
    """
    if not _IS_WINDOWS:
        _log("poller skipped: not Windows")
        return None
    if not POLLER_SCRIPT.exists():
        _log(f"poller skipped: {POLLER_SCRIPT.name} not found")
        return None
    argv = _build_poller_argv(pulse)
    if argv is None:
        _log("poller skipped: no character_ids or player_name in config")
        return None
    proc = subprocess.Popen(
        argv,
        cwd=str(BACKEND_REPO),
        creationflags=_PROCESS_GROUP_FLAG | _NEW_CONSOLE_FLAG,
    )
    _log(
        f"poller started (pid={proc.pid}) "
        f"ids={len(pulse.get('character_ids') or [])} "
        f"regions={','.join(pulse.get('regions') or [])}"
    )
    return proc


def stop_child(proc: Optional[subprocess.Popen]) -> None:
    """Politely shut down ``proc``, escalating to ``kill`` on timeout.

    Idempotent: returns immediately if ``proc`` is ``None`` or has
    already exited. On Windows, sends ``CTRL_BREAK_EVENT`` (the only
    signal that crosses console boundaries reliably for a child placed
    in a new process group); on POSIX, ``terminate()``.

    Example:
        >>> stop_child(proc)  # doctest: +SKIP
    """
    if proc is None or proc.poll() is not None:
        return
    try:
        if _IS_WINDOWS:
            proc.send_signal(signal.CTRL_BREAK_EVENT)
        else:
            proc.terminate()
        proc.wait(timeout=SHUTDOWN_TIMEOUT_SEC)
    except (subprocess.TimeoutExpired, OSError):
        try:
            proc.kill()
        except OSError:
            pass


def wait_for_ready(url: str, timeout_sec: int = READY_TIMEOUT_SEC) -> bool:
    """Poll ``url`` once per second until it responds 200 or the budget runs out.

    Args:
        url: Fully-qualified health endpoint, e.g.
            ``http://127.0.0.1:3000/api/health``.
        timeout_sec: Total seconds to wait before giving up.

    Returns:
        True if the endpoint responded with HTTP 200 in time, False
        otherwise.

    Example:
        >>> wait_for_ready("http://127.0.0.1:3000/api/health")  # doctest: +SKIP
        True
    """
    deadline = time.monotonic() + timeout_sec
    while time.monotonic() < deadline:
        try:
            with urllib.request.urlopen(
                url, timeout=HEALTH_REQUEST_TIMEOUT_SEC,
            ) as resp:
                if resp.status == 200:
                    return True
        except (urllib.error.URLError, ConnectionRefusedError, OSError):
            pass
        time.sleep(HEALTH_POLL_INTERVAL_SEC)
    return False


def _start_optional_children(config: Dict[str, Any]) -> List[subprocess.Popen]:
    """Spawn watcher and poller per ``runtime`` flags in config.

    Returns the list of started ``Popen`` instances, in start order, for
    atexit registration. Failures are logged and skipped so a partial
    spawn never aborts launcher boot.
    """
    flags = launcher_config.read_runtime_flags(config)
    pulse = launcher_config.read_pulse_args(config)
    spawned: List[subprocess.Popen] = []
    if flags["spawn_watcher"]:
        try:
            proc = start_watcher()
            if proc is not None:
                spawned.append(proc)
        except OSError as exc:
            _log(f"watcher spawn failed: {exc}")
    else:
        _log("watcher skipped: runtime.spawn_watcher=false")
    if flags["spawn_poller"]:
        try:
            proc = start_poller(pulse)
            if proc is not None:
                spawned.append(proc)
        except OSError as exc:
            _log(f"poller spawn failed: {exc}")
    else:
        _log("poller skipped: disabled or no identity in config")
    return spawned


def _open_spa(port: int) -> None:
    """Open the analyzer SPA in the user''s default browser."""
    spa_url = f"http://127.0.0.1:{port}{SPA_PATH}"
    webbrowser.open_new_tab(spa_url)
    _log(f"opened {spa_url}")


def _register_shutdown(procs: List[subprocess.Popen]) -> None:
    """Register atexit handlers to stop ``procs`` in reverse start order."""
    for proc in reversed(procs):
        atexit.register(stop_child, proc)


def main() -> int:
    """Boot backend + watcher + poller, wait for readiness, open SPA, block.

    Returns the backend''s exit code, or a non-zero startup error
    code. Optional children (watcher, poller) are best-effort: a
    failure to spawn them is logged but does not abort the launcher.

    Example:
        >>> sys.exit(main())  # doctest: +SKIP
    """
    port = get_port()
    config = launcher_config.load_config(CONFIG_PATH)
    backend = start_backend(port)
    spawned: List[subprocess.Popen] = [backend]
    _register_shutdown(spawned)
    try:
        health_url = f"http://127.0.0.1:{port}{HEALTH_PATH}"
        if not wait_for_ready(health_url):
            print(
                f"FATAL: backend did not become ready at {health_url}",
                file=sys.stderr,
            )
            return EXIT_CODE_NOT_READY
        _log(f"backend up on :{port}")
        children = _start_optional_children(config)
        for child in children:
            spawned.append(child)
            atexit.register(stop_child, child)
        _open_spa(port)
        return backend.wait()
    finally:
        for proc in reversed(spawned):
            stop_child(proc)


if __name__ == "__main__":
    sys.exit(main())
