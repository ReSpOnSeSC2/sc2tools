"""Real FairPlayController/protobuf integration without launching SC2."""

import asyncio
from copy import deepcopy
from types import SimpleNamespace

import pytest
from sc2.ids.ability_id import AbilityId
from sc2.ids.unit_typeid import UnitTypeId
from sc2.position import Point2
from s2clientprotocol import common_pb2 as common
from s2clientprotocol import data_pb2 as data
from s2clientprotocol import raw_pb2 as raw

from pluto_sc2.fairplay import FairPlayController
from pluto_sc2.intent_runtime import IntentRuntime
from test_fairplay import RecordingClient
from test_rich_intents import action, context, normalize


def world(frame=None, *, result=1):
    frame = context() if frame is None else frame
    row = frame["entities"][0]
    source = SimpleNamespace(
        tag=row["tag"],
        type_id=UnitTypeId.PROBE,
        position=Point2(row["position"]),
        is_visible=True,
        is_on_screen=True,
        is_mine=True,
        is_enemy=False,
        is_snapshot=False,
        is_structure=False,
        is_flying=False,
        radius=0.375,
        _proto=raw.Unit(tag=row["tag"], alliance=raw.Self, unit_type=84, is_selected=False),
    )
    cam = frame["camera"]
    bot = SimpleNamespace(
        time=frame["game_loop"] / 22.4,
        state=SimpleNamespace(
            game_loop=frame["game_loop"],
            observation_raw=raw.ObservationRaw(
                player=raw.PlayerRaw(camera=common.Point(x=cam[0], y=cam[1])), units=[source._proto]
            ),
        ),
        units=[source],
        structures=[],
        enemy_units=[],
        enemy_structures=[],
        mineral_field=[],
        vespene_geyser=[],
        all_units=[source],
        client=RecordingClient(results=(result,)),
        game_info=SimpleNamespace(map_size=Point2((184, 200))),
        fairplay=FairPlayController(camera_center=cam),
        placement=True,
        queried_sources=[],
        placement_calls=[],
    )
    bot.game_data = SimpleNamespace(
        abilities={
            i: SimpleNamespace(
                id=AbilityId(i),
                _proto=data.AbilityData(
                    ability_id=i,
                    available=True,
                    target=data.AbilityData.Point,
                    allow_minimap=i == 16,
                    is_building=i in (880, 881, 894),
                    footprint_radius=1.5 if i == 894 else 1,
                ),
            )
            for i in (16, 880, 881, 894, 1006)
        }
    )
    bot.available = {16, 880, 881, 894, 1006}

    async def abilities(sources, ignore_resource_requirements=False):
        assert ignore_resource_requirements is False
        bot.queried_sources.append([u.tag for u in sources])
        return [[AbilityId(i) for i in bot.available] for _ in sources]

    async def place(ability, position):
        bot.placement_calls.append((ability.value, list(position)))
        return bot.placement

    bot.get_available_abilities, bot.can_place_single = abilities, place
    return bot


def advance(bot, frame, *, loops=8, selected=(101,), camera=None):
    frame["game_loop"] += loops
    bot.time, bot.state.game_loop = frame["game_loop"] / 22.4, frame["game_loop"]
    for entity in bot.state.observation_raw.units:
        entity.is_selected = entity.tag in selected
    if camera is not None:
        frame["camera"] = list(camera)
        bot.state.observation_raw.player.camera.CopyFrom(common.Point(x=camera[0], y=camera[1]))


def test_actual_controller_emits_one_selection_then_one_spatial_build():
    async def scenario():
        frame = context()
        intent, _ = normalize(action(881, (140, 150), (71, 43)), frame)
        bot, runtime = world(frame), IntentRuntime()
        first = await runtime.step(bot, intent, frame)
        assert first["stage"] == "selection_issued"
        assert bot.fairplay.pending and runtime.protected_tags == {101}
        assert len(bot.client.requests) == 1 and bot.fairplay.budget.total == 1
        advance(bot, frame)
        final = await runtime.step(bot, intent, frame)
        assert final["stage"] == "complete" and final["construction_observed"] is False
        assert not runtime.protected_tags and len(bot.client.requests) == 2
        assert bot.fairplay.budget.total == 2
        emitted = bot.client.requests[-1].actions[0]
        assert emitted.HasField("action_feature_layer") and not emitted.HasField("action_raw")
        assert emitted.action_feature_layer.unit_command.ability_id == 881
        assert len(bot.placement_calls) == 2 and bot.queried_sources == [[101], [101]]

    asyncio.run(scenario())


@pytest.mark.parametrize("change", ["placement", "ability", "source", "frame"])
def test_preflight_change_cancels_pending_without_emitting_command(change):
    async def scenario():
        frame = context()
        intent, _ = normalize(action(881, (140, 150), (71, 43)), frame)
        bot, runtime = world(frame), IntentRuntime()
        await runtime.step(bot, intent, frame)
        advance(bot, frame)
        if change == "placement":
            bot.placement = False
        elif change == "ability":
            bot.available = set()
        elif change == "source":
            bot.units[0].is_on_screen = False
        else:
            frame["game_loop"] -= 1
        result = await runtime.step(bot, intent, frame)
        assert result["stage"] == "deferred" and not bot.fairplay.pending
        assert len(bot.client.requests) == 1 and bot.fairplay.budget.total == 1
        assert bot.fairplay.audit[0]["cancelled_before_command"] is True

    asyncio.run(scenario())


def test_missed_selection_is_not_counted_as_completed_construction():
    async def scenario():
        frame = context()
        intent, _ = normalize(action(881, (140, 150), (71, 43)), frame)
        bot, runtime = world(frame), IntentRuntime()
        await runtime.step(bot, intent, frame)
        advance(bot, frame, selected=())
        result = await runtime.step(bot, intent, frame)
        assert result["stage"] == "deferred" and "source_not_selected" in result["reason"]
        assert len(bot.client.requests) == 1

    asyncio.run(scenario())


