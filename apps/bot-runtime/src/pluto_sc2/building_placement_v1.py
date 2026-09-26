"""Observation-only, conservative static-structure placement exclusions.

This proves square-footprint overlap only, never complete placement legality.
It reads neither intentions nor expert labels. No terrain/unit render raster,
remembered occupancy, power, resources, movement, engine query or model is used.
Unknown metadata stays permissive. Consumers must INTERSECT existing fog masks.
"""
from __future__ import annotations

from collections.abc import Mapping
import math

import numpy as np

from .alphastar_tensor import _current_visible

SCHEMA = "observed-building-placement-v1"
CLASS_SIZES = (2, 3, 5)
WORLD_SIZE = 256
POSITION_EPSILON = 1 / 256
PLACEMENT_SNAP_MARGIN = .5
_FRAME_KEYS = {"schema", "game_loop", "camera", "hud", "alerts", "entities", "known_own", "selection",
               "selection_complete", "ui", "spatial", "available_abilities", "feature_layers", "own_upgrades",
               "known_neutral", "intervening_selection_input"}
# Reviewed square construction footprints. Public native metadata must agree.
# Gas is an observed obstacle, but its unit-target construction is not masked.
_SQUARES = (
    (59, "Nexus", 880, 5), (60, "Pylon", 881, 2), (61, "Assimilator", 882, 3),
    (62, "Gateway", 883, 3), (63, "Forge", 884, 3), (64, "FleetBeacon", 885, 3),
    (65, "TwilightCouncil", 886, 3), (66, "PhotonCannon", 887, 2),
    (67, "Stargate", 889, 3), (68, "TemplarArchive", 890, 3),
    (69, "DarkShrine", 891, 2), (70, "RoboticsBay", 892, 3),
    (71, "RoboticsFacility", 893, 3), (72, "CyberneticsCore", 894, 3),
    (1910, "ShieldBattery", 895, 2),
)


class PlacementError(ValueError):
    pass


def _finite(value):
    return type(value) in (int, float) and math.isfinite(value)


def _point(value):
    return isinstance(value, (list, tuple)) and len(value) == 2 and all(_finite(x) for x in value)


def _public_squares(catalog):
    if (not isinstance(catalog, Mapping) or not isinstance(catalog.get("units"), Mapping)
            or not isinstance(catalog.get("abilities"), Mapping)):
        raise PlacementError("Public native unit and ability metadata required")
    result = {}
    for type_id, name, ability_id, size in _SQUARES:
        unit = catalog["units"].get(str(type_id), {})
        ability = catalog["abilities"].get(str(ability_id), {})
        if not isinstance(unit, Mapping) or not isinstance(ability, Mapping):
            continue
        native = ability.get("native", {})
        target = 3 if ability_id == 882 else 2
        if (not isinstance(native, Mapping) or unit.get("unit_id") != type_id
                or unit.get("name") != name or unit.get("ability_id") != ability_id
                or unit.get("race") != 3 or unit.get("available") is not True
                or not isinstance(unit.get("attributes"), list) or 8 not in unit["attributes"]
                or ability.get("id") != ability_id or ability.get("name") != "ProtossBuild"
                or ability.get("target") != target or ability.get("remaps_to_ability_id", 0) != 0
                or native.get("ability_id") != ability_id or native.get("link_name") != "ProtossBuild"
                or native.get("button_name") != name or native.get("target") != target
                or native.get("is_building") is not True or not _finite(native.get("footprint_radius"))
                or native["footprint_radius"] != size / 2):
            continue
        result[type_id] = {"type_id": type_id, "type_name": name, "ability_id": ability_id,
                           "size": size, "radius": size / 2, "point_target": target == 2}
    return result


