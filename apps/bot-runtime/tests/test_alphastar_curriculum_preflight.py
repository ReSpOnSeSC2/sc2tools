import numpy as np
import pytest

from scripts.preflight_alphastar_curriculum import (
    REPLAY, TensorError, dataset_provenance_guard, duplicate_summary,
    label_fingerprint, observation_fingerprint, permitted_exclusion, validate_active_logits,
    validate_checkpoint_root, validate_train_identity,
)


def row(ordinal=1033):
    return {"replay_id": REPLAY, "player_id": 2, "action_ordinal": ordinal,
            "partition": "train", "intent": {"ability_id": 4129}}


def test_only_exact_known_unmapped_events_can_be_excluded():
    error = TensorError("Exact RAW_FUNCTION mapping count 0")
    assert permitted_exclusion(row(), error)
    assert permitted_exclusion(row(1385), error)
    assert not permitted_exclusion(row(1034), error)
    assert not permitted_exclusion({**row(), "player_id": 1}, error)
    assert not permitted_exclusion({**row(), "replay_id": "other"}, error)
    assert not permitted_exclusion({**row(), "intent": {"ability_id": 881}}, error)
    assert not permitted_exclusion(row(), TensorError("Entity overflow: no silent truncation"))
    assert not permitted_exclusion(row(), RuntimeError("Exact RAW_FUNCTION mapping count 0"))


def test_checkpoint_root_and_exact_update_count_are_required():
    checkpoint = {"params": {}, "network_state": {}, "optimizer_state": {}, "optimizer_updates": 2112}
    validate_checkpoint_root(checkpoint, 2112)
    for bad in ({**checkpoint, "unexpected": {}}, {**checkpoint, "optimizer_updates": 1088},
                {**checkpoint, "optimizer_updates": True}):
        with pytest.raises(TensorError, match="checkpoint contents"):
            validate_checkpoint_root(bad, 2112)


def test_nonfinite_forward_logits_block_mask_eligibility():
    outputs = {("logits", "function"): np.array([1., -1e10]), ("logits", "world"): np.array([np.nan])}
    validate_active_logits(outputs, {"function": True, "world": False})
    with pytest.raises(TensorError, match="Nonfinite active-head logits"):
        validate_active_logits(outputs, {"function": True, "world": True})


@pytest.mark.parametrize("partition,manifest_partition,train,validation", [
    ("validation", "train", {REPLAY}, set()),
    ("train", "validation", {REPLAY}, set()),
    ("train", "train", set(), set()),
    ("train", "train", {REPLAY}, {REPLAY}),
])
def test_partition_mismatch_or_leakage_is_rejected(partition, manifest_partition, train, validation):
    with pytest.raises(TensorError, match="partition mismatch"):
        validate_train_identity({**row(), "partition": partition}, {REPLAY: manifest_partition}, train, validation)


def test_exact_dataset_and_split_are_required():
    manifest = {"split_sha256": "split", "replay_partitions": {REPLAY: "train"}, "counts": {"train_samples": 681}}
    hashes = {"samples": "samples"}
    result = {"dataset_hashes": hashes, "split_sha256": "split"}
    split = {"train_replay_ids": [{"replay_id": REPLAY}], "validation_replay_ids": [{"replay_id": "heldout"}]}
    assert dataset_provenance_guard(manifest, hashes, result, split) == ({REPLAY}, {"heldout"})
    with pytest.raises(TensorError, match="immutable dataset"):
        dataset_provenance_guard(manifest, {"samples": "changed"}, result, split)
    with pytest.raises(TensorError, match="681-row"):
        dataset_provenance_guard({**manifest, "counts": {"train_samples": 680}}, hashes, result, split)
    with pytest.raises(TensorError, match="overlap"):
        dataset_provenance_guard(manifest, hashes, result, {**split, "validation_replay_ids": [{"replay_id": REPLAY}]})


def test_observation_fingerprint_rejects_labels_and_preserves_exact_types_shapes():
    inputs = {"step_type": np.array(1, np.int32), ("observation", "units"): np.array([1, 2], np.int32)}
    encoded = {"inputs": inputs, "metadata": {}}
    fingerprint = observation_fingerprint(encoded)
    assert fingerprint == observation_fingerprint({**encoded, "metadata": {"ordinal": 99}})
    assert fingerprint != observation_fingerprint({**encoded, "inputs": {**inputs, ("observation", "units"): np.array([1, 2], np.int64)}})
    assert fingerprint != observation_fingerprint({**encoded, "inputs": {**inputs, ("observation", "units"): np.array([[1, 2]], np.int32)}})
    with pytest.raises(TensorError, match="forbidden"):
        observation_fingerprint({**encoded, "inputs": {**inputs, ("behaviour_features", "action", "function"): np.array(4)}})
    with pytest.raises(TensorError, match="without labels"):
        observation_fingerprint({**encoded, "labels": {"function": 4}})


def test_conflicts_count_only_active_labels_and_report_deterministic_ceiling():
    example = {"labels": {"function": np.array(1), "world": np.array(5)},
               "active_heads": {"function": True, "world": False}}
    same = {**example, "labels": {"function": np.array(1), "world": np.array(99)}}
    different = {**example, "labels": {"function": np.array(2), "world": np.array(99)}}
    assert label_fingerprint(example) == label_fingerprint(same)
    assert label_fingerprint(example) != label_fingerprint(different)
    records = [{"observation_sha256": "a", "label_sha256": label_fingerprint(item)}
               for item in (example, same, different)]
    records.append({"observation_sha256": "b", "label_sha256": "other"})
    audit = duplicate_summary(records)
    assert audit["conflicting_label_groups"] == 1
    assert audit["events_in_conflicting_groups"] == 3
    assert audit["deterministic_full_action_ceiling_count"] == 3
    assert audit["deterministic_full_action_ceiling_fraction"] == .75
