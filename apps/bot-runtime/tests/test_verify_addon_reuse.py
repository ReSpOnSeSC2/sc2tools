"""The live mechanics gate must reject successful but unexercised games."""
from copy import deepcopy
import importlib.util
import sys
from pathlib import Path
from types import SimpleNamespace as NS
import asyncio

import pytest
from sc2.ids.ability_id import AbilityId as A
from sc2.ids.unit_typeid import UnitTypeId as U
from sc2.position import Point2

from pluto_sc2.adversary import AdversaryBudget


source = Path(__file__).parents[1] / "scripts" / "verify_addon_reuse.py"
spec = importlib.util.spec_from_file_location("verify_addon_reuse", source)
module = importlib.util.module_from_spec(spec)
sys.modules[spec.name] = module
spec.loader.exec_module(module)


def evidence():
    report = dict(starting_workers=[8, 8], engine_results=["Defeat", "Victory"],
                  concession_reason="verification_complete", cycles_completed=2, cycles_requested=2,
                  stable_seconds=15, max_owned_addons=1,
                  events=[dict(kind="initial_attachment", addon_tag=22),
                          dict(kind="detached", addon_tag=22), dict(kind="reattached", addon_tag=22),
                          dict(kind="detached", addon_tag=22), dict(kind="reattached", addon_tag=22)])
    abilities = [A.BUILD_TECHLAB_FACTORY, A.LIFT_FACTORY, A.LAND_FACTORY, A.LIFT_FACTORY, A.LAND_FACTORY]
    budget = AdversaryBudget(600)
    for index, ability in enumerate(abilities):
        now = float(index)
        assert budget.available(now)
        budget.events.append(now)
        budget.last = now
        budget.peak = len(budget.events)
        budget.audit.append(dict(time=now, kind="raw_command", ability=ability.value,
                                 source_tags=[11], target_tag=None, target_position=None, result=[1]))
    return report, dict(summary=budget.summary(), actions=budget.audit)


def test_complete_mechanics_evidence_passes():
    module.verify_evidence(*evidence())


@pytest.mark.parametrize("field,value", [
    ("starting_workers", [12, 8]), ("engine_results", ["Tie", "Tie"]),
    ("concession_reason", "verification_timeout"), ("cycles_completed", 1),
    ("stable_seconds", 14.9), ("max_owned_addons", 2),
])
def test_success_cannot_hide_wrong_start_timeout_missing_cycles_or_accumulation(field, value):
    report, audit = evidence()
    report[field] = value
    with pytest.raises(RuntimeError):
        module.verify_evidence(report, audit)


def test_mere_commands_without_observed_reattachment_fail():
    report, audit = evidence()
    report["events"] = [e for e in report["events"] if e["kind"] != "reattached"]
    with pytest.raises(RuntimeError, match="reattachment"):
        module.verify_evidence(report, audit)


def test_new_addon_with_same_count_is_not_reuse():
    report, audit = evidence()
    report["events"][-1]["addon_tag"] = 33
    with pytest.raises(RuntimeError, match="same addon"):
        module.verify_evidence(report, audit)


def test_initial_addon_must_match_later_reuse():
    report, audit = evidence()
    report["events"][0]["addon_tag"] = 33
    with pytest.raises(RuntimeError, match="other than the initial"):
        module.verify_evidence(report, audit)


def test_accepted_build_454_is_required():
    report, audit = evidence()
    audit["actions"][0]["result"] = [2]
    with pytest.raises(RuntimeError, match="construction"):
        module.verify_evidence(report, audit)


def test_rejected_landing_cannot_count_as_cycle():
    report, audit = evidence()
    audit["actions"][-1]["result"] = [2]
    with pytest.raises(RuntimeError, match="LAND_FACTORY"):
        module.verify_evidence(report, audit)


def test_action_budget_is_checked_even_with_complete_cycle_evidence():
    report, audit = deepcopy(evidence())
    audit["actions"][2]["time"] = audit["actions"][1]["time"]
    with pytest.raises(ValueError, match="pacing"):
        module.verify_evidence(report, audit)


def test_accepted_build_waits_through_delayed_observation_and_construction():
    latch = module.ConstructionLatch("build_factory", Point2((30.5, 30.5)), (7,), 10)
    assert not latch.observe(11, [])
    structure = NS(type_id=U.FACTORY, tag=9, position=Point2((30.5, 30.5)), is_ready=False)
    assert not latch.observe(12, [structure])
    assert latch.observed_tag == 9
    structure.is_ready = True
    assert latch.observe(60, [structure])


def test_wrong_kind_or_different_site_does_not_release_build_reservation():
    latch = module.ConstructionLatch("build_factory", Point2((30.5, 30.5)), (7,), 0)
    buildings = [NS(type_id=U.FACTORY, tag=9, position=Point2((50.5, 50.5)), is_ready=True),
                 NS(type_id=U.BARRACKS, tag=10, position=Point2((30.5, 30.5)), is_ready=True)]
    assert not latch.observe(10, buildings)
    assert latch.observed_tag is None


def test_accepted_build_that_never_starts_fails_instead_of_silently_retrying():
    latch = module.ConstructionLatch("build_factory", Point2((30.5, 30.5)), (7,), 0)
    with pytest.raises(RuntimeError, match="never became observed"):
        latch.observe(46, [])


def test_started_build_disappearing_or_remaining_unfinished_fails():
    latch = module.ConstructionLatch("build_factory", Point2((30.5, 30.5)), (7,), 0)
    structure = NS(type_id=U.FACTORY, tag=9, position=Point2((30.5, 30.5)), is_ready=False)
    assert not latch.observe(1, [structure])
    with pytest.raises(RuntimeError, match="disappeared"):
        latch.observe(2, [])
    with pytest.raises(RuntimeError, match="did not complete"):
        latch.observe(151, [structure])


def test_pending_build_prevents_gather_from_cancelling_stale_idle_worker():
    calls = []

    async def issue(*args):
        calls.append(args)
        return True

    fake = NS(pending_construction=module.ConstructionLatch("build_factory", Point2((30.5, 30.5)), (7,), 0),
              time=1, structures=[], issue_named=issue, event=lambda *args, **kwargs: None)
    # Setup must return before even examining the idle-worker gather mask.
    asyncio.run(module.AddonVerificationBot.setup(fake, None))
    assert calls == []
