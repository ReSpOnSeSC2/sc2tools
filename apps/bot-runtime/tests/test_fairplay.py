"""Protocol and timing tests; live SC2 validation is a separate integration gate."""

import asyncio
from types import SimpleNamespace

import numpy as np
import pytest
from s2clientprotocol import common_pb2 as common
from s2clientprotocol import raw_pb2 as raw
from s2clientprotocol import sc2api_pb2 as api
from s2clientprotocol import spatial_pb2 as spatial
from s2clientprotocol import data_pb2 as data
from sc2.client import Client
from sc2.position import Point2

from pluto_sc2.fairplay import (
    ActionBudget, CAMERA_HEIGHT, CAMERA_WIDTH, FEATURE_CAMERA_SIZE,
    FairPlayController, HumanClient, MINIMAP_SIZE, SCREEN_SIZE, configure_interface,
    MAX_SELECTION_FAILURES, SELECTION_RETRY_SECONDS,
)


class RecordingClient:
    def __init__(self, results=(1,), failure=None):
        self.requests = []
        self.results = results
        self.failure = failure

    async def _execute(self, **kwargs):
        self.requests.append(kwargs["action"])
        if self.failure:
            raise self.failure
        return api.Response(action=api.ResponseAction(result=self.results))


def unit(tag=1, position=(50, 50), **overrides):
    fields = dict(
        tag=tag, position=Point2(position), type_id=74,
        is_visible=True, is_on_screen=True, is_mine=True, is_enemy=False,
    )
    fields.update(overrides)
    return SimpleNamespace(**fields)


def bot(*units, loop=0, client=None, selected=()):
    observation = raw.ObservationRaw(
        player=raw.PlayerRaw(camera=common.Point(x=50, y=50)),
        units=[raw.Unit(tag=item.tag, is_selected=item.tag in selected) for item in units],
    )
    return SimpleNamespace(
        time=loop / 22.4,
        client=client or RecordingClient(),
        state=SimpleNamespace(observation_raw=observation, game_loop=loop),
        game_info=SimpleNamespace(map_size=Point2((200, 100))),
        game_data=SimpleNamespace(abilities={ability: SimpleNamespace(
            _proto=data.AbilityData(ability_id=ability, available=True,
                                   target=data.AbilityData.Point, allow_minimap=True))
            for ability in (24, 25)}),
        all_units=list(units),
    )


def step(bot_state, loop, selected=()):
    bot_state.time = loop / 22.4
    bot_state.state.game_loop = loop
    for entity in bot_state.state.observation_raw.units:
        entity.is_selected = entity.tag in selected


def screen_layers(state, *, relative=0, kind=0, density=0, pixel=(64, 36), visibility=2, pathable=1):
    renders = spatial.FeatureLayers()
    for name, value in (("player_relative", relative), ("unit_type", kind), ("unit_density", density)):
        pixels = np.zeros((72, 128), dtype="<u4")
        pixels[pixel[1], pixel[0]] = value
        getattr(renders, name).CopyFrom(common.ImageData(bits_per_pixel=32,
            size=common.Size2DI(x=128, y=72), data=pixels.tobytes()))
    for name, value in (("visibility_map", visibility), ("pathable", pathable)):
        pixels = np.full((72, 128), value, dtype="<u4")
        getattr(renders, name).CopyFrom(common.ImageData(bits_per_pixel=32,
            size=common.Size2DI(x=128, y=72), data=pixels.tobytes()))
    state.state.observation = api.Observation(feature_layer_data=spatial.ObservationFeatureLayer(renders=renders))


@pytest.mark.parametrize("requested", [23, 3674])
@pytest.mark.parametrize("minimap", [False, True])
def test_ground_attack_on_own_nexus_uses_clear_screen_ordinary_attack(requested, minimap):
    async def scenario():
        source, nexus = unit(1, (48, 50)), unit(2, (50, 50), radius=2.75, is_structure=True, footprint_radius=2.5)
        state = bot(source, nexus)
        screen_layers(state, relative=1, kind=59, density=1)
        controller = FairPlayController(camera_center=(50, 50))
        assert await controller.issue(state, [source], requested, nexus.position, minimap=minimap)
        step(state, 8, selected=[source.tag])
        await controller.advance(state)
        command = state.client.requests[-1].actions[0].action_feature_layer.unit_command
        assert command.ability_id == 23
        assert command.WhichOneof("target") == "target_screen_coord"
        assert controller.audit[-1]["requested_ability"] == requested
        assert controller.audit[-1]["emitted_ability"] == 23
        assert not controller.audit[-1]["point_only_attack"]
        assert controller.audit[-1]["ground_redirect_reason"] == "occupied_screen_target"
        assert controller.audit[-1]["ground_target_safety"] == "current_visible_empty_screen"
        assert Point2(controller.audit[-1]["effective_target"]).distance_to(nexus.position) > nexus.radius
        assert controller.audit[0]["command_confirmation"] == "accepted"
    asyncio.run(scenario())


@pytest.mark.parametrize("signs", [(1, 1), (1, -1), (-1, 1), (-1, -1)])
def test_empty_feature_pixels_inside_nexus_footprint_corners_are_not_ground(signs):
    from pluto_sc2.target_geometry import clear_ground_pixel

    nexus = unit(2, (143.5, 149.5), radius=2.75, is_structure=True, footprint_radius=2.5)
    state = bot(nexus)
    screen_layers(state)  # Native v9 reported these corner pixels as empty.
    controller = FairPlayController(camera_center=nexus.position)
    target = nexus.position.offset((signs[0] * 2.21875, signs[1] * 2.34375))
    assert target.distance_to(nexus.position) > nexus.radius + 2 * 24 / 128
    assert not clear_ground_pixel(state, controller, controller.screen_point(target), SCREEN_SIZE)


def test_native_v9_offscreen_waypoint_avoids_square_nexus_footprint():
    async def scenario():
        source = unit(1, (147.46484375, 150.41015625), radius=.5)
        nexus = unit(2, (143.5, 149.5), radius=2.75, is_structure=True, footprint_radius=2.5)
        state = bot(source, nexus)
        state.state.observation_raw.player.camera.CopyFrom(common.Point(x=148.4375, y=151.5625))
        screen_layers(state)
        controller = FairPlayController(camera_center=(148.4375, 151.5625))
        target = Point2((129.89604480180662, 134.8394269223353))
        assert await controller.issue(state, [source], 23, target, minimap=True)
        step(state, 8, selected=[1])
        await controller.advance(state)
        command = controller.audit[-1]
        assert command["kind"] == "command" and command["minimap"] is False
        point = Point2(command["effective_target"])
        assert max(abs(point.x - nexus.position.x), abs(point.y - nexus.position.y)) > nexus.radius
        assert point.distance_to(target) < source.position.distance_to(target)
    asyncio.run(scenario())


@pytest.mark.parametrize("loop,tag,position,camera,target_pixel,delta", [
    (9344, 4378329089, (139.61669921875, 134.952880859375),
     (142.1875, 139.0625), (55, 59), (5, 2)),
    (10800, 4372561921, (123.932373046875, 117.42578125),
     (132.8125, 120.3125), (12, 55), (4, 4)),
    (11920, 4385931265, (134.751953125, 138.691650390625),
     (139.0625, 142.1875), (37, 58), (4, 4)),
], ids=["loop9344", "loop10800", "loop11920"])
def test_native_v13_stalker_pick_corner_is_blocked_despite_empty_features(
        loop, tag, position, camera, target_pixel, delta):
    from pluto_sc2.target_geometry import clear_ground_pixel

    # Exact command-loop current-screen observations from v13 inspection-v2.
    # All three pixels were visible/pathable with zero occupancy, yet the next
    # observation confirms an executed Attack23 bound to this friendly tag.
    friend = unit(tag, position, radius=.625)
    state = bot(friend)
    state.state.game_loop = loop
    screen_layers(state)
    controller = FairPlayController(camera_center=camera)
    pixel = common.PointI(x=target_pixel[0], y=target_pixel[1])
    center = controller.screen_point(friend)
    assert (abs(center.x - pixel.x), abs(center.y - pixel.y)) == delta
    assert sum(value * value for value in delta) ** .5 > friend.radius * 128 / 24 + 2
    assert max(delta) <= friend.radius * 128 / 24 + 2
    assert not clear_ground_pixel(state, controller, pixel, SCREEN_SIZE)


def test_native_v14_zealot_pick_boundary_rounds_outward():
    from pluto_sc2.target_geometry import clear_ground_pixel

    friend = unit(4386193409, (134.8271484375, 119.228759765625), radius=.5)
    state = bot(friend)
    screen_layers(state)
    controller = FairPlayController(camera_center=(135.9375, 120.3125))
    pixel = common.PointI(x=53, y=43)
    center = controller.screen_point(friend)
    assert (center.x, center.y) == (58, 41)
    assert max(abs(center.x - pixel.x), abs(center.y - pixel.y)) > .5 * 128 / 24 + 2
    assert not clear_ground_pixel(state, controller, pixel, SCREEN_SIZE)


