"""
SC2 Tools - Analyzer GUI package.

Public surface:
    analyzer_app   -- App + ReplayAnalyzer + GameVisualizerWindow (Tk required)
    design_tokens  -- Frozen design-system primitives (no Tk dependency)

``analyzer_app`` is loaded lazily via :func:`__getattr__` so that
``from gui.design_tokens import COLORS`` succeeds in environments
without Tkinter (CI containers, headless servers, mypy --strict
runs). Touching ``gui.analyzer_app`` for the first time triggers
the heavier import.

run_gui is intentionally not re-exported here: it is the launcher
entry point invoked via ``python -m gui.run_gui``. Importing it from
this __init__ would force runpy to re-execute an already-loaded
module and trigger a RuntimeWarning.
"""

from typing import Any

__all__ = ["analyzer_app", "design_tokens"]


def __getattr__(name: str) -> Any:
    """Lazy-import submodules so token-only consumers don't pay the Tk cost."""
    if name == "analyzer_app":
        from . import analyzer_app as _module
        return _module
    if name == "design_tokens":
        from . import design_tokens as _module
        return _module
    raise AttributeError(f"module 'gui' has no attribute {name!r}")
