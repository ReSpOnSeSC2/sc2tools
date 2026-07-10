"""Locks structure-lifetime emission for the death-aware Buildings roster.

The SPA's macro-breakdown Buildings roster starts from the cumulative
build-order count and subtracts destroyed structures using the
``production_buildings`` / ``opp_production_buildings`` lifetime arrays
(``deriveBuildingComposition`` in compositionAt.ts). Three extractor
behaviours have to hold for that subtraction to work:

  1. ``opp_production_buildings`` is emitted at all — pre-fix the
     extractor tracked opponent building lifetimes internally (for
     structures_killed attribution) but never materialized them, so the
     opponent roster showed cumulative counts forever ("43 Spine
     Crawlers" after most were killed).

  2. Structures destroyed while STILL UNDER CONSTRUCTION get a death
     record too. They never fire UnitDoneEvent, so they join neither
     lifetimes dict — but the build log records their UnitInitEvent, so
     without a death record a cannon or spine sniped mid-warp counts
     alive forever.

  3. Every record carries an explicit ``destroyed`` result. Survivors
     still use the game-end second as ``died_time`` for compatibility,
     but the flag prevents a complete wipe's last death from looking
     like that legacy sentinel.

These tests run without sc2reader or a real replay by stubbing the
tracker event classes, matching test_extract_macro_events_army_value.py.

Module: tests
"""
from __future__ import annotations

import os
import sys
from types import SimpleNamespace
from typing import Any, List
from unittest.mock import MagicMock

# Match the existing extractor-test mocking pattern so this module
# imports without sc2reader installed (CI containers without the wheel).
sys.modules.setdefault("sc2reader", MagicMock())
sys.modules.setdefault("sc2reader.events", MagicMock())
sys.modules.setdefault("sc2reader.events.tracker", MagicMock())
sys.modules.setdefault("sc2reader.events.game", MagicMock())

_HERE = os.path.dirname(os.path.abspath(__file__))
_ROOT = os.path.dirname(_HERE)
if _ROOT not in sys.path:
    sys.path.insert(0, _ROOT)

GAME_END = 600


def _import_extractor():
    """Import event_extractor with sc2reader's tracker classes stubbed."""
    import importlib

    class _PlayerStatsEvent:
        pass

    class _UnitBornEvent:
        pass

    class _UnitInitEvent:
        pass

    class _UnitDoneEvent:
        pass

    class _UnitTypeChangeEvent:
        pass

    class _UnitDiedEvent:
        pass

    class _UpgradeCompleteEvent:
        pass

    class _CommandEvent:
        pass

    tracker_mod = SimpleNamespace(
        PlayerStatsEvent=_PlayerStatsEvent,
        UnitBornEvent=_UnitBornEvent,
        UnitInitEvent=_UnitInitEvent,
        UnitDoneEvent=_UnitDoneEvent,
        UnitTypeChangeEvent=_UnitTypeChangeEvent,
        UnitDiedEvent=_UnitDiedEvent,
        UpgradeCompleteEvent=_UpgradeCompleteEvent,
    )
    game_mod = SimpleNamespace(
        CommandEvent=_CommandEvent,
        TargetPointCommandEvent=None,
        SelectionEvent=None,
    )
    sys.modules["sc2reader"] = MagicMock()
    sys.modules["sc2reader.events"] = MagicMock()
    sys.modules["sc2reader.events.tracker"] = tracker_mod
    sys.modules["sc2reader.events.game"] = game_mod

    sys.modules.pop("core.event_extractor", None)
    return importlib.import_module("core.event_extractor"), SimpleNamespace(
        UnitBornEvent=_UnitBornEvent,
        UnitInitEvent=_UnitInitEvent,
        UnitDoneEvent=_UnitDoneEvent,
        UnitDiedEvent=_UnitDiedEvent,
    )


def _unit_event(klass: type, second: int, *, pid: int, name: str,
                uid: int) -> Any:
    """Mock a UnitBorn/Init/Done tracker event.

    ``frame`` is set alongside ``second`` (at 16 fps, matching the
    replay stub's frames/length ratio) so ``event_seconds`` resolves
    to ``second`` exactly.
    """
    obj = klass()
    obj.second = second
    obj.frame = second * 16
    obj.control_pid = pid
    obj.unit_type_name = name
    obj.unit_id = uid
    obj.unit = None
    obj.x = 0
    obj.y = 0
    return obj


def _died_event(klass: type, second: int, *, uid: int,
                killer_pid: int | None = None) -> Any:
    obj = klass()
    obj.second = second
    obj.frame = second * 16
    obj.unit_id = uid
    obj.unit = None
    obj.killing_player_id = killer_pid
    return obj


def _make_replay(events: List[Any]) -> SimpleNamespace:
    """sc2reader-shaped Replay stub at a genuine 16 fps timebase."""
    return SimpleNamespace(
        tracker_events=events,
        events=[],
        build=92440,
        frames=GAME_END * 16,
        length=SimpleNamespace(seconds=GAME_END),
        game_length=SimpleNamespace(seconds=GAME_END),
        players=[],
    )


def _by_name(records: List[dict], name: str) -> List[dict]:
    return [r for r in records if r.get("name") == name]


