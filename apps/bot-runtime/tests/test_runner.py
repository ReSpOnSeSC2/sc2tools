"""Orchestration tests mock the game boundary; they never launch StarCraft II."""

import asyncio
from dataclasses import replace
import json
from pathlib import Path
import sys
from types import SimpleNamespace

import aiohttp
from filelock import FileLock, Timeout
import numpy as np
import pytest
from sc2.data import Result
import torch

from pluto_sc2 import runner
from pluto_sc2.contract import model_metadata
from pluto_sc2.fairplay import FairPlayController, HumanClient
from pluto_sc2.learning import Policy, PPOConfig, Transition, load_checkpoint, save_checkpoint
from pluto_sc2.schema import ACTION_NAMES, OBSERVATION_SIZE


@pytest.fixture(autouse=True)
def small_thread_pool():
    old_threads = torch.get_num_threads()
    torch.set_num_threads(1)
    yield
    torch.set_num_threads(old_threads)


def make_policy():
    return Policy(OBSERVATION_SIZE, len(ACTION_NAMES), 16)


def make_episode(policy, reward=1.0):
    mask = np.zeros(len(ACTION_NAMES), dtype=bool)
    mask[:2] = True
    observations = [np.zeros(OBSERVATION_SIZE, dtype=np.float32), np.ones(OBSERVATION_SIZE, dtype=np.float32) * .1]
    transitions = []
    for index, observation in enumerate(observations):
        action, log_prob, value = policy.act(observation, mask)
        terminal = index == 1
        transitions.append(Transition(
            observation, mask.copy(), action, log_prob, value,
            reward if terminal else 0.0,
            0.0 if terminal else policy.value(observations[index + 1]), terminal, False,
        ))
    return SimpleNamespace(
        policy=policy, error=None, _episode_finished=True, transitions=transitions,
        fairplay=FairPlayController(), time=12.0,
    )


def match_fixture(policy, **kwargs):
    episodes = [make_episode(policy)]
    if kwargs.get("opponent") == "self":
        episodes.append(make_episode(policy, reward=-1.0))
    return episodes, {"results": ["Victory", "Defeat"][:len(episodes)], "seed": kwargs.get("seed", 1)}


def training_kwargs(output):
    return dict(map_name="EightWorkerMelee", output=output, games=1, hidden_dim=16,
                config=PPOConfig(epochs=1, minibatch_size=4, target_kl=None),
                save_replays_every=0)


def test_training_checkpoint_resumes_configuration_optimizer_and_game_counter(tmp_path, monkeypatch):
    calls = []

    def mock_match(policy, map_name, **kwargs):
        calls.append(kwargs)
        return match_fixture(policy, **kwargs)

    monkeypatch.setattr(runner, "play_match", mock_match)
    options = training_kwargs(tmp_path)
    initial = runner.train(**options)
    first = load_checkpoint(initial["checkpoint"])
    first_step = next(iter(first["optimizer_state"]["state"].values()))["step"].item()
    resumed = runner.train(**options, resume=initial["checkpoint"])
    restored = load_checkpoint(resumed["checkpoint"])
    assert resumed["completed_games"] == 2
    assert restored["counters"] == {"games": 2}
    assert restored["config"] == options["config"]
    assert next(iter(restored["optimizer_state"]["state"].values()))["step"].item() > first_step
    assert [call["seed"] for call in calls] == [2, 3]
    assert len((tmp_path / "metrics.jsonl").read_text().splitlines()) == 2
    assert restored["metadata"]["start_workers"] == 8
    assert restored["metadata"]["step_mul"] == 8


def test_imitation_checkpoint_starts_new_ppo_optimizer_and_counter(tmp_path, monkeypatch):
    checkpoint = tmp_path / "imitation.pt"
    ancestry = {"version": 1, "known_train_replay_ids": ["a" * 64], "complete": True}
    save_checkpoint(checkpoint, make_policy(),
                    metadata=model_metadata(stage="imitation", training_ancestry=ancestry), counters={"games": 900})
    monkeypatch.setattr(runner, "play_match", lambda policy, *args, **kwargs: match_fixture(policy, **kwargs))
    result = runner.train(**training_kwargs(tmp_path / "rl"), resume=str(checkpoint))
    loaded = load_checkpoint(result["checkpoint"])
    assert loaded["counters"]["games"] == 1
    assert loaded["metadata"]["stage"] == "reinforcement"
    assert loaded["metadata"]["training_ancestry"] == ancestry
    assert loaded["optimizer_state"] is not None
    original = load_checkpoint(checkpoint)["policy"].state_dict()
    assert loaded["metadata"]["reference_enabled"]
    assert all(torch.equal(original[key], value)
               for key, value in loaded["reference_policy"].state_dict().items())
    assert any(not torch.equal(original[key], value)
               for key, value in loaded["policy"].state_dict().items())
    resumed = runner.train(**training_kwargs(tmp_path / "rl"), resume=result["checkpoint"])
    assert load_checkpoint(resumed["checkpoint"])["metadata"]["training_ancestry"] == ancestry
    assert all(torch.equal(original[key], value)
               for key, value in load_checkpoint(resumed["checkpoint"])["reference_policy"].state_dict().items())


