"""Pause three verified historical PvZ replays at their own natural walls.

Default is an offline, read-only plan. --run explicitly starts isolated replay
playback only after the full replay viewer has exited. No gameplay/debug/query
commands are sent. Native screenshots are inspected separately by the operator.
"""
from __future__ import annotations

import argparse
import asyncio
from datetime import datetime, timezone
import hashlib
import json
import math
from pathlib import Path
import time

from google.protobuf.json_format import MessageToDict
import numpy as np
import psutil
from s2clientprotocol import common_pb2 as common
from s2clientprotocol import data_pb2 as data
from s2clientprotocol import sc2api_pb2 as api
from sc2.ids.unit_typeid import UnitTypeId

from pluto_sc2.fairplay import configure_interface
from pluto_sc2.replay_viewer import local_map_data
from pluto_sc2.replays import inspect_replay, select_player
from pluto_sc2.runner import ManagedSC2Process, write_json

ROOT = Path(__file__).resolve().parents[1]
REVIEW = ROOT / "runs/full-replay-review-20260925"
DEFAULT_OUTPUT = ROOT / "runs/pvz-wall-review-20260925"
PHASES = (120, 180, 240, 300)
EXPECTED_IDS = frozenset({
    "86b7fe43c4943f1ec34736c540f4ddf3dbf1bcc2db1074cefa4c474233b92c94",
    "d001d64c3a4c5f60451b723144c6e5e6f3cf8a902ec32c92466224a9487a164e",
    "fca4dd57cab0c3176728243e7ab9c303f8a16eeba10d3fbe5eaca52d3fbda6ed",
})


def read(path):
    return json.loads(Path(path).read_text(encoding="utf-8"))


def digest(path):
    return hashlib.sha256(Path(path).read_bytes()).hexdigest()


def require(condition, message):
    if not condition:
        raise ValueError(message)


def unit_name(unit_id):
    try:
        return UnitTypeId(unit_id).name
    except ValueError:
        return str(unit_id)


def build_plan(review=REVIEW):
    """Validate provenance without starting SC2 or creating output files."""
    manifest_path = Path(review) / "manifest.json"
    manifest = read(manifest_path)
    sources = {Path(row["path"]).name: row for row in manifest["sources"]}
    for source in sources.values():
        require(digest(source["path"]) == source["sha256"], "Reviewed source manifest changed")
    library = read(sources["multi-opening-library-v2.json"]["path"])
    split = read(sources["response90-replay-split.json"]["path"])
    train = {row["replay_id"] for row in split["train_replay_ids"]}
    heldout = {row["replay_id"] for row in split["validation_replay_ids"]}
    require(not train & heldout, "Whole-replay train/validation overlap")
    candidates = {c["replay_id"]: c for c in library["protoss_candidates"] if c["matchup"] == "PvZ"}
    require(set(candidates) == EXPECTED_IDS, "Expected exactly the three reviewed PvZ sources")
    reviewed = {r["replay_id"]: r for r in manifest["replays"]}
    result = []
    for replay_id in sorted(candidates):
        candidate, entry = candidates[replay_id], reviewed[replay_id]
        require(replay_id in train and replay_id not in heldout, "PvZ example is not TRAIN-only")
        require(candidate["partition"] == "train" and candidate["result"] == "Victory",
                "Expected winning TRAIN example")
        require(digest(entry["path"]) == entry["sha256"], "Full-review artifact changed")
        artifact = read(entry["path"])
        path = Path(candidate["source_path"]).resolve()
        require(path == Path(artifact["source_path"]).resolve(), "Replay source path mismatch")
        require(digest(path) == replay_id == candidate["source_sha256"], "Replay hash mismatch")
        info = inspect_replay(path)
        player = select_player(info, player_name="ReSpOnSe")
        require(info["replay_id"] == replay_id and info["base_build"] == 97563,
                "Replay version or identity mismatch")
        require(bool(info["data_version"]), "Replay lacks exact DataVersion")
        require(player["starting_workers"] == 8 and player["player_id"] == artifact["selected_player_id"],
                "Wrong eight-worker player perspective")
        own_bases = [b for b in artifact["base_placements"]
                     if b["owner_player_id"] == player["player_id"] and b["type"].upper() == "NEXUS"]
        main = next(b for b in own_bases if b["game_loop"] == 0)
        natural = next(b for b in own_bases if b["game_loop"] > 0
                       and math.dist(b["position"], main["position"]) > 8)
        result.append(dict(label=candidate["site_build_label"], replay_id=replay_id,
                           source_path=str(path), source_sha256=replay_id, replay_info=info, player=player,
                           review_path=entry["path"], review_sha256=entry["sha256"],
                           natural_tracker_position=natural["position"],
                           natural_started_seconds=natural["seconds"], main_tracker_position=main["position"]))
    return dict(manifest_path=str(manifest_path), manifest_sha256=digest(manifest_path),
                source_manifests=list(sources.values()), phases=list(PHASES), replays=result,
                scope="Historical own wall geometry only; no live bot data or policy activation")


