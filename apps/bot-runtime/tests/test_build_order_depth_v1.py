"""Depth curriculum changes only the declared loss and LR, preserving lineage."""
import copy
import importlib.util
import io
import json
from pathlib import Path
import random
from types import SimpleNamespace

import pytest
import torch

SPEC = importlib.util.spec_from_file_location("depth_trainer", Path(__file__).parents[1] / "scripts/train_build_order_depth_v1.py")
depth = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(depth)


def raw_row(part="train", race="Protoss", names=("TrainProbe", "BuildPylon", "TrainStalker")):
    return {"partition": part, "race": race, "events": [
        {"ability_link": i + 10, "command_index": 0, "decoded_name": name} for i, name in enumerate(names)]}


def test_categories_use_train_protoss_only_and_conflicts_default_one():
    original = raw_row()
    ignored = raw_row("validation", names=("TrainCarrier", "TrainTempest", "ResearchBlink"))
    enemy = raw_row(race="Terran", names=("TrainMarine", "TrainMarauder", "TrainSCV"))
    mapping = depth.training_token_categories([original, ignored, enemy])
    assert [mapping[f"{i}:0"]["weight"] for i in (10, 11, 12)] == [1, 2, 3]
    changed = raw_row(names=("UnknownThing", "BuildPylon", "TrainStalker"))
    conflicting = depth.training_token_categories([original, changed])
    assert conflicting["10:0"]["category"] == "unknown"
    assert conflicting["10:0"]["weight"] == 1
    assert depth.training_token_categories([ignored, enemy]) == {}


@pytest.mark.parametrize("name,category,weight", [
    ("TrainProbe", "worker", 1), ("BuildNexus", "building", 2),
    ("TrainImmortal", "army_production", 3), ("WarpInZealot", "army_production", 3),
    ("ResearchBlink", "research", 2), ("UpgradeGroundWeapons1", "research", 2),
    ("BuildOracleStasisTrap", "other", 1), ("CancelLast", "cancel", 1),
    ("MorphUnknown", "other", 1), (None, "unknown", 1), ("", "unknown", 1)])
def test_bounded_explicit_category_semantics(name, category, weight):
    assert depth.classify_name(name) == category
    assert depth.CATEGORY_WEIGHTS[category] == weight


def test_weighted_ce_analytical_loss_and_gradient_keep_timing_unweighted():
    logits = torch.tensor([[0., .2, 2., -1.], [.3, 0., -1., 1.], [-1., 1., .3, .8]], requires_grad=True)
    waits = torch.tensor([.2, 1., 2.], requires_grad=True)
    targets, wanted = torch.tensor([2, 3, 2]), torch.tensor([.1, .2, .3])
    weights = torch.tensor([1., 2., 3.])
    actual, _, _ = depth.weighted_imitation_loss(logits, waits, targets, wanted, weights)
    manual = (torch.nn.functional.cross_entropy(logits, targets, reduction="none") * weights).sum() / 6
    manual += .1 * torch.nn.functional.smooth_l1_loss(waits, wanted)
    assert torch.equal(actual, manual)
    ga = torch.autograd.grad(actual, (logits, waits), retain_graph=True)
    gm = torch.autograd.grad(manual, (logits, waits), retain_graph=True)
    assert all(torch.equal(a, b) for a, b in zip(ga, gm))
    ones, _, _ = depth.weighted_imitation_loss(logits, waits, targets, wanted, torch.ones(3))
    legacy, _, _ = depth.base.imitation_loss(logits, waits, targets, wanted)
    assert torch.equal(ones, legacy)
    gw = torch.autograd.grad(ones, waits)[0]
    assert torch.equal(ga[1], gw), "Category weighting must not change timing gradients"


@pytest.mark.parametrize("weights", [[0., 1.], [1., 4.], [1., float('nan')], [1.]])
def test_bad_weights_fail_closed(weights):
    with pytest.raises(ValueError):
        depth.weighted_imitation_loss(torch.zeros(2, 4), torch.zeros(2), torch.tensor([2, 3]),
                                      torch.zeros(2), torch.tensor(weights))


def test_unknown_targets_rejected():
    with pytest.raises(ValueError):
        depth.weighted_imitation_loss(torch.zeros(2, 4), torch.zeros(2), torch.tensor([-1, 3]),
                                      torch.zeros(2), torch.ones(2))


