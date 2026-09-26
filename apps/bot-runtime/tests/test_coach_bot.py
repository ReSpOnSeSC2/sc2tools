import asyncio
import math
from types import SimpleNamespace as NS
import time

import numpy as np
import pytest
from sc2.data import Result
from sc2.ids.ability_id import AbilityId as A
from sc2.ids.unit_typeid import UnitTypeId as U
from sc2.ids.upgrade_id import UpgradeId as Upgrade
from sc2.position import Point2
from sc2.unit import Unit as SC2Unit
from s2clientprotocol import common_pb2 as common
from s2clientprotocol import raw_pb2 as raw
from s2clientprotocol import sc2api_pb2 as api

from pluto_sc2.coach_bot import CoachBot
from pluto_sc2.coach_executor import CoachExecutor
from pluto_sc2.coach_opening import OpeningPlan, OpeningStep
from pluto_sc2.coach_orders import StrategyOrder, write_strategy
from pluto_sc2.fairplay import FairPlayController
from pluto_sc2.schema import ACTION_NAMES
from pluto_sc2.sc2_adapter import _visible_footprint
from pluto_sc2.worker_scout import WorkerScoutLease


class Unit(NS):
    def __init__(self, kind=U.PROBE, tag=1, position=(50, 50), **kwargs):
        values = dict(type_id=kind, tag=tag, position=Point2(position), is_idle=False, is_ready=True,
                      is_mine=True, is_enemy=False, is_visible=True, is_on_screen=True, is_snapshot=False,
                      is_cloaked=False, is_revealed=False, is_collecting=True, is_structure=kind == U.NEXUS)
        values.update(kwargs)
        super().__init__(**values)

    def distance_to(self, value):
        return self.position.distance_to(value.position if hasattr(value, "position") else value)


class Client:
    def __init__(self):
        self.requests = []

    async def _execute(self, **kwargs):
        self.requests.append(kwargs["action"])
        return api.Response(action=api.ResponseAction(result=[1]))


class Memory:
    def __init__(self):
        self.own = {}
        self.observed = []

    def observe(self, bot, own, enemies):
        self.observed.append((list(own), list(enemies)))

    def report(self, bot):
        return {"game_seconds": bot.time, "hud": {}, "current_own": [], "current_enemies": [],
                "own_memory": list(self.own.values())}


def order(game_id="test-game", **updates):
    data = {"schema": 1, "game_id": game_id, "revision": 1, "based_on_report": 0,
            "issued_game_seconds": 0, "valid_until_game_seconds": 600, "stance": "defend",
            "scout": False, "worker_target": 32, "base_target": 2, "gas_workers_per_base": 3,
            "production_targets": {"GATEWAY": 2}, "composition": {"STALKER": 8},
            "research": [], "rationale": "Test order"}
    data.update(updates)
    return StrategyOrder.from_dict(data)


def world(tmp_path):
    bot = CoachBot(tmp_path, "test-game", speed=50)
    bot.state = NS(game_loop=224, dead_units=set(), upgrades=set(), observation_raw=raw.ObservationRaw(
        player=raw.PlayerRaw(camera=common.Point(x=50, y=50))))
    bot.game_info = NS(player_start_location=Point2((50, 50)), start_locations=[Point2((150, 150))],
                       map_size=Point2((200, 200)), playable_area=NS(x=0, y=0, width=200, height=200))
    bot.game_data = NS(units={}, abilities={A.PROTOSSBUILD_NEXUS.value: NS(id=A.PROTOSSBUILD_NEXUS)})
    bot.units, bot.structures, bot.enemy_units, bot.enemy_structures = [], [], [], []
    bot.mineral_field, bot.vespene_geyser = [], []
    bot.minerals, bot.vespene = 500, 0
    bot.client = Client()
    bot.fairplay = FairPlayController(camera_center=(50, 50))
    bot.is_visible = lambda _: True
    bot.memory = Memory()
    bot._worker_scout_lease = NS(designated_worker_tag=None, observe=lambda *_: None, summary=lambda: {})
    bot._economic_guard = NS(observe=lambda *_: None)
    bot._wall_start = time.monotonic() - 1000
    return bot


def known_base(position=(50, 50), tag=99):
    return {"type": "NEXUS", "tag": tag, "position": list(position), "is_ready": True,
            "is_structure": True, "last_seen_seconds": 10, "assigned_harvesters": 8, "ideal_harvesters": 16}


def test_worker_move_uses_spatial_gate_and_selection_is_not_completed_command(tmp_path):
    bot, worker = world(tmp_path), Unit()
    assert asyncio.run(bot._move_worker(worker, Point2((80, 50)), "expand_move"))
    assert len(bot.client.requests) == 1
    action = bot.client.requests[0].actions[0]
    assert action.HasField("action_feature_layer") and not action.HasField("action_raw")
    assert bot._selected_actions and not bot._construction
    bot._expansion = {"move_confirmed": False}
    bot._confirm_commands([worker])
    assert not bot._expansion["move_confirmed"]
    bot.fairplay.audit[0].update(command_confirmation="accepted", command_loop=232)
    bot.state.game_loop = 240
    bot._confirm_commands([worker])
    assert bot._expansion["move_confirmed"]
    assert not bot._selected_actions


@pytest.mark.parametrize("confirmation", [None, "source_not_selected", "engine_rejected", "accepted"])
def test_construction_reservation_requires_confirmed_command(tmp_path, confirmation):
    bot, worker = world(tmp_path), Unit()
    event = {"kind": "selection", "source_tags": [worker.tag], "result": [1]}
    if confirmation is not None:
        event["command_confirmation"] = confirmation
    bot.fairplay.audit.append(event)
    bot._selected_actions[0] = {"name": "build_pylon", "position": [53, 50], "revision": 1}
    recorded = []
    bot.executor = NS(record_action=lambda *args: recorded.append(args))
    bot._confirm_commands([worker])
    assert bool(bot._construction) is (confirmation == "accepted")
    assert bool(recorded) is (confirmation is not None)
    if confirmation is not None:
        assert recorded[0][-1] is (confirmation == "accepted")


def test_army_camera_destination_follows_confirmed_short_waypoint(tmp_path):
    bot = world(tmp_path)
    bot.fairplay.audit.append({"kind": "selection", "source_tags": [7], "result": [1],
                              "command_confirmation": "accepted", "effective_target": [54, 51]})
    bot._selected_actions[0] = {"name": "attack_enemy_base", "position": [150, 150], "revision": 1}
    bot._confirm_commands([])
    assert bot._army_destination == [54, 51]


@pytest.mark.parametrize("ability,retained", [
    (A.HARVEST_GATHER_PROBE, False),
    (A.MOVE_MOVE, False),
    (A.PROTOSSBUILD_GATEWAY, False),
    (A.PROTOSSBUILD_PYLON, True),
])
def test_empty_visible_construction_site_resolves_from_current_builder_orders(tmp_path, ability, retained):
    bot = world(tmp_path)
    bot.state.game_loop = 2240
    task = {"type": "PYLON", "position": [53, 50], "source_tag": 1, "issued_game_seconds": 0}
    bot._construction = [task]
    builder = Unit(orders=[NS(ability=NS(id=ability))])
    bot._confirm_commands([builder])
    assert bot._construction == ([task] if retained else [])


@pytest.mark.parametrize("absence", ["builder", "site_fog", "site_offscreen", "unavailable_orders"])
def test_uncertain_construction_is_not_expired_by_elapsed_time(tmp_path, absence):
    bot = world(tmp_path)
    bot.state.game_loop = 22400
    task = {"type": "PYLON", "position": [53, 50], "source_tag": 1, "issued_game_seconds": 0}
    bot._construction = [task]
    own = [Unit(is_idle=True)]
    if absence == "builder":
        own = []
    elif absence == "site_fog":
        bot.is_visible = lambda _: False
    elif absence == "site_offscreen":
        bot.fairplay.camera_center = Point2((100, 100))
    else:
        own = [Unit(is_idle=False)]
    bot._confirm_commands(own)
    assert bot._construction == [task]


def test_failed_initial_expansion_selection_does_not_leave_unresolvable_task(tmp_path):
    bot = world(tmp_path)
    bot.memory.own[99] = known_base()
    bot._public_sites = [Point2((80.5, 50.5))]

    async def rejected(*_):
        return False

    bot._move_worker = rejected
    assert not asyncio.run(bot._expansion_step([Unit()], order()))
    assert bot._expansion is None


def test_expansion_footprint_fog_blocks_ability_and_placement_queries(tmp_path):
    bot = world(tmp_path)
    bot.fairplay.camera_center = Point2((80.5, 50.5))
    bot._expansion = {"position": [80.5, 50.5], "source_tag": 1, "started": 0, "move_confirmed": True}
    bot.is_visible = lambda point: point != Point2((79.5, 49.5))

    async def forbidden(*_args, **_kwargs):
        pytest.fail("fogged expansion may not trigger any ability or placement query")

    bot.get_available_abilities = forbidden
    bot.can_place_single = forbidden
    assert not asyncio.run(bot._expansion_step([Unit(position=(80, 50))], order()))
    assert not bot.client.requests


def test_visible_expansion_queries_only_its_on_screen_worker_and_exact_site(tmp_path):
    bot = world(tmp_path)
    point = Point2((80.5, 50.5))
    worker = Unit(position=(80, 50))
    bot.fairplay.camera_center = point
    bot._expansion = {"position": list(point), "source_tag": worker.tag, "started": 0, "move_confirmed": True}
    queried = []

    async def available(units, **kwargs):
        queried.append((units, kwargs))
        return [[A.PROTOSSBUILD_NEXUS]]

    async def placement(ability, target):
        assert ability == A.PROTOSSBUILD_NEXUS and target == point
        return True

    bot.get_available_abilities = available
    bot.can_place_single = placement
    assert asyncio.run(bot._expansion_step([worker], order()))
    assert queried == [([worker], {"ignore_resource_requirements": False})]
    assert bot.fairplay.audit[-1]["kind"] == "selection"
    assert not bot._construction
    assert bot._selected_actions[0]["name"] == "build_nexus"


def test_absent_expansion_worker_never_causes_offscreen_lookup_or_remote_order(tmp_path):
    bot = world(tmp_path)
    bot.fairplay.camera_center = Point2((80.5, 50.5))
    bot._expansion = {"position": [80.5, 50.5], "source_tag": 1, "started": 0, "move_confirmed": True}

    class Hidden:
        def __getattribute__(self, name):
            raise AssertionError(f"hidden unit queried: {name}")

    bot.units = [Hidden()]

    async def forbidden(*_args, **_kwargs):
        pytest.fail("must not query or command absent worker")

    bot.get_available_abilities = forbidden
    bot.can_place_single = forbidden
    assert not asyncio.run(bot._expansion_step([], order()))
    assert not bot.client.requests


def test_expansion_camera_revisit_leaves_time_for_home_actions(tmp_path):
    bot = world(tmp_path)
    bot._last_camera_change = bot.time - 1
    bot._expansion = {"position": [80.5, 50.5], "source_tag": 1, "started": 0, "move_confirmed": True}
    assert not asyncio.run(bot._expansion_step([], order()))
    assert not bot.client.requests
    bot.state.game_loop += 112
    assert asyncio.run(bot._expansion_step([], order()))
    assert bot.fairplay.audit[-1]["kind"] == "camera"


def test_pending_expansion_does_not_suppress_home_and_scout_camera_schedule(tmp_path):
    bot = world(tmp_path)
    bot._expansion = {"position": [50, 50], "source_tag": 1, "started": 0, "move_confirmed": True}
    visits = []

    async def schedule(own, plan):
        visits.append((own, plan))
        return True

    bot._camera_schedule = schedule
    asyncio.run(bot._step(0))
    assert visits == [([], None)]


