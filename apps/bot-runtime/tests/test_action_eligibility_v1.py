"""Observation boundaries and conservative supplemental action eligibility."""
from copy import deepcopy

import pytest

from pluto_sc2.action_eligibility_v1 import (
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


def test_exact_public_producer_table_for_all_ten_commands_and_eos_passthrough():
    observation = frame(unit(1, 59), unit(2, 84), unit(3, 62), unit(4, 133), unit(5, 74, owner=4))
    before = deepcopy(observation)
    result = evaluate(observation)
    for index, rule in enumerate(RULES):
        wanted = {59: 0, 84: 1, 62: 2}[rule.producer_id]
        assert result["source_masks"][index][:5] == [n == wanted for n in range(5)]
        assert result["function_mask"][index]
        assert result["source_masks"][index][5:] == [True] * 11
    assert result["source_eos_included"] is False
    assert all(len(values) == 16 for values in result["source_masks"])
    assert all(result["source_masks"][-1]) and result["function_mask"][-1]
    assert observation == before


def test_selected_probe_does_not_suppress_causally_remembered_nexus():
    observation = frame(unit(1, 84), memory=[remember(unit(2, 59))])
    select(observation, 1)
    result = evaluate(observation)
    probe = idx("Train_Probe_quick")
    assert result["ui_negative_evidence"]["used"]
    assert result["source_masks"][probe][:2] == [False, True]
    assert result["function_mask"][probe]


def test_ui_negative_is_scoped_to_selected_current_producer_not_other_nexus():
    observation = frame(unit(1, 59), unit(2, 59))
    select(observation, 1)
    result = evaluate(observation)
    probe = idx("Train_Probe_quick")
    assert result["source_masks"][probe][:2] == [False, True]
    assert result["function_mask"][probe]
    observation["entities"].pop()
    result = evaluate(observation)
    assert not result["function_mask"][probe]
    assert result["reviewed_functions"][probe]["source_reasons"][0] == "selected_current_producer_ability_absent"


@pytest.mark.parametrize("kind", ["mixed", "incomplete", "memory", "inconsistent_flags", "intervening", "missing_abilities", "unknown_ability"])
def test_ui_negative_cannot_generalize_from_unreliable_selection(kind):
    observation = frame(unit(1, 59), unit(2, 84))
    select(observation, 1)
    if kind == "mixed":
        observation["selection"] = [1, 2]
        observation["entities"][1]["is_selected"] = True
    elif kind == "incomplete":
        observation["selection_complete"] = False
    elif kind == "memory":
        observation["known_own"] = [remember(observation["entities"].pop(0))]
    elif kind == "inconsistent_flags":
        observation["entities"][1]["is_selected"] = True
    elif kind == "intervening":
        observation["intervening_selection_input"] = True
    elif kind == "missing_abilities":
        observation.pop("available_abilities")
    elif kind == "unknown_ability":
        observation["available_abilities"] = [{"ability_id": 8675309}]
    result = evaluate(observation)
    assert not result["ui_negative_evidence"]["used"]
    assert result["function_mask"][idx("Train_Probe_quick")]


def test_memory_dynamic_fields_and_current_queue_energy_do_not_become_capability_evidence():
    observation = frame(unit(1, 84), memory=[remember(unit(2, 59))])
    before = evaluate(observation)
    observation["known_own"][0].update(build_progress=0, energy=0, is_powered=False,
                                      orders=[{"ability_id": 1006}] * 20, is_selected=True)
    observation["entities"][0].update(energy=0, build_progress=0, orders=[{"ability_id": 881}])
    after = evaluate(observation)
    assert after["function_mask"] == before["function_mask"]
    assert after["source_masks"] == before["source_masks"]
    assert not after["read_scope"]["memory_dynamic_fields_used"]


def test_unknown_types_and_unreviewed_functions_remain_permissive_even_with_zero_bank():
    observation = frame(unit(1, 9999))
    result = evaluate(observation)
    assert all(row[0] for row in result["source_masks"])
    assert all(result["function_mask"])
    observation["hud"].update(minerals=0, vespene=0, food_cap=20)
    result = evaluate(observation)
    assert result["function_mask"][-1] and all(result["source_masks"][-1])


@pytest.mark.parametrize("field,value,reason", [
    ("minerals", 124, "current_HUD_insufficient_minerals"),
    ("vespene", 49, "current_HUD_insufficient_vespene"),
    ("food_cap", 21, "current_HUD_insufficient_supply"),
])
def test_immediate_training_uses_only_unambiguous_current_hud_shortages(field, value, reason):
    observation = frame(unit(1, 62), unit(2, 84))
    observation["hud"][field] = value
    result = evaluate(observation)
    stalker = idx("Train_Stalker_quick")
    assert not result["function_mask"][stalker]
    assert reason in result["reviewed_functions"][stalker]["function_reasons"]
    assert result["source_masks"][stalker][0]  # Cost does not change static source compatibility.
    assert result["function_mask"][idx("Build_Nexus_pt")]


@pytest.mark.parametrize("missing", [None, True, -1, "0"])
def test_unknown_or_invalid_hud_values_are_not_observed_zero(missing):
    observation = frame(unit(1, 62))
    observation["hud"] = {name: missing for name in ("minerals", "vespene", "food_cap", "food_used")}
    assert evaluate(observation)["function_mask"][idx("Train_Stalker_quick")]


def test_planned_construction_never_uses_current_bank_or_selected_ui_absence():
    observation = frame(unit(1, 84))
    select(observation, 1)
    observation["hud"] = {"minerals": 0, "vespene": 0, "food_cap": 0, "food_used": 200}
    result = evaluate(observation)
    for rule in RULES:
        if not rule.train:
            index = idx(rule.name)
            assert result["function_mask"][index] and result["source_masks"][index][0]
            assert result["reviewed_functions"][index]["affordability"] == {}


def test_only_explicit_valid_native_remap_aliases_satisfy_selected_ability():
    catalog, registry = catalog_registry()
    catalog["abilities"]["8000"] = {"id": 8000, "name": "DifferentPublicAliasName", "target": 1,
        "remaps_to_ability_id": 1006, "native": {"ability_id": 8000, "target": 1, "remaps_to_ability_id": 1006}}
    observation = frame(unit(1, 59))
    select(observation, 1)
    observation["available_abilities"] = [{"ability_id": 8000}]
    assert evaluate(observation, catalog=catalog, registry=registry)["function_mask"][idx("Train_Probe_quick")]
    # Similar names alone are not ability equivalence.
    catalog["abilities"]["8000"]["remaps_to_ability_id"] = 0
    assert not evaluate(observation, catalog=catalog, registry=registry)["function_mask"][idx("Train_Probe_quick")]
    catalog["abilities"]["8000"]["remaps_to_ability_id"] = 1006
    catalog["abilities"]["8000"]["native"]["target"] = 2
    with pytest.raises(EligibilityError, match="alias"):
        evaluate(observation, catalog=catalog, registry=registry)


@pytest.mark.parametrize("mutate", [
    lambda c, r: c["units"]["74"].__setitem__("mineral_cost", 50),
    lambda c, r: c["units"]["62"].__setitem__("name", "WarpGate"),
    lambda c, r: c["units"]["84"].__setitem__("ability_id", 999),
    lambda c, r: c["abilities"]["922"]["native"].__setitem__("link_name", "WarpGateTrain"),
    lambda c, r: r[0].__setitem__("ability_id", 921),
    lambda c, r: r[0].__setitem__("general_id", 999),
])
def test_public_cost_type_or_alias_drift_fails_closed(mutate):
    catalog, registry = catalog_registry()
    validate_public_rules(registry, catalog)
    mutate(catalog, registry)
    with pytest.raises(EligibilityError):
        validate_public_rules(registry, catalog)


def test_causal_memory_and_exact_sidecar_are_required_and_labels_are_forbidden():
    observation = frame(unit(4, 84), memory=[remember(unit(1, 59))])
    with pytest.raises(EligibilityError, match="sidecar"):
        evaluate(observation, tags=[1, 4])
    observation["known_own"][0]["last_seen_loop"] = 101
    with pytest.raises(EligibilityError):
        evaluate(observation)
    observation["known_own"][0]["last_seen_loop"] = 80
    observation["labels"] = {"function": 64}
    with pytest.raises(EligibilityError, match="observation-only"):
        evaluate(observation)
