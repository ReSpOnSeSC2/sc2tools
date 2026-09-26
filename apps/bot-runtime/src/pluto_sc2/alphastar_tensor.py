"""Causal rich replay -> official AlphaStar input tensors (NumPy only).

No SC2, Torch, JAX or game commands are imported here. Missing features are
zero *storage* with explicit knownness, never claims that an unknown value was
observed zero. The network bridge must encode the accompanying knownness.
"""
from __future__ import annotations

import base64
from dataclasses import dataclass
import math

import numpy as np

SCHEMA = "alphastar-rich-tensor-v1"
HEADS = ("function", "delay", "queued", "repeat", "unit_tags", "target_unit_tag", "world")
DISABLED_HEADS = ("delay", "repeat")
FEATURES = dict(unit_type=0, alliance=1, health=2, shield=3, energy=4,
                cargo_space_taken=5, build_progress=6, health_ratio=7, shield_ratio=8,
                energy_ratio=9, display_type=10, owner=11, x=12, y=13, facing=14,
                radius=15, cloak=16, is_selected=17, is_blip=18, is_powered=19,
                mineral_contents=20, vespene_contents=21, cargo_space_max=22,
                assigned_harvesters=23, ideal_harvesters=24, weapon_cooldown=25,
                order_length=26, order_id_0=27, order_id_1=28, tag=29,
                hallucination=30, buff_id_0=31, buff_id_1=32, addon_unit_type=33,
                active=34, is_on_screen=35, order_progress_0=36, order_progress_1=37,
                order_id_2=38, order_id_3=39, is_in_cargo=40, buff_duration_remain=41,
                buff_duration_max=42, attack_upgrade_level=43, armor_upgrade_level=44,
                shield_upgrade_level=45)
PLAYER_FIELDS = ("player_id", "minerals", "vespene", "food_used", "food_cap", "food_army",
                 "food_workers", "idle_worker_count", "army_count", "warp_gate_count", "larva_count")
MINIMAP_MAX = dict(height_map=255, visibility_map=2, creep=1, player_relative=4,
                   alerts=5, pathable=1, buildable=1)


class TensorError(ValueError):
    """A sample cannot be represented faithfully by this bridge."""


def _int(value, name, minimum=0, maximum=2**31 - 1):
    if isinstance(value, bool) or not isinstance(value, (int, np.integer)) or not minimum <= value <= maximum:
        raise TensorError(f"Invalid {name}: expected integer in [{minimum},{maximum}]")
    return int(value)


def _number(value, name, minimum=0):
    if isinstance(value, bool) or not isinstance(value, (int, float)) or not math.isfinite(value) or value < minimum:
        raise TensorError(f"Invalid {name}")
    return float(value)


def decode_image(image):
    """Decode captured native ImageData without resizing or flipping it."""
    width = _int(image.get("size", {}).get("x"), "image width", 1, 4096)
    height = _int(image.get("size", {}).get("y"), "image height", 1, 4096)
    bits = image.get("bits_per_pixel")
    if bits not in (1, 8, 16, 32):
        raise TensorError("Unsupported image depth")
    try:
        payload = base64.b64decode(image["data"], validate=True)
    except (KeyError, ValueError, TypeError) as exc:
        raise TensorError("Invalid image payload") from exc
    expected = (width * height * bits + 7) // 8
    if len(payload) != expected:
        raise TensorError("Image byte count mismatch")
    if bits == 1:
        values = np.unpackbits(np.frombuffer(payload, np.uint8))[:width * height]
    else:
        values = np.frombuffer(payload, {8: np.uint8, 16: "<u2", 32: "<u4"}[bits])
    if np.any(values > np.iinfo(np.int32).max):
        raise TensorError("Image does not fit int32")
    return values.astype(np.int32).reshape(height, width)


@dataclass(frozen=True)
class TensorConfig:
    max_entities: int = 128
    max_selected: int = 64
    world_size: int = 256
    minimap_size: int = 64
    unit_features: int = 48  # 46 PySC2 fields, followed by two ablated previous-argument flags.

    def __post_init__(self):
        if not 2 <= self.max_entities <= 512 or not 1 <= self.max_selected <= 64:
            raise TensorError("Invalid bounded entity/selection shape")
        if self.world_size != 256 or self.minimap_size != 64 or self.unit_features != 48:
            raise TensorError("This bridge validates native64 minimap/world256/48 features only")