@pytest.mark.parametrize("case", ["config", "optimizer", "stage", "contract", "reference"])
def test_incompatible_resume_is_rejected_before_game_or_optimizer_work(tmp_path, monkeypatch, case):
    policy = make_policy()
    config = PPOConfig(epochs=1, minibatch_size=4, target_kl=None)
    metadata = model_metadata(stage="reinforcement")
    saved_config = config
    optimizer = torch.optim.Adam(policy.parameters())
    if case == "config":
        saved_config = PPOConfig(epochs=9)
    elif case == "optimizer":
        optimizer = None
    elif case == "stage":
        metadata["stage"] = "unknown"
    elif case == "reference":
        metadata["reference_enabled"] = True
    else:
        metadata["start_workers"] = 12
    path = tmp_path / "source.pt"
    save_checkpoint(path, policy, optimizer=optimizer, config=saved_config, metadata=metadata)
    calls = []
    monkeypatch.setattr(runner, "play_match", lambda *args, **kwargs: calls.append(1))
    with pytest.raises(ValueError):
        runner.train(**training_kwargs(tmp_path / "out"), resume=str(path))
    assert not calls
    assert not (tmp_path / "out" / "latest.pt").exists()


def test_training_failure_preserves_last_completed_checkpoint(tmp_path, monkeypatch):
    monkeypatch.setattr(runner, "play_match", lambda policy, *args, **kwargs: match_fixture(policy, **kwargs))
    options = training_kwargs(tmp_path)
    initial = runner.train(**options)
    checkpoint = Path(initial["checkpoint"])
    original = checkpoint.read_bytes()

    def invalid_scenario(*args, **kwargs):
        raise RuntimeError("Eight-worker Protoss scenario required: observed workers=12")

    monkeypatch.setattr(runner, "play_match", invalid_scenario)
    with pytest.raises(RuntimeError, match="workers=12"):
        runner.train(**options, resume=str(checkpoint))
    assert checkpoint.read_bytes() == original
    failure = json.loads((tmp_path / "failures.jsonl").read_text().splitlines()[-1])
    assert failure["game"] == 2
    assert failure["kind"] == "RuntimeError"
    assert len((tmp_path / "metrics.jsonl").read_text().splitlines()) == 1


@pytest.mark.parametrize("failure", ["start", "incomplete", "empty", "boundary", "internal", "policy", "audit"])
def test_invalid_match_data_never_reaches_optimizer(tmp_path, monkeypatch, failure):
    def invalid_match(policy, *args, **kwargs):
        episode = make_episode(policy)
        if failure == "start":
            episode.error = "Eight-worker Protoss scenario required: observed workers=12"
        elif failure == "incomplete":
            episode._episode_finished = False
        elif failure == "empty":
            episode.transitions.clear()
        elif failure == "boundary":
            episode.transitions[-1] = replace(episode.transitions[-1], terminated=False)
        elif failure == "internal":
            episode.transitions[0] = replace(episode.transitions[0], truncated=True)
        elif failure == "policy":
            episode.policy = make_policy()
        else:
            episode.fairplay.audit.append({"kind": "camera", "time": float("nan")})
        return [episode], {"results": ["Defeat"]}

    update_calls = []
    monkeypatch.setattr(runner, "play_match", invalid_match)
    monkeypatch.setattr(runner.PPOTrainer, "update", lambda *args, **kwargs: update_calls.append(True))
    with pytest.raises((ValueError, RuntimeError)):
        runner.train(**training_kwargs(tmp_path))
    assert update_calls == []
    assert not (tmp_path / "latest.pt").exists()
    assert not (tmp_path / "metrics.jsonl").exists()


def test_both_selfplay_rollouts_keep_explicit_gae_episode_boundaries():
    policy = make_policy()
    first, second = make_episode(policy, 1), make_episode(policy, -1)
    combined = runner._training_transitions([first, second], policy)
    assert len(combined) == 4
    assert combined[1].terminated and combined[3].terminated
    assert combined[1].reward == 1 and combined[3].reward == -1


def timeout_episode(result, *, time=59.8, terminal=True):
    policy = make_policy()
    episode = make_episode(policy)
    episode.time = time
    episode.result = result
    episode.gamma, episode.reward_shaping = .9, .1
    episode._potential = lambda: .5
    episode._last_observation = np.full(OBSERVATION_SIZE, .25, dtype=np.float32)
    outcome = 1.0 if result == Result.Victory else -1.0 if result == Result.Defeat else 0.0
    episode.transitions[-1] = replace(
        episode.transitions[-1], reward=outcome - .1 * .3 if terminal else .015,
        terminated=terminal, truncated=not terminal,
        next_value=0.0 if terminal else policy.value(episode._last_observation),
    )
    return episode


def test_selfplay_timeout_removes_asymmetric_loss_and_restores_shaped_bootstrap():
    host = timeout_episode(Result.Tie, terminal=False)
    peer = timeout_episode(Result.Defeat)
    original_host_tail = host.transitions[-1]
    expected_peer_bootstrap = peer.policy.value(peer._last_observation)
    names, capped = runner._normalize_time_limit([host, peer], ["Tie", "Defeat"], 60, 8)
    assert capped and names == ["Tie", "Tie"]
    assert host.transitions[-1] is original_host_tail
    corrected = peer.transitions[-1]
    assert corrected.truncated and not corrected.terminated
    assert corrected.reward == pytest.approx(.1 * (.9 * .5 - .3))
    assert corrected.next_value == expected_peer_bootstrap
    assert host.result == peer.result == Result.Tie