def test_scout_attention_revisits_public_destination_and_returns_home(tmp_path):
    bot = world(tmp_path)
    bot.state.game_loop = 448
    bot._start_scout_camera_lease(1, [150, 150], [])
    bot.state.game_loop = 1120  # 50 seconds
    bot._last_scout_dispatch = 20
    base = known_base()
    base["last_seen_seconds"] = bot.time
    bot.memory.own[base["tag"]] = base
    visits = []

    class Hidden:
        def __getattribute__(self, name):
            raise AssertionError(f"hidden scout or enemy lookup: {name}")

    bot.units = bot.enemy_units = [Hidden()]

    async def move_camera(point):
        point = Point2(point)
        if point == bot.fairplay.camera_center:
            return False
        visits.append(point)
        bot.fairplay.camera_center = point
        bot._last_camera_change = float(bot.time)
        return True

    bot._move_camera = move_camera
    plan = order(scout=True)
    assert asyncio.run(bot._camera_schedule([], plan))
    bot.state.game_loop += 8
    bot._observe_scout_camera([Unit(U.PROBE, tag=1, position=(150, 150))])
    bot.state.game_loop = 1312  # More than seven seconds later.
    assert asyncio.run(bot._camera_schedule([], plan))
    bot.state.game_loop = 1504
    base["last_seen_seconds"] = bot.time
    assert not asyncio.run(bot._camera_schedule([], plan))
    bot.state.game_loop = 1616  # More than twenty seconds since scout visit.
    assert asyncio.run(bot._camera_schedule([], plan))
    assert visits == [Point2((150, 150)), Point2((50, 50)), Point2((150, 150))]


def test_dead_or_missing_scout_cannot_cause_permanent_blind_camera_visits(tmp_path):
    bot = world(tmp_path)
    bot._start_scout_camera_lease(7, [150, 150], [Unit(tag=7)])
    visits = []

    class Hidden:
        def __getattribute__(self, name):
            raise AssertionError(f"Hidden scout/death lookup: {name}")

    bot.units = bot.enemy_units = [Hidden()]

    async def move_camera(point):
        bot.fairplay.camera_center = Point2(point)
        bot._last_camera_change = float(bot.time)
        visits.append(Point2(point))
        return True

    bot._move_camera = move_camera
    for failed in range(1, 4):
        now = bot._scout_camera_lease["next_check_game_seconds"]
        bot.state.game_loop = math.ceil(now * 22.4)
        bot.fairplay.camera_center = Point2((50, 50))
        assert asyncio.run(bot._camera_schedule([], order(scout=True)))
        bot.state.game_loop += 8
        bot._observe_scout_camera([])
        assert bot._scout_camera_lease["failed_visits"] == failed
    assert bot._scout_camera_lease["status"] == "stopped_no_scout_observation"
    bot.state.game_loop += 2240
    bot.fairplay.camera_center = Point2((50, 50))
    assert not asyncio.run(bot._camera_schedule([], order(scout=True)))
    assert visits == [Point2((150, 150))] * 3


def test_scout_camera_stops_without_progress_then_rearms_only_for_observed_progress_or_dispatch(tmp_path):
    bot = world(tmp_path)
    bot._start_scout_camera_lease(7, [150, 150], [Unit(tag=7)])
    bot.state.game_loop += 2688  # 120 seconds without observed progress.
    bot._observe_scout_camera([])
    assert bot._scout_camera_lease["status"] == "stopped_no_scout_observation"
    bot._observe_scout_camera([Unit(tag=7)])  # Still at home is not progress.
    assert bot._scout_camera_lease["status"] == "stopped_no_scout_observation"
    bot.fairplay.camera_center = Point2((100, 100))
    bot._observe_scout_camera([Unit(tag=7, position=(100, 100))])
    assert bot._scout_camera_lease["status"] == "observed_scout"
    bot._scout_camera_lease["status"] = "stopped_no_scout_observation"
    bot._start_scout_camera_lease(8, [150, 150], [])
    assert bot._scout_camera_lease["source_tag"] == 8
    assert bot._scout_camera_lease["failed_visits"] == 0
    assert bot._scout_camera_lease["status"] == "awaiting_arrival"


@pytest.mark.parametrize("confirmation", ["engine_rejected", "accepted"])
def test_scout_camera_lease_requires_a_confirmed_dispatch(tmp_path, confirmation):
    bot = world(tmp_path)
    bot.fairplay.audit.append({"kind": "selection", "source_tags": [7], "command_confirmation": confirmation})
    bot._selected_actions[0] = {"name": "scout", "position": [150, 150], "revision": 1,
                               "scout_source_type": "PROBE"}
    bot._confirm_commands([Unit(tag=7)])
    assert (bot._scout_camera_lease is not None) is (confirmation == "accepted")


def army_record(tag=7, position=(50, 50), seconds=10, loop=224):
    return {"type": "STALKER", "tag": tag, "position": list(position), "is_ready": True,
            "is_structure": False, "can_attack": True, "last_seen_seconds": seconds, "last_seen_loop": loop}


def test_seen_attack_at_expansion_survives_camera_change_but_expires(tmp_path):
    bot = world(tmp_path)
    bot.memory.own[99] = known_base(position=(80, 50))
    bot._observe_defense([Unit(U.MARINE, position=(83, 50), can_attack=True)])
    assert bot._defense_alert == {"base_tag": 99, "position": [80, 50], "last_seen_seconds": 10}
    bot.state.game_loop = 448
    bot._observe_defense([])
    assert bot._defense_alert["last_seen_seconds"] == 10
    bot.state.game_loop = 920
    bot._observe_defense([])
    assert bot._defense_alert is None


@pytest.mark.parametrize("kind,position,attacks", [
    (U.SCV, (52, 50), True), (U.MARINE, (150, 150), True), (U.RAVEN, (52, 50), False),
])
def test_remote_scout_sighting_does_not_create_base_defense_alert(tmp_path, kind, position, attacks):
    bot = world(tmp_path)
    bot.memory.own[99] = known_base()
    bot._observe_defense([Unit(kind, position=position, can_attack=attacks)])
    assert bot._defense_alert is None


def test_defense_uses_remembered_army_camera_then_only_onscreen_spatial_selection(tmp_path):
    bot = world(tmp_path)
    bot.game_data.abilities[A.ATTACK_ATTACK.value] = NS(id=A.ATTACK_ATTACK)
    bot.memory.own[99] = known_base(position=(80, 50))
    bot.memory.own[7] = army_record()
    bot._observe_defense([Unit(U.MARINE, position=(83, 50), can_attack=True)])
    bot.fairplay.camera_center = Point2((80, 50))

    class Hidden:
        def __getattribute__(self, name):
            raise AssertionError(f"global army or enemy lookup: {name}")

    bot.units = bot.enemy_units = [Hidden()]
    assert asyncio.run(bot._defense_step([], order()))
    assert bot.fairplay.audit[-1]["kind"] == "camera"
    assert bot.fairplay.audit[-1]["destination"] == [50, 50]
    bot.state.game_loop += 8
    bot.fairplay.camera_center = Point2((50, 50))
    stalker = Unit(U.STALKER, tag=7, can_attack=True)
    queried = []

    async def available(units, **kwargs):
        queried.extend(units)
        return [[A.ATTACK_ATTACK]]

    bot.get_available_abilities = available
    assert asyncio.run(bot._defense_step([stalker], order()))
    assert queried == [stalker]
    assert bot.fairplay.audit[-1]["source_tags"] == [7]
    assert bot.fairplay._pending.target.distance_to(Point2((80, 50))) == pytest.approx(8)
    assert bot.fairplay._pending.minimap
    assert not bot._defense_dispatched
    index = len(bot.fairplay.audit) - 1
    bot.fairplay.audit[index].update(command_confirmation="accepted", command_loop=232)
    bot._confirm_commands([stalker])
    assert bot._defense_dispatched == {7}
    assert not asyncio.run(bot._defense_step([stalker], order()))
    assert all(not action.HasField("action_raw") for request in bot.client.requests for action in request.actions)


def test_defense_does_not_repeatedly_visit_an_empty_stale_army_location(tmp_path):
    bot = world(tmp_path)
    bot._defense_alert = {"base_tag": 99, "position": [50, 50], "last_seen_seconds": 10}
    bot.memory.own[7] = army_record(position=(80, 50))
    assert asyncio.run(bot._defense_step([], order()))
    bot.state.game_loop += 224
    assert not asyncio.run(bot._defense_step([], order()))
    assert len(bot.client.requests) == 1


def test_explicit_retreat_prevents_automatic_defense_dispatch(tmp_path):
    bot = world(tmp_path)
    bot._defense_alert = {"base_tag": 99, "position": [80, 50], "last_seen_seconds": 10}
    bot.memory.own[7] = army_record(position=(80, 50))
    assert not asyncio.run(bot._defense_step([], order(stance="retreat")))
    assert not bot.client.requests


def test_regular_defend_intent_keeps_threatened_expansion_destination(tmp_path):
    bot = world(tmp_path)
    bot.game_data.abilities[A.ATTACK_ATTACK.value] = NS(id=A.ATTACK_ATTACK)
    bot._defense_alert = {"base_tag": 99, "position": [80, 50], "last_seen_seconds": 10}
    bot.memory.own[99] = known_base(position=(80, 50))
    index = ACTION_NAMES.index("defend")
    bot._pluto_action_context = {index: NS(ability=A.ATTACK_ATTACK, target=Point2((50, 50)), minimap=True)}

    async def available(units, **kwargs):
        return [[A.ATTACK_ATTACK] for _ in units]

    bot.get_available_abilities = available
    army = [Unit(U.STALKER, tag=7, can_attack=True)]
    asyncio.run(bot._army_intents(army, {"defend"}))
    assert bot._pluto_action_context[index].target.distance_to(Point2((80, 50))) == pytest.approx(8)
    assert bot._army_plan["job"] == "defend_base"


@pytest.mark.parametrize("combat_issued", [False, True])
def test_combat_runs_on_current_screen_before_defense_and_expansion(tmp_path, combat_issued):
    bot = world(tmp_path)
    own = Unit(U.STALKER, tag=7, can_attack=True)
    enemy = Unit(U.MARINE, tag=9, is_mine=False, is_enemy=True, can_attack=False)
    bot.units = [own, Unit(U.STALKER, tag=8, position=(100, 100))]
    bot.enemy_units = [enemy, Unit(U.MARINE, tag=10, is_visible=False)]
    calls = []

    async def combat(_bot, current_own, current_enemies, plan, *, protected_tags=(), guardian_only=False):
        assert current_own == [own] and current_enemies == [enemy]
        if guardian_only:
            return False
        calls.append("combat")
        return combat_issued

    async def defense(_own, _plan):
        calls.append("defense")
        return True

    async def forbidden(*_args):
        pytest.fail("Accepted combat/defense must precede expansion")

    bot.combat.step = combat
    bot._defense_step, bot._expansion_step = defense, forbidden
    asyncio.run(bot._step(0))
    assert calls == (["combat"] if combat_issued else ["combat", "defense"])


@pytest.mark.parametrize("confirmation", ["accepted", "engine_rejected"])
def test_combat_confirmation_protects_commands_and_briefly_holds_camera(tmp_path, confirmation):
    bot = world(tmp_path)
    bot._defense_alert = {"base_tag": 99, "position": [50, 50], "last_seen_seconds": bot.time}
    bot.fairplay.audit.append({"kind": "selection", "source_tags": [7], "command_confirmation": confirmation})
    bot._selected_actions[0] = {"name": "combat_cooldown_kite", "position": [48, 50], "revision": 1}
    bot._confirm_commands([])
    accepted = confirmation == "accepted"
    assert (7 in bot._combat_protected_tags()) is accepted
    assert (7 in bot._defense_dispatched) is accepted
    if accepted:
        assert not asyncio.run(bot._move_camera(Point2((80, 50))))
        assert not bot.client.requests
        bot.state.game_loop += 48
    assert asyncio.run(bot._move_camera(Point2((80, 50))))


