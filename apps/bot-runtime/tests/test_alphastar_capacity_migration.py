from copy import deepcopy
from dataclasses import asdict

import numpy as np
import pytest

from scripts.migrate_alphastar_capacity import (
    CAPACITY_ADAPTER, DATASET_HASHES, EXCLUSIONS, MASK_EXCLUSIONS, NEW_CONFIG, OLD_CONFIG, REPLAY, SCHEMA,
    SOURCE_SHA256, TensorConfig, TensorError, canonical_prediction,
    exact_state_equal, permitted_capacity_exclusion, require_capacity_preflight,
    capacity_mask_exclusion, diagnose_output_parity, validate_expansion, verify_observation_expansion,
    verify_output_parity, world_target_mask_evidence,
)
from scripts.alphastar_capacity_bridge import (
    CAPACITY_MATMUL_PRECISION, capacity_preserving_pool, build_capacity_bridge, configure_capacity_runtime,
)
from scripts.infer_alphastar_checkpoint import checkpoint_bridge
from scripts.train_alphastar_replay import ROOT, build_official_bridge, sha256


@pytest.mark.parametrize("count", [0, 1, 17, 127, 128, 129, 236, 512])
def test_pool_preserves_old_affine_padding_and_includes_every_extra_entity(count):
    rng = np.random.default_rng(3)
    empty = rng.normal(size=7).astype(np.float32)
    observed = rng.normal(size=(count, 7)).astype(np.float32)
    x = np.tile(empty, (512, 1))
    x[:count] = observed
    mask = np.arange(512) < count
    actual = capacity_preserving_pool(x, mask, empty)
    expected = x[:128].mean(axis=0) if count <= 128 else observed.mean(axis=0)
    np.testing.assert_allclose(actual, expected, rtol=3e-6, atol=3e-6)
    order = rng.permutation(512)
    np.testing.assert_allclose(capacity_preserving_pool(x[order], mask[order], empty), actual, atol=3e-6)


def test_inference_graph_selection_keeps_legacy_and_rejects_unknown_or_unpinned_adapter():
    assert checkpoint_bridge({}) is build_official_bridge
    result = {"capacity_adapter": CAPACITY_ADAPTER, "tensor_config": asdict(NEW_CONFIG),
              "matmul_precision": CAPACITY_MATMUL_PRECISION,
              "source_hashes": {"scripts/alphastar_capacity_bridge.py": sha256(ROOT / "scripts/alphastar_capacity_bridge.py")}}
    assert checkpoint_bridge(result) is build_capacity_bridge
    with pytest.raises(TensorError, match="Unknown"):
        checkpoint_bridge({**result, "capacity_adapter": "future-unknown"})
    with pytest.raises(TensorError, match="inconsistent"):
        checkpoint_bridge({**result, "tensor_config": asdict(OLD_CONFIG)})
    with pytest.raises(TensorError, match="hash differs"):
        checkpoint_bridge({**result, "source_hashes": {}})
    with pytest.raises(TensorError, match="precision contract"):
        checkpoint_bridge({**result, "matmul_precision": None})


def test_capacity_runtime_configures_only_explicit_valid_precision(monkeypatch):
    import sys
    from types import SimpleNamespace
    changes = []
    monkeypatch.setitem(sys.modules, "jax", SimpleNamespace(config=SimpleNamespace(
        update=lambda key, value: changes.append((key, value)))))
    assert configure_capacity_runtime({}) is False
    assert changes == []
    with pytest.raises(TensorError, match="precision contract"):
        configure_capacity_runtime({"capacity_adapter": CAPACITY_ADAPTER})
    with pytest.raises(TensorError, match="Unknown"):
        configure_capacity_runtime({"capacity_adapter": "unknown", "matmul_precision": "highest"})
    assert changes == []
    assert configure_capacity_runtime({"capacity_adapter": CAPACITY_ADAPTER, "matmul_precision": "highest"})
    assert changes == [("jax_default_matmul_precision", "highest")]


