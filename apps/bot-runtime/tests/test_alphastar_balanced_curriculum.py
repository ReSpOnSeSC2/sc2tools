import copy
from collections import Counter

import pytest

from scripts.fit_alphastar_balanced_curriculum import (
    TensorError, balanced_curriculum_schedule, own_build_metadata,
)


def curriculum():
    rows = [("replay", 2, index) for index in range(679)]
    functions = {row: 0 if index < 659 else index - 658 for index, row in enumerate(rows)}
    return rows, functions


def test_majority_class_cannot_dominate_update_budget():
    rows, functions = curriculum()
    schedule, initial, final = balanced_curriculum_schedule(rows, functions)
    assert len(schedule) == 1024
    counts = Counter(row["function_id"] for row in schedule)
    assert len(counts) == 21 and max(counts.values()) - min(counts.values()) == 1
    assert counts[0] == 49
    majority = [row["identity"] for row in schedule if row["function_id"] == 0]
    assert len(majority) == len(set(majority)) == 49
    assert set(row["identity"] for row in schedule) <= set(rows)
    assert final["function_draws"] == 1024 and sum(final["group_draws"].values()) == 1024
    assert initial["function_draws"] == 0 and not any(initial["group_draws"].values())
    assert schedule == balanced_curriculum_schedule(rows, functions)[0]


def test_saved_cursors_resume_exactly_without_repeating_initial_event_window():
    rows, functions = curriculum()
    complete, _, final = balanced_curriculum_schedule(rows, functions)
    first, _, middle = balanced_curriculum_schedule(rows, functions, updates=511)
    unchanged = copy.deepcopy(middle)
    second, resumed, last = balanced_curriculum_schedule(rows, functions, updates=513, previous=middle)
    assert first + second == complete
    assert last == final and resumed == middle == unchanged
    old_majority = {row["identity"] for row in first if row["function_id"] == 0}
    new_majority = {row["identity"] for row in second if row["function_id"] == 0}
    assert not old_majority & new_majority


def test_next_run_continues_group_coverage_and_seed_changes_order():
    rows, functions = curriculum()
    first, _, final = balanced_curriculum_schedule(rows, functions)
    second, _, _ = balanced_curriculum_schedule(rows, functions, previous=final)
    old = {row["identity"] for row in first if row["function_id"] == 0}
    new = {row["identity"] for row in second if row["function_id"] == 0}
    assert not old & new
    assert first != balanced_curriculum_schedule(rows, functions, seed=43)[0]


@pytest.mark.parametrize("change", [
    lambda state: state.__setitem__("seed", 43),
    lambda state: state.__setitem__("groups_sha256", "changed"),
    lambda state: state.__setitem__("function_draws", True),
    lambda state: state["group_draws"].__setitem__("0", 5),
    lambda state: state["group_draws"].__setitem__("0", True),
    lambda state: state["group_draws"].pop("20"),
])
def test_corrupt_sampler_cursors_or_provenance_fail_closed(change):
    rows, functions = curriculum()
    _, _, state = balanced_curriculum_schedule(rows, functions)
    change(state)
    with pytest.raises(TensorError, match="sampler"):
        balanced_curriculum_schedule(rows, functions, previous=state)


def test_changed_group_assignment_rejected_when_resuming():
    rows, functions = curriculum()
    _, _, state = balanced_curriculum_schedule(rows, functions)
    functions[rows[0]] = 1
    with pytest.raises(TensorError, match="provenance changed"):
        balanced_curriculum_schedule(rows, functions, previous=state)


def test_incomplete_duplicate_or_unbounded_curriculum_rejected():
    rows, functions = curriculum()
    for bad_rows in (rows[:-1], rows[:-1] + [rows[0]]):
        with pytest.raises(TensorError, match="679 distinct"):
            balanced_curriculum_schedule(bad_rows, functions)
    for count in (0, 1025, True):
        with pytest.raises(TensorError, match="1..1024"):
            balanced_curriculum_schedule(rows, functions, updates=count)


def test_only_selected_replay_own_build_metadata_is_retained():
    library = {"protoss_candidates": [
        {"replay_id": "r", "site_build_label": "PvT - Robo First", "matchup": "PvT", "opponent_site_label": "3 Rax"},
        {"replay_id": "other", "site_build_label": "unrelated", "matchup": "PvP"},
    ]}
    metadata = own_build_metadata(library, {"r"})
    assert metadata == [{"replay_id": "r", "own_build_label": "PvT - Robo First", "matchup": "PvT",
                         "use": "metadata_only_not_model_conditioning"}]
    assert "opponent" not in str(metadata) and "3 Rax" not in str(metadata)
    missing = own_build_metadata(library, {"missing"})
    assert missing[0]["own_build_label"] is None
    library["protoss_candidates"].append({"replay_id": "r", "site_build_label": "different", "matchup": "PvT"})
    with pytest.raises(TensorError, match="Conflicting own build metadata"):
        own_build_metadata(library, {"r"})
