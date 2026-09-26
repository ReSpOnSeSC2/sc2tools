"""An isolated, paced SC2 replay spectator with local pause/speed controls."""
from __future__ import annotations

import argparse
import asyncio
from datetime import datetime, timezone
import json
import math
import os
from pathlib import Path
import time
import uuid

import psutil

SPEEDS = (.5, 1.0, 2.0, 4.0, 8.0)
STEP_LOOPS = 8
LOOPS_PER_SECOND = 22.4


def write_json(path: Path, value: dict) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    temporary = path.with_name(path.name + "." + uuid.uuid4().hex + ".tmp")
    temporary.write_text(json.dumps(value, indent=2, allow_nan=False), encoding="utf-8")
    temporary.replace(path)


def read_controls(path: Path, previous: dict) -> dict:
    if not path.is_file():
        return previous
    value = json.loads(path.read_text(encoding="utf-8"))
    if not isinstance(value, dict):
        raise ValueError("Viewer controls must be an object")
    result = {**previous, **{key: value[key] for key in ("paused", "speed", "close") if key in value}}
    if type(result["paused"]) is not bool or type(result["close"]) is not bool:
        raise ValueError("Pause and close controls must be true or false")
    if isinstance(result["speed"], bool) or result["speed"] not in SPEEDS:
        raise ValueError("Replay speed must be 0.5, 1, 2, 4, or 8")
    return result


def _process_created_at(pid: int) -> float | None:
    try:
        return psutil.Process(pid).create_time()
    except (psutil.NoSuchProcess, psutil.AccessDenied):
        return None


def _replay_info(path: Path, sc2_path: Path | None) -> dict:
    if sc2_path:
        os.environ["SC2PATH"] = str(Path(sc2_path).resolve())
    from pluto_sc2.replays import inspect_replay
    from sc2.paths import Paths
    info = inspect_replay(path)
    if not info.get("data_version"):
        raise ValueError("Replay has no DataVersion; exact-version playback is unavailable")
    executable = Paths.BASE / "Versions" / f"Base{info['base_build']}" / "SC2_x64.exe"
    if not executable.is_file():
        raise ValueError(f"The replay's exact SC2 build is not installed: {executable}")
    return info


def local_map_data(info: dict) -> tuple[bytes | None, str | None]:
    """Use only the exact absolute map file named by this local replay.

    Generated API replays can lack Battle.net map-cache handles. The official
    RequestStartReplay.map_data field overrides that recorded map path.
    Display names are never matched approximately to a different local map.
    """
    name = info.get("local_map_path") or info.get("map_name")
    if not isinstance(name, str) or Path(name).suffix.lower() != ".sc2map":
        return None, None  # Published replay: let SC2 use its recorded cache handle.
    path = Path(name)
    if not path.is_absolute() or not path.is_file():
        raise ValueError(f"Replay's exact local map is unavailable: {name}")
    path = path.resolve()
    if not 0 < path.stat().st_size <= 128 * 1024 * 1024:
        raise ValueError("Replay's local map has an invalid size")
    contents = path.read_bytes()
    if not contents.startswith((b"MPQ\x1a", b"MPQ\x1b")):
        raise ValueError("Replay's local map is not a readable SC2 map archive")
    return contents, str(path)


