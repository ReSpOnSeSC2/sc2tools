"""Conservative, observation-only supplemental Protoss action masks.

This is static producer compatibility plus current mineral/gas evidence,
not execution permission. Training can enqueue while supply-blocked and while
the selected panel omits its ability, so neither is negative eligibility evidence.
Intersect with existing masks; preserve EOS externally.
No game requests, labels, commands, learned parameters or observation edits.
"""
from __future__ import annotations

from collections.abc import Mapping
from dataclasses import asdict, dataclass
import math

from .policy_intents import PredictionError, _rows, canonical_sha256

SCHEMA = "protoss-action-eligibility-v2"
_FRAME_KEYS = {"schema", "game_loop", "camera", "hud", "alerts", "entities", "known_own", "selection",
               "selection_complete", "ui", "spatial", "available_abilities", "feature_layers", "own_upgrades",
               "known_neutral", "intervening_selection_input"}


class EligibilityError(ValueError):
    pass


@dataclass(frozen=True)
class CommandRule:
    name: str
    ability: int
    product_id: int
    product_name: str
    producer_id: int
    producer_name: str
    family: str
    target: int
    train: bool = False
    minerals: int = 0
    gas: int = 0
    supply: int = 0


# IDs, products, command families and costs are checked against native RequestData.
# Producer membership is an explicit reviewed public game rule, not inferred
# from a target's tech prerequisite or a unit's own creation ability.
RULES = (
    CommandRule("Train_Probe_quick", 1006, 84, "Probe", 59, "Nexus", "NexusTrain", 1, True, 50, 0, 1),
    CommandRule("Train_Zealot_quick", 916, 73, "Zealot", 62, "Gateway", "GatewayTrain", 1, True, 100, 0, 2),
    CommandRule("Train_Stalker_quick", 917, 74, "Stalker", 62, "Gateway", "GatewayTrain", 1, True, 125, 50, 2),
    CommandRule("Train_Adept_quick", 922, 311, "Adept", 62, "Gateway", "GatewayTrain", 1, True, 100, 25, 2),
    CommandRule("Train_Sentry_quick", 921, 77, "Sentry", 62, "Gateway", "GatewayTrain", 1, True, 50, 100, 2),
    CommandRule("Build_Pylon_pt", 881, 60, "Pylon", 84, "Probe", "ProtossBuild", 2),
    CommandRule("Build_Gateway_pt", 883, 62, "Gateway", 84, "Probe", "ProtossBuild", 2),
    CommandRule("Build_Nexus_pt", 880, 59, "Nexus", 84, "Probe", "ProtossBuild", 2),
    CommandRule("Build_Assimilator_unit", 882, 61, "Assimilator", 84, "Probe", "ProtossBuild", 3),
    CommandRule("Build_CyberneticsCore_pt", 894, 72, "CyberneticsCore", 84, "Probe", "ProtossBuild", 2),
)


def _positive(value):
    return type(value) is int and value > 0


def _number(value):
    return (not isinstance(value, bool) and isinstance(value, (int, float))
            and math.isfinite(value) and value >= 0)


def _ability_aliases(abilities, rule):
    canonical = abilities.get(str(rule.ability))
    if (not isinstance(canonical, Mapping) or canonical.get("id") != rule.ability
            or canonical.get("name") != rule.family or canonical.get("target") != rule.target
            or canonical.get("remaps_to_ability_id", 0) != 0
            or canonical.get("native", {}).get("ability_id") != rule.ability
            or canonical.get("native", {}).get("link_name") != rule.family
            or canonical.get("native", {}).get("target") != rule.target):
        raise EligibilityError(f"Reviewed native ability contract changed: {rule.name}")
    aliases = {rule.ability}
    # Only explicit native remap edges establish equivalence. Shared family,
    # button labels and nearby IDs never establish aliases (e.g. WarpInAdept).
    while True:
        new = set()
        for key, value in abilities.items():
            if not isinstance(value, Mapping) or value.get("remaps_to_ability_id", 0) not in aliases:
                continue
            candidate = value.get("id")
            native = value.get("native", {})
            if (not _positive(candidate) or str(candidate) != key or value.get("target") != rule.target
                    or native.get("ability_id") != candidate or native.get("target") != rule.target
                    or native.get("remaps_to_ability_id", 0) != value.get("remaps_to_ability_id")):
                raise EligibilityError(f"Invalid native alias for reviewed command: {rule.name}")
            new.add(candidate)
        if new <= aliases:
            return sorted(aliases)
        aliases.update(new)


