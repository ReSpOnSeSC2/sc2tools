"""Perspective routing for versioned custom-build disk definitions.

The desktop agent and bulk importer both consume ``custom_builds.json``
through ``core.custom_builds.load_custom_builds``. These regressions ensure
an opponent definition cannot be evaluated as the user's build, including in
mirror matchups where a race check alone cannot protect the wrong axis.
"""

from __future__ import annotations

import json
import os
import sys
from types import SimpleNamespace
from typing import Any, Dict, List


_HERE = os.path.dirname(os.path.abspath(__file__))
_ROOT = os.path.dirname(_HERE)
if _ROOT not in sys.path:
    sys.path.insert(0, _ROOT)

from core import custom_builds  # noqa: E402
from core import event_extractor  # noqa: E402
from core.strategy_detector_base import PROXY_ELIGIBLE_BUILDINGS  # noqa: E402
from core.strategy_detector_opponent import OpponentStrategyDetector  # noqa: E402
from core.strategy_detector_user import UserBuildDetector  # noqa: E402


def _build(
    build_id: str,
    name: str,
    perspective: str | None,
    rules: List[Dict[str, Any]],
) -> Dict[str, Any]:
    entry: Dict[str, Any] = {
        "id": build_id,
        "name": name,
        "race": "Terran",
        "vs_race": "Terran",
        "rules": rules,
        "created_at": "2026-08-24T00:00:00Z",
        "updated_at": "2026-08-24T00:00:00Z",
        "sync_state": "synced",
    }
    if perspective is not None:
        entry["perspective"] = perspective
    return entry


def _building(
    name: str,
    time: int,
    x: float = 10.0,
    y: float = 10.0,
) -> Dict[str, Any]:
    return {
        "type": "building",
        "name": name,
        "time": time,
        "x": x,
        "y": y,
    }


def test_v3_disk_cache_routes_each_perspective_to_only_its_detector(
    tmp_path, monkeypatch,
):
    own = _build(
        "my-factory",
        "My Factory",
        "you",
        [{"type": "before", "name": "BuildFactory", "time_lt": 180}],
    )
    opponent = _build(
        "their-three-rax",
        "Their 3 Rax",
        "opponent",
        [{
            "type": "count_min",
            "name": "BuildBarracks",
            "count": 3,
            "time_lt": 180,
        }],
    )
    legacy_default = _build(
        "legacy-own-build",
        "Legacy own build",
        None,
        [{"type": "before", "name": "BuildStarport", "time_lt": 240}],
    )
    invalid = _build(
        "invalid-side",
        "Invalid side",
        "spectator",
        [{"type": "before", "name": "BuildGhostAcademy", "time_lt": 240}],
    )
    cache_path = tmp_path / "custom_builds.json"
    cache_path.write_text(
        json.dumps({
            "version": custom_builds.SCHEMA_VERSION,
            "builds": [own, opponent, legacy_default, invalid],
        }),
        encoding="utf-8",
    )
    monkeypatch.setattr(custom_builds, "CUSTOM_BUILDS_FILE", str(cache_path))

    buckets = custom_builds.load_custom_builds()

    assert [build["id"] for build in buckets["Self"]] == [
        "my-factory",
        "legacy-own-build",
    ]
    assert [build["id"] for build in buckets["Opponent"]] == [
        "their-three-rax",
    ]

    my_events = [_building("CommandCenter", 0), _building("Factory", 120)]
    opponent_events = [
        _building("CommandCenter", 0),
        _building("Barracks", 70),
        _building("Barracks", 105),
        _building("Barracks", 140),
    ]
    my_detector = UserBuildDetector(buckets["Self"])
    opponent_detector = OpponentStrategyDetector(buckets["Opponent"])

    assert my_detector.detect_my_build(
        "vs Terran", my_events, "Terran",
    ) == "My Factory"
    assert opponent_detector.get_strategy_name(
        "Terran",
        opponent_events,
        "vs Terran",
        my_race="Terran",
    ) == "Their 3 Rax"


