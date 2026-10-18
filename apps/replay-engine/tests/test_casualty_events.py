"""Exact casualties stay disjoint and do not turn consumed units into kills."""

from __future__ import annotations

import importlib
import sys
from pathlib import Path
from types import SimpleNamespace

import pytest

_ROOT = Path(__file__).resolve().parents[1]
if str(_ROOT) not in sys.path:
    sys.path.insert(0, str(_ROOT))


@pytest.fixture
def extractor(monkeypatch):
    ee = importlib.import_module("core.event_extractor")
    for name in (
        "PlayerStatsEvent", "UnitBornEvent", "UnitInitEvent", "UnitDoneEvent",
        "UnitTypeChangeEvent", "UnitDiedEvent",
    ):
        monkeypatch.setattr(ee, name, type(name, (), {}))
    return ee


def event(kind, time, *, uid=1, pid=1, name=None, **attrs):
    row = kind()
    row.frame = time * 16
    row.pid = pid
    row.unit_id = uid
    if name is not None:
        row.unit_type_name = name
    for key, value in attrs.items():
        setattr(row, key, value)
    return row


def replay(events):
    return SimpleNamespace(
        tracker_events=events, events=[], players=[], frames=960,
        length=SimpleNamespace(seconds=60), game_length=SimpleNamespace(seconds=60),
    )


def test_exact_deaths_preserve_time_side_and_disjoint_categories(extractor):
    ee = extractor
    rows = [
        event(ee.UnitBornEvent, 0, name="SCV"),
        event(ee.UnitBornEvent, 0, uid=2, pid=2, name="Marine"),
        # An unfinished enemy building killed during construction counts.
        event(ee.UnitInitEvent, 5, uid=3, pid=2, name="PhotonCannon"),
        event(ee.UnitDiedEvent, 10.25, killing_player_id=2),
        event(ee.UnitDiedEvent, 11, uid=2, killing_player_id=1),
        event(ee.UnitDiedEvent, 12, uid=3, killing_player_id=1),
        # A duplicate tracker notification cannot count another casualty.
        event(ee.UnitDiedEvent, 12.5, uid=3, killing_player_id=1),
    ]
    assert ee.extract_macro_events(replay(rows), 1, 2)["casualty_events"] == [
        {"time": 10.25, "owner": "me", "killer": "opp", "category": "workers", "name": "SCV"},
        {"time": 11, "owner": "opp", "killer": "me", "category": "units", "name": "Marine"},
        {"time": 12, "owner": "opp", "killer": "me", "category": "buildings", "name": "PhotonCannon"},
    ]
    # Owner and killer labels are relative to the selected player, not pid 1.
    reversed_rows = ee.extract_macro_events(replay(rows), 2, 1)["casualty_events"]
    assert reversed_rows[0]["owner"] == "opp"
    assert reversed_rows[0]["killer"] == "me"


def test_consumption_cancels_hallucinations_and_temporary_units_are_excluded(extractor):
    ee = extractor
    rows = []
    for uid, name in enumerate([
        "Drone", "HighTemplar", "DarkTemplar", "MULE", "LocustMPFlying",
        "Broodling", "Interceptor", "Egg", "AdeptPhaseShift", "ForceField",
    ], 1):
        rows.extend([
            event(ee.UnitBornEvent, 0, uid=uid, name=name),
            event(ee.UnitDiedEvent, 5, uid=uid, killing_player_id=None),
        ])
    rows.extend([
        event(ee.UnitBornEvent, 0, uid=30, name="Phoenix", hallucinated=True),
        event(ee.UnitTypeChangeEvent, 2, uid=30, name="Phoenix"),
        event(ee.UnitDiedEvent, 5, uid=30, killing_player_id=2),
        event(ee.UnitBornEvent, 0, uid=31, name="Drone"),
        event(ee.UnitTypeChangeEvent, 2, uid=31, name="Extractor"),
        event(ee.UnitDiedEvent, 5, uid=31, killing_player_id=None),
        event(ee.UnitInitEvent, 0, uid=32, name="PhotonCannon"),
        event(ee.UnitDiedEvent, 5, uid=32, killing_player_id=1),
        event(ee.UnitBornEvent, 0, uid=33, name="CreepTumorQueen"),
        event(ee.UnitDiedEvent, 5, uid=33, killing_player_id=2),
    ])
    assert ee.extract_macro_events(replay(rows), 1, 2)["casualty_events"] == []


