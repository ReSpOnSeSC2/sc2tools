"""Locks the per-sample ``army_value`` field on PlayerStatsEvent extracts.

The Active Army & Workers chart in the cloud SPA binds its army line to
``stats_events[i].army_value`` (and ``opp_stats_events[i].army_value``)
from agent v0.5.11+. This is sc2reader's authoritative number — the
same one the in-game Army graph and sc2replaystats's Army Value chart
read — and using it directly removes the entire fragile
``unit_timeline → buildOrderUnitsAt + derived deaths → food*50``
fallback cascade that produced the 9 200-late-game vertical spike on
the Jagannatha LE PvZ replay.

If this test ever goes red, the SPA chart will silently regress to the
old derived-cascade math and the spike comes back. It runs without a
real replay file by mocking sc2reader's tracker_events to fire a
canned ``PlayerStatsEvent`` sequence.

Module: tests
"""
from __future__ import annotations

import os
import sys
from types import SimpleNamespace
from typing import Any, Dict, List
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


def _make_stats_event(
    klass: type,
    second: int,
    *,
    pid: int,
    minerals_used_active_forces: int = 0,
    vespene_used_active_forces: int = 0,
    food_used: int = 0,
    food_workers: int = 12,
    legacy: bool = False,
    legacy_minerals: int = 0,
    legacy_vespene: int = 0,
) -> Any:
    """Mock a sc2reader PlayerStatsEvent.

    Real sc2reader objects expose ``second``, ``pid``, the ``food_*``
    counters, and the army-tracking fields. Anything missing here will
    surface as a getattr default in ``extract_macro_events`` — which
    is itself part of the contract we're locking down. We instantiate
    a subclass of ``klass`` (the stub PlayerStatsEvent) so the
    extractor's ``isinstance(event, PlayerStatsEvent)`` check accepts
    the test object — SimpleNamespace can't be re-classed in CPython
    3.10+ so the subclass route is the one that survives.
    """
    obj = klass()
    obj.second = second
    obj.pid = pid
    obj.food_used = food_used
    obj.food_made = food_used + 4
    obj.food_workers = food_workers
    obj.workers_active_count = food_workers
    obj.minerals_current = 50
    obj.vespene_current = 0
    obj.minerals_collection_rate = 600
    obj.vespene_collection_rate = 0
    obj.minerals_used_in_progress = 0
    obj.vespene_used_in_progress = 0
    if legacy:
        # Older sc2reader builds expose ``*_used_current_army`` instead
        # of ``*_used_active_forces``. Skip setting the modern names so
        # ``getattr`` falls through to the legacy ones.
        obj.minerals_used_current_army = legacy_minerals
        obj.vespene_used_current_army = legacy_vespene
    else:
        obj.minerals_used_active_forces = minerals_used_active_forces
        obj.vespene_used_active_forces = vespene_used_active_forces
    return obj


def _make_replay(stats: List[Any]) -> SimpleNamespace:
    """Wrap a stats-event sequence in a sc2reader-shaped Replay stub."""
    return SimpleNamespace(
        tracker_events=stats,
        events=[],
        build=92440,
        game_length=SimpleNamespace(seconds=stats[-1].second if stats else 0),
        players=[],
    )


def _import_extractor():
    """Import event_extractor with sc2reader's PlayerStatsEvent stubbed.

    The extractor uses ``isinstance(event, PlayerStatsEvent)`` to gate
    its sample-collection branch, so the stub has to register a real
    class on the mocked tracker module BEFORE the import executes.
    Re-importing under a fresh sys.modules state is the simplest way
    to guarantee that ordering across pytest's collection.
    """
    import importlib

    class _PlayerStatsEvent:  # noqa: D401 — sc2reader name parity
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

    # Drop any cached extractor so the new sc2reader stubs take effect.
    sys.modules.pop("core.event_extractor", None)
    return importlib.import_module("core.event_extractor"), _PlayerStatsEvent


def test_army_value_field_present_per_sample():
    """Every emitted PlayerStatsEvent gains a numeric ``army_value`` key.

    The chart binds ``stats_events[i].army_value`` directly so a
    missing key forces the SPA back into the derived-cascade fallback
    that produced the 9 200 spike. This test pins the contract.
    """
    ee, PSE = _import_extractor()
    stats = [
        _make_stats_event(PSE, 0, pid=1,
                          minerals_used_active_forces=0,
                          vespene_used_active_forces=0,
                          food_used=12, food_workers=12),
        _make_stats_event(PSE, 60, pid=1,
                          minerals_used_active_forces=300,
                          vespene_used_active_forces=125,
                          food_used=22, food_workers=18),
        _make_stats_event(PSE, 990, pid=1,
                          minerals_used_active_forces=900,
                          vespene_used_active_forces=575,
                          food_used=180, food_workers=49),
    ]
    out = ee.extract_macro_events(_make_replay(stats), my_pid=1, opp_pid=2)
    samples = out["stats_events"]
    assert len(samples) == 3
    for s in samples:
        assert "army_value" in s, (
            "Active Army chart binds to stats_events[i].army_value — "
            "missing key forces the SPA back into the derived "
            "fallback that produced the late-game 9 200 spike."
        )
    # Specifically, the values come from minerals_used_active_forces
    # + vespene_used_active_forces, NOT from any food-supply derivation.
    assert samples[0]["army_value"] == 0
    assert samples[1]["army_value"] == 425  # 300 + 125
    assert samples[2]["army_value"] == 1475  # 900 + 575


def test_army_value_uses_legacy_field_names_when_active_forces_absent():
    """Older sc2reader builds expose ``*_used_current_army`` instead.

    The agent runs against multiple sc2reader versions in the wild
    (frozen exes from the 2022-era v0.4.x stream still upload). We
    fall back to ``minerals_used_current_army`` /
    ``vespene_used_current_army`` so the SPA's army line keeps
    rendering sc2reader's authoritative number across the entire
    install base.
    """
    ee, PSE = _import_extractor()
    legacy_event = _make_stats_event(
        PSE, 60, pid=1,
        food_used=22, food_workers=18,
        legacy=True,
        legacy_minerals=275,
        legacy_vespene=100,
    )
    out = ee.extract_macro_events(_make_replay([legacy_event]), my_pid=1)
    assert out["stats_events"][0]["army_value"] == 375


def test_army_value_emitted_on_opp_stats_events_too():
    """Both sides need the field — chart renders both armies."""
    ee, PSE = _import_extractor()
    me_sample = _make_stats_event(
        PSE, 60, pid=1,
        minerals_used_active_forces=300,
        vespene_used_active_forces=0,
        food_used=22, food_workers=18,
    )
    opp_sample = _make_stats_event(
        PSE, 60, pid=2,
        minerals_used_active_forces=600,
        vespene_used_active_forces=200,
        food_used=22, food_workers=17,
    )
    out = ee.extract_macro_events(
        _make_replay([me_sample, opp_sample]), my_pid=1, opp_pid=2,
    )
    assert out["stats_events"][0]["army_value"] == 300
    assert out["opp_stats_events"][0]["army_value"] == 800