def world_pixel(point, map_size, size=256):
    """PySC2 convention: isotropic max-map-dimension scale, top-left y origin."""
    if not isinstance(point, (list, tuple)) or len(point) != 2:
        raise TensorError("Missing world point")
    width, height = (_int(v, "map dimension", 1, 4096) for v in map_size)
    x, y = (_number(v, "world coordinate") for v in point)
    if not (x < width and y < height):
        raise TensorError("World point outside public map bounds")
    scale = size / max(width, height)
    return (min(size - 1, int(x * scale)), min(size - 1, int((height - y) * scale)))


def resolve_function(intent, registry):
    """Exact native ability ID plus argument kind, without general-ID guesses."""
    if intent.get("admitted") is not True:
        raise TensorError("Intent was not admitted")
    target = intent.get("target")
    target_kind = target.get("kind") if isinstance(target, dict) else None
    if intent.get("kind") == "camera_move":
        candidates = [row for row in registry if row["name"] == "raw_move_camera"]
        if target_kind != "world_point":
            raise TensorError("Camera movement needs a world target")
    elif intent.get("kind") == "unit_command":
        ability = _int(intent.get("ability_id"), "native ability", 1)
        expected = {None: None, "unit": "target_unit_tag", "world_point": "world"}.get(target_kind, "invalid")
        candidates = []
        for row in registry:
            args = set(row["args"])
            actual = "world" if "world" in args else "target_unit_tag" if "target_unit_tag" in args else None
            if row["ability_id"] == ability and actual == expected and "unit_tags" in args:
                candidates.append(row)
    else:
        raise TensorError("Unsupported intent kind")
    if len(candidates) != 1:
        raise TensorError(f"Exact RAW_FUNCTION mapping count {len(candidates)}")
    return candidates[0]


def _current_visible(row, frame):
    if row.get("is_on_screen") is not True or row.get("is_visible") is not True:
        return False
    if row.get("owner") not in (1, 3, 4):
        return False
    if row["owner"] == 4 and row.get("cloak_state") not in (2, 3):
        return False
    try:
        cx, cy = frame["camera"]
        x, y = row["position"]
        spatial = frame["spatial"]
        visibility = np.asarray(spatial["screen_visibility"])
        height, width = visibility.shape
        px = round(width / 2 + (x - cx) * width / spatial["camera_width"])
        py = round(height / 2 - (y - cy) * height / spatial["camera_height"])
        return 0 <= px < width and 0 <= py < height and visibility[py, px] == 2
    except (KeyError, TypeError, ValueError, ZeroDivisionError):
        return False