def test_only_reviewed_capacity_change_is_accepted():
    validate_expansion(OLD_CONFIG, NEW_CONFIG)
    with pytest.raises(TensorError, match="reviewed"):
        validate_expansion(OLD_CONFIG, TensorConfig(max_entities=256, max_selected=64))


def test_exact_state_restoration_rejects_changed_optimizer_values_and_schema():
    original = {"params": {"w": np.array([1., 2.], np.float32)},
                "optimizer": {"mu": np.array([.1, .2], np.float32), "count": np.array(4041, np.int32)}}
    assert exact_state_equal(original, deepcopy(original))
    changed = deepcopy(original)
    changed["optimizer"]["mu"][1] = .3
    assert not exact_state_equal(original, changed)
    changed["optimizer"]["mu"] = np.array([.1, .2], np.float64)
    with pytest.raises(TensorError, match="dtype"):
        exact_state_equal(original, changed)


def test_all15_exclusions_are_bound_to_identity_ability_and_exact_reason():
    assert len(EXCLUSIONS) == 15
    for key, (ability, reason) in EXCLUSIONS.items():
        row = dict(zip(("replay_id", "player_id", "action_ordinal"), key))
        row["intent"] = {"ability_id": ability}
        assert permitted_capacity_exclusion(row, TensorError(reason))
        assert not permitted_capacity_exclusion(row, RuntimeError(reason))
        assert not permitted_capacity_exclusion(row, TensorError(reason + " changed"))
        assert not permitted_capacity_exclusion({**row, "player_id": 1}, TensorError(reason))


def masked_world_example():
    inputs = {("observation", "camera"): np.zeros((256, 256), np.int32),
              ("observation", "planned_build_mask"): np.zeros((256, 256), np.bool_),
              ("observation", "minimap_visibility_map"): np.zeros((64, 64), np.uint8),
              ("observation", "minimap_buildable"): np.ones((64, 64), np.uint8)}
    return {"active_heads": {"world": True}, "labels": {"world": np.asarray(168 * 256 + 192, np.int32)},
            "inputs": inputs, "metadata": {"function": {
                "name": "Build_Pylon_pt", "planned_build": True, "camera_only_pt": True}}}


@pytest.mark.parametrize("build,camera_only,camera,planned,expected", [
    (True, True, False, False, False), (True, True, True, False, True),
    (True, True, False, True, True), (False, True, False, True, False),
    (False, False, False, False, True), (False, True, True, False, True),
])
def test_cpu_world_mask_matches_camera_planning_and_unrestricted_function_semantics(build, camera_only, camera, planned, expected):
    example = masked_world_example()
    example["metadata"]["function"].update(planned_build=build, camera_only_pt=camera_only)
    example["inputs"]["observation", "camera"][168, 192] = camera
    example["inputs"]["observation", "planned_build_mask"][168, 192] = planned
    assert world_target_mask_evidence(example)["legal"] is expected


def test_mask_exclusion_requires_exact_identity_hashes_and_unchanged_causal_evidence(monkeypatch):
    from scripts import migrate_alphastar_capacity as module
    key, pinned = next(iter(MASK_EXCLUSIONS.items()))
    example = masked_world_example()
    row = dict(zip(("replay_id", "player_id", "action_ordinal"), key))
    row["intent"] = {"ability_id": 881}
    monkeypatch.setattr(module, "observation_fingerprint", lambda _: pinned["observation_sha256"])
    monkeypatch.setattr(module, "label_fingerprint", lambda _: pinned["label_sha256"])
    assert capacity_mask_exclusion(row, example, {}) == {"identity": list(key), **pinned}
    with pytest.raises(TensorError, match="Unreviewed"):
        capacity_mask_exclusion({**row, "action_ordinal": 2087}, example, {})
    with pytest.raises(TensorError, match="changed exclusion"):
        capacity_mask_exclusion({**row, "intent": {"ability_id": 880}}, example, {})
    monkeypatch.setattr(module, "label_fingerprint", lambda _: "changed")
    with pytest.raises(TensorError, match="changed exclusion"):
        capacity_mask_exclusion(row, example, {})
    example["inputs"]["observation", "camera"][168, 192] = 1
    with pytest.raises(TensorError, match="no longer fails"):
        capacity_mask_exclusion(row, example, {})
    assert capacity_mask_exclusion({**row, "action_ordinal": 2087}, example, {}) is None


