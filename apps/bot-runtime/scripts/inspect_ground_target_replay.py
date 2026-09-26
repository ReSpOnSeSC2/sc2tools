"""Read-only, exact-loop reconstruction of audited ground clicks in a replay.

Player camera and fog remain enabled. This creates no game, policy, training
data, or strength result; only this diagnostic's replay spectator is owned.
"""

import argparse
import asyncio
from datetime import datetime, timezone
import hashlib
import json
import math
from pathlib import Path
from types import SimpleNamespace

from google.protobuf.json_format import MessageToDict
import psutil
from sc2.ids.unit_typeid import UnitTypeId
from s2clientprotocol import common_pb2 as common
from s2clientprotocol import sc2api_pb2 as api

from pluto_sc2.fairplay import CAMERA_HEIGHT, CAMERA_WIDTH, SCREEN_SIZE, configure_interface
from pluto_sc2.replay_viewer import local_map_data
from pluto_sc2.replays import inspect_replay
from pluto_sc2.runner import ManagedSC2Process, write_json
from pluto_sc2.target_geometry import screen_pixel


DEFAULT_LOOPS = (9344, 10800, 11920)
DEFAULT_OFFSETS = (-8, -1, 0, 1, 2, 8)
LAYERS = ("player_relative", "unit_type", "unit_density", "visibility_map", "pathable", "height_map")


def command_cases(audit, loops):
    cases = []
    for loop in sorted(set(loops)):
        matches = [(index, action) for index, action in enumerate(audit["actions"])
                   if action.get("kind") == "command" and action.get("game_loop") == loop
                   and action.get("target_kind") == "ground" and action.get("ability") == 23]
        if len(matches) != 1:
            raise ValueError(f"Expected one ground Attack23 command at loop {loop}, found {len(matches)}")
        index, action = matches[0]
        pixel = action.get("target_pixel")
        if (action.get("minimap") or not isinstance(pixel, list) or len(pixel) != 2
                or any(not isinstance(value, int) for value in pixel)
                or not 0 <= pixel[0] < SCREEN_SIZE[0] or not 0 <= pixel[1] < SCREEN_SIZE[1]):
            raise ValueError(f"Loop {loop} has no valid feature-screen target")
        cases.append({"command_loop": loop, "audit_index": index, "command": action})
    return cases


def sample_schedule(cases, offsets, final_loop):
    requested = {}
    for case in cases:
        for offset in sorted(set(offsets)):
            loop = case["command_loop"] + offset
            if not 0 <= loop <= final_loop:
                raise ValueError(f"Requested loop {loop} is outside this replay")
            requested.setdefault(loop, []).append({"case": case, "offset": offset})
    return requested


def screen_unit(unit, camera):
    # Check observed flags BEFORE position access; never serialize hidden units.
    if not unit.is_on_screen or unit.display_type != 1 or unit.cloak in (1, 2):
        return None
    if (abs(unit.pos.x - camera.x) >= CAMERA_WIDTH / 2 - .2
            or abs(unit.pos.y - camera.y) >= CAMERA_HEIGHT / 2 - .2):
        return None
    try:
        kind = UnitTypeId(unit.unit_type).name
    except ValueError:
        kind = str(unit.unit_type)
    scale = SCREEN_SIZE[0] / CAMERA_WIDTH
    return {"tag": unit.tag, "type": kind, "unit_type": unit.unit_type,
            "owner": unit.owner, "alliance": unit.alliance,
            "is_on_screen": unit.is_on_screen, "display_type": unit.display_type,
            "is_selected": unit.is_selected, "position": [unit.pos.x, unit.pos.y, unit.pos.z],
            "radius": unit.radius, "health": unit.health, "shield": unit.shield,
            "screen_pixel_by_controller_projection": [int(SCREEN_SIZE[0] / 2 + (unit.pos.x - camera.x) * scale),
                                                        int(SCREEN_SIZE[1] / 2 - (unit.pos.y - camera.y) * scale)],
            "orders": [MessageToDict(order, preserving_proto_field_name=True) for order in unit.orders]}


