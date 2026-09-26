"""Activation is per match, provenance checked, and time caps cannot earn wins."""
import json
from types import SimpleNamespace

import numpy as np
import pytest
from sc2.data import Result

from pluto_sc2 import league, runner
from pluto_sc2.learning import Transition
from pluto_sc2.rewards import RewardConfig
from pluto_sc2.replay_targets import VERSION


def activate(path, **extra):
    document = {"schema": 1, "enabled": True, "config": RewardConfig().to_dict(), **extra}
    (path / "reward-config.json").write_text(json.dumps(document))


def test_dense_rewards_require_explicit_activation(tmp_path):
    assert league.reward_configuration(tmp_path) == (None, None)
    (tmp_path / "reward-config.json").write_text(json.dumps({"schema": 1, "enabled": False}))
    assert league.reward_configuration(tmp_path) == (None, None)
    activate(tmp_path)
    config, targets = league.reward_configuration(tmp_path)
    assert config == RewardConfig() and targets is None


@pytest.mark.parametrize("document", [[], {"schema": 2, "enabled": True},
                                     {"schema": 1, "enabled": "yes"},
                                     {"schema": 1, "enabled": True, "unknown": 1}])
def test_malformed_activation_is_rejected(tmp_path, document):
    (tmp_path / "reward-config.json").write_text(json.dumps(document))
    with pytest.raises(ValueError):
        league.reward_configuration(tmp_path)


def test_targets_are_hash_pinned_and_train_only(tmp_path):
    targets = tmp_path / "targets.json"
    document = {"version": VERSION, "train_replay_ids": ["train"], "validation_replay_ids": ["heldout"],
                "trajectories": [{"replay_id": "train", "source_sha256": "train", "result": "Victory",
                    "starting_workers": 8, "matchup": "PvT",
                    "frames": [{"seconds": 0, "counts": {"PROBE": 8, "NEXUS": 1}}]}]}
    targets.write_text(json.dumps(document))
    activate(tmp_path, replay_targets=str(targets), replay_targets_sha256=league.sha256(targets))
    _, loaded = league.reward_configuration(tmp_path)
    assert loaded == document
    targets.write_text(json.dumps({**document, "trajectories": []}))
    with pytest.raises(ValueError, match="changed"):
        league.reward_configuration(tmp_path)
    for replacement in ({**document, "validation_replay_ids": ["train"]},
                        {**document, "trajectories": [{"replay_id": "heldout", "matchup": "PvT"}]}):
        targets.write_text(json.dumps(replacement))
        activate(tmp_path, replay_targets=str(targets), replay_targets_sha256=league.sha256(targets))
        with pytest.raises(ValueError, match="disjoint|training replay"):
            league.reward_configuration(tmp_path)


def test_reference_choice_is_fixed_same_matchup_and_only_for_protoss():
    data = {"trajectories": [{"replay_id": "a", "matchup": "PvT"},
                             {"replay_id": "b", "matchup": "PvT"},
                             {"replay_id": "c", "matchup": "PvZ"}]}
    first = league.select_reward_reference(data, "Protoss", "Terran", 7)
    assert first == league.select_reward_reference(data, "Protoss", "Terran", 7)
    assert first["matchup"] == "PvT"
    assert league.select_reward_reference(data, "Terran", "Protoss", 7) is None
    with pytest.raises(ValueError, match="missing"):
        league.select_reward_reference(data, "Protoss", "Protoss", 7)


def test_timeout_correction_keeps_dense_progress_and_removes_large_loss_once():
    observation = np.zeros(3)
    transition = Transition(observation, np.ones(2, dtype=bool), 0, -.1, .2, -9.65, 0., True, False)
    corrected = []
    bot = SimpleNamespace(time=59.9, transitions=[transition], result=Result.Defeat,
                          _last_observation=observation, reward_config=RewardConfig(),
                          policy=SimpleNamespace(value=lambda _: .7),
                          correct_reward_timeout=lambda: corrected.append(True) or 10.)
    host = SimpleNamespace(time=60., transitions=[], result=Result.Tie)
    results, capped = runner._normalize_time_limit([host, bot], ["Tie", "Defeat"], 60., 8)
    assert capped and results == ["Tie", "Tie"]
    assert bot.transitions[-1].reward == pytest.approx(.35)
    assert bot.transitions[-1].next_value == .7
    assert bot.transitions[-1].truncated and not bot.transitions[-1].terminated
    runner._normalize_time_limit([host, bot], ["Tie", "Tie"], 60., 8)
    assert corrected == [True]
