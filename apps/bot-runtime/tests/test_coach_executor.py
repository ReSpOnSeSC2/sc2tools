from copy import deepcopy
from types import SimpleNamespace as NS

import pytest
from sc2.ids.ability_id import AbilityId as A

from pluto_sc2.coach_executor import CoachExecutor
from pluto_sc2.coach_opening import OpeningPlan


def order(**changes):
    values = dict(composition={}, production_targets={}, research=(), worker_target=16,
                  base_target=1, gas_workers_per_base=0, stance="defend")
    return NS(**(values | changes))


def unit(kind, tag=1, **changes):
    return dict(type=kind, tag=tag, is_ready=True, is_idle=False, orders=[], position=[tag * 5, 10]) | changes


def report(*own, **changes):
    return dict(hud=dict(supply_left=10, supply_cap=30, supply_workers=16, supply_army=0),
                own_memory=list(own), current_own=list(own), current_enemies=[], upgrades=[]) | changes


def choose(command, state, *legal, now=0):
    return CoachExecutor().choose_action(command, state, set(legal) | {"no_op"}, now)


def test_idle_probe_mines_before_extra_macro():
    state = report(unit("PROBE", is_idle=True))
    assert choose(order(), state, "harvest_minerals", "train_probe") == "harvest_minerals"


def test_proactive_pylon_starts_with_six_free_supply():
    state = report(unit("NEXUS"), unit("GATEWAY", 2))
    state["hud"]["supply_left"] = 6
    assert choose(order(), state, "build_pylon") == "build_pylon"
    state["hud"]["supply_left"] = 7
    assert choose(order(), state, "build_pylon") == "no_op"


def test_pylon_buffer_scales_with_ready_bases_and_production_only():
    state = report(unit("NEXUS"), unit("NEXUS", 2), unit("WARPGATE", 3),
                   unit("ROBOTICSFACILITY", 4), unit("STARGATE", 5, is_ready=False))
    state["hud"]["supply_left"] = 8
    assert choose(order(), state, "build_pylon") == "build_pylon"
    state["hud"]["supply_left"] = 9
    assert choose(order(), state, "build_pylon") == "no_op"


@pytest.mark.parametrize("pending", ["asset", "order", "reservation"])
def test_pending_pylon_prevents_another_build(pending):
    state = report(unit("NEXUS"))
    state["hud"]["supply_left"] = 0
    if pending == "asset":
        state["own_memory"].append(unit("PYLON", 2, is_ready=False))
    elif pending == "order":
        state["own_memory"].append(unit("PROBE", 3, orders=[{"ability_id": A.PROTOSSBUILD_PYLON.value}]))
    else:
        state["pending_construction"] = [{"type": "PYLON", "source_tag": 3, "position": [10, 20]}]
    assert choose(order(), state, "build_pylon") == "no_op"


def test_one_pending_pylon_does_not_veto_supply_for_a_large_production_cycle():
    state = report(unit("NEXUS"), unit("NEXUS", 2), unit("PYLON", 3, is_ready=False),
                   *(unit("GATEWAY", i) for i in range(4, 12)))
    state["hud"].update(supply_left=0, supply_cap=156)
    assert choose(order(), state, "build_pylon") == "build_pylon"
    state["hud"]["supply_cap"] = 192
    assert choose(order(), state, "build_pylon") == "no_op"


def test_supply_cap_200_does_not_request_more_pylons():
    state = report()
    state["hud"].update(supply_left=0, supply_cap=200)
    assert choose(order(), state, "build_pylon") == "no_op"


def test_train_probe_requires_current_ready_idle_nexus():
    state = report(unit("NEXUS", is_idle=True))
    state["hud"]["supply_workers"] = 8
    assert choose(order(), state, "train_probe") == "train_probe"
    state["current_own"] = []
    assert choose(order(), state, "train_probe") == "no_op"


@pytest.mark.parametrize("candidates,expected", [(["train_probe"], "train_probe"),
    ([], "no_op"), ("train_probe", "no_op"), ({"train_probe": True}, "no_op"), (None, "no_op")])
def test_probe_group_intent_can_request_ui_queue_check_without_inventing_idle(candidates, expected):
    state = report(unit("NEXUS"), current_own=[], group_production_candidates=candidates)
    state["hud"]["supply_workers"] = 8
    assert choose(order(), state, "train_probe") == expected
    state["hud"]["supply_workers"] = 16
    assert choose(order(), state, "train_probe") == "no_op"


def test_group_probe_request_does_not_displace_urgent_supply():
    state = report(unit("NEXUS"), current_own=[], group_production_candidates=["train_probe"])
    state["hud"].update(supply_workers=8, supply_left=0)
    assert choose(order(), state, "train_probe", "build_pylon") == "build_pylon"


def test_pending_probe_and_base_saturation_bound_worker_target():
    state = report(unit("NEXUS", is_idle=True), unit("NEXUS", 2, orders=[{"ability_id": A.NEXUSTRAIN_PROBE.value}]))
    state["hud"]["supply_workers"] = 15
    assert choose(order(worker_target=16), state, "train_probe") == "no_op"
    state = report(unit("NEXUS", is_idle=True))
    state["hud"]["supply_workers"] = 22
    assert choose(order(worker_target=80), state, "train_probe") == "no_op"