def tensorize_observation(frame, registry, unit_type_mapping, config=TensorConfig(), *, step_type=1):
    """Encode one permitted frame without an expert action or replay record.

    Returns flat tuple-key observation inputs plus ``step_type``, and metadata
    with the exact entity pointer ordering for a separate live-session binding.
    No labels, behaviour features, source permissions or action timestamps are
    synthesized. ``step_type`` is the caller's actual FIRST=0/MID=1/LAST=2.
    Current enemy energy/orders/cargo are ignored even if a malicious input adds
    them. Stale own rows use only type/last-seen position and have explicit age
    and currentness. Remembered neutral geysers retain their separate mask;
    ordinary unit targets require current screen visibility.
    """
    if frame.get("schema") != "protoss-rich-replay-v1":
        raise TensorError("Unsupported rich frame schema")
    before = _int(frame.get("game_loop"), "game_loop")
    step_type = _int(step_type, "step_type", 0, 2)
    spatial = frame["spatial"]
    map_size = spatial["map_size"]
    current = {}
    for row in frame.get("entities", []):
        tag = _int(row.get("tag"), "entity tag", 1, 2**64 - 1)
        if tag in current:
            raise TensorError("Duplicate current entity")
        if not _current_visible(row, frame):
            raise TensorError("Entity is not independently confirmed current screen-visible")
        current[tag] = row
    remembered = {}
    for row in frame.get("known_own", []):
        tag = _int(row.get("tag"), "remembered tag", 1, 2**64 - 1)
        if row.get("owner") != 1 or tag in remembered:
            raise TensorError("Invalid own memory ownership or duplicate")
        _int(row.get("last_seen_loop"), "last_seen_loop", 0, before)
        if tag not in current:
            remembered[tag] = row
    neutral_memory = {}
    for row in frame.get("known_neutral", []):
        tag = _int(row.get("tag"), "remembered neutral tag", 1, 2**64 - 1)
        if row.get("owner") != 3 or tag in neutral_memory or tag in remembered:
            raise TensorError("Invalid neutral memory ownership or duplicate")
        _int(row.get("last_seen_loop"), "neutral last_seen_loop", 0, before)
        if tag not in current:
            neutral_memory[tag] = row
    own_memory_count = len(remembered)
    remembered.update(neutral_memory)
    tags = sorted(current) + sorted(remembered)
    if len(tags) > config.max_entities:
        raise TensorError("Entity overflow: no silent truncation")
    indices = {tag: index for index, tag in enumerate(tags)}
    raw = np.zeros((config.max_entities, config.unit_features), np.int32)
    known = np.zeros_like(raw, dtype=np.float32)
    memory = np.zeros((config.max_entities, 2), np.float32)
    for index, tag in enumerate(tags):
        row = current.get(tag, remembered.get(tag))
        visible = tag in current
        memory[index] = (int(visible), 0 if visible else min(1., (before - row["last_seen_loop"]) / 2240.))

        def put(name, value):
            offset = FEATURES[name]
            raw[index, offset] = _int(int(value), name)
            known[index, offset] = 1

        original_type = _int(row.get("type_id"), "unit type", 1)
        mapped = unit_type_mapping.get(original_type)
        if mapped is not None and 0 < mapped < 256:
            put("unit_type", mapped)
        # Unknown public unit types retain their pointer, but the type is marked unknown.
        put("alliance", row["owner"])
        put("tag", index + 1)  # Presence token only; persistent 64bit identity stays in the sidecar.
        put("is_on_screen", int(visible))
        put("display_type", 1 if visible else 2)
        x, y = world_pixel(row["position"], map_size, config.world_size)
        put("x", x)
        put("y", y)
        if not visible:
            # An offscreen known UI-selected unit is selectable, not known in cargo.
            if (row["owner"] == 1 and frame.get("selection_complete") is True
                    and tag in frame.get("selection", [])):
                put("is_in_cargo", 0)
            continue
        put("is_blip", 0)
        put("is_in_cargo", 0)
        for name, source_name in (("health", "health"), ("shield", "shield"),
                                  ("build_progress", "build_progress"), ("cloak", "cloak_state"),
                                  ("hallucination", "is_hallucination"), ("is_selected", "is_selected")):
            if source_name in row:
                value = row[source_name]
                if name == "build_progress":
                    value = _number(value, name) * 100
                elif isinstance(value, bool):
                    value = int(value)
                else:
                    value = _number(value, name)
                put(name, int(value))
        for field in ("health", "shield"):
            if field in row and row.get(field + "_max", 0) > 0:
                put(field + "_ratio", min(255, int(255 * row[field] / row[field + "_max"])))
        if row["owner"] == 1:
            for name in ("energy", "assigned_harvesters", "ideal_harvesters", "weapon_cooldown"):
                if name in row:
                    put(name, int(_number(row[name], name)))
            if "energy" in row and row.get("energy_max", 0) > 0:
                put("energy_ratio", min(255, int(255 * row["energy"] / row["energy_max"])))
            if "orders" in row:
                put("order_length", len(row["orders"]))
                for order_index, order in enumerate(row["orders"][:4]):
                    matches = [r for r in registry if r["ability_id"] == order.get("ability_id")]
                    # PySC2 converter order IDs use raw function IDs; only unambiguous exact mappings here.
                    if len(matches) == 1:
                        put(f"order_id_{order_index}", matches[0]["id"])
                    if order_index < 2 and "progress" in order:
                        put(f"order_progress_{order_index}", int(100 * _number(order["progress"], "progress")))

    inputs = {("observation", "raw_units"): raw,
              ("observation", "raw_knownness"): known,
              ("observation", "memory_status"): memory,
              ("observation", "game_loop"): np.asarray(before, np.int32)}
    current_target = np.zeros(config.max_entities, np.bool_)
    known_geyser = np.zeros(config.max_entities, np.bool_)
    for tag, index in indices.items():
        current_target[index] = tag in current
        row = current.get(tag, remembered.get(tag))
        known_geyser[index] = row["owner"] == 3 and "geyser" in row.get("type_name", "").lower()
    inputs["observation", "current_target_mask"] = current_target
    inputs["observation", "known_geyser_mask"] = known_geyser
    # Proto scalar omission means unavailable here, not inferred zero. Its separate mask is encoded.
    player = np.zeros(len(PLAYER_FIELDS), np.int32)
    player_known = np.zeros(len(PLAYER_FIELDS), np.float32)
    for index, name in enumerate(PLAYER_FIELDS):
        if name in frame.get("hud", {}):
            player[index] = _int(frame["hud"][name], name)
            player_known[index] = 1
    inputs["observation", "player"] = player
    inputs["observation", "player_knownness"] = player_known
    counts = np.zeros(256, np.int32)
    for index, tag in enumerate(tags):
        if tag in current and current[tag]["owner"] == 1 and known[index, FEATURES["unit_type"]]:
            counts[raw[index, FEATURES["unit_type"]]] += 1
    inputs["observation", "unit_counts_bow"] = counts  # Explicitly camera-current counts, never global.
    # These unavailable conditioning features are explicitly ablated in model composition.
    inputs["observation", "mmr"] = np.asarray(0, np.int32)
    for name in ("home_race_requested", "away_race_requested", "away_race_observed"):
        inputs["observation", name] = np.asarray(0, np.int32)
    inputs["observation", "upgrades_fixed_length"] = np.full(32, -1, np.int32)
    layers = frame.get("feature_layers", {}).get("minimap_renders", {})
    for name, maximum in MINIMAP_MAX.items():
        if name not in layers:
            raise TensorError(f"Missing native minimap layer {name}; no fabricated plane")
        values = decode_image(layers[name])
        if values.shape != (config.minimap_size, config.minimap_size) or np.any(values > maximum):
            raise TensorError(f"Invalid native minimap layer {name}")
        inputs["observation", "minimap_" + name] = values.astype(np.uint8)
    width, height = map_size
    scale = config.world_size / max(width, height)
    cx, cy = frame["camera"]
    rows, columns = np.indices((config.world_size, config.world_size))
    world_x, world_y = (columns + .5) / scale, height - (rows + .5) / scale
    camera = ((np.abs(world_x - cx) <= spatial["camera_width"] / 2)
              & (np.abs(world_y - cy) <= spatial["camera_height"] / 2)
              & (world_x < width) & (world_y >= 0) & (world_y < height))
    inputs["observation", "camera"] = camera.astype(np.int32)
    # This is intent legality, not a substitute viewport. It is computed for
    # every candidate from public feature planes without consulting the label.
    visible_buildable = ((inputs["observation", "minimap_visibility_map"] == 2)
                        & (inputs["observation", "minimap_buildable"] == 1))
    planned_build_mask = np.repeat(np.repeat(visible_buildable, 4, axis=0), 4, axis=1)
    planned_build_mask &= (world_x < width) & (world_y >= 0) & (world_y < height)
    inputs["observation", "planned_build_mask"] = planned_build_mask
    inputs["observation", "camera_position"] = np.asarray(world_pixel(frame["camera"], map_size), np.int32)
    inputs["observation", "camera_size"] = np.asarray(
        [int(spatial["camera_width"] * scale), int(spatial["camera_height"] * scale)], np.int32)
    inputs["step_type"] = np.asarray(step_type, np.int32)
    return {"inputs": inputs,
            "metadata": {"schema": SCHEMA, "game_loop": before,
                         "player_id": frame.get("hud", {}).get("player_id"), "entity_tags": tags,
                         "current_entity_count": len(current), "remembered_own_count": own_memory_count,
                         "remembered_neutral_count": len(neutral_memory),
                         "unknown_type_count": sum(not known[i, 0] for i in range(len(tags)))}}


