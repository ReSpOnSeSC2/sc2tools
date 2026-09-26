"""Bind model pointers to one live observation and plan restricted UI intents.

This module runs no model and sends no game input. RAW_FUNCTION is a vocabulary,
not execution permission. Its output uses prediction provenance, never a forged
replay wire. A live caller must separately encode this exact frame for inference
and supply a fresh, per-game session ID. Delay/repeat heads remain disabled.
"""
from __future__ import annotations

from collections.abc import Mapping
from copy import deepcopy
import hashlib
import json

import numpy as np

from .alphastar_tensor import _current_visible, decode_image, world_pixel
from .rich_actions import _kind
from .rich_intents import is_assisted_build, on_map, visible_point


BINDING_SCHEMA = "live-policy-observation-v1"
_HEADS = {"queued", "unit_tags", "target_unit_tag", "world"}


class PredictionError(ValueError):
    """An inference binding or meaningful prediction head is not trustworthy."""


def canonical_sha256(value):
    """Hash JSON capture data without accepting NaN, implicit casts or repr()."""
    return hashlib.sha256(json.dumps(value, sort_keys=True, separators=(",", ":"),
                                    allow_nan=False).encode("utf-8")).hexdigest()


def _integer(value, name, lo=0, hi=2**31 - 1):
    if isinstance(value, np.ndarray) and value.shape == ():
        value = value.item()
    if isinstance(value, bool) or not isinstance(value, (int, np.integer)) or not lo <= value <= hi:
        raise PredictionError("invalid_" + name)
    return int(value)


def _functions(registry):
    rows = registry.get("functions") if isinstance(registry, Mapping) else registry
    if not isinstance(rows, list) or not rows:
        raise PredictionError("invalid_function_registry")
    result = {}
    for row in rows:
        if not isinstance(row, Mapping):
            raise PredictionError("invalid_function_registry")
        index = _integer(row.get("id"), "function_id")
        args = row.get("args")
        if (index in result or not isinstance(row.get("name"), str) or not row["name"]
                or not isinstance(args, list) or any(not isinstance(a, str) for a in args)
                or len(args) != len(set(args)) or not set(args) <= _HEADS
                or {"world", "target_unit_tag"} <= set(args)):
            raise PredictionError("invalid_or_ambiguous_function_registry")
        _integer(row.get("ability_id"), "registry_ability")
        _integer(row.get("general_id"), "registry_general_ability")
        if type(row.get("camera_only_pt")) is not bool or type(row.get("planned_build")) is not bool:
            raise PredictionError("invalid_registry_flags")
        result[index] = row
    return result


def _catalog(public_catalog):
    abilities = public_catalog.get("abilities", public_catalog)
    if not isinstance(abilities, Mapping):
        raise PredictionError("invalid_public_catalog")
    return abilities


def _rows(frame):
    loop = _integer(frame.get("game_loop"), "frame_loop")
    current, memory = {}, {}
    for row in frame.get("entities", []):
        tag = _integer(row.get("tag"), "entity_tag", 1, 2**64 - 1)
        if (tag in current or type(row.get("owner")) is not int or not _current_visible(row, frame)
                or not on_map(frame, row.get("position")) or not _kind(row)):
            raise PredictionError("invalid_current_permitted_entity")
        current[tag] = row
    for key, owner in (("known_own", 1), ("known_neutral", 3)):
        seen = set()
        for row in frame.get(key, []):
            tag = _integer(row.get("tag"), "memory_tag", 1, 2**64 - 1)
            _integer(row.get("last_seen_loop"), "memory_time", 0, loop)
            if (tag in seen or tag in memory or type(row.get("owner")) is not int or row.get("owner") != owner
                    or not on_map(frame, row.get("position")) or not _kind(row)
                    or tag in current and current[tag]["owner"] != owner):
                raise PredictionError("invalid_causal_entity_memory")
            seen.add(tag)
            if tag not in current:
                memory[tag] = row
    return current, memory


