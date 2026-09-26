"""Empty perspectives need pinned receipts and never produce fabricated examples."""
import importlib.util
import json
from pathlib import Path
import random

import pytest

SPEC = importlib.util.spec_from_file_location("build_order_trainer_v2", Path(__file__).parents[1] / "scripts/train_build_order_prior_v2.py")
trainer = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(trainer)


@pytest.fixture
def dataset(tmp_path):
    rows = [dict(replay_id="a", player_id=player, race=race, matchup=matchup, partition="train",
        training_sampling_weight=weight, evaluation_weight=1, extraction_counts={}, events=events)
        for player, race, matchup, weight, events in [
            (1, "Protoss", "PvZ", 1, [dict(ability_link=10, command_index=0, game_loop=50, ordinal=1)]),
            (2, "Zerg", "ZvP", 2, [])]]
    metadata = [{**{k: v for k, v in row.items() if k not in ("events", "extraction_counts")},
                 "start_workers": 8, "perspective": "opponent" if row["player_id"] == 2 else "user", "result": "Win"}
                for row in rows]
    manifest = {"schema": "incremental-own-intention-batch-v1", "perspectives": metadata,
                "fixed_partitions": {"a": "train"}, "selected_original_ids": ["a"]}
    path = tmp_path / "source-manifest.json"
    path.write_text(json.dumps(manifest))
    blob = b"\n".join(json.dumps(row).encode() for row in rows)
    (tmp_path / "sequences.jsonl").write_bytes(blob)
    result = {"schema": "own-macro-attempt-sequences-v1", "status": "complete", "source_unchanged": True,
        "all_originals_unchanged": True, "eligible_for_causal_raw_macro_prior": True,
        "alphastar_training_eligible": False, "errors": [], "sequences_sha256": trainer.bytes_sha(blob),
        "source_manifest": str(path), "source_manifest_sha256": trainer.sha(path),
        "perspectives": 2, "processed_originals": 1, "originals": 1,
        "extraction_contract": "own-macro-attempt-sequences-empty-views-v2", "empty_perspectives": [
            dict(replay_id="a", player_id=2, reason="no_classified_own_macro_attempts", extraction_counts={})]}
    (tmp_path / "result.json").write_text(json.dumps(result))
    return tmp_path


def test_explicit_empty_view_preserves_whole_original_and_produces_zero_examples(dataset):
    rows, partitions, hashes, _ = trainer.load_dataset(dataset)
    assert len(rows) == len(hashes) == 2 and partitions == {"a": "train"}
    assert rows[1]["commands"] == [] and rows[1]["race"] == "Zerg"
    chosen = trainer.sample_pass(rows, random.Random(1))
    assert len(chosen) == 3 and sum(len(row["commands"]) for row in chosen) == 1
    with pytest.raises(ValueError, match="Empty"):
        trainer.require_cohorts(rows, 480)


@pytest.mark.parametrize("change", ["no_receipt", "wrong_identity", "wrong_reason", "wrong_counts", "old_contract", "duplicate"])
def test_empty_view_cannot_be_silently_admitted(dataset, change):
    path = dataset / "result.json"
    result = json.loads(path.read_bytes())
    if change == "no_receipt":
        result["empty_perspectives"] = []
    elif change == "wrong_identity":
        result["empty_perspectives"][0]["player_id"] = 1
    elif change == "wrong_reason":
        result["empty_perspectives"][0]["reason"] = "parse_failed"
    elif change == "wrong_counts":
        result["empty_perspectives"][0]["extraction_counts"] = {"macro_attempts": 1}
    elif change == "old_contract":
        result.pop("extraction_contract")
    else:
        result["empty_perspectives"] *= 2
    path.write_text(json.dumps(result))
    with pytest.raises(ValueError):
        trainer.load_dataset(dataset)


def test_version1_normalization_and_model_contract_remain_exact_for_retained_views(dataset):
    path = Path(__file__).parents[1] / "scripts/train_build_order_prior_v1.py"
    spec = importlib.util.spec_from_file_location("old_prior_contract", path)
    original = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(original)
    row = json.loads((dataset / "sequences.jsonl").read_bytes().splitlines()[0])
    assert trainer.normalize_record(row) == original.normalize_record(row)
    assert trainer.model_contract() == original.model_contract()
    empty = json.loads((dataset / "sequences.jsonl").read_bytes().splitlines()[1])
    with pytest.raises(ValueError, match="Empty"):
        trainer.normalize_record(empty)  # Bypass is inaccessible without the receipt gate.