@pytest.mark.parametrize("metadata", [None,
    data.AbilityData(ability_id=24, available=True, target=data.AbilityData.PointOrUnit),
    data.AbilityData(ability_id=24, available=False, target=data.AbilityData.Point),
    data.AbilityData(ability_id=24, available=True, target=data.AbilityData.Point, allow_minimap=False)])
def test_ground_attack_without_current_screen_evidence_fails_regardless_of_unused_24_metadata(metadata):
    async def scenario():
        source = unit()
        state = bot(source)
        state.game_data.abilities = {} if metadata is None else {24: SimpleNamespace(_proto=metadata)}
        controller = FairPlayController(camera_center=(50, 50))
        assert await controller.issue(state, [source], 23, Point2((150, 50)), minimap=True)
        step(state, 8, selected=[source.tag])
        await controller.advance(state)
        assert len(state.client.requests) == 1  # Selection only; no unsafe fallback.
        assert controller.audit[0]["command_confirmation"] == "no_clear_visible_screen_ground"
    asyncio.run(scenario())


def test_partial_group_selection_records_only_actual_command_sources():
    async def scenario():
        first, second = unit(1, (49, 50)), unit(2, (51, 50))
        state = bot(first, second)
        controller = FairPlayController(camera_center=(50, 50))
        assert await controller.issue(state, [first, second], 4)
        step(state, 8, selected=[1])
        await controller.advance(state)
        assert controller.audit[0]["source_tags"] == [1, 2]
        assert controller.audit[0]["command_source_tags"] == [1]
        assert controller.audit[-1]["requested_source_tags"] == [1, 2]
        assert controller.audit[-1]["source_tags"] == [1]
    asyncio.run(scenario())


def test_selection_containing_unrequested_units_never_emits_command():
    async def scenario():
        first, second = unit(1), unit(2, (51, 50))
        state = bot(first, second)
        controller = FairPlayController(camera_center=(50, 50))
        assert await controller.issue(state, [first], 4)
        step(state, 8, selected=[1, 2])
        await controller.advance(state)
        assert len(state.client.requests) == 1
        assert controller.audit[0]["command_confirmation"] == "source_not_selected"
    asyncio.run(scenario())


@pytest.mark.parametrize("cap", [0, -1, 201, True, False, 200.0, 1.5, "200", None, float("nan"), float("inf")])
def test_invalid_apm_caps_are_rejected(cap):
    with pytest.raises(ValueError, match="integer"):
        ActionBudget(cap)


def test_hard_rolling_window_and_minimum_spacing_are_preserved_over_game_loops():
    budget = ActionBudget(200)
    accepted = []
    for loop in range(22_400):
        now = loop / 22.4
        if budget.consume(now):
            accepted.append(now)
            assert not budget.consume(now)
            assert sum(now - 60 < event <= now for event in accepted) <= 200
    assert min(np.diff(accepted)) >= .3 - 1e-9
    assert budget.peak <= 200
    assert budget.total == len(accepted)
    # At integer game loops 7 loops is the first legal interval (6 < .3sec).
    assert accepted[:3] == [0, 7 / 22.4, 14 / 22.4]


def test_budget_window_boundary_and_idle_time_do_not_accumulate_burst_credit():
    budget = ActionBudget(200)
    for index in range(200):
        assert budget.consume(index * .3)
    assert not budget.consume(59.99)
    assert budget.consume(60)
    assert budget.peak == 200
    assert budget.consume(600)
    assert not budget.consume(600)
    assert not budget.consume(600.29)
    assert budget.consume(600.3)


@pytest.mark.parametrize("now", [-1, float("nan"), float("inf"), True, "1"])
def test_invalid_budget_times_are_rejected(now):
    with pytest.raises(ValueError):
        ActionBudget().available(now)


def test_budget_rejects_backwards_game_time():
    budget = ActionBudget()
    budget.available(10)
    with pytest.raises(ValueError, match="backwards"):
        budget.available(9)


def test_interface_clears_cheating_and_coordinate_cropping_flags():
    options = api.InterfaceOptions(
        show_cloaked=True, show_placeholders=True, show_burrowed_shadows=True,
        raw_affects_selection=True, raw_crop_to_playable_area=True,
        feature_layer=api.SpatialCameraSetup(allow_cheating_layers=True, crop_to_playable_area=True),
    )
    configure_interface(options)
    assert options.raw and options.score
    assert not any((options.show_cloaked, options.show_placeholders, options.show_burrowed_shadows,
                    options.raw_affects_selection, options.raw_crop_to_playable_area,
                    options.feature_layer.allow_cheating_layers, options.feature_layer.crop_to_playable_area))
    assert (options.feature_layer.resolution.x, options.feature_layer.resolution.y) == SCREEN_SIZE
    assert (options.feature_layer.minimap_resolution.x, options.feature_layer.minimap_resolution.y) == MINIMAP_SIZE
    # Blizzard ConvertWorldToCamera: pixel_size = camera_size / min(resolution).
    pixel_size = options.feature_layer.width / min(SCREEN_SIZE)
    assert pixel_size * SCREEN_SIZE[0] == CAMERA_WIDTH
    assert pixel_size * SCREEN_SIZE[1] == CAMERA_HEIGHT
    assert options.feature_layer.width == FEATURE_CAMERA_SIZE


def test_screen_projection_center_axes_and_camera_bounds():
    controller = FairPlayController(camera_center=(50, 50))
    assert controller.screen_point((50, 50)) == common.PointI(x=64, y=36)
    assert controller.screen_point((53, 53)) == common.PointI(x=80, y=20)
    assert controller.screen_point((47, 47)) == common.PointI(x=48, y=52)
    assert not controller.on_screen((62, 50))
    assert not controller.on_screen((50, 56.75))
    assert not controller.on_screen((float("nan"), 50))
    with pytest.raises(ValueError, match="outside"):
        controller.screen_point((63, 50))
    assert not controller.on_screen(unit(is_on_screen=False))
    assert not controller.on_screen(unit(is_visible=False))


@pytest.mark.parametrize("map_size,point,expected", [
    ((200, 100), (100, 50), (32, 16)),
    ((100, 200), (50, 100), (16, 32)),
    ((200, 100), (0, 100), (0, 0)),
    ((200, 100), (200, 0), (63, 32)),
    ((100, 200), (100, 0), (32, 63)),
])
def test_rectangular_minimap_matches_blizzard_long_axis_projection(map_size, point, expected):
    state = bot()
    state.game_info.map_size = Point2(map_size)
    assert FairPlayController.minimap_point(state, point) == common.PointI(x=expected[0], y=expected[1])


@pytest.mark.parametrize("point", [(-1, 0), (201, 50), (50, 101), (float("nan"), 1)])
def test_minimap_rejects_invalid_destinations(point):
    with pytest.raises(ValueError):
        FairPlayController.minimap_point(bot(), point)


def test_selection_then_confirmed_next_observation_command_uses_real_spatial_protobufs():
    async def scenario():
        source = unit()
        target = unit(tag=2, position=(53, 50), is_enemy=True, is_mine=False)
        state = bot(source, target)
        screen_layers(state, relative=4, kind=74, density=1, pixel=(80, 36))
        controller = FairPlayController(camera_center=(50, 50))
        assert await controller.issue(state, [source], 3674, target)
        assert controller.pending
        assert len(state.client.requests) == 1
        selection_action = state.client.requests[0].actions[0]
        assert not selection_action.HasField("action_raw")
        selection = selection_action.action_feature_layer.unit_selection_point
        assert selection.type == spatial.ActionSpatialUnitSelectionPoint.Select
        assert selection.selection_screen_coord == common.PointI(x=64, y=36)
        assert await controller.advance(state)
        assert not await controller.move_camera(state, (100, 50))
        assert len(state.client.requests) == 1
        # Even an incorrectly advanced float timestamp cannot reuse an observation.
        state.time = 1
        assert await controller.advance(state)
        assert len(state.client.requests) == 1
        step(state, 7, selected=(1,))
        assert await controller.advance(state)
        assert not controller.pending
        assert len(state.client.requests) == 2
        command_action = state.client.requests[1].actions[0]
        assert not command_action.HasField("action_raw")
        command = command_action.action_feature_layer.unit_command
        assert command.ability_id == 3674
        assert not command.queue_command
        assert command.WhichOneof("target") == "target_screen_coord"
        assert command.target_screen_coord == common.PointI(x=80, y=36)
        assert controller.audit[0]["command_confirmation"] == "accepted"
        assert controller.audit[0]["command_loop"] == 7
        assert controller.audit[1]["source_tags"] == [1]
        assert controller.audit[1]["selection_audit_index"] == 0
        assert controller.audit[1]["game_loop"] == 7
        assert not await controller.move_camera(state, (100, 50))
        assert controller.budget.total == 2
    asyncio.run(scenario())


def test_unconfirmed_selection_does_not_send_a_command():
    async def scenario():
        source = unit()
        state = bot(source)
        controller = FairPlayController(camera_center=(50, 50))
        await controller.issue(state, [source], 1)
        step(state, 7)
        assert await controller.advance(state)
        assert len(state.client.requests) == 1
        assert not controller.pending
        assert controller.rejected == 1
        assert controller.audit[0]["command_confirmation"] == "source_not_selected"
        assert controller.audit[0]["command_loop"] == 7
    asyncio.run(scenario())