@pytest.mark.parametrize("reason", ["held", "withdrawing", "delivered_busy"])
def test_defense_uses_single_reinforcement_click_to_preserve_frontliner(tmp_path, reason):
    bot = world(tmp_path)
    bot.game_data.abilities[A.ATTACK_ATTACK.value] = NS(id=A.ATTACK_ATTACK)
    bot._defense_alert = {"base_tag": 99, "position": [80, 50], "last_seen_seconds": bot.time}
    bot.memory.own[99] = known_base(position=(80, 50))
    army = [Unit(U.STALKER, tag=tag, can_attack=True, position=(47 + tag / 3, 50)) for tag in (7, 8, 9)]
    if reason == "held":
        bot._combat_held_tags[7] = bot.time + 3
    elif reason == "withdrawing":
        bot.combat.withdrawing[7] = bot.time + 4
    else:
        bot._defense_dispatched.add(7)
    queried = []

    async def available(units, **_kwargs):
        queried.extend(units)
        return [[A.ATTACK_ATTACK] for _ in units]

    bot.get_available_abilities = available
    assert asyncio.run(bot._defense_step(army, order()))
    assert all(unit.tag != 7 for unit in queried)
    assert bot.fairplay.audit[-1]["source_tags"] == [8]
    selection = bot.client.requests[-1].actions[0].action_feature_layer.unit_selection_point
    assert selection.type == selection.Select


def test_idle_delivered_defender_can_be_called_again(tmp_path):
    bot = world(tmp_path)
    bot.game_data.abilities[A.ATTACK_ATTACK.value] = NS(id=A.ATTACK_ATTACK)
    bot._defense_alert = {"base_tag": 99, "position": [80, 50], "last_seen_seconds": bot.time}
    bot.memory.own[99] = known_base(position=(80, 50))
    bot._defense_dispatched.add(7)

    async def available(units, **_kwargs):
        return [[A.ATTACK_ATTACK] for _ in units]

    bot.get_available_abilities = available
    assert asyncio.run(bot._defense_step([Unit(U.STALKER, tag=7, can_attack=True, is_idle=True)], order()))


def guard_world(tmp_path, kind=U.STALKER):
    bot = world(tmp_path)
    bot.game_info.start_locations = [Point2((150, 50))]
    bot.memory.own[99] = known_base()
    bot.in_pathing_grid = lambda _point: True
    unit = Unit(kind, tag=7, position=(49, 50), can_attack=kind != U.OBSERVER, is_idle=True)
    base = Unit(U.NEXUS, tag=99, radius=2.5)

    async def available(units, **_kwargs):
        return [[A.ATTACK_ATTACK, A.MOVE_MOVE] for _ in units]

    bot.get_available_abilities = available
    return bot, [base, unit]


@pytest.mark.parametrize("kind,role,offset,ability", [
    (U.ZEALOT, "frontline", 10, A.ATTACK_ATTACK),
    (U.STALKER, "ranged", 8, A.ATTACK_ATTACK),
    (U.OBSERVER, "support", 6.5, A.MOVE_MOVE),
])
def test_idle_guard_jobs_use_role_approaches_and_normal_screen_selection(tmp_path, kind, role, offset, ability):
    bot, own = guard_world(tmp_path, kind)
    assert asyncio.run(bot._guard_army(own, order()))
    assert bot._army_plan["job"] == "guard_base" and bot._army_plan["role"] == role
    assert bot.fairplay._pending.target == Point2((50 + offset, 50))
    assert bot.fairplay._pending.ability == ability.value
    assert not bot.fairplay._pending.minimap
    assert bot.fairplay.audit[-1]["source_tags"] == [7]
    assert all(not action.HasField("action_raw") for request in bot.client.requests for action in request.actions)


def test_guard_terrain_queries_never_reach_fog_and_visible_obstacles_get_alternatives(tmp_path):
    bot, own = guard_world(tmp_path)
    own.append(Unit(U.PYLON, tag=98, position=(58, 50), is_structure=True, radius=1))
    path_queries = []
    bot.is_visible = lambda point: point.y <= 50

    def pathing(point):
        assert bot.fairplay.on_screen(point) and bot.is_visible(point)
        path_queries.append(point)
        return True

    bot.in_pathing_grid = pathing
    assert asyncio.run(bot._guard_army(own, order()))
    assert bot.fairplay._pending.target == Point2((58, 48))
    assert Point2((58, 50)) not in path_queries and Point2((58, 52)) not in path_queries


@pytest.mark.parametrize("reason", ["fog", "unpathable", "at_post", "busy", "protected", "scout"])
def test_guard_does_not_spam_or_steal_existing_jobs(tmp_path, reason):
    bot, own = guard_world(tmp_path)
    unit = own[-1]
    if reason == "fog":
        bot.is_visible = lambda _point: False
    elif reason == "unpathable":
        bot.in_pathing_grid = lambda _point: False
    elif reason == "at_post":
        unit.position = Point2((58, 50))
    elif reason == "busy":
        unit.is_idle = False
    elif reason == "protected":
        bot.combat.withdrawing[unit.tag] = bot.time + 4
    else:
        bot._nonworker_scout_tags.add(unit.tag)
    assert not asyncio.run(bot._guard_army(own, order()))
    assert not bot.client.requests


def test_remote_guard_moves_use_only_observed_base_and_public_geometry(tmp_path):
    bot, own = guard_world(tmp_path)
    bot.memory.own[99] = known_base(position=(80, 50))
    own = own[1:]  # Destination Nexus is remembered, not currently visible.

    def forbidden(_point):
        pytest.fail("Remote guard planning cannot query current visibility/pathing")

    bot.is_visible = bot.in_pathing_grid = forbidden
    assert asyncio.run(bot._guard_army(own, order()))
    assert bot.fairplay._pending.minimap
    assert bot.fairplay._pending.target == Point2((88, 50))


def test_guard_rotates_types_after_confirmed_commands_and_preserves_job_report(tmp_path):
    bot, own = guard_world(tmp_path, U.ZEALOT)
    own.append(Unit(U.STALKER, tag=8, can_attack=True, is_idle=True, position=(49, 50)))
    assert asyncio.run(bot._guard_army(own, order()))
    assert bot._army_plan["unit_type"] == "ZEALOT"
    assert bot._army_plan["status"] == "selection_pending"
    bot.fairplay.audit[-1]["command_confirmation"] = "accepted"
    bot.fairplay._pending = None
    bot._confirm_commands(own)
    assert bot._army_plan["status"] == "accepted"
    bot.state.game_loop += 96
    assert asyncio.run(bot._guard_army(own, order()))
    assert bot._army_plan["unit_type"] == "STALKER"
    bot._report(force=True)
    import json
    saved = json.loads((tmp_path / "report.json").read_text())
    assert saved["army_plan"]["description"] == "Guard the exposed base approach"


def test_productive_executor_action_keeps_priority_over_idle_guard(tmp_path, monkeypatch):
    bot = world(tmp_path)
    bot.executor = NS(choose_action=lambda *_args: "train_probe", record_action=lambda *_args: None)
    choices = []

    async def forbidden(*_args):
        pytest.fail("Idle guard must not replace productive macro")

    async def mask(_bot):
        index = ACTION_NAMES.index("train_probe")
        _bot._pluto_action_context = {index: NS(sources=(), target=None)}
        result = np.zeros(len(ACTION_NAMES), dtype=bool)
        result[index] = True
        return result

    async def execute(_bot, index):
        choices.append(ACTION_NAMES[index])
        return False

    bot._guard_army = forbidden
    monkeypatch.setattr("pluto_sc2.coach_bot.legal_action_mask", mask)
    monkeypatch.setattr("pluto_sc2.coach_bot.execute_action", execute)
    asyncio.run(bot._step(0))
    assert choices == ["train_probe"]


@pytest.mark.parametrize("name", ["attack_enemy_base", "defend", "retreat"])
def test_generic_army_intents_respect_withdrawal_and_explicit_retreat(tmp_path, name):
    bot = world(tmp_path)
    bot.game_data.abilities[A.ATTACK_ATTACK.value] = NS(id=A.ATTACK_ATTACK)
    bot.combat.withdrawing[7] = bot.time + 4
    index = ACTION_NAMES.index(name)
    bot._pluto_action_context = {index: NS(ability=A.ATTACK_ATTACK, target=Point2((80, 50)), minimap=True)}
    bot.memory.enemies = {}
    bot.memory.own[99] = known_base(position=(80, 50))

    async def available(units, **_kwargs):
        return [[A.ATTACK_ATTACK] for _ in units]

    bot.get_available_abilities = available
    army = [Unit(U.STALKER, tag=tag, can_attack=True, is_idle=True) for tag in (7, 8, 9)]
    asyncio.run(bot._army_intents(army, {name}))
    tags = [unit.tag for unit in bot._pluto_action_context[index].sources]
    assert tags == ([7, 8, 9] if name == "retreat" else [8])


def test_sustained_combat_gets_bounded_base_upkeep_and_can_resume_camera(tmp_path):
    bot = world(tmp_path)
    bot.memory.own[99] = known_base(position=(80, 50))
    bot._combat_view_started = 2
    bot._combat_camera_until = 100  # Repeated micro cannot extend the burst.
    assert asyncio.run(bot._combat_upkeep())
    assert bot.fairplay.audit[-1]["destination"] == [80, 50]
    assert bot._combat_view_started is None
    bot.fairplay.camera_center = Point2((80, 50))
    bot.state.game_loop += 56
    assert not asyncio.run(bot._move_camera(Point2((100, 100))))
    bot.state.game_loop += 16
    assert asyncio.run(bot._move_camera(Point2((100, 100))))


def test_combat_upkeep_leaves_macro_inputs_available(tmp_path, monkeypatch):
    bot = world(tmp_path)
    bot._combat_upkeep_until = bot.time + 3
    bot.executor = NS(choose_action=lambda *_args: "train_probe", record_action=lambda *_args: None)
    choices = []

    async def mask(_bot):
        index = ACTION_NAMES.index("train_probe")
        _bot._pluto_action_context = {index: NS(sources=(), target=None)}
        result = np.zeros(len(ACTION_NAMES), dtype=bool)
        result[index] = True
        return result

    async def execute(_bot, index):
        choices.append(ACTION_NAMES[index])
        return False

    async def forbidden(*_args):
        pytest.fail("The short upkeep interval must allow macro between combat views")

    bot.combat.step = forbidden
    monkeypatch.setattr("pluto_sc2.coach_bot.legal_action_mask", mask)
    monkeypatch.setattr("pluto_sc2.coach_bot.execute_action", execute)
    asyncio.run(bot._step(0))
    assert choices == ["train_probe"]


def set_opening(bot, steps):
    bot.opening = OpeningPlan("a" * 64, "PvT", "test", tuple(steps))
    bot.executor = CoachExecutor(opening=bot.opening)
    bot._refresh_opening([])


def test_constructor_shares_optional_opening_with_executor(tmp_path):
    plan = OpeningPlan("a" * 64, "PvT", "test", (OpeningStep("PYLON", 1, 30),))
    bot = CoachBot(tmp_path, "test-game", opening=plan)
    assert bot.opening is plan and bot.executor.opening is plan


def test_opening_delays_expansion_until_replay_step_then_uses_public_live_site(tmp_path):
    bot = world(tmp_path)
    bot.memory.own[99] = known_base()
    bot._public_sites = [Point2((50, 50)), Point2((80, 50))]
    set_opening(bot, (OpeningStep("PYLON", 1, 30), OpeningStep("NEXUS", 2, 100, 1)))
    worker = raw_worker(bot)
    assert not asyncio.run(bot._expansion_step([worker], order(base_target=3)))
    assert not bot.client.requests and bot._expansion is None
    bot.memory.own[98] = {**known_base(tag=98), "type": "PYLON"}
    bot.state.game_loop = 2240
    bot._refresh_opening([])
    assert bot._opening_decision.allow_expansion
    assert asyncio.run(bot._expansion_step([worker], order(base_target=1)))
    assert bot._expansion["position"] == [80, 50]
    assert bot._selected_actions[0]["opening"]["due_at"] == 100


