"""Opening weighting, exact continuation and fail-closed audit gates; CPU only."""
from collections import Counter
from copy import deepcopy
from pathlib import Path

import pytest

import scripts.fit_alphastar_opening as fit


def curriculum():
    identities = [("replay", 2, index) for index in range(80)]
    return identities, {key: index % 10 for index, key in enumerate(identities)}, identities[:30]


def test_two_stage_sampler_keeps_exact_role_ratio_and_persistent_function_cursors():
    ids, functions, opening = curriculum()
    first, initial, midpoint = fit.opening_schedule(ids, functions, opening)
    saved = deepcopy(midpoint)
    second, resumed, final = fit.opening_schedule(ids, functions, opening, previous=midpoint)
    assert initial["draws"] == 0 and resumed == saved == midpoint and final["draws"] == 2048
    combined = first + second
    assert Counter(item["role"] for item in combined) == {"opening": 1433, "full": 615}
    for start in range(0, 2040, 10):
        assert Counter(item["role"] for item in combined[start:start + 10]) == {"opening": 7, "full": 3}
    for role in ("opening", "full"):
        visits = Counter(item["function_id"] for item in combined if item["role"] == role)
        assert max(visits.values()) - min(visits.values()) <= 1
    assert all(item["identity"] in opening for item in combined if item["role"] == "opening")
    assert second[0]["objective_draw"] == 1024
    with pytest.raises(fit.TensorError, match="2048"):
        fit.opening_schedule(ids, functions, opening, updates=1, previous=final)


def test_arbitrary_stage_partition_preserves_identical_sampling_and_mutates_only_committed_cursor():
    ids, functions, opening = curriculum()
    all_rows, initial, expected = fit.opening_schedule(ids, functions, opening, updates=1024)
    first, _, state = fit.opening_schedule(ids, functions, opening, updates=501)
    second, _, final = fit.opening_schedule(ids, functions, opening, updates=523, previous=state)
    assert all_rows == first + second and final == expected
    committed = deepcopy(initial)
    for item in all_rows:
        fit.commit_sampler(committed, item)
    assert committed == expected and initial["draws"] == 0
    with pytest.raises(fit.TensorError, match="deterministic"):
        fit.commit_sampler(committed, all_rows[-1])


@pytest.mark.parametrize("mutate", [
    lambda s: s.__setitem__("draws", True),
    lambda s: s.__setitem__("objective_id", "old-loss"),
    lambda s: s.__setitem__("draws", s["draws"] - 1),
    lambda s: s["pools"]["opening"].__setitem__("groups_sha256", "different"),
    lambda s: s["pools"]["full"]["group_draws"].__setitem__("0", 0),
])
def test_changed_sampler_cannot_restart_or_reassign_weighting(mutate):
    ids, functions, opening = curriculum()
    _, _, cursor = fit.opening_schedule(ids, functions, opening)
    mutate(cursor)
    with pytest.raises(fit.TensorError):
        fit.opening_schedule(ids, functions, opening, previous=cursor)


def test_opening_milestones_and_context_are_pinned_together():
    ordinals = sorted(set(fit.MILESTONES) | set(range(277)))
    # Two milestones already lie in0..276; add two unique context observations.
    ordinals += [300, 301]
    assert len(ordinals) == 285
    metadata = {(fit.REPLAY, 2, ordinal): {"function": {"name": fit.MILESTONES.get(ordinal, "raw_move_camera")}}
                for ordinal in ordinals}
    metadata[fit.REPLAY, 2, 1]["function"]["name"] = "Smart_unit"
    opening, milestones = fit.opening_identities(metadata)
    assert len(opening) == 285 and [key[2] for key in milestones] == list(fit.MILESTONES)
    metadata[fit.REPLAY, 2, 593]["function"]["name"] = "Train_Probe_quick"
    with pytest.raises(fit.TensorError, match="milestone"):
        fit.opening_identities(metadata)


def passed_audit():
    return {"schema": "alphastar-source-objective-gradient-audit-v1", "status": "passed",
            "normalization_gradient_proof": True, "source_inputs_checkpoint_unchanged": True,
            "optimizer_updates": 0, "checkpoint_writes": 0, "game_launches": 0,
            "matmul_precision": "highest", "objective": fit.objective_contract(64),
            "source_and_input_hashes": {str(Path(__file__).resolve()): "hash"},
            "records": [{"passed": True, "new_source_proof": {"source_count": 1}},
                        {"passed": True, "new_source_proof": {"source_count": 5}},
                        {"passed": True, "inactive_loss_and_gradient_zero": True}]}


@pytest.mark.parametrize("mutate", [
    lambda a: a.__setitem__("status", "running"),
    lambda a: a.__setitem__("normalization_gradient_proof", False),
    lambda a: a.__setitem__("source_inputs_checkpoint_unchanged", False),
    lambda a: a.__setitem__("optimizer_updates", 1),
    lambda a: a.__setitem__("checkpoint_writes", 1),
    lambda a: a.__setitem__("records", a["records"][:2]),
    lambda a: a["records"][1].__setitem__("passed", False),
    lambda a: a["objective"]["weights"].__setitem__("unit_tags", 1),
])
def test_actual_network_audit_is_mandatory_and_cannot_be_replaced_by_analytic_tests(mutate):
    audit = passed_audit()
    assert fit.require_gradient_audit(audit)
    mutate(audit)
    with pytest.raises(fit.TensorError):
        fit.require_gradient_audit(audit)


def base_artifact():
    return {"checkpoint_sha256": fit.BASE_CHECKPOINT, "result_sha256": fit.BASE_RESULT,
            "result": {"diagnostic_mode": "class-balanced-full-game-continuation-v1",
                       "optimizer_updates": fit.BASE_UPDATES, "dataset_hashes": {"x": "pinned"}}}


def test_initial_origin_is_exact5065_and_architecture_unchanged():
    base = base_artifact()
    current, _, previous = fit.require_opening_origin(base, {}, Path.cwd(), "catalog", "audit")
    assert current is base and previous is None
    base["checkpoint_sha256"] = "different"
    with pytest.raises(fit.TensorError, match="exact reviewed5065"):
        fit.require_opening_origin(base, {}, Path.cwd(), "catalog", "audit")


def test_second_stage_requires_same_objective_audit_base_and_optimizer_bound_cursor(monkeypatch):
    base = base_artifact()
    monkeypatch.setattr(fit, "read_checkpoint_artifacts", lambda *args: base)
    ids, functions, opening = curriculum()
    _, _, cursor = fit.opening_schedule(ids, functions, opening)
    result = {**base["result"], "diagnostic_mode": fit.MODE, "objective": fit.objective_contract(64),
              "opening_base_run": str(Path.cwd()), "objective_audit_sha256": "audit",
              "opening_base_checkpoint_sha256": fit.BASE_CHECKPOINT, "opening_base_result_sha256": fit.BASE_RESULT,
              "optimizer_updates": 6089, "sampler_state": cursor, "sampler_state_checkpoint_updates": 6089}
    recipe = {"objective": fit.objective_contract(64), "objective_audit_sha256": "audit", "sampler_state": cursor}
    returned, _, previous = fit.require_opening_origin({"result": result}, recipe, Path.cwd(), "catalog", "audit")
    assert returned is base and previous == cursor
    for field, bad in (("optimizer_updates", 6090), ("objective_audit_sha256", "changed"),
                       ("dataset_hashes", {}), ("opening_base_checkpoint_sha256", "changed")):
        changed = {**result, field: bad}
        with pytest.raises(fit.TensorError):
            fit.require_opening_origin({"result": changed}, recipe, Path.cwd(), "catalog", "audit")
