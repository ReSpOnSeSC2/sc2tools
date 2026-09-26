import copy

import pytest

from scripts.prepare_rich_replay_plan import make_plan


def original(key, *, win=False, user_id=2):
    return {"replay_id": key, "path": "untouched.SC2Replay", "base_build": 97563,
            "data_version": "known", "map_name": "known", "duration_seconds": 500,
            "game_speed": "Faster", "matchup": "PvT", "player_id": user_id,
            "players": [
                {"player_id": user_id, "name": "ReSpOnSe", "race": "Protoss", "starting_workers": 8,
                 "result": "Win" if win else "Loss"},
                {"player_id": 3 - user_id, "name": "Opponent", "race": "Terran", "starting_workers": 8,
                 "result": "Loss" if win else "Win"}]}


def inventory(*rows):
    return {"complete": True, "errors": [], "replays": list(rows)}


def test_existing_holdouts_and_both_perspectives_remain_in_same_partition():
    source = inventory(*[original(str(i), user_id=1 if i % 2 else 2) for i in range(10)])
    before = copy.deepcopy(source)
    plan = make_plan(source, {"0": "validation", "1": "train"})
    assert source == before
    assert "0" in plan["validation_replay_ids"] and "1" in plan["train_replay_ids"]
    assert plan["partition_counts"] == {"validation": 2, "train": 8}
    assert plan["perspectives"] == 20
    for replay in source["replays"]:
        views = [c for c in plan["captures"] if c["replay_id"] == replay["replay_id"]]
        assert len(views) == 2 and len({c["partition"] for c in views}) == 1
        assert {c["matchup"] for c in views} == {"PvT", "TvP"}


def test_weight_applies_only_training_opponent_win_and_evaluation_always_unweighted():
    plan = make_plan(inventory(original("loss"), original("win", win=True), original("holdout")),
                     {"loss": "train", "win": "train", "holdout": "validation"})
    doubled = [c for c in plan["captures"] if c["training_sampling_weight"] == 2]
    assert [(c["replay_id"], c["perspective"]) for c in doubled] == [("loss", "opponent")]
    assert all(c["evaluation_weight"] == 1 for c in plan["captures"])
    assert all(c["eligible_for_training"] is False for c in plan["captures"])


def test_new_partitions_stable_under_inventory_order_changes():
    rows = [original(str(i), win=bool(i % 2)) for i in range(12)]
    a, b = make_plan(inventory(*rows), {}), make_plan(inventory(*reversed(rows)), {})
    assert a["train_replay_ids"] == b["train_replay_ids"]
    assert a["validation_replay_ids"] == b["validation_replay_ids"]
    assert a["captures"] == b["captures"]


@pytest.mark.parametrize("change", ["workers", "race", "build", "identity", "duplicate", "missing_pinned"])
def test_ineligible_or_ambiguous_inputs_fail_before_preparing_jobs(change):
    row = original("one")
    pinned = {}
    rows = [row]
    if change == "workers":
        row["players"][1]["starting_workers"] = 12
    elif change == "race":
        row["players"][1]["race"] = "Random"
    elif change == "build":
        row["base_build"] = 96883
    elif change == "identity":
        row["player_id"] = 1
    elif change == "duplicate":
        rows.append(copy.deepcopy(row))
    else:
        pinned["absent"] = "train"
    with pytest.raises(ValueError):
        make_plan(inventory(*rows), pinned)
