"""Native folder-picker helper for the analyzer SPA.

Opens a Tk ``askdirectory`` dialog on the user's screen and prints the
chosen path as a one-line JSON record on stdout. The Express layer
spawns this and surfaces the result to the SPA's "Browse..." button.

Why a native dialog and not a browser one?
    Browsers sandbox absolute paths from ``<input type="file"
    webkitdirectory>`` -- ``webkitRelativePath`` returns just
    ``Multiplayer/foo.SC2Replay`` style fragments, not the absolute
    Windows path the server-side parser needs. Since the analyzer is
    a localhost desktop app, popping a real Tk dialog on the user's
    actual screen gives them the familiar Explorer dialog AND returns
    the absolute path.

CLI::

    python scripts/folder_picker_cli.py [--initial-dir PATH] [--title TEXT]

Output::

    {"ok": true,  "path": "C:/Users/.../Replays"}        # picked
    {"ok": true,  "cancelled": true}                      # user dismissed
    {"ok": false, "error": "tkinter unavailable: ..."}    # missing GUI

Exit codes: 0 on success (including cancel), 2 on Tk init failure.
"""
from __future__ import annotations

import argparse
import json
import os
import sys
from typing import Optional


def _emit(obj: dict) -> None:
    sys.stdout.write(json.dumps(obj, default=str) + "\n")
    sys.stdout.flush()


def _pick_directory(initial_dir: str, title: str) -> Optional[str]:
    """Open a Tk directory dialog. Returns chosen path or None on cancel."""
    # Lazy-import so a headless environment still loads the module.
    import tkinter as tk
    from tkinter import filedialog

    root = tk.Tk()
    root.withdraw()
    # On Windows the dialog can sometimes hide behind the main window
    # without this. lift + topmost flicker forces it to the front.
    try:
        root.lift()
        root.attributes("-topmost", True)
    except Exception:
        pass
    initial = initial_dir if initial_dir and os.path.isdir(initial_dir) else None
    chosen = filedialog.askdirectory(
        title=title or "Select folder",
        initialdir=initial,
        mustexist=True,
    )
    try:
        root.destroy()
    except Exception:
        pass
    if not chosen:
        return None
    # Tk returns forward slashes on Windows; normalize to OS sep so
    # downstream `os.path.isdir` checks behave predictably.
    return os.path.normpath(chosen)


def main(argv: Optional[list] = None) -> int:
    parser = argparse.ArgumentParser(
        prog="folder_picker_cli",
        description="Open a native folder-picker dialog.",
    )
    parser.add_argument("--initial-dir", default="",
                        help="Directory to open in. Falls back to home if "
                             "the path doesn't exist.")
    parser.add_argument("--title", default="Select folder")
    args = parser.parse_args(argv)
    try:
        path = _pick_directory(args.initial_dir, args.title)
    except Exception as exc:
        _emit({"ok": False, "error": f"folder picker failed: {exc}"})
        return 2
    if path is None:
        _emit({"ok": True, "cancelled": True})
        return 0
    _emit({"ok": True, "path": path})
    return 0


if __name__ == "__main__":
    sys.exit(main())
