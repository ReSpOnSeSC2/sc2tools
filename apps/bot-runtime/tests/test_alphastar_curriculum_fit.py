import copy
from collections import Counter

import pytest

from scripts.fit_alphastar_curriculum import (
    ALLOWED_EXCLUSIONS, EXCLUSION_ERROR, TensorError, curriculum_schedule,
    group_metrics, original_anchor_teacher_events, require_preflight,
)


def curriculum():
    ids = [("replay", 2, ordinal) for ordinal in range(679)]
    anchors = ids[:24]
    functions = list(range(21)) + [4, 4, 4]
    return ids, anchors, functions


def test_complete_epoch_and_balanced_anchors_fit_bounded_schedule():
    ids, anchors, functions = curriculum()
    schedule = curriculum_schedule(ids, anchors, functions)
    assert len(schedule) == 905
    broad = [row["identity"] for row in schedule if row["role"] == "broad"]
    rehearsal = [row["identity"] for row in schedule if row["role"] == "anchor"]
    assert len(broad) == len(set(broad)) == 679 and set(broad) == set(ids)
    assert len(rehearsal) == 226 and set(rehearsal) <= set(anchors)
    by_function = Counter(functions[anchors.index(row)] for row in rehearsal)
    assert max(by_function.values()) - min(by_function.values()) <= 1
    assert schedule == curriculum_schedule(ids, anchors, functions)
    assert schedule != curriculum_schedule(ids, anchors, functions, seed=43)
    assert all(row["role"] == "anchor" for row in schedule[3:904:4])


def test_partial_or_duplicate_curriculum_cannot_pass_schedule():
    ids, anchors, functions = curriculum()
    for bad_ids, bad_anchors, bad_functions in (
            (ids[:-1], anchors, functions), (ids[:-1] + [ids[0]], anchors, functions),
            (ids, anchors[:-1] + [anchors[0]], functions), (ids, anchors, functions[:-1])):
        with pytest.raises(TensorError, match="Require exact679"):
            curriculum_schedule(bad_ids, bad_anchors, bad_functions)
    with pytest.raises(TensorError, match="cannot cover"):
        curriculum_schedule(ids, anchors, functions, max_updates=904)
    with pytest.raises(TensorError, match="Require exact679"):
        curriculum_schedule(ids, anchors, functions, max_updates=1025)


def passed_preflight():
    hashes = {"samples": "samples", "manifest": "manifest", "game_data": "catalog"}
    artifacts = {"checkpoint_sha256": "checkpoint", "result": {
        "optimizer_updates": 2112, "tensor_config": {"max_entities": 128}, "split_sha256": "split"}}
    records = [{"identity": ["replay", 2, index], "function": "Smart_pt",
                "observation_sha256": "a" * 64, "label_sha256": "b" * 64,
                "verified_unmasked_targets": {"function": 1, "world": 1}} for index in range(679)]
    preflight = {"schema": "alphastar-full-curriculum-preflight-v1", "status": "passed",
                 "eligible_for_broader_training": True, "all_source_inputs_unchanged": True,
                 "checkpoint_sha256": "checkpoint", "checkpoint_optimizer_updates": 2112,
                 "dataset_hashes": hashes, "tensor_config": {"max_entities": 128}, "split_sha256": "split",
                 "optimizer_updates": 0, "checkpoint_writes": 0, "failures": [],
                 "mask_verified_rows": 679, "source_train_rows": 681, "tensor_supported_rows": 679,
                 "known_exclusions": [{"identity": list(row), "ability_id": 4129, "error": EXCLUSION_ERROR}
                                      for row in sorted(ALLOWED_EXCLUSIONS)],
                 "tensor_records": copy.deepcopy(records), "mask_records": copy.deepcopy(records),
                 "source_and_input_hashes": {"source": "hash"}}
    return preflight, artifacts, hashes


@pytest.mark.parametrize("field,value", [
    ("status", "failed"), ("checkpoint_sha256", "different"),
    ("checkpoint_optimizer_updates", 1088), ("eligible_for_broader_training", False),
    ("all_source_inputs_unchanged", False), ("mask_verified_rows", 678),
    ("failures", [{"error": "invalid label"}]), ("optimizer_updates", 1),
    ("dataset_hashes", {}), ("source_and_input_hashes", {}),
])
def test_preflight_must_match_exact_saved_checkpoint_and_provenance(field, value):
    preflight, artifacts, hashes = passed_preflight()
    assert len(require_preflight(preflight, artifacts, hashes)) == 679
    preflight[field] = value
    with pytest.raises(TensorError):
        require_preflight(preflight, artifacts, hashes)


def test_preflight_duplicate_identity_label_tamper_or_new_omission_rejected():
    preflight, artifacts, hashes = passed_preflight()
    for change in (
        lambda data: data["tensor_records"].__setitem__(1, data["tensor_records"][0]),
        lambda data: data["mask_records"][0].__setitem__("label_sha256", "c" * 64),
        lambda data: data["mask_records"][0].__setitem__("verified_unmasked_targets", {}),
        lambda data: data["known_exclusions"][0].__setitem__("ability_id", 881),
    ):
        bad = copy.deepcopy(preflight)
        change(bad)
        with pytest.raises(TensorError):
            require_preflight(bad, artifacts, hashes)


def event(expert, correct_function, correct_args=True):
    metrics = {"function_exact": correct_function}
    if correct_function:
        metrics["world_exact_given_correct_function"] = correct_args
    return {"function": expert if correct_function else "Wrong", "mask_checks_passed": True,
            "score": {"expert_function": expert, "metrics": metrics}}


def test_macro_metric_exposes_camera_dominance_without_weighting_event_counts():
    events = [event("camera", True)] * 4 + [event("Build_Nexus", True, False)]
    summary = group_metrics(events)
    assert summary["events"] == 5 and summary["complete_action_exact"] == 4
    assert summary["function_exact"] == 5
    assert summary["macro_function_accuracy"] == 1
    assert summary["macro_complete_action_accuracy"] == .5
    assert summary["per_expert_function"]["camera"]["events"] == 4
    assert summary["per_expert_function"]["Build_Nexus"]["argument_metrics_conditional_on_correct_function"]["world_exact_given_correct_function"] == {"correct": 0, "events": 1}


def test_original_anchor_comparison_reorders_larger_archived_curriculum():
    archived = [{"replay_id": "r", "player_id": 2, "action_ordinal": index} for index in range(4)]
    result = {"teacher_forced_metrics": {"final": {"events": archived}}}
    anchors = [("r", 2, 3), ("r", 2, 1)]
    assert original_anchor_teacher_events(result, anchors) == [archived[3], archived[1]]
    with pytest.raises(TensorError, match="uniquely cover"):
        original_anchor_teacher_events(result, [("r", 2, 7)])
    result["teacher_forced_metrics"]["final"]["events"].append(archived[0])
    with pytest.raises(TensorError, match="uniquely cover"):
        original_anchor_teacher_events(result, anchors)
