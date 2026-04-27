"""UI layer (deprecated).

Stage 3 retired the customtkinter desktop GUI in favor of the React SPA
served by ``stream-overlay-backend``. The legacy modules
(``app.py``, ``visualizer.py``, ``map_intel.py``, ``map_viewer.py``,
``theme.py``, ``_tooltip.py``) have been renamed to ``*.deprecated`` and
are kept only as a reference until Stage 7. Nothing in the shipping code
path imports from this package any longer; new UI work belongs in
``reveal-sc2-opponent-main/stream-overlay-backend/public/analyzer/``.

This stub exists so ``import ui`` keeps working for any tooling that
walks the source tree, while making the deprecation explicit.
"""
