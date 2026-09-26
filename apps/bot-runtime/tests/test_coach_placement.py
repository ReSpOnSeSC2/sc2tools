import asyncio
import math
from types import SimpleNamespace as NS

import pytest
from sc2.ids.ability_id import AbilityId as A
from sc2.ids.unit_typeid import UnitTypeId as U
from sc2.position import Point2

from pluto_sc2 import sc2_adapter
from pluto_sc2.coach_placement import LocalEscapeGrid, candidate_allowed, candidate_points, layout_allowed
from pluto_sc2.fairplay import FairPlayController


def unit(kind, position, **changes):
    fields = dict(type_id=kind, position=Point2(position), is_structure=True,
                  is_flying=False, is_visible=True, is_snapshot=False)
    fields.update(changes)
    return NS(**fields)


def world():
    return NS(units=[], structures=[], enemy_units=[], enemy_structures=[],
              mineral_field=[], vespene_geyser=[], _public_sites=[],
              game_data=NS(units={}), is_visible=lambda _: True,
              fairplay=NS(on_screen=lambda _: True, camera_center=Point2((50, 50))))


@pytest.mark.parametrize("resource_width", [2, 3])
def test_building_cannot_obstruct_mining_lane_but_side_site_is_allowed(resource_width):
    layout = dict(bases=[Point2((50, 50))], resources=[(Point2((60, 50)), resource_width)])
    assert not layout_allowed(Point2((55, 50)), 2, **layout)
    assert layout_allowed(Point2((54, 56)), 2, **layout)


def test_expansion_footprint_rejects_overlap_even_when_center_is_outside_site():
    assert not layout_allowed(Point2((53, 50)), 2, expansions=[Point2((50, 50))])
    assert layout_allowed(Point2((54, 50)), 2, expansions=[Point2((50, 50))])


def test_no_cross_map_mining_corridor_is_inferred():
    assert layout_allowed(Point2((70, 50)), 2, bases=[Point2((50, 50))],
                          resources=[(Point2((90, 50)), 2)])


def test_owned_assimilator_preserves_gas_lane_when_neutral_geyser_is_absent():
    bot = world()
    bot.structures = [unit(U.NEXUS, (50, 50)), unit(U.ASSIMILATOR, (60, 50))]
    assert not candidate_allowed(bot, U.PYLON, Point2((55, 50)), 2)
    assert candidate_allowed(bot, U.PYLON, Point2((54, 56)), 2)


def test_current_public_footprint_is_used_for_own_buildings_and_expansions():
    bot = world()
    bot.game_data.units[U.NEXUS.value] = NS(footprint_radius=3)
    bot._public_sites = [Point2((50, 50))]
    assert not candidate_allowed(bot, U.PYLON, Point2((53.75, 50)), 2)
    bot._public_sites = []
    bot.game_data.units[U.GATEWAY.value] = NS(footprint_radius=2)
    bot.structures = [unit(U.GATEWAY, (50, 50))]
    assert not candidate_allowed(bot, U.PYLON, Point2((52.75, 50)), 2)


def test_warpgate_uses_gateway_footprint_not_missing_morph_placement_radius():
    bot = world()
    bot.game_data.units[U.WARPGATE.value] = NS(footprint_radius=0)
    bot.game_data.units[U.GATEWAY.value] = NS(footprint_radius=1.5)
    bot.structures = [unit(U.WARPGATE, (50, 50))]
    assert not candidate_allowed(bot, U.PYLON, Point2((52, 50)), 2)


@pytest.mark.parametrize("kind", [None, U.NEXUS, U.ASSIMILATOR, U.STALKER, U.ZEALOT])
def test_dedicated_townhall_gas_and_warp_unit_placements_are_unchanged(kind):
    class NoObservation:
        def __getattr__(self, name):
            raise AssertionError(f"Excluded placement read {name}")

    assert candidate_allowed(NoObservation(), kind, Point2((50, 50)), 2)


