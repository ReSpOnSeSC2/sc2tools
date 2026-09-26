"""League transaction tests run tiny real PPO updates, with no SC2 processes."""

from collections import Counter
from dataclasses import replace
import json
from pathlib import Path
from types import SimpleNamespace

import numpy as np
import pytest
import torch

from pluto_sc2 import adversary_schema, league
from pluto_sc2.adversary import AdversaryBudget
from pluto_sc2.contract import model_metadata
from pluto_sc2.fairplay import FAIRPLAY_VERSION, FairPlayController
from pluto_sc2.learning import Policy, PPOConfig, load_checkpoint, save_checkpoint
from pluto_sc2.schema import ACTION_NAMES, OBSERVATION_SIZE


@pytest.fixture(autouse=True)
def small_torch_pool():
    previous = torch.get_num_threads()
    torch.set_num_threads(1)
    yield
    torch.set_num_threads(previous)


def weights(policy):
    return {name: value.detach().clone() for name, value in policy.state_dict().items()}


def assert_weights_equal(left, right):
    assert left.keys() == right.keys()
    assert all(torch.equal(left[key], right[key]) for key in left)


@pytest.fixture
def make_league(tmp_path):
    created = 0

    def create(*, bootstrap_adversaries=False):
        nonlocal created
        created += 1
        sources = {}
        for race in league.RACES:
            if race != "Protoss" and not bootstrap_adversaries:
                continue
            if race == "Protoss":
                policy = Policy(OBSERVATION_SIZE, len(ACTION_NAMES), 8)
                metadata = model_metadata(stage="imitation")
            else:
                spec = adversary_schema.get_spec(race)
                policy = Policy(spec.input_dim, spec.action_dim, 8)
                metadata = adversary_schema.metadata(race, stage="imitation")
            path = tmp_path / f"source-{created}-{race}.pt"
            save_checkpoint(path, policy, metadata=metadata,
                            config=PPOConfig(epochs=1, minibatch_size=4, target_kl=None))
            sources[race] = path
        output = tmp_path / f"league-{created}"
        state = league.initialize(output, sources["Protoss"], terran=sources.get("Terran"),
                                  zerg=sources.get("Zerg"), hidden_dim=8, seed=713)
        return output, state, sources

    return create


def episode(policy, race, *, record=True):
    from pluto_sc2.learning import Transition

    observations = [np.full(policy.input_dim, index / 20, dtype=np.float32) for index in range(4)]
    mask = np.zeros(policy.action_dim, dtype=bool)
    mask[:2] = True
    transitions = []
    if record:
        for index, observation in enumerate(observations):
            action, log_prob, value = policy.act(observation, mask)
            terminal = index == len(observations) - 1
            transitions.append(Transition(observation, mask.copy(), action, log_prob, value,
                                          1.0 if terminal else 0.0,
                                          0.0 if terminal else policy.value(observations[index + 1]), terminal, False))
    return SimpleNamespace(policy=policy, error=None, teacher=None, _episode_finished=True,
                           transitions=transitions, fairplay=FairPlayController() if race == "Protoss" else AdversaryBudget(),
                           action_counts=Counter(), rejected_policy_actions=Counter())


class FakeMatch:
    def __init__(self):
        self.calls = []
        self.after = None
        self.mutation = None

    def __call__(self, learner, learner_race, opponent, opponent_race, map_name, **options):
        assert learner is not opponent
        assert not opponent.training
        assert not any(parameter.requires_grad for parameter in opponent.parameters())
        assert all(parameter.requires_grad for parameter in learner.parameters())
        learner_storage = {parameter.data_ptr() for parameter in learner.parameters()}
        assert not learner_storage & {parameter.data_ptr() for parameter in opponent.parameters()}
        call = {"learner_race": learner_race, "opponent_race": opponent_race, "map": map_name,
                "seed": options["seed"], "learner_before": weights(learner),
                "opponent_before": weights(opponent), "opponent": opponent}
        self.calls.append(call)
        bots = [episode(learner, learner_race), episode(opponent, opponent_race, record=False)]
        # Invalid opponent data would make PPO fail if accidentally concatenated.
        bots[1].transitions = [object()]
        if self.mutation:
            self.mutation(bots)
        if self.after:
            self.after()
        return bots, {"results": ["Victory", "Defeat"], "engine_results": ["Victory", "Defeat"],
                      "time_limit_reached": False, "learner_race": learner_race,
                      "opponent_race": opponent_race, "seed": options["seed"]}


