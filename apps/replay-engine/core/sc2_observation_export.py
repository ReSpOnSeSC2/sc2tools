"""Replay observations from Blizzard's installed simulation, never command targets.

The optional dependencies live in ``requirements-observations.txt``. This module
is importable without them, so ordinary tracker parsing keeps working. Exports
are local artifacts; callers explicitly opt into starting a hidden SC2 process.

Protocol: https://github.com/Blizzard/s2client-proto/blob/master/s2clientprotocol/raw.proto
Launch/version selection: https://github.com/google-deepmind/pysc2/blob/master/pysc2/lib/sc_process.py
"""
from __future__ import annotations

import argparse
import hashlib
import json
import math
import os
from pathlib import Path
import re
import socket
import subprocess
import tempfile
import time
from typing import Any, Callable

LOOPS_PER_SECOND = 22.4
ARTIFACT_VERSION = 1
MAX_ARTIFACT_BYTES = 128 * 1024 * 1024


class ObservationExportError(RuntimeError):
    """A bounded engine export failed; no incomplete artifact is published."""


def replay_digest(replay_path: str | Path) -> str:
    digest = hashlib.sha256()
    with Path(replay_path).open("rb") as replay_file:
        for block in iter(lambda: replay_file.read(1024 * 1024), b""):
            digest.update(block)
    return digest.hexdigest()


def encode_bit_runs(data: bytes, width: int, height: int, bits_per_pixel: int = 1) -> list[int]:
    """SC2 ImageData rows in world y order, MSB-first packed bits -> set runs."""
    if width <= 0 or height <= 0 or width * height > 1024 * 1024 or bits_per_pixel not in (1, 8):
        raise ObservationExportError("Unsupported engine bitmap dimensions or format")
    count = width * height
    if len(data) != (count * bits_per_pixel + 7) // 8:
        raise ObservationExportError("Engine returned an incomplete bitmap")
    runs: list[int] = []
    start = -1
    for index in range(count):
        present = data[index] != 0 if bits_per_pixel == 8 else bool(data[index >> 3] & (1 << (7 - (index & 7))))
        if present and start < 0:
            start = index
        elif not present and start >= 0:
            runs.extend((start, index - start))
            start = -1
    if start >= 0:
        runs.extend((start, count - start))
    return runs


def append_observed_waypoint(points: list[float], t: float, x: float, y: float) -> None:
    """Losslessly collapse runs of stationary samples, preserving departure."""
    sample = [round(t, 4), round(x, 4), round(y, 4)]
    if len(points) >= 3 and points[-3] == sample[0]:
        points[-3:] = sample
    elif len(points) >= 6 and points[-2:] == sample[1:] and points[-5:-3] == sample[1:]:
        points[-3:] = sample
    else:
        points.extend(sample)


def flip_bitmap_rows(data: bytes, width: int, height: int, bits_per_pixel: int = 1) -> bytes:
    """Normalize feature-layer top-left pixels to the raw world bottom-left."""
    if width <= 0 or height <= 0 or bits_per_pixel not in (1, 8):
        raise ObservationExportError("Invalid feature creep bitmap")
    if len(data) != (width * height * bits_per_pixel + 7) // 8:
        raise ObservationExportError("Feature creep bitmap has an invalid byte count")
    row_bits = width * bits_per_pixel
    if row_bits % 8 == 0:
        stride = row_bits // 8
        return b"".join(data[y * stride:(y + 1) * stride] for y in range(height - 1, -1, -1))
    output = bytearray(len(data))
    for y in range(height):
        for x in range(width):
            src = (height - 1 - y) * width + x
            dst = y * width + x
            if data[src >> 3] & (1 << (7 - (src & 7))):
                output[dst >> 3] |= 1 << (7 - (dst & 7))
    return bytes(output)


def merge_observed_effects(passes: list[dict]) -> list[dict]:
    """Union unknown-owner effects seen by both perspectives without duplicates."""
    result = []
    neutral = {}
    for effect in sorted((effect for part in passes for effect in part["effects"]), key=lambda effect: effect["t"]):
        effect = dict(effect)
        if effect["owner"] == "neutral":
            key = (effect["id"], effect["x"], effect["y"], effect["radius"])
            previous = neutral.get(key)
            if previous is not None and effect["t"] <= previous["end"]:
                previous["end"] = max(previous["end"], effect["end"])
                continue
            neutral[key] = effect
        result.append(effect)
    return result