def test_opening_places_second_gas_at_observed_main_and_never_extra_natural_gas(tmp_path):
    bot = world(tmp_path)
    bot.memory.own[99] = known_base()
    bot.memory.own[100] = known_base(position=(80, 50), tag=100)
    bot.memory.own[7] = {"type": "ASSIMILATOR", "position": [52, 57], "is_ready": True,
                         "assigned_harvesters": 3, "last_seen_seconds": 10}
    bot._public_geysers = [Point2((52, 57)), Point2((48, 43)), Point2((82, 57))]
    bot.fairplay.camera_center = Point2((80, 50))
    set_opening(bot, (OpeningStep("ASSIMILATOR", 1, 5, 0), OpeningStep("ASSIMILATOR", 2, 8, 0)))
    target = bot._gas_camera_target(order(gas_workers_per_base=6))
    assert target["base_tag"] == 99 and target["geyser"] == [48, 43]
    assert bot._opening_gas_allowed(Point2((48, 43)))
    assert not bot._opening_gas_allowed(Point2((82, 57)))
    del bot.memory.own[99]  # Losing the main cannot relabel the natural as base 0.
    assert bot._opening_gas_quota(bot.memory.own[100]) == 0
    assert not bot._opening_gas_allowed(Point2((82, 57)))


def test_opening_zero_gas_quota_and_visible_override_are_applied_before_actions(tmp_path):
    bot = world(tmp_path)
    bot.memory.own[99] = known_base()
    bot._public_geysers = [Point2((52, 57))]
    set_opening(bot, (OpeningStep("PYLON", 1, 30), OpeningStep("ASSIMILATOR", 1, 70, 0)))
    assert bot._gas_camera_target(order(gas_workers_per_base=6)) is None
    assert not bot._opening_gas_allowed(Point2((52, 57)))
    bot._refresh_opening([Unit(U.MARINE, tag=10, can_attack=True)])
    assert bot._opening_decision.status == "suspended"
    assert bot._opening_gas_allowed(Point2((52, 57)))


def test_opening_timing_status_and_delays_survive_report_and_selection_audit(tmp_path):
    bot = world(tmp_path)
    set_opening(bot, (OpeningStep("PYLON", 1, 5),))
    assert bot._opening_decision.delay_seconds == 5
    bot._report(force=True)
    import json
    report = json.loads((tmp_path / "report.json").read_text())
    assert report["opening"]["decision"]["due_at"] == 5
    assert report["opening"]["decision"]["delay_seconds"] == 5
    event = {"kind": "selection", "source_tags": [7], "command_confirmation": "accepted"}
    bot.fairplay.audit.append(event)
    bot._record_selection("build_pylon", Point2((53, 50)))
    bot._confirm_commands([])
    execution = json.loads((tmp_path / "execution.jsonl").read_text().strip())
    assert execution["opening_at_selection"]["due_at"] == 5
    assert bot.opening.summary()["history"][0]["delay_seconds"] == 5


def test_public_cost_report_uses_engine_prices_and_tags_the_current_opening_action(tmp_path):
    bot = world(tmp_path)
    set_opening(bot, (OpeningStep("NEXUS", 2, 100, 1),))
    queried = []

    def public_cost(kind):
        queried.append(kind)
        if kind == U.NEXUS:
            return NS(minerals=400, vespene=0)
        if kind == U.PROBE:
            return NS(minerals=50, vespene=0)
        if kind == U.STALKER:
            return NS(minerals=125, vespene=50)
        raise KeyError(kind)

    class Hidden:
        def __getattribute__(self, name):
            raise AssertionError(f"Cost reporting cannot inspect hidden units: {name}")

    bot.units = bot.enemy_units = [Hidden()]
    bot.calculate_cost = public_cost
    fields = bot._production_cost_fields()
    assert fields["opening_next_cost"] == {"action": "build_nexus", "minerals": 400, "vespene": 0}
    assert fields["action_costs"] == {"train_probe": {"minerals": 50, "vespene": 0},
                                      "train_stalker": {"minerals": 125, "vespene": 50},
                                      "build_nexus": {"minerals": 400, "vespene": 0}}
    assert all(isinstance(kind, (U, Upgrade)) for kind in queried)
    bot._report(force=True)
    import json
    saved = json.loads((tmp_path / "report.json").read_text())
    assert saved["opening_next_cost"] == fields["opening_next_cost"]
    assert saved["action_costs"] == fields["action_costs"]


@pytest.mark.parametrize("minerals,gas", [(0, 0), (-1, 0), (float("nan"), 0), (50, float("inf"))])
def test_invalid_public_prices_are_omitted_instead_of_inventing_reservations(tmp_path, minerals, gas):
    bot = world(tmp_path)
    set_opening(bot, (OpeningStep("NEXUS", 2, 100, 1),))
    bot.calculate_cost = lambda _kind: NS(minerals=minerals, vespene=gas)
    assert bot._production_cost_fields() == {"action_costs": {}, "upgrades": [], "opening_bases": []}


def test_executor_receives_current_public_costs_on_the_decision_report(tmp_path, monkeypatch):
    bot = world(tmp_path)
    bot.calculate_cost = lambda _kind: NS(minerals=123, vespene=45)
    received = []
    bot.executor = NS(choose_action=lambda _order, report, *_args: received.append(report) or "no_op",
                      record_action=lambda *_args: None)

    async def mask(_bot):
        _bot._pluto_action_context = {0: NS(sources=())}
        result = np.zeros(len(ACTION_NAMES), dtype=bool)
        result[0] = True
        return result

    monkeypatch.setattr("pluto_sc2.coach_bot.legal_action_mask", mask)
    asyncio.run(bot._step(0))
    assert received[0]["action_costs"]["train_probe"] == {"minerals": 123, "vespene": 45}


def test_public_supply_and_queue_durations_use_engine_data_frames(tmp_path):
    bot = world(tmp_path)
    bot.game_data.units[U.STALKER.value] = NS(_proto=NS(food_required=2))

    def public_cost(kind):
        if kind == U.STALKER:
            return NS(minerals=125, vespene=50, time=716.8)
        if kind == Upgrade.WARPGATERESEARCH:
            return NS(minerals=50, vespene=50, time=2240)
        raise KeyError(kind)

    bot.calculate_cost = public_cost
    costs = bot._production_cost_fields()["action_costs"]
    assert costs["train_stalker"] == {"minerals": 125, "vespene": 50, "supply": 2, "time_seconds": 32}
    assert costs["research_warpgateresearch"] == {"minerals": 50, "vespene": 50, "time_seconds": 100}


def gas_world(tmp_path):
    bot = world(tmp_path)
    bot.supply_workers = 32
    bot.memory.own[99] = known_base(position=(146.5, 124.5))
    bot.memory.own[98] = {**known_base(tag=98), "type": "GATEWAY"}
    bot._public_geysers = [Point2((148.5, 117.5)), Point2((148.5, 131.5))]
    bot.fairplay.camera_center = Point2((145.3125, 123.4375))
    return bot


def test_nexus_centered_gas_blind_spot_gets_usable_camera_after_minimap_rounding(tmp_path):
    bot = gas_world(tmp_path)
    assert all(not _visible_footprint(bot, point, 3) for point in bot._public_geysers)
    target = bot._gas_camera_target(order())
    assert target["base_tag"] == 99
    pixel = bot.fairplay.minimap_point(bot, Point2(target["position"]))
    scale = 64 / max(bot.game_info.map_size)
    bot.fairplay.camera_center = Point2(((pixel.x + .5) / scale,
                                       bot.game_info.map_size.y - (pixel.y + .5) / scale))
    assert _visible_footprint(bot, Point2(target["geyser"]), 3)
    assert bot.fairplay.on_screen(Point2(bot.memory.own[99]["position"]))


def test_gas_camera_uses_only_public_geometry_and_remembered_own_base(tmp_path):
    bot = gas_world(tmp_path)

    class Hidden:
        def __getattribute__(self, name):
            raise AssertionError(f"live off-screen resource or unit lookup: {name}")

    bot.units = bot.enemy_units = bot.vespene_geyser = [Hidden()]

    def scoped_visibility(point):
        assert bot.fairplay.on_screen(point)
        return False

    async def forbidden(*_args, **_kwargs):
        pytest.fail("A gas camera plan cannot query placement or unit abilities")

    bot.is_visible = scoped_visibility
    bot.can_place_single = bot.get_available_abilities = forbidden
    assert asyncio.run(bot._camera_schedule([], order()))
    assert bot.action_counts["camera_gas"] == 1
    assert bot._gas_camera_request["base_tag"] == 99
    assert bot.fairplay.audit[-1]["kind"] == "camera"


def test_gas_visit_returns_to_base_even_when_nexus_stayed_visible_and_fresh(tmp_path):
    bot = gas_world(tmp_path)
    assert asyncio.run(bot._camera_schedule([], order()))
    requested = Point2(bot._gas_camera_request["position"])
    base = bot.memory.own[99]
    bot.fairplay.camera_center = requested
    assert bot.fairplay.on_screen(Point2(base["position"]))
    assert requested.distance_to(Point2(base["position"])) < 12
    bot.state.game_loop += 104  # Before the five-second dwell completes.
    base["last_seen_seconds"] = float(bot.time)
    assert not asyncio.run(bot._camera_schedule([], None))
    bot.state.game_loop += 8
    base["last_seen_seconds"] = float(bot.time)
    assert asyncio.run(bot._camera_schedule([], None))
    assert bot.fairplay.audit[-1]["destination"] == base["position"]
    assert bot.action_counts["camera_gas_return"] == 1
    assert bot._gas_camera_return is None


def test_gas_return_already_reached_does_not_spend_another_input(tmp_path):
    bot = world(tmp_path)
    bot._gas_camera_return = {"position": [50, 50], "due_game_seconds": 5}
    assert not asyncio.run(bot._camera_schedule([], None))
    assert bot._gas_camera_return is None
    assert not bot.client.requests


@pytest.mark.parametrize("state", ["no_order", "no_gas", "few_workers", "no_gateway", "unfinished_base", "saturated"])
def test_gas_camera_requires_an_economically_due_unsatisfied_order(tmp_path, state):
    bot, plan = gas_world(tmp_path), order()
    if state == "no_order":
        plan = None
    elif state == "no_gas":
        plan = order(gas_workers_per_base=0)
    elif state == "few_workers":
        bot.supply_workers = 11
    elif state == "no_gateway":
        del bot.memory.own[98]
    elif state == "unfinished_base":
        bot.memory.own[99]["is_ready"] = False
    else:
        bot.memory.own[7] = {"type": "ASSIMILATOR", "position": [148.5, 117.5], "is_ready": True,
                             "assigned_harvesters": 3}
    assert bot._gas_camera_target(plan) is None


@pytest.mark.parametrize("ready,assigned", [(False, 0), (True, 1)])
def test_gas_camera_revisits_unfinished_or_unsaturated_observed_assimilator(tmp_path, ready, assigned):
    bot = gas_world(tmp_path)
    bot.memory.own[7] = {"type": "ASSIMILATOR", "position": [148.5, 131.5], "is_ready": ready,
                         "assigned_harvesters": assigned}
    target = bot._gas_camera_target(order())
    assert target["geyser"] == [148.5, 131.5]


@pytest.mark.parametrize("age,inspect", [(29, False), (30, True), (400, True)])
def test_gas_camera_refreshes_stale_full_saturation_without_global_reads(tmp_path, age, inspect):
    bot = gas_world(tmp_path)
    bot.state.game_loop = 11200
    bot.memory.own[7] = {"type": "ASSIMILATOR", "position": [148.5, 131.5], "is_ready": True,
                         "assigned_harvesters": 3, "last_seen_seconds": bot.time - age}
    target = bot._gas_camera_target(order())
    assert (target is not None) is inspect
    if inspect:
        assert target["geyser"] == [148.5, 131.5]


def test_pending_assimilator_reservation_requests_its_camera_not_an_extra_gas(tmp_path):
    bot = gas_world(tmp_path)
    bot._construction = [{"type": "ASSIMILATOR", "position": [148.5, 131.5], "source_tag": 5,
                          "issued_game_seconds": 1}]
    target = bot._gas_camera_target(order())
    assert target["geyser"] == [148.5, 131.5]


