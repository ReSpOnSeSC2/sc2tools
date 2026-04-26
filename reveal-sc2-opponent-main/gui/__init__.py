"""
SC2 Tools - Analyzer GUI package.

Public surface:
    analyzer_app  -- App + ReplayAnalyzer + GameVisualizerWindow

run_gui is intentionally not re-exported here: it is the launcher
entry point invoked via `python -m gui.run_gui`. Importing it from
this __init__ would force runpy to re-execute an already-loaded
module and trigger a RuntimeWarning.
"""

from . import analyzer_app

__all__ = ["analyzer_app"]