@pytest.mark.parametrize("names,time", [(["Tie", "Defeat"], 10), (["Victory", "Defeat"], 59.8)])
def test_time_limit_correction_preserves_earlier_ties_and_normal_wins(names, time):
    host = timeout_episode(Result[names[0]], time=time)
    peer = timeout_episode(Result[names[1]], time=time)
    original_tail = peer.transitions[-1]
    actual_names, capped = runner._normalize_time_limit([host, peer], names, 60, 8)
    assert not capped and actual_names == names
    assert peer.transitions[-1] is original_tail


def test_time_limit_correction_cannot_invent_missing_bootstrap_observation():
    host = timeout_episode(Result.Tie, terminal=False)
    peer = timeout_episode(Result.Defeat)
    peer._last_observation = None
    with pytest.raises(RuntimeError, match="final observation"):
        runner._normalize_time_limit([host, peer], ["Tie", "Defeat"], 60, 8)


def test_output_checkpoint_cannot_be_accidentally_overwritten(tmp_path, monkeypatch):
    checkpoint = tmp_path / "latest.pt"
    checkpoint.write_bytes(b"existing checkpoint")
    with pytest.raises(ValueError, match="already contains"):
        runner.train(**training_kwargs(tmp_path))
    assert checkpoint.read_bytes() == b"existing checkpoint"


def test_training_directory_lock_prevents_concurrent_training(tmp_path):
    with FileLock(str(tmp_path / ".training.lock"), timeout=0):
        with pytest.raises(Timeout):
            runner.train(**training_kwargs(tmp_path))
    assert not (tmp_path / "latest.pt").exists()


def test_different_resume_cannot_overwrite_existing_run(tmp_path):
    checkpoint = tmp_path / "latest.pt"
    checkpoint.write_bytes(b"newest successful checkpoint")
    with pytest.raises(ValueError, match="own latest.pt"):
        runner.train(**training_kwargs(tmp_path), resume=str(tmp_path / "older.pt"))
    assert checkpoint.read_bytes() == b"newest successful checkpoint"


def test_evaluation_preserves_previous_artifacts_before_loading_model(tmp_path):
    result = tmp_path / "matches.jsonl"
    result.write_text("original matches\n")
    with pytest.raises(ValueError, match="not empty"):
        runner.evaluate(checkpoint="absent.pt", map_name="Example", output=str(tmp_path))
    assert result.read_text() == "original matches\n"


def test_evaluation_output_is_locked(tmp_path):
    with FileLock(str(tmp_path / ".evaluation.lock"), timeout=0):
        with pytest.raises(Timeout):
            runner.evaluate(checkpoint="absent.pt", map_name="Example", output=str(tmp_path))


def test_spatial_client_and_process_injections_restore_even_on_exception():
    import sc2.main
    original_client, original_process = sc2.main.Client, sc2.main.SC2Process
    with pytest.raises(RuntimeError, match="test failure"):
        with runner.spatial_client():
            assert sc2.main.Client is HumanClient
            assert sc2.main.SC2Process is runner.ManagedSC2Process
            raise RuntimeError("test failure")
    assert sc2.main.Client is original_client
    assert sc2.main.SC2Process is original_process


def test_play_match_selfplay_uses_same_frozen_policy_and_eight_worker_contract(monkeypatch):
    import sc2.main
    policy = make_policy()
    captured = []

    def fake_run_game(map_info, players, **kwargs):
        captured.extend(players)
        assert sc2.main.Client is HumanClient
        assert sc2.main.SC2Process is runner.ManagedSC2Process
        assert kwargs["disable_fog"] is False
        for player in players:
            assert player.ai.expected_start_workers == 8
            assert player.ai.step_mul == 8
            assert player.ai.policy is policy
            player.ai._episode_finished = True
            player.ai.state = SimpleNamespace(game_loop=224)
        return [Result.Victory, Result.Defeat]

    monkeypatch.setattr(sc2.main, "run_game", fake_run_game)
    monkeypatch.setattr(runner, "resolve_map", lambda name: name)
    before = {key: tensor.clone() for key, tensor in policy.state_dict().items()}
    bots, match = runner.play_match(policy, "map", opponent="self")
    assert len(bots) == 2 and len(captured) == 2
    assert match["results"] == ["Victory", "Defeat"]
    assert all(torch.equal(before[key], tensor) for key, tensor in policy.state_dict().items())


@pytest.mark.parametrize("case", ["start_error", "unfinished", "missing_result"])
def test_game_library_losses_cannot_hide_bot_failures(monkeypatch, case):
    import sc2.main

    def fake_run_game(map_info, players, **kwargs):
        agent = players[0].ai
        agent.state = SimpleNamespace(game_loop=224)
        if case == "start_error":
            agent.error = "Eight-worker Protoss scenario required: observed workers=12"
        elif case == "missing_result":
            agent._episode_finished = True
            return None
        return Result.Defeat

    monkeypatch.setattr(sc2.main, "run_game", fake_run_game)
    monkeypatch.setattr(runner, "resolve_map", lambda name: name)
    with pytest.raises(RuntimeError):
        runner.play_match(make_policy(), "map")