def test_opp_production_buildings_emitted_with_death_times():
    """Opponent structure lifetimes materialize onto the output.

    Pre-fix the extractor only exported my-side ``production_buildings``;
    the opponent's lifetimes stayed internal, so the SPA's opponent
    Buildings roster could never subtract killed spines / spores /
    cannons.
    """
    ee, E = _import_extractor()
    events = [
        # Opp spine crawler: completes at 125, killed at 300.
        _unit_event(E.UnitInitEvent, 100, pid=2, name="SpineCrawler", uid=30),
        _unit_event(E.UnitDoneEvent, 125, pid=2, name="SpineCrawler", uid=30),
        _died_event(E.UnitDiedEvent, 300, uid=30, killer_pid=1),
        # Opp spine crawler that survives to game end.
        _unit_event(E.UnitInitEvent, 110, pid=2, name="SpineCrawler", uid=31),
        _unit_event(E.UnitDoneEvent, 135, pid=2, name="SpineCrawler", uid=31),
        # Opp hatchery (UnitBornEvent IS completion for base types).
        _unit_event(E.UnitBornEvent, 0, pid=2, name="Hatchery", uid=50),
    ]
    out = ee.extract_macro_events(_make_replay(events), my_pid=1, opp_pid=2)

    spines = _by_name(out["opp_production_buildings"], "SpineCrawler")
    assert len(spines) == 2, (
        "both opponent spine crawlers must appear in "
        "opp_production_buildings — without them the SPA roster falls "
        "back to cumulative build-order counts"
    )
    died_times = sorted(s["died_time"] for s in spines)
    assert died_times == [300, GAME_END], (
        "killed spine carries its real death second; the survivor is "
        "stamped with the game-end sentinel"
    )
    spines_by_death = {s["died_time"]: s for s in spines}
    assert spines_by_death[300]["destroyed"] is True
    assert spines_by_death[GAME_END]["destroyed"] is False
    # The hatchery lands in both the mirror array and opp_bases.
    hatches = _by_name(out["opp_production_buildings"], "Hatchery")
    assert len(hatches) == 1
    assert hatches[0]["destroyed"] is False
    assert len(_by_name(out["opp_bases"], "Hatchery")) == 1
    # Kill attribution keeps working alongside the new export.
    assert out["player_stats"]["1"]["structures_killed"] == 1
    assert out["player_stats"]["2"]["structures_lost"] == 1


def test_in_progress_structure_death_recorded_both_sides():
    """A structure killed before UnitDoneEvent still yields a record.

    The build log counts births off UnitInitEvent, so a cannon or spine
    sniped mid-construction must produce a death record or it counts
    alive forever. It must NOT join bases (a never-finished town hall
    can't be injected / chrono'd).
    """
    ee, E = _import_extractor()
    events = [
        # My cannon killed while warping in.
        _unit_event(E.UnitInitEvent, 200, pid=1, name="PhotonCannon", uid=40),
        _died_event(E.UnitDiedEvent, 220, uid=40, killer_pid=2),
        # My gateway that completes and survives.
        _unit_event(E.UnitInitEvent, 150, pid=1, name="Gateway", uid=41),
        _unit_event(E.UnitDoneEvent, 215, pid=1, name="Gateway", uid=41),
        # Opp spine killed while morphing (drone morph in progress).
        _unit_event(E.UnitInitEvent, 240, pid=2, name="SpineCrawler", uid=42),
        _died_event(E.UnitDiedEvent, 250, uid=42, killer_pid=1),
        # Opp hatchery started but destroyed before finishing — must
        # show in opp_production_buildings but stay OUT of opp_bases.
        _unit_event(E.UnitInitEvent, 300, pid=2, name="Hatchery", uid=43),
        _died_event(E.UnitDiedEvent, 330, uid=43, killer_pid=1),
    ]
    out = ee.extract_macro_events(_make_replay(events), my_pid=1, opp_pid=2)

    cannons = _by_name(out["production_buildings"], "PhotonCannon")
    assert len(cannons) == 1
    assert cannons[0]["born_time"] == 200
    assert cannons[0]["died_time"] == 220
    assert cannons[0]["destroyed"] is True

    gateways = _by_name(out["production_buildings"], "Gateway")
    assert len(gateways) == 1
    assert gateways[0]["died_time"] == GAME_END  # survivor sentinel
    assert gateways[0]["destroyed"] is False

    spines = _by_name(out["opp_production_buildings"], "SpineCrawler")
    assert len(spines) == 1
    assert spines[0]["died_time"] == 250
    assert spines[0]["destroyed"] is True

    hatches = _by_name(out["opp_production_buildings"], "Hatchery")
    assert len(hatches) == 1
    assert hatches[0]["died_time"] == 330
    assert hatches[0]["destroyed"] is True
    assert _by_name(out["opp_bases"], "Hatchery") == [], (
        "an in-progress hatchery death must not widen the opponent "
        "base list — it never finished, so it was never injectable"
    )
    # In-progress deaths don't touch the completed-structure counters.
    assert out["player_stats"]["1"]["structures_lost"] == 0
    assert out["player_stats"]["2"]["structures_lost"] == 0


def test_no_opp_pid_leaves_opp_arrays_empty():
    """1-player extraction (no opp_pid) keeps the mirrors empty."""
    ee, E = _import_extractor()
    events = [
        _unit_event(E.UnitInitEvent, 100, pid=1, name="Forge", uid=60),
        _unit_event(E.UnitDoneEvent, 132, pid=1, name="Forge", uid=60),
    ]
    out = ee.extract_macro_events(_make_replay(events), my_pid=1)
    assert out["opp_production_buildings"] == []
    assert out["opp_bases"] == []
    forges = _by_name(out["production_buildings"], "Forge")
    assert len(forges) == 1
    assert forges[0]["destroyed"] is False
