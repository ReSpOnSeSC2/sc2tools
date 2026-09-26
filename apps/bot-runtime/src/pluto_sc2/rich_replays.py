"""Exact-engine replay capture for the structured AlphaStar migration.

This version is a fidelity pilot, not an AlphaStar TFRecord converter or trainer.
Original actions are audit data; only separately validated arguments may become
supervised labels. No game actions, training updates or corpus mutations occur.
"""
from __future__ import annotations

import asyncio
import base64
from collections import Counter, deque
from datetime import datetime, timezone
import gzip
import hashlib
import json
import math
from pathlib import Path
import shutil
import time

import numpy as np
from google.protobuf.json_format import MessageToDict

from .fairplay import CAMERA_HEIGHT, CAMERA_WIDTH, MINIMAP_SIZE, SCREEN_SIZE
from .replays import ReplayError, _hash_file, inspect_replay, select_player

RICH_SCHEMA = "protoss-rich-replay-v1"


def _proto(value):
    return MessageToDict(value, preserving_proto_field_name=True, use_integers_for_enums=True)


def image_array(image):
    """Decode native image storage without changing its screen row orientation."""
    width, height, bits = image.size.x, image.size.y, image.bits_per_pixel
    if not 0 < width <= 4096 or not 0 < height <= 4096 or bits not in (1, 8, 16, 32):
        raise ReplayError("Unsupported feature image shape/depth")
    if bits == 1:
        data = np.unpackbits(np.frombuffer(image.data, dtype=np.uint8))[:width * height]
    else:
        data = np.frombuffer(image.data, dtype={8: np.uint8, 16: "<u2", 32: "<u4"}[bits])
    if data.size != width * height:
        raise ReplayError("Feature image payload does not match its shape")
    return data.reshape(height, width)


def encode_frame(observation, known_own, unit_names=None, *, map_size=None):
    """Capture only camera-visible entities and human UI, retaining own memory.

    Offscreen own units update only selection flags for previously seen tags.
    Their positions, health, orders and construction progress are never read.
    Enemy orders/cargo and snapshot entities are never exported.
    """
    unit_names = unit_names or {}
    loop = int(observation.game_loop)
    raw = observation.raw_data
    camera = raw.player.camera
    if not camera.HasField("x") or not camera.HasField("y"):
        raise ReplayError("Missing replay player's camera")
    cx, cy = float(camera.x), float(camera.y)
    if not all(math.isfinite(x) for x in (cx, cy)):
        raise ReplayError("Invalid camera coordinates")
    entities = []
    selected = []
    visibility = (image_array(observation.feature_layer_data.renders.visibility_map)
                  if observation.feature_layer_data.renders.HasField("visibility_map") else None)
    for unit in raw.units:
        # Identity and selection of already-known own units are available through
        # remembered groups. Never use an offscreen raw record as new knowledge.
        if unit.alliance == 1 and unit.tag in known_own and unit.is_selected:
            selected.append(int(unit.tag))
        if (unit.display_type != 1 or not unit.is_on_screen or unit.is_blip
                or unit.alliance not in (1, 3, 4)):
            continue
        if unit.alliance == 4 and unit.cloak not in (2, 3):  # Enemy: detected or uncloaked only
            continue
        if abs(unit.pos.x - cx) > CAMERA_WIDTH / 2 or abs(unit.pos.y - cy) > CAMERA_HEIGHT / 2:
            continue
        # Confirm actual screen visibility before reading any tactical fields.
        if visibility is None:
            continue
        height, width = visibility.shape
        px = round(width / 2 + (unit.pos.x - cx) * width / CAMERA_WIDTH)
        py = round(height / 2 - (unit.pos.y - cy) * height / CAMERA_HEIGHT)
        if not (0 <= px < width and 0 <= py < height and visibility[py, px] == 2):
            continue
        row = {"tag": int(unit.tag), "owner": int(unit.alliance), "type_id": int(unit.unit_type),
               "type_name": unit_names.get(int(unit.unit_type), "UNKNOWN"),
               "position": [float(unit.pos.x), float(unit.pos.y)],
               "is_on_screen": True, "is_visible": True,
               "is_selected": bool(unit.is_selected), "is_flying": bool(unit.is_flying),
               "cloak_state": int(unit.cloak),
               "is_hallucination": bool(unit.is_hallucination),
               "radius": float(unit.radius), "build_progress": float(unit.build_progress),
               "health": float(unit.health), "health_max": float(unit.health_max),
               "shield": float(unit.shield), "shield_max": float(unit.shield_max)}
        if unit.alliance == 1:
            row.update(energy=float(unit.energy), energy_max=float(unit.energy_max),
                       weapon_cooldown=float(unit.weapon_cooldown),
                       assigned_harvesters=int(unit.assigned_harvesters),
                       ideal_harvesters=int(unit.ideal_harvesters),
                       orders=[_proto(order) for order in unit.orders],
                       buffs=list(unit.buff_ids))
            known_own[int(unit.tag)] = {key: row[key] for key in ("tag", "owner", "type_id", "type_name", "position")}
            known_own[int(unit.tag)]["last_seen_loop"] = loop
            if unit.is_selected and unit.tag not in selected:
                selected.append(int(unit.tag))
        entities.append(row)
    ui = _proto(observation.ui_data)
    panel_count = None
    panel_units = []
    if observation.ui_data.HasField("multi"):
        panel_units = list(observation.ui_data.multi.units)
        panel_count = len(panel_units)
    elif observation.ui_data.HasField("single"):
        panel_count = int(observation.ui_data.single.HasField("unit"))
        panel_units = [observation.ui_data.single.unit] if panel_count else []
    elif observation.ui_data.HasField("production"):
        panel_count = int(observation.ui_data.production.HasField("unit"))
        panel_units = [observation.ui_data.production.unit] if panel_count else []
    selection_complete = (panel_count is not None and bool(selected) and panel_count == len(selected)
        and all(unit.player_relative == 1 for unit in panel_units)
        and Counter(int(unit.unit_type) for unit in panel_units)
        == Counter(known_own[tag]["type_id"] for tag in selected))
    spatial = {"screen_size": list(SCREEN_SIZE), "minimap_size": list(MINIMAP_SIZE),
               "camera_width": CAMERA_WIDTH, "camera_height": CAMERA_HEIGHT}
    if map_size is not None:
        if len(map_size) != 2 or any(type(value) is not int or value <= 0 for value in map_size):
            raise ReplayError("Map size must come from positive integer public engine dimensions")
        spatial["map_size"] = list(map_size)
    layers = observation.feature_layer_data
    if layers.renders.HasField("visibility_map"):
        spatial["screen_visibility"] = image_array(layers.renders.visibility_map).tolist()
    if layers.minimap_renders.HasField("visibility_map"):
        spatial["minimap_visibility"] = image_array(layers.minimap_renders.visibility_map).tolist()
    return {"schema": RICH_SCHEMA, "game_loop": loop, "camera": [cx, cy],
            "hud": _proto(observation.player_common), "alerts": list(observation.alerts),
            "entities": entities, "known_own": [dict(row) for row in known_own.values()],
            "selection": sorted(selected), "selection_complete": selection_complete,
            "ui": ui, "spatial": spatial,
            "available_abilities": [_proto(ability) for ability in observation.abilities],
            "feature_layers": _proto(layers),
            "own_upgrades": list(raw.player.upgrade_ids)}


