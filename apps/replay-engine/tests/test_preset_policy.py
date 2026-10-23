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
    result = apply_policy(policy, case["baseline"], case["race"], case["opponentRace"], case["events"], UserBuildDetector([]), case.get("eightWorker", False))
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
    assert opponent.get_strategy_name("Protoss", events, my_race="Zerg") == "PvZ - Archon Drop"
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
