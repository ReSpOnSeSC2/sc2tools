import asyncio
from types import SimpleNamespace as NS

import pytest
from sc2.ids.ability_id import AbilityId as A
from sc2.ids.unit_typeid import UnitTypeId as U
from sc2.position import Point2

from pluto_sc2.adversary_production import ProductionControl, Relocation


class Unit(NS):
    def __init__(self, kind, tag, position=(50, 50), **changes):
        fields = dict(type_id=kind, tag=tag, position=Point2(position), is_mine=True,
                      is_ready=True, is_idle=True, is_flying=kind.name.endswith("FLYING"),
                      add_on_tag=0, is_visible=True, is_snapshot=False, orders=[],
                      health=1000, health_max=1000)
        fields.update(changes)
        super().__init__(**fields)

    def distance_to(self, other):
        return self.position.distance_to(other.position if hasattr(other, "position") else other)


def scene(*units):
    async def can_place(ability, points):
        return [True] * len(points)

    async def can_place_single(ability, point):
        return True

    return NS(time=0.0, structures=list(units), game_data=NS(units={}, abilities={}),
              game_info=NS(playable_area=NS(x=0, y=0, width=200, height=200)),
              is_visible=lambda _: True, can_place=can_place, can_place_single=can_place_single,
              can_afford=lambda _: False, mineral_field=[], vespene_geyser=[])


def plan(control, bot, producer, enemies=()):
    control.observe(bot.time, bot.structures)
    return asyncio.run(control.lift_plan(bot, producer, bot.structures, enemies))


@pytest.mark.parametrize("kind", [U.BARRACKS, U.FACTORY, U.STARPORT])
def test_idle_working_producer_has_no_lift_action(kind):
    producer = Unit(kind, 1)
    assert plan(ProductionControl(), scene(producer), producer) is None


def test_attached_factory_cannot_lift_just_to_land_back_on_own_addon():
    factory = Unit(U.FACTORY, 1, add_on_tag=2)
    lab = Unit(U.FACTORYTECHLAB, 2, (52.5, 49.5))
    control = ProductionControl()
    assert plan(control, scene(factory, lab), factory) is None
    assert control.summary()["blocked_pointless_lifts"] == 1


@pytest.mark.parametrize("kind,addon", [(U.FACTORY, U.BARRACKSTECHLAB),
                                      (U.STARPORT, U.FACTORYREACTOR),
                                      (U.BARRACKS, U.STARPORTTECHLAB)])
def test_detached_cross_producer_addon_reuse_is_still_legal(kind, addon):
    producer, detached = Unit(kind, 1), Unit(addon, 2, (80, 50))
    result = plan(ProductionControl(), scene(producer, detached), producer)
    assert result.reason == "reuse_owned_addon"
    assert result.target == Point2((77.5, 50.5))
    assert result.addon_tag == 2


def test_landing_cooldown_masks_immediate_repeated_relocation():
    factory, addon = Unit(U.FACTORYFLYING, 1), Unit(U.TECHLAB, 2, (80, 50))
    control, bot = ProductionControl(), scene(factory, addon)
    control.observe(0, bot.structures)
    factory.type_id, factory.is_flying = U.FACTORY, False
    bot.time = 1
    assert plan(control, bot, factory) is None
    bot.time = 30.9
    assert plan(control, bot, factory) is None
    bot.time = 31
    assert plan(control, bot, factory).reason == "reuse_owned_addon"


def test_donation_creates_missing_factory_capability_and_reserves_destination(monkeypatch):
    rax = Unit(U.BARRACKS, 1, add_on_tag=2)
    lab, factory = Unit(U.BARRACKSTECHLAB, 2, (52.5, 49.5)), Unit(U.FACTORY, 3, (80, 80))
    bot, control = scene(rax, lab, factory), ProductionControl()

    async def placement(*_args):
        return Point2((60.5, 60.5))

    monkeypatch.setattr("pluto_sc2.adversary_production.find_placement", placement)
    result = plan(control, bot, rax)
    assert result.reason == "donate_missing_addon_capability" and result.recipient_tag == factory.tag
    control.accepted(0, NS(ability=A.LIFT_BARRACKS, sources=(rax,)))
    # One observation before the lift completes must not discard reservation.
    control.observe(.1, bot.structures)
    assert control.excluded_addons(rax.tag) == {lab.tag}
    assert control.excluded_addons(factory.tag) == set()
    rax.type_id, rax.is_flying, rax.add_on_tag = U.BARRACKSFLYING, True, 0
    control.observe(1, bot.structures)
    assert asyncio.run(control.landing_target(bot, rax)) == result.target
    bot.time = 1
    assert plan(control, bot, factory).addon_tag == lab.tag


def test_existing_factory_lab_prevents_further_donation(monkeypatch):
    rax, lab = Unit(U.BARRACKS, 1, add_on_tag=2), Unit(U.TECHLAB, 2, (52.5, 49.5))
    first, factory_lab = Unit(U.FACTORY, 3, (80, 80), add_on_tag=4), Unit(U.TECHLAB, 4, (82.5, 79.5))
    second = Unit(U.FACTORY, 5, (100, 100))
    assert plan(ProductionControl(), scene(rax, lab, first, factory_lab, second), rax) is None


def test_priority_prevents_lab_being_donated_back_to_barracks():
    factory, lab = Unit(U.FACTORY, 1, add_on_tag=2), Unit(U.FACTORYTECHLAB, 2, (52.5, 49.5))
    rax = Unit(U.BARRACKS, 3, (80, 80))
    assert plan(ProductionControl(), scene(factory, lab, rax), factory) is None


