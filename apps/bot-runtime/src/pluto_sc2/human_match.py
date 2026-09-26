"""A local human against an immutable learned policy, in two owned SC2 clients.

The human controls the ordinary visible SC2 window. Only the other participant
receives policy actions; it uses the same race-scoped fair-play clients as the
league. No learner, optimizer, training checkpoint, or training socket is used.
"""
from __future__ import annotations

import argparse
import asyncio
from contextlib import AsyncExitStack, suppress
from datetime import datetime, timezone
import hashlib
import json
import math
import os
from pathlib import Path
import time

import psutil
from s2clientprotocol import sc2api_pb2 as api
from sc2.client import Client
from sc2.data import Race, Result

from pluto_sc2.runner import ManagedSC2Process, resolve_map, seed_everything, write_json

RACES = ("Protoss", "Terran", "Zerg")
WORKER_IDS = {"Protoss": 84, "Terran": 45, "Zerg": 104}


class LocalHumanClient(Client):
    """Observe the human's game without issuing inputs or changing selection."""

    async def _execute(self, **kwargs):
        if any(key in kwargs for key in (
                "action", "debug", "map_command", "quick_load", "start_replay", "step")):
            raise RuntimeError("The human client cannot receive automated gameplay inputs")
        for key in ("create_game", "observation"):
            if key in kwargs and kwargs[key].disable_fog:
                raise RuntimeError("The human match cannot disable fog of war")
        join = kwargs.get("join_game")
        if join is not None:
            if join.HasField("observed_player_id") or join.race not in [Race[r].value for r in RACES]:
                raise ValueError("The human must join as an explicit playing race")
            # Raw data is used solely to verify starting workers. It neither
            # issues raw commands nor modifies the human's selected units.
            join.options.raw = True
            join.options.score = False
            join.options.raw_affects_selection = False
            join.options.show_cloaked = False
            join.options.show_burrowed_shadows = False
            join.options.show_placeholders = False
            join.options.ClearField("feature_layer")
            join.options.ClearField("render")
        response = await super()._execute(**kwargs)
        if join is not None and response.join_game.HasField("error"):
            raise RuntimeError(f"Human could not join: {response.join_game.error_details}")
        return response


def _created_at(pid):
    try:
        return psutil.Process(pid).create_time()
    except (psutil.NoSuchProcess, psutil.AccessDenied):
        return None


def _sha256(path):
    with Path(path).open("rb") as stream:
        return hashlib.file_digest(stream, "sha256").hexdigest()


def read_controls(path: Path) -> bool:
    if not path.is_file():
        return False
    value = json.loads(path.read_text(encoding="utf-8"))
    if not isinstance(value, dict) or type(value.get("close", False)) is not bool:
        raise ValueError("Match close control must be true or false")
    return value.get("close", False)


def _load_bot(checkpoint, race, max_apm, max_game_seconds):
    import torch
    from pluto_sc2.league import _load
    from pluto_sc2.adversary import AdversaryBot
    from pluto_sc2.sc2_adapter import NeuralBot

    torch.set_num_threads(2)
    loaded = _load(checkpoint, race, device="cpu", max_apm=max_apm)
    policy = loaded["policy"]
    policy.eval()
    policy.requires_grad_(False)
    common = dict(record=False, deterministic=False, max_game_seconds=max_game_seconds,
                  reward_shaping=0, expected_start_workers=8)
    return (NeuralBot(policy, **common) if race == "Protoss" else
            AdversaryBot(policy, race, max_apm=max_apm, step_mul=2, **common))


def starting_workers(response, race):
    return sum(unit.unit_type == WORKER_IDS[race] and unit.alliance == 1
               for unit in response.observation.observation.raw_data.units)


async def _join_pair(human, opponent, human_race, bot_race, ports):
    # Both requests must be outstanding together: SC2 waits for its peer.
    responses = await asyncio.gather(
        human.join_game("Local human", Race[human_race], portconfig=ports),
        opponent.join_game(f"{bot_race} bot", Race[bot_race], portconfig=ports),
        return_exceptions=True)
    for response in responses:
        if isinstance(response, BaseException):
            raise response
        if response not in (1, 2):
            raise RuntimeError("SC2 did not assign a valid player id")
    if responses != [1, 2]:
        raise RuntimeError("SC2 did not preserve human player 1 / bot player 2")
    return responses


