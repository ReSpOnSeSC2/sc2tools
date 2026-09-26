"""Teacher collection provenance and actual small-network imitation checks."""
import json
from types import SimpleNamespace

import numpy as np
import pytest
import torch

from pluto_sc2 import bootstrap
from pluto_sc2.adversary import AdversaryBudget
from pluto_sc2.adversary_schema import get_spec, metadata
from pluto_sc2.build_teacher import ReplayBuildTeacher
from pluto_sc2.learning import Policy, load_checkpoint
from pluto_sc2.runner import seed_everything


@pytest.fixture(autouse=True)
def single_thread_torch():
    previous = torch.get_num_threads()
    torch.set_num_threads(1)
    yield
    torch.set_num_threads(previous)


def build(identifier, result="Loss", race="Terran"):
    action = "build_supplydepot" if race == "Terran" else "build_spawningpool"
    order = {"action": action, "game_loop": 448, "game_seconds": 20.0}
    return dict(race=race, replay_id=identifier, user_result=result, bootstrap_weight=2 if result == "Loss" else 1,
                orders=[dict(order), dict(order)], teacher_orders=[dict(order)])


def corpus(path):
    lost, won, validation = build("a" * 64), build("b" * 64, "Win"), build("c" * 64)
    content = dict(format_version=1,
                   protoss_split=dict(train_replay_ids=[lost["replay_id"], won["replay_id"]],
                                      validation_replay_ids=[validation["replay_id"]]),
                   partitions=dict(train=[lost, won], validation=[validation]))
    path.write_text(json.dumps(content))
    return content


def fake_match_runner(calls):
    def run(source, map_name, **kwargs):
        calls.append((source, kwargs))
        spec = get_spec(source["race"])
        accepted_action = spec.action_names.index("build_supplydepot")
        rejected_action = spec.action_names.index("train_scv")
        mask = np.zeros(spec.action_dim, dtype=bool)
        mask[[0, accepted_action, rejected_action]] = True
        decisions = []
        # Nine accepted inputs, four rejected inputs, and ample waiting samples.
        for index, action in enumerate([accepted_action] * 9 + [rejected_action] * 4 + [0] * 40):
            obs = np.zeros(spec.input_dim, dtype=np.float32)
            obs[0] = index / 100
            decisions.append(dict(observation=obs, mask=mask.copy(), action=action,
                                  game_loop=index * 4, teacher=True, accepted=action != rejected_action))
        return SimpleNamespace(decisions=decisions, fairplay=AdversaryBudget()), {"kind": "teacher_rollout"}
    return run


def rewrite_npz(path, **changes):
    with np.load(path, allow_pickle=False) as saved:
        fields = {key: saved[key] for key in saved.files}
    fields.update(changes)
    np.savez_compressed(path, **fields)


def dataset(path, *, partition, identifier, source_digest="1" * 64, weight=2.0):
    spec = get_spec("Terran")
    obs = np.zeros((12, spec.input_dim), dtype=np.float32)
    obs[:, 0] = np.linspace(0, 1, 12)
    masks = np.zeros((12, spec.action_dim), dtype=bool)
    masks[:, :2] = True
    actions = np.ones(12, dtype=np.int64)
    config = dict(schema=1, contract=metadata("Terran"), partition=partition,
                  builds_sha256=source_digest, user_loss_weight=weight,
                  chosen_replay_ids=[identifier])
    np.savez_compressed(path, observations=obs, masks=masks, actions=actions,
                        replay_ids=np.full(12, identifier, dtype="U64"), metadata=np.asarray(json.dumps(config)))
    return config


def test_collection_keeps_only_accepted_labels_caps_idle_and_resumes_verified_episodes(tmp_path):
    source = tmp_path / "builds.json"
    corpus(source)
    calls = []
    output = tmp_path / "collection"
    result = bootstrap.collect(source, "Terran", output, "unused.SC2Map", games=2, seed=7,
                               match_runner=fake_match_runner(calls))
    assert len(calls) == 2
    assert result["user_loss_weight"] == 2
    with np.load(result["dataset"], allow_pickle=False) as saved:
        actions = saved["actions"]
        assert len(actions) == 24
        assert np.count_nonzero(actions == 0) == 6
        assert set(actions) == {0, get_spec("Terran").action_names.index("build_supplydepot")}
        assert set(saved["replay_ids"]) <= {"a" * 64, "b" * 64}
        assert "weights" not in saved.files
        assert all(report["examples"] == 12 for report in result["reports"])
    again = bootstrap.collect(source, "Terran", output, "unused.SC2Map", games=2, seed=7,
                              match_runner=fake_match_runner(calls))
    assert len(calls) == 2
    assert again["dataset_sha256"] == result["dataset_sha256"]


def test_validation_builds_are_distinct_unweighted_and_never_sample_training(tmp_path, monkeypatch):
    source = tmp_path / "builds.json"
    corpus(source)

    def forbidden(*args, **kwargs):
        raise AssertionError("Validation must not use weighted sampling")

    monkeypatch.setattr(bootstrap, "sample_builds", forbidden)
    calls = []
    result = bootstrap.collect(source, "Terran", tmp_path / "validation", "unused.SC2Map",
                               partition="validation", games=1, user_loss_weight=99,
                               match_runner=fake_match_runner(calls))
    assert result["chosen_replay_ids"] == ["c" * 64]
    assert result["user_loss_weight"] == 1.0
    with pytest.raises(ValueError, match="distinct held-out"):
        bootstrap.collect(source, "Terran", tmp_path / "too-many", "unused.SC2Map",
                          partition="validation", games=2, match_runner=forbidden)