def test_unresolved_construction_gets_camera_even_when_its_base_is_no_longer_known(tmp_path):
    bot = world(tmp_path)
    bot.memory.own[99] = known_base()
    task = {"type": "NEXUS", "position": [80.5, 50.5], "source_tag": 7, "issued_game_seconds": 0}
    bot._construction = [task]
    assert asyncio.run(bot._camera_schedule([], None))
    assert bot.fairplay.audit[-1]["destination"] == task["position"]
    assert bot.action_counts["camera_construction"] == 1
    assert bot._construction_camera_request["source_tag"] == 7
    bot._confirm_commands([])
    assert bot._construction == [task]  # An empty visit cannot infer builder death.


def test_pending_construction_visits_are_paced_and_rotate_sites(tmp_path):
    bot = world(tmp_path)
    bot._construction = [
        {"type": "PYLON", "position": [80, 50], "source_tag": 7, "issued_game_seconds": 0},
        {"type": "PYLON", "position": [110, 50], "source_tag": 8, "issued_game_seconds": 1},
    ]
    assert asyncio.run(bot._camera_schedule([], None))
    assert bot.fairplay.audit[-1]["destination"] == [80, 50]
    bot.state.game_loop += 224
    assert not asyncio.run(bot._camera_schedule([], None))
    bot.state.game_loop += 224
    assert asyncio.run(bot._camera_schedule([], None))
    assert bot.fairplay.audit[-1]["destination"] == [110, 50]
    assert len(bot._construction) == 2


def raw_worker(bot, ability=None, target=90, tag=7):
    orders = [] if ability is None else [raw.UnitOrder(ability_id=ability, target_unit_tag=target)]
    return SC2Unit(raw.Unit(tag=tag, unit_type=U.PROBE.value, alliance=1, display_type=1,
                           is_on_screen=True, pos=common.Point(x=50, y=50), orders=orders), bot, base_build=99999)


def transfer_world(tmp_path):
    bot = world(tmp_path)
    bot.memory.own[99] = known_base(tag=99)
    bot.memory.own[100] = known_base(position=(80, 50), tag=100)
    bot.mineral_field = [Unit(U.MINERALFIELD, tag=90, position=(51, 50))]
    base = Unit(U.NEXUS, tag=99, assigned_harvesters=18, ideal_harvesters=16)
    gas = Unit(U.ASSIMILATOR, tag=91)
    return bot, [base, gas]


@pytest.mark.parametrize("ability,target,transferred", [
    (4135, 90, False), (A.MOVE_MOVE.value, 90, False),
    (A.HARVEST_GATHER_PROBE.value, 91, False),
    (A.HARVEST_GATHER_PROBE.value, 90, True), (None, 90, True),
])
def test_transfer_reads_raw_orders_and_preserves_busy_and_gas_workers(tmp_path, ability, target, transferred):
    bot, own = transfer_world(tmp_path)
    worker = raw_worker(bot, ability, target)
    if ability == 4135:
        with pytest.raises(KeyError, match="4135"):
            _ = worker.is_collecting
        assert not worker.is_idle  # This Burnysc2 property reads raw orders safely.
    assert asyncio.run(bot._transfer_worker([*own, worker])) is transferred
    assert bool(bot.client.requests) is transferred
    if transferred:
        assert bot.fairplay.audit[-1]["source_tags"] == [worker.tag]


@pytest.mark.parametrize("reservation", ["scout", "construction", "expansion"])
def test_mineral_transfer_preserves_reserved_worker_roles(tmp_path, reservation):
    bot, own = transfer_world(tmp_path)
    worker = raw_worker(bot, A.HARVEST_GATHER_PROBE.value)
    if reservation == "scout":
        bot._worker_scout_lease.designated_worker_tag = worker.tag
    elif reservation == "construction":
        bot._construction = [{"source_tag": worker.tag}]
    else:
        bot._expansion = {"source_tag": worker.tag}
    assert not asyncio.run(bot._transfer_worker([*own, worker]))
    assert not bot.client.requests


def test_unknown_raw_builder_order_is_not_evidence_of_abandoned_construction(tmp_path):
    bot = world(tmp_path)
    worker = raw_worker(bot, 4135)
    task = {"type": "PYLON", "position": [53, 50], "source_tag": worker.tag, "issued_game_seconds": 0}
    bot._construction = [task]
    bot._confirm_commands([worker])
    assert bot._construction == [task]


@pytest.mark.parametrize("confirmation", [None, "engine_rejected", "accepted"])
def test_transfer_lease_requires_confirmed_move(tmp_path, confirmation):
    bot = world(tmp_path)
    worker = raw_worker(bot)
    assert asyncio.run(bot._move_worker(worker, Point2((80, 50)), "worker_transfer"))
    if confirmation is not None:
        bot.fairplay.audit[-1]["command_confirmation"] = confirmation
    bot._confirm_commands([worker])
    assert bool(bot._worker_transfers) is (confirmation == "accepted")
    if confirmation == "accepted":
        assert bot._worker_transfers[7]["position"] == [80, 50]


def arrival_world(tmp_path, ability=A.MOVE_MOVE.value, target=99):
    bot = world(tmp_path)
    bot._worker_transfers[7] = {"source_tag": 7, "position": [50, 50], "issued_game_seconds": 0}
    bot._last_transfer = bot.time  # Arrival is not blocked by new-transfer cadence.
    worker = raw_worker(bot, ability, target)
    base = Unit(U.NEXUS, tag=99, assigned_harvesters=7, ideal_harvesters=16)
    bot.mineral_field = [Unit(U.MINERALFIELD, tag=90, position=(52, 50), mineral_contents=1500)]
    queried = []

    async def available(units, **_kwargs):
        queried.extend(units)
        return [[A.HARVEST_GATHER_PROBE] for _ in units]

    bot.get_available_abilities = available
    return bot, worker, base, queried


@pytest.mark.parametrize("destination", ["nexus", "point", "idle"])
def test_arrived_transfer_receives_screen_gather_and_waits_for_confirmation(tmp_path, destination):
    bot, worker, base, queried = arrival_world(tmp_path, None if destination == "idle" else A.MOVE_MOVE.value)
    if destination == "point":
        worker._proto.orders[0].ClearField("target_unit_tag")
        worker._proto.orders[0].target_world_space_pos.CopyFrom(common.Point(x=51.5, y=50.5))
    assert asyncio.run(bot._transfer_worker([base, worker]))
    assert queried == [worker]
    assert bot._worker_transfers  # Selection does not prove Gather succeeded.
    assert bot.fairplay._pending.ability == A.HARVEST_GATHER_PROBE.value
    assert bot.fairplay._pending.target_tag == 90 and not bot.fairplay._pending.minimap
    assert bot.fairplay.audit[-1]["source_tags"] == [7]
    assert all(not action.HasField("action_raw") for request in bot.client.requests for action in request.actions)
    bot.fairplay.audit[-1]["command_confirmation"] = "accepted"
    bot._confirm_commands([base, worker])
    assert not bot._worker_transfers


@pytest.mark.parametrize("reason", ["unknown", "unrelated_move", "queued_order", "point_elsewhere",
                                   "scout", "builder", "expander", "worker_offscreen",
                                   "no_base", "mineral_offscreen", "empty_mineral", "mineral_snapshot",
                                   "mineral_hidden", "cooldown"])
def test_arrival_handoff_preserves_other_jobs_and_current_screen_restrictions(tmp_path, reason):
    bot, worker, base, queried = arrival_world(tmp_path)
    own = [base, worker]
    if reason == "unknown":
        worker._proto.orders[0].ability_id = 4135
    elif reason == "unrelated_move":
        worker._proto.orders[0].target_unit_tag = 999
    elif reason == "queued_order":
        worker._proto.orders.add(ability_id=4135)
    elif reason == "point_elsewhere":
        worker._proto.orders[0].ClearField("target_unit_tag")
        worker._proto.orders[0].target_world_space_pos.CopyFrom(common.Point(x=56, y=50))
    elif reason == "scout":
        bot._worker_scout_lease.designated_worker_tag = worker.tag
    elif reason == "builder":
        bot._construction = [{"source_tag": worker.tag}]
    elif reason == "expander":
        bot._expansion = {"source_tag": worker.tag}
    elif reason == "worker_offscreen":
        worker._proto.pos.x = 100
    elif reason == "no_base":
        own = [worker]
    elif reason == "mineral_offscreen":
        bot.mineral_field[0].position = Point2((100, 100))
    elif reason == "empty_mineral":
        bot.mineral_field[0].mineral_contents = 0
    elif reason == "mineral_snapshot":
        bot.mineral_field[0].is_snapshot = True
    elif reason == "mineral_hidden":
        bot.mineral_field[0].is_visible = False
    else:
        bot.fairplay._remember_selection_failure(worker.tag, bot.time)
    assert not asyncio.run(bot._transfer_worker(own))
    assert not queried and not bot.client.requests
    assert bot._worker_transfers


def test_failed_handoff_preserves_transfer_and_observed_mining_resolves_it(tmp_path):
    bot, worker, base, _queried = arrival_world(tmp_path)
    assert asyncio.run(bot._transfer_worker([base, worker]))
    bot.fairplay.audit[-1]["command_confirmation"] = "engine_rejected"
    bot._confirm_commands([base, worker])
    assert bot._worker_transfers
    worker._proto.orders[0].ability_id = A.HARVEST_GATHER_PROBE.value
    worker._proto.orders[0].target_unit_tag = 90
    assert not asyncio.run(bot._finish_worker_transfers([base, worker]))
    assert not bot._worker_transfers


def test_transfer_capacity_includes_workers_already_sent_to_remembered_base(tmp_path):
    bot, own = transfer_world(tmp_path)
    bot.mineral_field[0].mineral_contents = 1500
    bot.memory.own[100]["assigned_harvesters"] = 15
    bot._worker_transfers[8] = {"source_tag": 8, "position": [80, 50], "issued_game_seconds": 0}
    worker = raw_worker(bot, A.HARVEST_GATHER_PROBE.value)
    assert not asyncio.run(bot._transfer_worker([*own, worker]))
    assert not bot.client.requests
    assert 8 in bot._worker_transfers  # Unseen arrival/death cannot be inferred.


def test_arrival_requires_current_gather_ability(tmp_path):
    bot, worker, base, _queried = arrival_world(tmp_path)

    async def unavailable(units, **_kwargs):
        assert units == [worker]
        return [[]]

    bot.get_available_abilities = unavailable
    assert not asyncio.run(bot._transfer_worker([base, worker]))
    assert bot._worker_transfers and not bot.client.requests


@pytest.mark.parametrize("confirmation", ["accepted", "engine_rejected"])
def test_later_observer_scouts_through_spatial_gate_after_probe_trip(tmp_path, monkeypatch, confirmation):
    bot = world(tmp_path)
    bot.state.game_loop = 4480
    bot.supply_workers = 22
    bot._last_scout_dispatch = 20
    bot._worker_scout_lease = WorkerScoutLease()
    bot._worker_scout_lease.designated_worker_tag = 1
    observer = Unit(U.OBSERVER, tag=7, is_idle=True)
    bot.units = [observer]
    queried = []

    async def available(units, **kwargs):
        queried.extend(units)
        return [[A.MOVE_MOVE] for _ in units]

    async def no_action(*_args):
        return False

    async def mask(_bot):
        _bot._pluto_action_context = {0: NS(sources=())}
        result = np.zeros(len(ACTION_NAMES), dtype=bool)
        result[0] = True
        return result

    bot.get_available_abilities = available
    bot._expansion_step = bot._transfer_worker = bot._camera_schedule = bot._army_intents = no_action
    monkeypatch.setattr("pluto_sc2.coach_bot.legal_action_mask", mask)
    write_strategy(tmp_path / "strategy.json", order(scout=True))
    asyncio.run(bot._step(0))
    assert queried == [observer]
    event = bot.fairplay.audit[-1]
    assert event["kind"] == "selection" and event["source_tags"] == [7]
    assert bot.fairplay._pending.minimap
    assert bot.fairplay._pending.target == Point2((150, 150))
    assert not bot._nonworker_scout_tags
    event.update(command_confirmation=confirmation, command_loop=4488)
    bot._confirm_commands([observer])
    assert bot._nonworker_scout_tags == ({7} if confirmation == "accepted" else set())
    assert bot._worker_scout_lease.designated_worker_tag == 1
    assert all(not action.HasField("action_raw") for request in bot.client.requests for action in request.actions)


