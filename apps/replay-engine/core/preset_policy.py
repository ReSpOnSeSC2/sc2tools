"""Versioned, data-only replacements for released preset decision trees.

Custom builds retain precedence. Replacements are evaluated by (priority,
name); a replaced released label cannot bypass its replacement on failure.
The recorded clock is explicit: units/upgrades finish, ordinary buildings
start. Completion conditions are therefore restricted to units/upgrades.
No expression evaluation, imports, URLs or executable policy fields exist.
"""
from __future__ import annotations

import copy
import hashlib
import json
import math
from contextlib import contextmanager
from contextvars import ContextVar
from typing import Any

from .build_definitions import BUILD_DEFINITIONS, PROXY_ELIGIBLE_BUILDINGS, PRESET_SURFACES
from .build_durations import to_start_seconds
from .strategy_detector_helpers import _is_start_event, unit_prereq_met

SCHEMA_VERSION = 1
EVALUATOR_VERSION = 1
MAX_ENTRIES = 512


def policy_hash(value: dict) -> str:
    payload = {key: val for key, val in value.items() if key != "hash"}
    wire = json.dumps(payload, ensure_ascii=False, sort_keys=True, separators=(",", ":"))
    return hashlib.sha256(wire.encode("utf-8")).hexdigest()


def _keys(value, required, optional=()):
    if not isinstance(value, dict) or set(value) - set(required) - set(optional) or set(required) - set(value):
        raise ValueError("invalid_policy_fields")


def _integer(value, minimum=0, maximum=86400):
    if not isinstance(value, int) or isinstance(value, bool) or not minimum <= value <= maximum:
        raise ValueError("invalid_policy_integer")


def _text(value, maximum, minimum=0):
    # ASCII entity identifiers below keep canonical JSON hashes identical in
    # JS/Python, including surrogate handling. Prose permits Unicode scalars.
    if not isinstance(value, str) or not minimum <= len(value) <= maximum or any(0xD800 <= ord(c) <= 0xDFFF for c in value):
        raise ValueError("invalid_policy_text")


def validate_policy(value: Any, verify_hash=True) -> dict:
    _keys(value, ("schemaVersion", "evaluatorVersion", "revision", "entries"), ("hash",))
    if type(value["schemaVersion"]) is not int or type(value["evaluatorVersion"]) is not int or value["schemaVersion"] != SCHEMA_VERSION or value["evaluatorVersion"] != EVALUATOR_VERSION:
        raise ValueError("incompatible_policy")
    _integer(value["revision"], maximum=2147483647)
    entries = value["entries"]
    if not isinstance(entries, list) or len(entries) > MAX_ENTRIES:
        raise ValueError("invalid_policy_entries")
    seen = set()
    total_conditions = 0
    for entry in entries:
        _keys(entry, ("name", "priority", "enabled", "anyOf"), ("description", "steps", "mode"))
        name = entry["name"]
        if not isinstance(name, str) or name not in BUILD_DEFINITIONS or name in seen:
            raise ValueError("unknown_or_duplicate_preset")
        seen.add(name)
        _integer(entry["priority"], maximum=1000000)
        if not isinstance(entry["enabled"], bool):
            raise ValueError("invalid_policy_enabled")
        if "description" in entry:
            _text(entry["description"], 4000)
        if "steps" in entry:
            if not isinstance(entry["steps"], list) or len(entry["steps"]) > 200:
                raise ValueError("invalid_policy_steps")
            for step in entry["steps"]:
                _keys(step, ("timeSeconds", "action"), ("supply",))
                _integer(step["timeSeconds"])
                _text(step["action"], 280, 1)
                if "supply" in step:
                    _integer(step["supply"], maximum=200)
        groups = entry["anyOf"]
        if "mode" in entry and entry["mode"] not in ("replacement", "released"):
            raise ValueError("invalid_policy_mode")
        if entry.get("mode") == "released" and (entry["enabled"] is not True or not isinstance(groups, list) or len(groups) != 0):
            raise ValueError("invalid_released_policy")
        if not isinstance(groups, list) or len(groups) > 8 or entry["enabled"] and entry.get("mode") != "released" and not groups:
            raise ValueError("invalid_policy_alternatives")
        for conditions in groups:
            if not isinstance(conditions, list) or not 1 <= len(conditions) <= 30:
                raise ValueError("invalid_policy_conditions")
            total_conditions += len(conditions)
            if total_conditions > 4096:
                raise ValueError("policy_too_complex")
            for condition in conditions:
                _validate_condition(condition)
    if len(json.dumps(value, ensure_ascii=False, separators=(",", ":")).encode("utf-8")) > 1048576:
        raise ValueError("policy_too_large")
    expected = policy_hash(value)
    if verify_hash and value.get("hash") != expected:
        raise ValueError("policy_hash_mismatch")
    return {**copy.deepcopy(value), "hash": expected}