def test_gas_assignment_and_assimilator_count_follow_order():
    state = report(unit("NEXUS"), unit("ASSIMILATOR", 2, assigned_harvesters=1), unit("GATEWAY", 3))
    assert choose(order(gas_workers_per_base=3), state, "harvest_gas", "build_assimilator") == "harvest_gas"
    state["current_own"][1]["assigned_harvesters"] = 3
    assert choose(order(gas_workers_per_base=3), state, "harvest_gas", "build_assimilator") == "no_op"
    assert choose(order(gas_workers_per_base=6), state, "build_assimilator") == "build_assimilator"


def test_eight_worker_start_cannot_be_diverted_into_gas():
    state = report(unit("NEXUS"), unit("GATEWAY", 2), unit("ASSIMILATOR", 3, assigned_harvesters=0))
    state["hud"]["supply_workers"] = 8
    assert choose(order(gas_workers_per_base=6), state, "harvest_gas", "build_assimilator") == "no_op"


def test_first_gas_build_can_follow_unfinished_gateway_but_assignment_waits():
    state = report(unit("NEXUS"), unit("GATEWAY", 2, is_ready=False))
    assert choose(order(gas_workers_per_base=3), state, "build_assimilator") == "build_assimilator"
    state["current_own"].append(unit("ASSIMILATOR", 3, assigned_harvesters=0))
    assert choose(order(gas_workers_per_base=3), state, "harvest_gas") == "no_op"


def test_general_expansion_target_does_not_indefinitely_stop_army_production():
    state = report(unit("NEXUS"), unit("GATEWAY", 2))
    state["hud"]["minerals"] = 350
    command = order(base_target=2, production_targets={"GATEWAY": 2}, composition={"ZEALOT": 4},
                    research=("BLINKTECH",))
    assert choose(command, state, "build_gateway", "train_zealot", "research_blinktech") == "train_zealot"
    state["hud"]["supply_left"] = 1
    assert choose(command, state, "build_pylon", "train_zealot") == "build_pylon"
    state["hud"].update(supply_left=10, minerals=400)
    assert choose(command, state, "train_zealot") == "train_zealot"
    state["hud"].update(minerals=350, supply_workers=15)
    assert choose(command, state, "train_zealot") == "train_zealot"


def test_pending_nexus_satisfies_expansion_target_without_saving_twice():
    state = report(unit("NEXUS"), unit("GATEWAY", 2))
    state["pending_construction"] = [dict(type="NEXUS", source_tag=3, position=[30, 30])]
    state["hud"]["minerals"] = 100
    assert choose(order(base_target=2, composition={"ZEALOT": 2}), state, "train_zealot") == "train_zealot"


@pytest.mark.parametrize("existing, expected", [
    ([], "build_pylon"), (["PYLON"], "build_gateway"),
    (["PYLON", "GATEWAY"], "build_cyberneticscore"),
    (["PYLON", "GATEWAY", "CYBERNETICSCORE"], "build_roboticsfacility"),
])
def test_public_prerequisite_chain_builds_first_missing_tech(existing, expected):
    state = report(*(unit(kind, i + 1) for i, kind in enumerate(existing)))
    legal = {"build_pylon", "build_gateway", "build_cyberneticscore", "build_roboticsfacility"}
    assert choose(order(production_targets={"ROBOTICSFACILITY": 1}), state, *legal) == expected


def test_under_construction_prerequisite_neither_duplicates_nor_unlocks_next_tech():
    state = report(unit("PYLON"), unit("GATEWAY", 2, is_ready=False))
    assert choose(order(production_targets={"ROBOTICSFACILITY": 1}), state,
                  "build_gateway", "build_cyberneticscore", "build_roboticsfacility") == "no_op"


@pytest.mark.parametrize("reservation", [False, True])
def test_pending_gateway_satisfies_target_and_deduplicates_builder_order(reservation):
    state = report(unit("PYLON"), unit("GATEWAY", 2),
                   unit("PROBE", 3, orders=[dict(ability_id=A.PROTOSSBUILD_GATEWAY.value,
                                                target=dict(kind="point", position=[20, 20]))]))
    if reservation:
        state["pending_construction"] = [dict(type="GATEWAY", source_tag=3, position=[20, 20])]
    assert choose(order(production_targets={"GATEWAY": 2}), state, "build_gateway") == "no_op"
    # The reservation plus its worker order are exactly one expected building.
    assert choose(order(production_targets={"GATEWAY": 3}), state, "build_gateway") == "build_gateway"


def test_constructed_asset_and_builder_order_count_only_once():
    state = report(unit("PYLON"), unit("GATEWAY", 2, is_ready=False, position=[20, 20]),
                   unit("PROBE", 3, orders=[dict(produces="GATEWAY", target=dict(kind="point", position=[20, 20]))]))
    assert choose(order(production_targets={"GATEWAY": 2}), state, "build_gateway") == "build_gateway"


def test_duplicate_same_site_reservations_count_only_once_but_distinct_sites_count_separately():
    state = report(unit("PYLON"))
    reservation = dict(type="GATEWAY", source_tag=3, position=[20, 20])
    state["pending_construction"] = [reservation, dict(reservation)]
    assert choose(order(production_targets={"GATEWAY": 2}), state, "build_gateway") == "build_gateway"
    state["pending_construction"].append(dict(reservation, source_tag=4, position=[30, 30]))
    assert choose(order(production_targets={"GATEWAY": 2}), state, "build_gateway") == "no_op"


def test_composition_respects_existing_and_pending_units():
    state = report(unit("STALKER"), unit("GATEWAY", 2, orders=[{"ability_id": A.GATEWAYTRAIN_STALKER.value}]))
    assert choose(order(composition={"STALKER": 2}), state, "train_stalker") == "no_op"
    assert choose(order(composition={"STALKER": 3}), state, "train_stalker") == "train_stalker"


