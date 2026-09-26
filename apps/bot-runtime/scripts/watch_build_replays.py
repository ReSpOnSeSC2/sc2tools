"""Review complete library replays with player-camera playback and phase pauses.

Analysis-only: never writes training data, changes a replay, or sends gameplay
commands. Full historical own state and camera-local enemy sightings are kept
separately. STOP or control.close ends only this owned replay spectator.
"""

import argparse
import asyncio
from collections import Counter
from datetime import datetime, timezone
import hashlib
import json
from pathlib import Path
import time

import psutil
from s2clientprotocol import sc2api_pb2 as api
from sc2.ids.unit_typeid import UnitTypeId

from pluto_sc2.fairplay import configure_interface
from pluto_sc2.replay_viewer import local_map_data
from pluto_sc2.replays import inspect_replay, select_player
from pluto_sc2.runner import ManagedSC2Process, write_json


def kind(value):
    try:
        return UnitTypeId(value).name
    except ValueError:
        return str(value)


def snapshot(response, label, own_id):
    ob = response.observation.observation
    camera = ob.raw_data.player.camera
    units = ob.raw_data.units

    def row(u):
        return dict(
            tag=u.tag,
            type=kind(u.unit_type),
            owner=u.owner,
            position=[u.pos.x, u.pos.y],
            health=u.health,
            shield=u.shield,
            energy=u.energy,
            build_progress=u.build_progress,
            hallucination=u.is_hallucination,
            orders=[
                dict(
                    ability_id=q.ability_id,
                    progress=q.progress,
                    target_tag=q.target_unit_tag,
                    target_position=[q.target_world_space_pos.x, q.target_world_space_pos.y]
                    if q.HasField("target_world_space_pos")
                    else None,
                )
                for q in u.orders
            ],
        )

    own = [u for u in units if u.owner == own_id]
    enemies = [
        u
        for u in units
        if u.alliance == 4
        and u.display_type == 1
        and u.cloak not in (1, 2)
        and abs(u.pos.x - camera.x) < 12
        and abs(u.pos.y - camera.y) < 6.75
    ]
    pc = ob.player_common
    return dict(
        label=label,
        loop=ob.game_loop,
        seconds=ob.game_loop / 22.4,
        camera=[camera.x, camera.y],
        hud={
            name: getattr(pc, name)
            for name in (
                "minerals",
                "vespene",
                "food_used",
                "food_cap",
                "food_workers",
                "food_army",
                "idle_worker_count",
            )
        },
        own_historical_state=[row(u) for u in own],
        own_counts=dict(Counter(kind(u.unit_type) for u in own if not u.is_hallucination)),
        camera_visible_enemies=[row(u) for u in enemies],
        upgrades=list(ob.raw_data.player.upgrade_ids),
    )


