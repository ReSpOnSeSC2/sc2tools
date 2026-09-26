"""Critical opening priority uses ordinary queried spatial build intentions."""
import asyncio
from types import SimpleNamespace as NS

import pytest
from sc2.ids.ability_id import AbilityId as A
from sc2.ids.unit_typeid import UnitTypeId as U
from sc2.position import Point2
from s2clientprotocol import sc2api_pb2 as api

from pluto_sc2.coach_supply_opening import SupplyOpeningPlan
from pluto_sc2.schema import ACTION_TO_INDEX
from pluto_sc2.worker_scout import WorkerScoutLease
from test_coach_bot import Unit, known_base, order, world


CASES = [("build_assimilator", U.ASSIMILATOR, A.PROTOSSBUILD_ASSIMILATOR, 75),
         ("build_cyberneticscore", U.CYBERNETICSCORE, A.PROTOSSBUILD_CYBERNETICSCORE, 150)]


def construction_world(tmp_path, case=CASES[1]):
    name, kind, ability, minerals = case
    bot = world(tmp_path)
    bot.memory.own[99] = known_base()
    bot._opening_decision = NS(active=True, reserve=True, supply_threshold=17, next_action=name,
        next_base_index=0, step=4, desired_gas_by_base={0: 2}, desired_gas_count=2,
        to_dict=lambda: {"next_action": name, "supply_threshold": 17})
    bot._worker_scout_lease = WorkerScoutLease()
    bot.minerals, bot.vespene = minerals, 0
    bot.units = [Unit(position=(49, 50))]
    bot.game_data.units[kind.value] = NS(creation_ability=NS(id=ability))
    bot.game_data.abilities[ability.value] = NS(id=ability)
    bot._gas_camera_target = lambda _: None
    bot.placement_candidate_allowed = lambda *_: True
    bot.placement_candidate_points = lambda *_: []
    bot.query_log, bot.placement_log = [], []

    def cost(requested):
        if requested != kind:
            raise KeyError(requested)
        return NS(minerals=minerals, vespene=0)

    async def abilities(units, *, ignore_resource_requirements):
        bot.query_log.append(([unit.tag for unit in units], ignore_resource_requirements))
        return [[ability] if bot.can_afford(kind) else [] for _ in units]

    async def places(requested_ability, points):
        bot.placement_log.append((requested_ability, list(points)))
        return [True] * len(points)

    async def place_single(requested_ability, point):
        bot.placement_log.append((requested_ability, [point]))
        return True

    bot.calculate_cost = cost
    bot.can_afford = lambda requested: requested == kind and bot.minerals >= minerals
    bot.can_feed = lambda _: False
    bot.get_available_abilities = abilities
    bot.can_place, bot.can_place_single = places, place_single
    if kind == U.ASSIMILATOR:
        bot.vespene_geyser = [Unit(U.VESPENEGEYSER, tag=90, position=(54, 50), is_mine=False)]
    return bot


@pytest.mark.parametrize("case", CASES)
@pytest.mark.parametrize("offset", [-1, 0])
def test_exact_public_75_gas_and_150_core_mineral_thresholds(tmp_path, case, offset):
    bot = construction_world(tmp_path, case)
    bot.minerals = case[3] + offset
    accepted = asyncio.run(bot._critical_opening_step(bot.units, order()))
    assert accepted is (offset == 0)
    assert bot._opening_construction_status["public_cost"] == {"minerals": float(case[3]), "vespene": 0.0}
    if offset < 0:
        assert bot._opening_construction_status["reason"] == "waiting_for_current_resources"
        assert not bot.query_log and not bot.client.requests
    else:
        assert bot.query_log == [([1], False)]
        assert bot.placement_log and bot.placement_log[0][0] == case[2]
        assert bot.fairplay.audit[0]["ability"] == case[2].value


@pytest.mark.parametrize("condition", ["defense", "inactive", "unreserved", "no_supply_threshold", "absent", "not_building"])
def test_critical_slot_is_inactive_during_defense_or_without_explicit_due_build(tmp_path, condition):
    bot = construction_world(tmp_path)
    if condition == "defense":
        bot._defense_alert = {"base_tag": 99}
    elif condition == "inactive":
        bot._opening_decision.active = False
    elif condition == "unreserved":
        bot._opening_decision.reserve = False
    elif condition == "no_supply_threshold":
        bot._opening_decision.supply_threshold = None
    elif condition == "absent":
        bot._opening_decision = None
    else:
        bot._opening_decision.next_action = "train_probe"
    assert not asyncio.run(bot._critical_opening_step(bot.units, order()))
    assert not bot.query_log and not bot.placement_log and not bot.client.requests