def identity_alive(pid, created):
    try:
        return abs(psutil.Process(pid).create_time() - created) < .01
    except psutil.NoSuchProcess:
        return False


def require_idle_engine(review=REVIEW):
    """Never attach to or terminate a user game, learner, or existing viewer."""
    status_path = Path(review) / "engine-views/status.json"
    if status_path.exists():
        status = read(status_path)
        require(not identity_alive(status["pid"], status["process_created_at"]),
                "Full replay review driver is still alive; close it before wall inspection")
        require(status["status"] in {"complete", "closed"}, "Full replay review has not closed cleanly")
    for process in psutil.process_iter(["pid", "name", "create_time"]):
        require((process.info["name"] or "").casefold() not in {"sc2_x64.exe", "sc2.exe"},
                f"An SC2 process already exists (PID {process.pid}); no second engine will start")


def grid_array(grid):
    """Same [y,x] convention as Burnysc2 PixelMap; preserve unmodified bytes too."""
    width, height = grid.size.x, grid.size.y
    require(width > 0 and height > 0, "Empty public grid")
    raw = np.frombuffer(grid.data, dtype=np.uint8)
    if grid.bits_per_pixel == 1:
        require(len(raw) == math.ceil(width * height / 8), "Malformed packed grid")
        raw = np.unpackbits(raw, bitorder="big")[:width * height]
    else:
        require(grid.bits_per_pixel == 8 and len(raw) == width * height, "Unsupported grid encoding")
    return raw.reshape(height, width)


def save_map_grids(folder, game_info):
    grids = {}
    for name in ("placement_grid", "pathing_grid", "terrain_height"):
        grid = getattr(game_info.start_raw, name)
        array = grid_array(grid)
        path = folder / f"{name}.bin"
        path.write_bytes(grid.data)
        grids[name] = dict(path=path.name, sha256=digest(path), width=grid.size.x, height=grid.size.y,
                           bits_per_pixel=grid.bits_per_pixel, numpy=array)
    write_json(folder / "public-map.json", dict(
        map_name=game_info.map_name,
        map_size=MessageToDict(game_info.start_raw.map_size, preserving_proto_field_name=True),
        playable_area=MessageToDict(game_info.start_raw.playable_area, preserving_proto_field_name=True),
        grids={name: {k: v for k, v in row.items() if k != "numpy"} for name, row in grids.items()},
        convention="[y,x], SC2 world coordinates; packed bits unpack MSB first; nonzero pathing/placement means set",
        limitation="Engine-returned replay map grids; differences can show blocked cells, but do not alone prove unit-radius traversability"))
    return grids


