"""Visible, bounded native preview of one immutable neural checkpoint.

Only current permitted observations reach the isolated model worker. Native
simulation is stepped, so inference waits cannot invalidate frame bindings.
There is no coach, economy fallback, optimizer, or training-data admission.
"""
from __future__ import annotations

import asyncio
from collections import Counter
import hashlib
import json
import math
from pathlib import Path
import time
import uuid

from filelock import FileLock
from google.protobuf.json_format import MessageToDict
import psutil
from sc2.data import Difficulty, Race
from sc2.main import run_game
from sc2.player import Bot, Computer
from s2clientprotocol import sc2api_pb2 as api

from .fairplay import FairPlayController
from .intent_runtime import IntentRuntime
from .policy_intents import canonical_sha256, prediction_integrity_valid
from .policy_observation import LivePolicyObservation
from .runner import resolve_map, spatial_client, validate_action_audit, write_json
from .sc2_adapter import NeuralBot, screen_entities

ROOT = Path(__file__).resolve().parents[2]
PROFILE = "immutable-alphastar-native-preview-v1"
DEFAULT_AGENT_STATE = Path("C:/Users/jay19/AppData/Local/sc2tools/agent.json")


def digest(path):
    hasher = hashlib.sha256()
    with Path(path).open("rb") as stream:
        for block in iter(lambda: stream.read(1024 * 1024), b""):
            hasher.update(block)
    return hasher.hexdigest()


def check_stops(paths):
    for path in paths:
        if Path(path).exists():
            raise RuntimeError(f"STOP marker respected: {path}")


def stop_paths(output, checkpoint_run):
    return [ROOT / "STOP", Path(output) / "STOP", Path(checkpoint_run) / "STOP",
            ROOT / "runs/response-league/STOP", ROOT / "runs/response-league-monitor/STOP"]


def check_no_engine():
    for process in psutil.process_iter(["name"]):
        if (process.info.get("name") or "").lower() in {"sc2_x64.exe", "sc2_x64"}:
            raise RuntimeError("An SC2 client is active; native preview did not launch")


def require_capture_paused(state_path):
    """Inspect only the local pause bit; never log or return device credentials."""
    try:
        path = Path(state_path)
        if not 0 < path.stat().st_size <= 32 * 1024 * 1024:
            raise ValueError("Invalid state size")
        data = json.loads(path.read_text(encoding="utf-8"))
        paused = isinstance(data, dict) and data.get("paused") is True
    except (OSError, ValueError, TypeError):
        raise RuntimeError("SC2TOOLS capture pause could not be verified") from None
    if not paused:
        raise RuntimeError("SC2TOOLS must remain paused during this native preview")


def public_catalog(data):
    def proto(value):
        return MessageToDict(value, preserving_proto_field_name=True, use_integers_for_enums=True)
    return {"units": {str(unit.unit_id): proto(unit) for unit in data.units},
            "abilities": {str(ability.ability_id): {
                "id": int(ability.ability_id),
                "name": ability.link_name or ability.friendly_name or ability.button_name,
                "target": int(ability.target), "available": bool(ability.available),
                "allow_minimap": bool(ability.allow_minimap),
                "remaps_to_ability_id": int(ability.remaps_to_ability_id),
                "native": proto(ability)} for ability in data.abilities},
            "upgrades": {str(upgrade.upgrade_id): proto(upgrade) for upgrade in data.upgrades},
            "buffs": [proto(buff) for buff in data.buffs], "effects": [proto(effect) for effect in data.effects]}


def require_catalog(actual, expected):
    if canonical_sha256(actual) != canonical_sha256(expected):
        raise ValueError("Native public catalog differs from the checkpoint's verified patch vocabulary")


def observation_unit_names(data):
    """Ignore native unused catalog slots, without fabricating observed names.

    RequestData contains ID0 and unnamed reserved IDs. Keep the complete catalog
    for checkpoint compatibility; only named positive IDs enter the observation
    adapter. An actually observed reserved ID still fails its UNKNOWN check.
    """
    return {int(unit.unit_id): unit.name for unit in data.units if unit.unit_id > 0 and unit.name}