@pytest.mark.parametrize("kwargs", [
    {"step_mul": 4}, {"step_mul": True}, {"max_game_seconds": float("nan")},
    {"opponent": "human", "realtime": False}, {"difficulty": "CheatInsane"},
    {"opponent_race": "unknown"}, {"seed": -1},
])
def test_invalid_match_configuration_rejected_before_launch(kwargs, monkeypatch):
    import sc2.main
    calls = []
    monkeypatch.setattr(sc2.main, "run_game", lambda *args, **kw: calls.append(True))
    with pytest.raises(ValueError):
        runner.play_match(make_policy(), "map", **kwargs)
    assert calls == []


def sample_audit():
    controller = FairPlayController()
    actions = [
        {"time": 0.0, "kind": "selection", "camera": [50, 50], "source_tags": [1],
         "source_positions": [[50, 50]], "result": [1]},
        {"time": .4, "kind": "command", "camera": [50, 50], "ability": 16,
         "target": [53, 50], "minimap": False, "result": [1]},
        {"time": .8, "kind": "camera", "camera": [50, 50], "destination": [100, 50], "result": [1]},
    ]
    for action in actions:
        controller.budget.consume(action["time"])
    return {"summary": controller.summary(), "actions": actions}


def test_emitted_audit_independently_validates_timing_and_screen_bounds():
    assert runner.validate_action_audit(sample_audit())["events"] == 3


@pytest.mark.parametrize("field", ["time", "camera", "target", "source", "destination", "minimap", "kind", "spacing", "summary", "outside"])
def test_audit_parser_fails_closed_on_invalid_or_nonfinite_fields(field):
    audit = sample_audit()
    if field == "time":
        audit["actions"][0]["time"] = float("nan")
    elif field == "camera":
        audit["actions"][0]["camera"] = [float("nan"), 50]
    elif field == "target":
        audit["actions"][1]["target"] = [float("inf"), 50]
    elif field == "source":
        audit["actions"][0]["source_positions"] = []
    elif field == "destination":
        audit["actions"][2]["destination"] = ["100", 50]
    elif field == "minimap":
        audit["actions"][1]["minimap"] = "false"
    elif field == "kind":
        audit["actions"][1]["kind"] = "raw"
    elif field == "spacing":
        audit["actions"][1]["time"] = .1
    elif field == "summary":
        audit["summary"]["total_actions"] = 1
    else:
        audit["actions"][1]["target"] = [100, 50]
    with pytest.raises(ValueError):
        runner.validate_action_audit(audit)


def test_audit_rechecks_lower_configured_apm_limit():
    audit = sample_audit()
    audit["summary"]["max_apm"] = 60
    audit["summary"]["minimum_input_interval_seconds"] = 1
    with pytest.raises(ValueError, match="spacing"):
        runner.validate_action_audit(audit)


def recorded_group_audit(*, assign_offscreen=False):
    """Use real controller inputs; the fixture client is the mocked engine."""
    from test_fairplay import offscreen_production_observation, registered_nexus_group, step

    async def record():
        state, controller = await registered_nexus_group()
        offscreen_production_observation(state)
        step(state, 24, selected=[1])
        await controller.issue(state, [], None if assign_offscreen else 1006,
                               selection_mode="control_group", control_group=2)
        step(state, 32, selected=[1])
        await controller.advance(state)
        if assign_offscreen:
            step(state, 40, selected=[1])
            await controller.set_control_group(state, 3)
        return {"summary": controller.summary(), "actions": controller.audit}

    return asyncio.run(record())


@pytest.mark.parametrize("assign_offscreen", [False, True])
def test_generated_offscreen_group_audit_validates_actual_assignment_recall_chain(assign_offscreen):
    audit = recorded_group_audit(assign_offscreen=assign_offscreen)
    assert audit["actions"][2]["source_positions"] == []
    result = runner.validate_action_audit(audit)
    assert result["events"] == 4 and "UI group provenance" in result["scope"]


def recorded_idle_single_group_audit():
    from test_fairplay import offscreen_production_observation, registered_nexus_group, step

    async def record():
        state, controller = await registered_nexus_group()
        offscreen_production_observation(state)
        panel = state.state.observation.ui_data.single
        panel.unit.unit_type, panel.unit.player_relative = 59, 1
        step(state, 24, selected=[1])
        await controller.issue(state, [], 1006, selection_mode="control_group", control_group=2)
        step(state, 32, selected=[1])
        await controller.advance(state)
        return {"summary": controller.summary(), "actions": controller.audit}
    return asyncio.run(record())


def test_explicit_idle_single_group_audit_validates_ui_snapshot_and_provenance():
    audit = recorded_idle_single_group_audit()
    assert audit["actions"][-1]["group_production"]["queue_evidence"]["source"] == "selected_idle_single_panel"
    assert runner.validate_action_audit(audit)["events"] == 4


@pytest.mark.parametrize("corruption", ["missing_panel", "unknown_panel", "foreign", "wrong_type", "queued",
                                       "missing_variant", "foreign_queue", "fabricated_observed_queue"])