def snapshot(response, expected_loop, requests):
    observed = response.observation
    ob = observed.observation
    if ob.game_loop != expected_loop:
        raise RuntimeError(f"Expected exact replay loop {expected_loop}, observed {ob.game_loop}")
    camera = ob.raw_data.player.camera
    bot = SimpleNamespace(state=SimpleNamespace(observation=ob))
    units = [row for unit in ob.raw_data.units if (row := screen_unit(unit, camera)) is not None]
    samples = []
    for request in requests:
        case, offset = request["case"], request["offset"]
        command = case["command"]
        pixel = common.PointI(x=command["target_pixel"][0], y=command["target_pixel"][1])
        scale = SCREEN_SIZE[0] / CAMERA_WIDTH
        projection = [camera.x + (pixel.x + .5 - SCREEN_SIZE[0] / 2) / scale,
                      camera.y - (pixel.y + .5 - SCREEN_SIZE[1] / 2) / scale]
        samples.append({"command_loop": case["command_loop"], "audit_index": case["audit_index"],
                        "offset": offset, "target_pixel": command["target_pixel"],
                        "audit_camera": command["camera"],
                        "camera_distance_from_audit": math.dist([camera.x, camera.y], command["camera"]),
                        "audit_effective_target": command["effective_target"],
                        "projection_at_observed_camera": projection,
                        "layers": {name: screen_pixel(bot, name, pixel, SCREEN_SIZE) for name in LAYERS}})
    # Earlier observations can cover large replay jumps. Restrict saved actions
    # to each sampled command's local window; do not confuse delivery with execution.
    windows = [request["case"]["command_loop"] for request in requests]
    actions = [MessageToDict(action, preserving_proto_field_name=True) for action in observed.actions
               if any(abs(action.game_loop - loop) <= 16 for loop in windows)]
    return {"loop": ob.game_loop, "seconds": ob.game_loop / 22.4,
            "camera": [camera.x, camera.y, camera.z], "samples": samples,
            "current_screen_units": units, "executed_actions_since_previous_observation": actions,
            "action_errors": [MessageToDict(error, preserving_proto_field_name=True)
                              for error in observed.action_errors]}


async def playback_source(server, replay, output, info, player_id, publish):
    """Use the existing viewer's single, label-only derived-copy repair path."""
    ping = await server.ping()
    if (ping.ping.base_build != info["base_build"]
            or ping.ping.data_version.upper() != info["data_version"].upper()):
        raise ValueError("SC2 engine build/DataVersion differs from replay")
    playback = replay.resolve()
    response = await server._execute(replay_info=api.RequestReplayInfo(replay_path=str(playback), download_data=False))
    parsed = response.replay_info
    if parsed.HasField("error") and parsed.error in (api.ResponseReplayInfo.InvalidReplayPath,
                                                     api.ResponseReplayInfo.ParsingError):
        publish(replay_info_path_error=parsed.error_details)
        response = await server._execute(replay_info=api.RequestReplayInfo(replay_data=replay.read_bytes(),
                                                                          download_data=False))
        parsed = response.replay_info
    if (parsed.HasField("error") and parsed.error == api.ResponseReplayInfo.ParsingError
            and "initdata" in parsed.error_details.casefold()):
        from pluto_sc2.replay_repair import repair_replay

        publish(replay_info_original_error=parsed.error_details)
        repair = repair_replay(replay, output / "viewing-copy.SC2Replay")
        write_json(output / "repair-report.json", repair)
        playback = Path(repair["derived_replay"])
        publish(viewing_copy_repair=repair)
        response = await server._execute(replay_info=api.RequestReplayInfo(replay_path=str(playback),
                                                                          download_data=False))
        parsed = response.replay_info
    publish(playback_replay=str(playback), engine_replay_info=MessageToDict(parsed, preserving_proto_field_name=True))
    if parsed.HasField("error"):
        raise RuntimeError(f"Replay metadata failed ({api.ResponseReplayInfo.Error.Name(parsed.error)}): "
                           f"{parsed.error_details}")
    if (parsed.base_build != info["base_build"]
            or parsed.data_version.upper() != info["data_version"].upper()):
        raise ValueError("SC2 replay metadata differs from recorded build/DataVersion")
    if player_id not in [row.player_info.player_id for row in parsed.player_info]:
        raise ValueError("Observed player is absent from replay")
    return playback


