import asyncio
from types import SimpleNamespace as NS

import pytest
from s2clientprotocol import raw_pb2 as raw
from sc2.dicts.unit_train_build_abilities import TRAIN_INFO
from sc2.ids.ability_id import AbilityId as A
from sc2.ids.unit_typeid import UnitTypeId as U
from sc2.position import Point2

from pluto_sc2.adversary import Intent, legal_action_mask
from pluto_sc2.adversary_infrastructure import InfrastructureGuard
from test_adversary import Unit, scene


def world(*structures):
    bot = scene()
    bot.supply_workers, bot.supply_army = 24, 12
    bot.structures = [Unit(U.COMMANDCENTER, tag=100, position=(50, 50), is_structure=True), *structures]
    return bot


def observe(bot):
    guard = getattr(bot, "_infrastructure_guard", None) or InfrastructureGuard()
    bot._infrastructure_guard = guard
    guard.observe(bot, bot.units + bot.structures)
    return guard


def tower(position=(50, 60), tag=200, **kwargs):
    return Unit(U.SENSORTOWER, tag=tag, position=position, is_structure=True, **kwargs)


def build_order(kind, point):
    order = raw.UnitOrder(ability_id=TRAIN_INFO[U.SCV][kind]["ability"].value)
    order.target_world_space_pos.x, order.target_world_space_pos.y = point
    return order


def test_sensor_economy_and_army_gate_does_not_mask_upgrade_bays_or_detection():
    bot = world()
    bot.supply_workers, bot.supply_army = 8, 0
    guard = observe(bot)
    assert not guard.allowed("SENSORTOWER")
    assert guard.allowed("ENGINEERINGBAY") and guard.allowed("MISSILETURRET")
    bot.supply_workers, bot.supply_army = 24, 12
    assert observe(bot).allowed("SENSORTOWER")


@pytest.mark.parametrize("ready", [False, True])
def test_finished_and_unfinished_sensor_each_reserve_one_base(ready):
    bot = world(tower(is_ready=ready))
    guard = observe(bot)
    assert not guard.allowed("SENSORTOWER")
    assert guard.summary()["denied_reasons"] == {"sensortower:per_base_limit": 1}
    bot.structures.pop()
    assert observe(bot).allowed("SENSORTOWER")  # Destruction/cancellation reopens eligibility.


def test_build_order_and_foundation_at_same_site_count_once_and_cancellation_reopens():
    bot = world(tower(is_ready=False))
    bot.units = [Unit(U.SCV, tag=1, _proto=NS(orders=[build_order(U.SENSORTOWER, (50, 60))]))]
    guard = observe(bot)
    assert len(guard.sites["SENSORTOWER"]) == 1 and not guard.allowed("SENSORTOWER")
    bot.structures.pop()
    assert not observe(bot).allowed("SENSORTOWER")  # The still-observed build order reserves it.
    bot.units[0]._proto.orders.clear()
    assert observe(bot).allowed("SENSORTOWER")


def test_accepted_build_reservation_bridges_observation_without_becoming_permanent():
    bot = world()
    guard = observe(bot)
    intent = Intent((Unit(),), A.TERRANBUILD_SENSORTOWER, Point2((50, 60)))
    guard.accepted(0, intent)
    bot.time = .5
    assert not observe(bot).allowed("SENSORTOWER")
    bot.time = 6
    assert observe(bot).allowed("SENSORTOWER")  # No order or foundation ever materialized.


def test_lifted_unfinished_and_duplicate_command_centers_do_not_inflate_allowance():
    bot = world(Unit(U.ORBITALCOMMAND, tag=101, position=(56, 50), is_structure=True),
                Unit(U.COMMANDCENTERFLYING, tag=102, position=(100, 50), is_structure=True, is_flying=True),
                Unit(U.COMMANDCENTER, tag=103, position=(140, 50), is_structure=True, is_ready=False),
                tower())
    guard = observe(bot)
    assert len(guard.bases) == 1 and not guard.allowed("SENSORTOWER")
    bot.structures[3].is_ready = True
    assert len(observe(bot).bases) == 2


def test_sensor_coverage_uses_full_owned_radar_diameters_and_expansion_sites():
    bot = world(Unit(U.COMMANDCENTER, tag=101, position=(90, 50), is_structure=True),
                tower((50, 60), radar_range=25))
    guard = observe(bot)
    assert guard.allowed("SENSORTOWER")
    assert not guard.site_allowed("SENSORTOWER", Point2((51, 55)))  # Same base.
    assert not guard.site_allowed("SENSORTOWER", Point2((90, 60)))  # Outside first radius, but overlaps.
    assert guard.site_allowed("SENSORTOWER", Point2((100, 60)))  # Centers exactly two radii apart.
    assert not guard.site_allowed("SENSORTOWER", Point2((130, 60)))  # Too far from any established base.


@pytest.mark.parametrize("radius", [None, 0, -1, float("nan"), float("inf")])
def test_missing_owned_radar_radius_blocks_additional_sensors_without_guessing(radius):
    bot = world(Unit(U.COMMANDCENTER, tag=101, position=(120, 50), is_structure=True),
                tower(radar_range=radius))
    guard = observe(bot)
    assert not guard.allowed("SENSORTOWER")
    assert guard.last_denial["reason"] == "owned_radar_radius_unobserved"
    assert not guard.site_allowed("SENSORTOWER", Point2((120, 60)))


def test_prior_owned_radius_remains_available_for_new_unfinished_tower():
    bot = world(Unit(U.COMMANDCENTER, tag=101, position=(120, 50), is_structure=True),
                tower(radar_range=25))
    guard = observe(bot)
    bot.structures[-1] = tower(radar_range=0, is_ready=False)
    assert observe(bot).allowed("SENSORTOWER")
    assert guard.site_allowed("SENSORTOWER", Point2((120, 60)))


