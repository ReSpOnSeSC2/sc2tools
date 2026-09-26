"""Observation boundaries and conservative supplemental action eligibility."""
from copy import deepcopy

import pytest

from pluto_sc2.action_eligibility_v2 import (
    RULES, EligibilityError, build_action_eligibility, validate_public_rules,
)


def catalog_registry():
    units, abilities = {}, {}
    for rule in RULES:
        units.setdefault(str(rule.producer_id), {"unit_id": rule.producer_id,
            "name": rule.producer_name, "race": 3, "available": True})
        units.setdefault(str(rule.product_id), {}).update(unit_id=rule.product_id, name=rule.product_name,
            race=3, available=True, ability_id=rule.ability)
        if rule.train:
            units[str(rule.product_id)].update(mineral_cost=rule.minerals, vespene_cost=rule.gas,
                                                food_required=float(rule.supply))
        abilities[str(rule.ability)] = {"id": rule.ability, "name": rule.family,
            "target": rule.target, "remaps_to_ability_id": 0,
            "native": {"ability_id": rule.ability, "link_name": rule.family, "target": rule.target}}
    units["133"] = {"unit_id": 133, "name": "WarpGate", "race": 3, "available": True, "tech_alias": [62]}
    registry = [{"id": index, "name": rule.name, "ability_id": rule.ability, "general_id": 0,
                 "args": ["queued", "unit_tags"] + {1: [], 2: ["world"], 3: ["target_unit_tag"]}[rule.target]}
                for index, rule in enumerate(RULES)]
    registry.append({"id": len(registry), "name": "Unreviewed_TrainOrSpell", "ability_id": 999,
                     "general_id": 0, "args": ["queued", "unit_tags"]})
    return {"units": units, "abilities": abilities}, registry


def unit(tag, type_id, *, owner=1, selected=False):
    names = {59: "Nexus", 84: "Probe", 62: "Gateway", 74: "Stalker", 133: "WarpGate", 9999: "UNKNOWN"}
    return {"tag": tag, "owner": owner, "type_id": type_id, "type_name": names[type_id],
            "position": [50, 50], "is_visible": True, "is_on_screen": True,
            "is_selected": selected, "cloak_state": 3}


def frame(*entities, memory=()):
    return {"schema": "protoss-rich-replay-v1", "game_loop": 100, "camera": [50, 50],
            "entities": list(entities), "known_own": list(memory), "known_neutral": [],
            "hud": {"minerals": 500, "vespene": 500, "food_cap": 100, "food_used": 20},
            "selection": [], "selection_complete": False, "available_abilities": [],
            "spatial": {"map_size": [100, 100], "camera_width": 24, "camera_height": 24,
                        "screen_visibility": [[2] * 16 for _ in range(16)]}}


def remember(row):
    return {key: value for key, value in {**row, "last_seen_loop": 80}.items()
            if key in {"tag", "owner", "type_id", "type_name", "position", "last_seen_loop"}}


def evaluate(observation, *, catalog=None, registry=None, tags=None):
    c, r = catalog_registry()
    if tags is None:
        current = {row["tag"] for row in observation["entities"]}
        tags = sorted(current) + sorted(row["tag"] for row in observation["known_own"] if row["tag"] not in current)
    return build_action_eligibility(observation, tags, registry or r, catalog or c, max_entities=16)


def idx(name):
    return next(index for index, rule in enumerate(RULES) if rule.name == name)


def select(observation, tag):
    observation.update(selection=[tag], selection_complete=True)
    for row in observation["entities"]:
        row["is_selected"] = row["tag"] == tag


@pytest.mark.parametrize("name,producer,before,after,ability", [
    ("Train_Probe_quick", 59, {"minerals": 95, "vespene": 0, "food_used": 13, "food_cap": 13},
     {"minerals": 45, "vespene": 0, "food_used": 13, "food_cap": 13}, 1006),
    ("Train_Stalker_quick", 62, {"minerals": 150, "vespene": 72, "food_used": 20, "food_cap": 21},
     {"minerals": 25, "vespene": 22, "food_used": 20, "food_cap": 21}, 917),
])
def test_native_accepted_supply_blocked_queue_regressions(name, producer, before, after, ability):
    """Replay210 and794 enqueue despite absent selected-panel ability and supply.

210: loop1015/1016 Nexus oneProbe;1017 twoProbes and50minerals spent.
794: loop3452 Gatewayidle;3453 Stalkerqueued and125min/50gas spent;
     supply remains20/21 until later Pylon completes. These are actual accepted
     queue transitions, not assumed legality from build order labels alone.
"""
    observed = frame(unit(1, producer))
    observed["game_loop"] = 1015 if ability == 1006 else 3452
    observed["hud"] = dict(before)
    observed["entities"][0]["orders"] = [{"ability_id": 1006}] if ability == 1006 else []
    select(observed, 1)
    observed["available_abilities"] = []
    saved = deepcopy(observed)
    decision = evaluate(observed)
    index = idx(name)
    assert decision["schema"] == "protoss-action-eligibility-v2"
    assert decision["function_mask"][index] and decision["source_masks"][index][0]
    assert decision["reviewed_functions"][index]["function_reasons"] == []
    assert not decision["reviewed_functions"][index]["affordability"]["supply"]["used_for_eligibility"]
    assert decision["ui_negative_evidence"]["valid_single_selection"]
    assert decision["ui_negative_evidence"]["used"] is False
    assert observed == saved  # Later spending/queue state was not passed to eligibility.
    following = deepcopy(observed)
    following["hud"] = after
    following["entities"][0]["orders"].append({"ability_id": ability})
    assert len(following["entities"][0]["orders"]) == (2 if ability == 1006 else 1)
    assert following["hud"]["minerals"] < before["minerals"]
    assert not evaluate(following)["function_mask"][index]  # Spending prevents another immediate purchase.