def tensorize_sample(sample, registry, unit_type_mapping, config=TensorConfig()):
    """Add strictly causal replay supervision to the shared observation encoder.

    The observation is constructed without consulting the expert action. Label
    source and target permissions are checked separately; their failure never
    manufactures an observation or expands its entity/camera/fog masks.
    """
    frame, intent = sample["frame"], sample["intent"]
    before = _int(sample.get("preceding_loop"), "preceding_loop")
    action_loop = _int(sample.get("action_loop"), "action_loop", 1)
    if frame.get("game_loop") != before or not before < action_loop:
        raise TensorError("Observation must be strictly before the action")
    function = resolve_function(intent, registry)
    sources = intent.get("source_tags", [])
    if len(sources) > config.max_selected or len(set(sources)) != len(sources):
        raise TensorError("Selection exceeds shape or has duplicate tags")
    if any(isinstance(tag, bool) or not isinstance(tag, int) or tag <= 0 for tag in sources):
        raise TensorError("Invalid source tag")
    if ("unit_tags" in function["args"]) != bool(sources):
        raise TensorError("Function source argument mismatch")
    if not isinstance(intent.get("queued"), bool):
        raise TensorError("Queue flag must be explicit boolean")
    # Independent MID supervised event, not a trajectory boundary label.
    encoded = tensorize_observation(frame, registry, unit_type_mapping, config, step_type=1)
    inputs, metadata = encoded["inputs"], encoded["metadata"]
    tags = metadata["entity_tags"]
    indices = {tag: index for index, tag in enumerate(tags)}
    current_target = inputs["observation", "current_target_mask"]
    known_geyser = inputs["observation", "known_geyser_mask"]
    raw = inputs["observation", "raw_units"]
    for tag in sources:
        index = indices.get(tag)
        if index is None or raw[index, FEATURES["alliance"]] != 1:
            raise TensorError("Source pointer is not known own entity")
        if not current_target[index] and (frame.get("selection_complete") is not True or tag not in frame["selection"]):
            raise TensorError("Offscreen source lacks complete current UI selection")
    labels = {name: np.asarray(0, np.int32) for name in HEADS}
    labels["function"] = np.asarray(function["id"], np.int32)
    labels["queued"] = np.asarray(int(intent["queued"]), np.int32)
    labels["unit_tags"] = np.full(config.max_selected, config.max_entities, np.int32)
    labels["unit_tags"][:len(sources)] = [indices[tag] for tag in sources]
    target = intent.get("target")
    if target and target["kind"] == "unit":
        tag = target.get("tag")
        remembered_gas = (function["name"] == "Build_Assimilator_unit"
                          and tag in indices and known_geyser[indices[tag]])
        if (tag not in indices or not current_target[indices[tag]]) and not remembered_gas:
            raise TensorError("Unit target is not current screen-visible")
        labels["target_unit_tag"] = np.asarray(indices[tag], np.int32)
    elif target and target["kind"] == "world_point":
        x, y = world_pixel(target["point"], frame["spatial"]["map_size"], config.world_size)
        labels["world"] = np.asarray(y * config.world_size + x, np.int32)
    active = {name: name == "function" or name in function["args"] for name in HEADS}
    for name in DISABLED_HEADS:
        active[name] = False
    inputs.update({("behaviour_features", "action", name): value for name, value in labels.items()})
    return {"inputs": inputs, "labels": labels, "active_heads": active,
            "metadata": {"schema": SCHEMA, "replay_id": sample["replay_id"],
                         "player_id": sample.get("player_id"),
                         "action_ordinal": sample["action_ordinal"], "action_loop": action_loop,
                         "preceding_loop": before, "function": function, "entity_tags": tags,
                         "current_entity_count": metadata["current_entity_count"],
                         "remembered_own_count": metadata["remembered_own_count"],
                         "remembered_neutral_count": metadata["remembered_neutral_count"],
                         "source_count": len(sources), "execution_class": intent["supervision"]["execution_class"],
                         "unknown_type_count": metadata["unknown_type_count"]}}


def validate_supervised_masks(outputs, example):
    """Fail before optimization when upstream would silently zero a real label."""
    checked = {}
    for name, active in example["active_heads"].items():
        if not active:
            continue
        argument = np.asarray(outputs["argument_masks", name])
        if not np.all(argument):
            raise TensorError(f"Admitted {name} argument is masked")
        masks = np.asarray(outputs["masks", name])
        action = np.asarray(example["labels"][name])
        actual = np.asarray(outputs["action", name])
        if not np.array_equal(actual.reshape(action.shape), action):
            raise TensorError(f"Upstream changed {name} label")
        if name == "unit_tags":
            matrix = masks.reshape(len(action), -1)
            values = matrix[np.arange(len(action)), action]
        else:
            values = masks.reshape(-1)[int(action)]
        if not np.all(values):
            raise TensorError(f"Admitted {name} target silently masked by upstream")
        checked[name] = int(np.size(values))
    if "function" not in checked:
        raise TensorError("No admitted function supervision")
    return checked