def test_unknown_and_self_unit_losses_never_receive_opponent_kill_credit(extractor):
    ee = extractor
    rows = [
        event(ee.UnitBornEvent, 0, name="Zergling"),
        event(ee.UnitTypeChangeEvent, 2, name="BanelingCocoon"),
        event(ee.UnitTypeChangeEvent, 3, name="Baneling"),
        event(ee.UnitDiedEvent, 5, killing_player_id=None),
        event(ee.UnitBornEvent, 0, uid=2, name="Marine"),
        event(ee.UnitDiedEvent, 6, uid=2, killing_player_id=1),
        # Combat kills of workers / Templars still count normally.
        event(ee.UnitBornEvent, 0, uid=3, name="Drone"),
        event(ee.UnitDiedEvent, 7, uid=3, killing_player_id=2),
        event(ee.UnitBornEvent, 0, uid=4, name="HighTemplar"),
        event(ee.UnitDiedEvent, 8, uid=4, killing_player_id=2),
        event(ee.UnitBornEvent, 0, uid=5, name="Drone"),
        event(ee.UnitTypeChangeEvent, 1, uid=5, name="DroneBurrowed"),
        event(ee.UnitDiedEvent, 9, uid=5, killing_player_id=2),
    ]
    deaths = ee.extract_macro_events(replay(rows), 1, 2)["casualty_events"]
    assert [(r["name"], r["killer"], r["category"]) for r in deaths] == [
        ("Baneling", None, "units"), ("Marine", None, "units"),
        ("Drone", "opp", "workers"), ("HighTemplar", "opp", "units"),
        ("Drone", "opp", "workers"),
    ]


def test_incomplete_or_unsupported_death_stream_does_not_claim_tracked_zero(extractor, monkeypatch):
    ee = extractor
    assert ee.extract_macro_events(replay([]), 1, 2)["casualty_events"] == []

    def partial_tracker():
        yield event(ee.UnitBornEvent, 0, name="Marine")
        raise ValueError("truncated tracker")

    assert "casualty_events" not in ee.extract_macro_events(replay(partial_tracker()), 1, 2)
    monkeypatch.setattr(ee, "UnitDiedEvent", None)
    assert "casualty_events" not in ee.extract_macro_events(replay([]), 1, 2)


def test_missing_opponent_does_not_turn_unattributed_structure_cancel_into_a_death(extractor):
    ee = extractor
    rows = [
        event(ee.UnitInitEvent, 0, name="PhotonCannon"),
        event(ee.UnitDiedEvent, 5, killing_player_id=None),
    ]
    assert ee.extract_macro_events(replay(rows), 1)["casualty_events"] == []


@pytest.mark.parametrize("raw_name,canonical", [
    ("LurkerDenMP", "LurkerDen"),
    ("SpineCrawlerUprooted", "SpineCrawler"),
    ("SporeCrawlerUprooted", "SporeCrawler"),
    ("BarracksFlying", "Barracks"),
    ("FactoryFlying", "Factory"),
    ("StarportFlying", "Starport"),
    ("CommandCenterFlying", "CommandCenter"),
    ("OrbitalCommandFlying", "OrbitalCommand"),
    ("SupplyDepotLowered", "SupplyDepot"),
])
def test_structure_aliases_and_stances_never_count_as_units(extractor, raw_name, canonical):
    ee = extractor
    rows = [
        event(ee.UnitInitEvent, 0, name=raw_name),
        event(ee.UnitDiedEvent, 5, killing_player_id=2),
    ]
    assert ee.extract_macro_events(replay(rows), 1, 2)["casualty_events"] == [
        {"time": 5, "owner": "me", "killer": "opp", "category": "buildings", "name": canonical},
    ]


def test_completed_structure_self_and_unknown_deaths_are_loss_only(extractor):
    ee = extractor
    rows = [
        # Spawned and completed buildings supply completion evidence.
        event(ee.UnitBornEvent, 0, name="Pylon"),
        event(ee.UnitDiedEvent, 5, killing_player_id=1),
        event(ee.UnitInitEvent, 0, uid=2, name="Nexus"),
        event(ee.UnitDoneEvent, 2, uid=2, name="Nexus"),
        event(ee.UnitDiedEvent, 6, uid=2, killing_player_id=None),
        # Uprooting and morphing an existing structure do not erase completion.
        event(ee.UnitBornEvent, 0, uid=3, name="SpineCrawler"),
        event(ee.UnitTypeChangeEvent, 2, uid=3, name="SpineCrawlerUprooted"),
        event(ee.UnitDiedEvent, 7, uid=3, killing_player_id=1),
        event(ee.UnitBornEvent, 0, uid=4, name="Hatchery"),
        event(ee.UnitTypeChangeEvent, 2, uid=4, name="Lair"),
        event(ee.UnitDiedEvent, 8, uid=4, killing_player_id=None),
        # Only initialized structures remain cancellations without an enemy kill.
        event(ee.UnitInitEvent, 0, uid=5, name="Pylon"),
        event(ee.UnitDiedEvent, 9, uid=5, killing_player_id=1),
        event(ee.UnitInitEvent, 0, uid=6, name="LurkerDenMP"),
        event(ee.UnitDiedEvent, 10, uid=6, killing_player_id=None),
    ]
    deaths = ee.extract_macro_events(replay(rows), 1, 2)["casualty_events"]
    assert [(row["name"], row["killer"], row["category"]) for row in deaths] == [
        ("Pylon", None, "buildings"), ("Nexus", None, "buildings"),
        ("SpineCrawler", None, "buildings"), ("Lair", None, "buildings"),
    ]


def test_macro_score_preserves_unavailable_versus_tracked_empty():
    from analytics.macro_score import compute_macro_score

    assert "casualty_events" not in compute_macro_score({}, "Protoss", 60)
    assert compute_macro_score({"casualty_events": []}, "Protoss", 60)["casualty_events"] == []
