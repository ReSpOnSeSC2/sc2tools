"""Learning-rate migration preserves nonzero history instead of resetting Adam."""
from copy import deepcopy

import pytest
import torch

from scripts.reload_build_order_depth_v2 import (
    APPROVED_LOSS, CATEGORY_WEIGHTS, PARENT_SHA, TEACHER_CONTRACT, exact, independent_categories,
    verify_lr_transition, verify_adam, verify_completed_cursor, verify_recipe,
)


def checkpoint():
    return {"updates": 3492, "epoch": 11, "parameters": {"weight": torch.tensor([[.4]])},
        "vocabulary": {"177:0": 2}, "partitions": {"r": "train"}, "fixed_partitions": {"r": "train"},
        "perspective_hashes": {"r:1": "hash"}, "python_rng": (3, (1, 2), None), "torch_rng": torch.tensor([1, 2], dtype=torch.uint8),
        "optimizer": {"state": {0: {"step": torch.tensor(3492.), "exp_avg": torch.tensor([[.2]]), "exp_avg_sq": torch.tensor([[.1]])}},
            "param_groups": [{"lr": .002, "betas": (.9, .999), "eps": 1e-8, "weight_decay": 0, "amsgrad": False,
                              "maximize": False, "params": [0]}]}}


def migrated():
    value = checkpoint()
    value["optimizer"]["param_groups"][0]["lr"] = .0005
    return value


def test_only_explicit_learning_rate_change_is_allowed():
    parent, initial = checkpoint(), migrated()
    proof = verify_lr_transition(parent, initial)
    assert proof["parameters_exact"] and proof["moments_and_steps_exact"] and proof["rng_exact"]
    assert parent["optimizer"]["param_groups"][0]["lr"] == .002
    assert not exact(torch.tensor(0.), torch.tensor(-0.))


@pytest.mark.parametrize("mutation", [
    lambda x: x["optimizer"]["state"][0]["exp_avg"].zero_(),
    lambda x: x["optimizer"]["state"][0]["step"].zero_(),
    lambda x: x["parameters"]["weight"].add_(1),
    lambda x: x["optimizer"]["param_groups"][0].__setitem__("eps", 1e-6),
    lambda x: x["vocabulary"].__setitem__("177:0", 3),
    lambda x: x["torch_rng"].zero_(),
])
def test_reset_or_schema_drift_cannot_masquerade_as_lr_migration(mutation):
    value = migrated()
    mutation(value)
    with pytest.raises(ValueError):
        verify_lr_transition(checkpoint(), value)


def test_independent_adam_verifier_checks_all_counts_and_moments_without_an_optimizer():
    model = torch.nn.Linear(1, 1, bias=False)
    model.load_state_dict(checkpoint()["parameters"])
    value = migrated()
    assert verify_adam(value, model) == 1
    broken = deepcopy(value)
    broken["optimizer"]["state"][0]["exp_avg_sq"][0, 0] = float("nan")
    with pytest.raises(ValueError):
        verify_adam(broken, model)
    broken = deepcopy(value)
    broken["updates"] += 1
    with pytest.raises(ValueError):
        verify_adam(broken, model)


def test_completed_cursor_binds_order_offsets_and_evaluation_phase():
    row = {"replay_id": "r", "player_id": 2, "commands": [{"source_event_index": 8}, {"source_event_index": 17}]}
    examples = [(row, 1), (row, 0)]
    value = {"interrupted": False, "partial_cursor": {"epoch_in_run": 2, "next_example_offset": 2,
        "phase": "completed_evaluation", "shuffled_example_identities": [["r", 2, 17], ["r", 2, 8]],
        "resume_supported": False}}
    verify_completed_cursor(value, examples, 2)
    for key, changed in (("phase", "validation"), ("next_example_offset", 1),
                         ("shuffled_example_identities", [["r", 2, 8], ["r", 2, 17]])):
        broken = deepcopy(value)
        broken["partial_cursor"][key] = changed
        with pytest.raises(ValueError):
            verify_completed_cursor(broken, examples, 2)


def test_recipe_rejects_weighted_timing_and_extra_updates():
    value = {"learning_rate": .0005, "parent_learning_rate": .002, "parent_checkpoint_sha256": PARENT_SHA,
        "parent_updates": 3492, "schema": "causal-own-command-depth-worker-retention-v2", "category_weights": CATEGORY_WEIGHTS,
        "loss": APPROVED_LOSS, "teacher": TEACHER_CONTRACT, "adam_moments_preserved": True, "horizon_seconds": 480, "max_new_updates": 756,
        "epochs": 2, "threads": 2, "wall_seconds": 900, "ambiguous_unknown_weight": 1, "stasis_trap_weight": 1}
    verify_recipe(value)
    for key, changed in (("loss", "weighted command and timing"), ("max_new_updates", 757), ("teacher", {**TEACHER_CONTRACT, "membership": "validation"}),
                         ("category_weights", {**CATEGORY_WEIGHTS, "unknown": 3})):
        with pytest.raises(ValueError):
            verify_recipe({**value, key: changed})


def test_category_proof_cannot_learn_mapping_from_validation_or_other_race():
    def record(partition, race, names):
        return {"partition": partition, "race": race, "events": [
            {"ability_link": token, "command_index": 0, "decoded_name": name} for token, name in names]}
    rows = [record("train", "Protoss", [(1, "TrainProbe"), (2, "BuildOracleStasisTrap"), (3, "TrainStalker"),
                                       (4, "BuildNexus"), (4, "TrainProbe"), (5, None)]),
            record("validation", "Protoss", [(4, "BuildNexus"), (5, "TrainStalker"), (6, "BuildGateway")]),
            record("train", "Terran", [(7, "TrainMarine")])]
    categories = independent_categories(rows)
    assert set(categories) == {"1:0", "2:0", "3:0", "4:0", "5:0"}
    assert [categories[f"{i}:0"]["weight"] for i in range(1, 6)] == [1, 1, 1.5, 1, 1]
    assert categories["4:0"]["category"] == categories["5:0"]["category"] == "unknown"
