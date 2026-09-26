"""Pure, fail-closed UI-stage planner for normalized strategic intents.

No engine calls or raw execution. An adapter must route each paid stage through
FairPlayController and supply genuine receipts. Distant construction uses a
selected visible worker Move, then bounded arrival visits and fresh observations.
"""
from __future__ import annotations

from collections.abc import Mapping
from copy import deepcopy

from .rich_actions import _current, _kind, _records, _world_pixel
from .rich_intents import on_map, point, visible_point


def _decision(stage, *, reason=None, paid=False, **operation):
    return {"stage": stage, "reason": reason, "paid_input": paid, "operation": operation,
            "execution_authority": "existing_fairplay_controller_only", "raw_command": False}


def intent_identity(intent):
    """Separate predicted intent IDs from hashes of actually observed wire."""
    key = "intent_id" if intent.get("provenance") == "policy_prediction" else "wire_sha256"
    value = intent.get(key)
    return (key, value) if isinstance(value, str) and value else None


def identity_fields(intent):
    identity = intent_identity(intent)
    return {identity[0]: identity[1]} if identity else {}


def _identity_matches(value, intent):
    fields = identity_fields(intent)
    return bool(fields) and isinstance(value, Mapping) and all(value.get(k) == v for k, v in fields.items())


def _receipt(value, intent, frame, tags=None):
    return (_identity_matches(value, intent)
            and type(value.get("confirmed_loop")) is int
            and intent["evidence"]["preceding_loop"] <= value["confirmed_loop"] <= frame["game_loop"]
            and (tags is None or set(value.get("source_tags", [])) == set(tags)))


def _route_wait(intent, frame, confirmations, route, destination):
    if frame["game_loop"] - route["confirmed_loop"] > 1008:
        return _decision("deferred", reason="worker_route_expired_without_visible_arrival")
    visit = confirmations.get("route_visit", {})
    visited = _receipt(visit, intent, frame) and visit.get("paid") is True
    last_visit = max(route["confirmed_loop"], visit["confirmed_loop"] if visited else 0)
    if frame["game_loop"] - last_visit < 224:
        return _decision("wait", reason="worker_route_arrival_not_due", until_loop=last_visit + 224,
                         resume_economy_upkeep=True)
    return _decision("camera", paid=True, point=list(destination), purpose="worker_route_arrival")


def _worker_route(intent, frame, confirmations, sources, destination, route_valid):
    tags = intent["source_tags"]
    if (len(sources) != 1 or _kind(sources[0]) != "PROBE"
            or intent.get("evidence", {}).get("assisted_build_whitelist") is not True):
        return _decision("deferred", reason="worker_route_not_supported_for_this_intent")
    if route_valid:
        return _route_wait(intent, frame, confirmations, confirmations["route"], destination)
    selection = confirmations.get("selection", {})
    if (not _receipt(selection, intent, frame, tags) or selection.get("paid") is not True
            or frame.get("selection_complete") is not True or set(frame.get("selection", [])) != set(tags)):
        return _decision("select", paid=True, source_tags=list(tags), selection_mode="point",
                         purpose="construction_worker_route")
    if 16 not in {a.get("ability_id") for a in frame.get("available_abilities", [])}:
        return _decision("deferred", reason="selected_worker_move_not_available")
    return _decision("route_move", paid=True, ability_id=16, source_tags=list(tags),
                     target={"kind": "world_point", "point": list(destination)},
                     minimap=True, queued=False, reserve_worker=True,
                     require_observed_point_order=True, route_timeout_loops=1008)


