"""Planner integration; the native fixture separately verifies game UI effects."""
import asyncio
from types import SimpleNamespace as NS

import pytest
from sc2.ids.ability_id import AbilityId as A
from sc2.ids.unit_typeid import UnitTypeId as U
from sc2.position import Point2

from test_coach_bot import Unit, world
from test_coach_bot import cohort_world, order
from test_coach_bot import known_base


def production_world(tmp_path):
    bot = world(tmp_path)
    bot.supply_left, bot.supply_army = 10, 0
    bot.minerals, bot.vespene = 500, 100
    bot._pluto_action_context = {}
    nexus = Unit(U.NEXUS, tag=99)
    bot.groups.observe([nexus], bot.time)
    bot.groups.plan_registration(2, [99], bot.time)
    bot.groups.confirm_registration(True)
    return bot


def test_group_candidate_is_intent_and_does_not_read_hidden_queues(tmp_path):
    bot = production_world(tmp_path)

    class Hidden:
        def __getattribute__(self, name):
            raise AssertionError(f"Hidden producer state: {name}")

    bot.units = bot.structures = [Hidden()]
    report = {"action_costs": {"train_probe": {"minerals": 50, "vespene": 0, "supply": 1}}}
    legal = {"no_op"}
    bot._group_candidates(report, legal)
    assert report["group_production_candidates"] == ["train_probe"]
    assert bot._group_production_intents == {"train_probe": 2}
    intent = next(iter(bot._pluto_action_context.values()))
    assert intent.sources == () and intent.target is None and intent.ability == A.NEXUSTRAIN_PROBE


@pytest.mark.parametrize("case", ["unregistered", "poor", "supply", "cooldown", "pending_store"])
def test_group_candidates_obey_observed_budget_and_registration(tmp_path, case):
    bot = production_world(tmp_path)
    if case == "unregistered":
        bot.groups.registered[2].clear()
    elif case == "poor":
        bot.minerals = 49
    elif case == "supply":
        bot.supply_left = 0
    elif case == "cooldown":
        bot.groups.record_production_attempt("train_probe", bot.time, False)
    else:
        bot.groups.plan_registration(1, [5], bot.time)
    report = {"action_costs": {"train_probe": {"minerals": 50, "vespene": 0, "supply": 1}}}
    bot._group_candidates(report, {"no_op"})
    assert report["group_production_candidates"] == []


def test_visible_production_intent_is_preserved_for_new_group_members(tmp_path):
    bot = production_world(tmp_path)
    report = {"action_costs": {"train_probe": {"minerals": 50, "vespene": 0, "supply": 1}}}
    bot._group_candidates(report, {"train_probe"})
    assert bot._group_production_intents == {} and bot._pluto_action_context == {}


def test_only_confirmed_production_plans_group_store(tmp_path):
    bot = world(tmp_path)
    bot.groups.observe([Unit(U.NEXUS, tag=99)], bot.time)
    event = {"source_tags": [99]}
    bot._confirm_group_actions("train_probe", event, {}, False)
    assert bot.groups.pending_registration is None
    bot._confirm_group_actions("train_probe", event, {}, True)
    assert bot.groups.pending_registration["group"] == 2
    assert bot.groups.registered[2] == set()  # A store still requires a paid game input.


def test_pending_group_store_prevents_recall_planning_and_records_rejection(tmp_path):
    bot = production_world(tmp_path)
    bot.groups.plan_registration(1, [7], bot.time)
    assert bot.groups.recall_plan(2, bot.time) is None
    assert not asyncio.run(bot._store_pending_group())  # No controller receipt to back the store.
    assert bot.groups.pending_registration is None and bot.groups.registered[1] == set()


