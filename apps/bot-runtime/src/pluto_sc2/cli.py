"""Command-line entry point; all gameplay paths enforce the experiment contract."""

from __future__ import annotations

import argparse
import json
import os
import sys
from pathlib import Path


def positive(value: str) -> int:
    number = int(value)
    if number < 1:
        raise argparse.ArgumentTypeError("must be positive")
    return number


def replay_files(paths: list[str], limit: int | None = None) -> list[Path]:
    found: set[Path] = set()
    for value in paths:
        path = Path(value).expanduser()
        if path.is_file() and path.suffix.lower() == ".sc2replay":
            found.add(path.resolve())
        elif path.is_dir():
            found.update(p.resolve() for p in path.rglob("*") if p.is_file() and p.suffix.lower() == ".sc2replay")
        else:
            raise ValueError(f"Not a replay file or folder: {path}")
    if not found:
        raise ValueError("No .SC2Replay files found in the supplied paths")
    return sorted(found)[:limit]


def parser() -> argparse.ArgumentParser:
    root = argparse.ArgumentParser(description="Protoss: eight-worker starts, replay imitation, 200 APM, camera restrictions")
    root.add_argument("--sc2-path", help="StarCraft II installation directory (or set SC2PATH)")
    root.add_argument("--threads", type=positive, default=4, help="PyTorch CPU threads (default: 4)")
    commands = root.add_subparsers(dest="command", required=True)
    commands.add_parser("doctor", help="Check the local runtime and experiment requirements")
    inspect = commands.add_parser("inspect-replays", help="Read replay players, versions and map metadata locally")
    inspect.add_argument("paths", nargs="+")
    inspect.add_argument("--limit", type=positive, default=20)
    sync = commands.add_parser("sync-replays", help="Download your original files from SC2TOOLS")
    sync.add_argument("--api-url", default="https://sc2tools-api.onrender.com")
    sync.add_argument("--output", default="replays/remote")
    sync.add_argument("--limit", type=positive, default=100)
    sync.add_argument("--public-handle", help="An existing shared archive; no token or sharing changes")
    sync.add_argument("--token-env", default="SC2TOOLS_TOKEN", help="Environment variable holding an existing private API token")
    extract = commands.add_parser("import-replays", help="Reconstruct camera-limited training examples in the SC2 engine")
    extract.add_argument("paths", nargs="+")
    extract.add_argument("--output", required=True, help="Output .npz dataset")
    selection = extract.add_mutually_exclusive_group()
    selection.add_argument("--player", help="Exact player name, without clan tag")
    selection.add_argument("--player-id", type=positive)
    extract.add_argument("--step-mul", type=int, choices=(8,), default=8)
    extract.add_argument("--idle-fraction", type=float, default=.25)
    extract.add_argument("--seed", type=int, default=1)
    imitation = commands.add_parser("imitate", help="Train on imported replays, holding out entire games")
    imitation.add_argument("datasets", nargs="+")
    imitation.add_argument("--output", required=True, help="Output .pt checkpoint")
    imitation.add_argument("--epochs", type=positive, default=20)
    imitation.add_argument("--batch-size", type=positive, default=128)
    imitation.add_argument("--learning-rate", type=float, default=3e-4)
    imitation.add_argument("--gameplay-loss-weight", type=float, default=1.0,
                           help="Replay gameplay-command weight relative to camera and idle examples")
    imitation.add_argument("--validation-fraction", type=float, default=.2)
    imitation.add_argument("--stratify-matchups", action="store_true",
                           help="Hold out whole replay games separately in PvT, PvP and PvZ")
    imitation.add_argument("--stratify-outcomes", action="store_true",
                           help="Also balance original wins and losses within each matchup's game split")
    imitation.add_argument("--balance-matchups", action="store_true",
                           help="Balance each matchup's contribution to the imitation loss")
    imitation.add_argument("--resume", help="Compatible checkpoint to fine-tune")
    imitation.add_argument("--hidden-dim", type=positive, default=256)
    imitation.add_argument("--seed", type=int, default=1)
    imitation.add_argument("--device", choices=("cpu", "cuda", "auto"), default="cpu")
    for name in ("train", "evaluate", "play"):
        command = commands.add_parser(name)
        command.add_argument("--map", required=True, help="Current 5.0.16+ eight-worker melee map path or installed name")
        command.add_argument("--max-game-seconds", type=positive, default=1200)
        command.add_argument("--step-mul", type=int, choices=(8,), default=8)
        command.add_argument("--seed", type=int, default=1 if name != "evaluate" else 10000)
        command.add_argument("--device", choices=("cpu", "cuda", "auto"), default="cpu")
        command.add_argument("--difficulty", choices=("VeryEasy", "Easy", "Medium", "MediumHard", "Hard", "Harder", "VeryHard"), default="Easy")
        command.add_argument("--opponent-race", choices=("Terran", "Protoss", "Zerg", "Random"), default="Random")
        if name == "train":
            command.add_argument("--output", required=True)
            command.add_argument("--games", type=positive, default=100)
            command.add_argument("--resume", help="Start from an imitation or prior PPO checkpoint")
            command.add_argument("--opponent", choices=("self", "builtin"), default="self")
            command.add_argument("--hidden-dim", type=positive, default=256)
            command.add_argument("--learning-rate", type=float, default=3e-4)
            command.add_argument("--gamma", type=float, default=1.0)
            command.add_argument("--gae-lambda", type=float, default=.95)
            command.add_argument("--epochs", type=positive, default=4)
            command.add_argument("--minibatch-size", type=positive, default=64)
            command.add_argument("--entropy-coef", type=float, default=.01)
            command.add_argument("--reference-kl-coef", type=float, default=.01,
                                 help="Frozen replay-policy penalty during RL (0 disables the penalty)")
            command.add_argument("--reward-shaping", type=float, default=.1)
            command.add_argument("--save-replays-every", type=int, default=1)
        else:
            command.add_argument("--checkpoint", required=True)
            command.add_argument("--output", default="runs/evaluation" if name == "evaluate" else "runs/play")
            selection = command.add_mutually_exclusive_group()
            selection.add_argument("--deterministic", action="store_true",
                                   help="Choose the most likely action instead of sampling the learned policy")
            selection.add_argument("--stochastic", dest="deterministic", action="store_false",
                                   help="Sample the learned action distribution (default)")
            command.set_defaults(deterministic=False)
            if name == "evaluate":
                command.add_argument("--games", type=positive, default=10)
            else:
                command.add_argument("--opponent", choices=("builtin", "self", "human"), default="builtin")
                command.add_argument("--realtime", action="store_true", help="Run at human speed; required versus a human")
    audit = commands.add_parser("audit", help="Independently check an emitted input audit")
    audit.add_argument("path")
    return root