def test_collection_detects_changed_episode_data_and_changed_source_corpus(tmp_path):
    source = tmp_path / "builds.json"
    content = corpus(source)
    output = tmp_path / "collection"
    bootstrap.collect(source, "Terran", output, "map", games=1, match_runner=fake_match_runner([]))
    examples = output / "episode-0000" / "examples.npz"
    with examples.open("ab") as stream:
        stream.write(b"tampered")
    with pytest.raises(ValueError, match="episode changed"):
        bootstrap.collect(source, "Terran", output, "map", games=1, match_runner=fake_match_runner([]))
    content["additional_provenance"] = "new artifact"
    source.write_text(json.dumps(content))
    with pytest.raises(ValueError, match="different configuration"):
        bootstrap.collect(source, "Terran", output, "map", games=1, match_runner=fake_match_runner([]))


def test_collection_rejects_changed_partition_report(tmp_path):
    source = tmp_path / "builds.json"
    corpus(source)
    output = tmp_path / "collection"
    bootstrap.collect(source, "Terran", output, "map", games=1, match_runner=fake_match_runner([]))
    path = output / "episode-0000" / "report.json"
    report = json.loads(path.read_text())
    report["partition"] = "validation"
    path.write_text(json.dumps(report))
    with pytest.raises(ValueError):
        bootstrap.collect(source, "Terran", output, "map", games=1, match_runner=fake_match_runner([]))


def test_teacher_uses_tracker_corresponding_orders_once():
    teacher = ReplayBuildTeacher(build("a" * 64))
    assert len(teacher.orders) == 1


@pytest.mark.parametrize("corruption", ["partition", "unknown_replay", "nan", "illegal_action"])
def test_dataset_rejects_wrong_partition_unprovenanced_rows_and_invalid_examples(tmp_path, corruption):
    path = tmp_path / "train.npz"
    config = dataset(path, partition="train", identifier="a" * 64)
    if corruption == "partition":
        config["partition"] = "validation"
        rewrite_npz(path, metadata=np.asarray(json.dumps(config)))
    elif corruption == "unknown_replay":
        rewrite_npz(path, replay_ids=np.full(12, "b" * 64, dtype="U64"))
    elif corruption == "nan":
        bad = np.full((12, get_spec("Terran").input_dim), np.nan, dtype=np.float32)
        rewrite_npz(path, observations=bad)
    else:
        rewrite_npz(path, actions=np.full(12, 2, dtype=np.int64))
    with pytest.raises(ValueError):
        bootstrap._dataset(path, "Terran", "train", 600)


@pytest.mark.parametrize("fault", ["overlap", "corpus_hash"])
def test_fit_rejects_original_replay_leakage_and_different_partition_corpora(tmp_path, fault):
    train, validation = tmp_path / "train.npz", tmp_path / "valid.npz"
    dataset(train, partition="train", identifier="a" * 64)
    dataset(validation, partition="validation", identifier=("a" if fault == "overlap" else "b") * 64,
            source_digest=("2" if fault == "corpus_hash" else "1") * 64)
    with pytest.raises(ValueError, match="overlap|same partitioned"):
        bootstrap.fit(train, validation, "Terran", tmp_path / "model.pt", epochs=1, hidden_dim=8)
    assert not (tmp_path / "model.pt").exists()


def test_actual_bc_updates_weights_and_loss_weight_metadata_is_not_applied_twice(tmp_path):
    train, validation = tmp_path / "train.npz", tmp_path / "valid.npz"
    config = dataset(train, partition="train", identifier="a" * 64, weight=2.0)
    dataset(validation, partition="validation", identifier="b" * 64, weight=1.0)
    output = tmp_path / "model.pt"
    result = bootstrap.fit(train, validation, "Terran", output, epochs=5, batch_size=4, hidden_dim=8, seed=17)
    assert result["train_replay_ids"] == ["a" * 64]
    assert result["validation_replay_ids"] == ["b" * 64]
    assert result["history"][-1]["validation_cross_entropy"] < result["history"][0]["validation_cross_entropy"]
    loaded = load_checkpoint(output)
    assert loaded["metadata"]["source_training_sha256"] == bootstrap._digest(train)
    assert loaded["metadata"]["training_ancestry"]["known_train_replay_ids"] == ["a" * 64]
    assert loaded["metadata"]["user_loss_weight"] == 2.0
    seed_everything(17)
    spec = get_spec("Terran")
    initial = Policy(spec.input_dim, spec.action_dim, 8)
    assert any(not torch.equal(value, initial.state_dict()[key]) for key, value in loaded["policy"].state_dict().items())
    # Identical sampled rows get exactly the same fit: the build-level weighting
    # is provenance, not an extra row-loss multiplier.
    config["user_loss_weight"] = 1.0
    rewrite_npz(train, metadata=np.asarray(json.dumps(config)))
    second = tmp_path / "model-unweighted.pt"
    bootstrap.fit(train, validation, "Terran", second, epochs=5, batch_size=4, hidden_dim=8, seed=17)
    second_model = load_checkpoint(second)["policy"]
    for key, value in loaded["policy"].state_dict().items():
        torch.testing.assert_close(value, second_model.state_dict()[key], rtol=0, atol=0)
