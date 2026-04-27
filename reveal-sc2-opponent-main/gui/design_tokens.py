"""
Unified design tokens for SC2 Tools — Python edition.

Mirrors ``SC2-Overlay/design-tokens.css`` and
``SC2-Overlay/design-tokens.json`` so the Tkinter / customtkinter / PyQt
desktop surfaces share the same color, typography, spacing, and radius
language as the React SPA analyzer and the OBS overlay widgets.

Usage
-----
    from gui.design_tokens import COLORS, FONT_FAMILIES, FONT_SIZES, SPACING, RADII

    sidebar.configure(fg_color=COLORS.BG_SURFACE)
    title_lbl.configure(text_color=COLORS.TEXT_PRIMARY,
                        font=(FONT_FAMILIES.UI, FONT_SIZES.XL, "bold"))

Rules
-----
* Use :class:`COLORS` constants instead of hard-coded hex strings. CI greps
  ``gui/`` for raw '#' literals in color contexts.
* Race accents (``RACE_TERRAN`` etc.) are for race chips and badges only —
  never for win/loss state. Semantic state always wins (a Zerg loss is red,
  not purple).
* Mono font family is reserved for stats and timing values (MMR deltas,
  build-order timestamps, win/loss counts). Body copy uses the UI family.
* All public dataclasses are :data:`frozen=True` so accidental mutation
  raises :exc:`dataclasses.FrozenInstanceError`.

Example
-------
    >>> COLORS.RACE_ZERG
    '#A855F7'
    >>> FONT_SIZES.LG
    18
    >>> SPACING.S4
    16
"""

from __future__ import annotations

from dataclasses import dataclass


# ---------------------------------------------------------------------------
# COLORS
# ---------------------------------------------------------------------------
@dataclass(frozen=True)
class _Colors:
    """Frozen color palette. Hex strings; alpha values use ``rgba(...)`` form."""

    # Surfaces ----------------------------------------------------------------
    BG_PRIMARY:    str = "#0A0E1A"
    BG_SURFACE:    str = "#111827"
    BG_ELEVATED:   str = "#1F2937"

    # Race accents ------------------------------------------------------------
    RACE_TERRAN:   str = "#3B82F6"
    RACE_ZERG:     str = "#A855F7"
    RACE_PROTOSS:  str = "#F59E0B"
    RACE_RANDOM:   str = "#94A3B8"

    # Semantic state ----------------------------------------------------------
    SUCCESS:       str = "#10B981"
    DANGER:        str = "#EF4444"
    WARNING:       str = "#F59E0B"
    INFO:          str = "#3B82F6"

    # Text --------------------------------------------------------------------
    TEXT_PRIMARY:    str = "#F1F5F9"
    TEXT_SECONDARY:  str = "#94A3B8"
    TEXT_MUTED:      str = "#64748B"
    TEXT_ON_ACCENT:  str = "#0A0E1A"

    # Borders -----------------------------------------------------------------
    # Tkinter doesn't render rgba() borders natively, so the desktop GUI
    # exposes a solid-fallback hex alongside the alpha rule used elsewhere.
    BORDER_SUBTLE:    str = "#1B2030"   # solid-equivalent of rgba 5%
    BORDER_DEFAULT:   str = "#262C3B"   # solid-equivalent of rgba 10%
    BORDER_STRONG:    str = "#3A4154"   # solid-equivalent of rgba 20%
    DIVIDER:          str = "#1F2434"

    # Overlay-legacy palette (decorative; matches OBS widget aesthetic) -------
    OVERLAY_BG_FROM:        str = "#11141C"
    OVERLAY_BG_TO:          str = "#1A1E29"
    OVERLAY_BORDER:         str = "#2A3143"
    OVERLAY_TEXT:           str = "#FFFFFF"
    OVERLAY_TEXT_DIM:       str = "#7B869E"
    OVERLAY_TEXT_MEDIUM:    str = "#C5CDE0"
    OVERLAY_TEXT_MATCHUP:   str = "#A0AABF"

    OVERLAY_ACCENT_GOLD:    str = "#E5C100"
    OVERLAY_ACCENT_CYAN:    str = "#00CCFF"
    OVERLAY_ACCENT_PURPLE:  str = "#A06BFF"
    OVERLAY_ACCENT_RED:     str = "#FF3366"
    OVERLAY_ACCENT_RIVAL:   str = "#FFCC33"

    OVERLAY_VICTORY:        str = "#00FF88"
    OVERLAY_DEFEAT:         str = "#FF3366"