def audit_file(path: str) -> dict:
    from pluto_sc2.runner import validate_action_audit
    data = json.loads(Path(path).read_text(encoding="utf-8"))
    return validate_action_audit(data)


def main(argv: list[str] | None = None) -> int:
    args = parser().parse_args(argv)
    if args.sc2_path:
        os.environ["SC2PATH"] = str(Path(args.sc2_path).expanduser().resolve())
    try:
        import torch
        from loguru import logger

        # SC2 protocol DEBUG messages can include full replay contents. Keep
        # progress on stderr and reserve stdout for the command's JSON result.
        logger.remove()
        logger.add(sys.stderr, level="INFO")
        from pluto_sc2 import runner
        torch.set_num_threads(args.threads)
        if args.command == "doctor":
            result = runner.doctor(args.sc2_path)
        elif args.command == "inspect-replays":
            from pluto_sc2.replays import inspect_replay
            result = [inspect_replay(path) for path in replay_files(args.paths, args.limit)]
        elif args.command == "sync-replays":
            from pluto_sc2.remote import sync_remote
            result = sync_remote(args.api_url, args.output, token_env=args.token_env,
                                 limit=args.limit, public_handle=args.public_handle)
        elif args.command == "import-replays":
            from pluto_sc2.replays import extract_replays
            result = extract_replays(replay_files(args.paths), args.output, player_name=args.player,
                                     player_id=args.player_id, step_mul=args.step_mul,
                                     idle_fraction=args.idle_fraction, seed=args.seed)
        elif args.command == "imitate":
            from pluto_sc2.replays import pretrain
            result = pretrain(args.datasets, args.output, epochs=args.epochs, batch_size=args.batch_size,
                              learning_rate=args.learning_rate, validation_fraction=args.validation_fraction,
                              gameplay_loss_weight=args.gameplay_loss_weight,
                              stratify_matchups=args.stratify_matchups,
                              stratify_outcomes=args.stratify_outcomes,
                              balance_matchups=args.balance_matchups,
                              seed=args.seed, hidden_dim=args.hidden_dim, resume=args.resume,
                              device=runner.device_name(args.device))
            runner.write_json(Path(args.output).with_suffix(".metrics.json"), result)
        elif args.command == "audit":
            result = audit_file(args.path)
        else:
            common = dict(map_name=args.map, max_game_seconds=args.max_game_seconds,
                          step_mul=args.step_mul, seed=args.seed, difficulty=args.difficulty,
                          opponent_race=args.opponent_race)
            if args.command == "train":
                from pluto_sc2.learning import PPOConfig
                config = PPOConfig(learning_rate=args.learning_rate, gamma=args.gamma,
                                    gae_lambda=args.gae_lambda, epochs=args.epochs,
                                    minibatch_size=args.minibatch_size, entropy_coef=args.entropy_coef,
                                    reference_kl_coef=args.reference_kl_coef)
                result = runner.train(**common, output=args.output, games=args.games, resume=args.resume,
                                       opponent=args.opponent, hidden_dim=args.hidden_dim, device=args.device,
                                       config=config, reward_shaping=args.reward_shaping,
                                       save_replays_every=args.save_replays_every)
            elif args.command == "evaluate":
                result = runner.evaluate(**common, checkpoint=args.checkpoint, output=args.output,
                                          games=args.games, device=args.device, deterministic=args.deterministic)
            else:
                policy, _ = runner.load_policy(args.checkpoint, args.device)
                runner.seed_everything(args.seed)
                output = Path(args.output)
                bots, result = runner.play_match(**common, policy=policy, opponent=args.opponent,
                                                 realtime=args.realtime, deterministic=args.deterministic,
                                                 replay_path=output / "match.SC2Replay")
                for player, bot in enumerate(bots, 1):
                    runner.write_json(output / f"audit-p{player}.json", {"summary": bot.fairplay.summary(),
                                                                        "actions": bot.fairplay.audit})
                runner.write_json(output / "result.json", result)
        print(json.dumps(result, indent=2, allow_nan=False))
        return 0
    except KeyboardInterrupt:
        print("Stopped. The last completed checkpoint is preserved.", file=sys.stderr)
        return 130
    except (ValueError, RuntimeError, OSError, KeyError) as error:
        print(f"Error: {error}", file=sys.stderr)
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