async def view(replay: Path, output: Path, *, sc2_path: Path | None = None,
               max_wall_seconds: float | None = None, process_factory=None,
               inspect=None, sleep=asyncio.sleep, monotonic=time.monotonic,
               observed_player_id: int | None = None) -> dict:
    """Play only this replay in an owned SC2 instance; never attach to training.

    The visible SC2 window supplies the picture and camera controls. Pause and
    playback speed are controlled by this directory's control.json file.
    """
    from s2clientprotocol import sc2api_pb2 as api
    replay, output = Path(replay).resolve(), Path(output).resolve()
    playback_replay, repair_report = replay, None
    output.mkdir(parents=True, exist_ok=True)
    state = {"schema": 1, "viewer_id": output.name, "viewer_output": str(output),
             "status": "starting", "pid": os.getpid(), "process_created_at": _process_created_at(os.getpid()),
             "sc2pid": None, "sc2_process_created_at": None, "replay": str(replay), "path": str(replay),
             "playback_replay": str(replay), "engine_playback_verified": False,
             "game_seconds": 0.0, "game_loop": 0, "speed": 1.0, "paused": False, "error": None}

    def publish(status=None, **values):
        if status:
            state["status"] = status
        state.update(values, updated_at=datetime.now(timezone.utc).isoformat())
        write_json(output / "status.json", state)

    publish()
    started_at = monotonic()
    try:
        if max_wall_seconds is not None and (isinstance(max_wall_seconds, bool)
                or not math.isfinite(max_wall_seconds) or max_wall_seconds <= 0):
            raise ValueError("Maximum wall time must be positive and finite")
        info = (inspect or _replay_info)(replay, sc2_path)
        if process_factory is None:
            from pluto_sc2.runner import ManagedSC2Process
            process_factory = ManagedSC2Process
        process = process_factory(fullscreen=False, resolution=(1280, 720),
                                  base_build=f"Base{info['base_build']}", data_hash=info["data_version"])
        async with process as controller:
            sc2pid = process._process.pid
            publish(sc2pid=sc2pid, sc2_process_created_at=_process_created_at(sc2pid),
                    base_build=info["base_build"], map_name=info.get("map_name"))
            ping = await controller.ping()
            if (ping.ping.base_build != info["base_build"] or
                    ping.ping.data_version.upper() != info["data_version"].upper()):
                raise ValueError("SC2 launched a different build or DataVersion from this replay")
            details = await controller._execute(replay_info=api.RequestReplayInfo(
                replay_path=str(replay), download_data=False))
            parsed = details.replay_info
            if parsed.HasField("error") and parsed.error in (
                    api.ResponseReplayInfo.InvalidReplayPath, api.ResponseReplayInfo.ParsingError):
                publish(replay_info_path_error={"code": api.ResponseReplayInfo.Error.Name(parsed.error),
                                               "message": parsed.error_details})
                details = await controller._execute(replay_info=api.RequestReplayInfo(
                    replay_data=replay.read_bytes(), download_data=False))
                parsed = details.replay_info
                publish(replay_info_transport="bytes")
            if (parsed.HasField("error") and parsed.error == api.ResponseReplayInfo.ParsingError
                    and "initdata" in parsed.error_details.casefold()):
                publish(replay_info_original_error={"code": "ParsingError", "message": parsed.error_details})
                from pluto_sc2.replay_repair import repair_replay
                # Exactly one derived-copy attempt, restricted by the repairer
                # to local API replays whose backup changes only player labels.
                try:
                    repair_report = repair_replay(replay, output / "viewing-copy.SC2Replay")
                except (ValueError, OSError) as error:
                    publish(viewing_copy_repair_error=str(error))
                else:
                    playback_replay = Path(repair_report["derived_replay"])
                    write_json(output / "repair-report.json", repair_report)
                    publish(playback_replay=str(playback_replay), viewing_copy_repair=repair_report)
                    details = await controller._execute(replay_info=api.RequestReplayInfo(
                        replay_path=str(playback_replay), download_data=False))
                    parsed = details.replay_info
                    publish(replay_info_transport="derived_copy_path")
            diagnostics = {name: getattr(parsed, name) for name in (
                "base_build", "data_build", "game_version", "data_version", "local_map_path", "map_name",
                "game_duration_loops", "game_duration_seconds")}
            diagnostics["player_ids"] = [item.player_info.player_id for item in parsed.player_info]
            if parsed.HasField("error"):
                diagnostics.update(error=api.ResponseReplayInfo.Error.Name(parsed.error), error_details=parsed.error_details)
            publish(replay_info=diagnostics)
            if parsed.HasField("error"):
                raise RuntimeError(f"SC2 could not inspect replay ({diagnostics['error']}): {parsed.error_details}")
            if parsed.base_build != info["base_build"] or parsed.data_version.upper() != info["data_version"].upper():
                raise ValueError("SC2's replay metadata differs from the recorded exact build/DataVersion")
            known_ids = diagnostics["player_ids"]
            if observed_player_id is None:
                observed_player_id = 0
            if observed_player_id not in [0, *known_ids]:
                raise ValueError("The selected observer perspective is not present in this replay")
            map_data, map_path = local_map_data(info)
            publish(local_map_path=map_path, map_data_supplied=map_data is not None,
                    observed_player_id=observed_player_id)
            request = api.RequestStartReplay(
                replay_path=str(playback_replay), observed_player_id=observed_player_id, disable_fog=False, realtime=False,
                options=api.InterfaceOptions(raw=True, score=True, show_cloaked=True,
                    show_burrowed_shadows=True, raw_affects_selection=False))
            if map_data is not None:
                request.map_data = map_data
            response = await controller._execute(start_replay=request)
            if response.start_replay.HasField("error") and response.start_replay.error == api.ResponseStartReplay.InvalidReplayPath:
                publish(replay_path_error=response.start_replay.error_details)
                request.replay_data = playback_replay.read_bytes()  # Switches the protobuf oneof from path to bytes.
                response = await controller._execute(start_replay=request)
            if response.start_replay.HasField("error"):
                code = api.ResponseStartReplay.Error.Name(response.start_replay.error)
                raise RuntimeError(f"Replay playback failed ({code}): " + str(
                    response.start_replay.error_details or response.start_replay.error))
            controls = {"paused": False, "speed": 1.0, "close": False}
            next_step, last_publish = monotonic(), -math.inf
            previous_pacing = (False, 1.0)
            publish("playing")
            while True:
                if process._process.poll() is not None:
                    publish("closed", close_reason="SC2 window closed")
                    break
                if max_wall_seconds is not None and monotonic() - started_at >= max_wall_seconds:
                    publish("closed", close_reason="Requested viewer wall-time limit reached")
                    break
                try:
                    controls = read_controls(output / "control.json", controls)
                    state.pop("control_error", None)
                except (OSError, ValueError, TypeError) as error:
                    state["control_error"] = str(error)
                if controls["close"]:
                    publish("closed", close_reason="Viewer close requested")
                    break
                pacing = (controls["paused"], float(controls["speed"]))
                changed = pacing != previous_pacing
                if changed:
                    next_step = monotonic()  # No catch-up burst after a pause/speed change.
                    previous_pacing = pacing
                state.update(paused=pacing[0], speed=pacing[1])
                if pacing[0]:
                    if changed or monotonic() - last_publish >= 1:
                        publish("paused")
                        last_publish = monotonic()
                    await sleep(.05)
                    continue
                if changed:
                    publish("playing")
                delay = next_step - monotonic()
                if delay > 0:
                    await sleep(min(delay, .05))
                    continue
                await controller._execute(step=api.RequestStep(count=STEP_LOOPS))
                observation = await controller._execute(observation=api.RequestObservation())
                loop = observation.observation.observation.game_loop
                state.update(game_loop=loop, game_seconds=loop / LOOPS_PER_SECOND)
                if loop > 0 and not state["engine_playback_verified"]:
                    state["engine_playback_verified"] = True
                    if repair_report is not None:
                        repair_report.update(engine_playback_verified=True, verified_game_loop=loop)
                        write_json(output / "repair-report.json", repair_report)
                        state["viewing_copy_repair"] = repair_report
                if observation.observation.player_result:
                    publish("finished", results=[{"player_id": result.player_id, "result": result.result}
                        for result in observation.observation.player_result])
                    break
                if monotonic() - last_publish >= 1:
                    publish("playing")
                    last_publish = monotonic()
                next_step = max(next_step + STEP_LOOPS / LOOPS_PER_SECOND / pacing[1], monotonic())
    except (KeyboardInterrupt, asyncio.CancelledError):
        publish("closed", close_reason="Viewer interrupted")
    except Exception as error:
        publish("failed", error=f"{type(error).__name__}: {error}")
    return state


def main(argv=None) -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--replay", type=Path, required=True)
    parser.add_argument("--output", type=Path, required=True)
    parser.add_argument("--sc2-path", type=Path)
    parser.add_argument("--max-wall-seconds", type=float)
    parser.add_argument("--observed-player", type=int)
    args = parser.parse_args(argv)
    from loguru import logger
    logger.remove()  # Protocol debug logs include full replay bytes.
    result = asyncio.run(view(args.replay, args.output, sc2_path=args.sc2_path,
                             max_wall_seconds=args.max_wall_seconds, observed_player_id=args.observed_player))
    return 1 if result["status"] == "failed" else 0


if __name__ == "__main__":
    raise SystemExit(main())
