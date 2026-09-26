from copy import deepcopy
import json

import pytest

from pluto_sc2.coach_orders import StrategyOrder
from pluto_sc2.coach_strategy import adapt_strategy
from pluto_sc2.schema import BUILD_TYPES, RESEARCH_UPGRADES, TRAIN_TYPES


def order(**changes):
    values = dict(schema=1, game_id="game", revision=4, based_on_report=20,
                  issued_game_seconds=200, valid_until_game_seconds=800, stance="pressure", scout=True,
                  worker_target=44, base_target=2, gas_workers_per_base=3,
                  production_targets={"GATEWAY": 2}, composition={"ZEALOT": 6, "STALKER": 8},
                  research=["WARPGATERESEARCH"], rationale="Chosen replay into ground army.")
    return StrategyOrder.from_dict(values | changes)


def asset(name, tag, **changes):
    return dict(type=name, tag=tag, is_ready=True, is_structure=name in BUILD_TYPES,
                current=False, last_seen_seconds=600, health=100, health_max=100,
                shield=0, shield_max=0, is_hallucination=False,
                can_attack_ground=name in {"STALKER", "ZEALOT", "MARINE", "BANSHEE"},
                can_attack_air=name in {"STALKER", "MARINE"}, is_flying=name == "BANSHEE") | changes


def report(**changes):
    costs = {f"train_{name.lower()}": dict(minerals=125, vespene=50, supply=2) for name in TRAIN_TYPES}
    costs.update({f"build_{name.lower()}": dict(minerals=150, vespene=100) for name in BUILD_TYPES})
    costs["build_nexus"] = dict(minerals=400, vespene=0)
    costs.update({f"research_{name.lower()}": dict(minerals=100, vespene=100) for name in RESEARCH_UPGRADES})
    return dict(game_id="game", time=600, report_sequence=100,
                hud=dict(minerals=3000, vespene=2000, supply_workers=44, supply_army=70,
                         supply_used=114, supply_cap=140),
                own_memory=[asset("NEXUS", 1), asset("NEXUS", 2)], current_own=[],
                current_enemies=[], enemy_memory=[], upgrades=[], action_costs=costs) | changes


def test_large_bank_ground_macro_grows_workers_bases_capacity_and_selected_tech():
    decision = adapt_strategy(order(), report(), now=600)
    result = decision.order
    assert (result.worker_target, result.base_target) == (66, 3)
    assert result.production_targets["GATEWAY"] == 8
    assert result.production_targets["ROBOTICSFACILITY"] == 2
    assert result.production_targets["FORGE"] == result.production_targets["TWILIGHTCOUNCIL"] == 1
    assert not {"STARGATE", "FLEETBEACON", "ROBOTICSBAY", "TEMPLARARCHIVE", "DARKSHRINE"} & result.production_targets.keys()
    assert {"BLINKTECH", "CHARGE", "PROTOSSGROUNDWEAPONSLEVEL1"} <= set(result.research)
    assert not any("AIR" in name or "LEVEL2" in name or "LEVEL3" in name for name in result.research)
    assert decision.evidence["known_value_ratio"] is None
    assert result.stance == "pressure"
    json.dumps(decision.to_dict(), allow_nan=False)


@pytest.mark.parametrize("now,opening,kwargs", [(239, {}, {}), (300, {}, {"opening_active": True}),
                                               (300, {"decision": {"active": True}}, {})])
def test_replay_opening_is_preserved_byte_for_byte(now, opening, kwargs):
    command = order()
    decision = adapt_strategy(command, report(opening=opening), now=now, **kwargs)
    assert decision.order is command
    assert decision.status == "opening_protected"


@pytest.mark.parametrize("kwargs", [{"now": 199}, {"now": 800}, {"now": 600, "game_id": "other"}])
def test_expired_future_and_wrong_game_never_produce_effective_order(kwargs):
    state = report(game_id=kwargs.get("game_id", "game"))
    assert adapt_strategy(order(), state, now=kwargs["now"]).order is None


def test_absent_order_does_not_create_unsolicited_strategy():
    assert adapt_strategy(None, report(), now=600).order is None


def test_retreat_is_not_overridden_by_macro_or_visible_advantage():
    command = order(stance="retreat")
    assert adapt_strategy(command, report(), now=600).order is command


@pytest.mark.parametrize("price,bank,expected", [(875, 800, 2), (875, 875, 3), (400, 399, 2)])
def test_expansion_uses_actual_game_price(price, bank, expected):
    state = report()
    state["action_costs"]["build_nexus"]["minerals"] = price
    state["hud"]["minerals"] = bank
    assert adapt_strategy(order(), state, now=600).order.base_target == expected


@pytest.mark.parametrize("blocker", ["missing_price", "unsaturated", "defense", "pending"])
def test_expansion_does_not_assume_affordability_or_expand_during_known_pressure(blocker):
    state = report()
    if blocker == "missing_price":
        del state["action_costs"]["build_nexus"]
    elif blocker == "unsaturated":
        state["hud"]["supply_workers"] = 20
    elif blocker == "defense":
        state["defense_alert"] = {"position": [1, 2]}
    else:
        state["expansion_task"] = {"position": [1, 2]}
    assert adapt_strategy(order(), state, now=600).order.base_target == 2