def test_f2_visible_target_selects_army_without_reading_hidden_sources(tmp_path):
    bot = world(tmp_path)
    bot.supply_army = 12
    assert asyncio.run(bot._group_army_step([], Point2((55, 50)), "defend", key=("defend", 99)))
    action = bot.client.requests[0].actions[0]
    assert action.action_ui.HasField("select_army")
    assert bot.fairplay.audit[0]["source_positions"] == []
    assert not bot.groups.registered[1]  # Input accepted does not mean selection confirmed.


@pytest.mark.parametrize("case", ["fog", "offscreen", "protected", "scouting"])
def test_f2_does_not_override_fog_or_active_unit_missions(tmp_path, case):
    bot = world(tmp_path)
    bot.supply_army = 12
    target = Point2((55, 50))
    if case == "fog":
        bot.is_visible = lambda _: False
    elif case == "offscreen":
        target = Point2((150, 150))
    elif case == "protected":
        bot._combat_held_tags[7] = bot.time + 3
    else:
        bot._nonworker_scout_tags.add(8)
        bot._scout_camera_lease = {"source_tag": 8, "issued_game_seconds": bot.time}
    assert not asyncio.run(bot._group_army_step([], target, "defend", key=("defend", 99)))
    assert not bot.client.requests


def test_f2_confirmation_reassigns_expired_scout_and_plans_army_group(tmp_path):
    bot = world(tmp_path)
    bot.supply_army = 12
    bot._nonworker_scout_tags.add(8)
    bot._scout_camera_lease = {"source_tag": 8, "issued_game_seconds": -40, "status": "observed_scout"}
    bot._confirm_group_actions("cohort_advance", {
        "selection_mode": "army", "source_tags": [], "command_source_tags": [7, 8]}, {}, True)
    assert not bot._nonworker_scout_tags
    assert bot._scout_camera_lease["status"] == "reassigned_to_army"
    assert bot.groups.pending_registration["source_tags"] == [7, 8]
    bot._observe_scout_camera([])
    assert bot._scout_camera_lease["status"] == "reassigned_to_army"


def test_group_production_issue_uses_recall_without_camera_input(tmp_path):
    bot = production_world(tmp_path)
    calls = []

    async def issue(*args, **kwargs):
        calls.append((args, kwargs))
        return False

    bot.fairplay.issue = issue
    bot._group_candidates({"action_costs": {"train_probe": {
        "minerals": 50, "vespene": 0, "supply": 1}}}, {"no_op"})
    assert not asyncio.run(bot._issue_production_group("train_probe"))
    assert calls[0][0][1] == []
    assert calls[0][1] == {"selection_mode": "control_group", "control_group": 2}
    assert not bot.client.requests


def test_production_portrait_step_retains_intention_until_actual_command(tmp_path):
    bot = world(tmp_path)
    bot.fairplay.audit.extend([
        {"kind": "selection", "selection_mode": "control_group", "source_tags": [],
         "selected_tags": [98, 99], "command_confirmation": "production_subselection"},
        {"kind": "selection", "selection_mode": "control_group_producer", "source_tags": [],
         "parent_selection_audit_index": 0},
    ])
    bot._selected_actions[0] = {"name": "train_probe", "position": None, "revision": 1}
    bot._confirm_commands([])
    assert set(bot._selected_actions) == {1}
    assert not bot.groups.counts
    bot.fairplay.audit[1].update(command_confirmation="accepted", command_source_tags=[99])
    bot._confirm_commands([])
    assert not bot._selected_actions
    assert bot.groups.counts["accepted_production_attempts"] == 1
    import json
    execution = [json.loads(line) for line in (tmp_path / "execution.jsonl").read_text().splitlines()]
    assert len(execution) == 1 and execution[0]["selection_audit_index"] == 1
    assert execution[0]["command_result"] == "accepted"
    assert bot.groups.counts["accepted_group_production"] == 1


