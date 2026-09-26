import asyncio

import pytest

from test_coach_critical_opening import CASES, construction_world
from test_coach_bot import order


def test_final_gas_waits_until_probe_production_really_resumed(tmp_path):
    bot = construction_world(tmp_path, CASES[0])
    bot._opening_decision.core_foundation_observed = True
    assert not asyncio.run(bot._critical_opening_step(bot.units, order()))
    assert not bot.client.requests


@pytest.mark.parametrize("refill", [True, False])
def test_post_core_worker_refill_gets_first_slot_then_affordable_gas(tmp_path, refill):
    bot = construction_world(tmp_path, CASES[0])
    bot._opening_decision.core_foundation_observed = True
    bot._post_core_probe_primed = True
    calls = []

    async def worker_step(_order, *, workers_only=False):
        calls.append(workers_only)
        assert not bot.query_log
        return refill

    bot._production_group_step = worker_step
    assert asyncio.run(bot._critical_opening_step(bot.units, order()))
    assert calls == [True]
    assert bool(bot.query_log) is not refill
    assert bool(bot.client.requests) is not refill
    assert bot._opening_decision.core_foundation_observed


@pytest.mark.parametrize("accepted,observed,primed", [(True, True, True), (False, True, False),
                                                      (True, False, False)])
def test_only_confirmed_post_core_probe_primes_final_buildings(tmp_path, accepted, observed, primed):
    bot = construction_world(tmp_path)
    bot._opening_decision.core_foundation_observed = observed
    bot.fairplay.audit.append(dict(kind="selection", source_tags=[1], command_loop=224,
        command_confirmation="accepted" if accepted else "engine_rejected"))
    bot._record_selection("train_probe")
    bot._confirm_commands(bot.units)
    assert bot._post_core_probe_primed is primed