class ObservationAccumulator:
    """Pure state accumulator, tested without launching SC2."""

    def __init__(self, my_pid: int, unit_data: dict[int, dict], effect_data: dict[int, str], sample_seconds: float):
        self.my_pid = my_pid
        self.unit_data = unit_data
        self.effect_data = effect_data
        self.sample_seconds = sample_seconds
        self.units: dict[str, dict] = {}
        self.closed_segments: list[dict] = []
        self.active_effects: dict[tuple, dict] = {}
        self.effects: list[dict] = []
        self.creep_frames: list[dict] = []
        self.creep_size: tuple[int, int] | None = None
        self.last_creep: bytes | None = None
        self.last_time = 0.0
        self.attack_channel_seen = False

    def observe(self, frame: dict, capture_creep: bool = True) -> None:
        t = float(frame["t"])
        if not math.isfinite(t) or t < self.last_time:
            raise ObservationExportError("Engine observation timeline moved backwards")
        self.last_time = t
        for departed in frame.get("departed_tags", []):
            record = self.units.pop(str(departed), None)
            if record is not None:
                record["died"] = round(t, 4)
                record["killer_pid"] = None
                append_observed_waypoint(record["waypoints"], t, record["waypoints"][-2], record["waypoints"][-1])
                self.closed_segments.append(record)
        seen: set[str] = set()
        for unit in frame.get("units", []):
            owner = int(unit["owner"])
            if owner <= 0 or owner >= 16 or unit.get("display_type", 1) != 1:
                continue  # Neutral furniture, snapshots and queued placeholders are not live units.
            tag = str(unit["tag"])
            seen.add(tag)
            info = self.unit_data.get(int(unit["unit_type"]), {})
            name = info.get("name") or f"Unit{unit['unit_type']}"
            record = self.units.get(tag)
            if record is not None and (record["structure"] != bool(info.get("structure")) or record["owner_pid"] != owner):
                # Drone -> building and owner changes are new rendered lives,
                # not retroactive changes to the entity's initial category.
                record["died"] = round(t, 4)
                record["killer_pid"] = None
                append_observed_waypoint(record["waypoints"], t, record["waypoints"][-2], record["waypoints"][-1])
                if record["_hidden_since"] is not None:
                    record["hidden"].extend([record["_hidden_since"], round(t, 4)])
                    record["_hidden_since"] = None
                self.closed_segments.append(record)
                record = None
            if record is None:
                record = {"id": tag, "name": name, "born": round(t, 4), "died": None,
                          "owner_pid": owner, "structure": bool(info.get("structure")),
                          "waypoints": [], "forms": [], "hidden": [], "_hidden_since": None,
                          "attacks": [], "aim": [], "_cooldown": None, "_weapon_seen_at": None,
                          "_name": name}
                self.units[tag] = record
            elif record["died"] is not None:
                raise ObservationExportError("A dead engine unit tag was reused")
            if record["_hidden_since"] is not None:
                record["hidden"].extend([record["_hidden_since"], round(t, 4)])
                record["_hidden_since"] = None
                record["_cooldown"] = None
            if name != record["_name"]:
                record["forms"].append({"t": round(t, 4), "name": name})
                record["_name"] = name
                record["_cooldown"] = None
            append_observed_waypoint(record["waypoints"], t, float(unit["x"]), float(unit["y"]))
            cooldown = unit.get("weapon_cooldown")
            if isinstance(cooldown, (int, float)) and math.isfinite(cooldown):
                self.attack_channel_seen = True
                # SC2 can report slightly negative ready-state cooldowns.
                # Settling from a negative value to zero is not a shot.
                cooldown = max(0.0, float(cooldown))
                previous = record["_cooldown"]
                previous_time = record["_weapon_seen_at"]
                consecutive = previous_time is not None and 0 < t - previous_time <= self.sample_seconds * 1.5 + 1e-4
                if cooldown > 1e-3 and previous is not None and cooldown > previous + 1e-3 and consecutive:
                    # A positive reset observes a weapon cycle. Attack orders,
                    # target acquisition, and nearby enemies alone never do.
                    shot_time = round(t, 4)
                    record["attacks"].append(shot_time)
                    target = unit.get("target_position")
                    if isinstance(target, (list, tuple)) and len(target) == 2 and all(
                            isinstance(value, (int, float)) and math.isfinite(value) for value in target):
                        record["aim"].extend([shot_time, round(target[0], 4), round(target[1], 4)])
                record["_cooldown"] = cooldown
                record["_weapon_seen_at"] = t
            else:
                # Never compare a new sample against stale weapon telemetry.
                record["_cooldown"] = None
                record["_weapon_seen_at"] = None
        for dead in frame.get("dead_units", []):
            record = self.units.get(str(dead))
            if record is not None:
                record["died"] = round(t, 4)
        for tag, record in self.units.items():
            if tag not in seen and record["died"] is None and record["_hidden_since"] is None:
                # Transport cargo is absent from raw units. Keep its life and
                # position but hide it until it is observed again.
                record["_hidden_since"] = round(t, 4)
                # Bound the interpolation before pickup. Otherwise a short
                # absence could interpolate toward the later unload position
                # while the passenger is still shown outside the transport.
                append_observed_waypoint(record["waypoints"], t, record["waypoints"][-2], record["waypoints"][-1])

        effect_keys: set[tuple] = set()
        for effect in frame.get("effects", []):
            owner = int(effect.get("owner", 0))
            if owner < 0 or owner > 16:
                continue
            for position in effect.get("positions", []):
                x, y = (round(float(value), 4) for value in position)
                effect_id = int(effect["id"])
                radius = round(float(effect["radius"]), 4)
                key = (effect_id, owner, x, y, radius)
                effect_keys.add(key)
                if key not in self.active_effects:
                    record = {"id": effect_id, "name": self.effect_data.get(effect_id, f"Effect{effect_id}"),
                              "owner": "me" if owner == self.my_pid else ("opp" if 0 < owner < 16 else "neutral"), "t": round(t, 4),
                              "end": round(t + self.sample_seconds, 4), "x": x, "y": y, "radius": radius}
                    self.effects.append(record)
                    self.active_effects[key] = record
                self.active_effects[key]["end"] = round(t + self.sample_seconds, 4)
        for key in list(self.active_effects):
            if key not in effect_keys:
                self.active_effects[key]["end"] = round(t, 4)
                del self.active_effects[key]

        creep = frame.get("creep")
        if capture_creep and creep is not None:
            width, height = int(creep["width"]), int(creep["height"])
            if self.creep_size is not None and self.creep_size != (width, height):
                raise ObservationExportError("Engine creep bitmap dimensions changed during replay")
            self.creep_size = (width, height)
            data = bytes(creep["data"])
            if data != self.last_creep:
                self.creep_frames.append({"t": round(t, 4), "runs": encode_bit_runs(data, width, height,
                    int(creep.get("bits_per_pixel", 1)))})
                self.last_creep = data

    def result(self, complete: bool) -> dict:
        result: dict[str, Any] = {"my_units": [], "opp_units": [], "my_buildings": [], "opp_buildings": []}
        for stored in [*self.closed_segments, *self.units.values()]:
            record = {key: value for key, value in stored.items() if not key.startswith("_")}
            prefix = "my_" if record.pop("owner_pid") == self.my_pid else "opp_"
            structure = record.pop("structure")
            if stored["_hidden_since"] is not None:
                record["hidden"] = [*record["hidden"], stored["_hidden_since"], round(self.last_time + self.sample_seconds, 4)]
            if not record["hidden"]:
                record.pop("hidden")
            if not record["forms"]:
                record.pop("forms")
            if not record["attacks"]:
                record.pop("attacks")
            if not record["aim"]:
                record.pop("aim")
            if structure:
                waypoints = record.pop("waypoints")
                record.update({"x": waypoints[1], "y": waypoints[2], "moves": waypoints[3:]})
            else:
                record["is_worker"] = record["name"] in {"Drone", "SCV", "Probe", "MULE"}
            result[prefix + ("buildings" if structure else "units")].append(record)
        result["effects"] = [{**effect, "end": min(effect["end"], self.last_time + self.sample_seconds)} for effect in self.effects]
        if self.creep_size is not None:
            result["creep"] = {"width": self.creep_size[0], "height": self.creep_size[1],
                               "encoding": "rle", "frames": self.creep_frames}
        result["fidelity"] = {"positions": "engine", "paths": "observed",
                              "creep": "observed" if self.creep_size is not None else "unavailable",
                              "attacks": "observed" if self.attack_channel_seen else "unavailable",
                              "complete": complete, "sampleSeconds": round(self.sample_seconds, 4)}
        return result


