"""SC2 Tools desktop launcher.

Entry point invoked by START_SC2_TOOLS.bat (and by anyone double-clicking
this file's icon). Replaces the legacy Tkinter analyzer GUI with a thin
shim that spins up the Express backend, waits for /api/health to respond,
opens the React SPA in the default browser, and forwards lifecycle events
so closing the terminal cleanly stops the backend.

The Tkinter GUI under SC2Replay-Analyzer/ui/ is archived as ``*.deprecated``;
nothing in the shipping code path imports from it anymore.

Example:
    $ python SC2ReplayAnalyzer.py
    [launcher] backend up on :3000; opened http://127.0.0.1:3000/analyzer/
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

# --- Constants ------------------------------------------------------------
ROOT: Path = Path(__file__).resolve().parent.parent
BACKEND_DIR: Path = ROOT / "reveal-sc2-opponent-main" / "stream-overlay-backend"

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
    creationflags = (
        subprocess.CREATE_NEW_PROCESS_GROUP if _IS_WINDOWS else 0
    )
    return subprocess.Popen(
        [_NPM_CMD, "start"],
        cwd=str(BACKEND_DIR),
        env=env,
        creationflags=creationflags,
    )


def stop_backend(proc: subprocess.Popen) -> None:
    """Politely shut down ``proc``, escalating to ``kill`` on timeout.

    Idempotent: returns immediately if the process has already exited.

    Example:
        >>> stop_backend(proc)  # doctest: +SKIP
    """
    if proc.poll() is not None:
        return
    try:
        if _IS_WINDOWS:
            proc.send_signal(signal.CTRL_BREAK_EVENT)
        else:
            proc.terminate()
        proc.wait(timeout=SHUTDOWN_TIMEOUT_SEC)
    except (subprocess.TimeoutExpired, OSError):
        proc.kill()


def wait_for_ready(url: str, timeout_sec: int = READY_TIMEOUT_SEC) -> bool:
    """Poll ``url`` once per second until it responds 200 or the budget runs out.

    Args:
        url: Fully-qualified health endpoint, e.g. ``http://127.0.0.1:3000/api/health``.
        timeout_sec: Total seconds to wait before giving up.

    Returns:
        True if the endpoint responded with HTTP 200 in time, False otherwise.

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


def main() -> int:
    """Boot backend, wait for readiness, open the SPA, block on the child.

    Returns:
        The backend's exit code, or a non-zero startup error code.

    Example:
        >>> sys.exit(main())  # doctest: +SKIP
    """
    port = get_port()
    proc = start_backend(port)
    atexit.register(stop_backend, proc)
    try:
        health_url = f"http://127.0.0.1:{port}{HEALTH_PATH}"
        if not wait_for_ready(health_url):
            print(
                f"FATAL: backend did not become ready at {health_url}",
                file=sys.stderr,
            )
            return EXIT_CODE_NOT_READY
        spa_url = f"http://127.0.0.1:{port}{SPA_PATH}"
        webbrowser.open_new_tab(spa_url)
        print(f"[launcher] backend up on :{port}; opened {spa_url}")
        return proc.wait()
    finally:
        stop_backend(proc)


if __name__ == "__main__":
    sys.exit(main())