def test_hallucinated_scout_does_not_satisfy_real_phoenix_quota_or_change_memory():
    state = report(unit("PHOENIX", 1, is_hallucination=True), unit("STARGATE", 2))
    before = deepcopy(state)
    assert choose(order(composition={"PHOENIX": 1}), state, "train_phoenix") == "train_phoenix"
    assert state == before
    state["own_memory"] = state["own_memory"] + [unit("PHOENIX", 3, is_hallucination=False)]
    assert choose(order(composition={"PHOENIX": 1}), state, "train_phoenix") == "no_op"


@pytest.mark.parametrize("now", [221, 1200, 3600])
def test_expired_offscreen_queue_cannot_permanently_suppress_replacement(now):
    state = report(unit("GATEWAY", is_idle=True), time=now)
    state["own_memory"] = state["own_memory"] + [unit("GATEWAY", 2, current=False,
        last_seen_seconds=100, orders=[{"produces": "STALKER"}])]
    before = deepcopy(state)
    assert choose(order(composition={"STALKER": 1}), state, "train_stalker", now=now) == "train_stalker"
    assert state == before  # No assertion about the unseen queue's real outcome.


@pytest.mark.parametrize("now,expected", [(159, "no_op"), (160, "no_op"), (161, "train_stalker"),
                                          (3600, "train_stalker")])
def test_stale_mobile_quota_expires_without_deleting_last_seen_fact(now, expected):
    state = report(unit("GATEWAY", is_idle=True), time=now)
    state["own_memory"] = state["own_memory"] + [unit("STALKER", 2, current=False, last_seen_seconds=100)]
    assert state["hud"]["supply_army"] == 0
    before = deepcopy(state)
    assert choose(order(composition={"STALKER": 1}), state, "train_stalker", now=now) == expected
    assert state == before


@pytest.mark.parametrize("current,age", [(True, 3500), (False, 20), (False, 120)])
def test_current_and_fresh_busy_queues_still_prevent_duplicate_units(current, age):
    busy = unit("GATEWAY", 2, last_seen_seconds=3600-age, orders=[{"produces": "STALKER"}])
    state = report(unit("GATEWAY", is_idle=True), time=3600)
    state["own_memory"] = state["own_memory"] + [busy]
    if current:
        state["current_own"] = state["current_own"] + [busy]
    assert choose(order(composition={"STALKER": 1}), state, "train_stalker", now=3600) == "no_op"


def test_public_train_duration_bounds_queue_with_margin_and_fifo_duration():
    busy = unit("GATEWAY", 2, last_seen_seconds=100, orders=[{"produces": "STALKER"}] * 2)
    state = report(unit("GATEWAY", is_idle=True), time=179,
                   action_costs={"train_stalker": {"time_seconds": 30}})
    state["own_memory"] = state["own_memory"] + [busy]
    command = order(composition={"STALKER": 2})
    assert choose(command, state, "train_stalker", now=179) == "no_op"
    state["time"] = 181
    assert choose(command, state, "train_stalker", now=181) == "train_stalker"


def test_even_long_paused_queue_has_finite_quota_lifetime():
    state = report(unit("GATEWAY", is_idle=True), time=401,
                   action_costs={"train_stalker": {"time_seconds": 10000}})
    state["own_memory"] = state["own_memory"] + [unit("GATEWAY", 2, last_seen_seconds=100,
        orders=[{"produces": "STALKER"}])]
    assert choose(order(composition={"STALKER": 1}), state, "train_stalker", now=401) == "train_stalker"


@pytest.mark.parametrize("now,expected", [(220, "no_op"), (221, "research_warpgateresearch")])
def test_stale_research_queue_cannot_suppress_legal_current_research_forever(now, expected):
    state = report(unit("CYBERNETICSCORE", is_idle=True), time=now)
    state["own_memory"] = state["own_memory"] + [unit("CYBERNETICSCORE", 2, last_seen_seconds=100,
        orders=[{"researches": "WARPGATERESEARCH"}])]
    assert choose(order(), state, "research_warpgateresearch", now=now) == expected


def test_real_research_duration_keeps_long_fresh_queue_until_bounded_deadline():
    state = report(unit("TWILIGHTCOUNCIL", is_idle=True), time=250,
                   action_costs={"research_blinktech": {"time_seconds": 160}})
    state["own_memory"] = state["own_memory"] + [unit("TWILIGHTCOUNCIL", 2, last_seen_seconds=100,
        orders=[{"researches": "BLINKTECH"}])]
    assert choose(order(research=("BLINKTECH",)), state, "research_blinktech", now=250) == "no_op"
    state["time"] = 281
    assert choose(order(research=("BLINKTECH",)), state, "research_blinktech", now=281) == "research_blinktech"


def test_missing_report_time_retains_legacy_conservative_queue_behavior():
    state = report(unit("GATEWAY", is_idle=True))
    state["own_memory"] = state["own_memory"] + [unit("GATEWAY", 2, last_seen_seconds=100,
        orders=[{"produces": "STALKER"}])]
    assert choose(order(composition={"STALKER": 1}), state, "train_stalker", now=3600) == "no_op"


@pytest.mark.parametrize("army_supply,expected", [(0, "train_stalker"), (5, "train_stalker"), (6, "no_op"),
                                                  (20, "no_op")])