class _Engine:
    def __init__(self, install: Path, executable: Path, data_version: str | None, timeout: float):
        self.install, self.executable, self.data_version, self.timeout = install, executable, data_version, timeout
        self.process = None
        self.ws = None
        self.temp = None
        self.log = None
        self.request_id = 0

    def __enter__(self):
        try:
            import websocket
            from s2clientprotocol import sc2api_pb2
        except ImportError as exc:
            raise ObservationExportError("Install requirements-observations.txt for engine replay export") from exc
        self.api = sc2api_pb2
        self.websocket = websocket
        self.temp = tempfile.TemporaryDirectory(prefix="sc2-observation-")
        with socket.socket() as reserve:
            reserve.bind(("127.0.0.1", 0))
            port = reserve.getsockname()[1]
        args = [str(self.executable), "-listen", "127.0.0.1", "-port", str(port),
                "-dataDir", str(self.install) + os.sep, "-tempDir", self.temp.name + os.sep]
        kwargs: dict = {}
        if os.name == "nt":
            args += ["-displayMode", "0", "-windowwidth", "640", "-windowheight", "480",
                     "-windowx", "-32000", "-windowy", "-32000"]
            startup = subprocess.STARTUPINFO()
            startup.dwFlags |= subprocess.STARTF_USESHOWWINDOW
            startup.wShowWindow = subprocess.SW_HIDE
            kwargs.update(startupinfo=startup, creationflags=subprocess.CREATE_NO_WINDOW)
        if self.data_version:
            args += ["-dataVersion", self.data_version]
        cwd = self.install / "Support64" if os.name == "nt" else self.install
        self.log = (Path(self.temp.name) / "engine.log").open("wb")
        try:
            self.process = subprocess.Popen(args, cwd=cwd, stdin=subprocess.DEVNULL,
                                            stdout=self.log, stderr=self.log, **kwargs)
            deadline = time.monotonic() + min(self.timeout, 60)
            while time.monotonic() < deadline:
                if self.process.poll() is not None:
                    raise ObservationExportError(f"SC2 exited before API startup (code {self.process.returncode})")
                try:
                    self.ws = websocket.create_connection(f"ws://127.0.0.1:{port}/sc2api", timeout=2,
                                                           http_proxy_host=None)
                    self.ws.settimeout(min(self.timeout, 120))
                    return self
                except (OSError, websocket.WebSocketException):
                    time.sleep(0.25)
            raise ObservationExportError("SC2 local API did not start within 60 seconds")
        except BaseException:
            self.close()
            raise

    def request(self, kind: str, **kwargs):
        self.request_id += 1
        request = self.api.Request(id=self.request_id)
        body_type = getattr(self.api, "Request" + "".join(part.title() for part in kind.split("_")))
        getattr(request, kind).CopyFrom(body_type(**kwargs))
        try:
            self.ws.send(request.SerializeToString(), opcode=self.websocket.ABNF.OPCODE_BINARY)
            response = self.api.Response.FromString(self.ws.recv())
        except (OSError, self.websocket.WebSocketException) as exc:
            raise ObservationExportError(f"SC2 {kind} API connection failed: {exc}") from exc
        if response.error:
            raise ObservationExportError("; ".join(response.error))
        if response.id != self.request_id or response.WhichOneof("response") != kind:
            raise ObservationExportError("SC2 returned an unexpected API response")
        body = getattr(response, kind)
        if "error" in body.DESCRIPTOR.fields_by_name and body.HasField("error"):
            raise ObservationExportError(f"SC2 {kind}: {body.error} {getattr(body, 'error_details', '')}")
        return body

    def close(self):
        if self.ws is not None:
            self.ws.close()
            self.ws = None
        if self.process is not None and self.process.poll() is None:
            self.process.terminate()
            try:
                self.process.wait(timeout=5)
            except subprocess.TimeoutExpired:
                self.process.kill()
                self.process.wait(timeout=5)
        if self.log:
            self.log.close()
        if self.temp:
            # TemporaryDirectory owns this exact directory; no user path can
            # influence the cleanup target.
            self.temp.cleanup()

    def __exit__(self, *_):
        self.close()