def preceding_frame(frames, action_loop):
    """Never pair an expert action with its resulting observation."""
    return next((frame for frame in reversed(frames) if frame["game_loop"] < action_loop), None)


def _json_write(path, value):
    pending = path.with_suffix(path.suffix + ".pending")
    pending.write_text(json.dumps(value, indent=2, allow_nan=False) + "\n", encoding="utf-8")
    pending.replace(path)


def _line(stream, value):
    stream.write(json.dumps(value, separators=(",", ":"), allow_nan=False) + "\n")


async def capture_replay(replay_path, *, player_id, output, expected_sha256,
                         partition, max_seconds=240, step_mul=1):
    """Write a new standalone fidelity capture; never modify previous artifacts."""
    from filelock import FileLock
    import psutil
    from s2clientprotocol import sc2api_pb2 as api
    from sc2.paths import Paths, latest_executeble
    from .fairplay import HumanClient, configure_interface
    from .rich_actions import serialize_action, validate_action_record
    from .runner import ManagedSC2Process

    if partition not in ("train", "validation") or type(step_mul) is not int or not 1 <= step_mul <= 8:
        raise ReplayError("Explicit whole-replay partition and step1..8 are required")
    if not isinstance(max_seconds, (int, float)) or isinstance(max_seconds, bool) or not 1 <= max_seconds <= 7200:
        raise ReplayError("Capture horizon must be1..7200 seconds")
    info = inspect_replay(replay_path)
    if info["replay_id"] != expected_sha256:
        raise ReplayError("Original replay hash differs from the pinned corpus")
    player = select_player(info, player_id=player_id)
    if player["starting_workers"] != 8 or not info["data_version"]:
        raise ReplayError("Verified eight-worker replay and exact data version required")
    base = f'Base{info["base_build"]}'
    if not latest_executeble(Paths.BASE / "Versions", base).is_file():
        raise ReplayError("Exact replay engine build is not installed")
    out = Path(output).resolve()
    if out.exists():
        raise ReplayError("Capture output must be a new directory; existing artifacts are immutable")
    out.parent.mkdir(parents=True, exist_ok=True)
    with FileLock(str(out.parent / "rich-replay-capture.lock"), timeout=0):
        engines = [(p.pid, p.create_time()) for p in psutil.process_iter(["name"])
                   if (p.info["name"] or "").lower() == "sc2_x64.exe"]
        if engines:
            raise ReplayError(f"Existing SC2 engines must finish before isolated capture: {engines}")
        out.mkdir()
        source_dir = out / "source-snapshot"
        source_dir.mkdir()
        sources = {}
        for filename in ("rich_replays.py", "rich_actions.py", "replays.py", "fairplay.py", "runner.py"):
            original = Path(__file__).parent / filename
            shutil.copy2(original, source_dir / filename)
            sources[filename] = _hash_file(original)
        _json_write(source_dir / "manifest.json", sources)
        state = {"schema": RICH_SCHEMA, "status": "running", "created_at": datetime.now(timezone.utc).isoformat(),
                 "pid": psutil.Process().pid, "process_created_at": psutil.Process().create_time(),
                 "replay": info, "player_id": player_id, "partition": partition,
                 "max_seconds": max_seconds, "step_mul": step_mul,
                 "purpose": "structured replay fidelity pilot", "trained_weights": False,
                 "full_replay": False, "eligible_for_training": False,
                 "upstream_commit": "700b1e74364ed5dfc66f6cd2574c5ffac2fa474e",
                 "rules": {"start_workers": 8, "max_apm": 200, "camera_restricted": True, "fog": True},
                 "apm_note": "Expert timings retained; fast sequences need a validated paced decoder, not raw replay execution."}
        _json_write(out / "capture.json", state)
        counters = Counter()
        known_own = {}
        frames = deque(maxlen=16)
        start = time.monotonic()
        last_loop = -1
        try:
            with gzip.open(out / "frames.jsonl.gz", "wt", encoding="utf-8", compresslevel=3) as frame_file, gzip.open(
                    out / "actions.jsonl.gz", "wt", encoding="utf-8", compresslevel=3) as action_file:
                async with ManagedSC2Process(fullscreen=False, base_build=base, data_hash=info["data_version"]) as server:
                    ping = (await server.ping()).ping
                    if ping.base_build != info["base_build"] or ping.data_version.upper() != info["data_version"].upper():
                        raise ReplayError("Replay engine does not match original build/data hash")
                    request = api.RequestStartReplay(replay_data=Path(info["path"]).read_bytes(),
                        observed_player_id=player_id, disable_fog=False, realtime=False)
                    configure_interface(request.options)
                    if (out / "STOP").exists():
                        raise ReplayError("Capture STOP marker is present")
                    result = (await server._execute(start_replay=request)).start_replay
                    if result.HasField("error"):
                        raise ReplayError(f"Replay startup failed: {result.error_details or result.error}")
                    client = HumanClient(server._ws)
                    client.game_step = step_mul
                    game_info = (await client._execute(game_info=api.RequestGameInfo())).game_info
                    map_size = [int(game_info.start_raw.map_size.x), int(game_info.start_raw.map_size.y)]
                    _json_write(out / "game-info.json", _proto(game_info))
                    state["map_size"] = map_size
                    await client._execute(obs_action=api.RequestObserverAction(actions=[api.ObserverAction(
                        camera_follow_player=api.ActionObserverCameraFollowPlayer(player_id=player_id))]))
                    # Retain the engine's complete patch vocabulary. Burnysc2's
                    # GameData wrapper drops abilities absent from its old enum.
                    data = (await client._execute(data=api.RequestData(
                        ability_id=True, unit_type_id=True, upgrade_id=True, buff_id=True, effect_id=True))).data
                    names = {unit.unit_id: unit.name for unit in data.units}
                    abilities = {str(ability.ability_id): {"id": int(ability.ability_id),
                        "name": ability.link_name or ability.friendly_name or ability.button_name,
                        "target": int(ability.target), "available": bool(ability.available),
                        "allow_minimap": bool(ability.allow_minimap),
                        "remaps_to_ability_id": int(ability.remaps_to_ability_id),
                        "native": _proto(ability)} for ability in data.abilities}
                    _json_write(out / "game-data.json", {"units": {str(unit.unit_id): _proto(unit) for unit in data.units},
                        "abilities": abilities, "upgrades": {str(upgrade.upgrade_id): _proto(upgrade) for upgrade in data.upgrades},
                        "buffs": [_proto(buff) for buff in data.buffs], "effects": [_proto(effect) for effect in data.effects]})
                    while True:
                        if (out / "STOP").exists():
                            state["status"] = "stopped"
                            break
                        response = (await client.observation()).observation
                        observation = response.observation
                        loop = int(observation.game_loop)
                        if observation.player_common.player_id != player_id:
                            raise ReplayError("Replay perspective changed")
                        if counters["frames"] == 0:
                            workers = [u for u in observation.raw_data.units if u.alliance == 1 and u.unit_type == 84]
                            # Loop-zero counts are eligibility validation only, not model features.
                            if loop > 1 or len(workers) != 8:
                                raise ReplayError("SC2 did not verify exactly eight starting Probes at loop zero")
                            state["engine_start_workers"] = 8
                        if loop <= last_loop and not response.player_result:
                            raise ReplayError("Replay engine stopped advancing")
                        intervening_ui = set()
                        for action in sorted(response.actions, key=lambda a: a.game_loop):
                            context = preceding_frame(frames, int(action.game_loop))
                            if context is None:
                                wire = action.SerializeToString()
                                record = {"schema": 1, "game_loop": int(action.game_loop), "preceding_game_loop": None,
                                    "payload": _proto(action), "wire_base64": base64.b64encode(wire).decode(),
                                    "wire_sha256": hashlib.sha256(wire).hexdigest(), "components": [],
                                    "supervision": {"trainable": False, "exclusion_reasons": ["no_preceding_observation"],
                                                    "scope": "native_action_labels_require_restricted_decoder"}}
                            else:
                                current_abilities = {int(row["ability_id"]) for row in context["available_abilities"]}
                                selected_abilities = {key: {**value, "current_available": value["id"] in current_abilities}
                                                      for key, value in abilities.items()}
                                context = {**context, "public_abilities": selected_abilities}
                                if context["game_loop"] in intervening_ui:
                                    context["selection_complete"] = False
                                record = serialize_action(action, context)
                                validate_action_record(record, context)
                                if action.HasField("action_ui") or any(
                                    getattr(action, surface).WhichOneof("action") in ("unit_selection_point", "unit_selection_rect")
                                    for surface in ("action_feature_layer", "action_render")):
                                    intervening_ui.add(context["game_loop"])
                            _line(action_file, record)
                            counters["actions"] += 1
                            counters["trainable_actions"] += bool(record["supervision"]["trainable"])
                            counters.update("exclusion:" + reason for reason in record["supervision"]["exclusion_reasons"])
                        frame = encode_frame(observation, known_own, names, map_size=map_size)
                        _line(frame_file, frame)
                        frames.append(frame)
                        counters["frames"] += 1
                        last_loop = loop
                        if response.player_result:
                            state.update(status="captured_full_replay", full_replay=True,
                                         player_result=[_proto(result) for result in response.player_result])
                            break
                        if loop / 22.4 >= max_seconds:
                            state["status"] = "captured_prefix"
                            break
                        if counters["frames"] % 224 == 0:
                            state.update(game_loop=loop, game_seconds=loop / 22.4, counters=dict(counters))
                            _json_write(out / "capture.json", state)
                        await client.step()
        except BaseException as exc:
            state.update(status="failed", error=f"{type(exc).__name__}: {exc}")
            raise
        finally:
            state.update(finished_at=datetime.now(timezone.utc).isoformat(), game_loop=last_loop,
                         game_seconds=max(last_loop, 0) / 22.4, counters=dict(counters),
                         wall_seconds=time.monotonic() - start,
                         original_replay_unchanged=_hash_file(Path(info["path"])) == expected_sha256)
            state["artifacts"] = {name: _hash_file(out / name) for name in
                ("frames.jsonl.gz", "actions.jsonl.gz", "game-data.json", "game-info.json") if (out / name).is_file()}
            _json_write(out / "capture.json", state)
    return state