def test_reward_activation_is_frozen_per_game_and_saved_with_the_update(make_league):
    from pluto_sc2.replay_targets import VERSION
    from pluto_sc2.rewards import RewardConfig

    output, _, _ = make_league()
    reference = {"replay_id": "train", "source_sha256": "train", "result": "Victory",
                 "matchup": "PvT", "starting_workers": 8,
                 "frames": [{"seconds": 0, "counts": {"PROBE": 8, "NEXUS": 1}}]}
    targets = output / "targets.json"
    league.write_json(targets, {"version": VERSION, "train_replay_ids": ["train"],
                               "validation_replay_ids": ["heldout"], "trajectories": [reference]})
    configuration = output / "reward-config.json"
    league.write_json(configuration, {"schema": 1, "enabled": True, "config": RewardConfig().to_dict(),
        "replay_targets": str(targets), "replay_targets_sha256": league.sha256(targets)})
    fake = FakeMatch()
    profiles = []

    def run(*args, **options):
        profiles.append(options.get("reward_config"))
        if len(profiles) == 1:
            assert options["reward_reference"] == reference
            # Editing during collection only affects the following game.
            league.write_json(configuration, {"schema": 1, "enabled": False})
        return fake(*args, **options)

    state = league.train(output, ["test-map"], games=2, match_runner=run)
    assert profiles == [RewardConfig(), None]
    checkpoint = output / state["snapshots"]["Protoss"][-1]["path"]
    loaded = league._load(checkpoint, "Protoss")
    assert loaded["metadata"]["reward_config"] == RewardConfig().to_dict()
    assert loaded["metadata"]["reward_reference_replay_id"] == "train"
    assert loaded["counters"]["games"] == 1
    record = json.loads((checkpoint.parent / "match.json").read_text())
    viewer = json.loads((checkpoint.parent / "viewer.json").read_text())
    assert record["reward_reference"] == reference
    assert viewer["reward_version"] == RewardConfig().version
    assert state["games"] == 2


def test_initialization_creates_three_separate_valid_profiles_and_optimizers(make_league):
    output, state, _ = make_league()
    assert state["games"] == 0 and state["rating_status"] == "unrated"
    models = {}
    for race in league.RACES:
        entry = state["snapshots"][race][0]
        loaded = league._load(output / entry["path"], race)
        assert loaded["optimizer_state"] is not None
        assert loaded["counters"]["games"] == 0
        models[race] = loaded["policy"]
        assert league.sha256(output / entry["path"]) == entry["sha256"]
        if race == "Protoss":
            assert loaded["metadata"]["fairplay_version"] == FAIRPLAY_VERSION
            assert loaded["metadata"]["max_apm"] == 200
            assert loaded["reference_policy"] is not None
        else:
            assert loaded["metadata"]["camera_restricted"] is False
            assert loaded["metadata"]["max_apm"] == 600
            assert loaded["metadata"]["initialization"] == "random"
    stores = [{parameter.data_ptr() for parameter in model.parameters()} for model in models.values()]
    assert not stores[0] & stores[1] and not stores[0] & stores[2] and not stores[1] & stores[2]


