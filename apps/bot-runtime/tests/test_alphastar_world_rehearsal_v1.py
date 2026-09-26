"""Distinct rehearsal sampling, provenance gates, and inherited isolation."""
from copy import deepcopy
from collections import Counter

import pytest

from scripts.fit_alphastar_world_rehearsal_v1 import (
    ALREADY_SPENT, GLOBAL_CEILING, MODE, MAX_UPDATES, PARENT_SHA256, OPENING_WORLD_ORDINALS,
    REHEARSAL_CLASSES, TensorError, mixed_world_schedule, require_objective_proof,
)


def metadata():
    names = [(139, "Build_Pylon_pt", 1), (234, "Build_Gateway_pt", 2), (518, "Build_Nexus_pt", 3),
             (593, "Build_CyberneticsCore_pt", 4), (692, "Build_Pylon_pt", 1),
             (700, "Build_Pylon_pt", 1), (701, "Build_Gateway_pt", 2),
             (710, "raw_move_camera", 5), (711, "raw_move_camera", 5),
             (712, "Move_pt", 6), (713, "Smart_pt", 7), (714, "Attack_Attack_pt", 8),
             (715, "Train_Probe_quick", 9)]
    return {("replay", 2, ordinal): {"function": {"id": number, "name": name,
                                                 "args": [] if name.startswith("Train_") else ["world"]}}
            for ordinal, name, number in names}


def test_sampling_is_distinct_balanced_rehearsal_and_excludes_inactive_world():
    rows = metadata()
    schedule, initial, final = mixed_world_schedule(rows)
    assert len(schedule) == MAX_UPDATES == 128 and initial["draws"] == 0 and final["draws"] == 128
    assert Counter(row["role"] for row in schedule) == {"opening": 64, "rehearsal": 51, "other": 13}
    assert Counter(row["rehearsal_class"] for row in schedule if row["role"] == "rehearsal") == dict.fromkeys(REHEARSAL_CLASSES, 17)
    assert {row["identity"][2] for row in schedule if row["role"] == "opening"} == set(OPENING_WORLD_ORDINALS)
    assert {row["identity"][2] for row in schedule if row["role"] == "other"} == {700, 701}
    assert all(row["identity"][2] != 715 for row in schedule)
    first, _, cursor = mixed_world_schedule(rows, updates=64)
    assert first == schedule[:64] and cursor["draws"] == 64
    assert Counter(row["role"] for row in first) == {"opening": 32, "rehearsal": 26, "other": 6}
    assert final["opening_draws"] == 64 and final["rehearsal_draws"] == 51


def test_original_specialization_spending_is_not_reset_and_missing_rehearsal_fails():
    assert ALREADY_SPENT == 64 and GLOBAL_CEILING == 256 and ALREADY_SPENT + MAX_UPDATES <= GLOBAL_CEILING
    for count in (0, 129, True):
        with pytest.raises(TensorError):
            mixed_world_schedule(metadata(), updates=count)
    rows = metadata()
    del rows["replay", 2, 714]
    with pytest.raises(TensorError, match="nonempty"):
        mixed_world_schedule(rows)


def proof():
    rows = [(ordinal, "opening") for ordinal in OPENING_WORLD_ORDINALS]
    rows.extend(zip((710, 712, 714), REHEARSAL_CLASSES))
    return {"schema": "world-rehearsal-zero-update-proof-v1", "status": "passed", "objective_version": MODE,
        "checkpoint_sha256": PARENT_SHA256, "source_sha256": "source", "source_inputs_checkpoint_unchanged": True,
        "optimizer_updates": 0, "checkpoint_writes": 0, "game_launches": 0, "optimizer_constructed": False,
        "full_checkpoint_state_unchanged": True, "probes": 8, "roles": ["opening", *REHEARSAL_CLASSES],
        "source_and_input_hashes": {"source": "hash"}, "events": [{"identity": ["replay", 2, ordinal], "role": role,
            "masks_passed": True, "gradient_finite": True, "gradient_norm": 1., "world_gradient_matches_full": True}
            for ordinal, role in rows]}


@pytest.mark.parametrize("key,value", [("source_sha256", "different"), ("checkpoint_sha256", "6153"),
    ("optimizer_updates", 1), ("optimizer_constructed", True), ("probes", 7), ("status", "running"),
    ("source_inputs_checkpoint_unchanged", False), ("objective_version", "building-only-old")])
def test_only_exact_zero_update_proof_can_admit_fitting(key, value):
    value_proof = proof()
    require_objective_proof(value_proof, "source")
    value_proof[key] = value
    with pytest.raises(TensorError):
        require_objective_proof(value_proof, "source")


def test_mask_gradient_and_probe_coverage_are_independent_mandatory_gates():
    for key, value in (("masks_passed", False), ("gradient_norm", 0.), ("world_gradient_matches_full", False),
                       ("identity", ["replay", 2, 139])):
        altered = deepcopy(proof())
        altered["events"][-1][key] = value
        with pytest.raises(TensorError):
            require_objective_proof(altered, "source")
