"""Lossless replay action audit with conservative, causal supervision flags.

Native raw actions are demonstration labels, never authorization to execute raw
commands. A learned decoder must still select and act through FairPlay. Unknown
protobuf fields survive in ``wire_base64`` even when protobuf JSON omits them.
No action is merged, substituted, or dropped by this module.
"""
from __future__ import annotations

import base64
from collections.abc import Mapping
import hashlib
import json
import math

from google.protobuf.json_format import MessageToDict
from s2clientprotocol import sc2api_pb2 as api


SCHEMA = 1
_SCOPE = "native_action_labels_require_restricted_decoder"
_ATTACK_IDS = {23, 24, 25, 3674}
_WORKERS = {"PROBE", "SCV", "DRONE"}


def _integer(value, *, minimum=0):
    if isinstance(value, bool) or not isinstance(value, int) or value < minimum:
        return None
    return value


def _finite(value):
    return isinstance(value, (int, float)) and not isinstance(value, bool) and math.isfinite(value)


def _tag(value):
    if isinstance(value, str) and value.isascii() and value.isdigit():
        value = int(value)
    return _integer(value, minimum=1)


def _kind(row):
    value = row.get("type_name", row.get("type", row.get("unit_type_name", "")))
    return str(value).upper().replace("UNITTYPEID.", "")


def _own(row):
    return type(row.get("owner")) is int and row["owner"] == 1


def _current(row):
    if row.get("owner") == 4 and row.get("cloak_state", row.get("cloak")) not in (2, 3):
        return False
    return row.get("is_visible") is True and row.get("is_on_screen") is True


def _records(frame, key):
    values = frame.get(key, ())
    if not isinstance(values, (list, tuple)):
        return {}
    return {_tag(row.get("tag")): row for row in values
            if isinstance(row, Mapping) and _tag(row.get("tag")) is not None}


def _selection(frame, own):
    tags = frame.get("selection", ())
    if not isinstance(tags, (list, tuple)):
        return [], False
    parsed = [_tag(value) for value in tags]
    complete = (frame.get("selection_complete") is True and bool(parsed)
                and None not in parsed and len(set(parsed)) == len(parsed)
                and all(tag in own for tag in parsed))
    return [tag for tag in parsed if tag is not None], complete


def _public(frame, ability):
    catalog = frame.get("public_abilities", {})
    if not isinstance(catalog, Mapping):
        return None
    data = catalog.get(str(ability), catalog.get(ability))
    return data if isinstance(data, Mapping) else None


def _targetless(data):
    # SC2APIProtocol.AbilityData.Target.NoTarget == 1; 0 is unspecified.
    return (data is not None and not isinstance(data.get("target"), bool)
            and data.get("target") in (1, "NoTarget", "None"))


def _producer_matches(data, row):
    """Explicit public ability families; a missing producer mapping fails closed."""
    name = str(data.get("name", "")).upper().replace("_", "")
    kind = _kind(row)
    families = {
        "NEXUSTRAIN": {"NEXUS"}, "TRAINPROBE": {"NEXUS"},
        "GATEWAYTRAIN": {"GATEWAY"}, "ROBOTICSFACILITYTRAIN": {"ROBOTICSFACILITY"},
        "STARGATETRAIN": {"STARGATE"}, "FORGERESEARCH": {"FORGE"},
        "CYBERNETICSCORERESEARCH": {"CYBERNETICSCORE"},
        "TWILIGHTCOUNCILRESEARCH": {"TWILIGHTCOUNCIL"},
        "TEMPLARARCHIVERESEARCH": {"TEMPLARARCHIVE"},
        "ROBOTICSBAYRESEARCH": {"ROBOTICSBAY"}, "FLEETBEACONRESEARCH": {"FLEETBEACON"},
    }
    if any(name.startswith(prefix) and kind in kinds for prefix, kinds in families.items()):
        return True
    research = {
        "RESEARCHWARPGATE": "CYBERNETICSCORE", "RESEARCHBLINK": "TWILIGHTCOUNCIL",
        "RESEARCHCHARGE": "TWILIGHTCOUNCIL", "RESEARCHADEPTRESONATINGGLAIVES": "TWILIGHTCOUNCIL",
        "RESEARCHPSISTORM": "TEMPLARARCHIVE", "RESEARCHEXTENDEDTHERMALLANCE": "ROBOTICSBAY",
    }
    return research.get(name) == kind


