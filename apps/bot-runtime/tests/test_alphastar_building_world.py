"""Head isolation, nonzero inherited Adam moments, and bounded proof gates."""
from copy import deepcopy

import numpy as np
import pytest
import torch

from scripts.fit_alphastar_building_world import (
    MAX_UPDATES, PARENT_SHA256, PARENT_UPDATES, WORLD_MODULES, WORLD_PREFIX,
    TensorError, assemble_world_checkpoint, building_schedule, extract_world_optimizer,
    frozen_state_digest, historical_retention_groups, partition_world, require_placement_proof,
    retention_groups, tree_digest, stage_quality,
)


def saved_checkpoint():
    parameters = {name: {leaf: np.array([[.25, -.1], [.3, .4]], np.float32)
                         for leaf in (("offset", "scale") if "/layer_norm" in name else ("b", "w"))}
                  for name in WORLD_MODULES}
    parameters["official_lite_rich_intent_v1/function_head/linear"] = {
        "w": np.array([[.6, -.2], [.1, .5]], np.float32), "b": np.array([.1, -.05], np.float32)}
    mu = {name: {leaf: np.full_like(value, .075) for leaf, value in values.items()}
          for name, values in parameters.items()}
    nu = {name: {leaf: np.full_like(value, .015) for leaf, value in values.items()}
          for name, values in parameters.items()}
    return {"params": parameters, "network_state": {}, "optimizer_updates": PARENT_UPDATES,
            "optimizer_state": {"0": {"count": np.array(PARENT_UPDATES, np.int32), "mu": mu, "nu": nu}, "1": {}}}


def test_zero_update_subset_restore_reassembles_every_parent_byte_and_keeps_inherited_moments():
    original = saved_checkpoint()
    digest = tree_digest(original)
    world, optimizer = extract_world_optimizer(original)
    assert len(world) == 22 and sum(len(value) for value in world.values()) == 44
    assert int(optimizer["0"]["count"]) == PARENT_UPDATES
    assert all(np.any(value != 0) for branch in ("mu", "nu") for module in optimizer["0"][branch].values() for value in module.values())
    restored = assemble_world_checkpoint(original, world, optimizer, 0)
    assert tree_digest(restored) == digest == tree_digest(original)
    next(iter(world.values()))["w" if "w" in next(iter(world.values())) else "scale"][0, 0] += 1
    assert tree_digest(original) == digest  # Extracted arrays do not alias immutable parent storage.


def test_nonlinear_cpu_gradient_updates_only_world_subtree_with_existing_Adam_history():
    original = saved_checkpoint()
    world, serialized = extract_world_optimizer(original)
    selected = WORLD_PREFIX + "vector_to_visual/linear"
    head = torch.tensor(world[selected]["w"], requires_grad=True)
    frozen = original["params"]["official_lite_rich_intent_v1/function_head/linear"]["w"]
    feature = torch.tensor([[1., 2.], [-1., .5]]) @ torch.from_numpy(frozen)
    optimizer = torch.optim.Adam([head], lr=1e-4, betas=(.9, .999), eps=1e-8)
    optimizer.state[head] = {"step": torch.tensor(float(PARENT_UPDATES)),
                            "exp_avg": torch.from_numpy(serialized["0"]["mu"][selected]["w"].copy()),
                            "exp_avg_sq": torch.from_numpy(serialized["0"]["nu"][selected]["w"].copy())}
    loss = torch.nn.functional.cross_entropy(torch.tanh(feature) @ head, torch.tensor([0, 1]))
    loss.backward()
    assert head.grad.norm() > 0 and torch.isfinite(head.grad).all()
    optimizer.step()
    world[selected]["w"] = head.detach().numpy()
    serialized["0"]["count"] = np.array(PARENT_UPDATES + 1, np.int32)
    serialized["0"]["mu"][selected]["w"] = optimizer.state[head]["exp_avg"].numpy()
    serialized["0"]["nu"][selected]["w"] = optimizer.state[head]["exp_avg_sq"].numpy()
    candidate = assemble_world_checkpoint(original, world, serialized, 1)
    assert tree_digest(candidate["params"][selected]) != tree_digest(original["params"][selected])
    assert frozen_state_digest(candidate) == frozen_state_digest(original)
    assert candidate["optimizer_updates"] == PARENT_UPDATES + 1
    # A full Adam zero-gradient update would still decay inherited frozen mu/nu.
    _, frozen_mu = partition_world(original["optimizer_state"]["0"]["mu"])
    decayed = {name: {leaf: value * .9 for leaf, value in module.items()} for name, module in frozen_mu.items()}
    assert tree_digest(decayed) != tree_digest(frozen_mu)