def test_five_game_schedule_updates_only_each_learner_and_balances_main_matchups_across_restart(make_league):
    output, initial, _ = make_league()
    original_hashes = {race: initial["snapshots"][race][0]["sha256"] for race in league.RACES}
    initial_weights = {race: weights(league._load(output / initial["snapshots"][race][0]["path"], race)["policy"])
                       for race in league.RACES}
    matches = FakeMatch()
    halfway = league.train(output, ["fixture-map-A", "fixture-map-B"], games=2, match_runner=matches)
    assert halfway["games"] == 2
    final = league.train(output, ["fixture-map-A", "fixture-map-B"], games=3, match_runner=matches)
    assert [(call["learner_race"], call["opponent_race"]) for call in matches.calls] == list(league.SCHEDULE)
    assert [call["map"] for call in matches.calls] == ["fixture-map-A", "fixture-map-B", "fixture-map-A", "fixture-map-B", "fixture-map-A"]
    assert [call["seed"] for call in matches.calls] == [714, 715, 716, 717, 718]
    assert final["games"] == 5
    assert [final["snapshots"][race][-1]["updates"] for race in league.RACES] == [3, 1, 1]
    assert [len(final["snapshots"][race]) for race in league.RACES] == [4, 2, 2]
    assert all(value["training_games"] == 1 for value in final["matchups"].values())
    for race in league.RACES:
        assert league.sha256(output / initial["snapshots"][race][0]["path"]) == original_hashes[race]
        current = league._load(output / final["snapshots"][race][-1]["path"], race)
        assert any(not torch.equal(initial_weights[race][key], value) for key, value in current["policy"].state_dict().items())
        assert current["optimizer_state"]["state"]  # Actual Adam gradients/steps occurred.
    for call in matches.calls:
        assert_weights_equal(call["opponent_before"], call["opponent"].state_dict())


def test_learner_optimizer_resumes_and_each_race_has_independent_step_count(make_league):
    output, _, _ = make_league(bootstrap_adversaries=True)
    state = league.train(output, ["fixture"], games=5, match_runner=FakeMatch())
    for race, expected in (("Protoss", 3), ("Terran", 1), ("Zerg", 1)):
        loaded = league._load(output / state["snapshots"][race][-1]["path"], race)
        steps = {int(item["step"].item()) for item in loaded["optimizer_state"]["state"].values()}
        assert steps == {expected}
    continued = league.train(output, ["fixture"], games=1, match_runner=FakeMatch())
    current = league._load(output / continued["snapshots"]["Protoss"][-1]["path"], "Protoss")
    assert {int(item["step"].item()) for item in current["optimizer_state"]["state"].values()} == {4}
    assert len(continued["snapshots"]["Terran"]) == len(state["snapshots"]["Terran"])


def test_supplied_replay_bootstrap_anchors_stay_original_for_all_races(make_league):
    output, _, sources = make_league(bootstrap_adversaries=True)
    state = league.train(output, ["fixture"], games=5, match_runner=FakeMatch())
    for race in league.RACES:
        loaded = league._load(output / state["snapshots"][race][-1]["path"], race)
        source = load_checkpoint(sources[race])
        assert loaded["metadata"]["reference_enabled"]
        assert_weights_equal(source["policy"].state_dict(), loaded["reference_policy"].state_dict())
        assert loaded["metadata"]["reference_source"]["checkpoint_sha256"] == league.sha256(sources[race])


@pytest.mark.parametrize("probability,expected", [(.6999, "latest"), (.7, "older"), (.999, "older")])
def test_snapshot_selection_has_exact_latest_history_boundary(monkeypatch, probability, expected):
    history = [{"path": "older"}, {"path": "middle"}, {"path": "latest"}]

    class FixedRandom:
        def __init__(self, seed):
            assert seed == 12

        def random(self):
            return probability

        def choice(self, entries):
            assert entries == history[:-1]
            return entries[0]

    monkeypatch.setattr(league.random, "Random", FixedRandom)
    state = {"games": 0, "seed": 12, "snapshots": {"Terran": history}}
    learner, opponent, selected = league.select_match(state)
    assert (learner, opponent, selected["path"]) == ("Protoss", "Terran", expected)


