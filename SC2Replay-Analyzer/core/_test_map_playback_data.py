import sys
import os

# Add the SC2Replay-Analyzer directory to sys.path
sys.path.insert(0, os.path.abspath(os.path.join(os.path.dirname(__file__), '..')))

# Mock sc2reader completely before any imports
from unittest.mock import MagicMock
mock_sc2reader = MagicMock()
sys.modules['sc2reader'] = mock_sc2reader
sys.modules['sc2reader.events'] = MagicMock()
sys.modules['sc2reader.events.tracker'] = MagicMock()
sys.modules['sc2reader.engine'] = MagicMock()
sys.modules['sc2reader.engine.plugins'] = MagicMock()

from core.map_playback_data import centroid

def _assert(cond, msg: str) -> None:
    if not cond:
        raise AssertionError(msg)

def test_centroid_empty_events():
    _assert(centroid([], 10.0) is None, "centroid([]) should be None")
    print("test_centroid_empty_events OK")

def test_centroid_time_filtering():
    events = [
        {"time": 5.0, "x": 10, "y": 10},   # Ignored (too early, t - window = 10 - 4 = 6)
        {"time": 6.5, "x": 20, "y": 20},   # Included
        {"time": 8.0, "x": 30, "y": 30},   # Included
        {"time": 10.5, "x": 40, "y": 40},  # Ignored (too late, > t)
    ]

    result = centroid(events, t=10.0, window=4.0)
    _assert(result is not None, "result should not be None")
    x, y = result
    _assert(x == 25.0 and y == 25.0, f"Expected (25.0, 25.0), got ({x}, {y})")
    print("test_centroid_time_filtering OK")

def test_centroid_missing_coords():
    events = [
        {"time": 8.0, "x": 10},             # Missing y
        {"time": 9.0, "y": 20},             # Missing x
        {"time": 9.5, "x": 10, "y": 20},    # Valid
        {"time": 10.0},                     # Missing both
    ]

    result = centroid(events, t=10.0, window=10.0)
    _assert(result is not None, "result should not be None")
    x, y = result
    _assert(x == 10.0 and y == 20.0, f"Expected (10.0, 20.0), got ({x}, {y})")
    print("test_centroid_missing_coords OK")

def test_centroid_exact_bounds():
    events = [
        {"time": 5.0, "x": 10, "y": 10},   # Exact lower bound (ignored, > is required implicitly by "falls in (t - window, t]")
        {"time": 10.0, "x": 30, "y": 30},  # Exact upper bound (included, <= t implicitly)
    ]
    # The docstring says: "falls in (t - window, t]"
    # Code:
    # if et > t: break
    # if et < lo: continue
    # This means et == lo is included, so it's [t - window, t]. Let's test that behavior.

    result = centroid(events, t=10.0, window=5.0)
    _assert(result is not None, "result should not be None")
    x, y = result
    _assert(x == 20.0 and y == 20.0, f"Expected (20.0, 20.0), got ({x}, {y})")
    print("test_centroid_exact_bounds OK")

def test_centroid_correct_calculation():
    events = [
        {"time": 8.0, "x": 10, "y": 50},
        {"time": 9.0, "x": 20, "y": 60},
        {"time": 10.0, "x": 30, "y": 70},
    ]

    result = centroid(events, t=10.0, window=5.0)
    _assert(result is not None, "result should not be None")
    x, y = result
    _assert(x == 20.0 and y == 60.0, f"Expected (20.0, 60.0), got ({x}, {y})")
    print("test_centroid_correct_calculation OK")

def main() -> int:
    try:
        test_centroid_empty_events()
        test_centroid_time_filtering()
        test_centroid_missing_coords()
        test_centroid_exact_bounds()
        test_centroid_correct_calculation()
        print("\nAll map_playback_data smoke tests passed.")
        return 0
    except AssertionError as e:
        print(f"FAIL: {e}")
        return 1
    except Exception as e:
        print(f"ERROR: {e}")
        return 1

if __name__ == "__main__":
    sys.exit(main())