def test_current_hud_supply_caps_replacements_after_old_composition_memory_expires(army_supply, expected):
    state = report(unit("GATEWAY", is_idle=True), time=3600,
                   action_costs={"train_stalker": {"supply": 2}, "train_sentry": {"supply": 2}})
    state["hud"]["supply_army"] = army_supply
    state["own_memory"] = state["own_memory"] + [unit("STALKER", 2, last_seen_seconds=100)]
    command = order(composition={"STALKER": 2, "SENTRY": 1})
    assert choose(command, state, "train_stalker", now=3600) == expected


def test_hud_army_cap_does_not_stop_worker_replacement_or_invent_unknown_supply():
    state = report(unit("NEXUS", is_idle=True), time=3600, action_costs={"train_stalker": {"supply": 2}})
    state["hud"].update(supply_army=50, supply_workers=8)
    command = order(worker_target=16, composition={"STALKER": 2})
    assert choose(command, state, "train_probe", now=3600) == "train_probe"
    state["action_costs"]["train_stalker"]["supply"] = float("nan")
    assert choose(command, state, "train_stalker", now=3600) == "train_stalker"


def test_composition_derives_missing_producer_and_tech():
    state = report(unit("PYLON"), unit("GATEWAY", 2))
    assert choose(order(composition={"STALKER": 4}), state, "build_cyberneticscore") == "build_cyberneticscore"


def test_composition_prefers_relative_shortage_and_warpgates_count_as_gateways():
    state = report(unit("ZEALOT"), unit("ZEALOT", 2), unit("WARPGATE", 3), unit("PYLON", 4))
    assert choose(order(composition={"ZEALOT": 4, "STALKER": 4}, production_targets={"GATEWAY": 1}),
                  state, "train_zealot", "train_stalker", "build_gateway") == "train_stalker"


def test_requested_research_is_not_repeated_while_queued_or_completed():
    state = report(unit("TWILIGHTCOUNCIL"))
    command = order(research=("BLINKTECH",))
    assert choose(command, state, "research_blinktech") == "research_blinktech"
    state["current_own"][0]["orders"] = [{"ability_id": A.RESEARCH_BLINK.value}]
    assert choose(command, state, "research_blinktech") == "no_op"
    state["current_own"][0]["orders"] = []
    state["upgrades"] = ["BLINKTECH"]
    assert choose(command, state, "research_blinktech") == "no_op"


def test_warpgate_research_precedes_optional_army_buildings_and_expansion_saving():
    state = report(unit("NEXUS"), unit("GATEWAY", 2), unit("CYBERNETICSCORE", 3))
    state["hud"].update(minerals=350, vespene=50)
    command = order(base_target=2, composition={"STALKER": 10}, production_targets={"GATEWAY": 4})
    assert choose(command, state, "research_warpgateresearch", "build_gateway", "train_stalker") == "research_warpgateresearch"


@pytest.mark.parametrize("blocker", ["pending", "completed", "not_ready", "not_legal", "no_order"])
def test_warpgate_research_waits_for_actual_readiness_and_never_duplicates(blocker):
    state = report(unit("CYBERNETICSCORE"))
    command = order()
    legal = {"research_warpgateresearch"}
    if blocker == "pending":
        state["current_own"][0]["orders"] = [{"ability_id": A.RESEARCH_WARPGATE.value}]
    elif blocker == "completed":
        state["upgrades"] = ["WARPGATERESEARCH"]
    elif blocker == "not_ready":
        state["current_own"][0]["is_ready"] = False
    elif blocker == "not_legal":
        legal.clear()  # Includes engine resource, tech and selected-screen checks.
    else:
        command = None
    assert choose(command, state, *legal) == "no_op"


def test_warpgate_research_keeps_urgent_supply_and_economy_first():
    state = report(unit("NEXUS", is_idle=True), unit("CYBERNETICSCORE", 2))
    state["hud"].update(supply_left=2, supply_workers=8)
    legal = {"research_warpgateresearch", "train_probe", "build_pylon"}
    assert choose(order(), state, *legal) == "build_pylon"
    state["hud"]["supply_left"] = 10
    assert choose(order(), state, *legal) == "train_probe"


def test_visible_threat_keeps_army_production_before_research_and_morph():
    state = report(unit("CYBERNETICSCORE"), unit("GATEWAY", 2, is_idle=True),
                   current_enemies=[unit("MARINE")])
    command = order(composition={"STALKER": 2}, research=("WARPGATERESEARCH",))
    legal = {"research_warpgateresearch", "morph_warpgate", "train_stalker"}
    assert choose(command, state, *legal) == "train_stalker"
    assert choose(command, state, "research_warpgateresearch", "morph_warpgate") == "no_op"


def test_researched_gateway_keeps_normal_production_without_automatic_morph():
    state = report(unit("GATEWAY", is_idle=True), upgrades=["WARPGATERESEARCH"])
    assert choose(order(composition={"STALKER": 4}), state,
                  "morph_warpgate", "train_stalker") == "train_stalker"


@pytest.mark.parametrize("blocker", ["busy", "queued", "offscreen", "unready", "warpgate", "not_legal"])
def test_executor_does_not_automatically_morph_gateways(blocker):
    state = report(unit("GATEWAY", is_idle=True), upgrades=["WARPGATERESEARCH"])
    legal = {"morph_warpgate"}
    if blocker == "busy":
        state["current_own"][0]["is_idle"] = False
    elif blocker == "queued":
        state["current_own"][0]["orders"] = [{"ability_id": A.GATEWAYTRAIN_STALKER.value}]
    elif blocker == "offscreen":
        state["current_own"] = []
    elif blocker == "unready":
        state["current_own"][0]["is_ready"] = False
    elif blocker == "warpgate":
        state["current_own"][0]["type"] = "WARPGATE"
    else:
        legal.clear()
    assert choose(order(), state, *legal) == "no_op"


