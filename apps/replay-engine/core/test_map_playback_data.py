"""Smoke tests for core.map_playback_data.

Run with::

    python -m core._test_map_playback_data
"""

from __future__ import annotations

import sys
import os

_HERE = os.path.dirname(os.path.abspath(__file__))
_ROOT = os.path.dirname(_HERE)
if _ROOT not in sys.path:
    sys.path.insert(0, _ROOT)


def _assert(cond, msg: str) -> None:
    if not cond:
        raise AssertionError(msg)


def test_centroid_window_zero() -> None:
    from core.map_playback_data import centroid

    events = [
        {"time": 10.0, "x": 10, "y": 10},
        {"time": 20.0, "x": 20, "y": 20},
        {"time": 30.0, "x": 30, "y": 30},
    ]

    # window=0 should only match the exact time
    res1 = centroid(events, 20.0, window=0.0)
    _assert(res1 == (20.0, 20.0), f"Expected (20.0, 20.0) but got {res1}")

    # window=0 with no exact match should return None
    res2 = centroid(events, 25.0, window=0.0)
    _assert(res2 is None, f"Expected None but got {res2}")

    print("test_centroid_window_zero OK")


def main() -> int:
    test_centroid_window_zero()
    print("\nAll map_playback_data tests passed.")
    return 0


if __name__ == "__main__":
    sys.exit(main())
