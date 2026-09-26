"""Artificial arrays here are test fixtures, never replay training deliverables."""

from __future__ import annotations

import json
import hashlib
from pathlib import Path

import numpy as np
import pytest
from s2clientprotocol import common_pb2 as common
from s2clientprotocol import raw_pb2 as raw
from s2clientprotocol import sc2api_pb2 as api
from s2clientprotocol import spatial_pb2 as spatial
from sc2.ids.ability_id import AbilityId

from pluto_sc2.contract import model_metadata, validate_metadata
from pluto_sc2.replays import (
    ReplayDataset, ReplayError, _cap_idle, _checkpoint_training_ancestry, _imitation_objective, _matchup_weights, _merge_datasets, _player_name, _preceding_snapshot,
    _project_commands, extract_replays, grouped_split, inspect_replay,
    load_dataset, pretrain, save_dataset, select_player,
)
from pluto_sc2.schema import ACTION_NAMES, ACTION_TO_INDEX, OBSERVATION_SIZE, SCHEMA_VERSION


def dataset(samples=64) -> ReplayDataset:
    observations = np.zeros((samples, OBSERVATION_SIZE), dtype=np.float32)
    observations[:, 0] = np.where(np.arange(samples) % 2, 1, -1)
    labels = np.where(np.arange(samples) % 2, 2, 3).astype(np.int64)
    replay_ids = np.asarray([f"{index // (samples // 4):064x}" for index in range(samples)])
    return ReplayDataset(
        observations, np.ones((samples, len(ACTION_NAMES)), dtype=bool), labels,
        replay_ids, np.arange(samples, dtype=np.int64) * 8, np.arange(samples, dtype=np.int64) * 8 + 1,
        model_metadata(schema_version=SCHEMA_VERSION, source="sc2_replay_observations",
                       expected_start_workers=8, fog_of_war=True, test_fixture=True),
    )


def write_unchecked(path: Path, data: ReplayDataset):
    fields = {name: getattr(data, name) for name in (
        "observations", "masks", "actions", "replay_ids", "game_loops", "action_game_loops"
    )}
    np.savez_compressed(path, **fields, metadata=np.asarray(json.dumps(data.metadata)))


def test_player_selection_requires_explicit_unambiguous_protoss_identity():
    info = {"players": [
        {"player_id": 1, "name": "ReSpOnSe", "race": "Protoss"},
        {"player_id": 2, "name": "Opponent", "race": "Zerg"},
    ]}
    assert select_player(info, player_name="response")["player_id"] == 1
    for kwargs in ({}, {"player_id": 0}, {"player_id": 2}, {"player_name": "missing"},
                   {"player_id": 2, "player_name": "ReSpOnSe"}):
        with pytest.raises(ReplayError):
            select_player(info, **kwargs)
    info["players"].append({"player_id": 3, "name": "response", "race": "Protoss"})
    with pytest.raises(ReplayError, match="exactly one"):
        select_player(info, player_name="response")


def test_clan_markup_does_not_become_part_of_player_identity():
    assert _player_name("&lt;TGosuP&gt;<sp/>ReSpOnSe") == "ReSpOnSe"
    assert _player_name("OrdinaryName") == "OrdinaryName"


