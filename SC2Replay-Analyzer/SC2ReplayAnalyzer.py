"""SC2 Meta Analyzer - thin entry point.

The application has been split into a package:

    core/       - replay loading, event extraction, error logging, paths
    analytics/  - shared per-replay feature layer (feature_extractor.py)
    detectors/  - strategy/build classifiers and the build catalog
    db/         - persistence and schema migrations
    ui/         - App, GameVisualizerWindow, theme constants

This module just bootstraps the app: ensures `custom_builds.json` exists,
launches the Tk main loop, and surfaces any otherwise-unhandled startup
exception in a messagebox.
"""

import multiprocessing
import sys
import traceback
import tkinter as tk


def _run():
    # Lazy imports keep startup-time tracebacks readable when a dependency is
    # missing (the offending import surfaces in the messagebox below).
    from detectors.definitions import initialize_custom_builds
    initialize_custom_builds()

    from ui.app import App
    app = App()
    app.mainloop()


if __name__ == "__main__":
    # Required so PyInstaller-frozen builds can still spawn worker processes
    # for the replay parsing pool. No-op when running from source on macOS/Linux.
    multiprocessing.freeze_support()

    try:
        _run()
    except Exception as e:
        import tkinter.messagebox
        root = tk.Tk()
        root.withdraw()
        error_msg = f"Critical Error:\n{e}\n\n{traceback.format_exc()}"
        tkinter.messagebox.showerror("App Crashed", error_msg)
        sys.exit(1)