def test_offscreen_own_buildings_and_hidden_snapshot_resources_are_ignored():
    bot = world()

    class Hidden:
        is_visible = False

        @property
        def position(self):
            raise AssertionError("Hidden resource geometry was read")

    class Snapshot:
        is_visible = True
        is_snapshot = True

        @property
        def position(self):
            raise AssertionError("Snapshot resource geometry was read")

    offscreen = unit(U.NEXUS, (50, 50))
    bot.structures = [offscreen]
    bot.fairplay.on_screen = lambda item: item is not offscreen
    bot.mineral_field = [Hidden(), Snapshot()]
    assert candidate_allowed(bot, U.PYLON, Point2((50, 50)), 2)


def test_resource_contents_and_building_orders_are_never_read():
    bot = world()

    class Mineral:
        position = Point2((60, 50))
        is_visible = True
        is_snapshot = False

        @property
        def mineral_contents(self):
            raise AssertionError("Resource amount was read")

    class Nexus:
        position = Point2((50, 50))
        type_id = U.NEXUS
        is_structure = True
        is_flying = False

        @property
        def orders(self):
            raise AssertionError("Structure orders were read")

    bot.structures = [Nexus()]
    bot.mineral_field = [Mineral()]
    assert not candidate_allowed(bot, U.PYLON, Point2((55, 50)), 2)


def test_adapter_filters_before_first_engine_query_and_tries_alternative(monkeypatch):
    bot = world()
    queried = []
    inspected = []
    monkeypatch.setattr(sc2_adapter, "_visible_footprint", lambda _, point, width: point.x >= 50)

    def allowed(kind, point, width):
        assert point.x >= 50  # Invisible candidates must not reach the hook.
        assert kind == U.PYLON and width == 2
        inspected.append(point)
        return point == Point2((52, 50))

    async def can_place(ability, points):
        queried.extend(points)
        return [True] * len(points)

    bot.placement_candidate_allowed = allowed
    bot.can_place = can_place
    assert asyncio.run(sc2_adapter._placement(bot, A.PROTOSSBUILD_PYLON)) == Point2((52, 50))
    assert inspected and queried == [Point2((52, 50))]


def test_adapter_no_hook_retains_original_first_candidate(monkeypatch):
    bot = world()
    monkeypatch.setattr(sc2_adapter, "_visible_footprint", lambda *_: True)
    queried = []

    async def can_place(ability, points):
        queried.extend(points)
        return [True] * len(points)

    bot.can_place = can_place
    assert asyncio.run(sc2_adapter._placement(bot, A.PROTOSSBUILD_PYLON)) == Point2((50, 50))
    assert len(queried) == 41


def test_no_engine_query_when_coach_rejects_all_candidates(monkeypatch):
    bot = world()
    monkeypatch.setattr(sc2_adapter, "_visible_footprint", lambda *_: True)
    bot.placement_candidate_allowed = lambda *_: False

    async def can_place(*_):
        raise AssertionError("No candidate should reach placement query")

    bot.can_place = can_place
    assert asyncio.run(sc2_adapter._placement(bot, A.PROTOSSBUILD_PYLON)) is None


@pytest.mark.parametrize("width,offset", [(2, 0), (3, .5), (4, 0)])
def test_dense_candidates_cover_bounded_correctly_aligned_one_tile_lattice(width, offset):
    center = Point2((50.1875, 50.4375))
    points = candidate_points(U.CYBERNETICSCORE, center, width)
    expected = {Point2((x + offset, y + offset)) for x in range(40, 61) for y in range(40, 61)
                if Point2((x + offset, y + offset)).distance_to(center) <= 10}
    assert set(points) == expected and len(points) == len(set(points))
    assert len(points) <= 441
    assert points == sorted(points, key=lambda p: (p.distance_to(center), p.x, p.y))


@pytest.mark.parametrize("kind", [None, U.NEXUS, U.ASSIMILATOR, U.STALKER, U.ZEALOT])
def test_dense_search_does_not_extend_dedicated_expansion_gas_or_warp_placements(kind):
    assert candidate_points(kind, Point2((50, 50)), 3) == []


