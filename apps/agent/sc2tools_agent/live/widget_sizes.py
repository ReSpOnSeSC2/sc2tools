"""Shared recommended standalone Browser Source sizes; generated layouts keep their geometry."""
from __future__ import annotations

import json
from functools import lru_cache
from pathlib import Path


@lru_cache(maxsize=1)
def widget_sizes() -> dict[str, tuple[int, int]]:
    packaged = Path(__file__).with_name("widgetRecommendedSizes.json")
    source = Path(__file__).resolve().parents[3] / "web" / "lib" / "widgetRecommendedSizes.json"
    try:
        raw = json.loads((packaged if packaged.is_file() else source).read_text(encoding="utf-8"))
        return {
            key: (value["width"], value["height"])
            for key, value in raw.items()
            if isinstance(key, str) and isinstance(value, dict)
            and type(value.get("width")) is int and type(value.get("height")) is int
            and 100 <= value["width"] <= 7680 and 100 <= value["height"] <= 4320
        }
    except (OSError, ValueError, AttributeError, TypeError):
        return {}


def recommended_widget_size(widget_id: str) -> tuple[int, int]:
    return widget_sizes().get(widget_id, (1920, 1080))
