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
from typing import Any, Dict, List


_HERE = os.path.dirname(os.path.abspath(__file__))
_ROOT = os.path.dirname(_HERE)
if _ROOT not in sys.path:
    sys.path.insert(0, _ROOT)

from core import custom_builds  # noqa: E402
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


def _building(name: str, time: int) -> Dict[str, Any]:
    return {
        "type": "building",
        "name": name,
        "time": time,
        "x": 10.0,
        "y": 10.0,
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