def main():
    import argparse
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--manifest", type=Path, required=True)
    parser.add_argument("--split-summary", type=Path, required=True)
    parser.add_argument("--replay-id", required=True)
    parser.add_argument("--output", type=Path, required=True)
    parser.add_argument("--seconds", type=float, default=240)
    parser.add_argument("--step-mul", type=int, default=1)
    args = parser.parse_args()
    manifest = json.loads(args.manifest.read_text(encoding="utf-8"))
    rows = [row for row in manifest["replays"] if row["replay_id"] == args.replay_id]
    if len(rows) != 1:
        raise ReplayError("Replay must be unique in pinned manifest")
    splits = json.loads(args.split_summary.read_text(encoding="utf-8"))["split"]["matchups"]
    memberships = [partition for match in splits.values() for partition, key in
        (("train", "train_replay_ids"), ("validation", "validation_replay_ids")) if args.replay_id in match[key]]
    if len(memberships) != 1:
        raise ReplayError("Replay must have exactly one existing whole-game partition")
    row = rows[0]
    result = asyncio.run(capture_replay(row["path"], player_id=row["player_id"], output=args.output,
        expected_sha256=args.replay_id, partition=memberships[0], max_seconds=args.seconds, step_mul=args.step_mul))
    print(json.dumps({key: result[key] for key in ("status", "game_seconds", "wall_seconds", "counters")}, indent=2))


if __name__ == "__main__":
    main()