def test_command_rejection_is_linked_to_selection_without_claiming_dispatch_success():
    async def scenario():
        source = unit()
        state = bot(source)
        controller = FairPlayController(camera_center=(50, 50))
        assert await controller.issue(state, [source], 16, Point2((80, 50)), minimap=True)
        assert "command_confirmation" not in controller.audit[0]
        state.client.results = (3,)
        step(state, 7, selected=(1,))
        assert await controller.advance(state)
        assert controller.audit[0]["selection_confirmation"] == "confirmed"
        assert controller.audit[0]["command_confirmation"] == "engine_rejected"
        assert controller.audit[0]["command_loop"] == 7
        assert controller.audit[1]["source_tags"] == [1]
        assert controller.audit[1]["selection_audit_index"] == 0
        assert controller.audit[1]["result"] == [3]
        assert controller.budget.total == 2
    asyncio.run(scenario())


@pytest.mark.parametrize("engine_result,selected", [(3, ()), (1, (2,))])
def test_failed_click_cools_down_source_and_retries_without_bypassing_apm(engine_result, selected):
    async def scenario():
        source, overlap = unit(), unit(tag=2)
        state = bot(source, overlap, client=RecordingClient(results=(engine_result,)))
        controller = FairPlayController(camera_center=(50, 50))
        assert await controller.issue(state, [source], 1) == (engine_result == 1)
        step(state, 7, selected=selected)
        if engine_result == 1:
            assert await controller.advance(state)
            assert controller.audit[0]["selection_confirmation"] == "source_not_selected"
            assert controller.audit[0]["selected_tags"] == [2]
        else:
            assert controller.audit[0]["selection_confirmation"] == "engine_rejected"
        assert not controller.source_available(source, state.time)
        assert controller.source_available(overlap, state.time)
        assert not await controller.issue(state, [source], 1)
        assert len(state.client.requests) == controller.budget.total == 1
        # No position change is necessary: time alone permits a real retry.
        step(state, int((state.time + SELECTION_RETRY_SECONDS) * 22.4) + 1)
        state.client.results = (1,)
        assert controller.source_available(source, state.time)
        assert await controller.issue(state, [source], 1)
        step(state, state.state.game_loop + 7, selected=(1,))
        assert await controller.advance(state)
        assert len(state.client.requests) == controller.budget.total == 3
        assert controller.audit[-2]["selection_confirmation"] == "confirmed"
        assert controller.rejected == 1
    asyncio.run(scenario())


def test_failed_selection_memory_is_bounded_and_reset_between_games():
    controller = FairPlayController()
    for tag in range(MAX_SELECTION_FAILURES + 20):
        controller._remember_selection_failure(tag, 0.0)
    assert len(controller._selection_failures) == MAX_SELECTION_FAILURES
    assert controller.source_available(unit(tag=0), 0.0)
    assert not controller.source_available(unit(tag=MAX_SELECTION_FAILURES + 19), 0.0)
    assert controller.source_available(unit(tag=MAX_SELECTION_FAILURES + 19), SELECTION_RETRY_SECONDS)
    controller._remember_selection_failure(1, SELECTION_RETRY_SECONDS)
    controller.reset((50, 50))
    assert controller._selection_failures == {}


@pytest.mark.parametrize("map_size,center,same_pixel,new_pixel", [
    ((200, 200), (142.1875, 148.4375), (143.5, 149.5), (145.5, 149.5)),
    ((200, 100), (51.5625, 48.4375), (52.0, 49.0), (54.0, 49.0)),
    ((100, 200), (48.4375, 151.5625), (49.0, 151.0), (49.0, 148.0)),
])
def test_camera_suppresses_identical_emitted_minimap_pixel(map_size, center, same_pixel, new_pixel):
    async def scenario():
        state = bot()
        state.game_info.map_size = Point2(map_size)
        controller = FairPlayController(camera_center=center)
        assert not controller.camera_would_move(state, same_pixel)
        assert not await controller.move_camera(state, same_pixel)
        assert state.client.requests == []
        assert controller.budget.total == 0
        assert controller.camera_would_move(state, new_pixel)
        assert await controller.move_camera(state, new_pixel)
        assert controller.budget.total == 1
    asyncio.run(scenario())


@pytest.mark.parametrize("target_change", ["hidden", "offscreen", "gone"])
def test_target_loss_between_selection_and_command_cancels(target_change):
    async def scenario():
        source = unit()
        target = unit(tag=2, is_enemy=True, is_mine=False)
        state = bot(source, target)
        controller = FairPlayController(camera_center=(50, 50))
        await controller.issue(state, [source], 1, target)
        if target_change == "hidden":
            target.is_visible = False
        elif target_change == "offscreen":
            target.is_on_screen = False
        else:
            state.all_units.remove(target)
        step(state, 7, selected=(1,))
        await controller.advance(state)
        assert not controller.pending
        assert len(state.client.requests) == 1
        assert controller.rejected == 1
    asyncio.run(scenario())


def test_forbidden_sources_targets_and_mixed_groups_never_send_input():
    async def scenario():
        source = unit()
        state = bot(source)
        controller = FairPlayController(camera_center=(50, 50))
        for sources, target, minimap in (
            ([unit(position=(80, 50))], None, False),
            ([unit(is_on_screen=False)], None, False),
            ([unit(is_mine=False)], None, False),
            ([source], unit(tag=2, is_visible=False), False),
            ([source], unit(tag=2, is_on_screen=False), True),
            ([source], Point2((90, 50)), False),
            ([source, unit(tag=2, type_id=75)], None, False),
        ):
            with pytest.raises(ValueError):
                await controller.issue(state, sources, 1, target, minimap=minimap)
        assert state.client.requests == []
        assert controller.budget.total == 0
    asyncio.run(scenario())


def test_camera_and_minimap_commands_use_spatial_coords_and_consume_budget():
    async def scenario():
        source = unit()
        state = bot(source)
        controller = FairPlayController(camera_center=(50, 50))
        assert await controller.move_camera(state, (100, 50))
        camera = state.client.requests[0].actions[0].action_feature_layer.camera_move
        assert camera.center_minimap == common.PointI(x=32, y=16)
        # Sending a camera action does not invent an observation of its result.
        assert controller.camera_center == Point2((50, 50))
        step(state, 7)
        assert await controller.issue(state, [source], 16, Point2((150, 50)), minimap=True)
        step(state, 14, selected=(1,))
        await controller.advance(state)
        command = state.client.requests[-1].actions[0].action_feature_layer.unit_command
        assert command.WhichOneof("target") == "target_minimap_coord"
        assert command.target_minimap_coord == common.PointI(x=48, y=16)
        assert controller.budget.total == 3
    asyncio.run(scenario())


@pytest.mark.parametrize("results", [(), (2,), (1, 1)])
def test_rejected_or_missing_protocol_result_is_charged_and_not_queued(results):
    async def scenario():
        source = unit()
        state = bot(source, client=RecordingClient(results=results))
        controller = FairPlayController(camera_center=(50, 50))
        assert not await controller.issue(state, [source], 1)
        assert not controller.pending
        assert controller.budget.total == 1
        assert controller.rejected == 1
    asyncio.run(scenario())


def test_transport_failure_is_audited_and_charged():
    async def scenario():
        source = unit()
        state = bot(source, client=RecordingClient(failure=OSError("disconnected")))
        controller = FairPlayController(camera_center=(50, 50))
        with pytest.raises(OSError, match="disconnected"):
            await controller.issue(state, [source], 1)
        assert controller.budget.total == 1
        assert controller.audit[-1]["transport_error"]
    asyncio.run(scenario())


@pytest.mark.parametrize("ability", [16, 3794, 23, 3674, 24, 25])
def test_ground_command_over_friendly_model_preserves_intent_and_attack_uses_screen(ability):
    async def scenario():
        from pluto_sc2.runner import validate_action_audit
        # Same requested ground geometry as the observed v10 friendly attack.
        source = unit(tag=4370989060, position=(103, 121), radius=.625)
        friend = unit(tag=4389863429, position=(104.7247, 123.8334), radius=.625)
        state = bot(source, friend)
        screen_layers(state)
        state.game_info.map_size = Point2((200, 200))
        state.state.observation_raw.player.camera.CopyFrom(common.Point(x=104, y=123))
        controller = FairPlayController(camera_center=(104, 123))
        target = Point2((104.7247, 123.8334))
        assert await controller.issue(state, [source], ability, target)
        step(state, 7, selected=(source.tag,))
        assert await controller.advance(state)
        action = state.client.requests[-1].actions[0]
        command = action.action_feature_layer.unit_command
        attack = ability in (23, 3674, 24, 25)
        assert command.WhichOneof("target") == ("target_screen_coord" if attack else "target_minimap_coord")
        assert command.ability_id == (23 if attack else ability)
        assert not action.HasField("action_raw")
        selection, emitted = controller.audit
        for event in (selection, emitted):
            assert event["target_kind"] == "ground" and event["unit_target_tag"] is None
            assert event["intended_target"] == list(target)
            assert event["ground_target_redirected"]
            assert event["minimap"] is (not attack)
            assert event["effective_target"] != list(friend.position)
        assert controller.budget.total == 2
        assert validate_action_audit({"summary": controller.summary(), "actions": controller.audit})["valid"]
    asyncio.run(scenario())