def test_dense_gap_is_found_after_all_original_rays_fail_engine_query(monkeypatch):
    bot = world()
    queried = []
    gap = Point2((53.5, 52.5))  # Neither cardinal nor diagonal even-radius ray.
    monkeypatch.setattr(sc2_adapter, "_visible_footprint", lambda _, p, width: p.x >= 50)
    bot.placement_candidate_points = candidate_points

    def allowed(kind, point, width):
        assert point.x >= 50  # Proposal generation does not bypass visibility.
        return True

    async def can_place(ability, points):
        queried.extend(points)
        return [point == gap for point in points]

    bot.placement_candidate_allowed = allowed
    bot.can_place = can_place
    assert asyncio.run(sc2_adapter._placement(bot, A.PROTOSSBUILD_CYBERNETICSCORE)) == gap
    assert len(queried) == len(set(queried)) and gap in queried
    del bot.placement_candidate_points
    queried.clear()
    assert asyncio.run(sc2_adapter._placement(bot, A.PROTOSSBUILD_CYBERNETICSCORE)) is None
    assert gap not in queried


def test_v18_observed_main_geometry_contains_an_off_ray_core_gap():
    # Current own positions and camera at165.357s in v18. This tests only that
    # observed subset of layout geometry; mineral, power and live placement
    # remain unproven until the adapter queries the next native observation.
    center = Point2((142.1875, 148.4375))
    nexus, pylon, gateway, gas = map(Point2, [(143.5, 149.5), (145, 145),
                                           (141.5, 145.5), (150.5, 145.5)])
    gap = Point2((149.5, 149.5))
    assert gap in candidate_points(U.CYBERNETICSCORE, center, 3)
    original = [center] + [center.offset(delta) for radius in (2, 4, 6, 8, 10)
                          for delta in ((radius, 0), (-radius, 0), (0, radius), (0, -radius),
                                        (radius, radius), (radius, -radius),
                                        (-radius, radius), (-radius, -radius))]
    assert gap not in {Point2((math.floor(p.x) + .5, math.floor(p.y) + .5)) for p in original}
    assert layout_allowed(gap, 3, structures=[(nexus, 5), (pylon, 2), (gateway, 3), (gas, 3)],
                          resources=[(gas, 3)], bases=[nexus], expansions=[nexus])
    assert abs(gap.x - center.x) + 1.5 < 12
    assert abs(gap.y - center.y) + 1.5 < 6.75


def square_cells(left=130, right=148, bottom=138, top=156):
    cells = [Point2((x / 2, y / 2)) for x in range(left * 2, right * 2 + 1)
             for y in range(bottom * 2, top * 2 + 1)]
    perimeter = [p for p in cells if p.x in {left, right} or p.y in {bottom, top}]
    return cells, perimeter


def test_v20_last_building_cannot_close_observed_stalkers_inside_two_tile_pocket():
    # V20 main: the west Gateway closed the other three observed sides of
    # x137..139,y145..147. Both recorded Stalker positions must keep an exit.
    walls = [(Point2((137.5, 148.5)), 3), (Point2((138, 144)), 2), (Point2((140, 146)), 2)]
    units = [Point2((137.4375, 145.4331)), Point2((137.4375, 146.5625))]
    grid = LocalEscapeGrid(*square_cells(), occupied=walls, ground_units=units)
    assert len(grid.groups) == 2  # The pre-placement proof has real anchors.
    assert not grid.allows(Point2((135.5, 145.5)), 3, new_producer=True)
    assert grid.allows(Point2((132, 141)), 2)


def test_v20_producer_portal_cannot_become_pocket_even_before_army_spawns():
    gateway = (Point2((137.5, 148.5)), 3)
    grid = LocalEscapeGrid(*square_cells(), occupied=[gateway, (Point2((138, 144)), 2),
                          (Point2((140, 146)), 2)], producers=[gateway])
    assert grid.producer_cells
    assert not grid.allows(Point2((135.5, 145.5)), 3, new_producer=True)