def _frame_from_proto(observation) -> dict:
    raw = observation.raw_data
    # Everyone perspective supplies global live units but an EMPTY raw creep
    # map. Feature minimap creep is global and is rendered at native map size;
    # flip rows once so exported indices remain ordinary SC2 world coordinates.
    creep = observation.feature_layer_data.minimap_renders.creep
    visible_targets = {unit.tag: unit for unit in raw.units if unit.display_type == 1}
    units = []
    for unit in raw.units:
        row = {"tag": str(unit.tag), "owner": unit.owner, "unit_type": unit.unit_type,
               "display_type": unit.display_type, "x": unit.pos.x, "y": unit.pos.y}
        if unit.HasField("weapon_cooldown"):
            row["weapon_cooldown"] = unit.weapon_cooldown
        target = visible_targets.get(unit.engaged_target_tag)
        if target is not None:
            # Resolve before selecting this pass's own units, so an observed
            # enemy can supply an aim point. Hidden/snapshot positions cannot.
            row["target_position"] = (target.pos.x, target.pos.y)
        units.append(row)
    return {
        "t": observation.game_loop / LOOPS_PER_SECOND,
        "units": units,
        "dead_units": [str(tag) for tag in raw.event.dead_units],
        "effects": [{"id": effect.effect_id, "owner": effect.owner, "radius": effect.radius,
                     "positions": [(point.x, point.y) for point in effect.pos]} for effect in raw.effects],
        "creep": {"width": creep.size.x, "height": creep.size.y,
                  "bits_per_pixel": creep.bits_per_pixel,
                  "data": flip_bitmap_rows(creep.data, creep.size.x, creep.size.y, creep.bits_per_pixel)} if creep.data else None,
    }