def test_crash_before_manifest_commit_leaves_orphan_unused_on_resume(make_league, monkeypatch):
    output, initial, _ = make_league()
    manifest = output / "state.json"
    original_manifest = manifest.read_bytes()
    original_write = league.write_json

    def fail_commit(path, content):
        if Path(path) == manifest and content.get("games") == 1:
            raise OSError("Fixture power loss before manifest replace")
        return original_write(path, content)

    matches = FakeMatch()
    monkeypatch.setattr(league, "write_json", fail_commit)
    with pytest.raises(OSError, match="before manifest"):
        league.train(output, ["fixture"], match_runner=matches)
    assert manifest.read_bytes() == original_manifest
    orphan = next((output / "matches").glob("*/learner.pt"))
    assert orphan.is_file() and (orphan.parent / "failure.json").is_file()
    assert load_checkpoint(orphan)["counters"]["games"] == 1
    monkeypatch.setattr(league, "write_json", original_write)
    final = league.train(output, ["fixture"], match_runner=matches)
    assert final["games"] == 1
    assert len(list((output / "matches").glob("*/learner.pt"))) == 2
    assert str(orphan.relative_to(output)) not in {entry["path"] for entries in final["snapshots"].values() for entry in entries}
    assert_weights_equal(matches.calls[0]["learner_before"], matches.calls[1]["learner_before"])
    assert final["snapshots"]["Protoss"][0] == initial["snapshots"]["Protoss"][0]


@pytest.mark.parametrize("fault", ["error", "incomplete", "wrong_policy", "no_boundary", "multiple_episodes", "teacher", "privileged_protoss"])
def test_invalid_game_never_updates_or_commits_league(make_league, fault):
    output, state, _ = make_league()
    manifest = (output / "state.json").read_bytes()
    matches = FakeMatch()

    def corrupt(bots):
        bot = bots[0]
        if fault == "error":
            bot.error = "Fixture game failed"
        elif fault == "incomplete":
            bot._episode_finished = False
        elif fault == "wrong_policy":
            bot.policy = bots[1].policy
        elif fault == "no_boundary":
            bot.transitions[-1] = replace(bot.transitions[-1], terminated=False)
        elif fault == "multiple_episodes":
            bot.transitions[0] = replace(bot.transitions[0], truncated=True)
        elif fault == "teacher":
            bot.teacher = object()
        else:
            bot.fairplay = AdversaryBudget()

    matches.mutation = corrupt
    with pytest.raises(ValueError):
        league.train(output, ["fixture"], match_runner=matches)
    assert (output / "state.json").read_bytes() == manifest
    assert not list((output / "matches").glob("*/learner.pt"))
    assert len(list((output / "matches").glob("*/failure.json"))) == 1
    assert league._state(output)["games"] == state["games"] == 0


@pytest.mark.parametrize("race", ["Protoss", "Terran"])
def test_modified_selected_snapshot_is_rejected_before_game(make_league, race):
    output, state, _ = make_league()
    path = output / state["snapshots"][race][0]["path"]
    path.write_bytes(path.read_bytes() + b"altered fixture")
    matches = FakeMatch()
    with pytest.raises(ValueError, match="checkpoint has changed"):
        league.train(output, ["fixture"], match_runner=matches)
    assert not matches.calls
    assert league._state(output)["games"] == 0


def test_stop_prevents_next_game_but_commits_current_completed_update(make_league):
    output, _, _ = make_league()
    matches = FakeMatch()
    (output / "STOP").write_text("Fixture explicit stop")
    assert league.train(output, ["fixture"], games=5, match_runner=matches)["games"] == 0
    assert not matches.calls
    (output / "STOP").unlink()
    matches.after = lambda: (output / "STOP").write_text("Fixture stop after current match")
    result = league.train(output, ["fixture"], games=5, match_runner=matches)
    assert result["games"] == 1 and len(matches.calls) == 1
    assert result["matchups"]["PvT"]["training_games"] == 1