def _observation(frame, catalog):
    if (not isinstance(frame, Mapping) or frame.get("schema") != "protoss-rich-replay-v1"
            or set(frame) - _FRAME_KEYS):
        raise PlacementError("Require observation-only rich frame, never sample or expert fields")
    loop, spatial = frame.get("game_loop"), frame.get("spatial", {})
    if type(loop) is not int or loop < 0 or not isinstance(spatial, Mapping):
        raise PlacementError("Invalid current observation")
    size = spatial.get("map_size")
    if (not _point(size) or any(type(v) is not int or not 1 <= v <= 4096 for v in size)
            or not _point(frame.get("camera"))):
        raise PlacementError("Invalid public map transform")
    rows = frame.get("entities")
    if not isinstance(rows, list) or any(not isinstance(row, Mapping) for row in rows):
        raise PlacementError("Invalid current entity collection")
    public = _public_squares(catalog)
    structures, ignored = [], []
    tags = set()
    for row in rows:
        tag = row.get("tag")
        if type(tag) is not int or not 0 < tag < 2**64 or tag in tags:
            raise PlacementError("Invalid or duplicate current entity identity")
        tags.add(tag)
        # Never fall back to memory, even for own structures. A unit in the
        # collection without current screen visibility is insufficient evidence.
        if (not _point(row.get("position")) or not _current_visible(row, frame)
                or not all(0 <= x < limit for x, limit in zip(row["position"], size))
                or row.get("last_seen_loop", loop) != loop):
            ignored.append({"tag": tag, "reason": "not_current_visible"})
            continue
        metadata = public.get(row.get("type_id"))
        if (metadata is None or not isinstance(row.get("type_name"), str)
                or row["type_name"].upper() != metadata["type_name"].upper()):
            continue
        if (row.get("is_flying") is not False or row.get("is_hallucination") is not False
                or not _finite(row.get("health")) or row["health"] <= 0):
            ignored.append({"tag": tag, "reason": "grounded_real_living_structure_unproven"})
            continue
        structures.append({**metadata, "tag": tag, "owner": row["owner"],
                           "position": list(row["position"])})
    structures.sort(key=lambda row: row["tag"])
    return public, structures, ignored


def _margin(frame, quantized):
    # An integer/half-integer placement lattice can move a click by up to0.5
    # on either axis. Include screen-pixel rounding as well as native numeric
    # uncertainty; world labels represent an entire cell, not just its center.
    spatial = frame["spatial"]
    screen = spatial.get("screen_size")
    camera = (spatial.get("camera_width"), spatial.get("camera_height"))
    if (not _point(screen) or any(type(v) is not int or v <= 0 for v in screen)
            or not all(_finite(v) and v > 0 for v in camera)):
        return None
    cell = max(spatial["map_size"]) / WORLD_SIZE / 2 if quantized else 0
    return [PLACEMENT_SNAP_MARGIN + POSITION_EPSILON + cell + extent / pixels / 2
            for extent, pixels in zip(camera, screen)]


def build_placement_constraints(frame, catalog, ability_id):
    """Return auditable current static geometry; no target or labels are read."""
    public, structures, ignored = _observation(frame, catalog)
    candidate = next((row for row in public.values()
                      if row["ability_id"] == ability_id and row["point_target"]), None)
    return {"schema": SCHEMA, "game_loop": frame["game_loop"], "ability_id": ability_id,
            "candidate": candidate, "structures": structures, "ignored_entities": ignored,
            "map_size": list(frame["spatial"]["map_size"]), "exact_margin": _margin(frame, False),
            "quantized_margin": _margin(frame, True), "memory_used": False,
            "render_occupancy_used": False, "authoritative_placement_query": False}


def _covered(frame, point, radius, margin):
    spatial = frame["spatial"]
    try:
        width, height = spatial["screen_size"]
        cx, cy = frame["camera"]
        cw, ch = spatial["camera_width"], spatial["camera_height"]
        x0 = math.floor(width / 2 + (point[0] - radius - margin[0] - cx) * width / cw)
        x1 = math.ceil(width / 2 + (point[0] + radius + margin[0] - cx) * width / cw)
        y0 = math.floor(height / 2 - (point[1] + radius + margin[1] - cy) * height / ch)
        y1 = math.ceil(height / 2 - (point[1] - radius - margin[1] - cy) * height / ch)
        visibility = np.asarray(spatial["screen_visibility"])
        return bool(visibility.shape == (height, width) and 0 <= x0 <= x1 < width
                    and 0 <= y0 <= y1 < height and np.all(visibility[y0:y1 + 1, x0:x1 + 1] == 2))
    except (KeyError, TypeError, ValueError, ZeroDivisionError):
        return False