def _pixel_evidence(frame, point, surface, reasons):
    spatial = frame.get("spatial", {})
    if not isinstance(spatial, Mapping):
        spatial = {}
    size = spatial.get(surface + "_size")
    if (not isinstance(size, (list, tuple)) or len(size) != 2
            or any(_integer(v, minimum=1) is None for v in size)):
        reasons.add("spatial_bounds_unavailable")
        return False
    x, y = point
    if not all(_finite(v) for v in point) or not (0 <= x < size[0] and 0 <= y < size[1]):
        reasons.add("spatial_target_out_of_bounds")
        return False
    visibility = spatial.get(surface + "_visibility")
    try:
        visible = visibility[int(y)][int(x)] == 2
    except (IndexError, KeyError, TypeError):
        reasons.add("target_visibility_unavailable")
        return False
    if not visible:
        reasons.add("target_not_currently_visible")
        return False
    return True


def _point(message):
    return [message.x, message.y]


def _world_pixel(frame, point):
    spatial = frame.get("spatial", {})
    camera = frame.get("camera")
    if not isinstance(spatial, Mapping):
        return None
    size, width = spatial.get("screen_size"), spatial.get("camera_width", frame.get("camera_width"))
    if (not isinstance(camera, (list, tuple)) or len(camera) != 2
            or not all(_finite(x) for x in camera)
            or not isinstance(size, (list, tuple)) or len(size) != 2
            or any(_integer(v, minimum=1) is None for v in size)
            or not _finite(width) or width <= 0 or not all(_finite(x) for x in point)):
        return None
    return [(point[0] - camera[0]) * size[0] / width + size[0] / 2,
            (camera[1] - point[1]) * size[0] / width + size[1] / 2]


def _ability(data, reasons):
    # SMART has a blank link_name in actual engine metadata. Its typed public
    # id/target still establish a known ability; producer families remain strict.
    if (data is None or _integer(data.get("id", data.get("ability_id")), minimum=1) is None
            or type(data.get("target")) is not int or data["target"] not in (1, 2, 3, 4, 5)):
        reasons.add("public_ability_metadata_unavailable")
    elif data.get("available") is False:
        reasons.add("ability_not_available_in_preceding_frame")


def _sources(tags, frame, own, data, has_target, reasons):
    if not tags or len(set(tags)) != len(tags):
        reasons.add("source_selection_missing_or_duplicate")
        return
    selected, complete = _selection(frame, own)
    for tag in tags:
        row = own.get(tag)
        if row is None:
            reasons.add("source_not_previously_observed_own")
        elif not _current(row):
            if (has_target or not complete or tag not in selected or not _targetless(data)
                    or data.get("current_available") is not True or not _producer_matches(data, row)):
                reasons.add("offscreen_source_without_confirmed_targetless_production")


def _command(part, surface, frame, own, entities, reasons):
    ability = part.ability_id
    data = _public(frame, ability)
    _ability(data, reasons)
    attack = ability in _ATTACK_IDS or (data is not None and str(data.get("name", "")).upper().startswith("ATTACK"))
    target = None
    if surface == "action_raw":
        tags = list(part.unit_tags)
        if part.HasField("target_world_space_pos"):
            point = _point(part.target_world_space_pos)
            target = {"kind": "world_point", "point": point}
            pixel = _world_pixel(frame, point)
            if pixel is None:
                reasons.add("world_target_visibility_unresolved")
            else:
                _pixel_evidence(frame, pixel, "screen", reasons)
        elif part.HasField("target_unit_tag"):
            target = {"kind": "unit", "tag": int(part.target_unit_tag)}
            row = entities.get(part.target_unit_tag)
            if attack and part.target_unit_tag in own:
                reasons.add("friendly_attack_target")
            if row is None or not _current(row):
                reasons.add("unit_target_not_currently_visible_on_screen")
    else:
        tags, complete = _selection(frame, own)
        if not complete:
            reasons.add("selection_incomplete")
        if data is None or data.get("current_available") is not True:
            reasons.add("selected_ui_ability_not_available")
        for field, name in (("target_screen_coord", "screen"), ("target_minimap_coord", "minimap")):
            if part.HasField(field):
                point = _point(getattr(part, field))
                target = {"kind": name + "_point", "point": point}
                _pixel_evidence(frame, point, name, reasons)
                # A native spatial click can bind a unit. Coordinates alone do
                # not establish whether a friendly unit occupies its pick box.
                reasons.add("spatial_command_pick_resolution_unavailable")
    if not part.HasField("ability_id") or ability <= 0:
        reasons.add("ability_id_missing_or_invalid")
    if target is None and not _targetless(data):
        reasons.add("targetless_semantics_unverified")
    _sources(tags, frame, own, data, target is not None, reasons)
    return {"ability_id": ability, "source_tags": tags, "queue_command": bool(part.queue_command), "target": target}