def test_idle_single_audit_rejects_unknown_or_mismatching_ui_proof(corruption):
    audit = recorded_idle_single_group_audit()
    proof = audit["actions"][-1]["group_production"]
    if corruption == "missing_panel":
        proof.pop("ui_panel")
    elif corruption == "unknown_panel":
        proof["ui_panel"]["panel_kind"] = None
    elif corruption == "foreign":
        proof["ui_panel"]["player_relative"] = 4
    elif corruption == "wrong_type":
        proof["ui_panel"]["unit_type"] = 62
    elif corruption == "queued":
        proof["queue_evidence"].update(build_queue_count=1, production_queue_count=1, queue_item_count=1)
    elif corruption == "missing_variant":
        proof["queue_evidence"].pop("panel_kind")
    elif corruption == "foreign_queue":
        proof["queue_evidence"]["player_relative"] = 4
    else:
        proof["ui_panel"]["production_queue_count"] = 0
    with pytest.raises(ValueError):
        runner.validate_action_audit(audit)


def test_historical_production_panel_audit_without_new_ui_snapshot_still_validates():
    audit = recorded_group_audit()
    proof = audit["actions"][-1]["group_production"]
    proof.pop("ui_panel")
    proof["queue_evidence"].pop("panel_kind")
    proof["queue_evidence"].pop("player_relative")
    assert runner.validate_action_audit(audit)["events"] == 4


@pytest.mark.parametrize("corruption", [
    "missing_mode", "unknown_mode", "unconfirmed_selection", "failed_assignment", "invented_member",
    "changed_selection", "wrong_assignment", "future_reference", "bool_reference", "wrong_group",
    "command_extra_member", "wrong_offscreen_count", "missing_command_provenance",
    "production_assignment", "negative_cost", "nonfinite_cost", "empty_ui_abilities", "targeted_production",
    "missing_queue", "wrong_queue_source", "overqueued", "queue_disagreement", "queue_multiple_producers",
])
def test_group_audit_rejects_broken_provenance_and_forged_production_evidence(corruption):
    audit = recorded_group_audit()
    actions = audit["actions"]
    if corruption == "missing_mode":
        actions[2].pop("selection_mode")
    elif corruption == "unknown_mode":
        actions[2]["selection_mode"] = "raw_group"
    elif corruption == "unconfirmed_selection":
        actions[0]["selection_confirmation"] = "source_not_selected"
    elif corruption == "failed_assignment":
        actions[1]["result"] = [3]
    elif corruption == "invented_member":
        actions[1]["registered_tags"].append(99)
    elif corruption == "changed_selection":
        actions[1]["selected_tags"] = [99]
    elif corruption == "wrong_assignment":
        actions[2]["group_assignment_audit_index"] = 0
    elif corruption == "future_reference":
        actions[1]["selection_provenance_audit_index"] = 2
    elif corruption == "bool_reference":
        actions[1]["selection_provenance_audit_index"] = False
    elif corruption == "wrong_group":
        actions[3]["control_group"] = 3
    elif corruption == "command_extra_member":
        actions[3]["source_tags"].append(99)
    elif corruption == "wrong_offscreen_count":
        actions[3]["offscreen_selected_count"] = 0
    elif corruption == "missing_command_provenance":
        actions[3].pop("selection_provenance_audit_index")
    elif corruption == "production_assignment":
        actions[3]["group_production"]["group_assignment_audit_index"] = 0
    elif corruption == "negative_cost":
        actions[3]["group_production"]["mineral_cost"] = -1
    elif corruption == "nonfinite_cost":
        actions[3]["group_production"]["supply_cost"] = float("nan")
    elif corruption == "empty_ui_abilities":
        actions[3]["group_production"]["selection_ui_abilities"] = []
    elif corruption == "missing_queue":
        actions[3]["group_production"].pop("queue_evidence")
    elif corruption == "wrong_queue_source":
        actions[3]["group_production"]["queue_evidence"]["source"] = "offscreen_raw_orders"
    elif corruption == "overqueued":
        queue = actions[3]["group_production"]["queue_evidence"]
        queue.update(build_queue_count=2, queue_item_count=2)
    elif corruption == "queue_disagreement":
        actions[3]["group_production"]["queue_evidence"]["queue_item_count"] = 1
    elif corruption == "queue_multiple_producers":
        actions[3]["group_production"]["queue_evidence"]["producer_count"] = 2
    else:
        actions[3]["target"] = [50, 50]
    with pytest.raises(ValueError):
        runner.validate_action_audit(audit)


def recorded_append_audit():
    from test_fairplay import bot, own_selection_rows, step, unit

    async def record():
        first, second = unit(1, type_id=59, is_structure=True), unit(2, (52, 50), type_id=59, is_structure=True)
        state = bot(first, second)
        own_selection_rows(state)
        controller = FairPlayController(camera_center=(50, 50))
        for index, source in enumerate((first, second)):
            step(state, index * 24, selected=[1] if index else [])
            await controller.issue(state, [source], None)
            step(state, index * 24 + 8, selected=[source.tag])
            await controller.advance(state)
            step(state, index * 24 + 16, selected=[source.tag])
            await controller.set_control_group(state, 2, append=bool(index))
        step(state, 48, selected=[2])
        await controller.issue(state, [], None, selection_mode="control_group", control_group=2)
        step(state, 56, selected=[1, 2])
        await controller.advance(state)
        return {"summary": controller.summary(), "actions": controller.audit}

    return asyncio.run(record())


