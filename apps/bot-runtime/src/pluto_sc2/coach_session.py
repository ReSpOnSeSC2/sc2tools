"""Run a separate local, session-coached match without an external model API."""
from __future__ import annotations

import argparse
from datetime import datetime, timezone
import hashlib
import json
import math
from pathlib import Path
import time
import uuid

from filelock import FileLock
import psutil
from sc2.data import Difficulty, Race
from sc2.main import run_game
from sc2.player import Bot, Computer

from .coach_bot import CoachBot, PROFILE
from .coach_orders import StrategyOrder
from .coach_opening_io import opening_snapshot, load_opening
from .runner import resolve_map, spatial_client, validate_action_audit, write_json


def initialize(output, map_name, *, opponent_race="Terran", difficulty="VeryEasy", seconds=600, speed=3,
               opening_library=None, opening_replay=None, opening_horizon=240, opening_seed=None):
    output = Path(output).resolve()
    if opponent_race not in {"Protoss", "Terran", "Zerg"} or difficulty not in {
        "VeryEasy", "Easy", "Medium", "MediumHard", "Hard", "Harder", "VeryHard"}:
        raise ValueError("Choose an ordinary non-cheating computer opponent")
    if (not math.isfinite(seconds) or not 60 <= seconds <= 3600
            or not math.isfinite(speed) or not 0 < speed <= 50):
        raise ValueError("Invalid duration or speed")
    if bool(opening_library) != bool(opening_replay):
        raise ValueError('Choose both an opening library and an opening replay')
    if not math.isfinite(opening_horizon) or not 60 <= opening_horizon <= 600:
        raise ValueError('Opening horizon must be 60 to 600 game seconds')
    opening = (opening_snapshot(opening_library, opening_replay, opponent_race, opening_horizon,
                                selection_seed=opening_seed)
               if opening_library else None)
    selected_map = resolve_map(map_name)
    if output.exists() and any(output.iterdir()):
        raise ValueError("Coach output must be a new empty directory; never use the active league")
    output.mkdir(parents=True, exist_ok=True)
    state = {"schema": 1, "game_id": uuid.uuid4().hex, "profile": PROFILE, "status": "ready",
             "map": str(selected_map.path), "opponent_race": opponent_race,
             "difficulty": difficulty, "max_game_seconds": seconds, "speed": speed,
             "created_at": datetime.now(timezone.utc).isoformat(), "seed": 94321,
             "external_model_api": False, "learned_policy": False,
             "note": "Separate experiment. Codex can update strategy.json while this local process executes."}
    if opening is not None:
        write_json(output / 'opening.json', opening)
        state['opening'] = {'path': 'opening.json',
                            'sha256': hashlib.sha256((output / 'opening.json').read_bytes()).hexdigest(),
                            'replay_id': opening['candidate']['replay_id'],
                            'label': opening['candidate']['site_build_label'],
                            'selection': opening['selection'],
                            'horizon_seconds': opening_horizon}
    write_json(output / "session.json", state)
    return state


def _preserve_partial_audit(output, bot, failure):
    """Save available native receipts without declaring a failed run verified."""
    metadata = {"path": "audit.partial.json", "status": "unavailable", "partial": True,
                "completed": False, "verification_passed": False}
    controller = getattr(bot, "fairplay", None)
    actions = getattr(controller, "audit", None)
    if not isinstance(actions, list):
        metadata["reason"] = "No recorded controller action list was available"
        return metadata
    # Do not validate partial receipts as a complete game: the last selection
    # or command may still await its next native observation at the crash.
    audit = {"summary": {}, "actions": list(actions), "partial": True, "completed": False,
             "verification_passed": False, "failure": f"{type(failure).__name__}: {failure}",
             "validation": {"status": "not_run", "reason": "Session failed; receipts are incomplete"}}
    metadata["actions"] = len(actions)
    try:
        audit["summary"] = controller.summary()
    except BaseException as summary_error:
        audit["summary_error"] = f"{type(summary_error).__name__}: {summary_error}"
        metadata["summary_error"] = audit["summary_error"]
    write_json(output / metadata["path"], audit)
    metadata["status"] = "saved"
    return metadata