def _validate_condition(rule):
    if not isinstance(rule, dict):
        raise ValueError("invalid_policy_condition")
    kind = rule.get("kind")
    if kind in ("count", "exists"):
        _keys(rule, ("kind", "name", "category", "clock", "beforeSeconds"), ("min", "max", "proxy"))
        _identifier(rule["name"])
        _integer(rule["beforeSeconds"])
        if kind == "exists" and ("min" in rule or "max" in rule):
            raise ValueError("invalid_policy_count")
        if kind == "count" and "min" not in rule and "max" not in rule:
            raise ValueError("missing_policy_count")
        for key in ("min", "max"):
            if key in rule:
                _integer(rule[key], maximum=1000)
        if rule.get("min", 0) > rule.get("max", 1000):
            raise ValueError("invalid_policy_count")
        if "proxy" in rule and (rule["proxy"] is not True or rule["category"] != "building" or rule["name"] not in PROXY_ELIGIBLE_BUILDINGS):
            raise ValueError("invalid_policy_proxy")
    elif kind in ("order", "first"):
        _keys(rule, ("kind", "names", "category", "clock"), ("allowTies",) if kind == "first" else ())
        if "allowTies" in rule and not isinstance(rule["allowTies"], bool):
            raise ValueError("invalid_policy_order")
        names = rule["names"]
        if not isinstance(names, list) or not 2 <= len(names) <= 8 or any(not isinstance(name, str) for name in names) or len(set(names)) != len(names):
            raise ValueError("invalid_policy_order")
        for name in names:
            _identifier(name)
    else:
        raise ValueError("unknown_policy_condition")
    if rule["category"] not in ("building", "unit", "upgrade") or rule["clock"] not in ("start", "completion", "recorded"):
        raise ValueError("invalid_policy_clock")
    if rule["clock"] == "completion" and rule["category"] == "building":
        raise ValueError("building_completion_unavailable")
    if kind == "count" and rule["category"] == "building" and rule["clock"] == "recorded":
        raise ValueError("building_recorded_count_ambiguous")


def _identifier(value):
    if not isinstance(value, str) or not 1 <= len(value) <= 80 or not value.isascii() or not value.isalnum() or not value[0].isalpha():
        raise ValueError("invalid_policy_entity")


def _event_time(event, clock, eight_worker):
    recorded = event.get("time")
    if not isinstance(recorded, (int, float)) or isinstance(recorded, bool) or not math.isfinite(recorded) or recorded < 0:
        return None
    if clock in ("completion", "recorded"):
        return recorded
    return to_start_seconds(event.get("name"), recorded, is_building=event.get("type") == "building", is_upgrade=event.get("type") == "upgrade", eight_worker=eight_worker)


def _prepare(events, detector, eight_worker):
    buildings = [event for event in events if event.get("type") == "building"]
    main = detector._get_main_base_loc(buildings)
    town_halls = sorted([event for event in buildings if event.get("name") in ("Nexus", "Hatchery", "CommandCenter", "OrbitalCommand", "PlanetaryFortress")], key=lambda event: event.get("time", 0))
    main_known = bool(town_halls) and all(isinstance(town_halls[0].get(axis), (int, float)) and not isinstance(town_halls[0].get(axis), bool) and math.isfinite(town_halls[0][axis]) for axis in ("x", "y"))
    index = {}
    cache = {}
    for event in events:
        category = "unit" if event.get("type") == "worker" else event.get("type")
        moment = _event_time(event, "completion", eight_worker)
        if moment is None:
            continue
        if category == "unit" and (event.get("hallucinated") is True or not unit_prereq_met(event.get("name"), moment, buildings)):
            continue
        index.setdefault((category, event.get("name")), []).append(event)

    def times(rule, name):
        key = (rule["category"], name, rule["clock"], bool(rule.get("proxy")))
        if key not in cache:
            found = []
            for event in index.get((rule["category"], name), []):
                if rule["category"] == "building" and rule["clock"] == "start" and not _is_start_event(event) and not (event.get("time") == 0 and name in ("Nexus", "CommandCenter", "Hatchery")):
                    continue
                if rule.get("proxy"):
                    if isinstance(event.get("is_proxy"), bool):
                        proxy = event["is_proxy"]
                    elif main_known and all(isinstance(event.get(axis), (int, float)) and math.isfinite(event[axis]) for axis in ("x", "y")):
                        proxy = detector._is_canonical_proxy(event, main)
                    else:
                        # Missing geometry cannot prove a negative/max-count
                        # condition either. Fail this entire alternative.
                        cache[key] = None
                        return None
                    if not proxy:
                        continue
                found.append(_event_time(event, rule["clock"], eight_worker))
            cache[key] = found
        return cache[key]
    return times