def test_queued_expert_intent_never_reaches_unqueued_controller():
    async def scenario():
        frame = context()
        intent, _ = normalize(action(queued=True), frame)
        bot = world(frame)
        result = await IntentRuntime().step(bot, intent, frame)
        assert result["stage"] == "deferred" and bot.client.requests == []

    asyncio.run(scenario())


def test_assisted_core_first_pays_camera_then_reobserves_before_selecting():
    async def scenario():
        frame = context()
        intent, _ = normalize(action(), frame)
        bot, runtime = world(frame), IntentRuntime()
        result = await runtime.step(bot, intent, frame)
        assert result["stage"] == "camera_issued"
        assert not bot.queried_sources and not bot.placement_calls
        target = bot.fairplay.audit[-1]["destination"]
        advance(bot, frame, camera=target)
        assert (await runtime.step(bot, intent, frame))["stage"] == "selection_issued"
        assert bot.fairplay.budget.total == 2

    asyncio.run(scenario())


def test_foreign_pending_task_is_not_advanced_or_cancelled():
    async def scenario():
        frame = context()
        intent, _ = normalize(action(881, (140, 150), (71, 43)), frame)
        bot = world(frame)
        await bot.fairplay.issue(bot, bot.units, 881, Point2((140, 150)))
        advance(bot, frame)
        intent, _ = normalize(action(881, (140, 150), (71, 43), loop=frame["game_loop"] + 1), frame)
        result = await IntentRuntime().step(bot, intent, frame)
        assert result["reason"] == "controller_owned_by_other_task"
        assert len(bot.client.requests) == 1 and bot.fairplay.pending

    asyncio.run(scenario())


def test_cancel_hook_rejects_missing_reason_keeps_paid_budget_and_audit():
    async def scenario():
        bot = world()
        await bot.fairplay.issue(bot, bot.units, 881, Point2((140, 150)))
        for reason in (None, "", " "):
            with pytest.raises(ValueError):
                bot.fairplay.cancel_pending(reason)
        assert bot.fairplay.pending and bot.fairplay.cancel_pending("placement_changed")
        assert not bot.fairplay.pending and not bot.fairplay.cancel_pending("again")
        assert bot.fairplay.budget.total == 1 and len(bot.client.requests) == 1
        assert bot.fairplay.audit[0]["command_confirmation"] == "placement_changed"

    asyncio.run(scenario())


def test_runtime_cannot_mutate_training_intent_or_frame():
    async def scenario():
        frame = context()
        intent, _ = normalize(action(881, (140, 150), (71, 43)), frame)
        before = deepcopy((intent, frame))
        await IntentRuntime().step(world(frame), intent, frame)
        assert (intent, frame) == before

    asyncio.run(scenario())


def test_archived_intent_is_not_initially_bound_to_a_later_observation():
    async def scenario():
        frame = context()
        intent, _ = normalize(action(881, (140, 150), (71, 43)), frame)
        bot = world(frame)
        advance(bot, frame)
        result = await IntentRuntime().step(bot, intent, frame)
        assert result["reason"] == "new_intent_not_bound_to_current_observation"
        assert not bot.client.requests

    asyncio.run(scenario())


def test_source_identity_type_is_checked_before_ability_queries():
    async def scenario():
        frame = context()
        intent, _ = normalize(action(881, (140, 150), (71, 43)), frame)
        bot = world(frame)
        bot.units[0].type_id = UnitTypeId.STALKER
        result = await IntentRuntime().step(bot, intent, frame)
        assert result["reason"] == "source_type_no_longer_matches_bound_intent"
        assert not bot.client.requests and not bot.queried_sources

    asyncio.run(scenario())


def test_distant_nexus_route_requires_observed_point_order_after_actual_move():
    async def scenario():
        frame = context()
        intent, _ = normalize(action(880, (170, 180), (127, 0)), frame)
        bot, runtime = world(frame), IntentRuntime()
        assert (await runtime.step(bot, intent, frame))["stage"] == "selection_issued"
        advance(bot, frame)
        assert (await runtime.step(bot, intent, frame))["stage"] == "route_input_accepted"
        assert "route" not in runtime.confirmations
        emitted = bot.client.requests[-1].actions[0].action_feature_layer.unit_command
        assert emitted.ability_id == 16 and emitted.WhichOneof("target") == "target_minimap_coord"
        # Actual currently visible own order is the required independent proof.
        bot.units[0]._proto.orders.add(ability_id=16, target_world_space_pos=common.Point(x=170, y=180))
        advance(bot, frame)
        assert (await runtime.step(bot, intent, frame))["stage"] == "route_confirmed"
        assert runtime.confirmations["route"]["point_order_confirmed"]
        advance(bot, frame)
        assert (await runtime.step(bot, intent, frame))["stage"] == "wait"
        assert len(bot.client.requests) == 2

    asyncio.run(scenario())


def test_route_follow_unit_order_is_not_mistaken_for_ground_progress():
    async def scenario():
        frame = context()
        intent, _ = normalize(action(880, (170, 180), (127, 0)), frame)
        bot, runtime = world(frame), IntentRuntime()
        await runtime.step(bot, intent, frame)
        advance(bot, frame)
        await runtime.step(bot, intent, frame)
        bot.units[0]._proto.orders.add(ability_id=16, target_unit_tag=999)
        advance(bot, frame, loops=23)
        result = await runtime.step(bot, intent, frame)
        assert result["reason"] == "route_order_not_observed_as_ground_move"
        assert "route" not in runtime.confirmations

    asyncio.run(scenario())