def save_public_data(folder, game_info, game_data):
    grids = save_map_grids(folder, game_info)
    (folder / "public-game-data.pb").write_bytes(game_data.SerializeToString())
    units = {u.unit_id: u for u in game_data.units}
    abilities = {a.ability_id: a for a in game_data.abilities}
    metadata = {}
    for unit in game_data.units:
        if unit.race != common.Protoss:
            continue
        ability = abilities.get(unit.ability_id)
        metadata[unit.unit_id] = dict(
            type=unit_name(unit.unit_id), ability_id=unit.ability_id,
            attributes=[data.Attribute.Name(a) for a in unit.attributes],
            public_footprint_radius_estimate=(ability.footprint_radius
                if ability and ability.HasField("footprint_radius") else None),
            public_ability=MessageToDict(ability, preserving_proto_field_name=True) if ability else None)
    write_json(folder / "public-protoss-footprints.json", dict(units=metadata,
        limitation="AbilityData footprint_radius is explicitly an estimate; raw Unit.radius is a separate observed radius. Neither proves gap width."))
    return grids, units


def overview_center(record, row):
    """Include own natural and nearby wall pieces; never infer an entrance gap."""
    natural = record["natural_raw_position"] or row["natural_tracker_position"]
    main = row["main_tracker_position"]
    minimum_main_distance = math.dist(main, natural) - 5
    points = [natural]
    for unit in record["own_near_natural"]:
        if (unit["is_structure"] and unit["type"] not in {"NEXUS", "ASSIMILATOR"}
                and math.dist(unit["position"], natural) <= 18
                and math.dist(unit["position"], main) >= minimum_main_distance):
            points.append(unit["position"])
    return [(min(p[axis] for p in points) + max(p[axis] for p in points)) / 2 for axis in (0, 1)]


def wall_snapshot(response, row, requested_center, grids, units):
    ob = response.observation.observation
    target = row["natural_tracker_position"]
    own = [u for u in ob.raw_data.units if u.owner == row["player"]["player_id"]]
    bases = [u for u in own if u.unit_type == UnitTypeId.NEXUS.value
             and math.dist((u.pos.x, u.pos.y), target) < 3]
    natural = min(bases, key=lambda u: math.dist((u.pos.x, u.pos.y), target)) if bases else None
    center = [natural.pos.x, natural.pos.y] if natural else target
    records = []
    for unit in own:
        position = [unit.pos.x, unit.pos.y]
        if math.dist(position, center) > 28:
            continue
        public = units.get(unit.unit_type)
        records.append(dict(tag=unit.tag, type=unit_name(unit.unit_type), unit_type_id=unit.unit_type,
            position=position, z=unit.pos.z, radius=unit.radius, facing=unit.facing,
            build_progress=unit.build_progress, health=unit.health, shield=unit.shield,
            is_structure=bool(public and data.Structure in public.attributes),
            is_flying=unit.is_flying, is_hallucination=unit.is_hallucination,
            display_type=unit.display_type,
            orders=[dict(ability_id=o.ability_id, progress=o.progress,
                         target_tag=o.target_unit_tag if o.HasField("target_unit_tag") else None,
                         target_position=[o.target_world_space_pos.x, o.target_world_space_pos.y]
                         if o.HasField("target_world_space_pos") else None) for o in unit.orders]))
    crops = {}
    for name, grid in grids.items():
        x0, y0 = max(0, math.floor(center[0] - 26)), max(0, math.floor(center[1] - 26))
        x1, y1 = min(grid["width"], math.ceil(center[0] + 27)), min(grid["height"], math.ceil(center[1] + 27))
        crops[name] = dict(origin_xy=[x0, y0], shape_yx=[y1-y0, x1-x0], rows_y_ascending=grid["numpy"][y0:y1, x0:x1].tolist())
    return dict(replay_id=row["replay_id"], label=row["label"], game_loop=ob.game_loop,
                seconds=ob.game_loop / 22.4, observed_player_id=row["player"]["player_id"],
                requested_observer_camera=requested_center,
                raw_player_camera=[ob.raw_data.player.camera.x, ob.raw_data.player.camera.y],
                raw_player_camera_note="May be recorded player camera; not proof of rendered observer camera alignment",
                natural_tracker_position=target, natural_raw_position=center if natural else None,
                own_near_natural=records, map_grid_crops=crops,
                scope="Own historical replay units only; unit centers/radii are engine float values, not tracker integers",
                gap_width_verified=False, guard_role_verified=False)


