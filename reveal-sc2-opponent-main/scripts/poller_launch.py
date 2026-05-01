"""Launch ``Reveal-Sc2Opponent.ps1`` with config-derived arguments.

This script exists so two callers don''t duplicate the "read config,
build PowerShell argv, spawn poller" logic:

  1. ``SC2ReplayAnalyzer.py`` -- the desktop launcher imports
     ``launcher_config`` and spawns PS directly.
  2. ``reveal-sc2-opponent.bat`` -- the legacy manual-invocation path
     now just runs ``python scripts/poller_launch.py`` instead of
     hardcoding character IDs / player name / regions.

Both paths end up calling the same PowerShell with the same arguments.
The .bat exists for power users who want to run the poller without
the rest of the toolkit; the launcher path is what installer
shortcuts hit.

Exit codes
----------
* ``0`` -- PowerShell launched (we don''t wait for it; PS opens its
  own console with -NoExit and lives until the user closes it).
* ``2`` -- PowerShell binary missing (non-Windows, or unusual PATH).
* ``3`` -- ``Reveal-Sc2Opponent.ps1`` not found relative to the repo.
* ``4`` -- Config has neither character IDs nor a player name; nothing
  to poll for.

Example:
    > python scripts/poller_launch.py
    [poller_launch] launched powershell pid=12345 ids=2 regions=us,eu
"""
from __future__ import annotations

import os
import shutil
import subprocess
import sys
from pathlib import Path
from typing import Any, Dict, List, Optional

# Make ``launcher_config`` importable. It lives next to the launcher
# in ``SC2Replay-Analyzer/`` -- two dirs up from this script
# (``reveal-sc2-opponent-main/scripts/`` -> repo root -> sibling).
_REPO_ROOT = Path(__file__).resolve().parent.parent
_LAUNCHER_DIR = _REPO_ROOT.parent / "SC2Replay-Analyzer"
sys.path.insert(0, str(_LAUNCHER_DIR))
import launcher_config  # noqa: E402  -- needs sys.path tweak above.

POLLER_SCRIPT: Path = _REPO_ROOT / "Reveal-Sc2Opponent.ps1"
CONFIG_PATH: Path = _REPO_ROOT / "data" / launcher_config.CONFIG_FILENAME

EXIT_OK: int = 0
EXIT_NO_POWERSHELL: int = 2
EXIT_NO_SCRIPT: int = 3
EXIT_NO_IDENTITY: int = 4

_LOG_TAG: str = "[poller_launch]"

# CREATE_NEW_CONSOLE on Windows gives PowerShell its own window so the
# user can read the poller output and close it independently. On non-
# Windows the flag is a no-op (we exit before reaching this anyway).
_NEW_CONSOLE_FLAG: int = (
    getattr(subprocess, "CREATE_NEW_CONSOLE", 0) if os.name == "nt" else 0
)
_PROCESS_GROUP_FLAG: int = (
    getattr(subprocess, "CREATE_NEW_PROCESS_GROUP", 0)
    if os.name == "nt" else 0
)


def _log(msg: str) -> None:
    """Print a tagged line and flush stdout."""
    print(f"{_LOG_TAG} {msg}", flush=True)


def _resolve_powershell() -> Optional[str]:
    """Return the full path to ``powershell.exe`` or ``None``.

    Falls back to the PATH lookup; if it''s not on PATH the poller
    can''t run anyway, so we surface a clean error.
    """
    return shutil.which("powershell.exe") or shutil.which("powershell")


def _build_argv(ps_exe: str, pulse: Dict[str, Any]) -> Optional[List[str]]:
    """Thin wrapper over :func:`launcher_config.build_poller_argv`.

    Centralises the argv-building logic so the launcher and this
    helper can never drift. Kept as a module-private wrapper for
    test ergonomics.
    """
    return launcher_config.build_poller_argv(ps_exe, pulse, POLLER_SCRIPT)


def main() -> int:
    """Read config, build PowerShell argv, spawn the poller."""
    if not POLLER_SCRIPT.exists():
        _log(f"missing poller script: {POLLER_SCRIPT}")
        return EXIT_NO_SCRIPT
    ps_exe = _resolve_powershell()
    if ps_exe is None:
        _log("powershell.exe not found on PATH")
        return EXIT_NO_POWERSHELL
    config = launcher_config.load_config(CONFIG_PATH)
    pulse = launcher_config.read_pulse_args(config)
    argv = _build_argv(ps_exe, pulse)
    if argv is None:
        _log(
            "no character_ids or player_name in config -- run the wizard "
            f"or edit {CONFIG_PATH}"
        )
        return EXIT_NO_IDENTITY
    proc = subprocess.Popen(
        argv,
        cwd=str(_REPO_ROOT),
        creationflags=_PROCESS_GROUP_FLAG | _NEW_CONSOLE_FLAG,
    )
    _log(
        f"launched powershell pid={proc.pid} "
        f"ids={len(pulse['character_ids'])} "
        f"regions={','.join(pulse['regions'])}"
    )
    return EXIT_OK


if __name__ == "__main__":
    sys.exit(main())