def test_clear_current_screen_ground_pixel_retains_precise_screen_movement():
    async def scenario():
        source = unit(position=(45, 50), radius=.5)
        state = bot(source)
        controller = FairPlayController(camera_center=(50, 50))
        screen_layers(state)
        assert await controller.issue(state, [source], 16, Point2((50, 50)))
        step(state, 7, selected=(1,))
        await controller.advance(state)
        command = state.client.requests[-1].actions[0].action_feature_layer.unit_command
        assert command.WhichOneof("target") == "target_screen_coord"
        assert command.target_screen_coord == common.PointI(x=64, y=36)
        assert not controller.audit[-1]["ground_target_redirected"]
    asyncio.run(scenario())


def test_unit_entering_target_pixel_after_selection_uses_new_clear_screen_pixel():
    async def scenario():
        source, friend = unit(position=(45, 50)), unit(tag=2, position=(58, 50))
        state = bot(source, friend)
        screen_layers(state)
        controller = FairPlayController(camera_center=(50, 50))
        assert await controller.issue(state, [source], 23, Point2((50, 50)))
        friend.position = Point2((50, 50))
        screen_layers(state, relative=1, kind=74, density=1)
        step(state, 7, selected=(1,))
        await controller.advance(state)
        command = state.client.requests[-1].actions[0].action_feature_layer.unit_command
        assert command.WhichOneof("target") == "target_screen_coord"
        assert command.target_screen_coord != common.PointI(x=64, y=36)
        assert controller.audit[-1]["ground_redirect_reason"] == "occupied_screen_target"
    asyncio.run(scenario())


@pytest.mark.parametrize("relative", [1, 2, 3, 4])
def test_any_occupied_pixel_cannot_turn_ground_intent_into_follow_or_unit_attack(relative):
    async def scenario():
        source = unit(position=(45, 50))
        state = bot(source)
        screen_layers(state, relative=relative, kind=74, density=1)
        controller = FairPlayController(camera_center=(50, 50))
        assert await controller.issue(state, [source], 16, Point2((50, 50)))
        step(state, 7, selected=(1,))
        await controller.advance(state)
        assert controller.audit[-1]["minimap"]
    asyncio.run(scenario())


def test_ground_attack_without_observed_clear_screen_abandons_even_if_minimap_metadata_exists():
    async def scenario():
        source = unit()
        state = bot(source)
        state.game_data = SimpleNamespace(abilities={23: SimpleNamespace(id=23,
            _proto=data.AbilityData(ability_id=23, allow_minimap=False))})
        controller = FairPlayController(camera_center=(50, 50))
        assert await controller.issue(state, [source], 23, Point2((53, 50)))
        step(state, 7, selected=(1,))
        await controller.advance(state)
        assert len(state.client.requests) == controller.budget.total == 1
        assert controller.audit[0]["command_confirmation"] == "no_clear_visible_screen_ground"
        assert not controller.pending
    asyncio.run(scenario())


@pytest.mark.parametrize("ability", [23, 3674, 24, 25])
def test_distant_ground_attack_uses_bounded_forward_screen_waypoint_and_ordinary_23(ability):
    async def scenario():
        source = unit(position=(50, 50), radius=.5)
        state = bot(source)
        screen_layers(state)
        controller = FairPlayController(camera_center=(50, 50))
        destination = Point2((150, 50))
        assert await controller.issue(state, [source], ability, destination, minimap=True)
        step(state, 7, selected=(1,))
        await controller.advance(state)
        command = state.client.requests[-1].actions[0].action_feature_layer.unit_command
        event = controller.audit[-1]
        effective = Point2(event["effective_target"])
        assert command.ability_id == 23 and command.WhichOneof("target") == "target_screen_coord"
        assert effective.x > source.position.x + 2
        assert effective.distance_to(source.position) <= 8
        assert effective.distance_to(destination) < source.position.distance_to(destination)
        assert controller.on_screen(effective)
        assert event["intended_target"] == [150, 50]
        assert event["ground_redirect_reason"] == "offscreen_forward_waypoint"
        assert event["ground_target_safety"] == "current_visible_empty_screen"
        assert event["requested_minimap"] and not event["minimap"]
        assert controller.budget.total == 2
    asyncio.run(scenario())


@pytest.mark.parametrize("visibility,pathable", [(0, 1), (1, 1), (2, 0)])
def test_attack_never_uses_fogged_unexplored_or_unpathable_screen(visibility, pathable):
    async def scenario():
        source = unit(position=(45, 50))
        state = bot(source)
        screen_layers(state, visibility=visibility, pathable=pathable)
        controller = FairPlayController(camera_center=(50, 50))
        assert await controller.issue(state, [source], 23, Point2((50, 50)))
        step(state, 7, selected=(1,))
        await controller.advance(state)
        assert len(state.client.requests) == 1
        assert controller.audit[0]["command_confirmation"] == "no_clear_visible_screen_ground"
    asyncio.run(scenario())


def test_attack_clear_pixel_search_is_bounded_even_if_distant_screen_pixel_is_clear():
    async def scenario():
        source = unit(position=(45, 50))
        state = bot(source)
        screen_layers(state)
        pixels = np.ones((72, 128), dtype="<u4")
        pixels[36, 95] = 0  #31pixelsfromintendedpixel; beyond24pixelsearch.
        state.state.observation.feature_layer_data.renders.player_relative.data = pixels.tobytes()
        controller = FairPlayController(camera_center=(50, 50))
        assert await controller.issue(state, [source], 23, Point2((50, 50)))
        step(state, 7, selected=(1,))
        await controller.advance(state)
        assert len(state.client.requests) == controller.budget.total == 1
        assert controller.audit[0]["command_confirmation"] == "no_clear_visible_screen_ground"
    asyncio.run(scenario())


def test_attack_uses_nearest_safe_screen_pixel_for_single_pixel_occupancy():
    async def scenario():
        source = unit(position=(45, 50), radius=.5)
        state = bot(source)
        screen_layers(state, relative=1, kind=74, density=1)
        controller = FairPlayController(camera_center=(50, 50))
        assert await controller.issue(state, [source], 23, Point2((50, 50)))
        step(state, 7, selected=(1,))
        await controller.advance(state)
        x, y = controller.audit[-1]["target_pixel"]
        assert (x - 64) ** 2 + (y - 36) ** 2 == 1
    asyncio.run(scenario())


@pytest.mark.parametrize("change", ["flag", "camera"])
def test_selected_requested_source_must_still_be_on_screen_at_dispatch(change):
    async def scenario():
        source = unit(position=(50, 50))
        state = bot(source)
        screen_layers(state)
        controller = FairPlayController(camera_center=(50, 50))
        assert await controller.issue(state, [source], 23, Point2((150, 50)), minimap=True)
        if change == "flag":
            source.is_on_screen = False
        else:
            state.state.observation_raw.player.camera.x = 100
        step(state, 7, selected=(1,))
        await controller.advance(state)
        assert len(state.client.requests) == 1
        assert controller.audit[0]["command_confirmation"] == "source_not_on_screen"
    asyncio.run(scenario())


def test_ground_attack_search_never_reads_hidden_unit_position_or_minimap_layers():
    class Hidden:
        tag = 3
        is_on_screen = False
        is_visible = False

        @property
        def position(self):
            raise AssertionError("Hidden position read")

    async def scenario():
        source = unit(position=(50, 50), radius=.5)
        state = bot(source)
        state.all_units.append(Hidden())
        screen_layers(state)
        controller = FairPlayController(camera_center=(50, 50))
        assert await controller.issue(state, [source], 23, Point2((150, 50)), minimap=True)
        step(state, 7, selected=(1,))
        await controller.advance(state)
        assert controller.audit[-1]["kind"] == "command"
        assert not controller.audit[-1]["minimap"]
    asyncio.run(scenario())


@pytest.mark.parametrize("ability", [23, 3674])
def test_direct_attack_on_own_unit_is_refused_without_spending_an_input(ability):
    async def scenario():
        source, friend = unit(), unit(tag=2, position=(53, 50))
        state = bot(source, friend)
        controller = FairPlayController(camera_center=(50, 50))
        assert not await controller.issue(state, [source], ability, friend)
        assert not state.client.requests and not controller.pending
        assert controller.last_target_rejection["reason"] == "friendly_attack_forbidden"
    asyncio.run(scenario())


def test_target_becoming_friendly_after_selection_abandons_attack():
    async def scenario():
        source, target = unit(), unit(tag=2, position=(53, 50), is_enemy=True, is_mine=False)
        state = bot(source, target)
        controller = FairPlayController(camera_center=(50, 50))
        assert await controller.issue(state, [source], 23, target)
        target.is_mine, target.is_enemy = True, False
        step(state, 7, selected=(1,))
        await controller.advance(state)
        assert len(state.client.requests) == 1
        assert controller.audit[0]["command_confirmation"] == "friendly_attack_forbidden"
    asyncio.run(scenario())