async def _drive_bot(bot, client, initial, publish, closed_reason, max_game_seconds):
    """The burnysc2 lifecycle with realtime observations and explicit shutdown.

    This deliberately never calls Client.step(): wall time drives the engine,
    and physical mouse/keyboard inputs control the separate human participant.
    """
    from sc2.game_state import GameState

    bot._initialize_variables()
    data = await client.get_game_data()
    info = await client.get_game_info()
    ping = await client.ping()
    bot._prepare_start(client, client._player_id, info, data,
                       realtime=True, base_build=ping.ping.base_build)
    game_state = GameState(initial.observation)
    proto_info = await client._execute(game_info=api.RequestGameInfo())
    bot._prepare_step(game_state, proto_info)
    await bot.on_before_start()
    bot._prepare_first_step()
    await bot.on_start()
    if bot.error:
        raise RuntimeError(bot.error)
    publish("playing", game_loop=int(game_state.game_loop), game_seconds=float(bot.time))
    last_publish = -math.inf
    iteration = 0
    while True:
        reason = closed_reason()
        if reason:
            return "closed", None, reason
        try:
            response = await client.observation(game_state.game_loop + client.game_step)
        except Exception:
            reason = closed_reason()
            if reason:
                return "closed", None, reason
            raise
        if client._game_result:
            result = client._game_result.get(client._player_id)
            if result not in (Result.Victory, Result.Defeat, Result.Tie):
                raise RuntimeError("SC2 ended without a valid bot result")
            await bot.on_end(result)
            return "finished", client._game_result, None
        # Every received observation is processed once. Passing an already
        # processed previous response would deliver chat/death events twice.
        game_state = GameState(response.observation)
        proto_info = await client._execute(game_info=api.RequestGameInfo())
        bot._prepare_step(game_state, proto_info)
        if float(bot.time) >= max_game_seconds:
            await bot.on_end(Result.Tie)
            return "finished", {1: Result.Tie, 2: Result.Tie}, "Game time limit reached"
        await bot.issue_events()
        await bot.on_step(iteration)
        await bot._after_step()
        if bot.error:
            raise RuntimeError(bot.error)
        if getattr(bot, "forfeit_reason", None) is not None and client._game_result:
            if client._game_result.get(client._player_id) != Result.Defeat:
                raise RuntimeError("Resigned bot did not receive its defeat result")
            await bot.on_end(Result.Defeat)
            return "finished", {client._player_id: Result.Defeat,
                                3 - client._player_id: Result.Victory}, "Bot resigned: no recoverable Probe economy"
        if float(bot.time) - last_publish >= 1:
            publish(game_loop=int(game_state.game_loop), game_seconds=float(bot.time))
            last_publish = float(bot.time)
        iteration += 1


