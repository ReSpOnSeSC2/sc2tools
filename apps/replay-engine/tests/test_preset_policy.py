"""Shared active-policy contract, not a substitute for released tree tests."""
import copy
import json
from pathlib import Path

import pytest

from core.preset_policy import (
    apply_policy, install_policy, policy_hash, policy_snapshot, validate_policy,
)
from core.strategy_detector import OpponentStrategyDetector, UserBuildDetector

FIXTURE = json.loads((Path(__file__).parent / "fixtures/preset_policy.json").read_text(encoding="utf-8"))


@pytest.mark.parametrize("case", FIXTURE["cases"], ids=lambda case: case["name"])
def test_shared_cases(case):
    policy = validate_policy(case["policy"], verify_hash=False)
    result = apply_policy(policy, case["baseline"], case["race"], case["opponentRace"], case["events"], UserBuildDetector([]), case.get("eightWorker", False), case.get("surface", "you"))
    assert result == case["expected"]


def test_hash_matches_release_fixture_and_rejects_mutation():
    policy = validate_policy(FIXTURE["cases"][0]["policy"], verify_hash=False)
    assert policy["hash"] == FIXTURE["hash"]
    assert validate_policy(policy) == policy
    policy["entries"][0]["anyOf"][0][0]["beforeSeconds"] = 100
    with pytest.raises(ValueError, match="policy_hash_mismatch"):
        validate_policy(policy)


@pytest.mark.parametrize("mutation", [
    lambda p: p.update(evaluatorVersion=2),
    lambda p: p.update(schemaVersion=True),
    lambda p: p["entries"].append(copy.deepcopy(p["entries"][0])),
    lambda p: p["entries"][0].update(name="Arbitrary new label"),
    lambda p: p["entries"][0].update(anyOf=[[]]),
    lambda p: p["entries"][0]["anyOf"][0][0].update(category="building"),
    lambda p: p["entries"][0]["anyOf"][0][0].update(execute="print(1)"),
    lambda p: p["entries"][0].update(description="\ud800"),
])
def test_reject_invalid_policy_without_changing_active(mutation):
    before = policy_snapshot()
    policy = copy.deepcopy(FIXTURE["cases"][0]["policy"])
    mutation(policy)
    with pytest.raises(ValueError):
        install_policy(policy)
    assert policy_snapshot() == before


def test_real_detectors_share_snapshot_and_custom_precedence():
    policy = validate_policy(FIXTURE["cases"][0]["policy"], verify_hash=False)
    events = FIXTURE["cases"][0]["events"]
    you = UserBuildDetector([], preset_policy=policy)
    opponent = OpponentStrategyDetector([], preset_policy=policy)
    assert you.detect_my_build("vs Zerg", events) == "PvZ - Archon Drop"
    assert opponent.get_strategy_name("Protoss", events, my_race="Zerg") == OpponentStrategyDetector([], preset_policy=validate_policy({"schemaVersion": 1, "evaluatorVersion": 1, "revision": 0, "entries": []}, verify_hash=False)).get_strategy_name("Protoss", events, my_race="Zerg")
    policy["entries"][0]["enabled"] = False
    # Mutation of the caller's object cannot alter an in-flight parse.
    assert you.detect_my_build("vs Zerg", events) == "PvZ - Archon Drop"
    custom = [{"name": "Private preference", "race": "Protoss", "vs_race": "Zerg", "rules": [{"type": "unit", "name": "WarpPrism", "time_lt": 360}]}]
    assert UserBuildDetector(custom, preset_policy=you.preset_policy).detect_my_build("vs Zerg", events) == "Private preference"
    assert OpponentStrategyDetector(custom, preset_policy=you.preset_policy).get_strategy_name("Protoss", events, my_race="Zerg") == "Private preference"


def test_hash_is_order_independent_and_unicode_safe():
    value = copy.deepcopy(FIXTURE["cases"][0]["policy"])
    value["entries"][0]["description"] = "6:00 — caméra 🛠"
    assert policy_hash(value) == policy_hash(dict(reversed(list(value.items()))))