def observation(n):
    units = np.zeros((n, 48), np.int32)
    units[0, 0] = 3
    return {"inputs": {"step_type": np.array(1, np.int32),
                       ("observation", "raw_units"): units,
                       ("observation", "camera"): np.zeros((256, 256), np.bool_)},
            "metadata": {"entity_tags": [123]}}


def test_observation_expansion_preserves_entity_order_and_never_adds_observed_values():
    a, b = observation(128), observation(512)
    assert verify_observation_expansion(a, b) == ["('observation', 'raw_units')"]
    b["inputs"]["observation", "raw_units"][130, 2] = 1
    with pytest.raises(TensorError, match="padding"):
        verify_observation_expansion(a, b)
    b = observation(512)
    b["metadata"]["entity_tags"] = [456]
    with pytest.raises(TensorError, match="pointer order"):
        verify_observation_expansion(a, b)


def outputs(n, slots):
    source_logits = np.full((1, 1, slots, n + 1), -1e10, np.float32)
    source_masks = np.zeros_like(source_logits, dtype=np.bool_)
    source_logits[..., 0] = 1
    source_logits[..., n] = 2
    source_masks[..., 0] = True
    source_masks[..., n] = True
    actions = np.full((1, 1, slots), n, np.int32)
    actions[..., 0] = 0
    return {("logits", "unit_tags"): source_logits,
            ("masks", "unit_tags"): source_masks, ("action", "unit_tags"): actions}


def test_pointer_parity_remaps_eos_and_checks_only_meaningful_prefix():
    a, b = outputs(128, 16), outputs(512, 64)
    proof = verify_output_parity(a, b, {"unit_tags": True})
    assert proof["unit_tags"]["maximum_absolute_logit_error"] == 0
    b["logits", "unit_tags"][0, 0, 63, 0] = 99
    assert verify_output_parity(a, b, {"unit_tags": True})
    b["masks", "unit_tags"][0, 0, 0, 130] = True
    with pytest.raises(TensorError, match="padded source"):
        verify_output_parity(a, b, {"unit_tags": True})


def test_pointer_parity_rejects_changed_logits_actions_and_missing_eos():
    a, b = outputs(128, 16), outputs(512, 64)
    b["logits", "unit_tags"][0, 0, 0, 0] += 1
    with pytest.raises(TensorError, match="logits"):
        verify_output_parity(a, b, {"unit_tags": True})
    b = outputs(512, 64)
    b["action", "unit_tags"][0, 0, 0] = 1
    with pytest.raises(TensorError, match="action prefix"):
        verify_output_parity(a, b, {"unit_tags": True})
    a["action", "unit_tags"][:] = 0
    with pytest.raises(TensorError, match="termination"):
        verify_output_parity(a, b, {"unit_tags": True})


def test_read_only_diagnostic_reports_failed_strict_logits_without_hiding_actions():
    a, b = outputs(128, 16), outputs(512, 64)
    b["logits", "unit_tags"][0, 0, 0, 0] += .002
    report = diagnose_output_parity(a, b, {"unit_tags": True})["unit_tags"]
    assert report["strict_tolerance_passed"] is False
    assert report["maximum_absolute_logit_error"] > .001
    assert report["maximum_absolute_probability_error"] > 0
    assert report["actions_exact"] and report["legal_masks_exact"]
    b["action", "unit_tags"][0, 0, 0] = 3
    report = diagnose_output_parity(a, b, {"unit_tags": True})["unit_tags"]
    assert report["strict_tolerance_passed"] is False
    assert "action prefix" in report["error"]


