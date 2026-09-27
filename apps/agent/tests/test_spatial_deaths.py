"""Regression tests for the Map Intel death-zone extract (``spatial.deaths``).

Until agent 0.17.2 the list was always empty: the extractor looked for
``my_lost`` / ``opp_lost`` on battle markers, but ``detect_battle_markers``
only returns ``{time, x, y, side}``. Losses are now measured from the
playback stats' cumulative army-value ``lost`` counter and placed where
the user's army actually died.
"""

from __future__ import annotations

import bisect
import sys
from pathlib import Path
from types import SimpleNamespace

import pytest

HERE = Path(__file__).resolve().parents[1]
if str(HERE) not in sys.path:
    sys.path.insert(0, str(HERE))

FIXTURE_REPLAY = (
    HERE.parent
    / "replay-engine"
    / "tests"
    / "fixtures"
    / "replays"
    / "warpgate_adept_tracking.SC2Replay"
)


def _interp(stats, t, key):
    """Same contract as core.map_playback_data.interp (linear, clamped)."""
    times = [s["time"] for s in stats]
    if t <= times[0]:
        return float(stats[0][key])
    if t >= times[-1]:
        return float(stats[-1][key])
    i = bisect.bisect_left(times, t)
    a, b = stats[i - 1], stats[i]
    frac = (t - a["time"]) / (b["time"] - a["time"])
    return float(a[key]) + frac * (float(b[key]) - float(a[key]))


PLAYBACK_MOD = SimpleNamespace(interp=_interp)


def _stats(points):
    return [{"time": float(t), "lost": lost} for t, lost in points]


def _unit(died, x, y, *, worker=False):
    return {"died": died, "is_worker": worker, "waypoints": [died - 5, 0.0, 0.0, died, x, y]}


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------


def test_loss_windows_are_clipped_between_neighbouring_battles():
    from sc2tools_agent.replay_pipeline import _battle_loss_windows

    windows = _battle_loss_windows([{"time": 100.0}, {"time": 112.0}, {"time": 300.0}])
    assert windows == [(90.0, 106.0), (106.0, 122.0), (290.0, 310.0)]


def test_loss_windows_skip_battles_without_time():
    from sc2tools_agent.replay_pipeline import _battle_loss_windows

    assert _battle_loss_windows([{"x": 1}, {"time": 50.0}]) == [None, (40.0, 60.0)]


def test_death_position_accepts_flat_and_row_waypoints():
    from sc2tools_agent.replay_pipeline import _unit_death_position

    assert _unit_death_position({"died": 5.0, "waypoints": [1.0, 2.0, 3.0, 5.0, 8.0, 9.0]}) == (8.0, 9.0)
    assert _unit_death_position({"died": 5.0, "waypoints": [(1.0, 2.0, 3.0), (5.0, 8.0, 9.0)]}) == (8.0, 9.0)


def test_death_position_requires_an_observation_at_death():
    from sc2tools_agent.replay_pipeline import _unit_death_position

    # Last observation 3 s before death (e.g. a morph "death"): unknown place.
    assert _unit_death_position({"died": 5.0, "waypoints": [2.0, 8.0, 9.0]}) is None
    assert _unit_death_position({"died": None, "waypoints": [5.0, 8.0, 9.0]}) is None
    assert _unit_death_position({"died": 5.0, "waypoints": []}) is None


def test_death_centroid_ignores_workers_and_deaths_outside_window():
    from sc2tools_agent.replay_pipeline import _army_death_centroid

    units = [
        _unit(100.0, 10.0, 20.0),
        _unit(104.0, 30.0, 40.0),
        _unit(101.0, 90.0, 90.0, worker=True),
        _unit(200.0, 70.0, 70.0),
        {"died": None, "is_worker": False, "waypoints": [100.0, 5.0, 5.0]},
    ]
    assert _army_death_centroid(units, 95.0, 105.0) == (20.0, 30.0)
    assert _army_death_centroid(units, 0.0, 50.0) is None


def test_army_value_lost_needs_the_cumulative_counter():
    from sc2tools_agent.replay_pipeline import _army_value_lost

    assert _army_value_lost(_stats([(0, 0), (20, 400)]), 0.0, 20.0, _interp) == 400.0
    assert _army_value_lost([{"time": 0.0, "army_val": 5}], 0.0, 20.0, _interp) is None
    assert _army_value_lost([], 0.0, 20.0, _interp) is None