def test_two_engineering_bays_allow_parallel_upgrades_but_no_third():
    bot = world(Unit(U.ENGINEERINGBAY, tag=201, is_structure=True))
    guard = observe(bot)
    assert guard.allowed("ENGINEERINGBAY")
    bot.units = [Unit(U.SCV, _proto=NS(orders=[build_order(U.ENGINEERINGBAY, (60, 60))]))]
    assert not observe(bot).allowed("ENGINEERINGBAY")
    assert guard.last_denial["reason"] == "two_upgrade_bays_reserved"
    bot.units.clear()
    assert observe(bot).allowed("ENGINEERINGBAY")


def test_turrets_allow_two_spaced_sites_per_base_and_reopen_at_expansion():
    bot = world(Unit(U.MISSILETURRET, tag=201, position=(50, 60), is_structure=True))
    guard = observe(bot)
    assert guard.allowed("MISSILETURRET")
    assert not guard.site_allowed("MISSILETURRET", Point2((50, 62)))
    assert guard.site_allowed("MISSILETURRET", Point2((54, 60)))
    bot.structures.append(Unit(U.MISSILETURRET, tag=202, position=(54, 60), is_structure=True))
    assert not observe(bot).allowed("MISSILETURRET")
    bot.structures.append(Unit(U.COMMANDCENTER, tag=101, position=(100, 50), is_structure=True))
    assert observe(bot).allowed("MISSILETURRET")
    assert not guard.site_allowed("MISSILETURRET", Point2((45, 60)))
    assert guard.site_allowed("MISSILETURRET", Point2((100, 60)))


def test_defenses_left_at_destroyed_expansion_do_not_consume_main_base_quota():
    bot = world(tower((130, 130), radar_range=25),
                Unit(U.MISSILETURRET, tag=201, position=(132, 130), is_structure=True),
                Unit(U.MISSILETURRET, tag=202, position=(136, 130), is_structure=True))
    guard = observe(bot)
    assert guard.allowed("SENSORTOWER") and guard.allowed("MISSILETURRET")
    assert guard.site_allowed("SENSORTOWER", Point2((50, 60)))
    assert guard.site_allowed("MISSILETURRET", Point2((50, 60)))


def sensor_mask_world(*structures):
    bot = world(*structures)
    bot.units = [Unit(U.SCV, abilities=[A.TERRANBUILD_SENSORTOWER])]
    bot.can_afford = lambda kind: kind == U.SENSORTOWER
    return bot


def test_mask_drops_redundant_build_before_any_placement_query():
    bot = sensor_mask_world(tower())

    async def forbidden(*_):
        pytest.fail("Redundant sensor must not query any placement")

    bot.can_place = forbidden
    mask = asyncio.run(legal_action_mask(bot))
    index = bot.spec.action_names.index("build_sensortower")
    assert not mask[index] and index not in bot._action_context
    assert bot._infrastructure_guard.summary()["denied_action_opportunities"] == {"build_sensortower": 1}


def test_mask_filters_each_site_so_existing_main_sensor_does_not_hide_valid_expansion():
    bot = sensor_mask_world(Unit(U.COMMANDCENTER, tag=101, position=(90, 50), is_structure=True),
                            tower((50, 60), radar_range=25))
    queries = []

    async def query(ability, points):
        queries.extend(points)
        assert all(bot._infrastructure_guard.site_allowed("SENSORTOWER", point) for point in points)
        return [True] * len(points)

    bot.can_place = query
    mask = asyncio.run(legal_action_mask(bot))
    index = bot.spec.action_names.index("build_sensortower")
    assert mask[index] and queries
    intent = bot._action_context[index]
    assert intent.target.distance_to(bot.structures[-1].position) >= 50
    assert intent.target.distance_to(bot.structures[1].position) <= 18
    assert not bot.fairplay.audit  # Mask construction did not replace a policy action or issue commands.


def test_guarded_placement_remains_fog_limited_and_does_not_read_global_radar():
    bot = sensor_mask_world()

    class ForbiddenRadar:
        def __iter__(self):
            pytest.fail("Global radar observations can include enemy rings")

    bot.state.observation_raw = NS(radar=ForbiddenRadar())
    bot.is_visible = lambda point: False

    async def forbidden(*_):
        pytest.fail("No placement queries in fog")

    bot.can_place = forbidden
    mask = asyncio.run(legal_action_mask(bot))
    assert not mask[bot.spec.action_names.index("build_sensortower")]
    assert bot._infrastructure_guard.last_denial["reason"] == "no_nonredundant_visible_placement"


def test_accepted_normal_budget_input_creates_pending_infrastructure_reservation():
    bot = sensor_mask_world()
    mask = asyncio.run(legal_action_mask(bot))
    index = bot.spec.action_names.index("build_sensortower")
    assert mask[index]
    assert asyncio.run(bot.fairplay.issue(bot, bot._action_context[index]))
    assert len(bot._infrastructure_guard.reservations) == 1
    assert bot.fairplay.audit[0]["result"] == [1]
    bot.time = .2
    assert not asyncio.run(legal_action_mask(bot))[index]


def test_rejected_budget_input_does_not_reserve_construction():
    bot = sensor_mask_world()
    asyncio.run(legal_action_mask(bot))
    bot.client.codes = [2]
    index = bot.spec.action_names.index("build_sensortower")
    assert not asyncio.run(bot.fairplay.issue(bot, bot._action_context[index]))
    assert not bot._infrastructure_guard.reservations
