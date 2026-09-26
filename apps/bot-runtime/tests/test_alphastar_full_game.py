"""Full-game curriculum/accounting checks without optional GPU dependencies."""
from collections import Counter
from copy import deepcopy
import hashlib
import json

import numpy as np
import pytest

from scripts.fit_alphastar_full_game import (
    TensorError, balanced_full_game_schedule, evaluation_subset, exclusion_index,
    full_dataset_guard, matches_exclusion, mixed_reload_order, retention_identities,
    pin_artifact_inputs, read_hashed_json, require_full_game_preflight, verified_checkpoint_bytes,
    CAPACITY_ADAPTER, CAPACITY_MATMUL_PRECISION, require_capacity_adapter,
    label_fingerprint, mask_exclusion_index, observation_fingerprint,
    verified_mask_exclusion, verify_admission_coverage,
)


def curriculum():
    rows = [("replay", 2, number) for number in range(1202)]
    functions = {row: (number % 31 + 1) if number < 100 else 0 for number, row in enumerate(rows)}
    return rows, functions


def test_all32_function_groups_receive_equal_update_frequency():
    rows, functions = curriculum()
    scheduled, initial, final = balanced_full_game_schedule(rows, functions)
    counts = Counter(record["function_id"] for record in scheduled)
    assert len(scheduled) == 1024 and counts == {function: 32 for function in range(32)}
    assert initial["function_draws"] == 0 and final["function_draws"] == 1024
    camera = [record["identity"] for record in scheduled if record["function_id"] == 0]
    assert len(set(camera)) == len(camera) == 32
    assert {record["identity"] for record in scheduled} <= set(rows)


def test_sampler_continuation_matches_uninterrupted_schedule_and_preserves_input():
    rows, functions = curriculum()
    uninterrupted, _, final = balanced_full_game_schedule(rows, functions)
    first, _, cursor = balanced_full_game_schedule(rows, functions, updates=513)
    saved = deepcopy(cursor)
    second, resumed, end = balanced_full_game_schedule(rows, functions, updates=511, previous=cursor)
    assert uninterrupted == first + second and end == final
    assert saved == resumed == cursor
    assert not {record["identity"] for record in first if record["function_id"] == 0} & {
        record["identity"] for record in second if record["function_id"] == 0}


def test_every_small_group_epoch_uses_each_distinct_event_once():
    rows, functions = curriculum()
    schedule, _, _ = balanced_full_game_schedule(rows, functions)
    by_epoch = {}
    for record in schedule:
        key = record["function_id"], record["group_epoch"]
        by_epoch.setdefault(key, []).append(record["identity"])
    assert all(len(group) == len(set(group)) for group in by_epoch.values())


@pytest.mark.parametrize("mutation", [
    lambda state: state.__setitem__("schema", "class-balanced-full-curriculum-sampler-v1"),
    lambda state: state.__setitem__("groups_sha256", "changed"),
    lambda state: state.__setitem__("function_draws", True),
    lambda state: state["group_draws"].__setitem__("0", 0),
    lambda state: state["group_draws"].__setitem__("0", True),
    lambda state: state["group_draws"].pop("31"),
])
def test_invalid_or_old_curriculum_cursor_cannot_silently_reset(mutation):
    rows, functions = curriculum()
    _, _, saved = balanced_full_game_schedule(rows, functions)
    mutation(saved)
    with pytest.raises(TensorError, match="sampler"):
        balanced_full_game_schedule(rows, functions, previous=saved)


def test_expanded_group_assignment_requires_explicit_new_sampler():
    rows, functions = curriculum()
    _, _, cursor = balanced_full_game_schedule(rows, functions)
    functions[rows[0]] = 45
    with pytest.raises(TensorError, match="provenance"):
        balanced_full_game_schedule(rows, functions, previous=cursor)
    _, fresh, _ = balanced_full_game_schedule(rows, functions)
    assert fresh["function_draws"] == 0


@pytest.mark.parametrize("count", [0, 1025, True])
def test_bounded_update_count_cannot_be_bypassed(count):
    rows, functions = curriculum()
    with pytest.raises(TensorError):
        balanced_full_game_schedule(rows, functions, updates=count)