async def inspect(replay, audit_path, output, *, player_id=1, loops=DEFAULT_LOOPS,
                  offsets=DEFAULT_OFFSETS, timeout_seconds=180):
    original_replay, original_audit = replay.read_bytes(), audit_path.read_bytes()
    hashes = {"replay": hashlib.sha256(original_replay).hexdigest(),
              "audit": hashlib.sha256(original_audit).hexdigest()}
    info = inspect_replay(replay)
    cases = command_cases(json.loads(original_audit), loops)
    schedule = sample_schedule(cases, offsets, info["game_loops"])
    if not schedule or not 1 <= player_id <= 16 or not 5 <= timeout_seconds <= 600:
        raise ValueError("Need nonempty samples, player 1..16, and timeout 5..600 seconds")
    output.mkdir(parents=True, exist_ok=False)
    proc = psutil.Process()
    report = {"schema": 1, "status": "starting", "purpose": "Read-only replay mechanics diagnosis; no learning or strength result",
              "scope": "Observed player camera, fog enabled, current visible screen units only",
              "replay": str(replay.resolve()), "audit": str(audit_path.resolve()), "source_sha256": hashes,
              "player_id": player_id, "replay_info": info, "cases": cases,
              "requested_loops": sorted(schedule), "pid": proc.pid, "process_created_at": proc.create_time(),
              "observed_loops": []}

    def publish(**updates):
        report.update(updates, updated_at=datetime.now(timezone.utc).isoformat())
        write_json(output / "inspection.json", report)

    def check_stop():
        if (output / "STOP").exists():
            raise asyncio.CancelledError("Replay inspection STOP requested")

    async def collect():
        process = ManagedSC2Process(fullscreen=False, resolution=(1280, 720),
                                    base_build=f"Base{info['base_build']}", data_hash=info["data_version"])
        async with process as server:
            publish(sc2_pid=process._process.pid,
                    sc2_process_created_at=psutil.Process(process._process.pid).create_time())
            check_stop()
            playback = await playback_source(server, replay, output, info, player_id, publish)
            options = api.InterfaceOptions(raw=True, score=True, raw_affects_selection=False)
            configure_interface(options)
            request = api.RequestStartReplay(replay_path=str(playback), observed_player_id=player_id,
                                              disable_fog=False, realtime=False, options=options)
            map_data, map_path = local_map_data(info)
            if map_data:
                request.map_data = map_data
            publish(map_path=str(map_path) if map_path else None)
            check_stop()
            started = await server._execute(start_replay=request)
            if (started.start_replay.HasField("error")
                    and started.start_replay.error == api.ResponseStartReplay.InvalidReplayPath):
                publish(replay_path_error=started.start_replay.error_details)
                request.replay_data = playback.read_bytes()
                started = await server._execute(start_replay=request)
            if started.start_replay.HasField("error"):
                raise RuntimeError(f"Replay start failed ({api.ResponseStartReplay.Error.Name(started.start_replay.error)}): "
                                   f"{started.start_replay.error_details}")
            await server._execute(obs_action=api.RequestObserverAction(actions=[api.ObserverAction(
                camera_follow_player=api.ActionObserverCameraFollowPlayer(player_id=player_id))]))
            response = await server._execute(observation=api.RequestObservation())
            current = response.observation.observation.game_loop
            with (output / "observations.jsonl").open("x", encoding="utf-8") as stream:
                for target in sorted(schedule):
                    check_stop()
                    if current > target:
                        raise RuntimeError(f"Replay began after requested loop {target}")
                    if target > current:
                        await server._execute(step=api.RequestStep(count=target - current))
                        response = await server._execute(observation=api.RequestObservation())
                    record = snapshot(response, target, schedule[target])
                    current = target
                    stream.write(json.dumps(record) + "\n")
                    stream.flush()
                    report["observed_loops"].append(current)
                    publish(status="inspecting")
                    if "viewing_copy_repair" in report and not report["viewing_copy_repair"]["engine_playback_verified"]:
                        repair = report["viewing_copy_repair"]
                        repair.update(engine_playback_verified=True, verified_game_loop=current)
                        write_json(output / "repair-report.json", repair)
                    if response.observation.player_result and target < max(schedule):
                        raise RuntimeError("Replay terminated before all requested samples")
    publish()
    try:
        await asyncio.wait_for(collect(), timeout=timeout_seconds)
        publish(status="complete")
    except asyncio.CancelledError as error:
        publish(status="stopped", error=str(error))
    except BaseException as error:
        publish(status="failed", error=f"{type(error).__name__}: {error}")
        raise
    finally:
        unchanged = replay.read_bytes() == original_replay and audit_path.read_bytes() == original_audit
        publish(source_files_unchanged=unchanged)
        if not unchanged:
            raise RuntimeError("Source replay or audit changed during read-only inspection")
    return report


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--replay", type=Path, required=True)
    parser.add_argument("--audit", type=Path, required=True)
    parser.add_argument("--output", type=Path, required=True)
    parser.add_argument("--player-id", type=int, default=1)
    parser.add_argument("--loops", type=int, nargs="+", default=DEFAULT_LOOPS)
    parser.add_argument("--offsets", type=int, nargs="+", default=DEFAULT_OFFSETS)
    parser.add_argument("--timeout-seconds", type=float, default=180)
    args = parser.parse_args()
    from loguru import logger

    logger.remove()
    asyncio.run(inspect(args.replay, args.audit, args.output, player_id=args.player_id,
                        loops=args.loops, offsets=args.offsets, timeout_seconds=args.timeout_seconds))