def test_world_subtree_cannot_inject_an_earlier_head_or_change_namespace():
    original = saved_checkpoint()
    world, optimizer = extract_world_optimizer(original)
    world["official_lite_rich_intent_v1/function_head/linear"] = {"w": np.zeros((2, 2), np.float32)}
    with pytest.raises(TensorError, match="mapping differs"):
        assemble_world_checkpoint(original, world, optimizer, 0)
    original["params"][WORLD_PREFIX + "unexpected/linear"] = {"b": np.zeros(2), "w": np.zeros((2, 2))}
    with pytest.raises(TensorError, match="namespaces"):
        partition_world(original["params"])


@pytest.mark.parametrize("change", [
    lambda p: p["optimizer_state"]["0"].__setitem__("count", np.array(0, np.int32)),
    lambda p: p["optimizer_state"]["0"].__setitem__("mu", {}),
    lambda p: p.__setitem__("network_state", {"moving_average": np.array(1.)}),
])
def test_optimizer_reset_schema_or_mutable_network_state_is_forbidden(change):
    original = saved_checkpoint()
    change(original)
    with pytest.raises(TensorError):
        extract_world_optimizer(original)


def test_frozen_digest_detects_signbit_dtype_shape_and_moment_changes():
    assert tree_digest({"x": np.array(0., np.float32)}) != tree_digest({"x": np.array(-0., np.float32)})
    assert tree_digest({"x": np.array(0., np.float32)}) != tree_digest({"x": np.array([0.], np.float32)})
    original, altered = saved_checkpoint(), saved_checkpoint()
    altered["optimizer_state"]["0"]["mu"]["official_lite_rich_intent_v1/function_head/linear"]["b"][0] += .1
    assert frozen_state_digest(original) != frozen_state_digest(altered)


def metadata():
    names = [(139, "Build_Pylon_pt", ["world"]), (234, "Build_Gateway_pt", ["world"]),
             (518, "Build_Nexus_pt", ["world"]), (593, "Build_CyberneticsCore_pt", ["world"]),
             (692, "Build_Pylon_pt", ["world"]), (700, "Build_Pylon_pt", ["world"]),
             (710, "Build_Assimilator_unit", ["target_unit_tag"]), (711, "raw_move_camera", ["world"]),
             (712, "Move_pt", ["world"]), (713, "Smart_pt", ["world"]), (714, "Attack_Attack_pt", ["world"]),
             (715, "Attack_Attack_unit", ["target_unit_tag"]), (716, "Train_Probe_quick", [])]
    ids = {name: index for index, name in enumerate(sorted({name for _, name, _ in names}))}
    return {("replay", 2, ordinal): {"function": {"id": ids[name], "name": name, "args": args}}
            for ordinal, name, args in names}


def test_building_loss_schedule_excludes_gas_training_camera_move_and_attack_labels():
    rows = metadata()
    scheduled, initial, final = building_schedule(rows)
    assert len(scheduled) == MAX_UPDATES and initial["draws"] == 0 and final["draws"] == 256
    assert {row["identity"][2] for row in scheduled} == {139, 234, 518, 593, 692, 700}
    assert sum(row["role"] == "opening" for row in scheduled) == 179
    assert {row["identity"][2] for row in scheduled if row["role"] == "opening"} == {139, 234, 518, 593, 692}
    first, _, cursor = building_schedule(rows, updates=64)
    assert first == scheduled[:64] and cursor["draws"] == 64 and cursor["opening_draws"] == 45
    groups = retention_groups(rows)
    assert [key[2] for key in groups["camera"]] == [711]
    assert [key[2] for key in groups["move_or_smart_world"]] == [712, 713]
    assert [key[2] for key in groups["attack_world"]] == [714]
    assert sum(map(len, groups.values())) == len(rows)
    for bad in (0, 257, True):
        with pytest.raises(TensorError):
            building_schedule(rows, updates=bad)


def proof():
    return {"schema": "alphastar-building-placement-graph-audit-v1", "status": "passed",
            "checkpoint_sha256": PARENT_SHA256, "adam_count_verified": PARENT_UPDATES,
            "optimizer_updates": 0, "checkpoint_writes": 0, "game_launches": 0,
            "inference_rows": 1201, "teacher_graph_rows": 1201, "inference_mask_passes": 1201,
            "source_inputs_checkpoint_unchanged": True, "changed_inputs": [], "quarantine_identities": [],
            "parity": [{"passed": True}] * 3, "source_and_input_hashes": {"source": "sha"},
            "events": [{"mask_checks_passed": True, "teacher_graph_masks_passed": True}] * 1201}


