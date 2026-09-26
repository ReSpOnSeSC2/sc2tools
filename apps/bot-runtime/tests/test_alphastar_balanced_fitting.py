"""Fitting guards run without GPU/JAX and without modifying any real checkpoint."""
from collections import Counter
from copy import deepcopy
from types import SimpleNamespace

import numpy as np
import pytest

from scripts.fit_alphastar_balanced import (
    BudgetExhausted, RunGuard, TensorError, balanced_schedule, greedy_summary,
    supervised_mask_scalar, verify_adam_count, verify_resume_recipe, verify_state_dict_schema,
)
from scripts.train_alphastar_replay import HEADS


def test_schedule_equalizes_function_groups_and_rotates_all_gas_examples():
    functions = [2, 2, 2, 2] + list(range(3, 23))
    schedule = balanced_schedule(functions, 1024)
    assert len(schedule) == 1024 and len(set(functions)) == 21
    for prefix in range(1, 1025):
        visited = Counter(functions[index] for index in schedule[:prefix])
        counts = [visited[key] for key in set(functions)]
        assert max(counts) - min(counts) <= 1
    gas_indices = [index for index in schedule if functions[index] == 2]
    assert gas_indices[:12] == [0, 1, 2, 3] * 3
    assert max(Counter(gas_indices).values()) - min(Counter(gas_indices).values()) <= 1


@pytest.mark.parametrize("functions,updates", [([], 1), ([0], 0), ([0], 1025), ([0], True), ([True], 4), ([-1], 4)])
def test_bad_schedule_cannot_exceed_cap_or_lose_identity(functions, updates):
    with pytest.raises(TensorError):
        balanced_schedule(functions, updates)


def test_guard_exact_deadline_blocks_commit_and_stop_takes_priority(tmp_path):
    clock = [10.]
    marker = tmp_path / "STOP"
    guard = RunGuard(15, [marker], clock=lambda: clock[0])
    clock[0] = 24.999
    guard.check("update")
    clock[0] = 25
    with pytest.raises(BudgetExhausted, match="committing"):
        guard.check("committing optimizer")
    marker.write_text("stop")
    with pytest.raises(TensorError, match="STOP"):
        guard.check("update")


@pytest.mark.parametrize("seconds", [0, -1, 901, float("nan"), float("inf")])
def test_wall_budget_is_bounded(seconds):
    with pytest.raises(TensorError):
        RunGuard(seconds, [])


def checkpoint():
    return {"params": {"x": np.ones((2,), np.float32)}, "network_state": {},
            "optimizer_updates": 64, "optimizer_state": {
                "0": {"count": np.asarray(64, np.int32), "mu": {"x": np.ones((2,), np.float32)},
                      "nu": {"x": np.ones((2,), np.float32)}}, "1": {}}}


@pytest.mark.parametrize("change", ["count", "count_dtype", "top_count", "missing_moments", "extra", "nonfinite", "shape", "dtype"])
def test_restore_rejects_adam_reset_missing_moments_and_incompatible_values(change):
    wanted, actual = checkpoint(), checkpoint()
    if change == "count":
        actual["optimizer_state"]["0"]["count"] = np.asarray(0, np.int32)
    elif change == "count_dtype":
        actual["optimizer_state"]["0"]["count"] = np.asarray(64, np.int64)
    elif change == "top_count":
        actual["optimizer_updates"] = 0
    elif change == "missing_moments":
        del actual["optimizer_state"]["0"]["mu"]
    elif change == "extra":
        actual["unproven"] = True
    elif change == "nonfinite":
        actual["optimizer_state"]["0"]["mu"]["x"][0] = np.nan
    elif change == "shape":
        actual["optimizer_state"]["0"]["nu"]["x"] = np.zeros((3,), np.float32)
    else:
        actual["optimizer_state"]["0"]["nu"]["x"] = np.zeros((2,), np.float64)
    with pytest.raises(TensorError):
        verify_adam_count(actual, 64)
        verify_state_dict_schema(wanted, actual)


def test_restore_accepts_all_saved_params_and_both_moment_trees():
    value = checkpoint()
    verify_adam_count(value, 64)
    assert verify_state_dict_schema(value, deepcopy(value)) == 5


def test_resume_recipe_rejects_learning_rate_provenance_and_holdout_updates():
    config = SimpleNamespace(max_entities=128, max_selected=16, world_size=256, minimap_size=64)
    artifacts = {"config": config, "result_sha256": "r", "checkpoint_sha256": "c",
                 "result": {"optimizer_updates": 64, "validation_optimizer_updates": 0,
                            "source_hashes": {"trainer": "hash"}, "dataset_hashes": {"samples": "hash"}}}
    recipe = {"optimizer": "optax.adam", "learning_rate": 1e-4, "seed": 42, "steps": 64,
              "result_sha256": "r", "checkpoint_sha256": "c", "source_hashes": {"trainer": "hash"},
              "dataset_hashes": {"samples": "hash"}, "batch_size": 1, "unroll_length": 1, **vars(config)}
    verify_resume_recipe(artifacts, recipe)
    for change in ({"learning_rate": 1e-3}, {"steps": 63}, {"max_selected": 64}, {"result_sha256": "different"}):
        with pytest.raises(TensorError):
            verify_resume_recipe(artifacts, {**recipe, **change})
    artifacts["result"]["validation_optimizer_updates"] = 1
    with pytest.raises(TensorError):
        verify_resume_recipe(artifacts, recipe)


def test_greedy_evaluation_counts_each_event_once_and_rejects_masked_complete_action():
    def event(correct, source=True, mask=True):
        return {"function": "gas", "mask_checks_passed": mask, "score": {"metrics": {
            "function_exact": correct, "unit_tags_exact_given_correct_function": source}}}
    summary = greedy_summary([event(True), event(True, mask=False), event(False), event(True, source=False)])
    assert summary == {"events": 4, "function_exact": 3, "complete_action_exact": 1,
                       "predicted_functions": {"gas": 4}, "unweighted": True, "held_out": False}


def masked_outputs():
    outputs, labels, active = {}, {}, {}
    for name in HEADS:
        shape = (1, 1, 3) if name == "unit_tags" else (1, 1)
        labels[name] = np.zeros(shape, np.int32)
        outputs["masks", name] = np.ones(shape + (5,), np.bool_)
        outputs["action", name] = labels[name].copy()
        outputs["argument_masks", name] = np.ones((1, 1), np.bool_)
        active[name] = name not in ("delay", "repeat")
    return outputs, labels, active


@pytest.mark.parametrize("change", ["argument", "target", "recurrent_eos", "changed_label"])
def test_jitted_equivalent_scalar_rejects_bad_mask_before_update(change):
    outputs, labels, active = masked_outputs()
    assert supervised_mask_scalar(outputs, labels, active)
    if change == "argument":
        outputs["argument_masks", "function"][:] = False
    elif change == "target":
        outputs["masks", "world"][0, 0, 0] = False
    elif change == "recurrent_eos":
        outputs["masks", "unit_tags"][0, 0, 2, 0] = False
    else:
        outputs["action", "queued"][:] = 1
    assert not supervised_mask_scalar(outputs, labels, active)


def test_scalar_proof_ignores_only_explicitly_inactive_heads():
    outputs, labels, active = masked_outputs()
    outputs["masks", "delay"][:] = False
    outputs["argument_masks", "repeat"][:] = False
    assert supervised_mask_scalar(outputs, labels, active)
