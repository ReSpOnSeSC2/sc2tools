import asyncio
from types import SimpleNamespace as NS

import pytest
from s2clientprotocol import sc2api_pb2 as api, query_pb2 as query
from sc2.ids.ability_id import AbilityId as A
from sc2.ids.unit_typeid import UnitTypeId as U
from sc2.position import Point2

from pluto_sc2.adversary_addons import QUERY_BATCH, reusable_addon_site, verified_addon_point


def unit(kind, position=(50, 50), tag=1, **values):
    fields = dict(type_id=kind, position=Point2(position), tag=tag, is_flying=False,
                  is_ready=True, is_visible=True, is_snapshot=False, is_mine=True,
                  add_on_tag=0, orders=[])
    fields.update(values)
    return NS(**fields)


def world(*structures):
    bot = NS(structures=list(structures), game_data=NS(units={}, abilities={}),
             game_info=NS(playable_area=NS(x=0, y=0, width=1000, height=1000)),
             is_visible=lambda _: True, queries=[])

    async def query(ability, points):
        bot.queries.append((ability, list(points)))
        return [True] * len(points)

    bot.can_place = query
    return bot


def resolve(bot, producer=U.FACTORY, origin=(40, 50), family=None):
    return asyncio.run(reusable_addon_site(bot, producer, origin, family))


@pytest.mark.parametrize("addon_type", [U.TECHLAB, U.REACTOR, U.BARRACKSTECHLAB,
                                       U.BARRACKSREACTOR, U.FACTORYTECHLAB,
                                       U.FACTORYREACTOR, U.STARPORTTECHLAB,
                                       U.STARPORTREACTOR])
@pytest.mark.parametrize("producer,ability", [(U.BARRACKS, A.LAND_BARRACKS),
                                            (U.FACTORY, A.LAND_FACTORY),
                                            (U.STARPORT, A.LAND_STARPORT)])
def test_cross_producer_reuse_queries_actual_land_at_exact_offset(addon_type, producer, ability):
    addon = unit(addon_type)
    bot = world(addon)
    target = Point2((47.5, 50.5))
    assert resolve(bot, producer) == (addon, target)
    assert bot.queries == [(ability, [target])]


def test_attached_addon_is_excluded_even_if_producer_is_far_from_socket():
    addon = unit(U.TECHLAB)
    # Metadata association must block reuse independently of geometric overlap.
    producer = unit(U.BARRACKS, (80.5, 80.5), tag=2, add_on_tag=addon.tag)
    bot = world(addon, producer)
    assert resolve(bot) is None
    assert not bot.queries


def test_flying_producers_stale_addon_tag_does_not_claim_detached_addon():
    addon = unit(U.TECHLAB)
    producer = unit(U.BARRACKSFLYING, (80.5, 80.5), tag=2,
                    add_on_tag=addon.tag, is_flying=True)
    assert resolve(world(addon, producer))[0] is addon


@pytest.mark.parametrize("values", [{"is_mine": False}, {"is_ready": False},
                                   {"is_visible": False}, {"is_snapshot": True}])
def test_not_owned_ready_current_visible_addons_are_not_queried(values):
    bot = world(unit(U.TECHLAB, **values))
    assert resolve(bot) is None
    assert not bot.queries


def test_requested_addon_family_filters_incompatible_type():
    reactor = unit(U.STARPORTREACTOR, (50, 50), tag=1)
    lab = unit(U.BARRACKSTECHLAB, (60, 50), tag=2)
    bot = world(reactor, lab)
    assert resolve(bot, family="TECHLAB")[0] is lab
    assert resolve(bot, family="reactor")[0] is reactor


def test_closest_legal_site_wins_with_deterministic_tag_tiebreak():
    near = unit(U.TECHLAB, (50, 50), tag=3)
    far = unit(U.REACTOR, (80, 50), tag=2)
    bot = world(far, near)
    assert resolve(bot)[0] is near


@pytest.mark.parametrize("hidden_point", [Point2((46.5, 49.5)), Point2((50.5, 50.5))])
def test_fogged_body_or_addon_interior_prevents_all_queries(hidden_point):
    bot = world(unit(U.TECHLAB))
    bot.is_visible = lambda point: point != hidden_point
    assert resolve(bot) is None
    assert not bot.queries


def test_out_of_bounds_body_never_queries():
    bot = world(unit(U.TECHLAB, (3, 50)))
    assert resolve(bot) is None
    assert not bot.queries


def test_own_grounded_body_collision_never_queries():
    bot = world(unit(U.TECHLAB), unit(U.FACTORY, (48.5, 50.5), tag=2))
    assert resolve(bot) is None
    assert not bot.queries


def test_engine_rejection_tries_next_candidate_without_using_depot_queries():
    near = unit(U.TECHLAB, (50, 50), tag=1)
    far = unit(U.TECHLAB, (80, 50), tag=2)
    bot = world(near, far)

    async def query(ability, points):
        bot.queries.append((ability, list(points)))
        return [point.x > 60 for point in points]

    bot.can_place = query
    assert resolve(bot)[0] is far
    assert all(ability == A.LAND_FACTORY for ability, _ in bot.queries)


def test_all_rejected_landing_candidates_return_none():
    bot = world(unit(U.TECHLAB))

    async def query(ability, points):
        return [False] * len(points)

    bot.can_place = query
    assert resolve(bot) is None


@pytest.mark.parametrize("ability", [A.LAND_BARRACKS, A.LAND_FACTORY, A.LAND_STARPORT, A.LAND])
def test_another_flying_producer_landing_claim_blocks_the_site(ability):
    other = unit(U.BARRACKSFLYING, (80, 80), tag=2, is_flying=True,
                 orders=[NS(ability=NS(id=ability), target=Point2((47.5, 50.5)))])
    bot = world(unit(U.TECHLAB), other)
    assert resolve(bot) is None
    assert not bot.queries