def test_duplicate_or_missing_preflight_identity_is_rejected():
    rows, functions = curriculum()
    with pytest.raises(TensorError):
        balanced_full_game_schedule(rows[:-1], functions)
    with pytest.raises(TensorError):
        balanced_full_game_schedule(rows[:-1] + rows[:1], functions)
    with pytest.raises(TensorError):
        balanced_full_game_schedule([], {})


def test_original679_retention_uses_exact_ordered_identities_inside_full_game():
    rows, _ = curriculum()
    old = rows[:679]
    preflight = {"original_admitted_identities": old}
    result = deepcopy(preflight)
    assert retention_identities(preflight, result, set(rows)) == old
    for altered in (old[:-1], old[:-1] + old[:1], list(reversed(old))):
        with pytest.raises(TensorError):
            retention_identities(preflight, {"original_admitted_identities": altered}, set(rows))
    with pytest.raises(TensorError):
        retention_identities(preflight, result, set(rows[1:]))


def test_exact_full_game_exclusion_does_not_hide_another_error_or_ability():
    row = {"replay_id": "r", "player_id": 2, "action_ordinal": 5, "intent": {"ability_id": 4129}}
    proof = {"identity": ["r", 2, 5], "error": "Exact RAW_FUNCTION mapping count 0", "ability_id": 4129}
    indexed = exclusion_index({"known_exclusions": [proof]})
    assert matches_exclusion(row, TensorError(proof["error"]), indexed)
    assert not matches_exclusion(row, TensorError("overflow"), indexed)
    assert not matches_exclusion({**row, "action_ordinal": 6}, TensorError(proof["error"]), indexed)
    assert not matches_exclusion({**row, "intent": {"ability_id": 23}}, TensorError(proof["error"]), indexed)
    with pytest.raises(TensorError):
        exclusion_index({"known_exclusions": [proof, proof]})


def dataset_parts():
    manifest = {"split_sha256": "split", "replay_partitions": {"train": "train"},
                "counts": {"train_samples": 1217, "samples": 1217}}
    hashes = {"samples": "full", "manifest": "manifest", "game_data": "catalog"}
    result = {"dataset_hashes": deepcopy(hashes), "split_sha256": "split"}
    split = {"train_replay_ids": [{"replay_id": "train"}], "validation_replay_ids": [{"replay_id": "held-out"}]}
    return manifest, hashes, result, split


def test_full_game_dataset_requires_migrated_hashes_and_whole_replay_split():
    manifest, hashes, result, split = dataset_parts()
    assert full_dataset_guard(manifest, hashes, result, split) == ({"train"}, {"held-out"})
    with pytest.raises(TensorError):
        full_dataset_guard(manifest, {**hashes, "samples": "old-prefix"}, result, split)
    split["validation_replay_ids"].append({"replay_id": "train"})
    with pytest.raises(TensorError, match="separation"):
        full_dataset_guard(manifest, hashes, result, split)


def test_validation_row_or_unknown_replay_cannot_enter_full_game_curriculum():
    manifest, hashes, result, split = dataset_parts()
    for partitions in ({"held-out": "train"}, {"train": "validation"}, {"unknown": "train"}):
        with pytest.raises(TensorError):
            full_dataset_guard({**manifest, "replay_partitions": partitions}, hashes, result, split)


def metadata():
    rows = [("r", 2, number) for number in range(100)]
    meta = {}
    for number, row in enumerate(rows):
        if number >= 71:
            function, name = (31, "Attack_pt") if number < 91 else (32, "Attack_unit")
        else:
            function = number % 30
            name = f"function_{function}"
        meta[row] = {"function": {"id": function, "name": name}}
    return rows, meta


def test_mixed64_reload_includes_all29_attacks_and24_anchors_without_reordering_corpus():
    rows, meta = metadata()
    canonical = deepcopy(meta)
    order = mixed_reload_order(meta, rows[:24])
    assert set(rows[:24]) <= set(order[:64]) and set(rows[71:]) <= set(order[:64])
    assert len(order) == len(set(order)) == len(meta)
    assert order[:24] == rows[:24]
    assert meta == canonical
    assert set(order) == set(rows)