def evaluate_conditions(conditions, events, detector, eight_worker=False, prepared=None):
    times = prepared or _prepare(events, detector, eight_worker)
    for rule in conditions:
        if rule["kind"] in ("count", "exists"):
            moments = times(rule, rule["name"])
            if moments is None:
                return False
            got = sum(moment <= rule["beforeSeconds"] for moment in moments)
            if not rule.get("min", 1 if rule["kind"] == "exists" else 0) <= got <= rule.get("max", 1000000000):
                return False
        else:
            moments = [times(rule, name) for name in rule["names"]]
            if any(value is None for value in moments):
                return False
            earliest = [min(value, default=math.inf) for value in moments]
            if rule["kind"] == "first":
                if not math.isfinite(earliest[0]) or any(earliest[0] > value if rule.get("allowTies") else earliest[0] >= value for value in earliest[1:]):
                    return False
            elif not all(math.isfinite(value) for value in earliest) or any(a >= b for a, b in zip(earliest, earliest[1:])):
                return False
    return True


def preset_scope(name):
    prefix = name.split(" - ", 1)[0]
    races = {"P": "Protoss", "T": "Terran", "Z": "Zerg"}
    if len(prefix) == 3 and prefix[1] == "v":
        return races.get(prefix[0]), races.get(prefix[2])
    return prefix, None


def apply_policy(policy, baseline, race, opponent_race, events, detector, eight_worker=False, surface="you"):
    """Apply an already validated immutable policy snapshot, after custom rules."""
    if surface not in ("you", "opponent"):
        raise ValueError("invalid_policy_surface")
    entries = sorted([entry for entry in policy["entries"] if surface in PRESET_SURFACES[entry["name"]]], key=lambda entry: (entry["priority"], entry["name"]))
    prepared = _prepare(events, detector, eight_worker) if entries else None
    for entry in entries:
        holder, partner = preset_scope(entry["name"])
        if holder != race or partner is not None and partner != opponent_race or not entry["enabled"] or entry.get("mode") == "released":
            continue
        if any(evaluate_conditions(group, events, detector, eight_worker, prepared) for group in entry["anyOf"]):
            return entry["name"]
    if any(entry["name"] == baseline and entry.get("mode") != "released" for entry in entries):
        return f"Unclassified - {race}"
    return baseline


_active = validate_policy({"schemaVersion": 1, "evaluatorVersion": 1, "revision": 0, "entries": []}, verify_hash=False)
_scoped = ContextVar("preset_policy_snapshot", default=None)


def install_policy(value):
    """Atomic snapshot swap; an invalid/unsupported policy leaves the prior one intact."""
    global _active
    validated = validate_policy(value)
    _active = validated
    return validated["hash"]


def policy_snapshot():
    return copy.deepcopy(_scoped.get() or _active)


@contextmanager
def policy_scope(value):
    """One parse/thread's policy, never a mutable process-wide user setting."""
    token = _scoped.set(validate_policy(value))
    try:
        yield
    finally:
        _scoped.reset(token)


def classification_evidence(policy, you, opponent, my_events, opp_events):
    """Small allowlisted raw-clock projection for authoritative API parity.

    Never infer completeness from truncated string build logs. An oversized or
    unsupported event makes that axis unavailable; other detection stays valid.
    """
    def axis(detector, events):
        projected = []
        complete = len(events) <= 5000
        for event in events[:5000]:
            name, category, moment = event.get("name"), event.get("type"), event.get("time")
            if (not isinstance(name, str) or not name.isascii() or not name.isalnum()
                    or not 1 <= len(name) <= 80 or not name[0].isalpha()
                    or category not in ("building", "unit", "worker", "upgrade")
                    or not isinstance(moment, (int, float)) or isinstance(moment, bool)
                    or not math.isfinite(moment) or not 0 <= moment <= 86400):
                complete = False
                continue
            value = {"name": name, "type": category, "time": moment}
            if event.get("subtype") in ("init", "born", "morph"):
                value["subtype"] = event["subtype"]
            elif "subtype" in event:
                complete = False
            for field in ("hallucinated", "is_proxy"):
                if isinstance(event.get(field), bool):
                    value[field] = event[field]
            for field in ("x", "y"):
                coordinate = event.get(field)
                if isinstance(coordinate, (int, float)) and not isinstance(coordinate, bool) and math.isfinite(coordinate) and abs(coordinate) <= 100000:
                    value[field] = coordinate
            projected.append(value)
        return {"custom": detector.custom_match, "baseline": detector.released_label,
                "complete": complete, "events": projected}
    return {"schemaVersion": SCHEMA_VERSION, "evaluatorVersion": EVALUATOR_VERSION,
            "policyHash": policy["hash"], "you": axis(you, my_events),
            "opponent": axis(opponent, opp_events)}