def test_stratified_split_holds_out_six_whole_games_per_matchup_without_leakage():
    strata = {f"{i:064x}": ("PvT", "PvP", "PvZ")[i // 30] for i in range(90)}
    ids = np.asarray([replay for i, replay in enumerate(strata) for _ in range(1 + i % 5)])
    train, validation = grouped_split(ids, seed=42, strata=strata)
    assert not set(ids[train]) & set(ids[validation])
    for matchup in ("PvT", "PvP", "PvZ"):
        assert len({replay for replay in ids[validation] if strata[replay] == matchup}) == 6
        assert len({replay for replay in ids[train] if strata[replay] == matchup}) == 24
    np.testing.assert_array_equal(validation, grouped_split(ids, seed=42, strata=strata)[1])
    assert set(ids[validation]) == set(ids[::-1][grouped_split(ids[::-1], seed=42, strata=strata)[1]])


def test_stratified_split_rejects_missing_metadata_and_single_game_matchup():
    ids = np.asarray(["a" * 64, "b" * 64])
    with pytest.raises(ReplayError, match="every replay"):
        grouped_split(ids, strata={ids[0]: "PvT"})
    with pytest.raises(ReplayError, match="at least two"):
        grouped_split(ids, strata={ids[0]: "PvT", ids[1]: "PvP"})


def test_matchup_and_outcome_split_keeps_three_wins_and_losses_per_heldout_matchup():
    strata = {f'{i:064x}': ('PvT', 'PvP', 'PvZ')[i // 30] + '|' + ('Win' if i % 30 < 15 else 'Loss')
              for i in range(90)}
    ids = np.asarray(list(strata))
    train, validation = grouped_split(ids, strata=strata)
    for stratum in set(strata.values()):
        assert sum(strata[replay] == stratum for replay in ids[train]) == 12
        assert sum(strata[replay] == stratum for replay in ids[validation]) == 3
    assert not set(ids[train]) & set(ids[validation])


def test_matchup_weights_equalize_training_mass_without_reading_validation_frequency():
    matchups = np.asarray(["PvT", "PvT", "PvP", "PvZ", "PvZ", "PvZ", "PvP"])
    weights = _matchup_weights(matchups, np.arange(6), True)
    assert weights == {"PvP": 2.0, "PvT": 1.0, "PvZ": pytest.approx(2 / 3)}
    for name in weights:
        assert weights[name] * np.count_nonzero(matchups[:6] == name) == pytest.approx(2)


def test_combined_matchup_gameplay_weight_has_expected_connected_gradient():
    import torch
    from torch.nn import functional as F
    logits = torch.tensor([[1.0, 0.0], [0.2, 0.8], [0.5, -0.5]], requires_grad=True)
    labels = torch.tensor([0, 1, 1])
    lookup = torch.tensor([False, True])
    matchup_weights = torch.tensor([2.0, 1.0, 0.5])
    actual, _, weights = _imitation_objective(logits, labels, lookup, 3.0, matchup_weights)
    expected_weights = torch.tensor([2.0, 3.0, 1.5])
    expected = (F.cross_entropy(logits, labels, reduction="none") * expected_weights).sum() / expected_weights.sum()
    torch.testing.assert_close(weights, expected_weights)
    torch.testing.assert_close(torch.autograd.grad(actual, logits, retain_graph=True)[0],
                               torch.autograd.grad(expected, logits)[0])


def test_roundtrip_and_whole_replay_split(tmp_path):
    path = tmp_path / "records.npz"
    data = dataset()
    save_dataset(path, data)
    loaded = load_dataset(path)
    np.testing.assert_array_equal(loaded.observations, data.observations)
    train, validation = grouped_split(loaded.replay_ids, seed=42)
    assert len(train) + len(validation) == len(data)
    assert not set(loaded.replay_ids[train]) & set(loaded.replay_ids[validation])
    other_train, other_validation = grouped_split(loaded.replay_ids, seed=42)
    np.testing.assert_array_equal(train, other_train)
    np.testing.assert_array_equal(validation, other_validation)
    assert len(_merge_datasets([path, path])) == len(data)


def test_single_replay_never_splits_frames_into_fake_validation():
    ids = np.asarray(["a" * 64] * 20)
    train, validation = grouped_split(ids)
    assert len(train) == 20 and len(validation) == 0
    with pytest.raises(ReplayError):
        grouped_split(ids, validation_fraction=1)


def test_merge_rejects_conflicting_extraction_semantics_and_preserves_sources(tmp_path):
    first, second = dataset(), dataset()
    first.metadata["replays"] = [{"replay_id": "a" * 64, "selected_player": {"player_id": 1}}]
    second.metadata["replays"] = [{"replay_id": "b" * 64, "selected_player": {"player_id": 2}}]
    paths = [tmp_path / "first.npz", tmp_path / "second.npz"]
    save_dataset(paths[0], first)
    save_dataset(paths[1], second)
    assert len(_merge_datasets(paths).metadata["replays"]) == 2
    second.metadata["extractor_version"] = "different-command-alignment"
    save_dataset(paths[1], second)
    with pytest.raises(ReplayError, match="different extraction rules"):
        _merge_datasets(paths)


def test_batch_manifest_rejects_changed_replay_content(tmp_path):
    from scripts.import_replay_batches import validated_entries

    replay = tmp_path / "test-only.SC2Replay"
    replay.write_bytes(b"Original fixture bytes, not a playable replay")
    frozen = validated_entries([{"path": str(replay)}])
    assert len(frozen[0]["sha256"]) == 64
    assert validated_entries(frozen) == frozen
    replay.write_bytes(b"Changed fixture bytes")
    with pytest.raises(ValueError, match="content changed"):
        validated_entries(frozen)


def test_gameplay_loss_weight_changes_gradient_without_weighting_camera_or_idle():
    import torch

    # Three identical inputs conflict: camera, idle, and a gameplay command.
    # Equal weighting is balanced; gameplay emphasis must favor the command.
    logits = torch.zeros(3, requires_grad=True)
    labels = torch.tensor([0, 1, 2])
    gameplay = torch.tensor([False, False, True])
    neutral, _, _ = _imitation_objective(logits.expand(3, -1), labels, gameplay, 1.0)
    neutral.backward()
    torch.testing.assert_close(logits.grad, torch.zeros(3), atol=1e-7, rtol=0)
    logits.grad = None
    weighted, losses, weights = _imitation_objective(logits.expand(3, -1), labels, gameplay, 3.0)
    weighted.backward()
    assert logits.grad[2] < 0 and logits.grad[0] > 0 and logits.grad[1] > 0
    torch.testing.assert_close(weights, torch.tensor([1.0, 1.0, 3.0]))
    torch.testing.assert_close(weighted, (losses * weights).sum() / weights.sum())


@pytest.mark.parametrize("mutation", [
    lambda data: data.observations.__setitem__((0, 0), np.nan),
    lambda data: setattr(data, "observations", data.observations[:, :-1]),
    lambda data: data.actions.__setitem__(0, len(ACTION_NAMES)),
    lambda data: data.actions.__setitem__(0, -1),
    lambda data: data.masks.__setitem__((0, data.actions[0]), False),
    lambda data: setattr(data, "masks", data.masks.astype(np.int64)),
    lambda data: data.action_game_loops.__setitem__(0, data.game_loops[0]),
    lambda data: setattr(data, "replay_ids", data.replay_ids.astype(object)),
    lambda data: data.metadata.__setitem__("schema_version", "old"),
    lambda data: data.metadata.__setitem__("action_names", list(reversed(ACTION_NAMES))),
    lambda data: data.metadata.__setitem__("source", "synthetic"),
    lambda data: data.metadata.__setitem__("expected_start_workers", 12),
    lambda data: data.metadata.__setitem__("fog_of_war", False),
    lambda data: data.metadata.__setitem__("fairplay_version", "unrestricted"),
])
def test_loader_rejects_bad_or_incompatible_arrays(tmp_path, mutation):
    data = dataset()
    mutation(data)
    path = tmp_path / "bad.npz"
    write_unchecked(path, data)
    with pytest.raises(ReplayError):
        load_dataset(path)


def test_loader_rejects_missing_fields_and_non_zip(tmp_path):
    path = tmp_path / "bad.npz"
    np.savez(path, observations=np.zeros((2, 2)))
    with pytest.raises(ReplayError):
        load_dataset(path)
    path.write_text("This is not an NPZ archive")
    with pytest.raises(ReplayError):
        load_dataset(path)


def test_idle_sampling_is_bounded_deterministic_and_preserves_commands():
    idle = ACTION_TO_INDEX["no_op"]
    rows = [(None, None, idle, index) for index in range(100)]
    rows.extend((None, None, 3, index) for index in range(30))
    retained = _cap_idle(rows, 0.25, 7)
    assert len(retained) == 40
    assert sum(row[2] != idle for row in retained) == 30
    assert _cap_idle(rows, 0.25, 7) == retained
    assert _cap_idle(rows[:100], 0.25, 7) == []


def screen():
    return {"camera": (20.0, 20.0), "start": (5.0, 5.0), "enemy_start": (80.0, 80.0),
            "map_size": (100.0, 100.0), "positions": {1: (20.0, 20.0), 10: (22.0, 20.0)},
            "entity_types": {1: "PROBE", 10: "MINERALFIELD"}, "enemy_visible": False}


def command(ability=AbilityId.PROTOSSBUILD_PYLON, loop=9, tags=(1,), **kwargs):
    return api.Action(game_loop=loop, action_raw=raw.ActionRaw(unit_command=raw.ActionRawUnitCommand(
        ability_id=int(getattr(ability, "value", ability)), unit_tags=tags, **kwargs
    )))


def test_commands_are_aligned_to_strictly_earlier_observations():
    response = api.ResponseObservation(actions=[command(loop=8), command(loop=9), command(ability=987654)])
    projected, counts = _project_commands(response, 8, {1: "PROBE"}, [], screen_context=screen())
    assert projected == [(9, ACTION_TO_INDEX["build_pylon"])]
    assert counts["commands_without_prior_observation"] == 1
    assert counts["unsupported_commands"] == 1


def test_same_loop_command_uses_an_earlier_snapshot_instead_of_future_state():
    snapshots = [(0, "first"), (8, "second"), (16, "third")]
    assert _preceding_snapshot(snapshots, 8) == (0, "first")
    assert _preceding_snapshot(snapshots, 9) == (8, "second")
    assert _preceding_snapshot(snapshots, 0) is None


def test_offscreen_producers_and_hidden_targets_are_excluded():
    response = api.ResponseObservation(actions=[
        command(tags=(999,)), command(target_unit_tag=999),
        command(target_world_space_pos=common.Point2D(x=80, y=80)),
    ])
    projected, counts = _project_commands(response, 8, {1: "PROBE"}, [], screen_context=screen())
    assert projected == []
    assert counts["offscreen_producer_commands"] == 1
    assert counts["offscreen_or_hidden_target_commands"] == 2


def test_spatial_commands_require_onscreen_previous_selection_and_action_budget():
    response = api.ResponseObservation(actions=[api.Action(
        game_loop=9, action_feature_layer=spatial.ActionSpatial(
            unit_command=spatial.ActionSpatialUnitCommand(ability_id=AbilityId.PROTOSSBUILD_PYLON.value)
        )
    )])
    projected, counts = _project_commands(response, 8, {1: "PROBE"}, [], screen_context=screen())
    assert projected == [] and counts["offscreen_or_unknown_selection_commands"] == 1
    projected, counts = _project_commands(response, 8, {1: "PROBE"}, ["PROBE"], screen_context=screen(), eligible_actions=set())
    assert projected == [] and counts["actions_over_200_apm"] == 1


def test_mineral_target_and_camera_movement_project_to_distinct_actions():
    response = api.ResponseObservation(actions=[
        command(ability=AbilityId.SMART, target_unit_tag=10),
        api.Action(game_loop=16, action_raw=raw.ActionRaw(camera_move=raw.ActionRawCameraMove(
            center_world_space=common.Point(x=40, y=20)
        ))),
    ])
    projected, counts = _project_commands(response, 8, {1: "PROBE"}, [], screen_context=screen())
    assert projected == [(9, ACTION_TO_INDEX["harvest_minerals"]), (16, ACTION_TO_INDEX["camera_east"])]
    assert counts["projectable_camera_actions"] == 1


def test_ineligible_start_rejected_before_launch_and_output_not_replaced(tmp_path, monkeypatch):
    from pluto_sc2 import replays
    monkeypatch.setattr(replays, "inspect_replay", lambda _: {
        "path": "test.SC2Replay", "players": [{"player_id": 1, "name": "Mine", "race": "Protoss", "starting_workers": 12}]
    })
    async def must_not_launch(*args):
        raise AssertionError("SC2 must not launch for an ineligible replay")
    monkeypatch.setattr(replays, "_extract_one", must_not_launch)
    target = tmp_path / "existing.npz"
    target.write_bytes(b"original")
    with pytest.raises(ReplayError, match="starts with 12 workers"):
        extract_replays(["test.SC2Replay"], target, player_name="Mine")
    assert target.read_bytes() == b"original"


def test_completed_replay_cache_survives_later_failure_and_is_reused(tmp_path, monkeypatch):
    from pluto_sc2 import replays
    calls = []
    def inspect(path):
        return {"path": path, "replay_id": ("a" if path == "first.SC2Replay" else "b") * 64,
                "base_build": 97563, "players": [{"player_id": 1, "name": "Mine", "race": "Protoss", "starting_workers": 8}]}
    async def extract(info, *args):
        calls.append(info["path"])
        if info["path"] == "second.SC2Replay":
            raise ReplayError("Expected fixture failure")
        return [(np.zeros(OBSERVATION_SIZE, dtype=np.float32), np.ones(len(ACTION_NAMES), dtype=bool),
                 ACTION_TO_INDEX["train_probe"], info["replay_id"], 0, 8)], {"starting_workers": 8}
    monkeypatch.setattr(replays, "inspect_replay", inspect)
    monkeypatch.setattr(replays, "_extract_one", extract)
    output = tmp_path / "records.npz"
    with pytest.raises(ReplayError, match="fixture failure"):
        extract_replays(["first.SC2Replay", "second.SC2Replay"], output, player_name="Mine")
    assert not output.exists()
    assert len(list((tmp_path / "replay-cache").glob("*.npz"))) == 1
    result = extract_replays(["first.SC2Replay"], output, player_name="Mine")
    assert calls.count("first.SC2Replay") == 1
    assert result["replays"][0]["cache_hit"] is True
    assert len(load_dataset(output)) == 1


def test_imitation_learns_labels_and_saves_compatible_checkpoint(tmp_path):
    import torch
    from pluto_sc2.learning import load_checkpoint

    previous_threads = torch.get_num_threads()
    torch.set_num_threads(1)
    try:
        path = tmp_path / "test-only-arrays.npz"
        checkpoint_path = tmp_path / "test-only-policy.pt"
        save_dataset(path, dataset(128))
        result = pretrain([path], checkpoint_path, epochs=8, batch_size=32, hidden_dim=16, learning_rate=0.01)
        assert result["history"][-1]["train_loss"] < result["history"][0]["train_loss"]
        assert result["history"][-1]["validation_accuracy"] > 0.9
        assert not set(result["train_replay_ids"]) & set(result["validation_replay_ids"])
        checkpoint = load_checkpoint(checkpoint_path, expected_input_dim=OBSERVATION_SIZE, expected_action_dim=len(ACTION_NAMES))
        validate_metadata(checkpoint["metadata"])
        assert checkpoint["metadata"]["stage"] == "imitation"
    finally:
        torch.set_num_threads(previous_threads)


@pytest.fixture
def imitation_threads():
    import torch

    previous_threads = torch.get_num_threads()
    torch.set_num_threads(1)
    yield
    torch.set_num_threads(previous_threads)


def test_fresh_imitation_records_complete_training_ancestry(tmp_path, imitation_threads):
    from pluto_sc2.learning import load_checkpoint

    path, output = tmp_path / "fixture.npz", tmp_path / "fresh.pt"
    save_dataset(path, dataset(16))
    result = pretrain([path], output, epochs=1, hidden_dim=8, gameplay_loss_weight=3)
    metadata = load_checkpoint(output)["metadata"]
    assert metadata["initialization_checkpoint"] is None
    assert metadata["training_ancestry"] == {
        "version": 1, "known_train_replay_ids": result["train_replay_ids"], "complete": True,
    }
    assert metadata["validation_provenance"]["status"] == "held_out_from_recorded_training"
    assert result["warning"] is None
    assert not set(result["validation_replay_ids"]) & set(metadata["training_ancestry"]["known_train_replay_ids"])


def test_imitation_records_stratified_game_lists_and_unweighted_matchup_metrics(tmp_path, imitation_threads):
    from pluto_sc2.learning import load_checkpoint

    data = dataset(48)
    data.replay_ids = np.asarray([f"{i // 4:064x}" for i in range(48)])
    data.metadata["replays"] = [{
        "replay_id": f"{i:064x}",
        "selected_player": {"player_id": 1, "name": "TestPlayer", "race": "Protoss"},
        "players": [{"player_id": 1, "race": "Protoss"},
                    {"player_id": 2, "race": ("Terran", "Protoss", "Zerg")[i // 4]}],
    } for i in range(12)]
    path, output = tmp_path / "artificial.npz", tmp_path / "artificial.pt"
    save_dataset(path, data)
    result = pretrain([path], output, epochs=2, hidden_dim=8, validation_fraction=.25,
                      stratify_matchups=True, balance_matchups=True, gameplay_loss_weight=3)
    metadata = load_checkpoint(output)["metadata"]
    assert result["replay_split"] == metadata["replay_split"]
    assert metadata["initialization_checkpoint"] is None
    for details in result["replay_split"]["matchups"].values():
        assert len(details["train_replay_ids"]) == 3 and len(details["validation_replay_ids"]) == 1
        assert not set(details["train_replay_ids"]) & set(details["validation_replay_ids"])
    for epoch in result["history"]:
        metrics = epoch["validation_by_matchup"]
        assert set(metrics) == {"PvT", "PvP", "PvZ"}
        assert sum(m["samples"] for m in metrics.values()) == result["validation_samples"]
        assert sum(m["accuracy"] * m["samples"] for m in metrics.values()) / result["validation_samples"] == pytest.approx(epoch["validation_accuracy"])
        assert sum(m["loss"] * m["samples"] for m in metrics.values()) / result["validation_samples"] == pytest.approx(epoch["validation_loss"])


def test_imitation_requires_verified_outcomes_when_requested(tmp_path, imitation_threads):
    data = dataset(16)
    path = tmp_path / 'missing-outcomes.npz'
    save_dataset(path, data)
    with pytest.raises(ReplayError, match='requires matchup'):
        pretrain([path], tmp_path / 'none.pt', epochs=1, stratify_outcomes=True)


@pytest.mark.parametrize("source", ["cumulative", "legacy_direct", "legacy_reference"])
def test_imitation_rejects_prior_training_validation_overlap_before_optimization(tmp_path, monkeypatch, imitation_threads, source):
    import torch
    from pluto_sc2.learning import Policy, save_checkpoint

    data = dataset(16)
    _, validation = grouped_split(data.replay_ids, seed=7)
    prior_id = str(data.replay_ids[validation[0]])
    details = ({"training_ancestry": {"version": 1, "known_train_replay_ids": [prior_id], "complete": True}}
               if source == "cumulative" else {"train_replay_ids": [prior_id]} if source == "legacy_direct"
               else {"reference_source": {"train_replay_ids": [prior_id]}})
    checkpoint, path, output = tmp_path / "prior.pt", tmp_path / "fixture.npz", tmp_path / "preserved.pt"
    save_dataset(path, data)
    save_checkpoint(checkpoint, Policy(OBSERVATION_SIZE, len(ACTION_NAMES), 8), metadata=model_metadata(stage="imitation", **details))
    output.write_bytes(b"Existing checkpoint must survive rejected fine-tuning")

    def must_not_optimize(*args, **kwargs):
        pytest.fail("Optimizer must not be created before overlap rejection")

    monkeypatch.setattr(torch.optim, "Adam", must_not_optimize)
    with pytest.raises(ReplayError, match="Validation replays overlap"):
        pretrain([path], output, resume=checkpoint, epochs=1, seed=7)
    assert output.read_bytes() == b"Existing checkpoint must survive rejected fine-tuning"


def test_imitation_resume_preserves_hash_and_cumulative_ancestry_across_generations(tmp_path, imitation_threads):
    from pluto_sc2.learning import Policy, load_checkpoint, save_checkpoint

    path, initial = tmp_path / "fixture.npz", tmp_path / "initial.pt"
    first, second = tmp_path / "first.pt", tmp_path / "second.pt"
    save_dataset(path, dataset(16))
    save_checkpoint(initial, Policy(OBSERVATION_SIZE, len(ACTION_NAMES), 8), metadata=model_metadata(
        stage="imitation", train_replay_ids=["e" * 64],
        training_ancestry={"version": 1, "known_train_replay_ids": ["f" * 64], "complete": True},
    ))
    result = pretrain([path], first, resume=initial, epochs=1, seed=1)
    metadata = load_checkpoint(first)["metadata"]
    initialization = metadata["initialization_checkpoint"]
    assert initialization["sha256"] == hashlib.sha256(initial.read_bytes()).hexdigest()
    assert initialization["path"] == str(initial.resolve())
    assert initialization["known_prior_train_replay_ids"] == ["e" * 64, "f" * 64]
    expected = sorted(set(result["train_replay_ids"]) | {"e" * 64, "f" * 64})
    assert metadata["training_ancestry"]["known_train_replay_ids"] == expected
    continued = pretrain([path], second, resume=first, epochs=1, seed=1)
    assert continued["initialization_checkpoint"]["sha256"] == hashlib.sha256(first.read_bytes()).hexdigest()
    assert continued["initialization_checkpoint"]["known_prior_train_replay_ids"] == expected
    assert continued["training_ancestry"] == metadata["training_ancestry"]
    assert continued["validation_provenance"]["status"] == "held_out_from_recorded_training"


def test_legacy_imitation_resume_reports_unknown_history_without_losing_known_ids(tmp_path, imitation_threads):
    from pluto_sc2.learning import Policy, load_checkpoint, save_checkpoint

    path, prior, output = tmp_path / "fixture.npz", tmp_path / "legacy.pt", tmp_path / "continued.pt"
    save_dataset(path, dataset(16))
    save_checkpoint(prior, Policy(OBSERVATION_SIZE, len(ACTION_NAMES), 8), metadata=model_metadata(
        stage="imitation", train_replay_ids=["a" * 64],
    ))
    result = pretrain([path], output, resume=prior, epochs=1)
    metadata = load_checkpoint(output)["metadata"]
    assert result["validation_provenance"]["status"] == "prior_training_unknown"
    assert metadata["metrics"]["validation_status"] == "prior_training_unknown"
    assert "do not establish held-out performance" in result["warning"]
    assert metadata["training_ancestry"]["complete"] is False
    known, complete = _checkpoint_training_ancestry(metadata)
    assert "a" * 64 in known and not complete


@pytest.mark.parametrize("details", [
    {"train_replay_ids": "not-a-list"},
    {"training_ancestry": {"version": 1, "known_train_replay_ids": ["invalid"], "complete": True}},
    {"training_ancestry": {"version": 1, "known_train_replay_ids": [], "complete": 1}},
])
def test_malformed_training_ancestry_is_rejected(details):
    with pytest.raises(ReplayError, match="ancestry"):
        _checkpoint_training_ancestry(details)


def test_actual_local_fixture_metadata_and_twelve_worker_rejection(tmp_path):
    fixture = Path("C:/SC2TOOLS/apps/replay-engine/tests/fixtures/replays/warpgate_adept_tracking.SC2Replay")
    if not fixture.is_file():
        pytest.skip("Optional local real replay fixture is unavailable")
    info = inspect_replay(fixture)
    player = select_player(info, player_name="ReSpOnSe")
    assert info["map_name"] == "Tourmaline LE"
    assert info["game_speed"] == "Faster"
    assert info["duration_seconds"] == pytest.approx(info["game_loops"] / 22.4, abs=0.001)
    assert info["duration_seconds"] != info["metadata_duration"]
    assert player["race"] == "Protoss" and player["starting_workers"] == 12
    with pytest.raises(ReplayError, match="starts with 12 workers"):
        extract_replays([fixture], tmp_path / "must-not-exist.npz", player_name="ReSpOnSe")
    assert not (tmp_path / "must-not-exist.npz").exists()