def run(output):
    output = Path(output).resolve()
    with FileLock(str(output / ".coach.lock"), timeout=0):
        state = json.loads((output / "session.json").read_text())
        if state["status"] != "ready" or (output / "STOP").exists():
            raise ValueError("Only a ready, unstopped coach session may run; create a new session for another game")
        process = psutil.Process()
        state.update(status="running", pid=process.pid, process_created_at=process.create_time())
        write_json(output / "session.json", state)
        started = time.monotonic()
        bot = None
        failure = None
        try:
            kwargs = {}
            if state.get('opening'):
                kwargs['opening'] = load_opening(output, state['opening'])
            bot = CoachBot(output, state["game_id"], max_game_seconds=state["max_game_seconds"], speed=state["speed"], **kwargs)
            with spatial_client():
                result = run_game(resolve_map(state["map"]), [
                    Bot(Race.Protoss, bot, name="Codex coached Protoss"),
                    Computer(Race[state["opponent_race"]], Difficulty[state["difficulty"]]),
                ], realtime=False, disable_fog=False, random_seed=state["seed"],
                    game_time_limit=state["max_game_seconds"], save_replay_as=str(output / "game.SC2Replay"))
            if bot.error or not bot._episode_finished:
                raise RuntimeError(bot.error or "Coach episode did not finish")
            audit = {"summary": bot.fairplay.summary(), "actions": bot.fairplay.audit}
            validation = validate_action_audit(audit)
            write_json(output / "audit.json", audit)
            state.update(status="complete", result=result.name, game_seconds=float(bot.time),
                         wall_seconds=time.monotonic() - started, input_validation=validation,
                         control_rules=bot.control_summary, policy_actions=dict(bot.action_counts),
                         forfeit=bot.forfeit_reason, strategy=bot.mailbox.status)
        except BaseException as error:
            failure = error
            state.update(status="failed", error=f"{type(error).__name__}: {error}")
            try:
                state["partial_audit"] = _preserve_partial_audit(output, bot, error)
            except BaseException as audit_error:
                diagnostic = f"{type(audit_error).__name__}: {audit_error}"
                state["partial_audit"] = {"path": "audit.partial.json", "status": "preservation_failed",
                                          "partial": True, "completed": False,
                                          "verification_passed": False, "error": diagnostic}
                error.add_note(f"Partial action audit could not be preserved: {diagnostic}")
            raise
        finally:
            state["finished_at"] = datetime.now(timezone.utc).isoformat()
            try:
                write_json(output / "session.json", state)
            except BaseException as state_error:
                if failure is None:
                    raise
                failure.add_note(f"Failed session manifest could not be written: {type(state_error).__name__}: {state_error}")
        return state


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__)
    sub = parser.add_subparsers(dest="command", required=True)
    init = sub.add_parser("init")
    init.add_argument("--output", required=True)
    init.add_argument("--map", required=True)
    init.add_argument("--race", default="Terran")
    init.add_argument("--difficulty", default="VeryEasy")
    init.add_argument("--seconds", type=float, default=600)
    init.add_argument("--speed", type=float, default=3)
    init.add_argument('--opening-library')
    init.add_argument('--opening-replay')
    init.add_argument('--opening-horizon', type=float, default=240)
    init.add_argument('--opening-seed', type=int)
    start = sub.add_parser("run")
    start.add_argument("--output", required=True)
    validate = sub.add_parser("validate-order")
    validate.add_argument("--path", required=True)
    args = parser.parse_args(argv)
    if args.command == "init":
        result = initialize(args.output, args.map, opponent_race=args.race, difficulty=args.difficulty,
                            seconds=args.seconds, speed=args.speed, opening_library=args.opening_library,
                            opening_replay=args.opening_replay, opening_horizon=args.opening_horizon,
                            opening_seed=args.opening_seed)
    elif args.command == "run":
        import torch
        torch.set_num_threads(2)
        result = run(args.output)
    else:
        result = StrategyOrder.from_dict(json.loads(Path(args.path).read_text())).to_dict()
    print(json.dumps(result, indent=2))


if __name__ == "__main__":
    main()