def test_ordinal2285_supply_shortage_is_not_illegality_without_visible_queue():
    observed = frame(memory=[remember(unit(1, 62))])
    observed["hud"] = {"minerals": 100, "vespene": 0, "food_used": 126, "food_cap": 127}
    # Observed100 mineral spend after action is consistent with acceptance;
    # source was offscreen, so this test makes no fresh production-queue claim.
    result = evaluate(observed)
    assert result["function_mask"][idx("Train_Zealot_quick")]
    assert result["source_masks"][idx("Train_Zealot_quick")][0]
    assert not result["read_scope"]["memory_dynamic_fields_used"]


def test_static_producer_rules_and_unknown_passthrough_preserve_all_shapes():
    observed = frame(unit(1, 59), unit(2, 84), unit(3, 62), unit(4, 133), unit(5, 9999))
    result = evaluate(observed)
    for index, rule in enumerate(RULES):
        wanted = {59: 0, 84: 1, 62: 2}[rule.producer_id]
        assert result["source_masks"][index][:5] == [n in (wanted, 4) for n in range(5)]
        assert result["source_masks"][index][5:] == [True] * 11
        assert result["function_mask"][index]
    assert all(result["source_masks"][-1]) and result["function_mask"][-1]
    assert result["source_eos_included"] is False


def test_selection_changes_and_missing_ui_do_not_change_v2_masks():
    observed = frame(unit(1, 59), unit(2, 84), memory=[remember(unit(3, 62))])
    baseline = evaluate(observed)
    for selected in (1, 2):
        select(observed, selected)
        for values in ([], [{"ability_id": 1006}], [{"ability_id": 8675309}], None):
            observed["available_abilities"] = values
            result = evaluate(observed)
            assert result["function_mask"] == baseline["function_mask"]
            assert result["source_masks"] == baseline["source_masks"]
            assert not result["ui_negative_evidence"]["used"]


def test_memory_dynamic_fields_cannot_override_static_type_compatibility():
    observed = frame(unit(1, 84), memory=[remember(unit(2, 59))])
    baseline = evaluate(observed)
    observed["known_own"][0].update(orders=[{"ability_id": 1006}] * 20, energy=0,
                                   is_powered=False, build_progress=0, is_selected=True)
    result = evaluate(observed)
    assert result["source_masks"] == baseline["source_masks"]
    assert result["function_mask"] == baseline["function_mask"]


@pytest.mark.parametrize("field,value", [("minerals", 124), ("vespene", 49)])
def test_known_current_resource_shortage_still_masks_immediate_training_only(field, value):
    observed = frame(unit(1, 62), unit(2, 84))
    observed["hud"][field] = value
    result = evaluate(observed)
    assert not result["function_mask"][idx("Train_Stalker_quick")]
    assert result["source_masks"][idx("Train_Stalker_quick")][0]
    assert result["function_mask"][idx("Build_Nexus_pt")]


@pytest.mark.parametrize("missing", [None, True, -1, "0"])
def test_unknown_resource_values_are_not_a_zero_resource_claim(missing):
    observed = frame(unit(1, 62))
    observed["hud"] = {"minerals": missing, "vespene": missing}
    assert evaluate(observed)["function_mask"][idx("Train_Stalker_quick")]


def test_public_catalog_identity_costs_and_aliases_still_fail_on_drift():
    catalog, registry = catalog_registry()
    assert len(validate_public_rules(registry, catalog)) == 10
    catalog["units"]["74"]["mineral_cost"] = 50
    with pytest.raises(EligibilityError, match="costs"):
        validate_public_rules(registry, catalog)
    catalog, registry = catalog_registry()
    catalog["abilities"]["8000"] = {"id": 8000, "remaps_to_ability_id": 1006, "target": 2,
                                     "native": {"ability_id": 8000, "target": 2, "remaps_to_ability_id": 1006}}
    with pytest.raises(EligibilityError, match="alias"):
        validate_public_rules(registry, catalog)


def test_observation_only_exact_causal_pointer_contract_unchanged():
    observed = frame(unit(4, 84), memory=[remember(unit(1, 59))])
    with pytest.raises(EligibilityError, match="sidecar"):
        evaluate(observed, tags=[1, 4])
    observed["known_own"][0]["last_seen_loop"] = 101
    with pytest.raises(EligibilityError):
        evaluate(observed)
    observed["known_own"][0]["last_seen_loop"] = 80
    observed["intent"] = {"ability_id": 1006}
    with pytest.raises(EligibilityError, match="observation-only"):
        evaluate(observed)