@pytest.mark.parametrize("key,value", [("status", "running"), ("checkpoint_sha256", "other"),
    ("optimizer_updates", 1), ("inference_rows", 1200), ("quarantine_identities", [["x", 2, 7]]),
    ("source_inputs_checkpoint_unchanged", False), ("parity", [{"passed": False}] * 3)])
def test_zero_update_placement_proof_is_mandatory_and_cannot_silently_quarantine(key, value):
    receipt = proof()
    require_placement_proof(receipt, PARENT_SHA256)
    receipt[key] = value
    with pytest.raises(TensorError):
        require_placement_proof(receipt, PARENT_SHA256)


def test_zero_update_moments_cannot_be_changed_and_counter_must_match_actual_updates():
    original = saved_checkpoint()
    world, optimizer = extract_world_optimizer(original)
    optimizer["0"]["mu"][next(iter(WORLD_MODULES))][next(iter(world[next(iter(WORLD_MODULES))]))] += .1
    with pytest.raises(TensorError, match="Zero-update"):
        assemble_world_checkpoint(original, world, optimizer, 0)
    world, optimizer = extract_world_optimizer(original)
    with pytest.raises(TensorError, match="bias-correction count"):
        assemble_world_checkpoint(original, world, optimizer, 1)
    with pytest.raises(TensorError, match="bounded"):
        assemble_world_checkpoint(original, world, optimizer, 257)


def evaluation():
    return {"events": [{"replay_id": "replay", "player_id": 2, "action_ordinal": ordinal,
        "prediction": {"function": 35, "unit_tags": [1, 512], "world": number * 256 + 5},
        "expert_world_cell": [5, number], "world_grid_error": 0.}
        for number, ordinal in enumerate((139, 234, 518, 593, 692))],
        "groups": {name: {"complete_action_exact": 3} for name in ("camera", "move_or_smart_world", "attack_world")},
        "world_error": {"camera": 4., "move_or_smart_world": 5., "attack_world": 9.}}


def test_retention_detects_shared_world_head_regression_even_when_attack_exact_remains_zero():
    baseline = evaluation()
    candidate = deepcopy(baseline)
    assert stage_quality(baseline, candidate)["retention_gates_passed"]
    baseline["groups"]["attack_world"]["complete_action_exact"] = 0
    candidate["groups"]["attack_world"]["complete_action_exact"] = 0
    candidate["world_error"]["attack_world"] = 10.
    proof = stage_quality(baseline, candidate)
    assert not proof["retention_gates_passed"]
    assert proof["retention_gates"]["attack_world_complete_retained"]
    assert not proof["retention_gates"]["attack_world_world_error_retained"]
    assert not proof["model_promoted"]


def test_opening_collapse_distance_and_earlier_head_changes_are_reported_without_legality_claims():
    baseline, candidate = evaluation(), evaluation()
    candidate["events"][1]["prediction"]["world"] = candidate["events"][0]["prediction"]["world"]
    candidate["events"][1]["world_grid_error"] = 1.
    candidate["events"][4]["prediction"]["function"] = 999
    proof = stage_quality(baseline, candidate)
    assert proof["first_Pylon_Gateway_same_cell"] == {"baseline": False, "candidate": True}
    assert not proof["retention_gates"]["no_new_first_Pylon_Gateway_collapse"]
    assert not proof["retention_gates"]["five_opening_distances_retained"]
    assert not proof["retention_gates"]["earlier_heads_exact"]
    assert not proof["native_placement_legality_claimed"]


def test_historical_cohorts_cannot_drop_duplicate_or_substitute_missing_identities():
    available = [("replay", 2, ordinal) for ordinal in range(1201)]
    groups = historical_retention_groups(available, available[:24], available[:679])
    assert len(groups["original24"]) == 24 and len(groups["original679"]) == 679
    for anchors, original in ((available[:23], available[:679]),
                              (available[:24], available[:678] + [available[0]]),
                              (available[700:724], available[:679]),
                              (available[:24], available[:678] + [("missing", 2, 8)])):
        with pytest.raises(TensorError):
            historical_retention_groups(available, anchors, original)


def test_original_anchor_regression_cannot_be_hidden_by_aggregate_camera_improvement():
    baseline, candidate = evaluation(), evaluation()
    baseline["groups"].update(original24={"complete_action_exact": 16}, original679={"complete_action_exact": 139})
    candidate["groups"].update(original24={"complete_action_exact": 15}, original679={"complete_action_exact": 139})
    candidate["groups"]["camera"]["complete_action_exact"] += 1
    quality = stage_quality(baseline, candidate)
    assert quality["retention_gates"]["camera_complete_retained"]
    assert quality["retention_gates"]["original679_complete_retained"]
    assert not quality["retention_gates"]["original24_complete_retained"]
    assert not quality["retention_gates_passed"]