def test_opponent_v3_matchup_is_checked_against_the_users_race():
    build = _build(
        "their-three-rax",
        "Their 3 Rax",
        "opponent",
        [{
            "type": "count_min",
            "name": "BuildBarracks",
            "count": 3,
            "time_lt": 180,
        }],
    )
    build["vs_race"] = "Protoss"
    events = [
        _building("CommandCenter", 0),
        _building("Barracks", 70),
        _building("Barracks", 105),
        _building("Barracks", 140),
    ]
    detector = OpponentStrategyDetector([build])

    assert detector.get_strategy_name(
        "Terran", events, "vs Terran", my_race="Protoss",
    ) == "Their 3 Rax"
    assert detector.get_strategy_name(
        "Terran", events, "vs Terran", my_race="Zerg",
    ) != "Their 3 Rax"


def test_v3_proxy_modifier_uses_strict_canonical_owner_main_distance():
    proxy_build = _build(
        "proxy-rax",
        "My Proxy Rax",
        "you",
        [{
            "type": "before",
            "name": "BuildBarracks",
            "time_lt": 180,
            "proxy": True,
        }],
    )
    detector = UserBuildDetector([proxy_build])
    main = _building("CommandCenter", 0, 10.0, 10.0)

    # At home and exactly 50 units away do not satisfy `_is_proxy`.
    assert detector.detect_my_build(
        "vs Terran", [main, _building("Barracks", 70, 40.0, 10.0)], "Terran",
    ) != "My Proxy Rax"
    assert detector.detect_my_build(
        "vs Terran", [main, _building("Barracks", 70, 60.0, 10.0)], "Terran",
    ) != "My Proxy Rax"

    # Any distance strictly greater than 50 does satisfy it.
    assert detector.detect_my_build(
        "vs Terran", [main, _building("Barracks", 70, 60.01, 10.0)], "Terran",
    ) == "My Proxy Rax"

    # Omitting the additive modifier preserves every existing v3 rule.
    ordinary = _build(
        "ordinary-rax",
        "My Ordinary Rax",
        "you",
        [{"type": "before", "name": "BuildBarracks", "time_lt": 180}],
    )
    assert UserBuildDetector([ordinary]).detect_my_build(
        "vs Terran", [main, _building("Barracks", 70, 40.0, 10.0)], "Terran",
    ) == "My Ordinary Rax"

    invalid = _build(
        "invalid-proxy-unit",
        "Invalid Proxy Unit",
        "you",
        [{
            "type": "not_before",
            "name": "BuildMarine",
            "time_lt": 180,
            "proxy": True,
        }],
    )
    assert UserBuildDetector([invalid]).detect_my_build(
        "vs Terran", [main], "Terran",
    ) != "Invalid Proxy Unit"

    # Missing geometry is unknown. It must not make negative/count-zero rules
    # pass merely because `_is_proxy` historically defaulted coordinates to 0.
    for malformed_index, malformed in enumerate((
        {"type": "building", "name": "Barracks", "time": 70},
        {
            "type": "building", "name": "Barracks", "time": 70,
            "x": 0.0, "y": 10.0,
        },
    )):
        for rule_index, rule in enumerate((
            {
                "type": "before", "name": "BuildBarracks",
                "time_lt": 180, "proxy": True,
            },
            {
                "type": "not_before", "name": "BuildBarracks",
                "time_lt": 180, "proxy": True,
            },
            {
                "type": "count_max", "name": "BuildBarracks",
                "time_lt": 180, "count": 0, "proxy": True,
            },
        )):
            bad_geometry = _build(
                f"missing-proxy-geometry-{malformed_index}-{rule_index}",
                f"Missing Proxy Geometry {malformed_index}-{rule_index}",
                "you",
                [rule],
            )
            assert UserBuildDetector([bad_geometry]).detect_my_build(
                "vs Terran", [main, malformed], "Terran",
            ) != bad_geometry["name"]