def trained_parent():
    torch.manual_seed(47)
    model = depth.base.BuildOrderPrior()
    optimizer = torch.optim.Adam(model.parameters(), lr=.002)
    sum(p.square().sum() for p in model.parameters()).backward()
    optimizer.step()
    return {"parameters": copy.deepcopy(model.state_dict()), "optimizer": copy.deepcopy(optimizer.state_dict()),
            "updates": 1, "python_rng": random.Random(39).getstate(), "torch_rng": torch.get_rng_state()}


def test_exact_restore_and_only_declared_learning_rate_change():
    parent = trained_parent()
    frozen = copy.deepcopy(parent)
    model, optimizer, generator = depth.restore_parent(parent)
    assert depth.exact(model.state_dict(), frozen["parameters"])
    assert depth.exact(optimizer.state_dict(), frozen["optimizer"])
    assert generator.getstate() == parent["python_rng"]
    assert torch.equal(torch.get_rng_state(), parent["torch_rng"])
    depth.change_learning_rate(optimizer)
    depth.verify_depth_optimizer(model, optimizer, 1)
    assert depth.exact(optimizer.state_dict()["state"], frozen["optimizer"]["state"])
    assert optimizer.param_groups[0]["lr"] == .0005
    assert depth.exact(parent, frozen), "The immutable parent object must not be mutated"
    with pytest.raises(ValueError):
        depth.change_learning_rate(optimizer)
    with pytest.raises(ValueError):
        depth.verify_depth_optimizer(model, optimizer, 2)


def test_corrupted_parent_adam_count_fails():
    parent = trained_parent()
    parent["updates"] = 2
    with pytest.raises(ValueError, match="Adam"):
        depth.restore_parent(parent)


def test_parent_bytes_verified_before_torch_deserialization(tmp_path, monkeypatch):
    (tmp_path / "Protoss-best.pt").write_bytes(b"not a checkpoint")
    (tmp_path / "status.json").write_text(json.dumps({"status": "complete", "races": {
        "Protoss": {"best_checkpoint_sha256": depth.PARENT_SHA}}}))
    def prohibited(*args, **kwargs):
        raise AssertionError("Unverified bytes reached torch.load")
    monkeypatch.setattr(torch, "load", prohibited)
    with pytest.raises(ValueError, match="selected"):
        depth.load_selected_parent(tmp_path, {})
    (tmp_path / "STOP").write_text("preserve")
    with pytest.raises(InterruptedError):
        depth.load_selected_parent(tmp_path, {})
    assert (tmp_path / "STOP").read_text() == "preserve"


def test_verified_parent_loaded_from_exact_bytes(tmp_path, monkeypatch):
    buffer = io.BytesIO()
    torch.save({"updates": 3492, "epoch": 11, "example": torch.ones(2)}, buffer)
    blob = buffer.getvalue()
    digest = depth.base.bytes_sha(blob)
    monkeypatch.setattr(depth, "PARENT_SHA", digest)
    (tmp_path / "Protoss-best.pt").write_bytes(blob)
    (tmp_path / "status.json").write_text(json.dumps({"status": "complete", "races": {
        "Protoss": {"best_checkpoint_sha256": digest}}}))
    pins = {}
    loaded, copied = depth.load_selected_parent(tmp_path, pins)
    assert copied == blob and len(pins) == 2 and torch.equal(loaded["example"], torch.ones(2))


@pytest.mark.parametrize("key,value", [("epochs", 4), ("epochs", True), ("wall_seconds", 901),
                                      ("threads", 3), ("horizon_seconds", 481)])
def test_hard_resource_and_horizon_bounds(key, value):
    args = SimpleNamespace(epochs=3, wall_seconds=900, threads=2, horizon_seconds=480)
    setattr(args, key, value)
    with pytest.raises(ValueError):
        depth.require_bounds(args)


def test_stop_prevents_any_run_output(tmp_path):
    dataset, parent, output = tmp_path / "dataset", tmp_path / "parent", tmp_path / "output"
    dataset.mkdir()
    parent.mkdir()
    (parent / "STOP").write_text("keep")
    args = SimpleNamespace(dataset=dataset, parent_run=parent, output=output,
                           epochs=3, wall_seconds=900, threads=2, horizon_seconds=480)
    with pytest.raises(InterruptedError):
        depth.run(args)
    assert not output.exists() and (parent / "STOP").read_text() == "keep"


def test_complete_pass_weights_not_multiplied_by_category():
    rows = [{"replay_id": "a", "player_id": 1, "weight": 1},
            {"replay_id": "b", "player_id": 2, "weight": 2}]
    chosen = depth.base.sample_pass(rows, random.Random(1))
    assert len(chosen) == 3 and sum(r["replay_id"] == "b" for r in chosen) == 2


