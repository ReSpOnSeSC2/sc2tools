"""Causal strategic labels, distinct from immediately executable replay clicks.

This module never executes raw commands or changes strict rich-action labels.
Assisted construction labels require a separately verified, paid UI decoder.
"""
from __future__ import annotations

import base64
from collections.abc import Mapping
from copy import deepcopy
import math

from s2clientprotocol import sc2api_pb2 as api

from .rich_actions import (
    _ability_root, _current, _kind, _records, _selection, _world_pixel,
    serialize_action, validate_action_record,
)


SCHEMA = 1
_BUILDS = {880: "Nexus", 881: "Pylon", 882: "Assimilator", 883: "Gateway", 894: "CyberneticsCore"}
_ATTACK = {23, 24, 25, 3674}


def point(value):
    return (isinstance(value, (list, tuple)) and len(value) == 2
            and all(isinstance(v, (float, int)) and not isinstance(v, bool) and math.isfinite(v) for v in value))


def on_map(frame, value):
    size = frame.get("spatial", {}).get("map_size")
    return point(value) and point(size) and all(0 <= v < maximum for v, maximum in zip(value, size))


def visible_point(frame, value):
    pixel = _world_pixel(frame, value) if point(value) else None
    spatial = frame.get("spatial", {})
    size = spatial.get("screen_size", [])
    if pixel is None or len(size) != 2 or not all(0 <= p < s for p, s in zip(pixel, size)):
        return False
    try:
        return spatial["screen_visibility"][int(pixel[1])][int(pixel[0])] == 2
    except (IndexError, KeyError, TypeError):
        return False


def _catalog(catalog):
    values = catalog.get("abilities", catalog) if isinstance(catalog, Mapping) else {}
    return values if isinstance(values, Mapping) else {}


def is_assisted_build(ability, data):
    """Public, patch-metadata-verified construction whitelist for intent masks."""
    native = data.get("native", {})
    return (ability in _BUILDS and data.get("available") is True
            and data.get("name", "").lower() == "protossbuild"
            and native.get("is_building") is True
            and native.get("button_name") == _BUILDS[ability]
            and data.get("target") == (3 if ability == 882 else 2))


def _memory(frame, key, owner):
    loop = frame["game_loop"]
    return {tag: row for tag, row in _records(frame, key).items()
            if type(row.get("owner", owner)) is int and row.get("owner", owner) == owner
            and type(row.get("last_seen_loop")) is int
            and 0 <= row["last_seen_loop"] <= loop and point(row.get("position"))}


def _building_pair(action, frame, target_position):
    """Accept only matching native views, allowing actual viewport clipping.

    A clipped feature point is audit evidence; the raw world target is retained.
    """
    if not action.HasField("action_feature_layer"):
        return True
    a, b = action.action_raw.unit_command, action.action_feature_layer.unit_command
    if (_ability_root(frame, a.ability_id) != _ability_root(frame, b.ability_id)
            or bool(a.queue_command) != bool(b.queue_command)
            or b.WhichOneof("target") != "target_screen_coord"):
        return False
    pixel = _world_pixel(frame, target_position)
    size = frame.get("spatial", {}).get("screen_size", [])
    if pixel is None or len(size) != 2 or any(type(s) is not int or s <= 0 for s in size):
        return False
    expected = [max(0, min(s - 1, math.floor(p))) for p, s in zip(pixel, size)]
    actual = [b.target_screen_coord.x, b.target_screen_coord.y]
    return all(abs(a - b) <= 1 for a, b in zip(expected, actual))