def test_reload_order_cannot_silently_omit_combat_when_cap_too_small():
    rows, meta = metadata()
    with pytest.raises(TensorError, match="every admitted attack"):
        mixed_reload_order(meta, rows[:24], limit=40)


def test_unweighted_subsets_do_not_resample_by_class_frequency():
    identities = [("r", 2, index) for index in range(4)]
    teacher, greedy = [], []
    for row_id in identities:
        record = dict(replay_id=row_id[0], player_id=row_id[1], action_ordinal=row_id[2])
        teacher.append({**record, "function": "Train_Probe_quick", "metrics": {"function_accuracy": .5}})
        greedy.append({**record, "function": "Train_Probe_quick", "mask_checks_passed": True,
                       "score": {"expert_function": "Train_Probe_quick", "metrics": {"function_exact": True}}})
    full = {"identities": identities, "new_updates": 10, "optimizer_updates": 4051,
            "unweighted": True, "held_out": False, "teacher_forced": {"events": teacher}, "greedy": {"events": greedy}}
    subset = evaluation_subset(full, identities[::2], "retention")
    assert subset["identities"] == identities[::2]
    assert subset["greedy"]["summary"]["events"] == 2
    assert subset["teacher_forced"]["summary"]["function_accuracy"]["events"] == 2
    assert not subset["held_out"] and subset["unweighted"]
    with pytest.raises(TensorError):
        evaluation_subset(full, [identities[0], identities[0]], "duplicate")
    corrupted = deepcopy(full)
    corrupted["greedy"]["events"][0]["action_ordinal"] = 999
    with pytest.raises(TensorError, match="Greedy event identity"):
        evaluation_subset(corrupted, [identities[0]], "wrong-pointer")


@pytest.fixture
def migration_contract(monkeypatch, tmp_path):
    import scripts.fit_alphastar_full_game as fitter
    import scripts.migrate_alphastar_capacity as migration
    base = {"result": {"artifact_role": "capacity_migration_no_learning", "optimizer_updates": 4041,
                       "dataset_hashes": {"samples": "full"}, "split_sha256": "split",
                       "capacity_adapter": CAPACITY_ADAPTER,
                       "matmul_precision": CAPACITY_MATMUL_PRECISION,
                       "tensor_config": {"max_entities": 512, "max_selected": 64}},
            "checkpoint_sha256": "original-state", "result_sha256": "original-proof"}
    calls = []

    def verify(preflight, artifacts, hashes):
        # The original migration proof remains tied to its unchanged state,
        # never falsely reissued for the numerically updated checkpoint.
        assert artifacts is base and hashes == base["result"]["dataset_hashes"]
        assert preflight == {"proof": "all1202"}
        calls.append(artifacts)
        return {("r", 2, 5): {"function": "Attack_pt"}}

    monkeypatch.setattr(migration, "require_capacity_preflight", verify)
    monkeypatch.setattr(fitter, "read_checkpoint_artifacts", lambda path, catalog: base)
    result = {**deepcopy(base["result"]), "artifact_role": "learned_candidate",
              "diagnostic_mode": "class-balanced-full-game-continuation-v1",
              "capacity_migration_run": str(tmp_path), "preflight_sha256": "preflight-proof",
              "capacity_migration_checkpoint_sha256": base["checkpoint_sha256"],
              "capacity_migration_result_sha256": base["result_sha256"],
              "optimizer_updates": 5065, "sampler_state_checkpoint_updates": 5065,
              "sampler_state": {"function_draws": 1024}}
    keywords = dict(origin=tmp_path / "later", catalog_path=tmp_path / "catalog", preflight_sha256="preflight-proof")
    return base, result, calls, keywords


def test_original_migration_proof_admits_only_its_original_checkpoint(migration_contract):
    base, _, calls, keywords = migration_contract
    admitted, returned, _ = require_full_game_preflight({"proof": "all1202"}, base,
                                                       base["result"]["dataset_hashes"], **keywords)
    assert returned is base and list(admitted) == [("r", 2, 5)] and calls == [base]