def test_raw_ingest_evidence_preserves_custom_same_name_provenance_and_recorded_clock():
    from core.preset_policy import classification_evidence, validate_policy
    from core.strategy_detector import UserBuildDetector, OpponentStrategyDetector
    name = "PvZ - Archon Drop"
    custom = {"name": name, "race": "Protoss", "vs_race": "Zerg", "rules": [{"type": "count_min", "name": "BuildGateway", "time_lt": 200, "count": 1}]}
    raw = [{"type": "building", "name": "Gateway", "time": 100, "subtype": "init"}, {"type": "unit", "name": "WarpPrism", "time": 360, "hallucinated": True}]
    policy = validate_policy({"schemaVersion": 1, "evaluatorVersion": 1, "revision": 1, "entries": [{"name": name, "enabled": False, "priority": 0, "anyOf": []}]}, verify_hash=False)
    you = UserBuildDetector([custom], preset_policy=policy)
    opponent = OpponentStrategyDetector([], preset_policy=policy)
    assert you.detect_my_build("vs Zerg", raw, "Protoss", game_length_seconds=600) == name
    evidence = classification_evidence(policy, you, opponent, raw, [])
    assert evidence["you"] == {"custom": True, "baseline": None, "complete": True, "events": raw}
    assert evidence["policyHash"] == policy["hash"]
    # Public manifest replacement cannot reinterpret an explicitly local custom
    # winner sharing the released preset's name, or a truncated event sample.
    assert classification_evidence(policy, you, opponent, raw * 2501, [])["you"]["complete"] is False


def test_raw_ingest_evidence_retains_released_baseline_independent_of_effective_policy():
    from core.preset_policy import classification_evidence, validate_policy
    from core.strategy_detector import UserBuildDetector, OpponentStrategyDetector
    name = "PvZ - Archon Drop"
    policy = validate_policy({"schemaVersion": 1, "evaluatorVersion": 1, "revision": 1, "entries": [{"name": name, "enabled": True, "priority": 0, "anyOf": [[{"kind": "exists", "name": "Gateway", "category": "building", "clock": "recorded", "beforeSeconds": 200}]]}]}, verify_hash=False)
    you, opponent = UserBuildDetector([], preset_policy=policy), OpponentStrategyDetector([], preset_policy=policy)
    events = [{"type": "building", "name": "Gateway", "time": 100}]
    assert you.detect_my_build("vs Zerg", events, "Protoss", game_length_seconds=600) == name
    evidence = classification_evidence(policy, you, opponent, events, [])
    assert evidence["you"]["custom"] is False
    assert evidence["you"]["baseline"] != name
    assert evidence["you"]["baseline"] is not None

@pytest.mark.parametrize("entry_name,personal,opposing", [
    ("PvZ - Archon Drop", True, False), ("Protoss - DT Rush", False, True),
])
def test_actual_protoss_detector_surfaces_never_cross_apply(entry_name, personal, opposing):
    empty = validate_policy({"schemaVersion": 1, "evaluatorVersion": 1, "revision": 0, "entries": []}, verify_hash=False)
    policy = validate_policy({**empty, "entries": [{"name": entry_name, "priority": 0, "enabled": True, "anyOf": [[{"kind": "exists", "name": "Gateway", "category": "building", "clock": "recorded", "beforeSeconds": 200}]]}]}, verify_hash=False)
    events = [{"type": "building", "name": "Gateway", "time": 100}]
    baseline_you = UserBuildDetector([], preset_policy=empty).detect_my_build("vs Zerg", events, "Protoss", game_length_seconds=600)
    baseline_opp = OpponentStrategyDetector([], preset_policy=empty).get_strategy_name("Protoss", events, my_race="Zerg", game_length_seconds=600)
    assert UserBuildDetector([], preset_policy=policy).detect_my_build("vs Zerg", events, "Protoss", game_length_seconds=600) == (entry_name if personal else baseline_you)
    assert OpponentStrategyDetector([], preset_policy=policy).get_strategy_name("Protoss", events, my_race="Zerg", game_length_seconds=600) == (entry_name if opposing else baseline_opp)


def test_generated_release_catalog_and_full_prerequisite_table_match_canonical_sources():
    import importlib.util
    script = Path(__file__).parents[1] / "scripts/export_preset_catalog.py"
    spec = importlib.util.spec_from_file_location("export_preset_catalog", script)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    assert json.loads(module.TARGET.read_text(encoding="utf-8")) == module.export_catalog()
