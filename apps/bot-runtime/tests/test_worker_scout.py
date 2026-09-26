from types import SimpleNamespace as NS

import pytest
from sc2.ids.ability_id import AbilityId as A
from sc2.ids.unit_typeid import UnitTypeId as U
from sc2.position import Point2

from pluto_sc2.worker_scout import WorkerScoutLease


def unit(tag=1, *, kind=U.PROBE, ability=A.MOVE_MOVE):
    return NS(tag=tag, type_id=kind, position=Point2((10, 10)),
              _proto=NS(orders=[] if ability is None else [NS(ability_id=ability.value)]))


def world():
    return NS(state=NS(game_loop=0, dead_units=set()), is_visible=lambda _: True,
              fairplay=NS(audit=[], on_screen=lambda _: True))


def select(lease, bot, probe):
    bot.fairplay.audit.append({"kind": "selection", "source_tags": [probe.tag],
                              "result": [1], "ability": A.MOVE_MOVE.value})
    lease.selected(bot, probe.tag, True)


def confirm(bot, *, success=True, loop=8):
    bot.state.game_loop = loop
    bot.fairplay.audit[-1].update(command_confirmation="accepted" if success else "engine_rejected",
                                 command_loop=loop)


def test_unresolved_scout_does_not_peel_next_worker_when_it_leaves_camera():
    lease, bot = WorkerScoutLease(), world()
    first, second = unit(1), unit(2)
    lease.observe(bot, [first, second])
    assert lease.choose([first, second]) is first
    select(lease, bot, first)
    confirm(bot)
    lease.observe(bot, [first, second])
    bot.state.game_loop = 16
    lease.observe(bot, [second])
    assert lease.choose([second]) is None
    bot.state.game_loop = 100000
    lease.observe(bot, [second])
    assert lease.choose([second]) is None


def test_pending_old_harvesting_and_command_frame_cannot_release_lease():
    lease, bot = WorkerScoutLease(), world()
    first, second = unit(1, ability=A.HARVEST_GATHER_PROBE), unit(2)
    lease.observe(bot, [first, second])
    select(lease, bot, first)
    bot.state.game_loop = 8
    lease.observe(bot, [first, second])
    assert lease.tag == 1
    confirm(bot, loop=16)
    lease.observe(bot, [first, second])
    assert lease.tag == 1  # This state predates the just-sent command.
    bot.state.game_loop = 24
    lease.observe(bot, [first, second])
    assert lease.tag is None
    assert lease.summary()["last_release"] == "observed_economic_return"


@pytest.mark.parametrize("reason", ["engine_rejected", "source_not_selected", "target_not_visible"])
def test_failed_dispatch_releases_only_new_pending_lease(reason):
    lease, bot = WorkerScoutLease(), world()
    probe = unit()
    lease.observe(bot, [probe])
    select(lease, bot, probe)
    bot.fairplay.audit[-1].update(command_confirmation=reason, command_loop=8)
    bot.state.game_loop = 8
    lease.observe(bot, [probe])
    assert lease.tag is None


def test_failed_redispatch_does_not_cancel_existing_successful_scout():
    lease, bot = WorkerScoutLease(), world()
    first, second = unit(1), unit(2)
    lease.observe(bot, [first, second])
    select(lease, bot, first)
    confirm(bot)
    lease.observe(bot, [first, second])
    select(lease, bot, first)
    confirm(bot, success=False, loop=16)
    lease.observe(bot, [first, second])
    assert lease.tag == 1
    assert lease.choose([second]) is None


@pytest.mark.parametrize("ability", [None, A.MOVE_MOVE, A.ATTACK_ATTACK, A.SMART])
def test_idle_unrelated_orders_and_cargo_do_not_release(ability):
    lease, bot = WorkerScoutLease(), world()
    probe = unit()
    lease.observe(bot, [probe])
    select(lease, bot, probe)
    confirm(bot)
    lease.observe(bot, [probe])
    bot.state.game_loop = 16
    probe = unit(ability=ability)
    probe.is_carrying_minerals = True
    lease.observe(bot, [probe])
    assert lease.tag == 1


def test_only_previously_seen_currently_visible_death_releases():
    lease, bot = WorkerScoutLease(), world()
    probe = unit()
    lease.observe(bot, [probe])
    select(lease, bot, probe)
    confirm(bot)
    lease.observe(bot, [probe])
    bot.state.game_loop = 16
    bot.state.dead_units = {1}
    lease.observe(bot, [])
    assert lease.tag is None
    assert lease.summary()["last_release"] == "observed_death"
    assert lease.designated_worker_tag == 1
    assert lease.choose([unit(2)]) is None  # A dead scout cannot drain the next worker.
    observer = unit(3, kind=U.OBSERVER)
    assert lease.choose([unit(2), observer]) is observer


def test_returned_designated_probe_can_rescout_but_another_worker_cannot():
    lease, bot = WorkerScoutLease(), world()
    first, second = unit(2), unit(1)
    lease.observe(bot, [first, second])
    select(lease, bot, first)
    confirm(bot)
    lease.observe(bot, [first, second])
    bot.state.game_loop = 16
    first = unit(2, ability=A.HARVEST_GATHER_PROBE)
    lease.observe(bot, [first, second])
    assert lease.tag is None
    assert lease.choose([second]) is None
    assert lease.choose([first, second]) is first


@pytest.mark.parametrize("hidden", ["camera", "fog", "previous_frame"])
def test_hidden_death_cannot_release(hidden):
    lease, bot = WorkerScoutLease(), world()
    probe = unit()
    lease.observe(bot, [probe])
    select(lease, bot, probe)
    confirm(bot)
    lease.observe(bot, [probe])
    if hidden == "camera":
        bot.fairplay.on_screen = lambda _: False
    elif hidden == "fog":
        bot.is_visible = lambda _: False
    else:
        bot.state.game_loop = 16
        lease.observe(bot, [])
    bot.state.game_loop = 24
    bot.state.dead_units = {1}
    lease.observe(bot, [])
    assert lease.tag == 1


def test_nonworker_scouts_remain_legal_and_selected_nonworker_does_not_lease():
    lease, bot = WorkerScoutLease(), world()
    probe, other, observer = unit(1), unit(2), unit(3, kind=U.OBSERVER)
    lease.observe(bot, [probe, other, observer])
    select(lease, bot, probe)
    assert lease.choose([other, observer]) is observer
    lease.selected(bot, observer.tag, True)
    assert lease.tag == probe.tag


def test_revisiting_scout_reuses_only_its_tag_and_rejected_selection_creates_no_lease():
    lease, bot = WorkerScoutLease(), world()
    other, scout = unit(1), unit(2)
    lease.observe(bot, [other, scout])
    lease.selected(bot, scout.tag, False)
    assert lease.tag is None
    select(lease, bot, scout)
    assert lease.choose([other, scout]) is scout
    with pytest.raises(ValueError, match="another worker"):
        lease.selected(bot, other.tag, True)


def test_helper_never_needs_global_own_units():
    class GuardedWorld:
        @property
        def units(self):
            raise AssertionError("global units forbidden")

        @property
        def structures(self):
            raise AssertionError("global structures forbidden")

    bot = GuardedWorld()
    bot.state = NS(game_loop=0, dead_units=set())
    bot.fairplay = NS(audit=[], on_screen=lambda _: True)
    bot.is_visible = lambda _: True
    lease, probe = WorkerScoutLease(), unit()
    lease.observe(bot, [probe])
    select(lease, bot, probe)
    confirm(bot)
    lease.observe(bot, [probe])
    assert lease.tag == probe.tag
