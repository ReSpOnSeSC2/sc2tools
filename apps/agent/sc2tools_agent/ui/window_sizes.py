"""Logical-pixel Companion window presets and screen-safe placement."""
from __future__ import annotations


WINDOW_SIZE_PRESETS = (
    ("Compact", "compact", (340, 78)),
    ("Standard", "standard", (520, 480)),
    ("Detailed", "detailed", (1024, 800)),
    ("Full workspace", "full", None),
)
INFORMATION_LAYOUTS = frozenset(preset[1] for preset in WINDOW_SIZE_PRESETS)


def normalize_information_layout(value: object) -> str:
    return value if isinstance(value, str) and value in INFORMATION_LAYOUTS else "standard"


def minimum_window_size(layout: str) -> tuple[int, int]:
    return (280, 68) if layout == "compact" else (480, 360)


def fit_window_preset(
    name: str,
    available: tuple[int, int, int, int],
    *,
    position: tuple[int, int] = (0, 0),
    frame: tuple[int, int] = (0, 0),
    minimum: tuple[int, int] | None = None,
) -> tuple[int, int, int, int]:
    requested = next((size for title, _layout, size in WINDOW_SIZE_PRESETS if title == name), None)
    if requested is None:
        raise ValueError("Unknown normal-window preset")
    minimum = minimum or minimum_window_size(next(level for title, level, _size in WINDOW_SIZE_PRESETS if title == name))
    origin_x, origin_y, available_width, available_height = available
    frame_width, frame_height = (max(0, dimension) for dimension in frame)
    maximum_width = max(1, available_width - frame_width)
    maximum_height = max(1, available_height - frame_height)
    width = min(max(requested[0], minimum[0]), maximum_width)
    height = min(max(requested[1], minimum[1]), maximum_height)
    left = min(max(position[0], origin_x), origin_x + max(0, available_width - width - frame_width))
    top = min(max(position[1], origin_y), origin_y + max(0, available_height - height - frame_height))
    return left, top, width, height


def window_size_label(
    size: tuple[int, int],
    *,
    available: tuple[int, int, int, int],
    layout: str,
    maximized: bool = False,
    frame: tuple[int, int] = (0, 0),
    minimum: tuple[int, int] | None = None,
) -> str:
    if maximized:
        return "Full workspace" if layout == "full" else "Custom"
    for title, density, requested in WINDOW_SIZE_PRESETS:
        if density == layout and requested is not None:
            fitted = fit_window_preset(title, available, frame=frame, minimum=minimum)
            if size == fitted[2:]:
                return title
    return "Custom"