async def run(plan, output, *, review=REVIEW):
    require_idle_engine(review)
    output = Path(output)
    require(not output.exists(), "Use a fresh output directory; existing evidence is immutable")
    output.mkdir(parents=True, exist_ok=False)
    write_json(output / "plan.json", plan)
    write_json(output / "control.json", dict(resume=0, close=False, speed=16))
    process = psutil.Process()
    state = dict(status="starting", pid=process.pid, process_created_at=process.create_time(),
                 purpose=plan["scope"], completed=[], sc2pid=None, sc2_process_created_at=None)

    def publish(**values):
        state.update(values, updated_at=datetime.now(timezone.utc).isoformat())
        write_json(output / "status.json", state)

    def controls():
        control = read(output / "control.json")
        if (output / "STOP").exists() or control.get("close"):
            raise asyncio.CancelledError("Wall replay review close requested")
        require(type(control.get("resume")) is int and control["resume"] >= 0, "Invalid resume token")
        speed = control.get("speed", 16)
        require(not isinstance(speed, bool) and isinstance(speed, (int, float))
                and math.isfinite(speed) and .5 <= speed <= 16, "Speed must be between0.5and16")
        return control

    publish()
    try:
        for index, row in enumerate(plan["replays"]):
            controls()
            require_idle_engine(review)
            require(digest(row["source_path"]) == row["source_sha256"], "Replay changed after planning")
            require(digest(row["review_path"]) == row["review_sha256"], "Review changed after planning")
            info = row["replay_info"]
            folder = output / row["replay_id"][:12]
            folder.mkdir()
            write_json(folder / "source.json", row)
            publish(status="starting_replay", index=index, label=row["label"], replay_id=row["replay_id"],
                    current_directory=str(folder), pause_label=None)
            engine = ManagedSC2Process(fullscreen=False, resolution=(1280, 720),
                                       base_build=f"Base{info['base_build']}", data_hash=info["data_version"])
            async with engine as server:
                pid = engine._process.pid
                publish(sc2pid=pid, sc2_process_created_at=psutil.Process(pid).create_time())
                ping = (await server.ping()).ping
                require(ping.base_build == info["base_build"]
                        and ping.data_version.upper() == info["data_version"].upper(), "Exact engine version mismatch")
                options = api.InterfaceOptions(raw=True, score=True, raw_affects_selection=False)
                configure_interface(options)
                request = api.RequestStartReplay(replay_data=Path(row["source_path"]).read_bytes(),
                    observed_player_id=row["player"]["player_id"], disable_fog=False, realtime=False, options=options)
                map_data, _ = local_map_data(info)
                if map_data:
                    request.map_data = map_data
                started = await server._execute(start_replay=request)
                require(not started.start_replay.HasField("error"), started.start_replay.error_details)
                await server._execute(obs_action=api.RequestObserverAction(actions=[api.ObserverAction(
                    player_perspective=api.ActionObserverPlayerPerspective(player_id=row["player"]["player_id"]))]))
                game_info = (await server._execute(game_info=api.RequestGameInfo())).game_info
                game_data = (await server._execute(data=api.RequestData(unit_type_id=True, ability_id=True))).data
                grids, units = save_public_data(folder, game_info, game_data)
                loop = -1
                response = await server._execute(observation=api.RequestObservation())
                for phase in PHASES:
                    target_loop = round(phase * 22.4)
                    while response.observation.observation.game_loop < target_loop:
                        controls()
                        require(not response.observation.player_result, "Replay ended before requested wall phase")
                        current = response.observation.observation.game_loop
                        require(current > loop, "Wall replay failed to advance")
                        loop = current
                        count = min(44, target_loop-current)
                        speed = controls()["speed"]
                        before = time.monotonic()
                        await server._execute(step=api.RequestStep(count=count))
                        response = await server._execute(observation=api.RequestObservation())
                        publish(status="playing", game_loop=response.observation.observation.game_loop,
                                game_seconds=response.observation.observation.game_loop/22.4)
                        await asyncio.sleep(max(0, count/22.4/speed-(time.monotonic()-before)))
                    provisional = wall_snapshot(response, row, row["natural_tracker_position"], grids, units)
                    center = provisional["natural_raw_position"] or row["natural_tracker_position"]
                    await server._execute(obs_action=api.RequestObserverAction(actions=[api.ObserverAction(
                        camera_move=api.ActionObserverCameraMove(world_pos=common.Point2D(x=center[0], y=center[1]), distance=0))]))
                    # One replay tick lets the renderer apply the observer move.
                    await server._execute(step=api.RequestStep(count=1))
                    response = await server._execute(observation=api.RequestObservation())
                    record = wall_snapshot(response, row, center, grids, units)
                    overview = overview_center(record, row)
                    await server._execute(obs_action=api.RequestObserverAction(actions=[api.ObserverAction(
                        camera_move=api.ActionObserverCameraMove(world_pos=common.Point2D(x=overview[0], y=overview[1]), distance=40))]))
                    await server._execute(step=api.RequestStep(count=1))
                    response = await server._execute(observation=api.RequestObservation())
                    phase_grid_folder = folder / f"phase-{phase:04d}-grids"
                    phase_grid_folder.mkdir()
                    current_info = (await server._execute(game_info=api.RequestGameInfo())).game_info
                    current_grids = save_map_grids(phase_grid_folder, current_info)
                    record = wall_snapshot(response, row, overview, current_grids, units)
                    record.update(natural_camera_request=center, observer_distance_requested=40,
                                  grid_scope="GameInfo requested at this phase; initial grids retained separately",
                                  grid_directory=phase_grid_folder.name,
                                  initial_grid_changed_cells={name: int(np.count_nonzero(
                                      current_grids[name]["numpy"] != grids[name]["numpy"])) for name in grids})
                    write_json(folder / f"phase-{phase:04d}.json", record)
                    write_json(output / "current_snapshot.json", record)
                    token = controls()["resume"]
                    publish(status="paused", pause_label=f"phase_{phase}", resume_token=token,
                            game_loop=record["game_loop"], game_seconds=record["seconds"],
                            requested_observer_camera=overview, snapshot_path=str(folder / f"phase-{phase:04d}.json"))
                    while controls()["resume"] <= token:
                        await asyncio.sleep(.15)
                    publish(status="playing", pause_label=None)
                require(digest(row["source_path"]) == row["source_sha256"], "Replay changed during review")
                completion = dict(replay_id=row["replay_id"], phases=list(PHASES),
                                  scope="Early natural-wall phases only; not complete replay playback")
                write_json(folder / "completion.json", completion)
                state["completed"].append(completion)
            publish(sc2pid=None, sc2_process_created_at=None)
        publish(status="complete", pause_label=None)
    except asyncio.CancelledError as error:
        publish(status="closed", error=str(error), sc2pid=None, sc2_process_created_at=None)
    except BaseException as error:
        publish(status="failed", error=f"{type(error).__name__}: {error}")
        raise


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--output", type=Path, default=DEFAULT_OUTPUT)
    parser.add_argument("--run", action="store_true", help="Start replay inspection; otherwise validate and print the plan only")
    args = parser.parse_args()
    plan = build_plan()
    if args.run:
        from loguru import logger
        logger.remove()
        asyncio.run(run(plan, args.output))
    else:
        print(json.dumps({"launch_requested": False, "output": str(args.output),
            "phases": plan["phases"], "replays": [{k: row[k] for k in (
                "label", "replay_id", "natural_tracker_position", "natural_started_seconds")} for row in plan["replays"]]}, indent=2))