def test_adjacent_production_row_keeps_legitimate_open_exit():
    existing = [(Point2((10.5, 10.5)), 3), (Point2((13.5, 10.5)), 3)]
    grid = LocalEscapeGrid(*square_cells(0, 24, 0, 20), occupied=existing,
                           producers=existing, ground_units=[Point2((13.5, 13.5))])
    assert grid.allows(Point2((16.5, 10.5)), 3, new_producer=True)


def test_existing_disconnected_space_is_not_misreported_as_new_enclosure():
    walls = [(Point2((137.5, 148.5)), 3), (Point2((138, 144)), 2),
             (Point2((140, 146)), 2), (Point2((135.5, 145.5)), 3)]
    grid = LocalEscapeGrid(*square_cells(), occupied=walls, ground_units=[Point2((138, 146))])
    assert not grid.groups  # There was no visible exit before this proposal.
    assert grid.allows(Point2((132, 141)), 2)


def test_new_ground_producer_must_have_a_clear_local_exit():
    walls = [(Point2((10, 5)), 6), (Point2((10, 15)), 6),
             (Point2((5, 10)), 6), (Point2((15, 10)), 6)]
    grid = LocalEscapeGrid(*square_cells(0, 20, 0, 20), occupied=walls)
    assert not grid.allows(Point2((10, 10)), 3, new_producer=True)


def test_native_escape_grid_reads_only_visible_pathing_and_caches_one_observation():
    bot = world()
    bot.state = NS(game_loop=10)
    bot.game_info = NS(playable_area=NS(x=0, y=0, width=100, height=100), pathing_grid=object())
    bot.fairplay.on_screen = lambda p: abs(p.x - 50) < 11.8 and abs(p.y - 50) < 6.55
    bot.is_visible = lambda p: p.x < 52
    checked = []

    def pathable(point):
        assert bot.fairplay.on_screen(point) and bot.is_visible(point)
        checked.append(point)
        return True

    bot.in_pathing_grid = pathable
    assert candidate_allowed(bot, U.PYLON, Point2((48, 50)), 2)
    first_count = len(checked)
    assert first_count > 0
    assert candidate_allowed(bot, U.PYLON, Point2((49, 50)), 2)
    assert len(checked) == first_count
    bot.state.game_loop += 1
    assert candidate_allowed(bot, U.PYLON, Point2((48, 50)), 2)
    assert len(checked) > first_count


def test_missing_or_fogged_cells_cannot_be_used_as_an_exit():
    cells, perimeter = square_cells(0, 12, 0, 12)
    # Only the east edge is observed. Closing its throat cannot escape through
    # the unobserved west/north/south perimeter or jump a diagonal corner.
    cells = [p for p in cells if 4 <= p.y <= 8 and p.x >= 4]
    perimeter = [p for p in perimeter if p in cells and p.x == 12]
    grid = LocalEscapeGrid(cells, perimeter, ground_units=[Point2((5, 6))])
    assert grid.groups
    assert not grid.allows(Point2((9, 6)), 3)


def test_no_visible_perimeter_is_explicitly_unproven_not_a_global_route_claim():
    cells, _ = square_cells(4, 8, 4, 8)
    grid = LocalEscapeGrid(cells, [], ground_units=[Point2((5, 6))])
    assert grid.evidence_status == "unproven_no_visible_perimeter"
    assert not grid.parents and not grid.groups
    # It supplies no enclosure veto; ordinary resource/layout and engine
    # placement checks still apply at the candidate_allowed/adapter layers.
    assert grid.allows(Point2((7, 6)), 2, new_producer=True)