def bind_observation(frame, entity_tags, registry, public_catalog, *, session_id,
                     max_entities=128, max_selected=16):
    """Bind an encoder's exact pointer sidecar to a current live frame.

    Returns detached JSON metadata, not inference tensors. It rejects archived
    training metadata as a substitute for a live binding. The caller owns the
    session identifier and must not reuse it across games. No hidden entities
    or arbitrary reordering may be inserted into the encoder sidecar.
    """
    if not isinstance(session_id, str) or not session_id.strip():
        raise PredictionError("live_session_id_required")
    max_entities = _integer(max_entities, "max_entities", 2, 512)
    max_selected = _integer(max_selected, "max_selected", 1, 64)
    _functions(registry)
    _catalog(public_catalog)
    current, memory = _rows(frame)
    player_id = _integer(frame.get("hud", {}).get("player_id"), "live_player_id", 1, 16)
    # The public map transform itself is validated even for targetless commands.
    world_pixel(frame.get("camera"), frame.get("spatial", {}).get("map_size"))
    expected = sorted(current) + sorted(memory)
    if (not isinstance(entity_tags, list)
            or any(type(t) is not int for t in entity_tags)
            or entity_tags != expected or len(expected) > max_entities):
        raise PredictionError("entity_sidecar_not_exact_observation_order")
    result = {"schema": BINDING_SCHEMA, "session_id": session_id, "player_id": player_id,
              "game_loop": frame["game_loop"], "frame_sha256": canonical_sha256(frame),
              "registry_sha256": canonical_sha256(registry),
              "catalog_sha256": canonical_sha256(public_catalog),
              "entity_tags": list(expected), "max_entities": max_entities,
              "max_selected": max_selected, "world_size": 256}
    result["binding_id"] = canonical_sha256(result)
    return result


def inverse_world(value, map_size):
    """Invert world256 at cell center; reject padded map cells without clipping."""
    cell = _integer(value, "world_head", 0, 256 * 256 - 1)
    if not isinstance(map_size, (list, tuple)) or len(map_size) != 2:
        raise PredictionError("invalid_public_map_size")
    width, height = [_integer(n, "map_dimension", 1, 4096) for n in map_size]
    row, col = divmod(cell, 256)
    scale = max(width, height) / 256
    position = [(col + .5) * scale, height - (row + .5) * scale]
    if not (0 <= position[0] < width and 0 <= position[1] < height):
        raise PredictionError("world_prediction_in_padded_map_area")
    if world_pixel(position, map_size) != (col, row):
        raise PredictionError("world_transform_roundtrip_failed")
    return position


def _source_pointers(values, binding):
    if isinstance(values, np.ndarray) and values.ndim == 1:
        values = values.tolist()
    if not isinstance(values, (list, tuple)) or len(values) != binding["max_selected"]:
        raise PredictionError("source_head_shape_mismatch")
    eos, ended, tags = binding["max_entities"], False, []
    for value in values:
        pointer = _integer(value, "source_pointer", 0, eos)
        if pointer == eos:
            ended = True
            continue
        if ended:
            raise PredictionError("source_pointer_after_eos")
        if pointer >= len(binding["entity_tags"]):
            raise PredictionError("source_pointer_targets_padding")
        tag = binding["entity_tags"][pointer]
        if tag in tags:
            raise PredictionError("duplicate_source_pointer")
        tags.append(tag)
    if not tags:
        raise PredictionError("empty_source_selection")
    return tags