def prepare(output, checkpoint_run, catalog_path, map_name, *, seconds=900, speed=1.0,
            wall_seconds=1800, timeout_seconds=180, opponent_race="Terran", difficulty="Hard",
            agent_state=DEFAULT_AGENT_STATE):
    """Prepare files only; neither this function nor its CLI starts a worker."""
    from .alphastar_spool import create_session
    output, checkpoint_run, catalog_path = map(lambda value: Path(value).resolve(),
                                               (output, checkpoint_run, catalog_path))
    check_stops(stop_paths(output, checkpoint_run))
    if output.exists():
        raise ValueError("Prepare requires a new session directory")
    for name, value, lower, upper in (("seconds", seconds, 30, 1200), ("speed", speed, .25, 2),
                                     ("wall_seconds", wall_seconds, 60, 3600),
                                     ("timeout_seconds", timeout_seconds, 10, 300)):
        if isinstance(value, bool) or not isinstance(value, (int, float)) or not math.isfinite(value) or not lower <= value <= upper:
            raise ValueError(f"Invalid bounded {name}")
    if opponent_race not in {"Terran", "Protoss", "Zerg"} or difficulty not in {"Easy", "Medium", "Hard"}:
        raise ValueError("Choose a supported non-cheating opponent")
    paths = [checkpoint_run / name for name in ("result.json", "checkpoint.msgpack", "registry.json", "reproduction-recipe.json")]
    paths.append(catalog_path)
    paths.extend(Path(__file__).parent / name for name in
                 ("alphastar_live.py", "alphastar_spool.py", "policy_observation.py", "intent_runtime.py",
                  "fairplay.py", "policy_intents.py", "rich_replays.py"))
    hashes = {str(path): digest(path) for path in paths}
    result = json.loads(paths[0].read_text(encoding="utf-8"))
    recipe = json.loads(paths[3].read_text(encoding="utf-8"))
    if (result.get("status") != "passed" or result.get("checkpoint_restore_verified") is not True
            or result.get("learned_from_actual_replay") is not True
            or result.get("checkpoint_sha256") != hashes[str(paths[1])]
            or recipe.get("checkpoint_sha256") != hashes[str(paths[1])]
            or recipe.get("result_sha256") != hashes[str(paths[0])]
            or result.get("dataset_hashes", {}).get("game_data") != hashes[str(catalog_path)]
            or result.get("tensor_config", {}).get("max_entities") != 512
            or result.get("tensor_config", {}).get("max_selected") != 64
            or result.get("capacity_adapter") != "empty-affine-preserving-entity-pool128-v1"
            or result.get("matmul_precision") != "highest"):
        raise ValueError("Require the complete immutable expanded neural checkpoint and exact public catalog")
    game_map = resolve_map(str(map_name))
    hashes[str(Path(game_map.path).resolve())] = digest(game_map.path)
    catalog = json.loads(catalog_path.read_text(encoding="utf-8"))
    output.mkdir(parents=True, exist_ok=False)
    session_id = uuid.uuid4().hex
    create_session(output, session_id, result["checkpoint_sha256"], catalog, player_id=1)
    config = {"schema": PROFILE, "session_id": session_id, "status": "prepared",
              "checkpoint_run": str(checkpoint_run), "checkpoint_sha256": result["checkpoint_sha256"],
              "checkpoint_updates": result["optimizer_updates"], "catalog_path": str(catalog_path),
              "map": str(Path(game_map.path).resolve()), "max_game_seconds": float(seconds),
              "max_wall_seconds": float(wall_seconds), "timeout_seconds": float(timeout_seconds),
              "speed": float(speed), "opponent_race": opponent_race, "difficulty": difficulty,
              "agent_state_path": str(Path(agent_state).resolve()),
              "input_hashes": hashes, "created_unix": time.time(), "seed": 260926,
              "scope": "Neural checkpoint preview; no RL updates, scripted fallback, or rating evidence"}
    write_json(output / "preview.json", config)
    return config


def validate_response(response, frame, *, session_id, checkpoint_sha256):
    binding = response.get("binding", {})
    if (response.get("checkpoint_sha256") != checkpoint_sha256
            or binding.get("session_id") != session_id
            or binding.get("player_id") != frame.get("hud", {}).get("player_id")
            or binding.get("game_loop") != frame.get("game_loop")
            or binding.get("frame_sha256") != canonical_sha256(frame)):
        raise ValueError("Model response is not bound to this exact live checkpoint/session/player/frame")
    intent = response.get("intent")
    if not isinstance(intent, dict) or type(intent.get("admitted")) is not bool:
        raise ValueError("Worker response has no explicit intent admission result")
    if intent["admitted"] and (intent.get("provenance") != "policy_prediction"
            or not prediction_integrity_valid(intent)
            or intent.get("evidence", {}).get("observation_binding") != binding):
        raise ValueError("Admitted intent lacks immutable model prediction provenance")
    return intent