@pytest.mark.parametrize("relative,kind,density", [(1, 74, 1), (2, 74, 1), (4, 75, 1), (4, 74, 2), (0, 0, 0)])
def test_explicit_enemy_attack_requires_unambiguous_matching_current_pixel(relative, kind, density):
    async def scenario():
        source, enemy = unit(position=(45, 50)), unit(tag=2, is_enemy=True, is_mine=False)
        state = bot(source, enemy)
        controller = FairPlayController(camera_center=(50, 50))
        assert await controller.issue(state, [source], 23, enemy)
        screen_layers(state, relative=relative, kind=kind, density=density)
        step(state, 7, selected=(1,))
        await controller.advance(state)
        assert len(state.client.requests) == 1
        assert controller.audit[0]["command_confirmation"] == "unit_target_pixel_ambiguous"
    asyncio.run(scenario())


def test_unambiguous_enemy_unit_click_stays_screen_target_even_if_minimap_requested():
    async def scenario():
        source, enemy = unit(position=(45, 50)), unit(tag=2, is_enemy=True, is_mine=False)
        state = bot(source, enemy)
        screen_layers(state, relative=4, kind=74, density=1)
        controller = FairPlayController(camera_center=(50, 50))
        assert await controller.issue(state, [source], 23, enemy, minimap=True)
        step(state, 7, selected=(1,))
        await controller.advance(state)
        assert controller.audit[-1]["target_kind"] == "unit"
        assert controller.audit[-1]["unit_target_tag"] == 2
        assert not controller.audit[-1]["minimap"]
    asyncio.run(scenario())


def test_friendly_body_overlapping_enemy_click_is_rejected_even_without_feature_layers():
    async def scenario():
        source = unit(position=(45, 50))
        friend, enemy = unit(tag=3, position=(50.2, 50)), unit(tag=2, is_enemy=True, is_mine=False)
        state = bot(source, friend, enemy)
        controller = FairPlayController(camera_center=(50, 50))
        assert await controller.issue(state, [source], 23, enemy)
        step(state, 7, selected=(1,))
        await controller.advance(state)
        assert controller.audit[0]["command_confirmation"] == "unit_target_pixel_ambiguous"
        assert len(state.client.requests) == 1
    asyncio.run(scenario())


def test_enemy_click_without_current_occupancy_is_not_assumed_safe():
    async def scenario():
        source, enemy = unit(position=(45, 50)), unit(tag=2, is_enemy=True, is_mine=False)
        state = bot(source, enemy)
        controller = FairPlayController(camera_center=(50, 50))
        assert await controller.issue(state, [source], 23, enemy)
        step(state, 7, selected=(1,))
        await controller.advance(state)
        assert controller.audit[0]["command_confirmation"] == "unit_target_pixel_ambiguous"
        assert len(state.client.requests) == 1
    asyncio.run(scenario())


def test_offscreen_friendly_is_not_read_as_a_hidden_target_blocker():
    class Hidden:
        tag = 3
        is_on_screen = False
        is_visible = False

        @property
        def position(self):
            raise AssertionError("Hidden position read")

    async def scenario():
        source, enemy = unit(position=(45, 50)), unit(tag=2, is_enemy=True, is_mine=False)
        state = bot(source, enemy)
        state.all_units.append(Hidden())
        screen_layers(state, relative=4, kind=74, density=1)
        controller = FairPlayController(camera_center=(50, 50))
        assert await controller.issue(state, [source], 23, enemy)
        step(state, 7, selected=(1,))
        await controller.advance(state)
        assert controller.audit[0]["command_confirmation"] == "accepted"
    asyncio.run(scenario())


def test_human_client_blocks_raw_unpaced_fog_and_debug_bypasses(monkeypatch):
    forwarded = []

    async def parent_execute(self, **kwargs):
        forwarded.append(kwargs)
        return api.Response(action=api.ResponseAction(result=[1]))

    monkeypatch.setattr(Client, "_execute", parent_execute)
    client = HumanClient(object())
    raw_action = api.Action(action_raw=raw.ActionRaw(
        unit_command=raw.ActionRawUnitCommand(ability_id=1, unit_tags=[1])))
    spatial_action = api.Action(action_feature_layer=spatial.ActionSpatial(
        camera_move=spatial.ActionSpatialCameraMove(center_minimap=common.PointI(x=10, y=10))))
    for request, message in (
        ({"action": api.RequestAction(actions=[raw_action])}, "Raw"),
        ({"action": api.RequestAction(actions=[spatial_action])}, "paced"),
        ({"observation": api.RequestObservation(disable_fog=True)}, "fog"),
        ({"start_replay": api.RequestStartReplay(disable_fog=True)}, "fog"),
        ({"debug": api.RequestDebug()}, "debug"),
        ({"map_command": api.RequestMapCommand(trigger_cmd="cheat")}, "debug"),
    ):
        with pytest.raises(RuntimeError, match=message):
            asyncio.run(client._execute(**request))
    assert forwarded == []
    source = unit()
    state = bot(source, client=client)
    controller = FairPlayController(camera_center=(50, 50))
    assert asyncio.run(controller.issue(state, [source], 1))
    assert len(forwarded) == 1
    assert "_fairplay_token" not in forwarded[0]


def test_human_client_configures_join_and_preserves_readonly_requests(monkeypatch):
    forwarded = []

    async def parent_execute(self, **kwargs):
        forwarded.append(kwargs)
        return api.Response()

    monkeypatch.setattr(Client, "_execute", parent_execute)
    client = HumanClient(object())
    join = api.RequestJoinGame(race=common.Protoss)
    asyncio.run(client._execute(join_game=join))
    assert join.options.feature_layer.width == FEATURE_CAMERA_SIZE
    asyncio.run(client._execute(observation=api.RequestObservation(disable_fog=False)))
    assert len(forwarded) == 2


def test_controller_reset_removes_prior_episode_actions_and_pending_input():
    async def scenario():
        source = unit()
        state = bot(source)
        controller = FairPlayController(150, camera_center=(50, 50))
        await controller.issue(state, [source], 1)
        controller.reset((80, 80))
        assert controller.camera_center == Point2((80, 80))
        assert controller.budget.max_apm == 150
        assert controller.budget.total == 0
        assert controller.audit == []
        assert not controller.pending
    asyncio.run(scenario())


def own_selection_rows(state):
    for row in state.state.observation_raw.units:
        row.alliance = 1


class HiddenSelectedUnit:
    tag = 2
    is_on_screen = False
    is_visible = False

    @property
    def position(self):
        raise AssertionError("Off-screen selected position was inspected")


def test_f2_selects_global_own_army_with_real_ui_input_and_visible_leader_only():
    async def scenario():
        leader, hidden = unit(1, (48, 50)), HiddenSelectedUnit()
        state = bot(leader, hidden)
        own_selection_rows(state)
        screen_layers(state)
        controller = FairPlayController(camera_center=(50, 50))
        assert await controller.issue(state, [leader], 23, Point2((55, 50)), selection_mode="army")
        first = state.client.requests[0].actions[0]
        assert first.HasField("action_ui") and first.action_ui.HasField("select_army")
        assert not first.action_ui.select_army.selection_add and not first.HasField("action_raw")
        step(state, 8, selected=[1, 2])
        assert await controller.advance(state)
        command = controller.audit[-1]
        assert command["source_tags"] == [1, 2]
        assert command["visible_command_source_tags"] == [1]
        assert command["offscreen_selected_count"] == 1
        assert command["ground_target_safety"] == "current_visible_empty_screen"
        assert command["selection_mode"] == "army" and controller.budget.total == 2
        assert controller.confirmed_selection["members"][1]["type_id"] is None
    asyncio.run(scenario())


def test_f2_still_rejects_non_owned_selection_and_missing_current_screen_leader():
    async def scenario(enemy):
        leader, hidden = unit(1, (48, 50)), HiddenSelectedUnit()
        state = bot(leader, hidden)
        own_selection_rows(state)
        screen_layers(state)
        controller = FairPlayController(camera_center=(50, 50))
        target = Point2((55, 50)) if enemy else Point2((150, 50))
        await controller.issue(state, [leader], 23, target, minimap=not enemy, selection_mode="army")
        if enemy:
            state.state.observation_raw.units[1].alliance = 4
        else:
            leader.is_on_screen = False
        step(state, 8, selected=[1, 2])
        await controller.advance(state)
        assert len(state.client.requests) == 1
        assert controller.audit[0]["command_confirmation"] == ("source_not_selected" if enemy else "source_not_on_screen")
    asyncio.run(scenario(True))
    asyncio.run(scenario(False))


def test_mixed_screen_group_uses_one_true_rectangle_and_confirmed_actual_sources():
    async def scenario():
        stalker, zealot = unit(1, (48, 50), type_id=74), unit(2, (52, 49), type_id=73)
        state = bot(stalker, zealot)
        controller = FairPlayController(camera_center=(50, 50))
        assert await controller.issue(state, [stalker, zealot], 4, selection_mode="rectangle")
        action = state.client.requests[0].actions[0].action_feature_layer
        assert action.HasField("unit_selection_rect")
        assert len(action.unit_selection_rect.selection_screen_coord) == 1
        assert not action.unit_selection_rect.selection_add
        step(state, 8, selected=[1, 2])
        await controller.advance(state)
        assert controller.audit[-1]["source_tags"] == [1, 2]
    asyncio.run(scenario())


