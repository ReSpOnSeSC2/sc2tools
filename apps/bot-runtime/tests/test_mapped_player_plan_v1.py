"""Admission boundary tests only; these fixtures are never training data."""
import importlib.util
from pathlib import Path

import pytest

spec = importlib.util.spec_from_file_location(
    "mapped_player_plan", Path(__file__).resolve().parents[1] / "scripts/plan_mapped_player_expansion_v1.py")
planner = importlib.util.module_from_spec(spec)
spec.loader.exec_module(planner)


def fixture():
    rows = [dict(replay_id="fixture-only", path="fixture.SC2Replay", player_id=pid,
                 race=race, matchup=matchup, partition="validation", start_workers=8,
                 base_build=97563, data_version="fixture", game_loops=100,
                 training_sampling_weight=1, evaluation_weight=1)
            for pid, race, matchup in [(1, "Protoss", "PvT"), (2, "Terran", "TvP")]]
    return {"perspectives": rows, "fixed_partitions": {"fixture-only": "validation"}}, {
        "replays": [{"replay_id": "fixture-only", "capture_complete": True}]}


def test_both_views_keep_original_partition_and_hash_check_once():
    manifest, progress = fixture()
    calls = []

    def check(path):
        calls.append(path)
        return "fixture-only"

    result = planner.candidates(manifest, progress, check_original=check)
    assert {row["player_id"] for row in result} == {1, 2}
    assert all(row["partition"] == "validation" and row["evaluation_weight"] == 1 for row in result)
    assert calls == ["fixture.SC2Replay"]


@pytest.mark.parametrize("field,value", [("partition", "train"), ("start_workers", 12),
                                        ("base_build", 1), ("matchup", "TvZ")])
def test_scope_or_whole_replay_split_change_rejected(field, value):
    manifest, progress = fixture()
    manifest["perspectives"][0][field] = value
    with pytest.raises(ValueError):
        planner.candidates(manifest, progress, check_original=lambda _: "fixture-only")


def test_unfinished_mapping_not_enqueued_or_hashed():
    manifest, progress = fixture()
    progress["replays"][0]["capture_complete"] = False
    assert planner.candidates(manifest, progress, check_original=lambda _: pytest.fail("No read expected")) == []


def test_mutated_original_rejected():
    manifest, progress = fixture()
    with pytest.raises(ValueError, match="hash"):
        planner.candidates(manifest, progress, check_original=lambda _: "changed")