def require_ready_worker(output, session, *, now=None):
    from .alphastar_spool import read_json, spool_path, validate_worker
    worker = validate_worker(read_json(spool_path(output, "worker.json")), session)
    status = read_json(spool_path(output, "worker-status.json"))
    stamp = status.get("updated_unix")
    current = time.time() if now is None else now
    if (status.get("worker_id") != worker["worker_id"]
            or status.get("session_id") != session["session_id"]
            or status.get("checkpoint_sha256") != session["checkpoint_sha256"]
            or status.get("status") != "ready"
            or status.get("warmup_complete") is not True
            or isinstance(stamp, bool) or not isinstance(stamp, (int, float))
            or not math.isfinite(stamp) or not -2 <= current - stamp <= 10):
        raise ValueError("Model worker must finish observation-only warmup before native SC2 launch")
    return worker


class PredictionDriver:
    """Own a single causal intent through all its paid selection/command stages."""

    def __init__(self, client, *, session_id, checkpoint_sha256, emit, runtime_factory=IntentRuntime):
        self.client, self.session_id, self.checkpoint_sha256 = client, session_id, checkpoint_sha256
        self.emit, self.runtime_factory = emit, runtime_factory
        self.runtime = self.intent = None
        self.inference_wait_seconds = 0.0
        self.predictions = self.executed_intents = self.rejected_intents = 0

    async def step(self, bot, frame):
        if self.runtime is None or self.runtime.terminal is not None:
            if bot.fairplay.pending:
                raise RuntimeError("Pending paid input lost its neural intent owner")
            if not bot.fairplay.can_issue(float(bot.time)):
                return
            before = time.monotonic()
            try:
                response = await self.client.infer(frame)
            finally:
                self.inference_wait_seconds += time.monotonic() - before
            if int(bot.state.game_loop) != frame["game_loop"]:
                raise ValueError("Native simulation advanced during model inference")
            intent = validate_response(response, frame, session_id=self.session_id,
                                       checkpoint_sha256=self.checkpoint_sha256)
            self.predictions += 1
            self.emit("prediction", game_loop=frame["game_loop"], record=response.get("record"),
                      admitted=intent["admitted"], reasons=intent.get("reasons", []),
                      request_sequence=response.get("sequence"), intent_id=intent.get("intent_id"))
            if not intent["admitted"]:
                self.rejected_intents += 1
                self.runtime = self.intent = None
                return
            self.intent = intent
            self.runtime = self.runtime_factory(session_id=self.session_id, max_game_seconds=20, max_camera_inputs=12)
        receipt = await self.runtime.step(bot, self.intent, frame)
        self.emit("runtime", **receipt)
        if self.runtime.terminal == "accepted":
            self.executed_intents += 1
        elif self.runtime.terminal is not None:
            self.rejected_intents += 1