def test_rectangle_never_includes_accidentally_selected_worker_in_command():
    async def scenario():
        first, second, worker = unit(1), unit(2, (52, 50), type_id=73), unit(3, (51, 50), type_id=84)
        state = bot(first, second, worker)
        controller = FairPlayController(camera_center=(50, 50))
        await controller.issue(state, [first, second], 23, Point2((55, 50)), selection_mode="rectangle")
        step(state, 8, selected=[1, 2, 3])
        await controller.advance(state)
        assert len(state.client.requests) == 1
        assert controller.audit[0]["command_confirmation"] == "source_not_selected"
    asyncio.run(scenario())


async def registered_nexus_group():
    nexus = unit(1, type_id=59, is_structure=True)
    state = bot(nexus)
    own_selection_rows(state)
    controller = FairPlayController(camera_center=(50, 50))
    assert await controller.issue(state, [nexus], None)
    step(state, 8, selected=[1])
    await controller.advance(state)
    assert controller.audit[0]["command_confirmation"] == "selection_only"
    assert len(state.client.requests) == 1
    step(state, 16, selected=[1])
    assert await controller.set_control_group(state, 2)
    assert controller.control_group_receipt(2)["tags"] == [1]
    return state, controller


def offscreen_production_observation(state, *, available=True, minerals=50, supply=1, ability=1006):
    # The group receipt supplies identity/type. Hidden objects provide no usable geometry.
    hidden = HiddenSelectedUnit()
    hidden.tag = 1
    state.all_units = [hidden]
    state.state.observation = api.Observation(player_common=api.PlayerCommon(
        minerals=minerals, vespene=100, food_cap=20, food_used=20-supply))
    state.state.observation.ui_data.production.unit.unit_type = 59
    state.state.observation.ui_data.production.unit.player_relative = 1
    if available:
        state.state.observation.abilities.add(ability_id=ability)
    state.game_data.abilities = {ability: SimpleNamespace(_proto=data.AbilityData(
        ability_id=ability, available=True, target=1))}
    state.game_data.units = {84: SimpleNamespace(_proto=data.UnitTypeData(
        unit_id=84, ability_id=1006, mineral_cost=50, vespene_cost=0, food_required=1))}
    state.game_data.upgrades = {}


def test_registered_offscreen_nexus_produces_using_only_selected_ui_and_public_costs():
    async def scenario():
        state, controller = await registered_nexus_group()
        offscreen_production_observation(state)
        step(state, 24, selected=[1])
        assert await controller.issue(state, [], 1006, selection_mode="control_group", control_group=2)
        recall = state.client.requests[-1].actions[0].action_ui.control_group
        assert recall.control_group_index == 2 and recall.action == 1
        step(state, 32, selected=[1])
        await controller.advance(state)
        command = state.client.requests[-1].actions[0].action_feature_layer.unit_command
        assert command.ability_id == 1006 and command.WhichOneof("target") is None
        assert controller.audit[-1]["source_tags"] == [1]
        assert controller.audit[-1]["visible_command_source_tags"] == []
        assert controller.audit[-1]["group_production"]["kind"] == "train"
        assert controller.budget.total == 4
        assert all(not request.actions[0].HasField("action_raw") for request in state.client.requests)
    asyncio.run(scenario())


@pytest.mark.parametrize("options", [{"available": False}, {"minerals": 49}, {"supply": 0}, {"ability": 4}])
def test_offscreen_group_cannot_bypass_ui_production_affordability_or_nonproduction_restriction(options):
    async def scenario():
        state, controller = await registered_nexus_group()
        offscreen_production_observation(state, **options)
        ability = options.get("ability", 1006)
        step(state, 24, selected=[1])
        assert await controller.issue(state, [], ability, selection_mode="control_group", control_group=2)
        step(state, 32, selected=[1])
        await controller.advance(state)
        assert len(state.client.requests) == 3  # Registration, assignment, recall only.
        assert controller.audit[-1]["command_confirmation"] == "group_production_unavailable"
    asyncio.run(scenario())


def test_control_group_recall_rejects_unregistered_selected_extra_without_reading_it():
    async def scenario():
        state, controller = await registered_nexus_group()
        offscreen_production_observation(state)
        state.state.observation_raw.units.add(tag=2, alliance=1, is_selected=False)
        step(state, 24, selected=[1])
        await controller.issue(state, [], 1006, selection_mode="control_group", control_group=2)
        step(state, 32, selected=[1, 2])
        await controller.advance(state)
        assert len(state.client.requests) == 3
        assert controller.audit[-1]["command_confirmation"] == "source_not_selected"
    asyncio.run(scenario())


def test_group_assignment_needs_confirmed_selection_and_cannot_repeat_inside_apm_interval():
    async def scenario():
        state = bot(unit())
        own_selection_rows(state)
        controller = FairPlayController(camera_center=(50, 50))
        assert not await controller.set_control_group(state, 2)
        await controller.issue(state, state.all_units, None)
        assert not await controller.set_control_group(state, 2)
        step(state, 8, selected=[1])
        await controller.advance(state)
        assert await controller.set_control_group(state, 2)
        assert not await controller.set_control_group(state, 3)
        assert controller.budget.total == 2
        snapshot = controller.control_group_receipt(2)
        snapshot['tags'].append(99)
        assert controller.control_group_receipt(2)["tags"] == [1]
        controller.reset((50, 50))
        assert controller.control_group_receipt(2) is None and controller.confirmed_selection is None
    asyncio.run(scenario())


def test_human_client_allows_only_gated_selection_ui_not_raw_or_unrelated_ui(monkeypatch):
    from s2clientprotocol import ui_pb2 as ui
    from pluto_sc2.fairplay import _SPATIAL_GATE

    forwarded = []

    async def execute(self, **kwargs):
        forwarded.append(kwargs)
        return api.Response(action=api.ResponseAction(result=[1]))

    monkeypatch.setattr(Client, "_execute", execute)
    client = HumanClient(object())
    approved = api.RequestAction(actions=[api.Action(action_ui=ui.ActionUI(select_army=ui.ActionSelectArmy()))])
    with pytest.raises(RuntimeError, match="paced"):
        asyncio.run(client._execute(action=approved))
    asyncio.run(client._execute(_fairplay_token=_SPATIAL_GATE, action=approved))
    unrelated = api.RequestAction(actions=[api.Action(action_ui=ui.ActionUI(
        select_idle_worker=ui.ActionSelectIdleWorker(type=1)))])
    with pytest.raises(RuntimeError, match="Only paced"):
        asyncio.run(client._execute(_fairplay_token=_SPATIAL_GATE, action=unrelated))
    assert len(forwarded) == 1


def test_producer_ui_allowlist_rejects_other_portrait_operations_and_unpaced_input(monkeypatch):
    from s2clientprotocol import ui_pb2 as ui
    from pluto_sc2.fairplay import _SPATIAL_GATE

    forwarded = []

    async def execute(self, **kwargs):
        forwarded.append(kwargs)
        return api.Response(action=api.ResponseAction(result=[1]))

    monkeypatch.setattr(Client, "_execute", execute)
    client = HumanClient(object())
    request = api.RequestAction(actions=[api.Action(action_ui=ui.ActionUI(
        multi_panel=ui.ActionMultiPanel(type=ui.ActionMultiPanel.SingleSelect, unit_index=0)))])
    with pytest.raises(RuntimeError, match="paced"):
        asyncio.run(client._execute(action=request))
    asyncio.run(client._execute(_fairplay_token=_SPATIAL_GATE, action=request))
    for operation, index in [(ui.ActionMultiPanel.DeselectUnit, 0),
                             (ui.ActionMultiPanel.SelectAllOfType, 0),
                             (ui.ActionMultiPanel.DeselectAllOfType, 0),
                             (ui.ActionMultiPanel.SingleSelect, -1)]:
        request.actions[0].action_ui.multi_panel.type = operation
        request.actions[0].action_ui.multi_panel.unit_index = index
        with pytest.raises(RuntimeError, match="Only paced"):
            asyncio.run(client._execute(_fairplay_token=_SPATIAL_GATE, action=request))
    assert len(forwarded) == 1


def test_offscreen_production_never_reads_hidden_raw_queue_positions_or_other_state():
    class SelectedIdentityOnly:
        tag = 1
        alliance = 1
        is_selected = True

        def __getattr__(self, field):
            raise AssertionError(f"Hidden raw selected field read: {field}")

    async def scenario():
        state, controller = await registered_nexus_group()
        offscreen_production_observation(state)
        state.state.observation_raw = SimpleNamespace(
            player=state.state.observation_raw.player, units=[SelectedIdentityOnly()])
        step(state, 24, selected=[1])
        await controller.issue(state, [], 1006, selection_mode="control_group", control_group=2)
        step(state, 32, selected=[1])
        await controller.advance(state)
        assert controller.audit[-1]["kind"] == "command"
        assert controller.audit[-1]["group_production"]["queue_evidence"]["source"] == "selected_production_panel"
    asyncio.run(scenario())