def test_public_combat_catalog_omits_scenery_and_handles_untrainable_variants(tmp_path):
    bot = world(tmp_path)
    bot.game_data.units = {
        U.MINERALFIELD.value: NS(_proto=NS(race=0)),
        U.STALKER.value: NS(_proto=NS(race=3, mineral_cost=125, vespene_cost=50,
                                    food_required=2, weapons=[NS(type=3)])),
    }

    def no_creation_cost(_):
        pytest.fail("Scenery and variants without a creation ability must not query creation cost")

    bot.calculate_cost = no_creation_cost
    catalog = bot._public_strategy_catalog()
    assert set(catalog) == {"STALKER"}
    assert catalog["STALKER"] == {"minerals": 125, "vespene": 50, "supply": 2,
                                   "can_attack_ground": True, "can_attack_air": True}


def test_blocked_nominal_wave_uses_current_clear_confirmed_click_without_advancing(tmp_path):
    bot, own = cohort_world(tmp_path)
    bot.fairplay.camera_center = Point2((64, 50))
    bot.cohesion.update([{"tag": 7, "position": (58, 50), "supply": 6},
                         {"tag": 8, "position": (58, 50), "supply": 6}], 12, (58, 50), (150, 50), bot.time)
    bot.cohesion.confirm("cohort_advance", [7], bot.cohesion.epoch, True, (64, 50))
    epoch = bot.cohesion.epoch
    bot.in_pathing_grid = lambda p: p.x <= 64
    assert bot._prepare_cohort_waypoint(own)
    assert bot.cohesion.waypoint == (64, 50) and bot.cohesion.epoch == epoch
    assert bot.cohesion.dispatched == {7} and bot.cohesion.job(8)["target"] == (64, 50)
    assert bot.cohesion.required_supply == 9


def test_supply_memory_camera_visit_is_bounded_and_does_not_claim_completion(tmp_path):
    bot = world(tmp_path)
    bot.state.game_loop = 2240
    bot.supply_left, bot.supply_cap = 0, 156
    stale = {"tag": 12, "type": "PYLON", "is_ready": False, "is_structure": True,
             "position": [80, 50], "last_seen_seconds": 50, "last_seen_loop": 1120}
    bot.memory.own[12] = stale
    assert asyncio.run(bot._camera_schedule([], order()))
    assert bot.action_counts["camera_verify_supply"] == 1
    assert not stale["is_ready"] and bot._supply_camera_visits[12] == 1120


def test_opening_building_roles_use_known_base_positions(tmp_path):
    bot = world(tmp_path)
    bot.memory.own = {99: known_base(), 100: known_base((80, 50), 100)}
    bot._opening_decision = NS(active=True, next_action="build_pylon", next_base_index=1)
    assert bot._opening_structure_allowed("build_pylon", Point2((83, 52)))
    assert not bot._opening_structure_allowed("build_pylon", Point2((53, 52)))
    assert not bot._opening_structure_allowed("build_pylon", Point2((140, 150)))
    assert bot._opening_bases() == [{"tag": 99, "base_index": 0, "position": [50, 50]},
                                   {"tag": 100, "base_index": 1, "position": [80, 50]}]


def test_due_natural_structure_gets_paid_camera_and_brief_construction_window(tmp_path):
    bot = world(tmp_path)
    bot.memory.own = {99: known_base(), 100: known_base((80, 50), 100)}
    bot._opening_decision = NS(active=True, reserve=True, next_action="build_pylon", next_base_index=1)
    assert asyncio.run(bot._opening_camera_step())
    assert bot.action_counts["camera_opening_base"] == 1
    assert bot._opening_camera_until == bot.time + 3
    assert not asyncio.run(bot._camera_schedule([], order()))
    assert not asyncio.run(bot._opening_camera_step())


def test_due_supply_opening_build_reaches_normal_mask_before_group_probe_check(tmp_path):
    bot = production_world(tmp_path)
    bot._opening_decision = NS(prioritize_due_construction=True)
    assert not asyncio.run(bot._production_group_step(order()))
    assert not bot.client.requests
    assert bot._last_group_production_check == -100