@pytest.mark.parametrize("reason", ["no_order", "disabled", "retreat", "defense", "busy", "loaded", "offscreen", "probe"])
def test_nonworker_scout_does_not_steal_busy_or_reserved_combat_roles(tmp_path, reason):
    bot, plan = world(tmp_path), order(scout=True)
    scout = Unit(U.OBSERVER, tag=7, is_idle=True)
    if reason == "no_order":
        plan = None
    elif reason == "disabled":
        plan = order(scout=False)
    elif reason == "retreat":
        plan = order(scout=True, stance="retreat")
    elif reason == "defense":
        bot._defense_alert = {"base_tag": 99}
    elif reason == "busy":
        scout.is_idle = False
    elif reason == "loaded":
        scout = Unit(U.WARPPRISM, tag=7, is_idle=True, cargo_used=1)
    elif reason == "offscreen":
        scout.position = Point2((100, 100))
    else:
        scout = Unit(U.PROBE, tag=8, is_idle=True)

    async def forbidden(*_args, **_kwargs):
        pytest.fail("Ineligible scout cannot trigger an ability query")

    bot.get_available_abilities = forbidden
    assert not asyncio.run(bot._nonworker_scout_intent([scout], plan))
    assert not bot.client.requests


def test_nonworker_scout_requires_move_ability_and_paces_new_units(tmp_path):
    bot = world(tmp_path)
    bot._pluto_action_context = {}
    bot._nonworker_scout_tags = {7}
    bot._last_nonworker_scout_dispatch = 0
    scouts = [Unit(U.OBSERVER, tag=7, is_idle=True), Unit(U.OBSERVER, tag=8, is_idle=True)]
    queried = []

    async def available(units, **kwargs):
        queried.extend(units)
        return [[A.MOVE_MOVE] for _ in units]

    bot.get_available_abilities = available
    assert not asyncio.run(bot._nonworker_scout_intent(scouts, order(scout=True)))
    assert not queried
    bot.state.game_loop = 672
    assert asyncio.run(bot._nonworker_scout_intent(scouts, order(scout=True)))
    assert queried == [scouts[1]]
    assert bot._pluto_action_context[ACTION_NAMES.index("scout")].sources == (scouts[1],)

    async def unavailable(units, **kwargs):
        return [[] for _ in units]

    bot.get_available_abilities = unavailable
    assert not asyncio.run(bot._nonworker_scout_intent(scouts, order(scout=True)))


def test_nonworker_scout_does_not_replace_executor_production(tmp_path, monkeypatch):
    bot = world(tmp_path)
    bot._last_scout_dispatch = 20
    bot.state.game_loop = 4480
    bot.units = [Unit(U.OBSERVER, tag=7, is_idle=True)]
    bot.executor = NS(choose_action=lambda *_: "train_probe", record_action=lambda *_: None)
    choices = []

    async def no_action(*_args):
        return False

    async def mask(_bot):
        index = ACTION_NAMES.index("train_probe")
        _bot._pluto_action_context = {index: NS(sources=(), target=None)}
        result = np.zeros(len(ACTION_NAMES), dtype=bool)
        result[index] = True
        return result

    async def execute(_bot, index):
        choices.append(ACTION_NAMES[index])
        return False

    async def forbidden(*_args, **_kwargs):
        pytest.fail("Production must not be replaced by a scout")

    bot._expansion_step = bot._transfer_worker = bot._camera_schedule = bot._army_intents = no_action
    bot._nonworker_scout_intent = forbidden
    monkeypatch.setattr("pluto_sc2.coach_bot.legal_action_mask", mask)
    monkeypatch.setattr("pluto_sc2.coach_bot.execute_action", execute)
    write_strategy(tmp_path / "strategy.json", order(scout=True))
    asyncio.run(bot._step(0))
    assert choices == ["train_probe"]


def test_pressure_army_attention_preempts_two_stale_bases_then_returns_to_upkeep(tmp_path):
    bot = world(tmp_path)
    bot.memory.own[99] = {**known_base(tag=99), "last_seen_seconds": 0}
    bot.memory.own[100] = {**known_base(position=(80, 50), tag=100), "last_seen_seconds": 0}
    bot.memory.own[7] = army_record(position=(100, 100), seconds=1, loop=16)
    plan = order(stance="pressure")
    assert asyncio.run(bot._camera_schedule([], plan))
    assert bot.fairplay.audit[-1]["destination"] == [100, 100]
    assert bot.action_counts["camera_army_attention"] == 1
    bot.fairplay.camera_center = Point2((100, 100))
    bot.state.game_loop += 104
    assert not asyncio.run(bot._camera_schedule([], plan))
    bot.state.game_loop += 8
    assert asyncio.run(bot._camera_schedule([], plan))
    assert bot.fairplay.audit[-1]["destination"] == [50, 50]
    assert bot.action_counts["camera_army_return"] == 1


def test_army_attention_uses_only_remembered_positions_and_recorded_destination(tmp_path):
    bot = world(tmp_path)
    bot.memory.own[99] = known_base()
    bot.memory.own[7] = army_record(position=(100, 100), seconds=1, loop=16)
    bot._army_destination = [150, 150]

    class Hidden:
        def __getattribute__(self, name):
            raise AssertionError(f"global army lookup: {name}")

    bot.units = bot.enemy_units = [Hidden()]
    plan = order(stance="attack")
    assert asyncio.run(bot._camera_schedule([], plan))
    bot.state.game_loop += 112
    bot.fairplay.camera_center = Point2((100, 100))
    assert asyncio.run(bot._camera_schedule([], plan))
    bot.state.game_loop += 224
    bot.fairplay.camera_center = Point2((50, 50))
    assert asyncio.run(bot._camera_schedule([], plan))
    target = Point2(bot.fairplay.audit[-1]["destination"])
    assert target.distance_to(Point2((100, 100))) == pytest.approx(8)
    assert target.distance_to(Point2((150, 150))) < Point2((100, 100)).distance_to(Point2((150, 150)))
    assert bot.memory.own[7]["last_seen_loop"] == 16


def test_already_framed_army_gets_command_time_without_extra_camera_input(tmp_path):
    bot = world(tmp_path)
    bot.memory.own[99] = {**known_base(tag=99), "last_seen_seconds": 0}
    bot.memory.own[100] = {**known_base(position=(80, 50), tag=100), "last_seen_seconds": 0}
    bot.memory.own[7] = army_record(position=(50, 50), seconds=1, loop=16)
    plan = order(stance="pressure")
    assert not asyncio.run(bot._camera_schedule([], plan))
    assert bot._army_camera_request["camera_input"] is False
    bot.state.game_loop += 8
    assert not asyncio.run(bot._camera_schedule([], plan))
    assert not bot.client.requests


def test_coach_step_filters_camera_and_does_not_call_learned_policy(tmp_path, monkeypatch):
    bot = world(tmp_path)
    visible, offscreen, hidden_enemy = Unit(), Unit(tag=2, position=(100, 100)), Unit(tag=3, is_visible=False)
    bot.units = [visible, offscreen]
    bot.enemy_units = [hidden_enemy]
    decisions = []
    bot.executor = NS(choose_action=lambda plan, report, legal, now: decisions.append(plan) or "no_op",
                      record_action=lambda *_: None)

    async def no_action(*_):
        return False

    async def mask(_bot):
        _bot._pluto_action_context = {0: NS(sources=())}
        result = np.zeros(len(ACTION_NAMES), dtype=bool)
        result[0] = True
        return result

    async def forbidden(*_):
        pytest.fail("learned policy step must not run in coach experiment")

    monkeypatch.setattr("pluto_sc2.coach_bot.NeuralBot._step", forbidden)
    monkeypatch.setattr("pluto_sc2.coach_bot.legal_action_mask", mask)
    bot._expansion_step = bot._transfer_worker = bot._camera_schedule = no_action
    write_strategy(tmp_path / "strategy.json", order(game_id="wrong-game"))
    asyncio.run(bot._step(0))
    assert bot.memory.observed == [([visible], [])]
    assert decisions == [None]
    assert bot.mailbox.status["last_status"] == "rejected"
    assert not bot.client.requests
    assert (tmp_path / "report.json").is_file()


def test_stop_marker_uses_concession_and_final_report_needs_no_policy(tmp_path):
    bot = world(tmp_path)
    (tmp_path / "STOP").write_text("stop")
    forfeits = []

    async def forfeit(evidence):
        forfeits.append(evidence)
        bot.forfeit_reason = evidence

    bot._forfeit = forfeit
    asyncio.run(bot._step(0))
    assert forfeits == [{"reason": "coach_session_stop"}]
    asyncio.run(bot.on_end(Result.Defeat))
    assert bot._episode_finished
    assert bot.policy is None and not bot.transitions


def cohort_world(tmp_path):
    bot, own = guard_world(tmp_path)
    own = own[:1]
    bot.supply_army = 12
    for kind, supply in ((U.STALKER, 2), (U.IMMORTAL, 4), (U.WARPPRISM, 2), (U.PHOENIX, 2)):
        bot.game_data.units[kind.value] = NS(_proto=NS(food_required=supply))
    bot.game_data.abilities.update({A.ATTACK_ATTACK.value: NS(id=A.ATTACK_ATTACK),
                                    A.MOVE_MOVE.value: NS(id=A.MOVE_MOVE)})
    return bot, own


def test_cohort_gathers_spread_army_and_blocks_independent_attack_intents(tmp_path):
    bot, own = cohort_world(tmp_path)
    own += [Unit(U.STALKER, tag=7, position=(58, 50), can_attack=True),
            Unit(U.STALKER, tag=8, position=(49, 50), can_attack=True)]
    bot._refresh_cohesion(own, order(stance="attack"))
    assert bot.cohesion.phase == "assembling" and bot.cohesion.required_supply == 9
    legal = {"attack_enemy_base", "attack_visible_enemy"}
    bot._pluto_action_context = {}
    asyncio.run(bot._army_intents(own, legal))
    assert legal == set()
    assert asyncio.run(bot._cohesion_step(own, order(stance="attack")))
    assert bot.fairplay._pending.ability == A.ATTACK_ATTACK.value
    assert bot.fairplay._pending.target == Point2((58, 50))
    assert bot.fairplay.audit[-1]["selection_mode"] == "army"  # Real F2, including reinforcements.
    assert bot.fairplay.audit[-1]["source_tags"] == []  # No hidden source positions inspected.


def test_cohort_mixed_types_share_one_waypoint_and_require_actual_confirmation(tmp_path):
    bot, own = cohort_world(tmp_path)
    bot.supply_army = 8
    own += [Unit(U.STALKER, tag=7, position=(57, 50), can_attack=True),
            Unit(U.IMMORTAL, tag=8, position=(58, 50), can_attack=True)]
    bot._refresh_cohesion(own, order(stance="attack"))
    assert bot.cohesion.phase == "advancing"
    assert asyncio.run(bot._cohesion_step(own, order(stance="attack")))
    first_target = bot.fairplay._pending.target
    assert first_target == Point2((66, 50)) and bot.cohesion.dispatched == set()
    first = bot.fairplay.audit[-1]["source_tags"][0]
    bot.fairplay.audit[-1]["command_confirmation"] = "accepted"
    bot.fairplay._pending = None
    bot._confirm_commands(own)
    assert bot.cohesion.dispatched == {first}
    bot.state.game_loop += 32
    assert asyncio.run(bot._cohesion_step(own, order(stance="attack")))
    assert bot.fairplay._pending.target == first_target
    assert bot.fairplay.audit[-1]["source_tags"] != [first]
    assert all(not action.HasField("action_raw") for request in bot.client.requests for action in request.actions)