async def review(library, output):
    output.mkdir(parents=True, exist_ok=True)
    original = library.read_bytes()
    candidates = json.loads(original)["protoss_candidates"]
    # Start with the opening whose placement exposed the current bot problem.
    candidates.sort(
        key=lambda x: (not x["replay_id"].startswith("86b7"), x["matchup"], x["site_build_label"])
    )
    controls_path = output / "control.json"
    if not controls_path.exists():
        write_json(controls_path, dict(resume=0, close=False, speed=8))
    proc = psutil.Process()
    state = dict(
        status="starting",
        pid=proc.pid,
        process_created_at=proc.create_time(),
        library_sha256=hashlib.sha256(original).hexdigest(),
        completed=[],
        purpose="Full replay analysis only; no live game or learning",
        observation_scope="Historical own state; camera-local visible enemy state; player camera",
    )

    def publish(**updates):
        state.update(updates, updated_at=datetime.now(timezone.utc).isoformat())
        write_json(output / "status.json", state)

    def controls():
        value = json.loads(controls_path.read_text())
        if (output / "STOP").exists() or value.get("close"):
            raise asyncio.CancelledError("Replay review close requested")
        return value

    async def pause(label):
        token = controls().get("resume", 0)
        publish(status="paused", pause_label=label, resume_token=token)
        while controls().get("resume", 0) <= token:
            await asyncio.sleep(0.15)
        publish(status="playing", pause_label=None)

    publish()
    try:
        for index, candidate in enumerate(candidates):
            path = Path(candidate["source_path"])
            info = inspect_replay(path)
            assert info["replay_id"] == candidate["source_sha256"] == candidate["replay_id"]
            assert candidate["partition"] == "train" and candidate["result"] == "Victory"
            player = select_player(info, player_name="ReSpOnSe")
            assert player["starting_workers"] == 8 and info["base_build"] == 97563
            folder = output / info["replay_id"][:12]
            folder.mkdir(exist_ok=False)
            write_json(folder / "source.json", dict(candidate=candidate, replay_info=info, player=player))
            label = candidate["site_build_label"]
            publish(
                status="starting_replay",
                index=index,
                label=label,
                replay_id=info["replay_id"],
                expected_loop=info["game_loops"],
                duration_seconds=info["duration_seconds"],
                current_directory=str(folder),
                map=info["map_name"],
                game_seconds=0,
            )
            process = ManagedSC2Process(
                fullscreen=False,
                resolution=(1280, 720),
                base_build=f"Base{info['base_build']}",
                data_hash=info["data_version"],
            )
            async with process as server:
                publish(
                    sc2pid=process._process.pid,
                    sc2_process_created_at=psutil.Process(process._process.pid).create_time(),
                )
                options = api.InterfaceOptions(raw=True, score=True, raw_affects_selection=False)
                configure_interface(options)
                req = api.RequestStartReplay(
                    replay_data=path.read_bytes(),
                    observed_player_id=player["player_id"],
                    disable_fog=False,
                    realtime=False,
                    options=options,
                )
                map_data, _ = local_map_data(info)
                if map_data:
                    req.map_data = map_data
                started = await server._execute(start_replay=req)
                if started.start_replay.HasField("error"):
                    raise RuntimeError(started.start_replay.error_details)
                await server._execute(
                    obs_action=api.RequestObserverAction(
                        actions=[
                            api.ObserverAction(
                                camera_follow_player=api.ActionObserverCameraFollowPlayer(
                                    player_id=player["player_id"]
                                )
                            )
                        ]
                    )
                )
                duration = info["duration_seconds"]
                phases = sorted(
                    {t for t in (120, 240, 360, 600, 900, max(30, int(duration) - 20)) if t < duration - 2}
                )
                loop = -1
                next_phase = 0
                with (folder / "observations.jsonl").open("w", encoding="utf-8") as stream:
                    while True:
                        response = await server._execute(observation=api.RequestObservation())
                        record = snapshot(response, label, player["player_id"])
                        if record["loop"] <= loop:
                            raise RuntimeError("Replay failed to advance")
                        loop = record["loop"]
                        stream.write(json.dumps(record) + "\n")
                        stream.flush()
                        write_json(output / "current_snapshot.json", record)
                        publish(status="playing", game_seconds=record["seconds"], game_loop=loop)
                        terminal = bool(response.observation.player_result) or loop >= info["game_loops"]
                        if terminal:
                            result = dict(
                                label=label,
                                replay_id=info["replay_id"],
                                final_loop=loop,
                                expected_loop=info["game_loops"],
                                reached_terminal=bool(response.observation.player_result),
                                complete=bool(response.observation.player_result)
                                or loop >= info["game_loops"],
                                results=[
                                    dict(player_id=p.player_id, result=p.result)
                                    for p in response.observation.player_result
                                ],
                            )
                            write_json(folder / "completion.json", result)
                            state["completed"].append(result)
                            await pause("end_of_replay")
                            break
                        if next_phase < len(phases) and record["seconds"] >= phases[next_phase]:
                            checkpoint = phases[next_phase]
                            next_phase += 1
                            write_json(folder / f"phase-{checkpoint:04d}.json", record)
                            await pause(f"phase_{checkpoint}")
                        speed = float(controls().get("speed", 8))
                        if not 0.5 <= speed <= 16:
                            raise ValueError("Review speed must be between0.5and16")
                        count = min(44, info["game_loops"] - loop)
                        before = time.monotonic()
                        await server._execute(step=api.RequestStep(count=count))
                        await asyncio.sleep(max(0, count / 22.4 / speed - (time.monotonic() - before)))
        publish(status="complete", pause_label=None)
    except asyncio.CancelledError as error:
        publish(status="closed", error=str(error))
    except BaseException as error:
        publish(status="failed", error=f"{type(error).__name__}: {error}")
        raise


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--library", type=Path, required=True)
    parser.add_argument("--output", type=Path, required=True)
    args = parser.parse_args()
    from loguru import logger

    logger.remove()
    asyncio.run(review(args.library, args.output))