def _planned_point_allowed(frame, value):
    # Same label-independent native minimap mask as the official tensor bridge.
    layers = frame.get("feature_layers", {}).get("minimap_renders", {})
    try:
        visibility, buildable = (decode_image(layers[k]) for k in ("visibility_map", "buildable"))
        if visibility.shape != (64, 64) or buildable.shape != (64, 64):
            return False
        x, y = world_pixel(value, frame["spatial"]["map_size"])
        return bool(visibility[y // 4, x // 4] == 2 and buildable[y // 4, x // 4] == 1)
    except (KeyError, ValueError, TypeError, IndexError):
        return False


def prediction_to_intent(prediction, registry, current_frame, binding, public_catalog, *, session_id):
    """Validate meaningful model heads and return a restricted runtime intent.

    ``prediction`` contains scalar function/queued/world/target_unit_tag heads
    and a fixed-length unit_tags pointer array with max_entities as EOS. Unused
    heads are ignored. All used values must be integers, without clipping or
    nearest-function fallback. Observed availability is re-queried by runtime
    after paid source reacquisition; static public availability is not a UI
    button claim. This does not connect a model inference loop by itself.
    """
    result = {"schema": 1, "provenance": "policy_prediction", "admitted": False,
              "reasons": [], "kind": None, "ability_id": None, "source_tags": [],
              "queued": False, "target": None, "decoder_requirements": [],
              "evidence": {"raw_execution_authorized": False},
              "supervision": {"execution_class": None, "timing": False, "repeat": False}}
    try:
        if not isinstance(binding, Mapping) or binding.get("schema") != BINDING_SCHEMA:
            raise PredictionError("live_observation_binding_required")
        expected = bind_observation(current_frame, binding.get("entity_tags"), registry, public_catalog,
                                    session_id=session_id, max_entities=binding.get("max_entities"),
                                    max_selected=binding.get("max_selected"))
        if dict(binding) != expected:
            raise PredictionError("observation_session_frame_or_registry_binding_mismatch")
        functions = _functions(registry)
        index = _integer(prediction.get("function"), "function_head")
        if index not in functions:
            raise PredictionError("unknown_function_prediction")
        function, requirements = functions[index], {"fresh_source_visibility", "paid_selection", "paid_command"}
        args = set(function["args"])
        used = {"function": index}
        evidence = result["evidence"]
        evidence.update(preceding_loop=current_frame["game_loop"], session_id=session_id,
                        player_id=binding["player_id"], observation_binding=deepcopy(binding),
                        function_id=index, function_name=function["name"], source_evidence=[], target_evidence=None)
        if function["name"] == "raw_move_camera":
            if args != {"world"} or function["ability_id"] != 0:
                raise PredictionError("camera_function_signature_mismatch")
            result["kind"] = "camera_move"
            used["world"] = _integer(prediction.get("world"), "world_head")
            result["target"] = {"kind": "world_point", "point": inverse_world(used["world"], current_frame["spatial"]["map_size"])}
            requirements = {"paid_camera"}
        else:
            if "unit_tags" not in args or not args <= _HEADS:
                raise PredictionError("function_not_supported_by_restricted_runtime")
            ability = _integer(function["ability_id"], "native_ability", 1)
            public = _catalog(public_catalog).get(str(ability), {})
            if (type(public.get("id")) is not int or public.get("id") != ability or public.get("available") is not True
                    or type(public.get("target")) is not int or public["target"] not in (1, 2, 3, 4, 5)):
                raise PredictionError("public_ability_not_supported")
            target_kind = "world" if "world" in args else "unit" if "target_unit_tag" in args else None
            if public["target"] not in {None: {1, 5}, "world": {2, 4, 5}, "unit": {3, 4}}[target_kind]:
                raise PredictionError("function_public_target_kind_mismatch")
            # Require a unique exact native ability + target signature, as in training.
            variants = [f for f in functions.values() if f["ability_id"] == ability and "unit_tags" in f["args"]
                        and ("world" if "world" in f["args"] else "unit" if "target_unit_tag" in f["args"] else None) == target_kind]
            if len(variants) != 1:
                raise PredictionError("ambiguous_native_function_inverse")
            if "queued" in args:
                used["queued"] = _integer(prediction.get("queued"), "queued_head", 0, 1)
                if used["queued"]:
                    raise PredictionError("controller_queue_not_supported")
            current, memory = _rows(current_frame)
            rows = {**memory, **current}
            tags = _source_pointers(prediction.get("unit_tags"), binding)
            used["source_tags"] = tags
            for tag in tags:
                row = rows[tag]
                if row["owner"] != 1:
                    raise PredictionError("predicted_source_not_own")
                if tag not in current:
                    requirements.update(("paid_source_reacquisition", "paid_camera_reframe"))
                evidence["source_evidence"].append({"tag": tag, "kind": "current_visible_own" if tag in current else "causal_known_own",
                                                    "type_name": _kind(row), "position": list(row["position"]),
                                                    "last_seen_loop": current_frame["game_loop"] if tag in current else row["last_seen_loop"]})
            result.update(kind="unit_command", ability_id=ability, source_tags=list(tags))
            build = is_assisted_build(ability, public)
            evidence["assisted_build_whitelist"] = build
            if public.get("native", {}).get("is_building") is True:
                requirements.add("fresh_placement_query")
            if target_kind == "world":
                used["world"] = _integer(prediction.get("world"), "world_head")
                position = inverse_world(used["world"], current_frame["spatial"]["map_size"])
                if not visible_point(current_frame, position):
                    if not build or not function["planned_build"] or not _planned_point_allowed(current_frame, position):
                        raise PredictionError("world_target_not_permitted_current_intent")
                    requirements.add("paid_camera_reframe")
                result["target"] = {"kind": "world_point", "point": position}
                evidence["target_evidence"] = {"kind": "predicted_world_intention", "position": list(position),
                                               "coordinate_provenance": "world256_cell_center"}
                requirements.add("fresh_target_visibility")
            elif target_kind == "unit":
                pointer = _integer(prediction.get("target_unit_tag"), "target_pointer", 0, binding["max_entities"] - 1)
                if pointer >= len(binding["entity_tags"]):
                    raise PredictionError("target_pointer_targets_padding")
                tag = binding["entity_tags"][pointer]
                used["target_unit_tag"] = pointer
                row = rows[tag]
                remembered_gas = (build and ability == 882 and row["owner"] == 3
                                  and "VESPENEGEYSER" in _kind(row).replace("_", ""))
                if tag not in current and not remembered_gas:
                    raise PredictionError("unit_target_not_current_visible_or_known_gas")
                if (ability in {23, 24, 25, 3674} or function["general_id"] in {23, 24, 25, 3674}
                        or public.get("name", "").upper().startswith("ATTACK")) and row["owner"] in (1, 2):
                    raise PredictionError("friendly_attack_target")
                if ability == 882 and not remembered_gas:
                    raise PredictionError("assimilator_target_not_neutral_geyser")
                result["target"] = {"kind": "unit", "tag": tag}
                evidence["target_evidence"] = {"kind": "current_visible_unit" if tag in current else "previously_seen_neutral",
                                               "owner": row["owner"], "type_name": _kind(row),
                                               "position": list(row["position"]),
                                               "last_seen_loop": current_frame["game_loop"] if tag in current else row["last_seen_loop"]}
                if tag not in current:
                    result["target"]["point"] = list(row["position"])
                    requirements.add("paid_camera_reframe")
                requirements.add("fresh_target_visibility")
        evidence["prediction_heads"] = used
        evidence["disabled_heads"] = ["delay", "repeat"]
        result["decoder_requirements"] = sorted(requirements)
        result["supervision"]["execution_class"] = "assisted" if "paid_camera_reframe" in requirements else "immediate"
        result["admitted"] = True
        result["intent_id"] = canonical_sha256(result)
    except (ValueError, KeyError, TypeError, AttributeError, IndexError) as exc:
        result["admitted"] = False
        result["reasons"] = [str(exc) or type(exc).__name__]
    return result


def prediction_integrity_valid(intent):
    """Check detached prediction identity before runtime accepts its first stage."""
    if not isinstance(intent, Mapping) or intent.get("provenance") != "policy_prediction":
        return False
    if "wire_sha256" in intent or "wire_base64" in intent:
        return False
    try:
        payload = {k: v for k, v in intent.items() if k != "intent_id"}
        return intent.get("intent_id") == canonical_sha256(payload)
    except (ValueError, TypeError):
        return False