def test_rejected_lift_does_not_commit_or_reserve_a_plan():
    factory = Unit(U.FACTORY, 1)
    control = ProductionControl()
    control.proposals[1] = Relocation("reuse_owned_addon", Point2((60, 60)), 2)
    # Merely computing the legal mask never commits a policy action.
    assert not control.pending and not control.reservations and control.accepted_lifts == 0
    control.accepted(0, NS(ability=A.MOVE_MOVE, sources=(factory,)))
    assert not control.pending


def test_fogged_detached_addon_cannot_make_lift_legal():
    factory, lab = Unit(U.FACTORY, 1), Unit(U.TECHLAB, 2, (80, 50), is_visible=False)
    assert plan(ProductionControl(), scene(factory, lab), factory) is None


def test_reserved_addon_cannot_be_reclaimed_by_donor():
    donor, recipient = Unit(U.BARRACKSFLYING, 1), Unit(U.FACTORY, 3, (100, 100))
    lab = Unit(U.TECHLAB, 2, (80, 50))
    bot, control = scene(donor, lab, recipient), ProductionControl()
    control.reservations[2] = (3, 120)
    control.observe(0, bot.structures)
    target = asyncio.run(control.landing_target(bot, donor))
    assert target != Point2((77.5, 50.5))


def test_reservation_expires_when_recipient_attaches_or_disappears():
    donor, recipient = Unit(U.BARRACKSFLYING, 1), Unit(U.FACTORY, 3, (100, 100), add_on_tag=2)
    lab, control = Unit(U.TECHLAB, 2, (80, 50)), ProductionControl()
    control.reservations[2] = (3, 120)
    control.observe(0, [donor, recipient, lab])
    assert not control.reservations


def test_known_blocked_socket_allows_relocation_but_fog_does_not(monkeypatch):
    factory, bot, control = Unit(U.FACTORY, 1), None, ProductionControl()
    bot = scene(factory)
    bot.can_afford = lambda _: True

    async def blocked(*_):
        return False

    async def placement(*_):
        return Point2((60.5, 60.5))

    bot.can_place_single = blocked
    monkeypatch.setattr("pluto_sc2.adversary_production.find_placement", placement)
    assert plan(control, bot, factory).reason == "clear_observed_blocked_addon_socket"
    bot.is_visible = lambda _: False
    assert plan(control, bot, factory) is None


@pytest.mark.parametrize("changes,allowed", [({}, True), ({"is_visible": False}, False),
                                           ({"is_snapshot": True}, False),
                                           ({"is_cloaked": True}, False),
                                           ({"can_attack_air": True}, False)])
def test_only_current_visible_ground_only_pressure_justifies_escape(monkeypatch, changes, allowed):
    factory = Unit(U.FACTORY, 1, health=300)
    base = Unit(U.COMMANDCENTER, 2, (100, 100))
    values = dict(is_mine=False, can_attack=True, can_attack_ground=True, can_attack_air=False,
                  ground_range=1, is_cloaked=False, is_revealed=False)
    values.update(changes)
    enemy = Unit(U.ZERGLING, 3, (51, 50), **values)
    bot = scene(factory, base)

    async def placement(*_):
        return Point2((100.5, 100.5))

    monkeypatch.setattr("pluto_sc2.adversary_production.find_placement", placement)
    result = plan(ProductionControl(), bot, factory, [enemy])
    if allowed:
        assert result.reason == "escape_visible_ground_pressure"
    else:
        assert result is None


def test_landing_observation_restarts_dwell_after_long_flight():
    factory, addon = Unit(U.FACTORYFLYING, 1), Unit(U.TECHLAB, 2, (80, 50))
    control, bot = ProductionControl(), scene(factory, addon)
    control.grounded_until[1] = 30
    control.observe(0, bot.structures)
    bot.time = 80
    factory.type_id, factory.is_flying = U.FACTORY, False
    assert plan(control, bot, factory) is None
    assert control.grounded_until[1] == 110


def test_reused_addon_is_reserved_for_one_accepted_producer():
    factory, starport = Unit(U.FACTORY, 1), Unit(U.STARPORT, 3, (100, 100))
    lab = Unit(U.TECHLAB, 2, (80, 50))
    control, bot = ProductionControl(), scene(factory, starport, lab)
    assert plan(control, bot, factory).addon_tag == lab.tag
    control.accepted(0, NS(ability=A.LIFT_FACTORY, sources=(factory,)))
    bot.time = 1
    assert plan(control, bot, starport) is None
    assert control.excluded_addons(starport.tag) == {lab.tag}
    assert control.excluded_addons(factory.tag) == set()


def test_committed_landing_waits_for_other_owned_landing_claim(monkeypatch):
    target = Point2((60.5, 60.5))
    factory = Unit(U.FACTORYFLYING, 1)
    other = Unit(U.STARPORTFLYING, 2, (80, 80),
                 orders=[NS(ability=NS(id=A.LAND_STARPORT), target=target)])
    bot, control = scene(factory, other), ProductionControl()
    control.pending[1] = Relocation("clear_observed_blocked_addon_socket", target)

    async def placement(*_):
        return target  # Even fallback must not send both producers here.

    monkeypatch.setattr("pluto_sc2.adversary_production.find_placement", placement)
    assert asyncio.run(control.landing_target(bot, factory)) is None
    other.orders = []
    assert asyncio.run(control.landing_target(bot, factory)) == target


def test_reservation_released_if_recipient_takes_different_addon():
    factory = Unit(U.FACTORY, 1, add_on_tag=3)
    old, new = Unit(U.TECHLAB, 2, (80, 50)), Unit(U.REACTOR, 3, (52.5, 49.5))
    control = ProductionControl()
    control.reservations[2] = (1, 120)
    control.observe(1, [factory, old, new])
    assert not control.reservations