def _capture_global_creep(install: Path, executable: Path, version: str, replay_path: Path,
                          map_width: int, map_height: int, step_loops: int, timeout_seconds: float,
                          max_game_seconds: float | None, report: Callable[[str], None]) -> dict:
    """A lightweight Everyone pass; participant feature creep is also masked."""
    from s2clientprotocol import sc2api_pb2
    started = time.monotonic()
    with _Engine(install, executable, version, timeout_seconds) as engine:
        replay_info = engine.request("replay_info", replay_path=str(replay_path), download_data=False)
        engine.request("start_replay", replay_path=str(replay_path), observed_player_id=0, disable_fog=True,
            realtime=False, options=sc2api_pb2.InterfaceOptions(raw=True, show_cloaked=True,
            feature_layer=sc2api_pb2.SpatialCameraSetup(width=24, resolution={"x": 16, "y": 16},
                minimap_resolution={"x": map_width, "y": map_height}, allow_cheating_layers=True,
                crop_to_playable_area=False)))
        info = engine.request("game_info")
        if (info.start_raw.map_size.x, info.start_raw.map_size.y) != (map_width, map_height):
            raise ObservationExportError("Global creep map dimensions do not match replay metadata")
        accumulator = ObservationAccumulator(1, {}, {}, step_loops / LOOPS_PER_SECOND)
        next_report = 0
        complete = False
        while True:
            if time.monotonic() - started > timeout_seconds:
                raise ObservationExportError("Global creep export exceeded its wall-clock timeout")
            response = engine.request("observation", disable_fog=True)
            observation = response.observation
            loop = observation.game_loop
            if loop >= (1 << 31):
                raise ObservationExportError("SC2 returned an invalid creep observation")
            frame = _frame_from_proto(observation)
            if frame["creep"] is None:
                raise ObservationExportError("Global engine creep observations are unavailable")
            accumulator.observe({"t": frame["t"], "creep": frame["creep"]})
            if loop >= next_report:
                report(f"Global creep: {loop / LOOPS_PER_SECOND:.0f}s")
                next_report = loop + int(LOOPS_PER_SECOND * 120)
            if response.player_result or loop >= replay_info.game_duration_loops:
                complete = True
                break
            if max_game_seconds is not None and loop / LOOPS_PER_SECOND >= max_game_seconds:
                break
            engine.request("step", count=min(step_loops, replay_info.game_duration_loops - loop))
        return accumulator.result(complete)


