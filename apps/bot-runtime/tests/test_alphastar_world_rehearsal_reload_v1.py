"""Only the explicitly bounded world-only optimizer namespace can reload."""
import pytest

from scripts.reload_alphastar_world_rehearsal_v1 import require_candidate_schema


def candidate():
    return {"schema": "alphastar-world-rehearsal-candidate-v1",
        "diagnostic_mode": "world-rehearsal-opening50-retention40-other10-v1",
        "optimizer_namespace": "world-head-only-adam-v1", "ordinary_full_model_continuation_allowed": False,
        "checkpoint_restore_verified": True, "new_optimizer_updates": 64, "optimizer_updates": 6153,
        "objective_proof_sha256": "sha", "specialization_budget": {"previously_spent": 64, "ceiling": 256}}


@pytest.mark.parametrize("key,value", [("schema", "alphastar-building-world-candidate-v1"),
    ("new_optimizer_updates", 129), ("optimizer_updates", 6154), ("ordinary_full_model_continuation_allowed", True),
    ("objective_proof_sha256", None), ("specialization_budget", {"previously_spent": 0, "ceiling": 256})])
def test_reload_rejects_other_namespace_reset_budget_missing_proof_or_wrong_counter(key, value):
    record = candidate()
    require_candidate_schema(record)
    record[key] = value
    with pytest.raises(ValueError):
        require_candidate_schema(record)