def validate_public_rules(registry, catalog):
    """Validate reviewed metadata; unknown vocabulary rows remain unrestricted."""
    if (not isinstance(registry, list) or not registry or not isinstance(catalog, Mapping)
            or not isinstance(catalog.get("units"), Mapping) or not isinstance(catalog.get("abilities"), Mapping)):
        raise EligibilityError("Require native public units/abilities and ordered function registry")
    if any(not isinstance(row, Mapping) or type(row.get("id")) is not int or row["id"] != index
           or not isinstance(row.get("name"), str) for index, row in enumerate(registry)):
        raise EligibilityError("Function IDs must be a contiguous ordered vocabulary")
    by_name = {row["name"]: row for row in registry}
    if len(by_name) != len(registry):
        raise EligibilityError("Duplicate function names are ambiguous")
    validated = []
    for rule in RULES:
        row = by_name.get(rule.name)
        if row is None:
            continue
        args = ["queued", "unit_tags"] + ({1: [], 2: ["world"], 3: ["target_unit_tag"]}[rule.target])
        if row.get("ability_id") != rule.ability or row.get("general_id", 0) != 0 or row.get("args") != args:
            raise EligibilityError(f"Reviewed function or ability identity changed: {rule.name}")
        units = catalog["units"]
        for unit_id, name in ((rule.producer_id, rule.producer_name), (rule.product_id, rule.product_name)):
            unit = units.get(str(unit_id), {})
            if (unit.get("unit_id") != unit_id or unit.get("name") != name or unit.get("race") != 3
                    or unit.get("available") is not True):
                raise EligibilityError(f"Reviewed public Protoss unit changed: {name}")
        product = units[str(rule.product_id)]
        if product.get("ability_id") != rule.ability:
            raise EligibilityError(f"Reviewed product creation ability changed: {rule.product_name}")
        if rule.train and (product.get("mineral_cost") != rule.minerals or product.get("vespene_cost") != rule.gas
                           or product.get("food_required") != rule.supply):
            raise EligibilityError(f"Reviewed immediate train costs changed: {rule.product_name}")
        validated.append((row, rule, _ability_aliases(catalog["abilities"], rule)))
    return validated


def _public_type(row, catalog):
    unit_id, name = row.get("type_id"), row.get("type_name")
    if not _positive(unit_id) or not isinstance(name, str) or name.upper() == "UNKNOWN":
        return None
    public = catalog["units"].get(str(unit_id))
    if not isinstance(public, Mapping) or not public.get("name"):
        return None
    if public.get("unit_id") != unit_id or name.upper() != public["name"].upper():
        raise EligibilityError("Observed unit type contradicts public type identity")
    return unit_id


def _selection_evidence(frame, current, catalog):
    result = {"used": False, "selected_tag": None, "reason": "not_exact_complete_single_current_own_selection"}
    selection = frame.get("selection")
    if (frame.get("selection_complete") is not True or not isinstance(selection, list) or len(selection) != 1
            or not _positive(selection[0]) or selection[0] not in current
            or current[selection[0]].get("owner") != 1
            or {tag for tag, row in current.items() if row.get("is_selected") is True} != set(selection)
            or frame.get("intervening_selection_input") is True):
        return result, None
    available = frame.get("available_abilities")
    if not isinstance(available, list):
        result["reason"] = "available_abilities_missing"
        return result, None
    values = []
    for item in available:
        ability = item.get("ability_id") if isinstance(item, Mapping) else None
        if not _positive(ability) or str(ability) not in catalog["abilities"]:
            result["reason"] = "available_ability_identity_unknown"
            return result, None
        values.append(ability)
    result.update(used=True, selected_tag=selection[0], reason="current_native_UI_negative_for_immediate_train_only",
                  available_ability_ids=sorted(set(values)))
    return result, set(values)


