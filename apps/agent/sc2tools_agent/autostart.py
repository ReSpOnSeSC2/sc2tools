"""Cross-platform helpers for "Run on login".

On Windows we toggle a per-user entry under
``HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Run``. The NSIS
installer also drops a Startup-folder shortcut, so this module is the
*post-install* path: the GUI's Settings tab calls these helpers when
the user toggles the checkbox after installation.

On macOS / Linux we don't try to manage launchd / systemd-user units
from the GUI - the dependencies are too varied. The functions return
``False`` (not enabled) and the GUI hides the checkbox instead.

All functions are idempotent. ``set_enabled(True)`` on top of an
already-enabled key is a no-op; ``set_enabled(False)`` when the key
doesn't exist is a silent success.

The helpers never raise on the happy path - every winreg call is
wrapped because a missing-permission error would otherwise crash the
agent inside the GUI thread. They return booleans and log warnings
instead so the UI can show "Couldn't toggle autostart" without a
full traceback.
"""

from __future__ import annotations

import logging
import os
import sys
from pathlib import Path
from typing import Optional

log = logging.getLogger(__name__)

# Subkey used by Windows to enumerate "run on logon" entries for the
# current user. We deliberately use HKCU (not HKLM) so the agent never
# triggers UAC during install or settings changes.
_WIN_RUN_KEY = r"Software\Microsoft\Windows\CurrentVersion\Run"

# Value name we own under HKCU\...\Run. Keep it stable - the uninstaller
# (and a future migration) need to find it.
_WIN_VALUE_NAME = "SC2ToolsAgent"


def _platform_is_windows() -> bool:
    """Indirection so unit tests can simulate Windows on a Linux runner
    without monkey-patching ``os.name`` (which breaks pathlib)."""
    return os.name == "nt"


def is_supported() -> bool:
    """Whether this OS exposes a one-call "run on login" toggle.

    Currently True only on Windows. The GUI hides the autostart
    checkbox when this returns False.
    """
    return _platform_is_windows()


def get_executable_path() -> Optional[Path]:
    """Best-guess path to invoke when the user logs in.

    * In a PyInstaller-frozen build, ``sys.executable`` IS the agent
      .exe - that's exactly what we want.
    * In a source install we use ``pythonw.exe -m sc2tools_agent`` so
      the user gets the windowed interpreter (no flashing console).
    * Returns ``None`` when we can't form a sensible command - the
      caller must treat that as "autostart not toggleable".
    """
    if getattr(sys, "frozen", False):
        return Path(sys.executable)

    # pythonw.exe sits next to python.exe in CPython installs. Prefer
    # it on Windows so the agent doesn't flash a console window at
    # logon. Fall back to the running interpreter when pythonw is
    # missing (Linux, slim Windows installs).
    exe = Path(sys.executable)
    if _platform_is_windows():
        candidate = exe.parent / "pythonw.exe"
        if candidate.exists():
            return candidate
    return exe


def is_enabled() -> bool:
    """Return True iff our Run-key entry exists.

    Treats winreg errors (key missing, ACL denial) as "not enabled".
    """
    if not is_supported():
        return False
    try:
        import winreg  # type: ignore[import-not-found]
    except ImportError:
        return False
    try:
        with winreg.OpenKey(winreg.HKEY_CURRENT_USER, _WIN_RUN_KEY) as key:
            value, _ = winreg.QueryValueEx(key, _WIN_VALUE_NAME)
            return bool(value)
    except FileNotFoundError:
        return False
    except OSError:
        # Permission denied or registry hive corrupt - treat as off.
        log.debug("autostart_probe_failed", exc_info=True)
        return False


def set_enabled(enabled: bool) -> bool:
    """Add or remove the Run-key entry.

    Returns True on success, False on any expected failure (unsupported
    OS, registry permission denied, no executable resolvable). The
    caller is expected to surface a friendly error in the UI.
    """
    if not is_supported():
        return False
    try:
        import winreg  # type: ignore[import-not-found]
    except ImportError:
        return False

    if enabled:
        exe = get_executable_path()
        if exe is None or not Path(exe).exists():
            log.warning("autostart_no_executable_to_register")
            return False
        command = _build_command(exe)
        try:
            with winreg.CreateKey(winreg.HKEY_CURRENT_USER, _WIN_RUN_KEY) as key:
                winreg.SetValueEx(
                    key, _WIN_VALUE_NAME, 0, winreg.REG_SZ, command,
                )
            log.info("autostart_enabled command=%s", command)
            return True
        except OSError:
            log.exception("autostart_enable_failed")
            return False

    # Disable: delete the value if it's there. The Run subkey itself
    # might not exist on a clean profile - that's a soft-success, since
    # the goal state ("our value is not present") is already satisfied.
    # FileNotFoundError on the value delete is the same situation.
    try:
        with winreg.OpenKey(
            winreg.HKEY_CURRENT_USER, _WIN_RUN_KEY, 0, winreg.KEY_SET_VALUE,
        ) as key:
            try:
                winreg.DeleteValue(key, _WIN_VALUE_NAME)
            except FileNotFoundError:
                pass
        log.info("autostart_disabled")
        return True
    except FileNotFoundError:
        # The Run subkey doesn't exist - nothing to remove.
        log.debug("autostart_disable_no_subkey")
        return True
    except OSError:
        log.exception("autostart_disable_failed")
        return False


def _build_command(exe: Path) -> str:
    """Compose the winreg-friendly command string.

    Windows reads the value verbatim and passes it to ``CreateProcess``,
    which already handles quoting paths with spaces. We add the
    ``--start-minimized`` flag so the agent boots straight to the tray
    on logon - the GUI Settings checkbox controls this, but the
    autostart entry should always start hidden so the user isn't
    interrupted at login.
    """
    if getattr(sys, "frozen", False):
        return f'"{exe}" --start-minimized'
    # Source / dev install path: invoke the module via the windowed
    # interpreter so no console window flashes at logon.
    return f'"{exe}" -m sc2tools_agent --start-minimized'


__all__ = [
    "is_supported",
    "is_enabled",
    "set_enabled",
    "get_executable_path",
    "_platform_is_windows",
]