class AlphaStarLiveBot(NeuralBot):
    """Uses NeuralBot's eight-worker check and surrender lifecycle only."""

    def __init__(self, output, config, client, *, clock=time.monotonic):
        super().__init__(None, record=False, max_game_seconds=config["max_game_seconds"], step_mul=8,
                         expected_start_workers=8, fairplay=FairPlayController(max_apm=200))
        self.output, self.config, self.clock = Path(output), config, clock
        self.wall_start = self.clock()
        self.builder = None
        self.observed_progress = {}
        self.completed_structures = Counter()
        self.driver = PredictionDriver(client, session_id=config["session_id"],
            checkpoint_sha256=config["checkpoint_sha256"], emit=self.emit)
        self.last_loop = -1
        self.native_start_workers = None
        self.preview_failure = None
        self.last_report_seconds = -10.0
        self.replay_validation = {"verified": False, "reason": "Game has not ended"}

    def emit(self, event, **data):
        with (self.output / "events.jsonl").open("a", encoding="utf-8") as stream:
            stream.write(json.dumps({"event": event, "wall_unix": time.time(), **data}, allow_nan=False) + "\n")

    def stop_check(self):
        check_stops(stop_paths(self.output, self.config["checkpoint_run"]))
        require_capture_paused(self.config["agent_state_path"])
        if self.clock() - self.wall_start >= self.config["max_wall_seconds"]:
            raise TimeoutError("Native preview wall-time deadline reached")

    async def _start(self):
        self.stop_check()
        await super()._start()  # Verifies an actual eight-worker Protoss start; never edits units.
        if self.player_id != 1:
            raise ValueError("Prepared live inference session requires native participant1")
        self.native_start_workers = len(self.workers)
        data = (await self.client._execute(data=api.RequestData(
            ability_id=True, unit_type_id=True, upgrade_id=True, buff_id=True, effect_id=True))).data
        catalog = public_catalog(data)
        expected = json.loads(Path(self.config["catalog_path"]).read_text(encoding="utf-8"))
        require_catalog(catalog, expected)
        size = self.game_info.map_size
        self.builder = LivePolicyObservation(session_id=self.config["session_id"], player_id=1,
            map_size=[int(size.x), int(size.y)], unit_names=observation_unit_names(data))
        self.emit("native_start_verified", workers=self.native_start_workers, player_id=1,
                  map_size=[int(size.x), int(size.y)], public_catalog_sha256=canonical_sha256(catalog),
                  checkpoint_updates=self.config["checkpoint_updates"], max_apm=200, fog=True,
                  camera_restricted=True, fallback_controller=False, realtime=False)

    async def _step(self, iteration):
        if self._episode_finished or self.forfeit_reason is not None:
            return
        try:
            self.stop_check()
            self.fairplay.sync_camera(self)
            loop = int(self.state.game_loop)
            if loop <= self.last_loop:
                raise ValueError("Duplicate or reversed native observation")
            self.last_loop = loop
            frame = self.builder.observe(self.state.observation)
            own, _ = screen_entities(self)
            evidence = self._economic_guard.observe(self, own)
            if evidence:
                self.emit("economic_resignation", evidence=evidence)
                await self._forfeit(evidence)
                return
            if self.time >= self.max_game_seconds:
                self._time_limited = True
                return  # Native runner ends the bounded game; no artificial Victory.
            elapsed = self.clock() - self.wall_start - self.driver.inference_wait_seconds
            delay = float(self.time) / self.config["speed"] - elapsed
            if delay > 0:
                await asyncio.sleep(min(delay, 1.0))
            self.stop_check()
            for entity in frame["entities"]:
                if entity["owner"] != 1:
                    continue
                tag, progress = entity["tag"], entity["build_progress"]
                previous = self.observed_progress.get(tag)
                if previous is not None and previous < 1 <= progress:
                    self.completed_structures[entity["type_name"]] += 1
                    self.emit("observed_build_completion", game_loop=loop, unit_type=entity["type_name"],
                              tag=tag, scope="Own visible incomplete-to-complete transition")
                self.observed_progress[tag] = progress
            await self.driver.step(self, frame)
            if float(self.time) - self.last_report_seconds >= 5:
                self.last_report_seconds = float(self.time)
                report = {"session_id": self.config["session_id"], "updated_unix": time.time(),
                          "game_loop": loop, "game_seconds": float(self.time), "hud": frame["hud"],
                          "camera": frame["camera"], "model_predictions": self.driver.predictions,
                          "accepted_intents": self.driver.executed_intents,
                          "rejected_intents": self.driver.rejected_intents,
                          "native_start_workers": self.native_start_workers,
                          "checkpoint_updates": self.config["checkpoint_updates"],
                          "observed_build_completions": dict(self.completed_structures),
                          "fairplay": self.fairplay.summary(), "training_updated": False}
                self.emit("progress", **report)
                write_json(self.output / "live-status.json", report)
        except Exception as error:
            self.preview_failure = f"{type(error).__name__}: {error}"
            self.emit("preview_failed_closed", error=self.preview_failure)
            await self._forfeit({"reason": "neural_preview_error", "detail": self.preview_failure})

    async def on_end(self, game_result):
        await super().on_end(game_result)
        try:
            replay = self.output / "game.SC2Replay"
            await self.client.save_replay(str(replay))
            response = (await self.client._execute(replay_info=api.RequestReplayInfo(
                replay_data=replay.read_bytes(), download_data=False))).replay_info
            if response.HasField("error"):
                raise ValueError(f"Native replay parser rejected saved game: {response.error_details or response.error}")
            self.replay_validation = {"verified": True, "base_build": int(response.base_build),
                                      "players": len(response.player_info), "map_name": response.map_name,
                                      "replay_sha256": digest(replay)}
        except Exception as error:
            self.replay_validation = {"verified": False, "error": f"{type(error).__name__}: {error}"}
        self.emit("saved_replay_native_check", **self.replay_validation)