def test_group_append_validates_union_of_paid_selection_and_previous_group():
    audit = recorded_append_audit()
    assert audit["actions"][3]["prior_group_tags"] == [1]
    assert audit["actions"][3]["registered_tags"] == [1, 2]
    assert runner.validate_action_audit(audit)["events"] == 5


@pytest.mark.parametrize("corruption", ["stale_selection", "stale_members", "missing_member", "unregistered_append",
                                      "failed_previous_set", "stale_recall"])
def test_group_append_and_recall_reject_stale_or_unregistered_chain(corruption):
    audit = recorded_append_audit()
    actions = audit["actions"]
    if corruption == "stale_selection":
        actions[3]["selection_provenance_audit_index"] = 0
    elif corruption == "stale_members":
        actions[3]["prior_group_tags"] = []
    elif corruption == "missing_member":
        actions[3]["registered_tags"] = [2]
    elif corruption == "unregistered_append":
        actions[1]["selection_mode"] = "control_group_append"
    elif corruption == "failed_previous_set":
        actions[1]["result"] = [3]
    else:
        actions[4]["group_assignment_audit_index"] = 1
    with pytest.raises(ValueError):
        runner.validate_action_audit(audit)


@pytest.mark.parametrize("mode", ["army", "rectangle"])
def test_generated_global_army_and_rectangle_audits_keep_real_selection_provenance(mode):
    from sc2.position import Point2
    from test_fairplay import HiddenSelectedUnit, bot, own_selection_rows, screen_layers, step, unit

    async def record():
        visible = unit(1, (48, 50))
        other = HiddenSelectedUnit() if mode == "army" else unit(2, (52, 49), type_id=73)
        state = bot(visible, other)
        own_selection_rows(state)
        screen_layers(state)
        controller = FairPlayController(camera_center=(50, 50))
        await controller.issue(state, [visible] if mode == "army" else [visible, other],
                               23, Point2((55, 50)), selection_mode=mode)
        step(state, 8, selected=[1, 2])
        await controller.advance(state)
        return {"summary": controller.summary(), "actions": controller.audit}

    audit = asyncio.run(record())
    assert runner.validate_action_audit(audit)["events"] == 2
    if mode == "rectangle":
        audit["actions"][0]["selection_rectangle"][1][0] = 128
    else:
        audit["actions"][1]["visible_command_source_tags"] = [99]
    with pytest.raises(ValueError):
        runner.validate_action_audit(audit)


def test_explicit_empty_anchor_f2_selection_requires_confirmation_for_assignment():
    from test_fairplay import HiddenSelectedUnit, bot, own_selection_rows, step

    async def record():
        state = bot(HiddenSelectedUnit())
        own_selection_rows(state)
        controller = FairPlayController(camera_center=(50, 50))
        await controller.issue(state, [], None, selection_mode="army")
        step(state, 8, selected=[2])
        await controller.advance(state)
        step(state, 16, selected=[2])
        await controller.set_control_group(state, 1)
        return {"summary": controller.summary(), "actions": controller.audit}

    audit = asyncio.run(record())
    assert audit["actions"][0]["source_tags"] == []
    assert runner.validate_action_audit(audit)["events"] == 2
    audit["actions"][0]["result"] = [3]
    with pytest.raises(ValueError):
        runner.validate_action_audit(audit)


def producer_portrait_audit():
    audit = recorded_group_audit()
    parent, command = audit["actions"][2:]
    parent["command_confirmation"] = "production_subselection"
    portrait = {
        "time": command["time"], "kind": "selection", "camera": list(command["camera"]),
        "selection_mode": "control_group_producer", "control_group": 2,
        "registered_tags": [1], "group_assignment_audit_index": 1,
        "parent_selection_audit_index": 2, "parent_selected_tags": [1],
        "production_ui_index": 0, "production_ui_unit_type": 59,
        "source_tags": [], "source_positions": [], "result": [1],
        "selected_tags": [1], "command_source_tags": [1], "selection_confirmation": "confirmed",
        "command_confirmation": "accepted",
    }
    command.update(time=command["time"] + 8 / 22.4, selection_mode="control_group_producer",
                   selection_audit_index=3, selection_provenance_audit_index=3)
    audit["actions"].insert(3, portrait)
    budget = FairPlayController()
    for action in audit["actions"]:
        budget.budget.consume(action["time"])
    audit["summary"] = budget.summary()
    return audit


def test_producer_portrait_chain_links_paid_recall_to_exactly_one_registered_producer():
    assert runner.validate_action_audit(producer_portrait_audit())["events"] == 5