def test_transient_builder_can_vacate_new_footprint_but_ground_army_is_protected():
    bot = world()
    bot.state = NS(game_loop=1)
    bot.game_info = NS(playable_area=NS(x=0, y=0, width=100, height=100), pathing_grid=object())
    bot.in_pathing_grid = lambda _: True
    bot.units = [unit(U.PROBE, (50, 50), is_structure=False)]
    assert candidate_allowed(bot, U.GATEWAY, Point2((50.5, 50.5)), 3)
    assert not bot._coach_placement_escape_grid[1].groups
    bot.units = [unit(U.STALKER, (50, 50), is_structure=False)]
    bot.state.game_loop += 1
    assert not candidate_allowed(bot, U.GATEWAY, Point2((50.5, 50.5)), 3)


def v21_gateway_scene():
    """Observed v21 geometry, with a synthetic visible terrain mask.

    Selection98/command99 requested Gateway[139.5,151.5] at160.714/161.071s.
    Report160.357 shows the Nexus, first Gateway and main gas below. The Pylon
    was just outside that camera (center140,148), so it is deliberately absent
    from current-own inputs. Its visible edge blocks the synthetic terrain.
    This fixture is not a captured native pathing grid or a new engine result.
    """
    bot = world()
    bot.state = NS(game_loop=3592)
    bot.game_info = NS(playable_area=NS(x=0, y=0, width=200, height=200), pathing_grid=object())
    bot.fairplay = FairPlayController(camera_center=(142.1875, 154.6875))
    bot.structures = [unit(U.NEXUS, (143.5, 149.5), tag=4350017537, is_on_screen=True),
                      unit(U.GATEWAY, (137.5, 148.5), tag=4357881857, is_on_screen=True),
                      unit(U.ASSIMILATOR, (141.5, 156.5), tag=4360765441, is_on_screen=True)]
    occupied = [(Point2((143.5, 149.5)), 5), (Point2((137.5, 148.5)), 3),
                (Point2((141.5, 156.5)), 3), (Point2((140, 148)), 2)]
    checked = []

    def pathable(point):
        assert bot.fairplay.on_screen(point) and bot.is_visible(point)
        checked.append(point)
        return not any(abs(point.x - center.x) < width / 2 and abs(point.y - center.y) < width / 2
                       for center, width in occupied)

    bot.in_pathing_grid = pathable
    return bot, checked


def test_v21_one_tile_spawn_pocket_is_rejected_before_any_army_exists():
    bot, checked = v21_gateway_scene()
    target = Point2((139.5, 151.5))
    assert not candidate_allowed(bot, U.GATEWAY, target, 3)
    large = bot._coach_placement_escape_grid[1]
    small = large.thin_pocket_grid
    # Reproduce the actual blind spot: large-unit erosion removed this pocket
    # entirely, while the small-unit portal remains and must keep an exit.
    assert large.allows(target, 3, new_producer=True)
    assert not small.allows(target, 3, new_producer=True)
    assert (280, 299) in small.cells  # World[140,149.5], inside future2x1 pocket.
    assert (280, 299) not in large.cells
    assert not bot.units and checked


def test_dual_clearance_still_permits_adjacent_open_production_row():
    existing = [(Point2((10.5, 10.5)), 3), (Point2((13.5, 10.5)), 3)]
    for radius in (.25, .75):
        grid = LocalEscapeGrid(*square_cells(0, 24, 0, 20), occupied=existing,
                               producers=existing, clearance=radius)
        assert grid.allows(Point2((16.5, 10.5)), 3, new_producer=True)


def test_unproven_native_perimeter_requires_two_tile_building_clearance():
    bot = world()
    bot.state = NS(game_loop=1)
    bot.game_info = NS(playable_area=NS(x=0, y=0, width=100, height=100), pathing_grid=object())
    bot.in_pathing_grid = lambda _: False  # Neither graph establishes any exit.
    bot.structures = [unit(U.GATEWAY, (50.5, 50.5))]
    assert not candidate_allowed(bot, U.GATEWAY, Point2((53.5, 50.5)), 3)
    assert candidate_allowed(bot, U.GATEWAY, Point2((55.5, 50.5)), 3)
    large = bot._coach_placement_escape_grid[1]
    assert large.evidence_status == large.thin_pocket_grid.evidence_status == "unproven_no_visible_perimeter"