def test_partial_cursor_records_exact_order_and_next_unprocessed_example():
    row = {"replay_id": "r", "player_id": 1, "commands": [
        {"source_event_index": 90}, {"source_event_index": 92}]}
    cursor = depth.example_cursor([(row, 1), (row, 0), (row, 1)], epoch=2, next_offset=2)
    assert cursor["shuffled_example_identities"] == [["r", 1, 92], ["r", 1, 90], ["r", 1, 92]]
    assert cursor["next_example_offset"] == 2 and not cursor["resume_supported"]
    with pytest.raises(ValueError):
        depth.example_cursor([(row, 0)], epoch=1, next_offset=2)


def test_stop_during_validation_persists_actual_adam_and_cursor(tmp_path, monkeypatch):
    """Synthetic one-batch fixture only; no replay data or production checkpoint."""
    dataset, parent_dir, output = (tmp_path / name for name in ("dataset", "parent", "output"))
    dataset.mkdir()
    parent_dir.mkdir()
    raw = [{"replay_id": rid, "player_id": 1, "race": "Protoss", "matchup": "PvT",
            "partition": part, "training_sampling_weight": 1, "evaluation_weight": 1,
            "events": [{"ability_link": 10, "command_index": 0, "game_loop": i * 20 + 5,
                        "ordinal": i, "decoded_name": "TrainProbe"} for i in range(3)]}
           for rid, part in (("a", "train"), ("b", "validation"))]
    raw += [{**row, "player_id": 2, "race": "Terran", "matchup": "TvP", "events": []}
            for row in list(raw)]
    blob = b"\n".join(json.dumps(row).encode() for row in raw)
    path = dataset / "sequences.jsonl"
    path.write_bytes(blob)
    rows = [depth.base.normalize_record(row, allow_empty=True) for row in raw]
    fixed = {"a": "train", "b": "validation"}
    fingerprints = {"a:1": "one", "b:1": "two", "a:2": "three", "b:2": "four"}
    monkeypatch.setattr(depth, "SEQUENCE_SHA", depth.base.bytes_sha(blob))
    monkeypatch.setattr(depth.base, "load_dataset", lambda _: (rows, fixed, fingerprints, {str(path): depth.base.bytes_sha(blob)}))
    parent = trained_parent()
    parent.update(epoch=11, fixed_partitions=fixed, perspective_hashes=fingerprints, partitions=fixed,
                  vocabulary={"10:0": 2}, schema=depth.base.SCHEMA, race="Protoss",
                  model_contract=depth.base.model_contract(), horizon_seconds=480, native_actor_connected=False)
    buffer = io.BytesIO()
    torch.save(parent, buffer)
    parent_bytes = buffer.getvalue()
    monkeypatch.setattr(depth, "PARENT_SHA", depth.base.bytes_sha(parent_bytes))
    monkeypatch.setattr(depth, "PARENT_UPDATES", 1)
    monkeypatch.setattr(depth, "load_selected_parent", lambda *_: (parent, parent_bytes))
    calls = []
    def evaluate(*args, check, **kwargs):
        calls.append(1)
        if len(calls) == 2:
            (output / "STOP").write_text("test stop")
            check()
        return {"known_target_cross_entropy": 1., "accuracy": 0.}
    monkeypatch.setattr(depth.base, "evaluate", evaluate)
    depth.run(SimpleNamespace(dataset=dataset, parent_run=parent_dir, output=output,
                             epochs=1, wall_seconds=60, threads=1, horizon_seconds=480))
    state = json.loads((output / "status.json").read_bytes())
    assert state["status"] == "stopped_at_bound" and state["actual_optimizer_updates"] == 2
    assert state["races"]["Protoss"]["completed_evaluation_updates"] == 1
    assert state["races"]["Protoss"]["updates"] == 2
    assert state["interrupted_cursor"]["next_example_offset"] == 3
    assert state["interrupted_cursor"]["phase"] == "validation"
    saved = output / state["interrupted_checkpoint"]
    assert depth.base.sha(saved) == state["interrupted_checkpoint_sha256"]
    value = torch.load(io.BytesIO(saved.read_bytes()), map_location="cpu", weights_only=True)
    assert value["interrupted"] and value["updates"] == 2
    assert {float(v["step"]) for v in value["optimizer"]["state"].values()} == {2.}
    assert not (output / "Protoss-epoch001.pt").exists()
    assert (output / "Protoss-parent-exact.pt").read_bytes() == parent_bytes
    assert (output / "STOP").read_text() == "test stop"