def test_public_ability_alias_and_own_current_landing_order():
    origin = unit(U.FACTORYFLYING, (40, 50), tag=2, is_flying=True,
                  orders=[NS(ability=NS(id=A.LAND), target=Point2((47.5, 50.5)))])
    addon = unit(U.TECHLAB)
    bot = world(addon, origin)
    bot.game_data.abilities = {A.LAND_FACTORY.value: NS(id=A.LAND)}
    assert resolve(bot, origin=origin)[0] is addon
    # With another caller, that same pending landing reserves the footprint.
    assert resolve(bot) is None


def test_bounded_query_batches_and_all_rejected_first_batch():
    addons = [unit(U.TECHLAB, (20 + index * 6, 50), tag=index + 1)
              for index in range(QUERY_BATCH + 3)]
    bot = world(*addons)

    async def query(ability, points):
        bot.queries.append((ability, list(points)))
        return [len(bot.queries) > 1] * len(points)

    bot.can_place = query
    assert resolve(bot, origin=(0, 50))[0] is addons[QUERY_BATCH]
    assert [len(points) for _, points in bot.queries] == [QUERY_BATCH, 3]


def test_no_hidden_enemy_or_dynamic_pathing_reads_or_orders():
    class GuardedBot:
        @property
        def enemy_structures(self):
            raise AssertionError("Enemy state must not be read")

        @property
        def enemy_units(self):
            raise AssertionError("Enemy state must not be read")

        @property
        def client(self):
            raise AssertionError("Resolver must never issue an order")

    bot = GuardedBot()
    bot.__dict__.update(world(unit(U.TECHLAB)).__dict__)
    assert resolve(bot) is not None


@pytest.mark.parametrize("producer,family", [(U.COMMANDCENTER, None), (U.FACTORY, "INVALID")])
def test_invalid_resolver_parameters_fail_explicitly(producer, family):
    with pytest.raises(ValueError):
        resolve(world(), producer, family=family)


def point_world(producer, results=(1,)):
    bot = world(producer)
    bot.game_data.abilities[A.BUILD_TECHLAB_FACTORY.value] = NS(_proto=NS(target=5))
    bot.point_queries = []
    remaining = iter(results)

    async def execute(**kwargs):
        bot.point_queries.append(kwargs["query"])
        return api.Response(query=query.ResponseQuery(placements=[
            query.ResponseQueryBuildingPlacement(result=next(remaining))]))

    bot.client = NS(_execute=execute)
    return bot


def test_point_required_addon_uses_exact_source_aware_producer_anchor():
    factory = unit(U.FACTORY, (50.5, 50.5), tag=10)
    bot = point_world(factory)
    assert asyncio.run(verified_addon_point(bot, factory, A.BUILD_TECHLAB_FACTORY)) == factory.position
    request = bot.point_queries[0]
    assert not request.ignore_resource_requirements
    placement = request.placements[0]
    assert placement.ability_id == 454 and placement.placing_unit_tag == 10
    assert Point2.from_proto(placement.target_pos) == factory.position
    assert bot._addon_point_query["attempts"][0]["addon_position"] == [53, 50]


def test_blocked_anchor_uses_only_an_exactly_queried_alternative(monkeypatch):
    factory = unit(U.FACTORY, (50.5, 50.5), tag=10)
    bot, alternative = point_world(factory, (2, 1)), Point2((60.5, 60.5))

    async def place(*_):
        return alternative

    monkeypatch.setattr("pluto_sc2.adversary_addons.find_placement", place)
    assert asyncio.run(verified_addon_point(bot, factory, A.BUILD_TECHLAB_FACTORY)) == alternative
    assert len(bot.point_queries) == 2
    assert all(q.placements[0].placing_unit_tag == factory.tag for q in bot.point_queries)


def test_both_exact_addon_queries_rejected_never_exposes_target(monkeypatch):
    factory = unit(U.FACTORY, tag=10)
    bot = point_world(factory, (2, 2))

    async def place(*_):
        return Point2((60.5, 60.5))

    monkeypatch.setattr("pluto_sc2.adversary_addons.find_placement", place)
    assert asyncio.run(verified_addon_point(bot, factory, A.BUILD_TECHLAB_FACTORY)) is None
    assert len(bot.point_queries) == 2


def test_unknown_public_target_or_flying_source_cannot_use_grounded_addon_point():
    factory = unit(U.FACTORY, tag=10)
    bot = point_world(factory)
    bot.game_data.abilities[454]._proto.target = 1
    assert asyncio.run(verified_addon_point(bot, factory, A.BUILD_TECHLAB_FACTORY)) is None
    bot.game_data.abilities[454]._proto.target = 5
    factory.is_flying = True
    assert asyncio.run(verified_addon_point(bot, factory, A.BUILD_TECHLAB_FACTORY)) is None
    assert not bot.point_queries


def test_fogged_body_and_alternative_socket_are_never_queried(monkeypatch):
    factory = unit(U.FACTORY, (50.5, 50.5), tag=10)
    bot = point_world(factory)
    alternative = Point2((60.5, 60.5))
    bot.is_visible = lambda p: p.x > 55 and p.x < 62

    async def place(*_):
        return alternative  # Deliberately invalid resolver output is checked.

    monkeypatch.setattr("pluto_sc2.adversary_addons.find_placement", place)
    assert asyncio.run(verified_addon_point(bot, factory, A.BUILD_TECHLAB_FACTORY)) is None
    assert not bot.point_queries
