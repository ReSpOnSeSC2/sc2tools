"""Dataset/restore boundaries and complete weighted passes for the macro prior."""
import copy
import importlib.util
import io
import json
from pathlib import Path
import random

import pytest
import torch

SPEC = importlib.util.spec_from_file_location("build_order_trainer", Path(__file__).parents[1] / "scripts/train_build_order_prior_v1.py")
trainer = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(trainer)


def record(rid="a", player=1, race="Protoss", matchup="PvT", part="train", weight=1):
    return dict(replay_id=rid, player_id=player, race=race, matchup=matchup, partition=part,
        training_sampling_weight=weight, evaluation_weight=1,
        events=[dict(ability_link=10 + i, command_index=0, game_loop=20 * i + 10, ordinal=i) for i in range(3)])


@pytest.fixture
def dataset(tmp_path):
    rows = [record(), record(player=2, race="Terran", matchup="TvP", weight=2)]
    metadata = [{**{key: row[key] for key in row if key != "events"}, "start_workers": 8,
                 "perspective": "opponent" if row["player_id"] == 2 else "user", "result": "Win"} for row in rows]
    manifest = {"schema": "incremental-own-intention-batch-v1", "perspectives": metadata,
                "fixed_partitions": {"a": "train"}, "selected_original_ids": ["a"]}
    path = tmp_path / "source-manifest.json"
    path.write_text(json.dumps(manifest))
    seq = b"\n".join(json.dumps(row).encode() for row in rows)
    (tmp_path / "sequences.jsonl").write_bytes(seq)
    receipt = {"schema": "own-macro-attempt-sequences-v1", "status": "complete", "source_unchanged": True,
        "all_originals_unchanged": True, "eligible_for_causal_raw_macro_prior": True,
        "alphastar_training_eligible": False, "errors": [], "sequences_sha256": trainer.bytes_sha(seq),
        "source_manifest": str(path), "source_manifest_sha256": trainer.sha(path),
        "perspectives": 2, "processed_originals": 1, "originals": 1}
    (tmp_path / "result.json").write_text(json.dumps(receipt))
    return tmp_path


def test_same_parsed_sequence_bytes_and_receipt_manifest_are_bound(dataset):
    records, partitions, hashes, inputs = trainer.load_dataset(dataset)
    assert len(records) == len(hashes) == 2 and partitions == {"a": "train"}
    assert inputs[str(dataset / "sequences.jsonl")] == trainer.sha(dataset / "sequences.jsonl")


@pytest.mark.parametrize("target", ["sequences.jsonl", "source-manifest.json"])
def test_modified_sequence_or_manifest_is_rejected(dataset, target):
    with (dataset / target).open("ab") as stream:
        stream.write(b" ")
    with pytest.raises(ValueError):
        trainer.load_dataset(dataset)


@pytest.mark.parametrize("field,value", [("race", "Zerg"), ("partition", "validation"),
    ("training_sampling_weight", 2), ("evaluation_weight", 2), ("matchup", "TvZ")])
def test_even_rehashed_sequences_cannot_change_manifest_metadata(dataset, field, value):
    rows = [json.loads(line) for line in (dataset / "sequences.jsonl").read_bytes().splitlines()]
    rows[0][field] = value
    blob = b"\n".join(json.dumps(row).encode() for row in rows)
    (dataset / "sequences.jsonl").write_bytes(blob)
    result = json.loads((dataset / "result.json").read_bytes())
    result["sequences_sha256"] = trainer.bytes_sha(blob)
    (dataset / "result.json").write_text(json.dumps(result))
    with pytest.raises(ValueError):
        trainer.load_dataset(dataset)


@pytest.mark.parametrize("horizon", [0, -1, 7201, True])
def test_invalid_horizon_rejected(horizon):
    with pytest.raises(ValueError):
        trainer.require_cohorts([], horizon)