def test_three_saturated_bases_target_four_and_automatic_workers_stop_at_72():
    state = report()
    state["own_memory"].append(asset("NEXUS", 3))
    state["hud"]["supply_workers"] = 66
    result = adapt_strategy(order(base_target=3, worker_target=66), state, now=600).order
    assert (result.base_target, result.worker_target) == (4, 72)


def test_sequential_upgrades_require_observed_previous_tier_and_available_price():
    state = report(upgrades=["PROTOSSGROUNDWEAPONSLEVEL1", "PROTOSSGROUNDARMORSLEVEL1"])
    del state["action_costs"]["research_protossgroundarmorslevel2"]
    result = adapt_strategy(order(), state, now=600).order
    assert "PROTOSSGROUNDWEAPONSLEVEL2" in result.research
    assert "PROTOSSGROUNDARMORSLEVEL2" not in result.research
    assert "PROTOSSGROUNDWEAPONSLEVEL3" not in result.research
    assert "PROTOSSGROUNDWEAPONSLEVEL1" not in result.research


def test_missing_public_prices_cannot_invent_tech_or_unit_support():
    command = order()
    result = adapt_strategy(command, report(action_costs={}), now=600).order
    assert result.production_targets == command.production_targets
    assert result.composition == command.composition
    assert result.research == command.research


def test_explicit_air_branch_is_preserved_without_unrelated_ground_tech():
    command = order(composition={"CARRIER": 10, "VOIDRAY": 4}, production_targets={"STARGATE": 3}, research=[])
    result = adapt_strategy(command, report(), now=600).order
    assert result.composition == command.composition
    assert result.production_targets == command.production_targets
    assert result.research == ()


def combat_report():
    return report(current_own=[asset("STALKER", i) for i in range(10, 18)],
                  enemy_memory=[asset("MARINE", 90)], current_enemies=[asset("MARINE", 90)])


def test_current_assembled_force_and_fresh_enemy_coverage_can_promote_attack():
    decision = adapt_strategy(order(), combat_report(), now=600,
                              unit_catalog={"MARINE": {"minerals": 50, "vespene": 0}})
    assert decision.order.stance == "attack"
    assert decision.evidence["favorable"]
    assert decision.evidence["known_value_ratio"] == 32


@pytest.mark.parametrize("condition", ["unknown", "stale", "absent", "offscreen_own", "hallucinations"])
def test_no_attack_claim_from_unknown_fog_or_unassembled_hud_force(condition):
    state = combat_report()
    catalog = {"MARINE": {"minerals": 50, "vespene": 0}}
    if condition == "unknown":
        catalog = {}
    elif condition == "stale":
        state["current_enemies"] = []
        state["enemy_memory"][0]["last_seen_seconds"] = 500
    elif condition == "absent":
        state["current_enemies"] = state["enemy_memory"] = []
    elif condition == "offscreen_own":
        state["own_memory"] += state["current_own"]
        state["current_own"] = []
    else:
        for row in state["current_own"]:
            row["is_hallucination"] = True
    decision = adapt_strategy(order(stance="attack"), state, now=600, unit_catalog=catalog)
    assert not decision.evidence["favorable"]
    assert decision.order.stance == "pressure"


def test_recent_enemy_air_requires_actual_anti_air_capability_and_adds_stalkers():
    state = report(current_own=[asset("ZEALOT", i) for i in range(10, 40)],
                   current_enemies=[asset("BANSHEE", 90)])
    decision = adapt_strategy(order(composition={"ZEALOT": 30}), state, now=600,
                              unit_catalog={"BANSHEE": {"minerals": 150, "vespene": 100}})
    assert not decision.evidence["favorable"]
    assert decision.evidence["own_anti_air_value"] == 0
    assert decision.order.composition["STALKER"] >= 24
    assert "STARGATE" not in decision.order.production_targets


def test_strategy_is_pure_and_preserves_mailbox_identity_and_lifetime():
    command, state = order(), report()
    original = deepcopy(state)
    decision = adapt_strategy(command, state, now=600)
    assert state == original
    assert decision.order.revision == command.revision
    assert decision.order.based_on_report == command.based_on_report
    assert decision.order.valid_until_game_seconds == command.valid_until_game_seconds
    assert len(decision.order.rationale) <= 2000


@pytest.mark.parametrize("now", [True, -1, float("nan"), float("inf")])
def test_invalid_time_fails_closed(now):
    with pytest.raises(ValueError):
        adapt_strategy(order(), report(), now=now)


def objective_report():
    state = combat_report()
    for row in state["current_own"]:
        row["position"] = [50, 50]
    state["current_enemies"] += [
        asset("SUPPLYDEPOT", 91, is_structure=True, position=[55, 50]),
        asset("COMMANDCENTER", 92, is_structure=True, position=[80, 50]),
        asset("ORBITALCOMMAND", 93, is_structure=True, position=[100, 100])]
    return state


