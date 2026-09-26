import asyncio
from types import SimpleNamespace as NS

from sc2.ids.ability_id import AbilityId as A
from sc2.ids.unit_typeid import UnitTypeId as U
from sc2.position import Point2

from pluto_sc2.adversary_placement import (
    QUERY_BATCH, building_candidates, expansion_candidates, find_placement,
    footprint_width, site_clear, visible_footprint,
)


def unit(kind, position, *, tag=1, **values):
    result = dict(type_id=kind, position=Point2(position), tag=tag, is_flying=False,
                  is_ready=True, is_visible=True, is_snapshot=False, rally_targets=[])
    result.update(values)
    return NS(**result)


def world():
    bot = NS(structures=[], mineral_field=[], vespene_geyser=[], expansion_locations_list=[],
             game_data=NS(units={}), game_info=NS(playable_area=NS(x=0, y=0, width=200, height=200)),
             is_visible=lambda _: True, queries=[])

    async def query(ability, points):
        bot.queries.append((ability, list(points)))
        return [True] * len(points)

    bot.can_place = query
    return bot


def test_dense_candidates_fill_holes_between_old_rays_and_expand_beyond_fourteen():
    candidates = building_candidates(Point2((50, 50)), 2)
    assert Point2((54, 52)) in candidates  # Old cardinal/diagonal sampling misses this.
    assert Point2((74, 50)) in candidates
    assert len(candidates) == len(set(candidates))
    assert candidates == building_candidates(Point2((50, 50)), 2)
    assert all(point.x % 1 == 0 and point.y % 1 == 0 for point in candidates)
    assert all(point.x % 1 == .5 and point.y % 1 == .5 for point in building_candidates((50, 50), 3))


def test_depot_fallback_uses_actual_two_tile_footprint():
    assert footprint_width(U.SUPPLYDEPOT) == 2
    assert footprint_width(U.BARRACKS) == 3
    assert footprint_width(U.COMMANDCENTER) == 5
    assert footprint_width(U.HATCHERY) == 5


def test_resolver_finds_legal_hole_that_old_star_search_never_queried():
    bot = world()
    only_free = Point2((54, 52))

    async def query(ability, points):
        bot.queries.append((ability, list(points)))
        return [point == only_free for point in points]

    bot.can_place = query
    assert asyncio.run(find_placement(bot, A.TERRANBUILD_SUPPLYDEPOT, U.SUPPLYDEPOT, (50, 50))) == only_free


def test_resolver_reaches_outer_ring_and_bounds_query_batch_size():
    bot = world()
    only_free = Point2((76, 54))

    async def query(ability, points):
        bot.queries.append((ability, list(points)))
        return [point == only_free for point in points]

    bot.can_place = query
    assert asyncio.run(find_placement(bot, A.TERRANBUILD_SUPPLYDEPOT, U.SUPPLYDEPOT, (50, 50))) == only_free
    assert all(len(points) <= QUERY_BATCH for _, points in bot.queries)


def test_resource_and_mineral_traffic_corridors_remain_open():
    resources = [(Point2((60, 50)), 2)]
    lanes = [(Point2((50, 50)), Point2((60, 50)))]
    assert not site_clear(Point2((55, 50)), 2, resources=resources, corridors=lanes)
    assert not site_clear(Point2((59, 52)), 2, resources=resources, corridors=lanes)
    assert site_clear(Point2((54, 56)), 2, resources=resources, corridors=lanes)


def test_existing_addon_socket_and_observed_rally_lane_are_not_consumed_by_depots():
    bot = world()
    producer = unit(U.BARRACKS, (50.5, 50.5), rally_targets=[NS(point=Point2((50.5, 40.5)), tag=None)])
    bot.structures = [producer]
    forbidden = {Point2((52, 50)), Point2((50, 46)), Point2((50, 50))}
    asyncio.run(find_placement(bot, A.TERRANBUILD_SUPPLYDEPOT, U.SUPPLYDEPOT, (50, 50)))
    assert all(point not in forbidden for _, points in bot.queries for point in points)