def test_empty_horizon_cohort_rejected():
    with pytest.raises(ValueError, match="Empty"):
        trainer.require_cohorts([trainer.normalize_record(record())], 480)


def test_complete_pass_contains_every_perspective_with_exact_once_or_twice_exposure():
    rows = [trainer.normalize_record(record()), trainer.normalize_record(record(player=2, weight=2))]
    chosen = trainer.sample_pass(rows, random.Random(7))
    assert sorted(row["player_id"] for row in chosen) == [1, 2, 2]
    assert sum(row["player_id"] == 1 for row in chosen) == 1


def test_repeat_last_uses_previous_loop_and_exposes_nonrepeat_commands():
    row = trainer.normalize_record(record())
    row["commands"][1].update(ability_link=10, game_loop=10)
    row["commands"][2].update(ability_link=10)
    assert trainer.repeat_last(row, 0) is False
    assert trainer.repeat_last(row, 1) is False  # Same-loop sibling is not a causal baseline.
    assert trainer.repeat_last(row, 2) is True


def parent():
    return dict(schema=trainer.SCHEMA, race="Protoss", model_contract=trainer.model_contract(),
                horizon_seconds=480, native_actor_connected=False, updates=0,
                partitions={"a": "train"}, fixed_partitions={"a": "train", "v": "validation"},
                perspective_hashes={"a:1": "h1", "a:2": "h2"})


def validate_parent(value):
    trainer.validate_parent(value, race="Protoss", horizon=480,
        partitions={"a": "train", "b": "train"}, fixed_partitions={"a": "train", "v": "validation", "b": "train"},
        perspective_hashes={"a:1": "h1", "a:2": "h2", "b:1": "h3", "b:2": "h4"})


def test_incremental_parent_retains_all_original_content_and_fixed_holdouts():
    validate_parent(parent())


@pytest.mark.parametrize("field,value", [("horizon_seconds", 600), ("model_contract", {}),
    ("partitions", {"a": "validation"}), ("fixed_partitions", {"v": "train"}),
    ("perspective_hashes", {"a:1": "changed", "a:2": "h2"})])
def test_resume_contract_drift_rejected(field, value):
    data = parent()
    data[field] = value
    with pytest.raises(ValueError):
        validate_parent(data)


def test_checkpoint_loaded_weights_only_from_verified_bytes_and_stop_obeyed(tmp_path):
    blob = io.BytesIO()
    torch.save({"schema": trainer.SCHEMA, "example": torch.zeros(2), "python_rng": random.Random(1).getstate()}, blob)
    raw = blob.getvalue()
    (tmp_path / "Protoss-last.pt").write_bytes(raw)
    (tmp_path / "status.json").write_text(json.dumps({"status": "complete", "races": {
        "Protoss": {"last_checkpoint_sha256": trainer.bytes_sha(raw)}}}))
    pins = {}
    result = trainer.load_parent(tmp_path, "Protoss", pins)
    assert torch.equal(result["example"], torch.zeros(2)) and len(pins) == 2
    (tmp_path / "STOP").write_text("keep")
    with pytest.raises(InterruptedError):
        trainer.load_parent(tmp_path, "Protoss", pins)
    assert (tmp_path / "STOP").read_text() == "keep"


def test_adam_counts_and_moments_are_verified():
    model = trainer.BuildOrderPrior()
    optimizer = torch.optim.Adam(model.parameters(), lr=.002)
    sum(parameter.sum() for parameter in model.parameters()).backward()
    optimizer.step()
    trainer.verify_optimizer(model, optimizer, 1)
    with pytest.raises(ValueError, match="Adam"):
        trainer.verify_optimizer(model, optimizer, 2)
    saved = copy.deepcopy(optimizer.state_dict())
    next(iter(saved["state"].values()))["exp_avg"] = torch.ones(1)
    optimizer.load_state_dict(saved)
    with pytest.raises(ValueError, match="Adam"):
        trainer.verify_optimizer(model, optimizer, 1)