def test_proxy_structure_contract_matches_schema_and_emitted_events():
    schema_path = os.path.join(_ROOT, "data", "custom_builds.schema.json")
    with open(schema_path, "r", encoding="utf-8") as handle:
        schema = json.load(handle)
    schema_names = {
        token[len("Build"):]
        for token in schema["definitions"]["proxyStructureName"]["enum"]
    }
    assert schema_names == set(PROXY_ELIGIBLE_BUILDINGS)
    assert "NydusNetwork" in schema_names
    for absent in (
        "Marine", "NydusWorm", "SupplyDepot", "ShieldBattery",
        "CreepTumor", "BarracksFlying", "WarpGate", "Lair",
    ):
        assert absent not in schema_names

    detector = UserBuildDetector([])
    main = _building("CommandCenter", 0, 10.0, 10.0)
    assert detector.check_custom_rules(
        [{
            "type": "before", "name": "BuildNydusNetwork",
            "time_lt": 180, "proxy": True,
        }],
        [main, _building("NydusNetwork", 90, 61.0, 10.0)],
        [], [], (10.0, 10.0),
    )
    for token in ("BuildNydusWorm", "BuildSupplyDepot", "BuildBarracksFlying"):
        assert not detector.check_custom_rules(
            [{
                "type": "before", "name": token,
                "time_lt": 180, "proxy": True,
            }],
            [main], [], [], (10.0, 10.0),
        )


def test_extract_events_reports_proxy_specific_completeness(monkeypatch):
    class FakeInit:
        def __init__(self, name, pid, x=10.0, y=10.0):
            self.unit_type_name = name
            self.pid = pid
            self.x = x
            self.y = y
            self.frame = 0

    class FakeBorn(FakeInit):
        pass

    class BrokenTracker:
        def __iter__(self):
            yield FakeInit("CommandCenter", 1)
            raise RuntimeError("truncated tracker stream")

    monkeypatch.setattr(event_extractor, "UnitInitEvent", FakeInit)
    monkeypatch.setattr(event_extractor, "UnitBornEvent", FakeBorn)
    replay = SimpleNamespace(
        tracker_events=BrokenTracker(),
        events=[],
        frames=22.4,
        length=SimpleNamespace(seconds=1),
    )
    mine, _theirs, broken_stats = event_extractor.extract_events(replay, 1)
    assert [row["name"] for row in mine] == ["CommandCenter"]
    assert broken_stats["errors"] == 1
    assert broken_stats["proxy_errors"] == 1

    ownerless_building = SimpleNamespace(
        tracker_events=[FakeInit("Barracks", None)],
        events=[],
        frames=22.4,
        length=SimpleNamespace(seconds=1),
    )
    _, _, building_stats = event_extractor.extract_events(ownerless_building, 1)
    assert building_stats["pid_failed"] == 1
    assert building_stats["proxy_errors"] == 1

    neutral = SimpleNamespace(
        tracker_events=[FakeBorn("MineralField", None)],
        events=[],
        frames=22.4,
        length=SimpleNamespace(seconds=1),
    )
    _, _, neutral_stats = event_extractor.extract_events(neutral, 1)
    assert neutral_stats["pid_failed"] == 1
    assert neutral_stats["proxy_errors"] == 0


def test_v1_migration_preserves_the_target_as_perspective():
    base = {
        "name": "Legacy build",
        "race": "Terran",
        "matchup": "vs Protoss",
        "rules": [{
            "type": "building",
            "name": "Barracks",
            "time_lt": 120,
        }],
    }

    own, _ = custom_builds._translate_one_v1_build({**base, "target": "Self"})
    opponent, _ = custom_builds._translate_one_v1_build({
        **base, "target": "Opponent",
    })

    assert own is not None and own["perspective"] == "you"
    assert opponent is not None and opponent["perspective"] == "opponent"