def _ability_root(frame, ability):
    """Follow only public remap metadata, never shared/ambiguous link names."""
    seen = set()
    while ability not in seen and len(seen) < 8:
        seen.add(ability)
        data = _public(frame, ability)
        remap = data.get("remaps_to_ability_id", 0) if data else 0
        if not remap:
            return ability
        if _integer(remap, minimum=1) is None or _public(frame, remap) is None:
            return None
        ability = remap
    return None


def _world_minimap_pixel(frame, point):
    spatial = frame.get("spatial", {})
    if not isinstance(spatial, Mapping):
        return None
    size = spatial.get("minimap_size")
    map_size = spatial.get("map_size", frame.get("map_size"))
    if (not isinstance(size, (list, tuple)) or len(size) != 2
            or any(_integer(v, minimum=1) is None for v in size) or size[0] != size[1]
            or not isinstance(map_size, (list, tuple)) or len(map_size) != 2
            or not all(_finite(v) and v > 0 for v in map_size)
            or not all(_finite(v) for v in point)):
        return None
    if not all(0 <= value <= bound for value, bound in zip(point, map_size)):
        return None
    scale = size[0] / max(map_size)
    return [point[0] * scale, (map_size[1] - point[1]) * scale]


def _correlated_views(action, frame, entities):
    """Verify two representations of ONE native Action, not two inputs.

    Exact native raw tags identify actors/recipients even when a selection
    action occurred in the same game loop. The restricted decoder still owes
    those real selections and input delays; this does not certify 200 APM.
    """
    reasons = set()
    raw = action.action_raw
    feature = action.action_feature_layer
    raw_fields, feature_fields = raw.ListFields(), feature.ListFields()
    if (len(raw_fields) != 1 or len(feature_fields) != 1
            or raw_fields[0][0].name != feature_fields[0][0].name):
        return None, {"dual_view_component_mismatch"}
    kind = raw_fields[0][0].name
    if kind not in {"camera_move", "unit_command"}:
        return None, {"dual_view_component_unsupported"}
    detail = {"kind": kind, "surfaces": ["action_raw", "action_feature_layer"],
              "actor_evidence": "native_raw_source_tags", "paced_decoder_verified": False}
    if kind == "camera_move":
        a, b = raw.camera_move, feature.camera_move
        if not a.HasField("center_world_space") or not b.HasField("center_minimap"):
            return None, {"dual_view_target_mismatch"}
        expected = _world_minimap_pixel(frame, _point(a.center_world_space))
        actual = _point(b.center_minimap)
        tolerance = 1.00001  # Native minimap projection truncates/quantizes pixels.
    else:
        a, b = raw.unit_command, feature.unit_command
        if a.ability_id != b.ability_id:
            first, second = _ability_root(frame, a.ability_id), _ability_root(frame, b.ability_id)
            if first is None or first != second:
                reasons.add("dual_view_ability_mismatch")
        if bool(a.queue_command) != bool(b.queue_command):
            reasons.add("dual_view_queue_mismatch")
        detail["ability_ids"] = [a.ability_id, b.ability_id]
        raw_target = a.WhichOneof("target")
        feature_target = b.WhichOneof("target")
        if raw_target is None and feature_target is None:
            detail["target_correlation"] = "both_targetless"
            return (detail if not reasons else None), reasons
        if raw_target is None or feature_target is None:
            return None, reasons | {"dual_view_target_mismatch"}
        point = None
        target_row = None
        if raw_target == "target_world_space_pos":
            point = _point(a.target_world_space_pos)
        elif raw_target == "target_unit_tag":
            target_row = entities.get(a.target_unit_tag)
            if target_row is None or not _current(target_row):
                return None, reasons | {"dual_view_unit_target_not_current"}
            point = target_row.get("position")
        if not isinstance(point, (list, tuple)) or len(point) != 2 or not all(_finite(v) for v in point):
            return None, reasons | {"dual_view_target_position_unavailable"}
        surface = "screen" if feature_target == "target_screen_coord" else "minimap"
        expected = _world_pixel(frame, point) if surface == "screen" else _world_minimap_pixel(frame, point)
        actual = _point(getattr(b, feature_target))
        tolerance = 1.00001
        if target_row is not None and surface == "screen":
            # Known native target tags settle recipient identity. Permit a
            # click within that currently seen recipient's bounded footprint,
            # plus one quantized pixel; never search for a different unit.
            radius = target_row.get("radius")
            spatial = frame.get("spatial", {})
            width = spatial.get("camera_width", frame.get("camera_width"))
            size = spatial.get("screen_size")
            if (_finite(radius) and 0 <= radius <= 8 and _finite(width) and width > 0
                    and isinstance(size, (list, tuple)) and len(size) == 2 and _integer(size[0], minimum=1)):
                tolerance += math.ceil(radius * size[0] / width)
        _pixel_evidence(frame, actual, surface, reasons)
        detail["target_correlation"] = "current_native_unit_recipient" if target_row else "native_world_point"
    if expected is None:
        return None, reasons | {"dual_view_correlation_geometry_unavailable"}
    if not all(abs(a - b) <= tolerance for a, b in zip(expected, actual)):
        return None, reasons | {"dual_view_coordinate_mismatch"}
    detail.update(expected_pixel=expected, feature_pixel=actual, tolerance_pixels=tolerance)
    return (detail if not reasons else None), reasons