def test_missing_public_price_does_not_guess_build_cost(tmp_path):
    bot = construction_world(tmp_path)
    bot.calculate_cost = lambda _: NS(minerals=0, vespene=0)
    assert not asyncio.run(bot._critical_opening_step(bot.units, order()))
    assert bot._opening_construction_status["public_cost"] is None
    assert not bot.query_log and not bot.client.requests


@pytest.mark.parametrize("case", CASES)
def test_observed_core_restores_normal_worker_priority_instead_of_critical_gas_or_build_slot(tmp_path, case):
    bot = construction_world(tmp_path, case)
    bot._opening_decision.core_foundation_observed = True
    assert not asyncio.run(bot._critical_opening_step(bot.units, order()))
    assert not bot.query_log and not bot.placement_log and not bot.client.requests
    assert not bot._selected_actions and not bot._construction


def test_unobserved_intended_base_does_not_query_or_build(tmp_path):
    bot = construction_world(tmp_path)
    bot.memory.own.clear()
    assert not asyncio.run(bot._critical_opening_step(bot.units, order()))
    assert bot._opening_construction_status["reason"] == "intended_base_not_yet_observed"
    assert not bot.query_log and not bot.client.requests


def test_paid_camera_targets_remembered_ready_main_pylon_not_remote_base_pylon(tmp_path):
    bot = construction_world(tmp_path)
    bot.memory.own[100] = known_base((80, 50), tag=100)
    bot.memory.own[60] = {"type": "PYLON", "tag": 60, "position": [54, 50], "is_ready": True}
    bot.memory.own[61] = {"type": "PYLON", "tag": 61, "position": [79, 50], "is_ready": True}
    bot.memory.own[62] = {"type": "PYLON", "tag": 62, "position": [51, 50], "is_ready": False}
    bot.fairplay.camera_center = Point2((100, 100))
    bot._combat_camera_until = bot._combat_upkeep_until = 50
    bot._combat_view_started = 5
    assert asyncio.run(bot._critical_opening_step([], order()))
    assert len(bot.fairplay.audit) == 1
    assert bot.fairplay.audit[0]["kind"] == "camera"
    assert bot.fairplay.audit[0]["destination"] == [54, 50]
    assert bot.fairplay.audit[0]["result"] == [1]
    action = bot.client.requests[0].actions[0]
    assert action.action_feature_layer.HasField("camera_move") and not action.HasField("action_raw")
    assert bot._opening_camera_until == bot.time + 3
    assert bot._combat_camera_until == bot._combat_upkeep_until == -100
    assert not bot.query_log and not bot._construction and not bot._selected_actions


def test_rejected_camera_does_not_claim_hold_or_build(tmp_path):
    bot = construction_world(tmp_path)
    bot.fairplay.camera_center = Point2((100, 100))
    previous_hold = bot._opening_camera_until

    async def reject(**kwargs):
        bot.client.requests.append(kwargs["action"])
        return api.Response(action=api.ResponseAction(result=[2]))

    bot.client._execute = reject
    assert not asyncio.run(bot._critical_opening_step([], order()))
    assert bot._opening_camera_until == previous_hold
    assert bot.fairplay.audit[0]["result"] == [2]
    assert not bot._construction and not bot._selected_actions


@pytest.mark.parametrize("case", CASES)
def test_ordinary_ability_and_placement_queries_precede_real_spatial_selection(tmp_path, case):
    bot = construction_world(tmp_path, case)
    assert asyncio.run(bot._critical_opening_step(bot.units, order()))
    assert bot.query_log == [([1], False)]
    assert bot.placement_log and all(bot.fairplay.on_screen(point) for _, points in bot.placement_log for point in points)
    intent = bot._pluto_action_context[ACTION_TO_INDEX[case[0]]]
    assert intent.sources == tuple(bot.units) and intent.ability == case[2]
    assert len(bot.client.requests) == 1
    action = bot.client.requests[0].actions[0]
    assert action.action_feature_layer.HasField("unit_selection_point")
    assert not action.action_feature_layer.HasField("unit_command") and not action.HasField("action_raw")
    assert bot._selected_actions[0]["name"] == case[0]
    assert not bot._construction  # A paid selection is still not a completed construction command.