def test_warp_in_queue_counts_towards_requested_composition():
    state = report(unit("WARPGATE", orders=[{"ability_id": A.WARPGATETRAIN_STALKER.value}]))
    assert choose(order(composition={"STALKER": 1}), state, "train_stalker") == "no_op"


def test_blink_emergency_requires_current_enemy_and_low_shield_stalker():
    state = report(unit("STALKER", shield=10, shield_max=80), current_enemies=[unit("MARINE")])
    assert choose(order(), state, "blink_retreat", "attack_visible_enemy") == "blink_retreat"
    state["current_enemies"] = []
    assert choose(order(), state, "blink_retreat", "attack_visible_enemy") == "no_op"


def test_only_accepted_strategic_inputs_start_five_second_commitment():
    executor = CoachExecutor()
    state = report(current_enemies=[unit("MARINE")])
    legal = {"attack_visible_enemy", "defend", "no_op"}
    executor.record_action("attack_visible_enemy", 1, accepted=False)
    assert executor.choose_action(order(), state, legal, 2) == "attack_visible_enemy"
    executor.record_action("attack_visible_enemy", 2, accepted=True)
    assert executor.choose_action(order(), state, legal, 6.99) == "no_op"
    assert executor.choose_action(order(), state, legal, 7) == "attack_visible_enemy"


def test_retreat_order_overrides_visible_attack_and_retains_commitment():
    executor = CoachExecutor()
    state = report(current_enemies=[unit("MARINE")])
    legal = {"attack_visible_enemy", "retreat", "defend", "no_op"}
    command = order(stance="retreat")
    assert executor.choose_action(command, state, legal, 0) == "retreat"
    executor.record_action("retreat", 0, accepted=True)
    assert executor.choose_action(command, state, legal, 4.99) == "no_op"
    assert executor.choose_action(command, state, legal, 5) == "retreat"
    state["current_enemies"] = []
    assert executor.choose_action(command, state, legal, 5) == "retreat"


def test_chrono_spacing_is_twenty_seconds():
    executor = CoachExecutor()
    executor.record_action("chrono_boost", 0, accepted=True)
    assert executor.choose_action(order(), report(), {"chrono_boost"}, 19.99) == "no_op"
    assert executor.choose_action(order(), report(), {"chrono_boost"}, 20) == "chrono_boost"


def test_attack_stance_requires_basic_army_and_never_runs_without_order():
    state = report()
    state["hud"]["supply_army"] = 5
    assert choose(order(stance="pressure"), state, "attack_enemy_base") == "no_op"
    state["hud"]["supply_army"] = 6
    assert choose(order(stance="pressure"), state, "attack_enemy_base") == "attack_enemy_base"
    assert choose(None, state, "attack_enemy_base", "scout", "build_nexus") == "no_op"


def test_missing_order_keeps_safe_worker_baseline_and_defends_visible_enemy():
    state = report(unit("NEXUS", is_idle=True))
    state["hud"]["supply_workers"] = 15
    assert choose(None, state, "train_probe") == "train_probe"
    state["hud"]["supply_workers"] = 16
    assert choose(None, state, "train_probe") == "no_op"
    state["current_enemies"] = [unit("MARINE")]
    assert choose(None, state, "defend") == "defend"


def test_inputs_are_not_mutated_and_mapping_memory_supported():
    state = report(unit("NEXUS", is_idle=True))
    state["own_memory"] = {"1": state["own_memory"][0]}
    command = vars(order())
    before = deepcopy((command, state))
    choose(command, state, "train_probe")
    assert (command, state) == before