def test_control_group_append_preserves_earlier_visible_registration_across_camera_visits():
    async def scenario():
        state, controller = await registered_nexus_group()
        second = unit(2, type_id=59, is_structure=True)
        state.all_units = [second]
        state.state.observation_raw.units.add(tag=2, alliance=1)
        step(state, 24, selected=[1])
        assert await controller.issue(state, [second], None)
        step(state, 32, selected=[2])
        await controller.advance(state)
        step(state, 40, selected=[2])
        assert await controller.set_control_group(state, 2, append=True)
        receipt = controller.control_group_receipt(2)
        assert receipt["tags"] == [1, 2]
        assert all(row["type_id"] == 59 and row["is_structure"] for row in receipt["members"])
        event = controller.audit[-1]
        assert event["prior_group_tags"] == [1] and event["registered_tags"] == [1, 2]
        assert event["selection_provenance_audit_index"] == 2
        control = state.client.requests[-1].actions[0].action_ui.control_group
        assert control.action == 3  # Actual Append, without re-reading the first Nexus.
    asyncio.run(scenario())


def test_append_cannot_establish_an_unregistered_engine_group():
    async def scenario():
        state = bot(unit(1, type_id=59, is_structure=True))
        own_selection_rows(state)
        controller = FairPlayController(camera_center=(50, 50))
        assert await controller.issue(state, state.all_units, None)
        step(state, 8, selected=[1])
        await controller.advance(state)
        assert not await controller.set_control_group(state, 2, append=True)
        assert controller.control_group_receipt(2) is None
        assert controller.budget.total == 1 and len(state.client.requests) == 1
        assert await controller.set_control_group(state, 2)
    asyncio.run(scenario())


def test_registered_offscreen_structure_research_uses_public_upgrade_cost_and_selected_ui():
    async def scenario():
        state, controller = await registered_nexus_group()
        offscreen_production_observation(state, minerals=100, supply=0, ability=1568)
        state.game_data.units = {}
        state.game_data.upgrades = {1: SimpleNamespace(_proto=data.UpgradeData(
            upgrade_id=1, ability_id=1568, mineral_cost=50, vespene_cost=50))}
        step(state, 24, selected=[1])
        await controller.issue(state, [], 1568, selection_mode="control_group", control_group=2)
        step(state, 32, selected=[1])
        await controller.advance(state)
        assert controller.audit[-1]["kind"] == "command"
        assert controller.audit[-1]["group_production"]["kind"] == "research"
        assert controller.audit[-1]["group_production"]["vespene_cost"] == 50
    asyncio.run(scenario())


@pytest.mark.parametrize("queue_count,expected", [(0, True), (1, True), (2, False), (5, False)])
def test_offscreen_group_training_queue_allows_at_most_one_waiting_unit(queue_count, expected):
    async def scenario():
        state, controller = await registered_nexus_group()
        offscreen_production_observation(state)
        panel = state.state.observation.ui_data.production
        # Both protocol views report the same queue; they are not added together.
        for _ in range(queue_count):
            panel.build_queue.add(unit_type=84, player_relative=1)
            panel.production_queue.add(ability_id=1006)
        step(state, 24, selected=[1])
        await controller.issue(state, [], 1006, selection_mode="control_group", control_group=2)
        step(state, 32, selected=[1])
        await controller.advance(state)
        assert (controller.audit[-1]["kind"] == "command") is expected
        if expected:
            proof = controller.audit[-1]["group_production"]["queue_evidence"]
            assert proof["queue_item_count"] == queue_count and proof["producer_count"] == 1
        else:
            assert controller.audit[-1]["group_production_queue_rejection"] == "selected_production_queue_full"
            assert len(state.client.requests) == 3
    asyncio.run(scenario())


@pytest.mark.parametrize("mutation", ["missing", "cargo", "foreign", "wrong_type"])
def test_no_queue_panel_or_untrusted_producer_panel_never_means_idle(mutation):
    async def scenario():
        state, controller = await registered_nexus_group()
        offscreen_production_observation(state)
        panel = state.state.observation.ui_data
        if mutation == "missing":
            state.state.observation.ClearField("ui_data")
        elif mutation == "cargo":
            panel.cargo.unit.unit_type = 59
            panel.cargo.unit.player_relative = 1
        elif mutation == "foreign":
            panel.production.unit.player_relative = 4
        else:
            panel.production.unit.unit_type = 62
        step(state, 24, selected=[1])
        await controller.issue(state, [], 1006, selection_mode="control_group", control_group=2)
        step(state, 32, selected=[1])
        await controller.advance(state)
        assert len(state.client.requests) == 3
        assert controller.audit[-1]["group_production_queue_rejection"] == "selected_production_queue_unavailable"
        evidence = controller.audit[-1]["group_production_ui"]
        assert evidence["panel_kind"] == (None if mutation == "missing" else "cargo" if mutation == "cargo" else "production")
    asyncio.run(scenario())


def test_visible_recalled_producer_cannot_fall_back_past_unavailable_ui_queue_proof():
    async def scenario():
        state, controller = await registered_nexus_group()
        offscreen_production_observation(state, available=False)
        state.all_units = [unit(1, type_id=59, is_structure=True)]
        step(state, 24, selected=[1])
        await controller.issue(state, [], 1006, selection_mode="control_group", control_group=2)
        step(state, 32, selected=[1])
        await controller.advance(state)
        assert len(state.client.requests) == 3
        assert controller.audit[-1]["command_confirmation"] == "group_production_unavailable"
    asyncio.run(scenario())


@pytest.mark.parametrize("research", [False, True])
def test_explicit_idle_single_producer_panel_allows_available_production_only(research):
    async def scenario():
        state, controller = await registered_nexus_group()
        ability = 1568 if research else 1006
        offscreen_production_observation(state, minerals=100, ability=ability)
        if research:
            state.game_data.units = {}
            state.game_data.upgrades = {1: SimpleNamespace(_proto=data.UpgradeData(
                upgrade_id=1, ability_id=1568, mineral_cost=50, vespene_cost=50))}
        panel = state.state.observation.ui_data.single
        panel.unit.unit_type, panel.unit.player_relative, panel.unit.build_progress = 59, 1, 1
        step(state, 24, selected=[1])
        await controller.issue(state, [], ability, selection_mode="control_group", control_group=2)
        step(state, 32, selected=[1])
        await controller.advance(state)
        command = controller.audit[-1]
        assert command["kind"] == "command"
        proof = command["group_production"]
        assert proof["queue_evidence"]["source"] == "selected_idle_single_panel"
        assert proof["queue_evidence"]["queue_item_count"] == 0
        assert proof["ui_panel"]["panel_kind"] == "single"
        assert proof["ui_panel"]["unit_type"] == 59 and proof["ui_panel"]["player_relative"] == 1
        assert proof["ui_panel"]["production_queue_count"] is None  # The UI variant, not a fabricated queue list.
        assert controller.audit[2]["group_production_ui"] == proof["ui_panel"]
    asyncio.run(scenario())


@pytest.mark.parametrize("failure", ["foreign", "wrong_type", "empty", "no_ability", "no_money"])
def test_single_panel_never_loosens_owned_type_ability_or_cost_checks(failure):
    async def scenario():
        state, controller = await registered_nexus_group()
        offscreen_production_observation(state, available=failure != "no_ability", minerals=49 if failure == "no_money" else 50)
        panel = state.state.observation.ui_data.single
        panel.unit.unit_type = 62 if failure == "wrong_type" else 59
        panel.unit.player_relative = 4 if failure == "foreign" else 1
        if failure == "empty":
            panel.ClearField("unit")
        step(state, 24, selected=[1])
        await controller.issue(state, [], 1006, selection_mode="control_group", control_group=2)
        step(state, 32, selected=[1])
        await controller.advance(state)
        assert len(state.client.requests) == 3 and controller.audit[-1]["kind"] == "selection"
        assert controller.audit[-1]["group_production_ui"]["panel_kind"] == "single"
    asyncio.run(scenario())


def test_single_panel_cannot_claim_idle_for_multiple_recalled_producers():
    async def scenario():
        state, controller = await registered_two_nexus_group()
        panel = state.state.observation.ui_data.single
        panel.unit.unit_type, panel.unit.player_relative = 59, 1
        step(state, 48, selected=[1, 2])
        await controller.issue(state, [], 1006, selection_mode="control_group", control_group=2)
        step(state, 56, selected=[1, 2])
        await controller.advance(state)
        assert len(state.client.requests) == 5 and not controller.pending
        assert controller.audit[-1]["group_production_queue_rejection"] == "selected_production_queue_unavailable"
    asyncio.run(scenario())