def build_action_eligibility(frame, entity_tags, registry, catalog, *, max_entities=512):
    """Return supplemental function[F] and source[F,E] masks with audit reasons.

``entity_tags`` must equal the frozen tensorizer's exact current+memory ordering.
Unknown functions/types and padded columns remainTrue. EOS is NOT in the source
matrix; appendTrue externally before intersecting existing recurrent masks.
Remembered rows contribute only owner/type identity; no stale dynamic fields.
"""
    if (not isinstance(frame, Mapping) or frame.get("schema") != "protoss-rich-replay-v1"
            or set(frame) - _FRAME_KEYS):
        raise EligibilityError("Require observation-only rich frame; labels and unknown frame fields are forbidden")
    if type(max_entities) is not int or not 2 <= max_entities <= 512:
        raise EligibilityError("Invalid bounded entity capacity")
    reviewed = validate_public_rules(registry, catalog)
    try:
        current, memory = _rows(frame)
    except PredictionError as exc:
        raise EligibilityError(str(exc)) from exc
    expected = sorted(current) + sorted(memory)
    if (not isinstance(entity_tags, list) or entity_tags != expected or len(expected) > max_entities
            or any(not _positive(tag) for tag in entity_tags)):
        raise EligibilityError("Entity sidecar differs from exact permitted observation order")
    entities = {**memory, **current}
    unit_types = {tag: _public_type(row, catalog) for tag, row in entities.items()}
    ui, _ = _selection_evidence(frame, current, catalog)
    ui["valid_single_selection"] = ui["used"]
    ui["used"] = False
    ui["informational_only"] = True
    if ui["valid_single_selection"]:
        ui["reason"] = "current_native_UI_presence_does_not_prove_queue_ineligibility"
    function_mask = [True] * len(registry)
    sources = [[True] * max_entities for _ in registry]
    records = []
    hud = frame.get("hud") if isinstance(frame.get("hud"), Mapping) else {}
    for function, rule, aliases in reviewed:
        index = function["id"]
        reasons, blocked = [], {}
        for pointer, tag in enumerate(entity_tags):
            row = entities[tag]
            if row.get("owner") != 1:
                blocked[pointer] = "not_own_producer"
            elif unit_types[tag] is not None and unit_types[tag] != rule.producer_id:
                blocked[pointer] = "known_incompatible_producer_type"
            if pointer in blocked:
                sources[index][pointer] = False
        if not any(sources[index][pointer] for pointer in range(len(entity_tags))):
            reasons.append("no_compatible_known_or_unknown_own_producer")
        affordability = {}
        if rule.train:
            for field, cost in (("minerals", rule.minerals), ("vespene", rule.gas)):
                value = hud.get(field)
                affordability[field] = {"known": _number(value), "required": cost}
                if _number(value):
                    affordability[field]["observed"] = value
                    if value < cost:
                        reasons.append(f"current_HUD_insufficient_{field}")
            used, cap = hud.get("food_used"), hud.get("food_cap")
            known = _number(used) and _number(cap)
            affordability["supply"] = {"known": known, "required": rule.supply}
            if known:
                affordability["supply"]["observed_free"] = cap - used
            affordability["supply"]["used_for_eligibility"] = False
        function_mask[index] = not reasons
        records.append({"id": index, "name": rule.name, "ability_id": rule.ability, "aliases": aliases,
                        "producer_types": [{"id": rule.producer_id, "name": rule.producer_name}],
                        "function_allowed": function_mask[index], "function_reasons": reasons,
                        "blocked_source_indices": sorted(blocked), "source_reasons": blocked,
                        "affordability": affordability, "current_train_checks": rule.train})
    return {"schema": SCHEMA, "function_mask": function_mask, "source_masks": sources,
            "entity_tags": list(entity_tags), "max_entities": max_entities, "source_eos_included": False,
            "source_padding_passthrough": True, "reviewed_functions": records, "ui_negative_evidence": ui,
            "catalog_sha256": canonical_sha256(catalog), "registry_sha256": canonical_sha256(registry),
            "observation_sha256": canonical_sha256(frame), "rules_sha256": canonical_sha256({"commands": [asdict(rule) for rule in RULES],
                "mask_policy": {"producer_compatibility": True, "train_mineral_gas": True,
                                "train_supply_negative": False, "train_UI_negative": False}}),
            "read_scope": {"observation_only": True, "memory_dynamic_fields_used": False,
                           "hidden_state_used": False, "build_affordability_or_UI_negative_used": False,
                           "train_supply_negative_used": False, "train_UI_negative_used": False,
                           "training_queue_may_accept_supply_blocked_or_UI_absent_ability": True,
                           "source_eos": "preserve existing recurrent EOS; appendTrue outside this module",
                           "execution_authorized": False, "action_substitution": False}}
