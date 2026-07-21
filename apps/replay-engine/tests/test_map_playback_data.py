import sys
import os
import importlib.util
from unittest.mock import MagicMock

# Shim sc2reader ONLY when the real package can't be imported.
# Unconditional MagicMock entries clobbered the real package
# (``sc2reader.events`` stopped being a package), so
# ``core.event_extractor`` failed to import whenever this file ran
# before the rest of the suite. Conversely, when another test module
# (tests/db/test_migrations.py) already parked a MagicMock in
# ``sys.modules``, keep shimming the submodules so the import chain
# stays consistent — ``find_spec`` would raise on the mock entry.
def _sc2reader_is_real() -> bool:
    mod = sys.modules.get("sc2reader")
    if mod is not None:
        return not isinstance(mod, MagicMock)
    try:
        return importlib.util.find_spec("sc2reader") is not None
    except (ImportError, ValueError):
        return False

if not _sc2reader_is_real():
    sys.modules['sc2reader'] = MagicMock()
    sys.modules['sc2reader.events'] = MagicMock()
    sys.modules['sc2reader.events.tracker'] = MagicMock()

_HERE = os.path.dirname(os.path.abspath(__file__))
_ROOT = os.path.dirname(_HERE)
if _ROOT not in sys.path:
    sys.path.insert(0, _ROOT)

import pytest
import core.map_playback_data as mpd
from core.map_playback_data import bounds_for, DEFAULT_BOUNDS

def test_bounds_for_empty_map_name():
    """Test bounds_for when map_name is None and events is empty."""
    bounds = bounds_for(None, [])

    # Assert it returns a fallback bounds dictionary
    assert bounds["x_min"] == float(DEFAULT_BOUNDS.get("x_min", 0))
    assert bounds["x_max"] == float(DEFAULT_BOUNDS.get("x_max", 200))
    assert bounds["y_min"] == float(DEFAULT_BOUNDS.get("y_min", 0))
    assert bounds["y_max"] == float(DEFAULT_BOUNDS.get("y_max", 200))
    assert bounds["starting_locations"] == DEFAULT_BOUNDS.get("starting_locations", [])


class _FakeStatsEvent:
    """Raw sc2reader-shaped PlayerStatsEvent: the worker count lives on
    ``workers_active_count`` (``food_workers`` is only this project's
    downstream JSON alias and does NOT exist on the raw event)."""

    def __init__(self, pid, second, workers):
        self.pid = pid
        self.second = second
        self.workers_active_count = workers
        self.minerals_used_active_forces = 400
        self.vespene_used_active_forces = 100
        self.minerals_current = 50
        self.vespene_current = 25
        self.food_used = 30
        self.food_made = 38
        self.minerals_lost_army = 100
        self.vespene_lost_army = 25
        self.minerals_killed_army = 200
        self.vespene_killed_army = 50


class _FakePlayer:
    def __init__(self, pid, name):
        self.pid = pid
        self.name = name
        self.is_observer = False
        self.is_referee = False
        self.result = "Win"


def test_build_playback_data_reads_workers_active_count(monkeypatch):
    """Worker counts must come from the raw event's
    ``workers_active_count`` — reading ``food_workers`` (absent on raw
    events) pinned the map-replay worker HUD to 0."""
    me, opp = _FakePlayer(1, "Me"), _FakePlayer(2, "Opp")
    replay = MagicMock()
    replay.players = [me, opp]
    replay.tracker_events = [
        _FakeStatsEvent(1, 10, 14),
        _FakeStatsEvent(2, 10, 17),
    ]
    replay.map_name = "TestMap"

    monkeypatch.setattr(mpd, "load_replay_with_fallback", lambda p: replay)
    monkeypatch.setattr(mpd, "PlayerStatsEvent", _FakeStatsEvent)
    monkeypatch.setattr(mpd, "extract_events", lambda r, pid: ([], [], None))
    monkeypatch.setattr(
        mpd, "extract_unit_tracks",
        lambda r, pid: {"my_units": [], "opp_units": []},
    )
    monkeypatch.setattr(mpd, "extract_building_lifecycle", lambda r: {})
    monkeypatch.setattr(mpd, "extract_resource_nodes", lambda r: [])
    monkeypatch.setattr(mpd, "event_seconds", lambda e, r: float(e.second))
    monkeypatch.setattr(mpd, "real_game_length", lambda r: 600.0)

    data = mpd.build_playback_data("fake.SC2Replay", "Me")

    assert data is not None
    assert [s["workers"] for s in data["my_stats"]] == [14]
    assert [s["workers"] for s in data["opp_stats"]] == [17]
    # The killed/lost resource totals ride along for efficiency views.
    assert data["my_stats"][0]["lost"] == 125
    assert data["my_stats"][0]["killed"] == 250