def test_canonical_greedy_prediction_excludes_inactive_heads_and_eos_padding():
    registry = [{"id": 0, "args": ["unit_tags", "queued"]}]
    a = {"function": 0, "unit_tags": [2, 128, 128], "queued": 0, "world": 100}
    b = {"function": 0, "unit_tags": [2, 512, 512, 512], "queued": 0, "world": 200}
    assert canonical_prediction(a, registry, OLD_CONFIG) == canonical_prediction(b, registry, NEW_CONFIG)
    with pytest.raises(TensorError, match="after termination"):
        canonical_prediction({**a, "unit_tags": [128, 2]}, registry, OLD_CONFIG)


def fixture_proof():
    records = [{"identity": [REPLAY, 2, i + 3000],
                "function": "Attack_Attack_pt" if i < 20 else "Attack_Attack_unit" if i < 29 else "raw_move_camera",
                "observation_sha256": "a" * 64, "label_sha256": "b" * 64}
               for i in range(1201)]
    proof = {"schema": SCHEMA, "status": "passed", "checkpoint_sha256": SOURCE_SHA256,
             "capacity_adapter": CAPACITY_ADAPTER,
             "matmul_precision": CAPACITY_MATMUL_PRECISION,
             "checkpoint_optimizer_updates": 4041, "dataset_hashes": DATASET_HASHES,
             "tensor_config": asdict(NEW_CONFIG), "split_sha256": "split",
             "optimizer_updates": 0, "new_checkpoint_writes": 0, "checkpoint_copies": 1,
             "failures": [], "supported_rows": 1201, "mask_verified_rows": 1201, "tensor_supported_rows": 1202,
             "source_train_rows": 1217, "source_and_input_hashes": {"pinned": "c" * 64},
             "tensor_records": records,
             "mask_records": [{**row, "verified_unmasked_targets": {"function": 1}} for row in records],
             "known_exclusions": [{"identity": list(key), "ability_id": value[0], "error": value[1]}
                                  for key, value in EXCLUSIONS.items()],
             "known_mask_exclusions": [{"identity": list(key), **value} for key, value in MASK_EXCLUSIONS.items()],
             "original_admitted_identities": [r["identity"] for r in records[:679]],
             "original_anchor_identities": [r["identity"] for r in records[:24]],
             "parity_records": [{}] * 24, "migrated_anchor_teacher_events": [{}] * 24}
    for name in ("eligible_for_broader_training", "all_source_inputs_unchanged", "parameter_values_exact",
                 "optimizer_moments_exact", "optimizer_count_restored", "exact_parameter_schema", "observation_parity_verified"):
        proof[name] = True
    artifacts = {"checkpoint_sha256": SOURCE_SHA256,
                 "result": {"optimizer_updates": 4041, "tensor_config": asdict(NEW_CONFIG),
                            "matmul_precision": CAPACITY_MATMUL_PRECISION,
                            "split_sha256": "split", "capacity_adapter": CAPACITY_ADAPTER}}
    return proof, artifacts


def test_admission_helper_requires_complete_graph_proof_and_exact_omissions():
    proof, artifacts = fixture_proof()
    assert len(require_capacity_preflight(proof, artifacts, DATASET_HASHES)) == 1201
    changed = deepcopy(proof)
    changed["mask_records"][0]["observation_sha256"] = "changed"
    with pytest.raises(TensorError, match="fingerprints"):
        require_capacity_preflight(changed, artifacts, DATASET_HASHES)
    changed = deepcopy(proof)
    changed["known_exclusions"][0]["error"] = "different"
    with pytest.raises(TensorError, match="exclusions"):
        require_capacity_preflight(changed, artifacts, DATASET_HASHES)
    changed = deepcopy(proof)
    changed["known_mask_exclusions"][0]["mask_evidence"]["minimap_visibility"] = 2
    with pytest.raises(TensorError, match="mask exclusions"):
        require_capacity_preflight(changed, artifacts, DATASET_HASHES)
    changed = deepcopy(proof)
    changed["optimizer_moments_exact"] = False
    with pytest.raises(TensorError, match="provenance"):
        require_capacity_preflight(changed, artifacts, DATASET_HASHES)
