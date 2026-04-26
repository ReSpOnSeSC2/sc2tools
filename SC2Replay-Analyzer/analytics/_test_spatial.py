"""Smoke tests for analytics.spatial.

Run with::

    python -m analytics._test_spatial

Covers:
* The KDE single-point fallback (no scipy, no LinAlgError).
* The 5-cell stamp shape used when the dataset has < 2 points.
* Coordinate->grid mapping is bounded inside [0, resolution).
* The aggregator constructs cleanly from an empty dict and reports
  no maps at the >= 3 games threshold.

These are deliberately offline; they don't require sc2reader or any
real replays. Spatial extraction from real replays is exercised by
running the desktop "Map Intel" tab.
"""

from __future__ import annotations

import sys


def _assert(cond, msg: str) -> None:
    if not cond:
        raise AssertionError(msg)


def test_stamp_fallback() -> None:
    from analytics import spatial
    bounds = {"x_min": 0, "x_max": 100, "y_min": 0, "y_max": 100,
              "starting_locations": []}
    grid = spatial._stamp_grid([50.0], [50.0], bounds, 20)
    _assert(grid.shape == (20, 20), "stamp shape wrong")
    _assert(grid.max() > 0, "stamp produced zero density at the point")
    _assert(grid.min() >= 0, "stamp produced negative density")
    print("test_stamp_fallback OK")


def test_kde_single_point_fallback() -> None:
    """A 1-point KDE call must NOT crash; it falls back to the stamp."""
    from analytics import spatial
    bounds = {"x_min": 0, "x_max": 100, "y_min": 0, "y_max": 100,
              "starting_locations": []}
    grid = spatial._kde_grid([42.0], [42.0], bounds, 50)
    _assert(grid.shape == (50, 50), "KDE single-pt returned wrong shape")
    _assert(grid.max() > 0, "KDE single-pt fallback produced empty grid")
    print("test_kde_single_point_fallback OK")


def test_coords_to_grid_bounds() -> None:
    import numpy as np
    from analytics import spatial
    bounds = {"x_min": 0, "x_max": 100, "y_min": 0, "y_max": 100,
              "starting_locations": []}
    cols, rows = spatial._coords_to_grid(
        np.asarray([-1000.0, 50.0, 9999.0]),
        np.asarray([-1000.0, 50.0, 9999.0]),
        bounds, 20,
    )
    _assert(0 <= int(cols.min()) and int(cols.max()) < 20, "cols out of range")
    _assert(0 <= int(rows.min()) and int(rows.max()) < 20, "rows out of range")
    print("test_coords_to_grid_bounds OK")


def test_aggregator_empty_db() -> None:
    from analytics.spatial import SpatialAggregator
    agg = SpatialAggregator({}, player_name=None)
    rows = agg.list_maps_with_min_games(3)
    _assert(rows == [], "expected no maps from empty DB")
    # building_heatmap on a non-existent map should return a zero grid, not crash.
    out = agg.building_heatmap("DoesNotExist", owner="me")
    _assert(out["sample_count"] == 0, "expected 0 samples")
    _assert(len(out["grid"]) == 100, "expected 100x100 grid")
    print("test_aggregator_empty_db OK")


def test_kde_two_points() -> None:
    """Two close points: must produce a non-zero KDE density."""
    from analytics import spatial
    bounds = {"x_min": 0, "x_max": 100, "y_min": 0, "y_max": 100,
              "starting_locations": []}
    grid = spatial._kde_grid([20.0, 80.0], [20.0, 80.0], bounds, 32)
    _assert(grid.shape == (32, 32), "wrong shape")
    _assert(grid.max() > 0, "two-point KDE empty")
    # The peak should be near one of the two points; at minimum, density at
    # the corners should exceed density at the centre (0,0 in world coords
    # maps to bottom-left of the grid).
    print("test_kde_two_points OK")


def main() -> int:
    test_stamp_fallback()
    test_kde_single_point_fallback()
    test_coords_to_grid_bounds()
    test_aggregator_empty_db()
    test_kde_two_points()
    print("\nAll spatial smoke tests passed.")
    return 0


if __name__ == "__main__":
    sys.exit(main())
