"""
Analyzer GUI launcher.

This script is the user-facing entry point for the analyzer GUI. It
performs the one-time legacy-data migration (if needed), redirects
stdout/stderr to a log file when launched via pythonw.exe (which has
no real console), and then opens the customtkinter window.

Run via:
    python -m gui.run_gui            (with console for live diagnostics)
    pythonw -m gui.run_gui           (silent; logs to data/analyzer.log)

The unified launcher (START_SC2_TOOLS.bat) calls the pythonw form so
the analyzer doesn't also pop a console window next to the watchers.
"""

from __future__ import annotations

import os
import sys


def _ensure_project_root_on_path() -> None:
    """
    Make `core/`, `gui/`, and `watchers/` importable when this script
    is run directly (not as a module). Idempotent.
    """
    here = os.path.dirname(os.path.abspath(__file__))
    project_root = os.path.dirname(here)
    if project_root not in sys.path:
        sys.path.insert(0, project_root)


def _redirect_stdio_if_windowless() -> None:
    """
    pythonw.exe attaches None to sys.stdout / sys.stderr; any print()
    call then raises AttributeError. Detect that and redirect both to
    data/analyzer.log so the diagnostic output we already emit (DB
    stats, render-card counts, exception tracebacks) is preserved.
    """
    needs_redirect = (sys.stdout is None) or (sys.stderr is None)
    if not needs_redirect:
        return
    try:
        from core.paths import DATA_DIR
        os.makedirs(DATA_DIR, exist_ok=True)
        log_path = os.path.join(DATA_DIR, "analyzer.log")
        # Line-buffered so prints flush promptly while debugging.
        f = open(log_path, "a", encoding="utf-8", buffering=1)
        sys.stdout = f
        sys.stderr = f
        print(f"\n=== Analyzer started at {os.getpid()} ===")
    except Exception:
        # If even the log redirect fails, fall back to a no-op writer
        # so any future print() doesn't crash the GUI.
        class _Null:
            def write(self, *_a, **_k): pass
            def flush(self): pass
        sys.stdout = _Null()
        sys.stderr = _Null()


def main() -> int:
    _ensure_project_root_on_path()
    _redirect_stdio_if_windowless()

    # Run the data migration before opening the GUI so the analyzer
    # always sees the most recent meta_database.json / MyOpponentHistory.json.
    try:
        from core.data_store import migrate_legacy_files
        actions = migrate_legacy_files()
        for source, action in actions.items():
            print(f"[Migration] {source}: {action}")
    except Exception as exc:
        print(f"[Migration] Skipped due to error: {exc}")

    from gui.analyzer_app import main as run_app
    return run_app()


if __name__ == "__main__":
    sys.exit(main())
