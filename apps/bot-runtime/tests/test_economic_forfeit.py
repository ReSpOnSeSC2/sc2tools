from types import SimpleNamespace as NS

import pytest
from sc2.ids.ability_id import AbilityId as A
from sc2.ids.unit_typeid import UnitTypeId as U
from sc2.position import Point2

from pluto_sc2.economic_forfeit import EconomicForfeitGuard


def bot(*, workers=0, minerals=35, loop=8):
    return NS(state=NS(game_loop=loop), supply_workers=workers, minerals=minerals,
              fairplay=NS(audit=[], on_screen=lambda position: position.x < 50),
              is_visible=lambda position: position.y < 50)


def unit(tag=1, kind=U.NEXUS, *, orders=(), ready=True, position=(10, 10)):
    return NS(tag=tag, type_id=kind, is_structure=kind != U.PROBE, is_ready=ready,
              position=Point2(position), _proto=NS(orders=[NS(ability_id=ability.value) for ability in orders]))


def command(state, *, source=1, ability=A.NEXUSTRAIN_PROBE, loop=None, result=1, target=None):
    state.fairplay.audit.append(dict(kind="command", ability=ability.value, source_tags=[source],
                                    game_loop=state.state.game_loop if loop is None else loop,
                                    result=[result], target=target))


def advance(state, loop=16, *, workers=None):
    state.state.game_loop = loop
    if workers is not None:
        state.supply_workers = workers


def test_zero_workers_and_35_minerals_without_recovery_forfeits():
    decision = EconomicForfeitGuard().observe(bot(), [unit()])
    assert decision["reason"] == "economic_forfeit_no_probes_or_recovery"
    assert decision["workers"] == 0 and decision["minerals"] == 35


@pytest.mark.parametrize("workers,minerals", [(8, 35), (1, 0), (0, 50), (0, 100)])
def test_viable_worker_or_affordable_probe_never_forfeits(workers, minerals):
    assert EconomicForfeitGuard().observe(bot(workers=workers, minerals=minerals), [unit()]) is None


def test_visible_queued_probe_blocks_even_without_prior_command_record():
    state = bot(minerals=0)
    guard = EconomicForfeitGuard()
    assert guard.observe(state, [unit(orders=[A.NEXUSTRAIN_PROBE])]) is None
    advance(state, 100000)
    assert guard.observe(state, []) is None


def test_accepted_probe_command_cannot_resolve_from_same_observation_empty_queue():
    state = bot(minerals=0)
    command(state)
    guard = EconomicForfeitGuard()
    assert guard.observe(state, [unit()]) is None
    assert guard.pending_probe_count == 1


def test_offscreen_pending_command_does_not_expire_after_long_time():
    state = bot(minerals=0)
    command(state)
    guard = EconomicForfeitGuard()
    assert guard.observe(state, []) is None
    advance(state, 100000)
    assert guard.observe(state, []) is None
    assert guard.pending_probe_count == 1


def test_strictly_later_visible_empty_queue_resolves_probe_and_allows_forfeit():
    state = bot()
    command(state)
    guard = EconomicForfeitGuard()
    assert guard.observe(state, [unit()]) is None
    advance(state)
    assert guard.observe(state, [unit()]) is not None
    assert guard.pending_probe_count == 0


def test_positive_worker_change_clears_only_proven_completions():
    state = bot()
    command(state, source=1)
    command(state, source=2)
    guard = EconomicForfeitGuard()
    assert guard.observe(state, []) is None
    advance(state, workers=1)
    assert guard.observe(state, []) is None
    assert guard.pending_probe_count == 1
    advance(state, 24, workers=0)
    assert guard.observe(state, []) is None


def test_simultaneous_birth_and_death_without_hud_increase_remains_uncertain():
    state = bot()
    command(state)
    guard = EconomicForfeitGuard()
    assert guard.observe(state, []) is None
    advance(state, 10000, workers=0)
    assert guard.observe(state, []) is None
    assert guard.pending_probe_count == 1


def test_rejected_command_does_not_create_pending_probe():
    state = bot()
    command(state, result=9)
    assert EconomicForfeitGuard().observe(state, [unit()]) is not None


def test_unknown_accepted_command_source_stays_conservative():
    state = bot()
    command(state)
    del state.fairplay.audit[-1]["source_tags"]
    guard = EconomicForfeitGuard()
    assert guard.observe(state, [unit()]) is None
    advance(state, 10000)
    assert guard.observe(state, [unit()]) is None


def test_productive_selection_wait_blocks_until_explicitly_rejected():
    state = bot()
    selection = dict(kind="selection", ability=A.NEXUSTRAIN_PROBE.value, source_tags=[1], result=[1])
    state.fairplay.audit.append(selection)
    guard = EconomicForfeitGuard()
    assert guard.observe(state, [unit()]) is None
    selection["command_confirmation"] = "source_not_selected"
    advance(state)
    assert guard.observe(state, [unit()]) is not None