def test_cohort_prism_follows_shared_anchor_without_counting_as_combat_or_scout(tmp_path):
    bot, own = cohort_world(tmp_path)
    bot.supply_army = 8
    prism = Unit(U.WARPPRISM, tag=9, position=(49, 50), is_idle=True, can_attack=False, is_flying=True)
    phoenix = Unit(U.PHOENIX, tag=10, position=(58, 50), can_attack=True, is_hallucination=True)
    own += [prism, phoenix]
    bot._refresh_cohesion(own, order(stance="attack", scout=True))
    assert bot.cohesion.local_supply == 0 and bot.cohesion.members == {}
    bot.cohesion.update([{"tag": 11, "position": (58, 50), "supply": 6}], 8, (58, 50), (150, 50), bot.time)
    assert bot.cohesion.phase == "advancing"
    bot._pluto_action_context = {}
    assert not asyncio.run(bot._nonworker_scout_intent(own, order(scout=True)))
    assert asyncio.run(bot._cohesion_step(own, order(stance="attack")))
    assert bot.fairplay._pending.ability == A.MOVE_MOVE.value
    assert bot.fairplay.audit[-1]["source_tags"] == [9]
    assert bot._army_plan["job"] == "cohort_support"


def test_prism_rescue_leases_protect_fullscreen_same_type_selection_and_loaded_transport(tmp_path):
    bot, own = cohort_world(tmp_path)
    bot.cohesion.update([], 12, (58, 50), (150, 50), bot.time)
    bot.prism.protected_tags[7] = bot.time + 3
    own += [Unit(U.STALKER, tag=tag, position=(49 + tag / 10, 50), can_attack=True) for tag in (7, 8, 9)]
    own += [Unit(U.WARPPRISM, tag=10, can_attack=False, cargo_used=2)]
    assert asyncio.run(bot._cohesion_step(own, order(stance="attack")))
    assert bot.fairplay.audit[-1]["source_tags"] == [8]
    assert bot.client.requests[-1].actions[0].action_feature_layer.unit_selection_point.type == 1


def test_cohort_camera_follows_recorded_shared_waypoint_then_returns_for_macro(tmp_path):
    bot, own = cohort_world(tmp_path)
    bot.cohesion.update([{"tag": 7, "position": (58, 50), "supply": 6}], 6, (58, 50), (150, 50), bot.time)
    bot.cohesion.confirm("cohort_advance", [7], bot.cohesion.epoch, True)

    class Hidden:
        def __getattribute__(self, name):
            raise AssertionError("Global unit reads forbidden: " + name)

    bot.units = [Hidden()]
    assert asyncio.run(bot._camera_schedule(own, order(stance="attack")))
    assert bot.fairplay.audit[-1]["destination"] == [66, 50]
    bot.fairplay.camera_center = Point2((66, 50))
    bot.state.game_loop += 112
    assert asyncio.run(bot._camera_schedule([], order(stance="attack")))
    assert bot.fairplay.audit[-1]["destination"] == [50, 50]


def test_hallucinated_scout_confirmation_arms_camera_but_never_real_army_job(tmp_path):
    bot, own = cohort_world(tmp_path)
    phoenix = Unit(U.PHOENIX, tag=10, position=(58, 50), can_attack=True, is_hallucination=True)
    bot.scout_spells.pending = {"name": "scout_hallucinated_phoenix", "source_tag": 10}
    bot.fairplay.audit.append({"kind": "selection", "source_tags": [10], "command_confirmation": "accepted"})
    bot._selected_actions[0] = {"name": "scout_hallucinated_phoenix", "position": [150, 50], "revision": 1}
    bot._confirm_commands([phoenix])
    assert bot.scout_spells.confirmed_dispatches == 1
    assert bot._scout_camera_lease["source_tag"] == 10
    assert 10 in bot._nonworker_scout_tags
    assert not asyncio.run(bot._guard_army([phoenix], order()))


def test_expansion_revisit_cannot_starve_behind_regular_camera_changes(tmp_path):
    bot = world(tmp_path)
    bot._last_camera_change = bot.time - 3
    bot._expansion = {"position": [80, 50], "source_tag": 1, "started": 0, "move_confirmed": True}
    assert asyncio.run(bot._expansion_step([], order()))
    assert bot._expansion["wait_reason"] == "site_camera_requested"
    bot.state.game_loop += 112
    bot._last_camera_change = bot.time - 3
    assert not asyncio.run(bot._expansion_step([], order()))  # Own ten-second pacing.
    bot.state.game_loop += 112
    bot._last_camera_change = bot.time - 3
    assert asyncio.run(bot._expansion_step([], order()))


@pytest.mark.parametrize("ability,placement,reason", [
    (False, True, "build_ability_unavailable"), (True, False, "placement_rejected"),
    (True, True, "build_selection_pending")])
def test_expansion_records_visible_ability_and_placement_evidence(tmp_path, ability, placement, reason):
    bot = world(tmp_path)
    bot._expansion = {"position": [50, 50], "source_tag": 1, "started": 0, "move_confirmed": True}

    async def available(*_args, **_kwargs):
        return [[A.PROTOSSBUILD_NEXUS] if ability else []]

    async def can_place(*_args):
        assert ability
        return placement

    bot.get_available_abilities, bot.can_place_single = available, can_place
    assert asyncio.run(bot._expansion_step([Unit()], order())) is (ability and placement)
    assert bot._expansion["wait_reason"] == reason
    assert bot._expansion["footprint_visible"] and bot._expansion["build_ability_available"] is ability


@pytest.mark.parametrize("known_job", [False, True])
def test_guard_recovers_only_its_own_observed_follow_nexus_order(tmp_path, known_job):
    bot, own = guard_world(tmp_path, U.SENTRY)
    own[-1].is_idle = False
    own[-1].orders = [NS(ability=NS(id=A.MOVE_MOVE, exact_id=A.MOVE_MOVE), target=99)]
    if known_job:
        bot._army_job_tags.add(7)
    assert asyncio.run(bot._guard_army(own, order())) is known_job
    if known_job:
        assert bot.fairplay._pending.target.distance_to(own[0].position) >= 6.5


def test_idle_cohort_member_reissues_interrupted_waypoint_without_hidden_inference(tmp_path):
    bot, own = cohort_world(tmp_path)
    unit = Unit(U.STALKER, tag=7, position=(58, 50), can_attack=True, is_idle=True)
    own.append(unit)
    bot.cohesion.update([{"tag": 7, "position": (58, 50), "supply": 6}], 6, (58, 50), (150, 50), bot.time)
    bot.cohesion.confirm("cohort_advance", [7], bot.cohesion.epoch, True)
    assert asyncio.run(bot._cohesion_step(own, order(stance="attack")))
    assert bot.fairplay._pending.target == Point2((66, 50))
    assert 7 not in bot.cohesion.dispatched


@pytest.mark.parametrize("position", [(66, 53), (66, 55)])
def test_idle_cohort_arrival_at_own_safe_click_or_formation_keeps_receipt(tmp_path, position):
    bot, own = cohort_world(tmp_path)
    bot._global_army_allowed = lambda _: False  # Exercise the local per-unit fallback.
    bot.fairplay.camera_center = Point2((66, 53))
    own.append(Unit(U.STALKER, tag=7, position=position, can_attack=True, is_idle=True))
    bot.cohesion.update([{"tag": 7, "position": (58, 50), "supply": 6}],
                        6, (58, 50), (150, 50), bot.time)
    bot.cohesion.confirm("cohort_advance", [7], bot.cohesion.epoch, True, (66, 50))
    bot.cohesion.confirm("cohort_advance", [7], bot.cohesion.epoch, True, (66, 53))
    assert not asyncio.run(bot._cohesion_step(own, order(stance="attack")))
    assert bot.cohesion.dispatched == {7}
    assert bot.fairplay._pending is None


def test_prism_rescue_has_priority_over_micro_and_passes_only_current_screen(tmp_path):
    bot = world(tmp_path)
    visible = Unit(U.WARPPRISM, tag=7, can_attack=False)
    bot.units = [visible, Unit(U.WARPPRISM, tag=8, position=(100, 100))]

    async def rescue(_bot, own, enemies, plan):
        assert own == [visible] and enemies == []
        bot.prism.protected_tags[7] = bot.time + 3
        return True

    async def forbidden(*_args, **_kwargs):
        pytest.fail("An accepted rescue must not immediately receive a replacement combat action")

    bot.prism.step, bot.combat.step = rescue, forbidden
    asyncio.run(bot._step(0))
    assert 7 in bot._combat_protected_tags()
    assert bot._combat_camera_until == bot.time + 2


@pytest.mark.parametrize("chosen,spell_expected", [("train_probe", False), ("build_pylon", False),
                                                   ("chrono_boost", True), ("no_op", True)])
def test_scout_spells_yield_to_urgent_macro_and_precede_optional_chrono(tmp_path, monkeypatch, chosen, spell_expected):
    bot = world(tmp_path)
    bot.executor = NS(choose_action=lambda *_: chosen, record_action=lambda *_: None)
    called = []

    async def no_action(*_args):
        return False

    async def spells(*_args):
        called.append("spell")
        return True

    async def execute(_bot, index):
        called.append(ACTION_NAMES[index])
        return False

    async def mask(_bot):
        index = ACTION_NAMES.index(chosen)
        _bot._pluto_action_context = {index: NS(sources=(), target=None)}
        mask = np.zeros(len(ACTION_NAMES), dtype=bool)
        mask[index] = True
        return mask

    bot._expansion_step = bot._transfer_worker = bot._camera_schedule = bot._army_intents = no_action
    bot.scout_spells.step = spells
    monkeypatch.setattr("pluto_sc2.coach_bot.legal_action_mask", mask)
    monkeypatch.setattr("pluto_sc2.coach_bot.execute_action", execute)
    asyncio.run(bot._step(0))
    assert called == (["spell"] if spell_expected else [chosen])


def test_force_field_confirmations_use_actual_input_result_and_protect_caster(tmp_path):
    bot = world(tmp_path)
    bot.force_fields.pending = {"source_tag": 7, "target": Point2((55, 50)), "selected_at": bot.time}
    bot.fairplay.audit.append({"kind": "selection", "source_tags": [7]})
    bot._selected_actions[0] = {"name": "combat_force_field", "position": [55, 50], "revision": 1}
    bot._confirm_commands([])
    assert bot.force_fields.confirmed_commands == 0
    bot.fairplay.audit[-1]["command_confirmation"] = "accepted"
    bot._confirm_commands([])
    assert bot.force_fields.confirmed_commands == 1
    assert bot.force_fields.recent_targets[0][0] == Point2((55, 50))
    assert 7 in bot._combat_protected_tags()


def test_guardian_then_force_fields_precede_ordinary_defense_and_keep_prism_source_protection(tmp_path):
    bot = world(tmp_path)
    bot.prism.protected_tags[7] = bot.time + 3
    called = []

    async def combat(_bot, own, enemies, plan, *, protected_tags, guardian_only=False):
        assert protected_tags == {7}
        assert guardian_only
        called.append("combat_guardian_opportunity")
        return False

    async def barrier(_bot, own, enemies, plan, *, protected_tags):
        assert protected_tags == {7}
        called.append("force_field")
        return True

    async def forbidden(*_args):
        pytest.fail("Accepted barrier must not be overwritten by ordinary defense")

    bot.combat.step, bot.force_fields.step = combat, barrier
    bot._defense_step = forbidden
    asyncio.run(bot._step(0))
    assert called == ["combat_guardian_opportunity", "force_field"]