# ---------------------------------------------------------------------------
# _death_zone_sample
# ---------------------------------------------------------------------------


def _playback(my_lost_after, opp_lost_after, my_units=()):
    return {
        "my_stats": _stats([(90, 0), (100, 0), (110, my_lost_after)]),
        "opp_stats": _stats([(90, 0), (100, 0), (110, opp_lost_after)]),
        "my_units": list(my_units),
    }


def test_lost_fight_becomes_a_weighted_point_where_the_army_died():
    from sc2tools_agent.replay_pipeline import _death_zone_sample

    battle = {"time": 100.0, "x": 50.0, "y": 50.0}
    playback = _playback(900, 300, [_unit(104.0, 12.0, 34.0)])
    sample = _death_zone_sample(battle, (90.0, 110.0), playback, PLAYBACK_MOD)
    assert sample == {"x": 12.0, "y": 34.0, "weight": 600.0, "time": 100.0}


def test_lost_fight_without_observed_deaths_falls_back_to_marker():
    from sc2tools_agent.replay_pipeline import _death_zone_sample

    battle = {"time": 100.0, "x": 50.0, "y": 60.0}
    sample = _death_zone_sample(battle, (90.0, 110.0), _playback(500, 100), PLAYBACK_MOD)
    assert (sample["x"], sample["y"], sample["weight"]) == (50.0, 60.0, 400.0)


@pytest.mark.parametrize("mine, theirs", [(100, 900), (400, 400), (0, 0)])
def test_won_or_even_fights_are_not_death_zones(mine, theirs):
    from sc2tools_agent.replay_pipeline import _death_zone_sample

    battle = {"time": 100.0, "x": 50.0, "y": 50.0}
    assert _death_zone_sample(battle, (90.0, 110.0), _playback(mine, theirs), PLAYBACK_MOD) is None


def test_missing_window_or_interp_yields_no_sample():
    from sc2tools_agent.replay_pipeline import _death_zone_sample

    battle = {"time": 100.0, "x": 50.0, "y": 50.0}
    assert _death_zone_sample(battle, None, _playback(900, 0), PLAYBACK_MOD) is None
    assert _death_zone_sample(battle, (90.0, 110.0), _playback(900, 0), SimpleNamespace()) is None


# ---------------------------------------------------------------------------
# Real replay: each lost fight is a death zone for exactly one player
# ---------------------------------------------------------------------------


@pytest.fixture(autouse=True)
def _no_pulse_network(monkeypatch):
    class _StubModule:
        @staticmethod
        def resolve_pulse_id_by_toon(handle, name):
            raise AssertionError("pulse lookup must be disabled in these tests")

    monkeypatch.setitem(sys.modules, "core.pulse_resolver", _StubModule)


def test_real_replay_fills_death_zones_for_the_side_that_lost_each_fight():
    pytest.importorskip("sc2reader")
    if not FIXTURE_REPLAY.is_file():
        pytest.skip("fixture replay not available")
    from sc2tools_agent.replay_pipeline import _compute_spatial_extract, probe_analyzer

    ok, diag = probe_analyzer()
    if not ok:
        pytest.skip(f"replay engine unavailable: {diag}")
    from core.sc2_replay_parser import parse_deep  # type: ignore

    by_player = {}
    for name in ("ReSpOnSe", "Squirtuoz"):
        spatial = _compute_spatial_extract(parse_deep(str(FIXTURE_REPLAY), name))
        assert spatial is not None
        by_player[name] = spatial

    battle_times = {b["time"] for b in by_player["ReSpOnSe"]["battles"]}
    death_times = [d["time"] for s in by_player.values() for d in s.get("deaths", [])]
    assert death_times, "a real game with lost fights must produce death zones"
    # Every death zone is one of the game's battles, claimed by one side only.
    assert set(death_times) <= battle_times
    assert len(death_times) == len(set(death_times))
    bounds = by_player["ReSpOnSe"]["map_bounds"]
    for spatial in by_player.values():
        for d in spatial.get("deaths", []):
            assert d["weight"] > 0
            assert bounds["minX"] <= d["x"] <= bounds["maxX"]
            assert bounds["minY"] <= d["y"] <= bounds["maxY"]