@pytest.mark.parametrize("rejected_portrait", [False, True])
def test_real_controller_multi_producer_portrait_audit_accounts_for_every_paid_ui_input(rejected_portrait):
    from test_fairplay import (
        HiddenSelectedUnit, offscreen_production_observation, registered_nexus_group, step, unit,
    )

    async def record():
        state, controller = await registered_nexus_group()
        second = unit(2, (52, 50), type_id=59, is_structure=True)
        state.all_units.append(second)
        state.state.observation_raw.units.add(tag=2, alliance=1)
        step(state, 24, selected=[1])
        await controller.issue(state, [second], None)
        step(state, 32, selected=[2])
        await controller.advance(state)
        await controller.set_control_group(state, 2, append=True)
        offscreen_production_observation(state)
        state.all_units.append(HiddenSelectedUnit())
        panel = state.state.observation.ui_data
        for _ in range(2):
            panel.multi.units.add(unit_type=59, player_relative=1)
        step(state, 40, selected=[2])
        await controller.issue(state, [], 1006, selection_mode="control_group", control_group=2)
        if rejected_portrait:
            state.client.results = (3,)
        step(state, 48, selected=[1, 2])
        await controller.advance(state)
        assert controller.audit[-1]["selection_mode"] == "control_group_producer"
        portrait = state.client.requests[-1].actions[0].action_ui.multi_panel
        assert portrait.type == 1 and portrait.unit_index == 0
        if not rejected_portrait:
            panel.production.unit.unit_type = 59
            panel.production.unit.player_relative = 1
            step(state, 56, selected=[1])
            await controller.advance(state)
            assert controller.audit[-1]["kind"] == "command"
            assert controller.audit[-1]["source_tags"] == [1]
        return {"summary": controller.summary(), "actions": controller.audit}

    audit = asyncio.run(record())
    assert runner.validate_action_audit(audit)["events"] == (6 if rejected_portrait else 7)


@pytest.mark.parametrize("corruption", ["stale_parent", "wrong_parent_members", "wrong_group", "not_subselected",
                                      "bad_portrait", "invalid_type", "multiple_members", "new_member", "not_production"])
def test_producer_portrait_audit_rejects_forged_selection_chain(corruption):
    audit = producer_portrait_audit()
    parent, portrait, command = audit["actions"][2:]
    if corruption == "stale_parent":
        portrait["parent_selection_audit_index"] = 0
    elif corruption == "wrong_parent_members":
        portrait["parent_selected_tags"] = [2]
    elif corruption == "wrong_group":
        portrait["control_group"] = 3
    elif corruption == "not_subselected":
        parent["command_confirmation"] = "selection_only"
    elif corruption == "bad_portrait":
        portrait["production_ui_index"] = 1
    elif corruption == "invalid_type":
        portrait["production_ui_unit_type"] = 0
    elif corruption == "multiple_members":
        portrait["selected_tags"] = [1, 2]
    elif corruption == "new_member":
        portrait["selected_tags"] = [99]
    else:
        command["group_production"] = None
    with pytest.raises(ValueError):
        runner.validate_action_audit(audit)


def test_atomic_json_failure_preserves_existing_file_and_removes_temporary(tmp_path, monkeypatch):
    path = tmp_path / "state.json"
    runner.write_json(path, {"before": True})
    before = path.read_bytes()

    def fail_replace(self, target):
        raise OSError("disk failure")

    monkeypatch.setattr(Path, "replace", fail_replace)
    with pytest.raises(OSError):
        runner.write_json(path, {"after": True})
    assert path.read_bytes() == before
    assert list(tmp_path.iterdir()) == [path]


def test_doctor_counts_executables_and_ignores_logs_and_directories(tmp_path):
    versions = tmp_path / "Versions" / "Base123"
    versions.mkdir(parents=True)
    binary = "SC2_x64.exe" if sys.platform == "win32" else "SC2_x64"
    (versions / binary).write_bytes(b"test fixture; not executable game content")
    (versions / "SC2_x64.log").write_text("not a game")
    (versions / "SC2_x64.errors").write_text("not a game")
    second = tmp_path / "Versions" / "Base456" / binary
    second.mkdir(parents=True)
    assert runner.doctor(str(tmp_path))["sc2_binaries"] == 1


def test_map_resolver_rejects_cache_extension_with_copy_instructions(tmp_path):
    cached = tmp_path / "cached.s2ma"
    cached.write_bytes(b"map fixture")
    with pytest.raises(ValueError, match=r"Copy the cached file to a \.SC2Map"):
        runner.resolve_map(str(cached))
    assert cached.read_bytes() == b"map fixture"
    assert not cached.with_suffix(".SC2Map").exists()


def test_map_resolver_accepts_local_sc2map_and_rejects_unrelated_files(tmp_path):
    from sc2.maps import Map
    playable = tmp_path / "local.SC2Map"
    playable.write_bytes(b"map fixture")
    result = runner.resolve_map(str(playable))
    assert isinstance(result, Map)
    assert result.path == playable.resolve()
    unrelated = tmp_path / "map.txt"
    unrelated.write_text("not a map")
    with pytest.raises(ValueError, match="must be a .SC2Map"):
        runner.resolve_map(str(unrelated))


class MockSession:
    def __init__(self, outcome):
        self.outcome = outcome
        self.closed = False
        self.attempts = 0
        self.connect_options = []

    async def ws_connect(self, url, **kwargs):
        self.attempts += 1
        self.connect_options.append(kwargs)
        if self.outcome == "hang":
            await asyncio.sleep(60)
        if isinstance(self.outcome, BaseException):
            raise self.outcome
        return self.outcome

    async def close(self):
        self.closed = True