def export_engine_observations(
    replay_path: str | Path,
    my_pid: int,
    sc2_path: str | Path | None = None,
    step_loops: int = 4,
    creep_step_loops: int = 24,
    timeout_seconds: float = 900,
    max_game_seconds: float | None = None,
    download_missing: bool = True,
    progress: Callable[[str], None] | None = None,
) -> dict:
    """Return a lossless local artifact with sampled authoritative positions.

    ``step_loops`` controls observation resolution, not simulation speed. A
    sample is an actual engine state; interpolation between samples remains a
    rendering choice. Partial runs are marked incomplete and never auto-merged.
    """
    if not 1 <= step_loops <= 32 or not 1 <= creep_step_loops <= 224:
        raise ValueError("Observation step must be 1..32 loops; creep step 1..224")
    if not 0 < timeout_seconds <= 7200:
        raise ValueError("Timeout must be positive and at most two hours")
    if max_game_seconds is not None and (not math.isfinite(max_game_seconds) or max_game_seconds <= 0):
        raise ValueError("Maximum game time must be positive")
    if not 1 <= my_pid <= 15:
        raise ValueError("Expected a participant player id")
    import sc2reader
    from s2clientprotocol import data_pb2, sc2api_pb2

    replay_path = Path(replay_path).resolve(strict=True)
    replay = sc2reader.load_replay(str(replay_path), load_level=1)
    metadata = json.loads(replay.archive.read_file("replay.gamemetadata.json"))
    base = str(metadata.get("BaseBuild", ""))
    version = str(metadata.get("DataVersion", "")).upper()
    if not re.fullmatch(r"Base\d+", base) or not re.fullmatch(r"[A-F0-9]{32}", version):
        raise ObservationExportError("Replay does not contain usable engine version metadata")
    map_description = replay.raw_data.get("replay.initData", {}).get("game_description", {})
    map_width = int(map_description.get("map_size_x", 0))
    map_height = int(map_description.get("map_size_y", 0))
    if not 1 <= map_width <= 512 or not 1 <= map_height <= 512:
        raise ObservationExportError("Replay does not contain usable native map dimensions for creep")
    install = Path(sc2_path or os.environ.get("SC2PATH") or r"C:/Program Files (x86)/StarCraft II").resolve()
    binary = "SC2_x64.exe" if os.name == "nt" else "SC2_x64"
    executable = install / "Versions" / base / binary
    report = progress or (lambda _: None)
    started = time.monotonic()
    if not executable.is_file():
        if not download_missing:
            raise ObservationExportError(f"Required SC2 executable is missing: {executable}")
        installed = sorted(install.glob(f"Versions/Base*/{binary}"),
                           key=lambda path: int(path.parent.name[4:]), reverse=True)
        if not installed:
            raise ObservationExportError(f"SC2 executable not found under {install}")
        report(f"Downloading replay engine {base} through Blizzard")
        with _Engine(install, installed[0], None, timeout_seconds) as engine:
            engine.request("replay_info", replay_path=str(replay_path), download_data=True)
        if not executable.is_file():
            raise ObservationExportError(f"Blizzard did not provide required replay engine {base}")

    participant_ids = [int(player["PlayerID"]) for player in metadata.get("Players", [])]
    if my_pid not in participant_ids or len(participant_ids) != 2:
        raise ObservationExportError("Engine playback requires a two-player replay and a valid perspective")
    perspectives = [my_pid, next(pid for pid in participant_ids if pid != my_pid)]
    pass_results = []
    participants = {}
    for pass_index, perspective in enumerate(perspectives):
        report(f"Loading replay with {base}, perspective {pass_index + 1}/2")
        with _Engine(install, executable, version, max(1, timeout_seconds - (time.monotonic() - started))) as engine:
            ping = engine.request("ping")
            if ping.base_build != int(base[4:]) or ping.data_version.upper() != version:
                raise ObservationExportError("Launched engine version does not match this replay")
            replay_info = engine.request("replay_info", replay_path=str(replay_path), download_data=download_missing)
            participants = {entry.player_info.player_id: entry.player_info.player_name for entry in replay_info.player_info}
            if set(participants) != set(perspectives):
                raise ObservationExportError("Engine participants differ from replay metadata")
            # Two participant passes are necessary. Everyone (0) has live unit
            # positions but silently omits raw spell effects. A participant has
            # authoritative own units/effects plus snapshots of opponents; keep
            # only the active participant's entities to avoid those snapshots.
            engine.request("start_replay", replay_path=str(replay_path), observed_player_id=perspective, disable_fog=True,
                           realtime=False, options=sc2api_pb2.InterfaceOptions(raw=True, score=True, show_cloaked=True,
                           show_burrowed_shadows=True, show_placeholders=False, raw_crop_to_playable_area=False,
                           feature_layer=sc2api_pb2.SpatialCameraSetup(width=24, resolution={"x": 16, "y": 16},
                               minimap_resolution={"x": map_width, "y": map_height}, allow_cheating_layers=True,
                               crop_to_playable_area=False)))
            game_info = engine.request("game_info")
            if (game_info.start_raw.map_size.x, game_info.start_raw.map_size.y) != (map_width, map_height):
                raise ObservationExportError("Engine map size differs from replay metadata; creep projection would be wrong")
            data = engine.request("data", unit_type_id=True, effect_id=True)
            unit_data = {unit.unit_id: {"name": unit.name, "structure": data_pb2.Structure in unit.attributes} for unit in data.units}
            effects = {effect.effect_id: effect.name for effect in data.effects}
            accumulator = ObservationAccumulator(my_pid, unit_data, effects, step_loops / LOOPS_PER_SECOND)
            next_creep = 0
            next_report = 0
            complete = False
            while True:
                if time.monotonic() - started > timeout_seconds:
                    raise ObservationExportError("Engine replay export exceeded its wall-clock timeout")
                response = engine.request("observation", disable_fog=True)
                observation = response.observation
                loop = observation.game_loop
                if loop >= (1 << 31):
                    raise ObservationExportError("SC2 returned an invalid terminal observation")
                # Even the participant feature minimap is visibility-filtered.
                # Global creep comes from the dedicated Everyone pass below.
                capture_creep = False
                frame = _frame_from_proto(observation)
                frame["departed_tags"] = [unit["tag"] for unit in frame["units"] if unit["owner"] != perspective
                                          and unit["tag"] in accumulator.units]
                frame["units"] = [unit for unit in frame["units"] if unit["owner"] == perspective]
                frame["effects"] = [effect for effect in frame["effects"] if effect["owner"] in (perspective, 0, 16)]
                accumulator.observe(frame, capture_creep=capture_creep)
                if capture_creep:
                    next_creep = loop + creep_step_loops
                if loop >= next_report:
                    report(f"Perspective {pass_index + 1}/2: {loop / LOOPS_PER_SECOND:.0f}s / {replay_info.game_duration_seconds:.0f}s")
                    next_report = loop + int(LOOPS_PER_SECOND * 60)
                if response.player_result or loop >= replay_info.game_duration_loops:
                    complete = True
                    break
                if max_game_seconds is not None and loop / LOOPS_PER_SECOND >= max_game_seconds:
                    break
                engine.request("step", count=min(step_loops, replay_info.game_duration_loops - loop))
            pass_results.append(accumulator.result(complete))
            bounds = game_info.start_raw.playable_area
            map_details = {"map_name": game_info.map_name, "game_length": replay_info.game_duration_seconds,
                           "bounds": {"x_min": bounds.p0.x, "y_min": bounds.p0.y,
                                      "x_max": bounds.p1.x, "y_max": bounds.p1.y}}
    report("Capturing global creep")
    creep_result = _capture_global_creep(install, executable, version, replay_path, map_width, map_height,
        creep_step_loops, max(1, timeout_seconds - (time.monotonic() - started)), max_game_seconds, report)
    result = {**pass_results[0], **map_details, "creep": creep_result["creep"]}
    for key in ("my_units", "opp_units", "my_buildings", "opp_buildings"):
        result[key] = pass_results[0][key] + pass_results[1][key]
    result["effects"] = merge_observed_effects(pass_results)
    result["fidelity"]["complete"] = all(part["fidelity"]["complete"] for part in [*pass_results, creep_result])
    result["fidelity"]["creep"] = "observed"
    result["fidelity"]["effects"] = "observed"
    result["fidelity"]["attacks"] = "observed" if all(
        part["fidelity"]["attacks"] == "observed" for part in pass_results) else "unavailable"
    return {"artifactVersion": ARTIFACT_VERSION, "replaySha256": replay_digest(replay_path),
            "myPid": my_pid, "myName": participants[my_pid], "participants": participants,
            "baseBuild": int(base[4:]), "dataVersion": version, "playback": result}