def test_current_legal_main_gas_builds_before_considering_other_offscreen_geyser(tmp_path):
    bot = construction_world(tmp_path, CASES[0])
    bot.fairplay.camera_center = Point2((58, 58))
    bot.units = [Unit(position=(55, 55))]
    near = Unit(U.VESPENEGEYSER, tag=90, position=(56, 56), is_mine=False)
    other = Unit(U.VESPENEGEYSER, tag=91, position=(44, 42), is_mine=False)
    bot.vespene_geyser = [near, other]
    assert bot.fairplay.on_screen(near) and not bot.fairplay.on_screen(other)
    camera_choices = []

    def other_gas(_order):
        camera_choices.append(other.position)
        return {"position": list(other.position)}

    bot._gas_camera_target = other_gas
    assert asyncio.run(bot._critical_opening_step(bot.units, order()))
    assert camera_choices == []
    assert len(bot.fairplay.audit) == 1 and bot.fairplay.audit[0]["kind"] == "selection"
    assert bot.fairplay.audit[0]["unit_target_tag"] == near.tag
    assert bot._opening_construction_status["reason"] == "selection_requested"
    assert bot.placement_log == [(A.PROTOSSBUILD_ASSIMILATOR, [near.position])]


def test_gas_reframe_then_fresh_legal_gas_build_does_not_bounce_camera_back(tmp_path):
    bot = construction_world(tmp_path, CASES[0])
    bot.fairplay.camera_center = Point2((44, 42))
    bot.units = [Unit(position=(54, 54))]
    near = Unit(U.VESPENEGEYSER, tag=90, position=(56, 56), is_mine=False)
    bot.vespene_geyser = [near]
    calls = []

    def gas_camera(_order):
        calls.append(len(calls))
        # The old implementation would consider the other side on the second
        # frame before checking the gas site now present in this camera.
        return {"position": [56, 56] if len(calls) == 1 else [44, 42]}

    bot._gas_camera_target = gas_camera
    assert asyncio.run(bot._critical_opening_step(bot.units, order()))
    assert bot.fairplay.audit[0]["kind"] == "camera"
    assert bot.fairplay.audit[0]["destination"] == [56, 56]
    assert not bot._selected_actions and not bot.placement_log
    # A later actual camera observation and normal budget spacing, not a
    # synthetic accepted camera destination used as a build observation.
    bot.state.game_loop += 24
    bot.state.observation_raw.player.camera.x = 56
    bot.state.observation_raw.player.camera.y = 56
    bot.fairplay.sync_camera(bot)
    assert asyncio.run(bot._critical_opening_step(bot.units, order()))
    assert calls == [0]
    assert [event["kind"] for event in bot.fairplay.audit] == ["camera", "selection"]
    assert bot.fairplay.audit[1]["unit_target_tag"] == near.tag
    assert bot._selected_actions[1]["name"] == "build_assimilator"


def test_core_same_quantized_camera_pixel_queries_and_builds_despite_world_distance_over_three(tmp_path):
    bot = construction_world(tmp_path)
    bot.game_info.map_size = Point2((400, 400))  # 64px minimap means 6.25 world tiles per pixel.
    bot.memory.own[60] = {"type": "PYLON", "tag": 60, "position": [54, 50], "is_ready": True}
    intended = Point2((54, 50))
    assert bot.fairplay.camera_center.distance_to(intended) > 3
    assert bot.fairplay.minimap_point(bot, intended) == bot.fairplay.minimap_point(bot, bot.fairplay.camera_center)
    assert not bot.fairplay.camera_would_move(bot, intended)
    assert asyncio.run(bot._critical_opening_step(bot.units, order()))
    assert bot.query_log == [([1], False)] and bot.placement_log
    assert [event["kind"] for event in bot.fairplay.audit] == ["selection"]
    assert bot.fairplay.audit[0]["ability"] == A.PROTOSSBUILD_CYBERNETICSCORE.value
    assert bot._opening_construction_status["reason"] == "selection_requested"


@pytest.mark.parametrize("failure", ["ability", "placement"])
def test_failed_native_legality_query_cannot_issue_build(tmp_path, failure):
    bot = construction_world(tmp_path)
    if failure == "ability":
        async def abilities(units, **kwargs):
            return [[] for _ in units]
        bot.get_available_abilities = abilities
    else:
        async def places(_ability, points):
            return [False] * len(points)
        bot.can_place = places
    assert not asyncio.run(bot._critical_opening_step(bot.units, order()))
    assert bot._opening_construction_status["reason"] == "no_current_legal_construction_intent"
    assert not bot.client.requests and not bot._construction