def plan_next(intent: Mapping, frame: Mapping, *, confirmations: Mapping | None = None) -> dict:
    """Return one proposed stage; only actual receipts establish completion.

    Confirmation keys: ``camera`` / ``selection`` / ``command`` use the native
    wire_sha256 (observed replay) or intent_id (policy prediction) and
    confirmed_loop, plus paid=True for camera/selection and
    accepted=True for command. Selection/command also name source_tags.
    ``placement`` requires checked_loop equal to the current frame, valid=True,
    matching identity and exact target. Queries are permitted-screen only.
    ``route`` uses the command receipt fields plus destination and
    point_order_confirmed=True (actual visible own order, not an assumed Move).
    ``route_visit`` uses a paid camera receipt. Visits are ten seconds apart;
    unsuccessful routes expire after 45 seconds. ``supports_queue`` defaults
    false because the existing controller does not yet emit queued commands.
    A host must also bound retries before any route has been accepted.
    """
    confirmations = confirmations or {}
    if intent.get("admitted") is not True or intent.get("schema") != 1:
        return _decision("rejected", reason="intent_not_admitted")
    if intent_identity(intent) is None:
        return _decision("rejected", reason="intent_identity_missing")
    if (type(frame.get("game_loop")) is not int or frame["game_loop"] < intent["evidence"]["preceding_loop"]):
        return _decision("rejected", reason="stale_decoder_observation")
    target = intent.get("target")
    if intent["kind"] == "camera_move":
        if _receipt(confirmations.get("camera"), intent, frame) and confirmations["camera"].get("paid") is True:
            return _decision("complete")
        if not target or not on_map(frame, target.get("point")):
            return _decision("rejected", reason="camera_map_bounds_unverified")
        return _decision("camera", paid=True, point=list(target["point"]))
    if intent.get("queued") and confirmations.get("supports_queue") is not True:
        return _decision("deferred", reason="controller_queue_not_supported")
    tags = intent.get("source_tags", [])
    if _receipt(confirmations.get("command"), intent, frame, tags) and confirmations["command"].get("accepted") is True:
        return _decision("complete")
    current = {t: r for t, r in _records(frame, "entities").items()
               if _current(r) and point(r.get("position")) and visible_point(frame, r["position"])}
    sources = [current.get(t) for t in tags]
    missing = [t for t, r in zip(tags, sources) if not r or r.get("owner") != 1]
    planned_position = target.get("point") if target else None
    route = confirmations.get("route", {})
    route_valid = (_receipt(route, intent, frame, tags) and route.get("accepted") is True
                   and route.get("point_order_confirmed") is True
                   and point(planned_position) and route.get("destination") == planned_position)
    if route_valid and missing:
        return _route_wait(intent, frame, confirmations, route, planned_position)
    if missing:
        memory = _records(frame, "known_own")
        row = memory.get(missing[0])
        if (not row or row.get("owner", 1) != 1 or type(row.get("last_seen_loop")) is not int
                or not 0 <= row["last_seen_loop"] <= frame["game_loop"] or not on_map(frame, row.get("position"))):
            return _decision("deferred", reason="source_reacquisition_has_no_causal_location")
        if visible_point(frame, row["position"]):
            return _decision("deferred", reason="source_absent_at_last_seen_location")
        return _decision("camera", paid=True, point=list(row["position"]), purpose="reacquire_known_own_source")
    target_position = None
    if target:
        if target["kind"] == "world_point":
            target_position = target["point"]
        else:
            target_row = current.get(target["tag"])
            if target_row:
                original = intent.get("evidence", {}).get("target_evidence") or {}
                if target_row.get("owner") != original.get("owner"):
                    return _decision("deferred", reason="target_ownership_changed")
                if intent["ability_id"] == 882 and (target_row.get("owner") != 3
                        or "VESPENEGEYSER" not in _kind(target_row).replace("_", "")):
                    return _decision("deferred", reason="gas_target_no_longer_neutral_geyser")
                if intent["ability_id"] in {23, 24, 25, 3674} and target_row.get("owner") in (1, 2):
                    return _decision("rejected", reason="friendly_attack_target")
                target_position = target_row["position"]
            elif intent.get("evidence", {}).get("target_evidence", {}).get("kind") == "previously_seen_neutral":
                target_position = target.get("point")
                if visible_point(frame, target_position):
                    return _decision("deferred", reason="remembered_neutral_not_reobserved")
            else:
                return _decision("deferred", reason="unit_target_not_currently_visible")
        if not on_map(frame, target_position):
            return _decision("rejected", reason="target_outside_known_map")
    if target_position and not visible_point(frame, target_position):
        if "paid_camera_reframe" not in intent["decoder_requirements"]:
            return _decision("deferred", reason="target_no_longer_visible")
        points = [r["position"] for r in sources] + [target_position]
        lo = [min(p[i] for p in points) for i in (0, 1)]
        hi = [max(p[i] for p in points) for i in (0, 1)]
        spatial = frame.get("spatial", {})
        pixel = _world_pixel(frame, target_position)
        size = spatial.get("screen_size", [])
        if pixel is not None and len(size) == 2 and all(0 <= p < s for p, s in zip(pixel, size)):
            return _worker_route(intent, frame, confirmations, sources, target_position, route_valid)
        width, height = spatial.get("camera_width", 0), spatial.get("camera_height", 0)
        if hi[0] - lo[0] >= width - 2 or hi[1] - lo[1] >= height - 2:
            return _worker_route(intent, frame, confirmations, sources, target_position, route_valid)
        return _decision("camera", paid=True, point=[(a + b) / 2 for a, b in zip(lo, hi)],
                         purpose="frame_current_source_and_planned_target")
    if "fresh_placement_query" in intent["decoder_requirements"]:
        proof = confirmations.get("placement", {})
        valid = (_identity_matches(proof, intent)
                 and proof.get("checked_loop") == frame["game_loop"] and proof.get("target") == target)
        if not valid:
            return _decision("placement_query", ability_id=intent["ability_id"], target=deepcopy(target))
        if proof.get("valid") is not True:
            return _decision("deferred", reason="placement_not_currently_legal")
    selection = confirmations.get("selection", {})
    if (not _receipt(selection, intent, frame, tags) or selection.get("paid") is not True
            or frame.get("selection_complete") is not True or set(frame.get("selection", [])) != set(tags)):
        return _decision("select", paid=True, source_tags=list(tags),
                         selection_mode="point" if len(tags) == 1 else "rectangle")
    if intent["ability_id"] not in {a.get("ability_id") for a in frame.get("available_abilities", [])}:
        return _decision("deferred", reason="selected_ability_not_currently_available")
    return _decision("command", paid=True, ability_id=intent["ability_id"], source_tags=list(tags),
                     target=deepcopy(target), queued=intent["queued"])