def test_later_checkpoint_preserves_exact_migration_lineage_and_sampler_count(migration_contract):
    base, result, calls, keywords = migration_contract
    admitted, returned, path = require_full_game_preflight({"proof": "all1202"}, {"result": result},
                                                          base["result"]["dataset_hashes"], **keywords)
    assert returned is base and calls == [base] and list(admitted) == [("r", 2, 5)]
    assert str(path) == result["capacity_migration_run"]


@pytest.mark.parametrize("field,value", [
    ("capacity_migration_checkpoint_sha256", "changed"),
    ("capacity_migration_result_sha256", "changed"),
    ("preflight_sha256", "changed"),
    ("capacity_migration_run", ""),
    ("tensor_config", {"max_entities": 128, "max_selected": 16}),
    ("capacity_adapter", "unknown"),
    ("matmul_precision", "default"),
    ("dataset_hashes", {"samples": "changed"}),
    ("split_sha256", "changed"),
    ("sampler_state_checkpoint_updates", 5064),
    ("optimizer_updates", True),
    ("optimizer_updates", 4041),
    ("sampler_state", None),
    ("sampler_state", {"function_draws": 1023}),
])
def test_changed_lineage_or_sampling_cannot_reuse_original_preflight(migration_contract, field, value):
    base, result, calls, keywords = migration_contract
    result[field] = value
    with pytest.raises(TensorError):
        require_full_game_preflight({"proof": "all1202"}, {"result": result},
                                    base["result"]["dataset_hashes"], **keywords)
    assert calls == []


def test_old_prefix_checkpoint_cannot_bypass_explicit_migration(migration_contract):
    base, result, calls, keywords = migration_contract
    result["diagnostic_mode"] = "class-balanced-full-curriculum-v1"
    with pytest.raises(TensorError, match="reviewed capacity migration"):
        require_full_game_preflight({"proof": "all1202"}, {"result": result},
                                    base["result"]["dataset_hashes"], **keywords)
    assert calls == []


def test_hash_capture_rejects_modified_artifacts_and_restore_bytes(tmp_path):
    filenames = ("result.json", "checkpoint.msgpack", "registry.json", "reproduction-recipe.json")
    digests = {}
    for name in filenames:
        blob = json.dumps({"name": name}, indent=3).encode()
        (tmp_path / name).write_bytes(blob)
        digests[name] = hashlib.sha256(blob).hexdigest()
    parsed, recipe_digest = read_hashed_json(tmp_path / "reproduction-recipe.json")
    assert parsed == {"name": "reproduction-recipe.json"} and recipe_digest == digests["reproduction-recipe.json"]
    artifacts = {"result_sha256": digests["result.json"], "registry_sha256": digests["registry.json"],
                 "checkpoint_sha256": digests["checkpoint.msgpack"], "checkpoint": tmp_path / "checkpoint.msgpack"}
    pinned = pin_artifact_inputs(tmp_path, artifacts, recipe_digest)
    assert len(pinned) == 4
    assert verified_checkpoint_bytes(artifacts) == artifacts["checkpoint"].read_bytes()
    artifacts["checkpoint"].write_bytes(b"modified")
    with pytest.raises(TensorError, match="provenance capture"):
        pin_artifact_inputs(tmp_path, artifacts, recipe_digest)
    with pytest.raises(TensorError, match="exact state restoration"):
        verified_checkpoint_bytes(artifacts)


def test_capacity_adapter_is_explicit_and_equal_in_result_preflight_and_recipes():
    correct = {"capacity_adapter": CAPACITY_ADAPTER, "matmul_precision": CAPACITY_MATMUL_PRECISION}
    assert require_capacity_adapter(correct, correct, correct, correct, correct) == CAPACITY_ADAPTER
    for wrong in ({}, {"capacity_adapter": None}, {"capacity_adapter": "unknown"},
                  {"capacity_adapter": CAPACITY_ADAPTER}, {**correct, "matmul_precision": "default"}):
        with pytest.raises(TensorError, match="exact reviewed capacity adapter"):
            require_capacity_adapter(correct, correct, wrong, correct, correct)
    with pytest.raises(TensorError):
        require_capacity_adapter()