def test_race_contract_mismatch_is_rejected(make_league):
    output, state, sources = make_league(bootstrap_adversaries=True)
    with pytest.raises(ValueError):
        league._load(sources["Terran"], "Protoss")
    with pytest.raises(ValueError):
        league._load(sources["Zerg"], "Terran")
    with pytest.raises(ValueError, match="max_apm"):
        league._load(output / state["snapshots"]["Terran"][0]["path"], "Terran", max_apm=200)


def test_manifest_checkpoint_paths_cannot_escape_league_folder(make_league):
    output, state, sources = make_league()
    state["snapshots"]["Protoss"][0]["path"] = str(sources["Protoss"])
    (output / "state.json").write_text(json.dumps(state))
    with pytest.raises(ValueError, match="outside"):
        league._state(output)


@pytest.mark.parametrize("corruption", ["games", "seed_type", "seed_range", "apm", "history_length", "update_order", "hash", "matchup_counter", "matchup_keys"])
def test_manifest_schedule_history_and_configuration_corruption_rejected(make_league, corruption):
    output, state, _ = make_league()
    if corruption == "games":
        state["games"] = 1
    elif corruption == "seed_type":
        state["seed"] = True
    elif corruption == "seed_range":
        state["seed"] = 2**32 - 1
    elif corruption == "apm":
        state["adversary_max_apm"] = 0
    elif corruption == "history_length":
        state["snapshots"]["Zerg"].append(state["snapshots"]["Zerg"][0])
    elif corruption == "update_order":
        state["snapshots"]["Terran"][0]["updates"] = 2
    elif corruption == "hash":
        state["snapshots"]["Protoss"][0]["sha256"] = "not-a-checkpoint-hash"
    elif corruption == "matchup_counter":
        state["matchups"]["PvP"]["training_games"] = 1
    else:
        del state["matchups"]["PvZ"]
    (output / "state.json").write_text(json.dumps(state))
    matches = FakeMatch()
    with pytest.raises(ValueError):
        league.train(output, ["fixture"], match_runner=matches)
    assert not matches.calls


def test_checkpoint_counter_mismatch_rejected_even_when_manifest_hash_matches(make_league):
    output, state, _ = make_league()
    entry = state["snapshots"]["Protoss"][0]
    checkpoint_path = output / entry["path"]
    payload = torch.load(checkpoint_path, weights_only=True)
    payload["counters"]["games"] = 1
    torch.save(payload, checkpoint_path)
    entry["sha256"] = league.sha256(checkpoint_path)
    (output / "state.json").write_text(json.dumps(state))
    matches = FakeMatch()
    with pytest.raises(ValueError, match="counter differs"):
        league.train(output, ["fixture"], match_runner=matches)
    assert not matches.calls


def test_optimizer_failure_cannot_commit_changed_in_memory_parameters(make_league, monkeypatch):
    output, state, _ = make_league()
    manifest = (output / "state.json").read_bytes()
    original = league.PPOTrainer.update

    def fail_after_update(trainer, rollout):
        original(trainer, rollout)
        raise RuntimeError("Fixture failure after in-memory optimizer update")

    monkeypatch.setattr(league.PPOTrainer, "update", fail_after_update)
    matches = FakeMatch()
    with pytest.raises(RuntimeError, match="in-memory"):
        league.train(output, ["fixture"], match_runner=matches)
    assert (output / "state.json").read_bytes() == manifest
    assert not list((output / "matches").glob("*/learner.pt"))
    for race in league.RACES:
        entry = state["snapshots"][race][0]
        assert league.sha256(output / entry["path"]) == entry["sha256"]
