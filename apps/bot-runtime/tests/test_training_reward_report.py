import importlib.util
import json
from pathlib import Path

import pytest


_path = Path(__file__).parents[1] / "scripts" / "training_reward_report.py"
_spec = importlib.util.spec_from_file_location("training_reward_report", _path)
module = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(module)


def fixture(tmp_path):
    state = {"games": 2, "snapshots": {name: [] for name in module.RACES}}
    for game, race in [(1, "Protoss"), (2, "Terran")]:
        folder = tmp_path / "matches" / f"{game:07d}-committed"
        folder.mkdir(parents=True)
        (folder / "learner.pt").write_bytes(b"not loaded or rehashed")
        digest = str(game) * 64
        state["snapshots"][race].append({"path": str((folder / "learner.pt").relative_to(tmp_path)), "sha256": digest})
        match = {"checkpoint_sha256": digest, "learner_race": race, "opponent_race": "Zerg",
                 "results": ["Defeat"], "engine_results": ["Defeat"], "time_limit_reached": game == 2,
                 "policy_actions": [{"camera_home": 80, "no_op": 10, "scout": 5, "train_probe": 5}]}
        if game == 2:
            match["reward_config"] = {"version": "dense-v1"}
            match["reward_breakdown"] = [{"components": {"army": .2}, "raw_components": {"army": .3},
                                           "event_counts": {"army_produced": 2}, "signal_totals": {"minerals": 500},
                                           "terminal_reward": 0, "auxiliary_used": .2}]
        (folder / "match.json").write_text(json.dumps(match))
    (tmp_path / "state.json").write_text(json.dumps(state))
    return state


def test_committed_only_with_time_caps_profiles_and_attempt_fractions(tmp_path):
    fixture(tmp_path)
    # The report must never inspect an uncommitted attempt, even if its JSON is corrupt.
    uncommitted = tmp_path / "matches" / "0000003-uncommitted"
    uncommitted.mkdir()
    (uncommitted / "match.json").write_text("invalid JSON")
    result = module.report(tmp_path)
    assert result["selected_games"] == [1, 2]
    assert result["overall"]["outcomes"] == {"Defeat": 1, "TimeLimit": 1}
    assert result["overall"]["gameplay_fraction"] == pytest.approx(.1)
    assert result["overall"]["non_navigation_fraction"] == pytest.approx(.05)
    assert result["by_reward_profile"]["dense-v1"]["raw_event_counts"] == {"army_produced": 2}
    assert result["by_reward_profile"]["legacy-potential"]["reward_reports"] == 0
    assert result["measured_mmr"] is None
    assert module.report(tmp_path, last=1)["selected_games"] == [2]
    assert module.report(tmp_path, last=1, race="Protoss")["selected_games"] == [1]


def test_mismatched_commit_hash_is_reported_and_not_counted(tmp_path):
    state = fixture(tmp_path)
    state["snapshots"]["Terran"][0]["sha256"] = "f" * 64
    (tmp_path / "state.json").write_text(json.dumps(state))
    result = module.report(tmp_path)
    assert result["selected_games"] == [1]
    assert "disagrees" in result["integrity_errors"][0]["error"]


def test_path_escape_is_rejected_without_reading_outside(tmp_path):
    state = fixture(tmp_path)
    state["snapshots"]["Zerg"].append({"path": "../outside/learner.pt", "sha256": "f" * 64})
    (tmp_path / "state.json").write_text(json.dumps(state))
    result = module.report(tmp_path)
    assert result["selected_games"] == [1, 2]
    assert len(result["integrity_errors"]) == 1