def test_known_incomplete_structure_offscreen_blocks_until_seen_complete():
    state = bot()
    guard = EconomicForfeitGuard()
    assert guard.observe(state, [unit(kind=U.PYLON, ready=False)]) is None
    state.fairplay.on_screen = lambda _: False
    advance(state, 1000)
    assert guard.observe(state, []) is None
    advance(state, 1008)
    assert guard.observe(state, [unit(kind=U.PYLON, ready=True)]) is not None


def test_refundable_research_or_unit_order_blocks_and_resolves_only_when_visible_empty():
    state = bot()
    guard = EconomicForfeitGuard()
    assert guard.observe(state, [unit(kind=U.GATEWAY, orders=[A.GATEWAYTRAIN_ZEALOT])]) is None
    advance(state)
    assert guard.observe(state, []) is None
    advance(state, 24)
    assert guard.observe(state, [unit(kind=U.GATEWAY)]) is not None


def test_accepted_construction_remains_pending_until_visible_completion():
    state = bot()
    command(state, source=9, ability=A.PROTOSSBUILD_PYLON, target=[10, 10])
    guard = EconomicForfeitGuard()
    assert guard.observe(state, []) is None
    advance(state)
    assert guard.observe(state, [unit(2, U.PYLON, ready=False)]) is None
    advance(state, 24)
    assert guard.observe(state, [unit(2, U.PYLON, ready=True)]) is not None


def test_public_probe_cost_is_used_without_hidden_unit_queries():
    class RestrictedBot:
        def __getattr__(self, name):
            raise AssertionError("Forbidden state read: " + name)

    state = RestrictedBot()
    state.__dict__.update(vars(bot(minerals=50)))
    state.game_data = NS(units={U.PROBE.value: NS(_proto=NS(mineral_cost=75))})
    assert EconomicForfeitGuard().observe(state, [unit()]) is not None


def test_same_loop_is_idempotent_and_backwards_loop_rejected():
    state = bot()
    guard = EconomicForfeitGuard()
    result = guard.observe(state, [unit()])
    assert guard.observe(state, [unit()]) == result
    advance(state, 0)
    with pytest.raises(ValueError, match="backwards"):
        guard.observe(state, [])


def test_fresh_on_screen_producer_death_resolves_pending_and_visible_queue():
    state = bot()
    command(state)
    guard = EconomicForfeitGuard()
    assert guard.observe(state, [unit(orders=[A.NEXUSTRAIN_PROBE])]) is None
    advance(state)
    state.state.dead_units = {1}
    assert guard.observe(state, []) is not None
    assert guard.pending_probe_count == 0


def test_fresh_on_screen_producer_death_resolves_observed_queue_without_command():
    state = bot()
    guard = EconomicForfeitGuard()
    assert guard.observe(state, [unit(kind=U.GATEWAY, orders=[A.GATEWAYTRAIN_ZEALOT])]) is None
    advance(state)
    state.state.dead_units = {1}
    assert guard.observe(state, []) is not None


@pytest.mark.parametrize("restriction", ["offscreen", "fogged", "stale"])
def test_unobserved_producer_death_cannot_resolve_queue(restriction):
    state = bot()
    command(state)
    guard = EconomicForfeitGuard()
    assert guard.observe(state, [unit(orders=[A.NEXUSTRAIN_PROBE])]) is None
    advance(state)
    if restriction == "offscreen":
        state.fairplay.on_screen = lambda _: False
    elif restriction == "fogged":
        state.is_visible = lambda _: False
    else:
        assert guard.observe(state, []) is None
        advance(state, 24)
    state.state.dead_units = {1}
    assert guard.observe(state, []) is None
    assert guard.pending_probe_count == 1


def test_dead_builder_does_not_cancel_warping_structure_recovery():
    state = bot(workers=1)
    command(state, source=9, ability=A.PROTOSSBUILD_PYLON, target=[20, 20])
    guard = EconomicForfeitGuard()
    assert guard.observe(state, [unit(9, U.PROBE), unit(2, U.PYLON, ready=False, position=(20, 20))]) is None
    advance(state, workers=0)
    state.state.dead_units = {9}
    assert guard.observe(state, [unit(2, U.PYLON, ready=False, position=(20, 20))]) is None
    advance(state, 24)
    assert guard.observe(state, [unit(2, U.PYLON, ready=True, position=(20, 20))]) is not None


def test_dead_builder_does_not_resolve_unobserved_build_site():
    state = bot(workers=1)
    command(state, source=9, ability=A.PROTOSSBUILD_PYLON, target=[60, 10])
    guard = EconomicForfeitGuard()
    assert guard.observe(state, [unit(9, U.PROBE)]) is None
    advance(state, workers=0)
    state.state.dead_units = {9}
    assert guard.observe(state, []) is None