def normalize_intent(action_record, preceding_frame, public_catalog) -> dict:
    """Normalize a native command/camera label without granting raw execution.

    ``known_neutral`` must contain only prior permitted sightings, with the same
    identity/position/last_seen_loop fields as known_own. Missing evidence fails
    closed. PySC2 RAW_FUNCTION resolution belongs to a separate pinned registry.
    """
    result = {"schema": SCHEMA, "admitted": False, "reasons": [], "kind": None,
              "ability_id": None, "source_tags": [], "queued": False, "target": None,
              "decoder_requirements": [], "evidence": {},
              "supervision": {"execution_class": None, "timing": False, "repeat": False}}
    try:
        validate_action_record(action_record)
        if (not isinstance(preceding_frame, Mapping)
                or type(preceding_frame.get("game_loop")) is not int
                or preceding_frame["game_loop"] != action_record["preceding_game_loop"]
                or preceding_frame["game_loop"] >= action_record["game_loop"]):
            raise ValueError("Causal frame does not match native action")
        action = api.Action.FromString(base64.b64decode(action_record["wire_base64"]))
    except (ValueError, KeyError, TypeError):
        result["reasons"] = ["invalid_native_record_or_causal_frame"]
        return result
    result.update(wire_base64=action_record["wire_base64"], wire_sha256=action_record["wire_sha256"])
    result["evidence"] = {"wire_sha256": action_record["wire_sha256"], "action_loop": action.game_loop,
                          "preceding_loop": preceding_frame["game_loop"], "source_evidence": [],
                          "target_evidence": None, "raw_execution_authorized": False}
    abilities = _catalog(public_catalog)
    available = {a.get("ability_id") for a in preceding_frame.get("available_abilities", [])}
    public = {str(k): {**v, "current_available": v.get("id", v.get("ability_id")) in available}
              for k, v in abilities.items() if isinstance(v, Mapping)}
    frame = {**preceding_frame, "public_abilities": public}
    strict = serialize_action(action, frame)
    remaining = set(strict["supervision"]["exclusion_reasons"])
    result["evidence"]["strict_exclusion_reasons"] = sorted(remaining)
    surfaces = {d.name for d, _ in action.ListFields()} - {"game_loop"}
    kind = action.action_raw.WhichOneof("action")
    if (not surfaces.issubset({"action_raw", "action_feature_layer"}) or "action_raw" not in surfaces
            or kind not in {"camera_move", "unit_command"}
            or action.HasField("action_feature_layer") and action.action_feature_layer.WhichOneof("action") != kind):
        result["reasons"] = ["unsupported_or_combined_native_intent"]
        return result
    result["kind"] = kind
    requirements = set()
    if kind == "camera_move":
        c = action.action_raw.camera_move.center_world_space
        result["target"] = {"kind": "world_point", "point": [c.x, c.y]}
        if not on_map(frame, [c.x, c.y]):
            remaining.add("camera_map_bounds_unverified")
        requirements.add("paid_camera")
    else:
        cmd = action.action_raw.unit_command
        ability = cmd.ability_id
        data = public.get(str(ability), {})
        build = is_assisted_build(ability, data)
        result.update(ability_id=ability, source_tags=list(cmd.unit_tags), queued=bool(cmd.queue_command))
        result["evidence"]["assisted_build_whitelist"] = build
        entities = _records(frame, "entities")
        memory = _memory(frame, "known_own", 1)
        own = {**memory, **{t: r for t, r in entities.items() if r.get("owner") == 1}}
        selected, complete = _selection(frame, own)
        source_resolved = bool(cmd.unit_tags) and len(set(cmd.unit_tags)) == len(cmd.unit_tags)
        for tag in cmd.unit_tags:
            row = entities.get(tag)
            if row and row.get("owner") == 1 and _current(row):
                status, observed = "current_visible_own", row
            elif tag in memory and complete and tag in selected:
                status, observed = "selected_known_own", memory[tag]
                requirements.update({"paid_source_reacquisition", "fresh_source_visibility"})
            else:
                remaining.add("source_not_current_or_confirmed_known_selection")
                source_resolved = False
                continue
            result["evidence"]["source_evidence"].append({"tag": tag, "kind": status,
                "type_name": _kind(observed), "position": deepcopy(observed.get("position")),
                "last_seen_loop": frame["game_loop"] if status == "current_visible_own" else observed["last_seen_loop"]})
            if build and _kind(observed) != "PROBE":
                remaining.add("construction_source_not_probe")
        if source_resolved:
            remaining.discard("offscreen_source_without_confirmed_targetless_production")
        target_kind = cmd.WhichOneof("target")
        allowed_targets = {1: {None}, 2: {"target_world_space_pos"}, 3: {"target_unit_tag"},
                           4: {"target_world_space_pos", "target_unit_tag"},
                           5: {None, "target_world_space_pos"}}
        if target_kind not in allowed_targets.get(data.get("target"), set()):
            remaining.add("public_ability_target_kind_mismatch")
        position = None
        if target_kind == "target_world_space_pos":
            position = [cmd.target_world_space_pos.x, cmd.target_world_space_pos.y]
            result["target"] = {"kind": "world_point", "point": position}
            result["evidence"]["target_evidence"] = {"kind": "native_world_intention"}
            if not on_map(frame, position):
                remaining.add("world_target_map_bounds_unverified")
            if build and on_map(frame, position) and not visible_point(frame, position):
                requirements.update({"paid_camera_reframe", "fresh_target_visibility"})
        elif target_kind == "target_unit_tag":
            tag = int(cmd.target_unit_tag)
            result["target"] = {"kind": "unit", "tag": tag}
            row = entities.get(tag)
            if row and _current(row):
                position = row.get("position")
                result["evidence"]["target_evidence"] = {"kind": "current_visible_unit", "owner": row.get("owner"),
                    "type_name": _kind(row), "position": deepcopy(position), "last_seen_loop": frame["game_loop"]}
            elif build and ability == 882:
                row = _memory(frame, "known_neutral", 3).get(tag)
                if row and "VESPENEGEYSER" in _kind(row).replace("_", ""):
                    position = row["position"]
                    result["target"]["point"] = list(position)
                    result["evidence"]["target_evidence"] = {"kind": "previously_seen_neutral", "owner": 3,
                        "type_name": _kind(row), "position": list(position), "last_seen_loop": row["last_seen_loop"]}
                    requirements.update({"paid_camera_reframe", "fresh_target_visibility", "fresh_neutral_identity"})
            if result["evidence"]["target_evidence"] is None:
                remaining.add("unit_target_not_current_or_permitted_neutral_memory")
            if ability in _ATTACK or str(data.get("name", "")).upper().startswith("ATTACK"):
                if tag in own or (row and row.get("owner") in (1, 2)):
                    remaining.add("friendly_attack_target")
            if build and ability == 882 and (not row or row.get("owner") != 3
                    or "VESPENEGEYSER" not in _kind(row).replace("_", "")):
                remaining.add("gas_target_not_permitted_geyser")
        if build:
            requirements.add("fresh_placement_query")
            if position is not None and on_map(frame, position) and _building_pair(action, frame, position):
                remaining.difference_update({"dual_view_coordinate_mismatch", "dual_view_unit_target_not_current",
                    "empty_or_combined_action_semantics", "spatial_command_pick_resolution_unavailable",
                    "spatial_target_out_of_bounds", "unit_target_not_currently_visible_on_screen",
                    "target_not_currently_visible", "selection_incomplete", "selected_ui_ability_not_available"})
            elif position is not None:
                remaining.add("construction_native_views_conflict_or_bounds_missing")
        requirements.update({"paid_selection", "confirmed_selection", "fresh_available_ability", "paced_command"})
        if cmd.queue_command:
            requirements.add("preserve_queue_flag")
    result["reasons"] = sorted(remaining)
    result["admitted"] = not remaining
    result["decoder_requirements"] = sorted(requirements)
    assisted = any(x in requirements for x in ("paid_source_reacquisition", "paid_camera_reframe"))
    result["supervision"]["execution_class"] = ("assisted" if assisted else "immediate") if not remaining else None
    return result
