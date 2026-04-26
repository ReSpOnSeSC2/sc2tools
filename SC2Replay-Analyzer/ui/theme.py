"""Shared color palette, font tuples, and the win-rate color helper.

Centralized here so the App, the visualizer, and any future UI surfaces use
the same look without copy/pasting hex codes.
"""

# Graph (matplotlib) colors
GRAPH_BG = "#2B2B2B"
GRAPH_FG = "#FFFFFF"
COLOR_P1 = "#42A5F5"
COLOR_P2 = "#EF5350"
COLOR_P1_DIM = "#1E88E5"
COLOR_P2_DIM = "#E53935"

# Win/loss accents
COLOR_WIN = "#66BB6A"
COLOR_LOSS = "#EF5350"
COLOR_NEUTRAL = "#90A4AE"

# Font tuples reused throughout the UI
FONT_TITLE = ("Arial", 20, "bold")
FONT_HEADING = ("Arial", 14, "bold")
FONT_BODY = ("Arial", 12)
FONT_SMALL = ("Arial", 10)


def wr_color(wins: int, total: int) -> str:
    """Return the accent color for a (wins, total) tuple."""
    if total == 0:
        return COLOR_NEUTRAL
    return COLOR_WIN if (wins / total) >= 0.5 else COLOR_LOSS