def test_loaded_prism_and_pending_pickup_target_ignore_generic_guard_and_retreat(tmp_path):
    bot, own = guard_world(tmp_path, U.WARPPRISM)
    own[-1].cargo_used = 2
    assert not asyncio.run(bot._guard_army(own, order()))
    index = ACTION_NAMES.index("retreat")
    bot._pluto_action_context = {index: NS(ability=A.MOVE_MOVE, target=Point2((50, 50)), minimap=True)}
    bot.prism.protected_tags[8] = bot.time + 3
    own.append(Unit(U.STALKER, tag=8, can_attack=True))
    legal = {"retreat"}
    asyncio.run(bot._army_intents(own, legal))
    # An empty eligible list must also remove the old adapter intent.
    assert not legal


def test_cohort_visible_blocked_waypoint_gets_shared_bounded_detour_before_dispatch(tmp_path):
    bot, own = cohort_world(tmp_path)
    bot.fairplay.camera_center = Point2((58, 50))
    bot.cohesion.update([{"tag": 7, "position": (58, 50), "supply": 6}], 6, (58, 50), (150, 50), bot.time)
    seen = []

    def pathing(point):
        assert bot.fairplay.on_screen(point) and bot.is_visible(point)
        seen.append(point)
        return point.y != 50

    bot.in_pathing_grid = pathing
    assert bot._prepare_cohort_waypoint(own)
    waypoint = Point2(bot.cohesion.waypoint)
    assert waypoint.y != 50 and waypoint.distance_to(Point2(bot.cohesion.rally)) <= 8.01
    assert bot.cohesion.members == {7: 6}
    assert seen and bot._cohort_blocked is None


def test_new_pylon_on_rendezvous_moves_shared_anchor_to_observed_clear_ground(tmp_path):
    bot, own = cohort_world(tmp_path)
    bot.fairplay.camera_center = Point2((58, 50))
    bot.cohesion.update([], 60, (58, 50), (150, 50), bot.time)
    pylon = Unit(U.PYLON, tag=88, position=(58, 50), is_structure=True, radius=1)
    own.append(pylon)
    bot.in_pathing_grid = lambda point: bot.fairplay.on_screen(point)
    assert bot._prepare_cohort_waypoint(own)
    anchor = Point2(bot.cohesion.rally)
    assert 2 < anchor.distance_to(pylon.position) <= 7.01
    assert bot.fairplay.on_screen(anchor) and bot.is_visible(anchor)
    assert bot.cohesion.phase == "assembling" and not bot.cohesion.members


def test_fogged_rendezvous_does_not_invent_an_obstruction_or_new_anchor(tmp_path):
    bot, own = cohort_world(tmp_path)
    bot.cohesion.update([], 60, (80, 50), (150, 50), bot.time)
    bot.is_visible = lambda point: False

    def forbidden(_point):
        pytest.fail("Cannot query unseen rendezvous terrain")

    bot.in_pathing_grid = forbidden
    assert bot._prepare_cohort_waypoint(own)
    assert bot.cohesion.rally == (80, 50)


@pytest.mark.parametrize("attention", [True, False])
def test_paid_army_camera_visit_services_cohort_before_returning_to_macro(tmp_path, attention):
    bot = world(tmp_path)
    bot._army_attention_until = bot.time + 3 if attention else bot.time - 1
    calls = []

    async def cohort(_own, _order):
        calls.append("cohort")
        return True

    async def expansion(_own, _order):
        calls.append("macro")
        return True

    bot._cohesion_step, bot._expansion_step = cohort, expansion
    asyncio.run(bot._step(0))
    assert calls == (["cohort"] if attention else ["macro"])


def test_building_attack_alert_looks_at_remembered_base_through_paid_camera(tmp_path):
    bot = world(tmp_path)
    bot.memory.own[99] = known_base((80, 50))
    bot.state.alerts = [6]
    bot._observe_building_attack_alert()
    assert bot._building_alert_checks[0]["position"] == [80, 50]
    assert asyncio.run(bot._building_attack_camera_step())
    assert bot.action_counts["camera_building_under_attack"] == 1
    assert bot.fairplay.audit[-1]["kind"] == "camera"
    assert not bot.client.requests[-1].actions[0].HasField("action_raw")
    assert bot._building_alert_events[-1]["source"] == "BuildingUnderAttack"


def test_alert_does_not_infer_attack_location_or_interrupt_confirmed_defense(tmp_path):
    bot = world(tmp_path)
    bot.memory.own[99] = known_base((80, 50))
    bot.state.alerts = [6]
    bot._observe_building_attack_alert()
    assert bot._defense_alert is None
    bot._defense_alert = {"base_tag": 99, "position": [80, 50], "last_seen_seconds": bot.time}
    assert not asyncio.run(bot._building_attack_camera_step())
    assert not bot._building_alert_checks and not bot.client.requests


def test_cohort_never_relocates_shared_waypoint_after_a_confirmed_order(tmp_path):
    bot, own = cohort_world(tmp_path)
    bot.fairplay.camera_center = Point2((58, 50))
    bot.cohesion.update([{"tag": 7, "position": (58, 50), "supply": 6}], 6, (58, 50), (150, 50), bot.time)
    bot.cohesion.confirm("cohort_advance", [7], bot.cohesion.epoch, True)
    bot.in_pathing_grid = lambda _point: False
    assert not bot._prepare_cohort_waypoint(own)
    assert bot.cohesion.waypoint == (66, 50)
    assert bot._cohort_blocked["orders_already_dispatched"] is True


def test_cohort_fogged_short_destination_never_refreshes_terrain(tmp_path):
    bot, own = cohort_world(tmp_path)
    bot.fairplay.camera_center = Point2((58, 50))
    bot.cohesion.update([{"tag": 7, "position": (58, 50), "supply": 6}], 6, (58, 50), (150, 50), bot.time)
    own.append(Unit(U.STALKER, tag=7, position=(58, 50), can_attack=True))
    bot.is_visible = lambda _point: False

    def forbidden(_point):
        pytest.fail("No pathing reads under fog")

    bot.in_pathing_grid = forbidden
    assert asyncio.run(bot._cohesion_step(own, order(stance="attack")))
    assert bot.fairplay._pending.minimap and bot.fairplay._pending.target == Point2((66, 50))


def test_third_nexus_does_not_move_natural_guard_or_assembly_anchor(tmp_path):
    bot, own = guard_world(tmp_path)
    bot.memory.own[99]["first_seen_loop"] = 0
    bot.memory.own[100] = {**known_base((80, 50), 100), "first_seen_loop": 100}
    assert bot._rally_bases()[0]["tag"] == 100
    bot.memory.own[101] = {**known_base((120, 50), 101), "first_seen_loop": 500}
    assert bot._rally_bases()[0]["tag"] == 100
    bot._refresh_cohesion(own, order(stance="pressure"))
    assert bot.cohesion.rally == (88, 50)
    # Observed removal of the natural falls back to the main; merely adding a
    # forward third never changes the remembered home army anchor.
    del bot.memory.own[100]
    assert bot._rally_bases()[0]["tag"] == 99


def test_cohort_camera_visits_first_commanded_waypoint_before_full_dispatch_quorum(tmp_path):
    bot, own = cohort_world(tmp_path)
    bot.cohesion.update([{"tag": tag, "position": (58, 50), "supply": 2} for tag in (7, 8, 9)],
                        8, (58, 50), (150, 50), bot.time)
    bot.cohesion.confirm("cohort_advance", [7], bot.cohesion.epoch, True, [65.625, 50])
    bot._cohort_camera_turn = 1
    bot.memory.own[10] = army_record(tag=10, position=(100, 100), seconds=1, loop=16)
    assert asyncio.run(bot._camera_schedule(own, order(stance="pressure")))
    assert bot.fairplay.audit[-1]["destination"] == [65.625, 50]


def test_cohort_recruitment_never_looks_for_the_old_worker_scout(tmp_path):
    bot, own = cohort_world(tmp_path)
    bot.cohesion.update([], 30, (80, 50), (150, 50), bot.time)
    bot._cohort_camera_turn = 1
    bot._worker_scout_lease.designated_worker_tag = 10
    bot.memory.own[10] = {**army_record(tag=10, position=(100, 100), seconds=1, loop=16), "type": "PROBE"}
    assert asyncio.run(bot._camera_schedule(own, order(stance="pressure")))
    assert bot.fairplay.audit[-1]["destination"] == [80, 50]


@pytest.mark.parametrize("target_current_own", [False, True])
def test_observed_friendly_attack_is_stopped_through_normal_screen_input(tmp_path, target_current_own):
    bot = world(tmp_path)
    attacker = Unit(U.STALKER, tag=7, can_attack=True,
                    orders=[NS(ability=NS(id=A.ATTACK_ATTACK, exact_id=A.ATTACK_ATTACK), target=8)])
    own = [attacker] + ([Unit(U.STALKER, tag=8, can_attack=True)] if target_current_own else [])
    queried = []

    async def available(units, **_kwargs):
        queried.extend(units)
        return [[A.STOP] for _ in units]

    bot.get_available_abilities = available
    assert asyncio.run(bot._stop_friendly_attacks(own)) is target_current_own
    assert queried == ([attacker] if target_current_own else [])
    if target_current_own:
        assert bot.fairplay.audit[-1]["source_tags"] == [7]
        assert bot.fairplay._pending.ability == A.STOP.value
        assert bot._friendly_stops_confirmed == 0
        bot.fairplay.audit[-1]["command_confirmation"] = "accepted"
        bot._confirm_commands(own)
        assert bot._friendly_stops_confirmed == 1
        assert bot._friendly_attack_recovery["command_result"] == "accepted"


def test_friendly_fire_recovery_runs_before_combat_or_macro(tmp_path):
    bot = world(tmp_path)
    attacker = Unit(U.STALKER, tag=7, can_attack=True,
                    orders=[NS(ability=NS(id=A.ATTACK_ATTACK, exact_id=A.ATTACK_ATTACK), target=8)])
    bot.units = [attacker, Unit(U.STALKER, tag=8, can_attack=True)]

    async def available(units, **_kwargs):
        return [[A.STOP] for _ in units]

    async def forbidden(*_args, **_kwargs):
        pytest.fail("Observed friendly fire must be stopped before ordinary behavior")

    bot.get_available_abilities = available
    bot.prism.step = bot.combat.step = bot._expansion_step = forbidden
    asyncio.run(bot._step(0))
    assert bot.fairplay._pending.ability == A.STOP.value
    assert bot._selected_actions[0]["name"] == "stop_friendly_fire"


def test_cohort_confirmation_consumes_emitted_pixel_projection_from_gate(tmp_path):
    bot, own = cohort_world(tmp_path)
    bot.cohesion.update([{"tag": 7, "position": (58, 50), "supply": 6}], 6, (58, 50), (150, 50), bot.time)
    bot.fairplay.audit.append({"kind": "selection", "source_tags": [7], "command_confirmation": "accepted",
                              "target_kind": "ground", "effective_target": [65.625, 50],
                              "ground_target_redirected": True})
    bot._selected_actions[0] = {"name": "cohort_advance", "position": [66, 50], "revision": 1,
                                "cohort_epoch": bot.cohesion.epoch}
    bot._confirm_commands(own)
    assert bot.cohesion.waypoint == (66, 50)
    assert bot.cohesion.arrival_point == (65.625, 50)


def test_cohort_and_defense_confirmation_credit_only_selected_subset(tmp_path):
    bot, own = cohort_world(tmp_path)
    bot.cohesion.update([{"tag": tag, "position": (58, 50), "supply": 4} for tag in (7, 8)],
                        8, (58, 50), (150, 50), bot.time)
    bot.fairplay.audit.append({"kind": "selection", "source_tags": [7, 8], "command_source_tags": [7],
                              "command_confirmation": "accepted", "target_kind": "ground",
                              "effective_target": [65.625, 50], "ground_target_redirected": True})
    bot._selected_actions[0] = {"name": "cohort_advance", "position": [66, 50], "revision": 1,
                                "cohort_epoch": bot.cohesion.epoch, "defense_alert_base_tag": 99}
    bot._confirm_commands(own)
    assert bot.cohesion.dispatched == {7}
    assert bot._defense_dispatched == {7}