def test_remote_research_requires_an_idle_selected_queue():
    async def scenario():
        state, controller = await registered_nexus_group()
        offscreen_production_observation(state, minerals=100, supply=0, ability=1568)
        state.game_data.units = {}
        state.game_data.upgrades = {1: SimpleNamespace(_proto=data.UpgradeData(
            upgrade_id=1, ability_id=1568, mineral_cost=50, vespene_cost=50))}
        state.state.observation.ui_data.production.production_queue.add(ability_id=1568, build_progress=.1)
        step(state, 24, selected=[1])
        await controller.issue(state, [], 1568, selection_mode="control_group", control_group=2)
        step(state, 32, selected=[1])
        await controller.advance(state)
        assert len(state.client.requests) == 3
        assert controller.audit[-1]["group_production_queue_rejection"] == "selected_production_queue_full"
    asyncio.run(scenario())


async def registered_two_nexus_group():
    state, controller = await registered_nexus_group()
    second = unit(2, type_id=59, is_structure=True)
    state.all_units = [second]
    state.state.observation_raw.units.add(tag=2, alliance=1)
    step(state, 24, selected=[1])
    await controller.issue(state, [second], None)
    step(state, 32, selected=[2])
    await controller.advance(state)
    step(state, 40, selected=[2])
    await controller.set_control_group(state, 2, append=True)
    offscreen_production_observation(state)
    first_hidden, second_hidden = HiddenSelectedUnit(), HiddenSelectedUnit()
    first_hidden.tag, second_hidden.tag = 1, 2
    state.all_units = [first_hidden, second_hidden]
    return state, controller


def multi_producer_ui(state, count=2):
    panel = state.state.observation.ui_data
    panel.ClearField("production")
    panel.ClearField("multi")
    for _ in range(count):
        panel.multi.units.add(unit_type=59, player_relative=1)


def test_group_producer_portraits_rotate_with_paid_confirmed_single_selection_and_preserve_group():
    from s2clientprotocol import ui_pb2 as ui

    async def scenario():
        state, controller = await registered_two_nexus_group()
        receipt = controller.control_group_receipt(2)
        for start_loop, selected_tag, expected_index in [(48, 1, 0), (72, 2, 1), (96, 1, 0)]:
            multi_producer_ui(state)
            step(state, start_loop, selected=[1, 2])
            assert await controller.issue(state, [], 1006, selection_mode="control_group", control_group=2)
            recall_index = len(controller.audit) - 1
            step(state, start_loop + 8, selected=[1, 2])
            assert await controller.advance(state)
            portrait = controller.audit[-1]
            assert portrait["selection_mode"] == "control_group_producer"
            assert portrait["parent_selection_audit_index"] == recall_index
            assert portrait["parent_selected_tags"] == [1, 2] and portrait["production_ui_index"] == expected_index
            action = state.client.requests[-1].actions[0].action_ui.multi_panel
            assert action.type == ui.ActionMultiPanel.SingleSelect and action.unit_index == expected_index
            assert controller.audit[recall_index]["command_confirmation"] == "production_subselection"
            assert controller.audit[recall_index]["command_source_tags"] == [1, 2]
            assert controller.pending and controller.confirmed_selection is None
            before = len(state.client.requests)
            step(state, start_loop + 9, selected=[selected_tag])
            await controller.advance(state)
            assert len(state.client.requests) == before  # Portrait cost enforces the same 0.3-second interval.
            panel = state.state.observation.ui_data.production
            panel.unit.unit_type, panel.unit.player_relative = 59, 1
            step(state, start_loop + 16, selected=[selected_tag])
            await controller.advance(state)
            command = controller.audit[-1]
            assert command["kind"] == "command" and command["selection_mode"] == "control_group_producer"
            assert command["source_tags"] == [selected_tag] and command["visible_command_source_tags"] == []
            assert command["selection_provenance_audit_index"] == recall_index + 1
            assert controller.confirmed_selection["tags"] == [selected_tag]
            assert controller.control_group_receipt(2) == receipt
        assert controller.budget.total == 13  # 4 registration inputs + 3 x (recall, portrait, command).
    asyncio.run(scenario())


@pytest.mark.parametrize("failure", ["extra", "empty", "unregistered", "queue_full", "missing_panel", "unavailable_ability"])
def test_paid_producer_subselection_rechecks_actual_selection_queue_and_ability(failure):
    async def scenario():
        state, controller = await registered_two_nexus_group()
        multi_producer_ui(state)
        step(state, 48, selected=[1, 2])
        await controller.issue(state, [], 1006, selection_mode="control_group", control_group=2)
        step(state, 56, selected=[1, 2])
        await controller.advance(state)
        assert controller.audit[-1]["selection_mode"] == "control_group_producer"
        selected = [1]
        if failure == "extra":
            selected = [1, 2]
        elif failure == "empty":
            selected = []
        elif failure == "unregistered":
            state.state.observation_raw.units.add(tag=3, alliance=1)
            selected = [3]
        panel = state.state.observation.ui_data.production
        panel.unit.unit_type, panel.unit.player_relative = 59, 1
        if failure == "queue_full":
            panel.production_queue.add(ability_id=1006)
            panel.production_queue.add(ability_id=1006)
        elif failure == "missing_panel":
            state.state.observation.ClearField("ui_data")
        elif failure == "unavailable_ability":
            state.state.observation.ClearField("abilities")
        step(state, 64, selected=selected)
        await controller.advance(state)
        assert len(state.client.requests) == 6  # 4 registration inputs, recall and portrait; no command.
        assert controller.audit[-1]["kind"] == "selection" and not controller.pending
        assert controller.control_group_receipt(2)["tags"] == [1, 2]
    asyncio.run(scenario())


@pytest.mark.parametrize("bad_panel", ["count", "type", "ownership"])
def test_producer_portrait_requires_matching_current_owned_ui_cards(bad_panel):
    async def scenario():
        state, controller = await registered_two_nexus_group()
        multi_producer_ui(state, count=1 if bad_panel == "count" else 2)
        if bad_panel == "type":
            state.state.observation.ui_data.multi.units[1].unit_type = 62
        elif bad_panel == "ownership":
            state.state.observation.ui_data.multi.units[1].player_relative = 4
        step(state, 48, selected=[1, 2])
        await controller.issue(state, [], 1006, selection_mode="control_group", control_group=2)
        step(state, 56, selected=[1, 2])
        await controller.advance(state)
        assert len(state.client.requests) == 5 and not controller.pending
        assert controller.audit[-1]["command_confirmation"] == "group_production_unavailable"
    asyncio.run(scenario())


@pytest.mark.parametrize("recall_group", [False, True])
def test_real_global_army_selection_can_attack_visible_ground_without_reading_any_source_position(recall_group):
    async def scenario():
        hidden = HiddenSelectedUnit()
        state = bot(hidden)
        own_selection_rows(state)
        screen_layers(state)
        controller = FairPlayController(camera_center=(50, 50))
        if recall_group:
            assert await controller.issue(state, [], None, selection_mode="army")
            step(state, 8, selected=[2])
            await controller.advance(state)
            assert await controller.set_control_group(state, 1)
            assert controller.control_group_receipt(1)["members"][0]["is_army"]
            step(state, 16, selected=[2])
            assert await controller.issue(state, [], 23, Point2((55, 50)),
                                          selection_mode="control_group", control_group=1)
            step(state, 24, selected=[2])
        else:
            assert await controller.issue(state, [], 23, Point2((55, 50)), selection_mode="army")
            step(state, 8, selected=[2])
        await controller.advance(state)
        event = controller.audit[-1]
        assert event["kind"] == "command" and event["ability"] == 23
        assert event["source_tags"] == [2] and event["visible_command_source_tags"] == []
        assert event["source_free_ground_command"]
        assert event["ground_target_safety"] == "current_visible_empty_screen"
        assert not event["minimap"]
    asyncio.run(scenario())


def test_source_free_f2_needs_real_nonempty_owned_selection_and_current_ground_vision():
    async def scenario(selected, visibility):
        state = bot(HiddenSelectedUnit())
        own_selection_rows(state)
        screen_layers(state, visibility=visibility)
        controller = FairPlayController(camera_center=(50, 50))
        assert await controller.issue(state, [], 23, Point2((55, 50)), selection_mode="army")
        step(state, 8, selected=selected)
        await controller.advance(state)
        assert len(state.client.requests) == 1
        assert controller.audit[0]["command_confirmation"] == ("source_not_selected" if not selected
                                                               else "no_clear_visible_screen_ground")
    asyncio.run(scenario([], 2))
    asyncio.run(scenario([2], 1))


def test_group_with_an_offscreen_building_cannot_cast_through_its_visible_building():
    async def scenario():
        state, controller = await registered_nexus_group()
        second = unit(2, type_id=59, is_structure=True)
        state.all_units.append(second)
        state.state.observation_raw.units.add(tag=2, alliance=1)
        step(state, 24, selected=[1])
        await controller.issue(state, [second], None)
        step(state, 32, selected=[2])
        await controller.advance(state)
        assert await controller.set_control_group(state, 2, append=True)
        hidden = HiddenSelectedUnit()
        hidden.tag = 1
        state.all_units = [hidden, second]
        step(state, 40, selected=[2])
        assert await controller.issue(state, [second], 3755, second, selection_mode="control_group", control_group=2)
        step(state, 48, selected=[1, 2])
        await controller.advance(state)
        assert controller.audit[-1]["kind"] == "selection"
        assert controller.audit[-1]["command_confirmation"] == "group_production_unavailable"
    asyncio.run(scenario())