def _ui_component(kind, part, frame, own, reasons):
    selected, complete = _selection(frame, own)
    ui = frame.get("ui", {})
    ui = ui if isinstance(ui, Mapping) else {}
    if kind == "control_group":
        index = part.control_group_index
        if not part.HasField("control_group_index") or not 0 <= index <= 9:
            reasons.add("control_group_index_invalid")
        if part.action == 1:
            groups = ui.get("groups", ())
            if not isinstance(groups, (list, tuple)) or not any(
                    isinstance(g, Mapping) and g.get("control_group_index") == index
                    and _integer(g.get("count"), minimum=1) is not None for g in groups):
                reasons.add("control_group_not_observed_in_ui")
        elif part.action in (2, 3, 4, 5):
            if not complete:
                reasons.add("selection_incomplete")
        else:
            reasons.add("control_group_operation_unknown")
    elif kind == "multi_panel":
        panel = ui.get("multi", {})
        units = panel.get("units", ()) if isinstance(panel, Mapping) else ()
        if (not complete or not isinstance(units, (list, tuple))
                or not part.HasField("unit_index") or not 0 <= part.unit_index < len(units)):
            reasons.add("ui_unit_index_unresolved")
        if not part.HasField("type") or part.type not in (1, 2, 3, 4):
            reasons.add("ui_selection_operation_unknown")
    elif kind in {"cargo_panel", "production_panel"}:
        panel = ui.get("cargo" if kind == "cargo_panel" else "production", {})
        key = "passengers" if kind == "cargo_panel" else "build_queue"
        items = panel.get(key, ()) if isinstance(panel, Mapping) else ()
        if (not complete or not isinstance(items, (list, tuple)) or not part.HasField("unit_index")
                or not 0 <= part.unit_index < len(items)):
            reasons.add("ui_unit_index_unresolved")
    elif kind == "toggle_autocast":
        data = _public(frame, part.ability_id)
        _ability(data, reasons)
        if not complete or any(not _current(own[tag]) for tag in selected):
            reasons.add("autocast_selection_not_current")
    elif kind == "select_idle_worker":
        if not part.HasField("type") or part.type not in (1, 2, 3, 4):
            reasons.add("ui_selection_operation_unknown")
    elif kind not in {"select_army", "select_larva", "select_warp_gates"}:
        reasons.add("unsupported_ui_action")