def assess_placement(frame, catalog, ability_id, point, *, quantized=False):
    """Tri-state overlap audit for an exact point or decoded world256 center.

    ``quantized=True`` accounts for any point encoded into that cell and its
    placement snap. This deliberately retains boundary-overlap uncertainty.
    ``no_observed_conflict`` never certifies power/terrain/pathing/legality.
    """
    if not _point(point) or type(quantized) is not bool or type(ability_id) is not int:
        raise PlacementError("Finite point, boolean quantization mode and integer ability required")
    result = build_placement_constraints(frame, catalog, ability_id)
    margin = result["quantized_margin" if quantized else "exact_margin"]
    result.update(point=list(point), quantized=quantized, state="unknown", exclude=False,
                  conflicts=[], uncertain_overlaps=[], footprint_observed=False)
    candidate = result["candidate"]
    if candidate is None or margin is None or not all(0 <= v < m for v, m in zip(point, result["map_size"])):
        result["reason"] = "candidate_or_coordinate_contract_unproven"
        return result
    for structure in result["structures"]:
        delta = [abs(v - occupied) for v, occupied in zip(point, structure["position"])]
        total_radius = candidate["radius"] + structure["radius"]
        if all(distance + uncertainty < total_radius for distance, uncertainty in zip(delta, margin)):
            result["conflicts"].append(structure["tag"])
        elif all(max(0, distance - uncertainty) < total_radius for distance, uncertainty in zip(delta, margin)):
            result["uncertain_overlaps"].append(structure["tag"])
    result["footprint_observed"] = _covered(frame, point, candidate["radius"], margin)
    if result["conflicts"]:
        result.update(state="proven_conflict", exclude=True, reason="overlap_for_all_bounded_centers")
    elif result["uncertain_overlaps"] or not result["footprint_observed"]:
        result["reason"] = "boundary_or_unobserved_occupancy_uncertain"
    else:
        result.update(state="no_observed_conflict", reason="no_current_known_square_overlap")
    return result


def registry_class_indices(registry, catalog):
    """Return0/1/2 for reviewed2/3/5 squares; -1 for all other functions."""
    if (not isinstance(registry, list) or not registry
            or any(not isinstance(row, Mapping) or row.get("id") != i or type(row.get("id")) is not int
                   or not isinstance(row.get("name"), str) for i, row in enumerate(registry))
            or len({row["name"] for row in registry}) != len(registry)):
        raise PlacementError("Require unique contiguous ordered function registry")
    public = _public_squares(catalog)
    abilities = {row["ability_id"]: row for row in public.values() if row["point_target"]}
    classes = []
    for row in registry:
        candidate = abilities.get(row.get("ability_id"))
        valid = (candidate is not None and row["name"] == "Build_" + candidate["type_name"] + "_pt"
                 and row.get("general_id", 0) == 0 and row.get("args") == ["queued", "unit_tags", "world"])
        classes.append(CLASS_SIZES.index(candidate["size"]) if valid else -1)
    return np.asarray(classes, dtype=np.int32)


def build_placement_masks(frame, registry, catalog, *, world_size=256):
    """Return supplemental bool[3,256,256] and function_classes[F](-1=ones).

    Only proven overlaps areFalse. Padded/unknown/fog locations remainTrue here;
    callers must intersect the existing world/camera/fog masks, never replace.
    """
    if type(world_size) is not int or world_size != WORLD_SIZE:
        raise PlacementError("This version supports only the frozen world256 transform")
    _, structures, ignored = _observation(frame, catalog)
    classes = registry_class_indices(registry, catalog)
    mask = np.ones((len(CLASS_SIZES), world_size, world_size), dtype=np.bool_)
    margin = _margin(frame, True)
    if margin is not None:
        width, height = frame["spatial"]["map_size"]
        scale = max(width, height) / world_size
        rows, columns = np.indices((world_size, world_size))
        x, y = (columns + .5) * scale, height - (rows + .5) * scale
        on_map = (x >= 0) & (x < width) & (y >= 0) & (y < height)
        for index, size in enumerate(CLASS_SIZES):
            for structure in structures:
                total_radius = size / 2 + structure["radius"]
                conflict = ((np.abs(x - structure["position"][0]) + margin[0] < total_radius)
                            & (np.abs(y - structure["position"][1]) + margin[1] < total_radius) & on_map)
                mask[index] &= ~conflict
    return {"schema": SCHEMA, "masks": mask, "function_classes": classes,
            "class_sizes": list(CLASS_SIZES), "margin": margin, "structures": structures,
            "ignored_entities": ignored, "requires_existing_mask_intersection": True,
            "graph_enabled": False, "memory_used": False, "render_occupancy_used": False}