@dataclass(frozen=True)
class _FontFamilies:
    """Font family stacks. Tk only honors the FIRST entry that resolves on the
    machine, so we keep a comma-separated string here for code that converts
    to CSS, plus a single-name variant Tk can use directly."""

    UI:        str = "Inter"
    UI_STACK:  str = (
        "Inter, system-ui, -apple-system, 'Segoe UI', Roboto, "
        "Helvetica, Arial, sans-serif"
    )
    MONO:        str = "JetBrains Mono"
    MONO_STACK:  str = (
        "'JetBrains Mono', 'SF Mono', 'Cascadia Code', Consolas, "
        "'Liberation Mono', monospace"
    )

    # Tk-friendly fallback when Inter isn't installed. Used by analyzer_app.py
    # so the GUI degrades gracefully on a plain Windows install.
    UI_FALLBACK:    str = "Segoe UI"
    MONO_FALLBACK:  str = "Consolas"


@dataclass(frozen=True)
class _FontSizes:
    """Type scale in pixels. Tk wants integers for the size argument."""

    XS:    int = 11
    SM:    int = 13
    BASE:  int = 15
    LG:    int = 18
    XL:    int = 22
    XXL:   int = 28   # exposed as 2XL in CSS / JSON
    XXXL:  int = 36   # exposed as 3XL in CSS / JSON


@dataclass(frozen=True)
class _FontWeights:
    REGULAR:   int = 400
    MEDIUM:    int = 500
    SEMIBOLD:  int = 600
    BOLD:      int = 700
    EXTRA:     int = 800
    BLACK:     int = 900


@dataclass(frozen=True)
class _LineHeights:
    TIGHT:    float = 1.2
    NORMAL:   float = 1.5
    RELAXED:  float = 1.75


@dataclass(frozen=True)
class _Spacing:
    """4px-base spacing scale. Pick the closest step — do not invent in-betweens."""

    S0:   int = 0
    S1:   int = 4
    S2:   int = 8
    S3:   int = 12
    S4:   int = 16
    S6:   int = 24
    S8:   int = 32
    S12:  int = 48
    S16:  int = 64
    S24:  int = 96


@dataclass(frozen=True)
class _Radii:
    SM:    int = 4
    MD:    int = 8
    LG:    int = 12
    XL:    int = 16
    FULL:  int = 9999


@dataclass(frozen=True)
class _Motion:
    """Tk has no ms-based animator, but these constants stay in sync with CSS
    so timed animations driven by ``after()`` use the same numbers."""

    DURATION_STATE_MS:      int = 200
    DURATION_ENTRANCE_MS:   int = 400
    DURATION_CELEBRATE_MS:  int = 600


# ---------------------------------------------------------------------------
# Public singletons
# ---------------------------------------------------------------------------
COLORS:        _Colors        = _Colors()
FONT_FAMILIES: _FontFamilies  = _FontFamilies()
FONT_SIZES:    _FontSizes     = _FontSizes()
FONT_WEIGHTS:  _FontWeights   = _FontWeights()
LINE_HEIGHTS:  _LineHeights   = _LineHeights()
SPACING:       _Spacing       = _Spacing()
RADII:         _Radii         = _Radii()
MOTION:        _Motion        = _Motion()


__all__ = [
    "COLORS",
    "FONT_FAMILIES",
    "FONT_SIZES",
    "FONT_WEIGHTS",
    "LINE_HEIGHTS",
    "SPACING",
    "RADII",
    "MOTION",
]