def serialize_action(action, preceding_frame: Mapping) -> dict:
    """Preserve one actual action and classify it against its causal frame.

    ``entities`` uses native owner1/3/4 for self/neutral/enemy; ``known_own`` is permitted prior
    own sightings, not global raw state. ``selection_complete`` must be proven
    by current selected tags and UI counts. Optional ``spatial`` contains sizes,
    current visibility grids, and camera_width for world-to-screen projection.
    """
    if not isinstance(action, api.Action):
        raise TypeError("Expected an SC2APIProtocol.Action")
    if not isinstance(preceding_frame, Mapping) or _integer(preceding_frame.get("game_loop")) is None:
        raise ValueError("A preceding frame with a nonnegative integer game_loop is required")
    wire = action.SerializeToString(deterministic=True)
    payload = MessageToDict(action, preserving_proto_field_name=True, use_integers_for_enums=True)
    # JSON itself must remain finite and portable, including absent/default data.
    json.dumps(payload, allow_nan=False)
    reasons = set()
    loop = int(action.game_loop) if action.HasField("game_loop") else None
    if loop is None or loop <= preceding_frame["game_loop"]:
        reasons.add("action_not_strictly_after_preceding_frame")
    clean = api.Action()
    clean.CopyFrom(action)
    clean.DiscardUnknownFields()
    if clean.SerializeToString(deterministic=True) != wire:
        reasons.add("unknown_protobuf_fields")
    entities = _records(preceding_frame, "entities")
    # Historical visibility flags never become a fresh current-screen sighting.
    own = {tag: {**row, "owner": 1, "is_visible": False, "is_on_screen": False}
           for tag, row in _records(preceding_frame, "known_own").items()
           if row.get("owner", 1) == 1 and not isinstance(row.get("owner"), bool)}
    own.update({tag: row for tag, row in entities.items() if _own(row)})
    components = []
    component_reasons = []
    for descriptor, surface in action.ListFields():
        name = descriptor.name
        if name == "game_loop":
            continue
        if name == "action_chat":
            components.append({"surface": name, "kind": "chat", "arguments": payload[name]})
            component_reasons.append(set())
            reasons.add("chat_not_gameplay_supervision")
            continue
        if name not in {"action_raw", "action_feature_layer", "action_render", "action_ui"}:
            reasons.add("unsupported_action_surface")
            continue
        if name == "action_render":
            reasons.add("render_coordinate_space_unverified")
        for field, part in surface.ListFields():
            kind = field.name
            local_reasons = set()
            component = {"surface": name, "kind": kind, "arguments": payload[name][kind]}
            if kind == "unit_command":
                component["command"] = _command(part, name, preceding_frame, own, entities, local_reasons)
            elif name == "action_ui":
                _ui_component(kind, part, preceding_frame, own, local_reasons)
            elif kind == "camera_move":
                if name == "action_raw":
                    point = _point(part.center_world_space)
                    if not all(_finite(x) for x in point):
                        local_reasons.add("camera_coordinates_invalid")
                    if not part.HasField("center_world_space"):
                        local_reasons.add("camera_coordinates_missing")
                elif not part.HasField("center_minimap"):
                    local_reasons.add("camera_coordinates_missing")
                else:
                    # Human camera movement into fog is a valid input. It does
                    # not assert enemy visibility or authorize a unit target.
                    temp = set()
                    _pixel_evidence(preceding_frame, _point(part.center_minimap), "minimap", temp)
                    local_reasons.update(temp - {"target_not_currently_visible", "target_visibility_unavailable"})
            elif kind == "unit_selection_point":
                if not part.HasField("selection_screen_coord") or not part.HasField("type"):
                    local_reasons.add("selection_arguments_missing")
                else:
                    _pixel_evidence(preceding_frame, _point(part.selection_screen_coord), "screen", local_reasons)
            elif kind == "unit_selection_rect":
                if not part.selection_screen_coord:
                    local_reasons.add("selection_arguments_missing")
                for rect in part.selection_screen_coord:
                    if not rect.HasField("p0") or not rect.HasField("p1"):
                        local_reasons.add("selection_arguments_missing")
                    for point in (rect.p0, rect.p1):
                        _pixel_evidence(preceding_frame, _point(point), "screen", local_reasons)
            elif kind == "toggle_autocast" and name == "action_raw":
                data = _public(preceding_frame, part.ability_id)
                _ability(data, local_reasons)
                tags = list(part.unit_tags)
                if not tags or any(tag not in own or not _current(own[tag]) for tag in tags):
                    local_reasons.add("autocast_selection_not_current")
            else:
                local_reasons.add("unsupported_action_component")
            components.append(component)
            component_reasons.append(local_reasons)
    canonical = None
    if len(components) == 1:
        reasons.update(component_reasons[0])
        canonical = components[0]
    elif (len(components) == 2
          and {c["surface"] for c in components} == {"action_raw", "action_feature_layer"}):
        correlation, failures = _correlated_views(action, preceding_frame, entities)
        reasons.update(failures)
        if correlation is not None:
            raw_index = next(i for i, c in enumerate(components) if c["surface"] == "action_raw")
            feature_index = 1 - raw_index
            reasons.update(component_reasons[raw_index])
            # Actual raw actor/recipient tags supersede guesses from an older
            # UI selection. Every other spatial/public/visibility check stays.
            superseded = {
                "selection_incomplete", "selected_ui_ability_not_available",
                "source_selection_missing_or_duplicate", "source_not_previously_observed_own",
                "offscreen_source_without_confirmed_targetless_production",
                "spatial_command_pick_resolution_unavailable",
            }
            reasons.update(component_reasons[feature_index] - superseded)
            canonical = {**components[raw_index], "correlated_view": correlation,
                         "feature_arguments": components[feature_index]["arguments"]}
        else:
            reasons.add("empty_or_combined_action_semantics")
            for failures in component_reasons:
                reasons.update(failures)
    else:
        reasons.add("empty_or_combined_action_semantics")
        for failures in component_reasons:
            reasons.update(failures)
    return {"schema": SCHEMA, "game_loop": loop, "preceding_game_loop": preceding_frame["game_loop"],
            "payload": payload, "wire_base64": base64.b64encode(wire).decode("ascii"),
            "wire_sha256": hashlib.sha256(wire).hexdigest(), "components": components, "canonical": canonical,
            "supervision": {"trainable": not reasons, "exclusion_reasons": sorted(reasons), "scope": _SCOPE}}


