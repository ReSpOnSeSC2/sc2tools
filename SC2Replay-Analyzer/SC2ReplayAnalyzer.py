"""DEPRECATED -- old standalone launcher, retired in favor of START_SC2_TOOLS.bat.

This file used to spawn its own backend / watcher / poller stack and
open the SPA in a browser. The merged toolkit's launcher
(``C:\\SC2TOOLS\\START_SC2_TOOLS.bat`` or the equivalent inside
``reveal-sc2-opponent-main/``) is the only supported entry point now.
Running this file directly would collide with the new launcher
(duplicate ``npm start`` on :3000, duplicate watcher, duplicate poller,
extra browser tab) which is the symptom that motivated retiring it.

Left as a stub instead of being deleted so any lingering shortcut,
Start-menu pin, or muscle-memory double-click surfaces a clear message
instead of silently double-launching everything. To restore the old
behavior, ``git log -p`` this file and revert.
"""
from __future__ import annotations

import sys

_MSG = (
    "This launcher (SC2ReplayAnalyzer.py) has been retired.\n\n"
    "Use START_SC2_TOOLS.bat in C:\\SC2TOOLS instead.\n\n"
    "If a shortcut brought you here, please update or delete it so this\n"
    "message stops appearing."
)


def _show_message() -> None:
    """Show a Tk message box if Tk is available, else print + pause."""
    try:
        import tkinter as tk
        from tkinter import messagebox
        root = tk.Tk()
        root.withdraw()
        messagebox.showinfo("SC2 Tools -- launcher retired", _MSG)
        root.destroy()
        return
    except Exception:
        pass
    # Fallback for headless / pythonw-without-Tk environments.
    print(_MSG)
    try:
        input("\nPress Enter to close...")
    except Exception:
        pass


if __name__ == "__main__":
    _show_message()
    sys.exit(0)