def test_process_exit_preserves_live_peer_and_restores_original_signal(monkeypatch):
    import sc2.controller
    events = []
    original_handler = object()
    monkeypatch.setattr(runner.ManagedSC2Process, "_active", set())
    monkeypatch.setattr(runner.ManagedSC2Process, "_previous_sigint", None)
    monkeypatch.setattr(runner.signal, "getsignal", lambda *_: original_handler)
    monkeypatch.setattr(runner.signal, "signal", lambda _, handler: events.append(("signal", handler)))
    monkeypatch.setattr(sc2.controller, "Controller", lambda ws, process: process)

    def child(name, fail=False):
        instance = object.__new__(runner.ManagedSC2Process)
        instance._launch = lambda: object()

        async def connect():
            if fail:
                raise RuntimeError("startup failure")
            return object()

        async def close():
            events.append(("close", name))

        instance._connect = connect
        instance._close_connection = close
        instance._clean = lambda **_: events.append(("clean", name))
        return instance

    async def exercise():
        first, second, failing = child("first"), child("second"), child("failing", True)
        await first.__aenter__()
        await second.__aenter__()
        with pytest.raises(RuntimeError, match="startup failure"):
            await failing.__aenter__()
        assert runner.ManagedSC2Process._active == {first, second}
        await first.__aexit__(None, None, None)
        assert runner.ManagedSC2Process._active == {second}
        assert ("clean", "second") not in events
        assert ("signal", original_handler) not in events
        await second.__aexit__(None, None, None)

    asyncio.run(exercise())
    assert not runner.ManagedSC2Process._active
    assert events.count(("clean", "first")) == events.count(("clean", "second")) == 1
    assert events[-1] == ("signal", original_handler)


def process_fixture(session, monkeypatch, *, exit_code=None):
    monkeypatch.setattr(aiohttp, "ClientSession", lambda **kwargs: session)
    process = object.__new__(runner.ManagedSC2Process)
    process._host, process._port = "127.0.0.1", 5000
    process._process = SimpleNamespace(poll=lambda: exit_code)
    process._session = None
    process.startup_timeout_seconds = .04
    process.connect_timeout_seconds = .01
    process.poll_interval_seconds = .001
    return process


def test_process_startup_reports_child_exit_without_waiting_on_socket(monkeypatch):
    session = MockSession("hang")
    process = process_fixture(session, monkeypatch, exit_code=3221225781)
    with pytest.raises(RuntimeError, match="0xC0000135"):
        asyncio.run(process._connect())
    assert session.attempts == 0
    assert session.closed
    assert process._session is None


@pytest.mark.parametrize("outcome", ["hang", aiohttp.ClientConnectionError("connection refused")])
def test_process_startup_has_total_and_per_attempt_deadlines(monkeypatch, outcome):
    session = MockSession(outcome)
    process = process_fixture(session, monkeypatch)
    with pytest.raises(TimeoutError, match="startup exceeded"):
        asyncio.run(process._connect())
    assert session.attempts > 0
    assert session.closed
    assert process._session is None


def test_successful_process_connection_keeps_session_for_gameplay(monkeypatch):
    websocket = object()
    session = MockSession(websocket)
    process = process_fixture(session, monkeypatch)
    assert asyncio.run(process._connect()) is websocket
    assert process._session is session
    assert not session.closed
    websocket_timeout = session.connect_options[0]["timeout"]
    assert isinstance(websocket_timeout, aiohttp.ClientWSTimeout)
    assert websocket_timeout.ws_receive == 90.0
    assert websocket_timeout.ws_close == 5.0


def test_cancelled_startup_closes_its_session(monkeypatch):
    session = MockSession("hang")
    process = process_fixture(session, monkeypatch)

    async def scenario():
        task = asyncio.create_task(process._connect())
        await asyncio.sleep(.001)
        task.cancel()
        with pytest.raises(asyncio.CancelledError):
            await task

    asyncio.run(scenario())
    assert session.closed
    assert process._session is None


def test_socket_receive_deadline_escapes_protocol_without_cancellation_drain(monkeypatch):
    from sc2.protocol import Protocol
    from s2clientprotocol import sc2api_pb2 as api

    class TimedWebSocket:
        receive_calls = 0

        async def send_bytes(self, payload):
            assert api.Request.FromString(payload).HasField("ping")

        async def receive_bytes(self):
            self.receive_calls += 1
            # Match aiohttp's internal timeout conversion to TimeoutError;
            # no external task cancellation enters burnysc2's drain handler.
            async with asyncio.timeout(self.timeout.ws_receive):
                await asyncio.Event().wait()

    class TimedSession(MockSession):
        async def ws_connect(self, url, **kwargs):
            socket = await super().ws_connect(url, **kwargs)
            socket.timeout = kwargs["timeout"]
            return socket

    socket = TimedWebSocket()
    session = TimedSession(socket)
    process = process_fixture(session, monkeypatch)
    process.websocket_receive_timeout_seconds = .005

    async def scenario():
        connected = await process._connect()
        with pytest.raises(TimeoutError):
            await Protocol(connected)._execute(ping=api.RequestPing())
        assert socket.receive_calls == 1
        await session.close()

    asyncio.run(scenario())