def run(output):
    """One visible native game. The separately started worker owns inference."""
    from .alphastar_spool import FileSpoolClient
    output = Path(output).resolve()
    config = json.loads((output / "preview.json").read_text(encoding="utf-8"))
    if config.get("schema") != PROFILE or config.get("status") != "prepared":
        raise ValueError("Require a fresh prepared preview; prior games cannot be restarted")
    check_stops(stop_paths(output, config["checkpoint_run"]))
    if (output / "launch.json").exists():
        raise ValueError("This native game was already reserved; use a new prepared session")
    if any(digest(path) != checksum for path, checksum in config["input_hashes"].items()):
        raise ValueError("An immutable native preview input changed")
    client = FileSpoolClient(output, config["session_id"], config["checkpoint_sha256"],
                             timeout_seconds=config["timeout_seconds"])
    require_ready_worker(output, client.session)
    require_capture_paused(config["agent_state_path"])
    with FileLock(str(ROOT / "runs/.alphastar-native-preview.lock"), timeout=0):
        check_stops(stop_paths(output, config["checkpoint_run"]))
        require_capture_paused(config["agent_state_path"])
        check_no_engine()
        process = psutil.Process()
        with (output / "launch.json").open("x", encoding="utf-8") as stream:
            json.dump({"pid": process.pid, "process_created_at": process.create_time(),
                       "session_id": config["session_id"], "created_unix": time.time()}, stream)
        bot = AlphaStarLiveBot(output, config, client)
        client.stop_check = bot.stop_check
        status = {**config, "status": "running", "pid": process.pid, "process_created_at": process.create_time(),
                  "started_unix": time.time(), "training_updated": False, "game_inputs": "neural predictions only",
                  "rating_evidence": False, "live_model_ready": False, "observed_result": None}
        write_json(output / "status.json", status)
        failure = None
        try:
            with spatial_client():
                outcome = run_game(resolve_map(config["map"]), [
                    Bot(Race.Protoss, bot, name="Neural preview", fullscreen=False),
                    Computer(Race[config["opponent_race"]], Difficulty[config["difficulty"]]),
                ], realtime=False, disable_fog=False, random_seed=config["seed"],
                    game_time_limit=config["max_game_seconds"], save_replay_as=str(output / "game.SC2Replay"))
            status["observed_result"] = getattr(outcome, "name", None)
            if bot.error or bot.preview_failure or not bot._episode_finished:
                raise RuntimeError(bot.error or bot.preview_failure or "Native episode did not finish")
            if status["observed_result"] not in {"Victory", "Defeat", "Tie"}:
                raise RuntimeError("SC2 did not return a valid result")
            status["status"] = "complete"
        except BaseException as error:
            failure = error
            status.update(status="failed", error=f"{type(error).__name__}: {error}")
        finally:
            audit = {"summary": bot.fairplay.summary(), "actions": bot.fairplay.audit}
            write_json(output / "audit.json", audit)
            try:
                status["input_validation"] = validate_action_audit(audit)
            except Exception as error:
                status["input_validation"] = {"valid": False, "error": f"{type(error).__name__}: {error}"}
                if failure is None:
                    failure = error
                    status.update(status="failed", error="Native input audit did not validate")
            unchanged = all(digest(path) == checksum for path, checksum in config["input_hashes"].items())
            if not unchanged:
                status.update(status="failed", error="Immutable preview input changed")
                failure = failure or RuntimeError(status["error"])
            replay = output / "game.SC2Replay"
            status.update(finished_unix=time.time(), start_workers=bot.native_start_workers,
                          game_seconds=float(bot.time), model_predictions=bot.driver.predictions,
                          accepted_intents=bot.driver.executed_intents, rejected_intents=bot.driver.rejected_intents,
                          inference_wait_seconds=bot.driver.inference_wait_seconds,
                          observed_build_completions=dict(bot.completed_structures), forfeit=bot.forfeit_reason,
                          checkpoint_and_inputs_unchanged=unchanged,
                          replay_saved=replay.is_file() and replay.stat().st_size > 0,
                          native_replay_validation=bot.replay_validation,
                          replay_sha256=digest(replay) if replay.is_file() else None)
            status["native_replay_validation"]["final_file_matches_checked"] = (
                status["native_replay_validation"].get("verified") is True
                and status["native_replay_validation"].get("replay_sha256") == status["replay_sha256"])
            if status["status"] == "complete" and not status["replay_saved"]:
                status.update(status="failed", error="Completed native game has no saved replay")
                failure = failure or RuntimeError(status["error"])
            write_json(output / "status.json", status)
            write_json(output / "host-finished.json", {"session_id": config["session_id"],
                "checkpoint_sha256": config["checkpoint_sha256"], "status": status["status"],
                "finished_unix": time.time()})
        if failure is not None:
            raise failure
        return status