def write_observation_artifact(artifact: dict, output: str | Path) -> Path:
    """Atomically replace the artifact only after a complete JSON serialization."""
    output = Path(output).resolve()
    encoded = json.dumps(artifact, separators=(",", ":"), allow_nan=False).encode("utf-8")
    if len(encoded) > MAX_ARTIFACT_BYTES:
        raise ObservationExportError("Observation artifact exceeds the 128 MiB local budget")
    output.parent.mkdir(parents=True, exist_ok=True)
    temporary = None
    try:
        with tempfile.NamedTemporaryFile(prefix=output.name + ".", suffix=".tmp", dir=output.parent, delete=False) as staged:
            temporary = Path(staged.name)
            staged.write(encoded)
        temporary.replace(output)
    finally:
        if temporary is not None:
            temporary.unlink(missing_ok=True)
    return output


def merge_precomputed_engine_playback(playback: dict, replay_path: str | Path, player_name: str) -> dict:
    """Use a complete matching local export; otherwise preserve tracker fallback.

    No game process or downloads start during ordinary parsing. Files are keyed
    to the replay bytes and the requested participant to prevent stale data or
    reversed ownership from entering the web payload.
    """
    path = Path(replay_path)
    candidates = [path.with_name(path.name + ".observations.json")]
    artifact_dir = os.environ.get("SC2TOOLS_OBSERVATION_DIR")
    digest = None
    if artifact_dir:
        digest = replay_digest(path)
        candidates.insert(0, Path(artifact_dir) / (digest + ".json"))
    for candidate in candidates:
        try:
            if not candidate.is_file() or candidate.stat().st_size > MAX_ARTIFACT_BYTES:
                continue
            artifact = json.loads(candidate.read_text(encoding="utf-8"))
            observed = artifact.get("playback", {})
            if artifact.get("artifactVersion") != ARTIFACT_VERSION:
                continue
            if artifact.get("replaySha256") != (digest or replay_digest(path)):
                continue
            if isinstance(playback.get("me_pid"), int):
                if artifact.get("myPid") != playback["me_pid"]:
                    continue
            else:
                import html
                import re
                def player_identity(value):
                    name = html.unescape(str(value)).replace("<sp/>", " ").strip()
                    return re.sub(r"^(?:<[^>]+>|\[[^\]]+\])\s*", "", name).casefold()
                participant = player_identity(artifact.get("myName", ""))
                expected = player_identity(playback.get("me_name") or player_name)
                if not expected or expected != participant:
                    continue
            fidelity = observed.get("fidelity", {})
            if fidelity.get("positions") != "engine" or fidelity.get("complete") is not True:
                continue
            keys = ("my_units", "opp_units", "my_buildings", "opp_buildings")
            if not all(isinstance(observed.get(key), list) for key in keys):
                continue
            replacement = {key: observed[key] for key in (*keys, "bounds", "game_length", "fidelity", "creep", "effects") if key in observed}
            from .event_extractor import _canonical_unit_name
            def display_name(name):
                # Cocoon aliases must not show the finished morph early.
                return name if isinstance(name, str) and name.endswith("Cocoon") else _canonical_unit_name(name)
            tracker = {key: {int(unit["id"]): unit for unit in playback.get(key, [])
                            if isinstance(unit, dict) and isinstance(unit.get("id"), int)} for key in keys}
            engine_ids = {}
            for key in keys:
                records = []
                for unit in observed[key]:
                    rec = dict(unit)
                    raw_tag = str(rec.get("id", ""))
                    if not raw_tag.isdecimal():
                        continue
                    tracker_id = int(raw_tag) & 0xffffffff
                    engine_ids[tracker_id] = raw_tag
                    rec["name"] = display_name(rec.get("name"))
                    rec["forms"] = [{**form, "name": display_name(form.get("name"))}
                                    for form in rec.get("forms", [])]
                    if not rec["forms"]:
                        rec.pop("forms", None)
                    tracked = tracker[key].get(tracker_id)
                    if (tracked is not None and tracked.get("died") is not None
                            and (rec.get("died") is None or tracked["died"] <= rec["died"] + 0.5)
                            and "killer_pid" not in rec):
                        if "killer_pid" in tracked:
                            rec["killer_pid"] = tracked["killer_pid"]
                        # Precise tracker deaths avoid the observer's next
                        # sample delay and identify consumed drones/merges.
                        rec["died"] = tracked["died"]
                    records.append(rec)
                replacement[key] = records
            casts = []
            for cast in playback.get("ability_casts", []):
                cast = dict(cast)
                for key in ("casterUnitId", "targetUnitId"):
                    if cast.get(key) in engine_ids:
                        cast[key] = engine_ids[cast[key]]
                if isinstance(cast.get("casterUnitIds"), list):
                    cast["casterUnitIds"] = [engine_ids.get(uid, uid) for uid in cast["casterUnitIds"]]
                casts.append(cast)
            replacement["ability_casts"] = casts
            return {**playback, **replacement}
        except (OSError, ValueError, TypeError, AttributeError):
            continue
    return playback


def main() -> None:
    parser = argparse.ArgumentParser(description="Export observed unit movement, spells and creep using the local SC2 engine")
    parser.add_argument("replay", type=Path)
    parser.add_argument("--player-id", type=int, required=True)
    parser.add_argument("--output", type=Path)
    parser.add_argument("--sc2-path", type=Path)
    parser.add_argument("--step-loops", type=int, default=4)
    parser.add_argument("--timeout", type=float, default=900)
    parser.add_argument("--max-game-seconds", type=float)
    parser.add_argument("--no-download", action="store_true")
    args = parser.parse_args()
    try:
        artifact = export_engine_observations(args.replay, args.player_id, sc2_path=args.sc2_path,
            step_loops=args.step_loops, timeout_seconds=args.timeout, max_game_seconds=args.max_game_seconds,
            download_missing=not args.no_download, progress=lambda value: print(value, flush=True))
        output = args.output or args.replay.with_name(args.replay.name + ".observations.json")
        write_observation_artifact(artifact, output)
        print(f"Wrote {output} (complete={artifact['playback']['fidelity']['complete']})")
    except (ObservationExportError, OSError, ImportError, ValueError) as exc:
        parser.exit(1, f"Engine export failed: {exc}\n")


if __name__ == "__main__":
    main()