@pytest.fixture
def mask_quarantine(monkeypatch):
    import scripts.migrate_alphastar_capacity as migration
    row = {"replay_id": "r", "player_id": 2, "action_ordinal": 2086, "intent": {"ability_id": 881}}
    example = {"active_heads": {"world": True}, "labels": {"world": np.asarray(43200, np.int32)}}
    observation = {"inputs": {"step_type": np.asarray(1, np.int32),
                              ("observation", "camera"): np.zeros((2, 2), np.bool_)}, "metadata": {}}
    exclusion = {"identity": ["r", 2, 2086], "ability_id": 881, "function": "Build_Pylon_pt",
                 "error": "World target outside current camera and visible-buildable planning mask",
                 "observation_sha256": observation_fingerprint(observation),
                 "label_sha256": label_fingerprint(example), "mask_evidence": {"legal": False}}
    monkeypatch.setattr(migration, "capacity_mask_exclusion", lambda row, example, obs: deepcopy(exclusion))
    expected = mask_exclusion_index({"known_mask_exclusions": [exclusion]})
    return row, example, observation, expected, exclusion


def test_quarantine_requires_exact_record_and_independent_label_observation_hashes(mask_quarantine):
    row, example, observation, expected, _ = mask_quarantine
    assert verified_mask_exclusion(row, example, observation, expected)
    changed_label = deepcopy(example)
    changed_label["labels"]["world"] += 1
    with pytest.raises(TensorError, match="fingerprint changed"):
        verified_mask_exclusion(row, changed_label, observation, expected)
    changed_observation = deepcopy(observation)
    changed_observation["inputs"]["observation", "camera"][0, 0] = True
    with pytest.raises(TensorError, match="fingerprint changed"):
        verified_mask_exclusion(row, example, changed_observation, expected)
    with pytest.raises(TensorError, match="preflight quarantine"):
        verified_mask_exclusion(row, example, observation, {})


def test_legal_row_cannot_be_quarantined_and_unknown_mask_error_cannot_be_hidden(mask_quarantine, monkeypatch):
    import scripts.migrate_alphastar_capacity as migration
    row, example, observation, expected, _ = mask_quarantine
    monkeypatch.setattr(migration, "capacity_mask_exclusion", lambda *args: None)
    assert not verified_mask_exclusion(row, example, observation, {})
    with pytest.raises(TensorError, match="preflight quarantine"):
        verified_mask_exclusion(row, example, observation, expected)

    def unknown(*args):
        raise TensorError("Unreviewed world-mask rejection")

    monkeypatch.setattr(migration, "capacity_mask_exclusion", unknown)
    with pytest.raises(TensorError, match="Unreviewed world-mask rejection"):
        verified_mask_exclusion(row, example, observation, expected)


def test_mask_quarantine_index_rejects_duplicate_or_unfingerprinted_record(mask_quarantine):
    _, _, _, _, record = mask_quarantine
    with pytest.raises(TensorError):
        mask_exclusion_index({"known_mask_exclusions": [record, record]})
    with pytest.raises(TensorError):
        mask_exclusion_index({"known_mask_exclusions": [{**record, "label_sha256": ""}]})
    with pytest.raises(TensorError):
        mask_exclusion_index({"known_mask_exclusions": [{**record, "mask_evidence": {}}]})


def test_admitted_and_two_exclusion_classes_exactly_cover_unmodified1217_corpus():
    ids = [("r", 2, number) for number in range(1217)]
    admitted, tensor, masked = ids[:1201], ids[1201:1216], ids[1216:]
    verify_admission_coverage(admitted, admitted, tensor, tensor, masked, masked, 1217)
    with pytest.raises(TensorError):
        verify_admission_coverage(admitted[:-1], admitted, tensor, tensor, masked, masked, 1217)
    with pytest.raises(TensorError):
        verify_admission_coverage(admitted, admitted, tensor, tensor, [], masked, 1217)
    with pytest.raises(TensorError):
        verify_admission_coverage(admitted, admitted, tensor, tensor, masked * 2, masked, 1217)
    with pytest.raises(TensorError):
        verify_admission_coverage(admitted, admitted, tensor + masked, tensor + masked, masked, masked, 1218)