def validate_action_record(record: Mapping, preceding_frame: Mapping | None = None) -> None:
    """Check wire/JSON integrity; pass the frame to verify supervision semantics.

    A wire-only check is not evidence that the trainability flag is trustworthy.
    Dataset consumers must provide the corresponding preceding frame.
    """
    if not isinstance(record, Mapping) or record.get("schema") != SCHEMA:
        raise ValueError("Unsupported rich action schema")
    try:
        wire = base64.b64decode(record["wire_base64"], validate=True)
        action = api.Action.FromString(wire)
        payload = MessageToDict(action, preserving_proto_field_name=True, use_integers_for_enums=True)
    except Exception as exc:
        raise ValueError("Invalid native action wire payload") from exc
    if hashlib.sha256(wire).hexdigest() != record.get("wire_sha256") or payload != record.get("payload"):
        raise ValueError("Native action wire, hash and JSON disagree")
    loop = int(action.game_loop) if action.HasField("game_loop") else None
    if record.get("game_loop") != loop or _integer(record.get("preceding_game_loop")) is None:
        raise ValueError("Native action timestamp mismatch")
    supervision = record.get("supervision")
    if (not isinstance(supervision, Mapping) or type(supervision.get("trainable")) is not bool
            or not isinstance(supervision.get("exclusion_reasons"), list)
            or supervision.get("scope") != _SCOPE
            or supervision["trainable"] != (not supervision["exclusion_reasons"])):
        raise ValueError("Malformed supervision flags")
    if preceding_frame is not None and dict(record) != serialize_action(action, preceding_frame):
        raise ValueError("Action record does not match causal frame and native action")