def opening_report(*own, **changes):
    # Stable, separated semantic bases for resource-priority tests. Geometry
    # itself is covered by OpeningPlan's scoped-inventory tests.
    records = []
    nexuses = 0
    for index, item in enumerate(own):
        point = [5 + index % 3, 10 + index // 3]
        if item["type"] == "NEXUS":
            point = [5, 10] if nexuses == 0 else [100, 100]
            nexuses += 1
        records.append(dict(item, position=point))
    return report(*records, opening_bases=[
        dict(base_index=0, position=[5, 10], tag=1),
        dict(base_index=1, position=[100, 100], tag=9)], **changes)


def replay_opening_executor():
    replay_id = "a" * 64
    candidate = dict(replay_id=replay_id, source_sha256=replay_id, partition="train",
                     starting_workers=8, matchup="PvT", milestone_events_first_10_minutes=[
                         dict(name=kind, seconds=seconds, meaning="construction_started", base_index=base)
                         for kind, seconds, base in (("Pylon", 33, 0), ("Gateway", 55, 0),
                             ("Nexus", 100, 1), ("Assimilator", 104, 0),
                             ("CyberneticsCore", 116, 0), ("Assimilator", 124, 0))])
    return CoachExecutor(OpeningPlan.from_candidate(candidate, {replay_id}, set(), "PvT"))


def test_opening_keeps_probes_continuous_through_non_nexus_reservations():
    executor = replay_opening_executor()
    state = opening_report(unit("NEXUS", is_idle=True))
    state["hud"].update(supply_left=5, supply_cap=13, supply_workers=8)
    legal = {"train_probe", "build_pylon"}
    assert executor.choose_action(order(), state, legal, 0) == "train_probe"
    assert executor.choose_action(order(), state, legal, 25) == "train_probe"
    assert executor.choose_action(order(), state, legal, 33) == "train_probe"
    state["current_own"][0]["is_idle"] = False
    assert executor.choose_action(order(), state, legal, 34) == "build_pylon"


def test_opening_emergency_supply_can_precede_its_replay_clock():
    executor = replay_opening_executor()
    state = opening_report(unit("NEXUS"))
    state["hud"]["supply_left"] = 2
    assert executor.choose_action(order(), state, {"build_pylon"}, 20) == "build_pylon"
    executor.record_action("build_pylon", 20, True, base_index=0)
    assert executor.opening.summary()["history"][0]["delay_seconds"] == 0
    assert executor.opening.steps[1].seconds == 55  # Original clock is unchanged.


def test_opening_prevents_early_gas_and_extra_production_but_allows_army_between_steps():
    executor = replay_opening_executor()
    state = opening_report(unit("NEXUS"), unit("PYLON", 2), unit("GATEWAY", 3))
    command = order(base_target=2, gas_workers_per_base=6, composition={"ZEALOT": 2},
                    production_targets={"GATEWAY": 3})
    assert executor.choose_action(command, state,
        {"build_assimilator", "build_gateway", "train_zealot"}, 75) == "train_zealot"
    assert executor.opening_decision.next_action == "build_nexus"
    assert executor.opening_decision.desired_gas_count == 0
    assert not executor.opening_decision.allow_expansion


def test_due_unaffordable_nexus_reserves_resources_before_workers_and_optional_army():
    executor = replay_opening_executor()
    state = opening_report(unit("NEXUS", is_idle=True), unit("PYLON", 2), unit("GATEWAY", 3))
    state["hud"].update(supply_workers=12, minerals=350)
    state["hud"]["vespene"] = 0
    state["opening_next_cost"] = dict(action="build_nexus", minerals=400, vespene=0)
    state["action_costs"] = {"train_probe": dict(minerals=50, vespene=0),
                             "train_zealot": dict(minerals=100, vespene=0)}
    command = order(base_target=2, gas_workers_per_base=6, composition={"ZEALOT": 2})
    legal = {"train_probe", "train_zealot", "build_assimilator"}
    assert executor.choose_action(command, state, legal, 101) == "no_op"
    assert executor.opening_decision.allow_expansion
    assert executor.opening_decision.delay_seconds == 1
    # Expansion placement remains the caller's spatial sequence, even when a
    # generic Nexus site near the current camera would otherwise be legal.
    assert executor.choose_action(command, state, legal | {"build_nexus"}, 102) == "no_op"
    executor.record_action("build_nexus", 102, True, base_index=1)
    assert executor.choose_action(command, state, legal, 103) == "train_probe"
    assert executor.choose_action(command, state, {"build_assimilator"}, 104) == "build_assimilator"


def test_due_nexus_worker_cut_is_bounded_to_eight_seconds_and_small_resource_gap():
    executor = replay_opening_executor()
    state = opening_report(unit("NEXUS", is_idle=True), unit("PYLON", 2), unit("GATEWAY", 3))
    state["hud"].update(supply_workers=12, minerals=350, vespene=0)
    state["opening_next_cost"] = dict(action="build_nexus", minerals=400, vespene=0)
    state["action_costs"] = {"train_probe": dict(minerals=50, vespene=0)}
    assert executor.choose_action(order(), state, {"train_probe"}, 101) == "no_op"
    assert executor.choose_action(order(), state, {"train_probe"}, 108) == "train_probe"
    # A long economic shortfall is not a useful small Nexus worker cut.
    state["hud"]["minerals"] = 100
    other = replay_opening_executor()
    assert other.choose_action(order(), state, {"train_probe"}, 101) == "train_probe"


@pytest.mark.parametrize("blocker", ["missing", "stale", "malformed"])
def test_unknown_or_stale_construction_cost_cannot_freeze_production(blocker):
    executor = replay_opening_executor()
    state = opening_report(unit("NEXUS", is_idle=True), unit("PYLON", 2), unit("GATEWAY", 3))
    state["hud"].update(supply_workers=12, minerals=350, vespene=0)
    state["action_costs"] = {"train_probe": dict(minerals=50, vespene=0)}
    if blocker == "stale":
        state["opening_next_cost"] = dict(action="build_pylon", minerals=400, vespene=0)
    elif blocker == "malformed":
        state["opening_next_cost"] = dict(action="build_nexus", minerals=float("nan"), vespene=0)
    assert executor.choose_action(order(), state, {"train_probe"}, 101) == "train_probe"


def test_rich_placement_blocked_gas_never_stops_probes_or_army():
    executor = replay_opening_executor()
    state = opening_report(unit("NEXUS", is_idle=True), unit("NEXUS", 4), unit("PYLON", 2), unit("GATEWAY", 3))
    state["hud"].update(supply_workers=25, supply_cap=80, supply_left=30, minerals=1565, vespene=640)
    state["opening_next_cost"] = dict(action="build_assimilator", minerals=75, vespene=0)
    state["action_costs"] = {"train_probe": dict(minerals=50, vespene=0),
                             "train_stalker": dict(minerals=125, vespene=50)}
    command = order(worker_target=44, composition={"STALKER": 10})
    legal = {"train_probe", "train_stalker"}  # No legal placement for the due gas.
    assert executor.choose_action(command, state, legal, 105) == "train_probe"
    state["current_own"][0]["is_idle"] = False
    assert executor.choose_action(command, state, legal, 106) == "train_stalker"


def test_army_reservation_preserves_late_construction_budget_until_opening_fallback():
    executor = replay_opening_executor()
    state = opening_report(unit("NEXUS"), unit("PYLON", 2), unit("GATEWAY", 3))
    state["hud"].update(minerals=500, vespene=0)
    state["opening_next_cost"] = dict(action="build_nexus", minerals=400, vespene=0)
    state["action_costs"] = {"train_zealot": dict(minerals=100, vespene=0)}
    command = order(composition={"ZEALOT": 2})
    assert executor.choose_action(command, state, {"train_zealot"}, 101) == "train_zealot"
    state["hud"]["minerals"] = 450
    assert executor.choose_action(command, state, {"train_zealot"}, 102) == "no_op"
    assert executor.choose_action(command, state, {"train_zealot"}, 110) == "no_op"
    assert executor.choose_action(command, state, {"train_zealot"}, 146) == "no_op"
    # Existing opening maximum-delay fallback prevents permanent production starvation.
    assert executor.choose_action(command, state, {"train_zealot"}, 191) == "train_zealot"
    assert executor.opening_decision.status == "fallback"


def test_opening_budget_reserves_optional_army_during_lead_but_keeps_probes_continuous():
    executor = replay_opening_executor()
    state = opening_report(unit("NEXUS", is_idle=True), unit("PYLON", 2), unit("GATEWAY", 3))
    state["hud"].update(minerals=450, vespene=0, supply_workers=12)
    state["opening_next_cost"] = dict(action="build_nexus", minerals=400, vespene=0)
    state["action_costs"] = {"train_zealot": dict(minerals=100, vespene=0),
                             "train_probe": dict(minerals=50, vespene=0)}
    command = order(composition={"ZEALOT": 2})
    assert executor.choose_action(command, state, {"train_zealot"}, 89) == "train_zealot"
    assert executor.choose_action(command, state, {"train_zealot"}, 95) == "no_op"
    state["hud"]["minerals"] = 350
    assert executor.choose_action(command, state, {"train_probe", "train_zealot"}, 96) == "train_probe"


def test_due_legal_opening_core_precedes_optional_army_after_lateness_timeout():
    executor = replay_opening_executor()
    state = opening_report(unit("NEXUS"), unit("NEXUS", 2), unit("PYLON", 3), unit("GATEWAY", 4),
                   unit("ASSIMILATOR", 5))
    state["hud"].update(minerals=250, vespene=0, supply_workers=25, supply_left=10)
    state["opening_next_cost"] = dict(action="build_cyberneticscore", minerals=150, vespene=0)
    state["action_costs"] = {"train_zealot": dict(minerals=100, vespene=0)}
    # Both are affordable together, but the due tech's input must happen first.
    assert executor.choose_action(order(composition={"ZEALOT": 6}), state,
        {"build_cyberneticscore", "train_zealot"}, 160) == "build_cyberneticscore"
    assert executor.opening_decision.next_action == "build_cyberneticscore"
    assert executor.opening_decision.delay_seconds == 44


def test_due_second_gas_precedes_warpgate_without_stopping_probe_upkeep():
    executor = replay_opening_executor()
    state = opening_report(unit("NEXUS", is_idle=True), unit("NEXUS", 2), unit("PYLON", 3), unit("GATEWAY", 4),
                   unit("ASSIMILATOR", 5), unit("CYBERNETICSCORE", 6))
    state["hud"].update(minerals=150, vespene=100, supply_workers=25, supply_left=10)
    state["group_production_candidates"] = ["train_probe"]
    command = order(worker_target=44)
    legal = {"build_assimilator", "research_warpgateresearch", "train_probe"}
    assert executor.choose_action(command, state, legal, 125) == "train_probe"
    assert executor.choose_action(command, state, legal - {"train_probe"}, 126) == "build_assimilator"


@pytest.mark.parametrize("research", ["WARPGATERESEARCH", "BLINKTECH"])
def test_upgrade_cannot_spend_late_opening_nexus_budget(research):
    executor = replay_opening_executor()
    state = opening_report(unit("NEXUS"), unit("PYLON", 2), unit("GATEWAY", 3), unit("CYBERNETICSCORE", 4),
                   unit("TWILIGHTCOUNCIL", 5))
    state["hud"].update(minerals=425, vespene=100, supply_workers=22, supply_left=10)
    action = "research_" + research.lower()
    state["opening_next_cost"] = dict(action="build_nexus", minerals=400, vespene=0)
    state["action_costs"] = {action: dict(minerals=50, vespene=50)}
    command = order(research=(research,))
    assert executor.choose_action(command, state, {action}, 146) == "no_op"
    state["hud"]["minerals"] = 500
    assert executor.choose_action(command, state, {action}, 147) == action


def test_visible_threat_releases_optional_army_reservation_for_late_opening():
    executor = replay_opening_executor()
    state = opening_report(unit("NEXUS"), unit("PYLON", 2), unit("GATEWAY", 3))
    state["hud"].update(minerals=350, vespene=0)
    state["opening_next_cost"] = dict(action="build_nexus", minerals=400, vespene=0)
    state["action_costs"] = {"train_zealot": dict(minerals=100, vespene=0)}
    command = order(composition={"ZEALOT": 2})
    assert executor.choose_action(command, state, {"train_zealot"}, 146) == "no_op"
    state["current_enemies"] = [unit("MARINE", 90)]
    assert executor.choose_action(command, state, {"train_zealot"}, 147) == "train_zealot"
    assert executor.opening_decision.status == "suspended"


def test_opening_rejected_construction_does_not_unlock_next_gas():
    executor = replay_opening_executor()
    state = opening_report(unit("NEXUS"), unit("PYLON", 2), unit("GATEWAY", 3))
    command = order(gas_workers_per_base=6)
    legal = {"build_nexus", "build_assimilator"}
    assert executor.choose_action(command, state, legal, 110) == "no_op"
    assert executor.opening_decision.next_action == "build_nexus"
    executor.record_action("build_nexus", 110, False)
    assert executor.choose_action(command, state, legal, 111) == "no_op"
    assert executor.opening_decision.next_action == "build_nexus"


def test_executor_forwards_actual_construction_base_for_opening_credit():
    executor = replay_opening_executor()
    state = opening_report(unit("NEXUS"))
    assert executor.choose_action(order(), state, {"build_pylon"}, 33) == "build_pylon"
    executor.record_action("build_pylon", 33, True, base_index=1)
    assert executor.opening.summary()["completed_steps"] == 0
    executor.record_action("build_pylon", 34, True)
    assert executor.opening.summary()["completed_steps"] == 0
    executor.record_action("build_pylon", 35, True, base_index=0)
    assert executor.opening.summary()["completed_steps"] == 1


def test_opening_suspends_for_visible_defense_and_explicit_scouting_override():
    executor = replay_opening_executor()
    state = opening_report(unit("NEXUS"), current_enemies=[unit("MARINE")])
    assert executor.choose_action(order(), state, {"attack_visible_enemy", "build_pylon"}, 34) == "attack_visible_enemy"
    assert executor.opening_decision.status == "suspended"
    assert executor.opening.summary()["completed_steps"] == 0
    state["current_enemies"] = []
    state["opening_suspended"] = True
    executor.choose_action(order(), state, set(), 35)
    assert executor.opening_decision.status == "suspended"


@pytest.mark.parametrize("now", [-1, float("nan"), float("inf"), True])
def test_invalid_times_rejected(now):
    with pytest.raises(ValueError):
        choose(None, report(), now=now)


def upgrade_state():
    state = report(unit("NEXUS"), unit("FORGE", 2), unit("GATEWAY", 3))
    state["hud"].update(minerals=600, vespene=400, supply_workers=44, supply_left=30, supply_cap=100)
    state["action_costs"] = {"research_protossgroundweaponslevel1": dict(minerals=100, vespene=100),
                             "research_protossgroundarmorslevel1": dict(minerals=100, vespene=100),
                             "train_stalker": dict(minerals=125, vespene=50)}
    return state


def test_requested_upgrade_gets_bounded_turn_before_permanent_army_shortage():
    executor = CoachExecutor()
    command = order(composition={"STALKER": 24}, research=("PROTOSSGROUNDWEAPONSLEVEL1",))
    state = upgrade_state()
    legal = {"train_stalker", "research_protossgroundweaponslevel1"}
    assert executor.choose_action(command, state, legal, 600) == "research_protossgroundweaponslevel1"
    executor.record_action("research_protossgroundweaponslevel1", 600, True)
    assert executor.choose_action(command, state, legal, 601) == "train_stalker"
    assert executor.choose_action(command, state, legal, 620) == "research_protossgroundweaponslevel1"


def test_rejected_research_does_not_spend_priority_slot():
    executor = CoachExecutor()
    command = order(composition={"STALKER": 24}, research=("PROTOSSGROUNDWEAPONSLEVEL1",))
    legal = {"train_stalker", "research_protossgroundweaponslevel1"}
    executor.record_action("research_protossgroundweaponslevel1", 600, False)
    assert executor.choose_action(command, upgrade_state(), legal, 601) == "research_protossgroundweaponslevel1"


@pytest.mark.parametrize("case", ["unknown_price", "no_reserve", "current_combat", "pending", "completed"])
def test_research_priority_requires_current_cost_reserve_and_no_conflicting_evidence(case):
    state = upgrade_state()
    command = order(composition={"STALKER": 24}, research=("PROTOSSGROUNDWEAPONSLEVEL1",))
    if case == "unknown_price":
        del state["action_costs"]["research_protossgroundweaponslevel1"]
    elif case == "no_reserve":
        state["hud"]["minerals"] = 200
    elif case == "current_combat":
        state["current_enemies"] = [unit("MARINE", 50)]
    elif case == "pending":
        state["current_own"][1]["orders"] = [{"researches": "PROTOSSGROUNDWEAPONSLEVEL1"}]
    else:
        state["upgrades"] = ["PROTOSSGROUNDWEAPONSLEVEL1"]
    assert choose(command, state, "train_stalker", "research_protossgroundweaponslevel1", now=600) == "train_stalker"


def test_urgent_supply_and_probe_continue_before_optional_upgrade():
    state = upgrade_state()
    state["hud"]["supply_left"] = 0
    command = order(worker_target=66, composition={"STALKER": 24}, research=("PROTOSSGROUNDWEAPONSLEVEL1",))
    assert choose(command, state, "build_pylon", "train_stalker", "research_protossgroundweaponslevel1", now=600) == "build_pylon"
    state["hud"].update(supply_left=30, supply_workers=8)
    state["current_own"][0]["is_idle"] = True
    assert choose(command, state, "train_probe", "train_stalker", "research_protossgroundweaponslevel1", now=600) == "train_probe"


def test_research_priority_does_not_cut_into_active_replay_opening():
    executor = replay_opening_executor()
    state = upgrade_state()
    command = order(composition={"STALKER": 24}, research=("PROTOSSGROUNDWEAPONSLEVEL1",))
    assert executor.choose_action(command, state, {"train_stalker", "research_protossgroundweaponslevel1"}, 75) == "train_stalker"