@pytest.mark.parametrize("reservation", ["scout", "construction", "transfer", "expansion"])
def test_reserved_nearest_worker_cannot_starve_legal_second_builder(tmp_path, reservation):
    bot = construction_world(tmp_path)
    bot.units = [Unit(tag=1, position=(50.5, 50.5)), Unit(tag=2, position=(54, 50))]
    if reservation == "scout":
        bot._worker_scout_lease.designated_worker_tag = 1
    elif reservation == "construction":
        bot._construction = [{"type": "PYLON", "source_tag": 1, "position": [53, 52]}]
    elif reservation == "transfer":
        bot._worker_transfers = {1: {"source_tag": 1}}
    else:
        bot._expansion = {"source_tag": 1}
    assert asyncio.run(bot._critical_opening_step(bot.units, order()))
    assert bot.fairplay.audit[0]["source_tags"] == [2]


def test_reserved_scout_as_only_worker_is_not_borrowed_for_core(tmp_path):
    bot = construction_world(tmp_path)
    bot._worker_scout_lease.designated_worker_tag = 1
    assert not asyncio.run(bot._critical_opening_step(bot.units, order()))
    assert not bot.client.requests and not bot._selected_actions


def test_rejected_selection_is_not_recorded_as_construction(tmp_path):
    bot = construction_world(tmp_path)

    async def reject(**kwargs):
        bot.client.requests.append(kwargs["action"])
        return api.Response(action=api.ResponseAction(result=[2]))

    bot.client._execute = reject
    assert not asyncio.run(bot._critical_opening_step(bot.units, order()))
    assert bot._opening_construction_status["reason"] == "selection_rejected"
    assert not bot._selected_actions and not bot._construction
    assert bot.fairplay.audit[0]["command_confirmation"] == "selection_rejected"


@pytest.mark.parametrize("confirmation", ["engine_rejected", "accepted"])
def test_later_command_confirmation_controls_construction_credit(tmp_path, confirmation):
    bot = construction_world(tmp_path)
    assert asyncio.run(bot._critical_opening_step(bot.units, order()))
    recorded = []
    bot.executor.record_action = lambda *args, **kwargs: recorded.append((args, kwargs))
    bot.fairplay.audit[0].update(command_confirmation=confirmation, command_loop=232, command_source_tags=[1])
    bot.state.game_loop = 240
    bot._confirm_commands(bot.units)
    assert bool(bot._construction) is (confirmation == "accepted")
    assert recorded[0][0][0] == "build_cyberneticscore"
    assert recorded[0][0][2] is (confirmation == "accepted")


@pytest.mark.parametrize("remote", [False, True])
def test_pending_matching_core_is_verified_without_duplicate_even_at_zero_minerals(tmp_path, remote):
    bot = construction_world(tmp_path)
    bot.minerals = 0
    bot._construction = [{"type": "CYBERNETICSCORE", "source_tag": 1, "position": [51, 50]}]
    if remote:
        bot.fairplay.camera_center = Point2((100, 100))
    assert asyncio.run(bot._critical_opening_step(bot.units, order()))
    assert bot._opening_construction_status["reason"] == "accepted_construction_awaiting_foundation"
    assert not bot.query_log and not bot.placement_log and not bot._selected_actions
    assert len(bot._construction) == 1
    assert len(bot.client.requests) == int(remote)
    if remote:
        assert bot.fairplay.audit[0]["kind"] == "camera"
        assert bot.fairplay.audit[0]["destination"] == [51, 50]


def test_pending_other_base_core_does_not_satisfy_main_core(tmp_path):
    bot = construction_world(tmp_path)
    bot.memory.own[100] = known_base((80, 50), tag=100)
    bot._construction = [{"type": "CYBERNETICSCORE", "source_tag": 2, "position": [80, 52]}]
    assert asyncio.run(bot._critical_opening_step(bot.units, order()))
    assert bot._opening_construction_status["reason"] == "selection_requested"


@pytest.mark.parametrize("threat", ["remote_scout", "base_defense", "retreat"])
def test_explicit_supply_opening_only_suspends_for_base_defense_or_retreat(tmp_path, threat):
    bot = construction_world(tmp_path)
    bot.opening = SupplyOpeningPlan()
    bot._current_order = order(stance="retreat" if threat == "retreat" else "defend")
    if threat == "base_defense":
        bot._defense_alert = {"base_tag": 99}
    enemy = Unit(U.SCV, tag=80, position=(150, 150), is_mine=False, is_enemy=True)
    bot._refresh_opening([enemy])
    assert (bot._opening_decision.status == "suspended") is (threat != "remote_scout")