def test_fresh_advantage_targets_nearest_observed_economic_base_before_random_depot():
    state = objective_report()
    before = deepcopy(state)
    decision = adapt_strategy(order(stance="defend"), state, now=600,
                              unit_catalog={"MARINE": dict(minerals=50, vespene=0)})
    objective = decision.evidence["offensive_objective"]
    assert decision.order.stance == "attack"
    assert objective["tag"] == 92 and objective["position"] == [80, 50]
    assert objective["kind"] == "economic_base" and objective["mode"] == "attack"
    assert objective["source"] == "current_enemy_screen" and objective["fresh"]
    assert not objective["requires_scout_refresh"]
    assert "unseen defenders remain unknown" in objective["reason"]
    assert state == before
    json.dumps(decision.to_dict(), allow_nan=False)


@pytest.mark.parametrize("name", ["NEXUS", "COMMANDCENTER", "ORBITALCOMMAND", "PLANETARYFORTRESS",
                                  "HATCHERY", "LAIR", "HIVE"])
def test_all_grounded_enemy_townhall_types_are_economic_objectives(name):
    state = report(current_enemies=[asset(name, 90, is_structure=True, position=[100, 100])])
    decision = adapt_strategy(order(), state, now=600)
    assert decision.evidence["offensive_objective"]["kind"] == "economic_base"
    # A base sighting alone does not establish zero enemy military strength.
    assert decision.order.stance == "pressure" and not decision.evidence["favorable"]


def test_assembled_force_with_stale_intelligence_pressures_and_scouts_last_seen_economy():
    state = objective_report()
    state["enemy_memory"] = [dict(row, last_seen_seconds=520) for row in state["current_enemies"]]
    state["current_enemies"] = []
    state["hud"]["supply_army"] = 16
    decision = adapt_strategy(order(stance="defend", scout=False), state, now=600,
                              unit_catalog={"MARINE": dict(minerals=50, vespene=0)})
    objective = decision.evidence["offensive_objective"]
    assert decision.order.stance == "pressure" and decision.order.scout
    assert not decision.evidence["favorable"] and objective["mode"] == "pressure"
    assert objective["tag"] == 92 and objective["age_seconds"] == 80
    assert not objective["fresh"] and objective["requires_scout_refresh"]
    assert objective["source"] == "enemy_last_seen_memory"
    assert "not a claim the target is still there" in objective["reason"]


def test_hud_alone_cannot_promote_defensive_scattered_army_to_offense():
    state = objective_report()
    state["own_memory"] += state["current_own"]
    state["current_own"] = []
    decision = adapt_strategy(order(stance="defend"), state, now=600,
                              unit_catalog={"MARINE": dict(minerals=50, vespene=0)})
    assert decision.order.stance == "defend"
    assert decision.evidence["offensive_objective"] is None


@pytest.mark.parametrize("change", [dict(status="destroyed"), dict(status="not_seen_at_visible_position"),
    dict(status="dead"), dict(destroyed=True), dict(is_flying=True), dict(is_hallucination=True),
    dict(position=None), dict(position=[float("nan"), 1]), dict(tag=True), dict(tag=None),
    dict(last_seen_seconds=419.99), dict(last_seen_seconds=601)])
def test_invalid_or_outdated_economic_location_cannot_be_objective(change):
    state = report(enemy_memory=[asset("NEXUS", 90, position=[100, 100], **change)]
                   if "position" not in change and "tag" not in change else [])
    row = asset("NEXUS", 90, position=[100, 100])
    row.update(change)
    state["enemy_memory"] = [row]
    assert adapt_strategy(order(), state, now=600).evidence["offensive_objective"] is None


def test_current_visible_empty_status_invalidates_old_same_tag_economic_location():
    state = report(enemy_memory=[asset("NEXUS", 90, position=[100, 100])],
                   current_enemies=[asset("NEXUS", 90, position=[100, 100],
                                          status="not_seen_at_visible_position")])
    assert adapt_strategy(order(), state, now=600).evidence["offensive_objective"] is None


def test_known_base_defense_alert_suppresses_favorable_offensive_objective():
    state = objective_report()
    state["defense_alert"] = {"position": [10, 10], "base_tag": 1}
    decision = adapt_strategy(order(stance="attack"), state, now=600,
                              unit_catalog={"MARINE": dict(minerals=50, vespene=0)})
    assert decision.evidence["favorable"]
    assert decision.order.stance == "defend"
    assert decision.evidence["offensive_objective"] is None


def test_destroyed_combat_memory_does_not_block_observed_favorable_force():
    state = objective_report()
    state["enemy_memory"].append(asset("BANSHEE", 99, status="destroyed", last_seen_seconds=300))
    decision = adapt_strategy(order(), state, now=600,
                              unit_catalog={"MARINE": dict(minerals=50, vespene=0)})
    assert decision.evidence["favorable"] and not decision.evidence["unknown_enemy_value"]