def test_townhalls_use_resource_sites_and_skip_unfinished_owned_bases():
    bot = world()
    bot.structures = [unit(U.COMMANDCENTER, (50.5, 50.5)),
                      unit(U.COMMANDCENTER, (90.5, 50.5), tag=2, is_ready=False)]
    bot.expansion_locations_list = [Point2((50.5, 50.5)), Point2((90.5, 50.5)), Point2((130.5, 50.5))]
    result = asyncio.run(find_placement(bot, A.TERRANBUILD_COMMANDCENTER, U.COMMANDCENTER, (50.5, 50.5)))
    assert result == Point2((130.5, 50.5))
    assert [point for _, points in bot.queries for point in points] == [result]


def test_no_arbitrary_main_base_townhall_when_no_resource_site_is_known():
    bot = world()
    assert asyncio.run(find_placement(bot, A.ZERGBUILD_HATCHERY, U.HATCHERY, (50, 50))) is None
    assert not bot.queries


def test_expansion_order_is_nearest_owned_base_and_deterministic():
    locations = [Point2((90.5, 50.5)), Point2((20.5, 50.5)), Point2((50.5, 50.5))]
    bases = [unit(U.COMMANDCENTER, (50.5, 50.5))]
    assert expansion_candidates(locations, bases, (50.5, 50.5)) == [Point2((20.5, 50.5)), Point2((90.5, 50.5))]


def test_fogged_expansion_and_footprints_never_trigger_placement_queries():
    bot = world()
    bot.expansion_locations_list = [Point2((90.5, 50.5))]
    bot.is_visible = lambda point: point.x < 60
    assert asyncio.run(find_placement(bot, A.TERRANBUILD_COMMANDCENTER, U.COMMANDCENTER, (50, 50))) is None
    assert not bot.queries
    bot.is_visible = lambda _: False
    assert asyncio.run(find_placement(bot, A.TERRANBUILD_SUPPLYDEPOT, U.SUPPLYDEPOT, (50, 50))) is None
    assert not bot.queries


def test_production_query_and_reserved_addon_query_both_require_visible_footprints():
    bot = world()
    bot.is_visible = lambda point: point.x < 50

    async def query(ability, points):
        width = 2 if ability == A.TERRANBUILD_SUPPLYDEPOT else 3
        assert all(visible_footprint(point, width, bot.is_visible, bot.game_info.playable_area) for point in points)
        bot.queries.append((ability, list(points)))
        return [True] * len(points)

    bot.can_place = query
    result = asyncio.run(find_placement(bot, A.TERRANBUILD_BARRACKS, U.BARRACKS, (50, 50)))
    assert result is not None
    assert {ability for ability, _ in bot.queries} == {A.TERRANBUILD_BARRACKS, A.TERRANBUILD_SUPPLYDEPOT}


def test_blocked_addon_space_rejects_otherwise_legal_production_sites():
    bot = world()

    async def query(ability, points):
        return [ability != A.TERRANBUILD_SUPPLYDEPOT] * len(points)

    bot.can_place = query
    assert asyncio.run(find_placement(bot, A.TERRANBUILD_FACTORY, U.FACTORY, (50, 50))) is None


def test_footprint_visibility_checks_interior_tiles_not_only_center_or_corners():
    area = NS(x=0, y=0, width=100, height=100)
    assert not visible_footprint(Point2((50.5, 50.5)), 5,
                                 lambda point: point != Point2((49.5, 49.5)), area)
    assert not visible_footprint(Point2((0, 0)), 2, lambda _: True, area)


def test_placement_never_reads_hidden_enemy_or_dynamic_global_pathing_data():
    class GuardedWorld:
        @property
        def enemy_structures(self):
            raise AssertionError("Hidden enemies forbidden")

        @property
        def enemy_units(self):
            raise AssertionError("Hidden enemies forbidden")

    bot = GuardedWorld()
    template = world()
    bot.__dict__.update(template.__dict__)
    assert asyncio.run(find_placement(bot, A.TERRANBUILD_SUPPLYDEPOT, U.SUPPLYDEPOT, (50, 50))) is not None