async def play(checkpoint: Path, output: Path, *, human_race: str, bot_race: str,
               map_path: str, max_apm: int = 600, max_game_seconds: float = 3600,
               seed: int = 1, max_wall_seconds: float | None = None,
               process_factory=None, monotonic=time.monotonic) -> dict:
    """Run one isolated exhibition; write only inside its unique output folder."""
    from sc2.player import Human, Bot
    from sc2.portconfig import Portconfig
    from pluto_sc2.league_client import LeagueClient
    from pluto_sc2.adversary import validate_adversary_audit
    from pluto_sc2.runner import validate_action_audit

    checkpoint, output = Path(checkpoint).resolve(), Path(output).resolve()
    if checkpoint in {output / name for name in ("status.json", "control.json", "match.json",
                                                "game.SC2Replay", "audit.json")}:
        raise ValueError("Checkpoint path conflicts with a human match artifact")
    output.mkdir(parents=True, exist_ok=True)
    # Never overwrite a prior game or a source checkpoint with an artifact.
    if any((output / name).exists() for name in ("match.json", "game.SC2Replay", "audit.json")):
        raise ValueError("Human match output already contains game artifacts; choose a new folder")
    state = {"schema": 1, "session_id": output.name, "status": "starting", "pid": os.getpid(),
             "process_created_at": _created_at(os.getpid()), "human_race": human_race,
             "bot_race": bot_race, "human_player_id": 1, "bot_player_id": 2,
             "checkpoint": str(checkpoint), "map_path": str(map_path),
             "map": Path(map_path).stem, "map_name": Path(map_path).stem,
             "output": str(output), "game_loop": 0, "game_seconds": 0.0,
             "start_workers": None, "result": None, "results": None,
             "realtime": True, "training_updated": False, "replay": None, "error": None}
    started = monotonic()
    finalized, terminal_status = False, None

    def publish(status=None, **values):
        nonlocal terminal_status
        if status is not None:
            if status in ("finished", "closed", "failed") and not finalized:
                terminal_status, status = status, "finishing"
            state["status"] = status
        state.update(values, updated_at=datetime.now(timezone.utc).isoformat())
        write_json(output / "status.json", state)

    publish()
    processes, joined_clients, ports, bot = [], [], None, None
    try:
        if human_race not in RACES or bot_race not in RACES:
            raise ValueError("Choose Protoss, Terran, or Zerg for both players")
        for name, value in (("Game time", max_game_seconds), ("Wall time", max_wall_seconds)):
            if value is not None and (isinstance(value, bool) or not isinstance(value, (int, float))
                                      or not math.isfinite(value) or value <= 0):
                raise ValueError(f"{name} limit must be positive and finite")
        if type(max_apm) is not int or not 1 <= max_apm <= 10000:
            raise ValueError("Adversary APM must be an integer in 1..10000")
        if not checkpoint.is_file():
            raise ValueError("The frozen checkpoint is unavailable")
        seed_everything(seed)
        checkpoint_digest = _sha256(checkpoint)
        bot = _load_bot(checkpoint, bot_race, max_apm, max_game_seconds)
        if _sha256(checkpoint) != checkpoint_digest:
            raise ValueError("The selected checkpoint changed while it was loading")
        game_map = resolve_map(map_path)
        publish(checkpoint_sha256=checkpoint_digest, map_name=game_map.name, map=game_map.name,
                bot_max_apm=200 if bot_race == "Protoss" else max_apm,
                bot_camera_restricted=bot_race == "Protoss", seed=seed)

        def closed_reason():
            try:
                if read_controls(output / "control.json"):
                    return "Closed from the local match controls"
            except (ValueError, OSError, json.JSONDecodeError) as error:
                publish(control_error=str(error))
            if max_wall_seconds is not None and monotonic() - started >= max_wall_seconds:
                return "Verification wall-time limit reached"
            for role, process in processes:
                if process._process is None or process._process.poll() is not None:
                    return f"The {role} SC2 window closed"
            return None

        reason = closed_reason()
        if reason:
            publish("closed", close_reason=reason)
            return state
        factory = process_factory or ManagedSC2Process
        ports = Portconfig()
        async with AsyncExitStack() as stack:
            # Start the opponent first so the visible human window is last.
            opponent_process = factory(fullscreen=False, resolution=(640, 480))
            opponent_process.websocket_receive_timeout_seconds = 30.0
            opponent_controller = await stack.enter_async_context(opponent_process)
            processes.append(("bot", opponent_process))
            human_process = factory(fullscreen=False, resolution=(1280, 720), placement=(40, 40))
            human_process.websocket_receive_timeout_seconds = 30.0
            human_controller = await stack.enter_async_context(human_process)
            processes.append(("human", human_process))
            publish(bot_window_hidden=False, sc2_processes={role: {
                "pid": process._process.pid, "process_created_at": _created_at(process._process.pid)}
                for role, process in processes})
            human_ping = await human_controller.ping()
            bot_ping = await opponent_controller.ping()
            if ((human_ping.ping.base_build, human_ping.ping.data_version) !=
                    (bot_ping.ping.base_build, bot_ping.ping.data_version)):
                raise RuntimeError("Human and bot SC2 versions differ")
            reason = closed_reason()
            if reason:
                publish("closed", close_reason=reason)
                return state
            players = [Human(Race[human_race], name="Local human"),
                       Bot(Race[bot_race], bot, name=f"{bot_race} bot")]
            created = await human_controller.create_game(game_map, players, realtime=True,
                                                        random_seed=seed, disable_fog=False)
            if created.create_game.HasField("error"):
                raise RuntimeError(f"SC2 could not create the match: {created.create_game.error_details}")
            human = LocalHumanClient(human_controller._ws)
            opponent = LeagueClient(opponent_controller._ws)
            await _join_pair(human, opponent, human_race, bot_race, ports)
            joined_clients = [human, opponent]
            try:
                human_initial, bot_initial = await asyncio.gather(human.observation(), opponent.observation())
                workers = {"human": starting_workers(human_initial, human_race),
                           "bot": starting_workers(bot_initial, bot_race)}
                publish(start_workers=workers, base_build=human_ping.ping.base_build,
                        data_version=human_ping.ping.data_version)
                if set(workers.values()) != {8}:
                    raise ValueError(f"Exactly eight starting workers required for both players: {workers}")
                status, results, reason = await _drive_bot(
                    bot, opponent, bot_initial, publish, closed_reason, max_game_seconds)
                if results:
                    names = [results.get(player_id, Result.Undecided).name for player_id in (1, 2)]
                    if any(name not in ("Victory", "Defeat", "Tie") for name in names):
                        raise RuntimeError("SC2 ended without both player results")
                    publish(status, results=names, result=names[0], close_reason=reason,
                            game_seconds=float(bot.time), game_loop=int(bot.state.game_loop),
                            time_limit_reached=reason == "Game time limit reached")
                    publish(bot_forfeit=getattr(bot, "forfeit_reason", None))
                else:
                    publish(status, close_reason=reason, game_seconds=float(bot.time),
                            game_loop=int(bot.state.game_loop))
            finally:
                # No API calls race with the bot: its single realtime loop has
                # returned before saving/leaving. Try the surviving participant
                # if the other SC2 window was closed manually.
                errors = []
                for client, process in ((human, human_process), (opponent, opponent_process)):
                    if process._process is None or process._process.poll() is not None:
                        continue
                    try:
                        await client.save_replay(str(output / "game.SC2Replay"))
                        if not (output / "game.SC2Replay").stat().st_size:
                            raise ValueError("SC2 returned an empty replay")
                        publish(replay=str(output / "game.SC2Replay"))
                        break
                    except Exception as error:
                        errors.append(f"{type(error).__name__}: {error}")
                if state["replay"] is None:
                    publish(replay_error="; ".join(errors) or "Both SC2 windows closed")
                for client in joined_clients:
                    with suppress(Exception):
                        await client.leave()
        if bot is not None and bot.fairplay is not None:
            audit = {"summary": bot.fairplay.summary(), "actions": bot.fairplay.audit}
            (validate_action_audit if bot_race == "Protoss" else validate_adversary_audit)(audit)
            write_json(output / "audit.json", audit)
            publish(audit=audit["summary"])
        if _sha256(checkpoint) != checkpoint_digest:
            raise ValueError("The frozen checkpoint changed during the match")
    except Exception as error:
        publish("failed", error=f"{type(error).__name__}: {error}", result=None, results=None)
    finally:
        if ports is not None:
            ports.clean()
        finalized = True
        publish(terminal_status or "failed", wall_seconds=monotonic() - started)
        write_json(output / "match.json", {**state, "learner_race": human_race,
            "opponent_race": bot_race, "opponent": "trained_bot", "exhibition": True,
            "game_seconds": [state["game_seconds"], state["game_seconds"]]})
    return state


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--checkpoint", type=Path, required=True)
    parser.add_argument("--output", type=Path, required=True)
    parser.add_argument("--human-race", choices=RACES, default="Protoss")
    parser.add_argument("--bot-race", choices=RACES, required=True)
    parser.add_argument("--map", dest="map_path", required=True)
    parser.add_argument("--max-apm", type=int, default=600,
                        help="Terran/Zerg budget; Protoss always keeps 200 APM")
    parser.add_argument("--max-game-seconds", type=float, default=3600)
    parser.add_argument("--max-wall-seconds", type=float, help="Optional bounded verification run")
    parser.add_argument("--seed", type=int, default=1)
    arguments = vars(parser.parse_args(argv))
    from loguru import logger
    import sys
    logger.remove()
    logger.add(sys.stderr, level="INFO")
    result = asyncio.run(play(**arguments))
    print(json.dumps(result, indent=2))
    return 1 if result["status"] == "failed" else 0


if __name__ == "__main__":
    raise SystemExit(main())
