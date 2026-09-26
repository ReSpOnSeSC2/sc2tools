"""Own-unit milestone trajectories from winning, training-only human replays.

Tracker data is used offline to count the selected human player's completed,
living units. No opponent inventory, actions, positions or hidden information
enters the artifact. Each reference is one coherent replay, never a mixture of
incompatible builds. This is a bounded training hint, not a scripted build.
"""
from __future__ import annotations

import argparse
from collections import Counter
from collections.abc import Iterable, Mapping
from copy import deepcopy
from datetime import datetime, timezone
import hashlib
from itertools import groupby
import json
import math
from numbers import Integral
from pathlib import Path
from typing import Any

from .replays import ReplayError, _hash_file, _metadata_protocol, _text, inspect_replay
from .schema import BUILD_TYPES, OWN_TYPE_NAMES, TRAIN_TYPES


VERSION = "winning-train-own-trajectories-v1"
_ALIASES = {"WARPGATE": "GATEWAY", "WARPPRISMPHASING": "WARPPRISM", "OBSERVERSIEGEMODE": "OBSERVER"}
_ALLOWED = frozenset((*OWN_TYPE_NAMES, "OBSERVERSIEGEMODE"))
_ARMY = frozenset((*[name for name in TRAIN_TYPES if name != "PROBE"], "ARCHON"))
_BUILDINGS = frozenset(BUILD_TYPES)
_MATCHUPS = frozenset(("PvT", "PvP", "PvZ"))


def _counts(values: Mapping[str, int]) -> dict[str, int]:
    """Validate and normalize aliases without rewarding surplus or unknown types."""
    result: Counter[str] = Counter()
    for name, value in values.items():
        if not isinstance(name, str) or name not in _ALLOWED:
            continue
        if isinstance(value, bool) or not isinstance(value, Integral) or value < 0:
            raise ValueError("Unit counts must be nonnegative integers")
        result[_ALIASES.get(name, name)] += int(value)
    return dict(result)


def replay_similarity(current_counts: Mapping[str, int], target_counts: Mapping[str, int]) -> float:
    """Capped per-type coverage of workers (25%), army (45%), buildings (30%).

    Only categories with a nonempty target participate. Wrong units, surplus
    units, unneeded structures and an empty target yield no extra credit. The
    caller must reward only productive asset changes: time advancing into a
    different reference frame must never itself generate reward.
    """
    current, target = _counts(current_counts), _counts(target_counts)
    value = weight_sum = 0.0
    for names, weight in (({"PROBE"}, .25), (_ARMY, .45), (_BUILDINGS, .30)):
        desired = {name: count for name, count in target.items() if name in names and count > 0}
        if desired:
            coverage = sum(min(current.get(name, 0), count) for name, count in desired.items()) / sum(desired.values())
            value += weight * coverage
            weight_sum += weight
    return value / weight_sum if weight_sum else 0.0


def frame_at(trajectory: Mapping[str, Any], seconds: float) -> dict[str, Any]:
    """Return the latest reference frame at/before time, clamped at the ends."""
    if isinstance(seconds, bool) or not isinstance(seconds, (int, float)) or not math.isfinite(seconds) or seconds < 0:
        raise ValueError("Reference time must be finite and nonnegative")
    frames = trajectory.get("frames", [])
    if not frames:
        raise ValueError("Reference trajectory has no frames")
    selected = frames[0]
    for frame in frames[1:]:
        if frame["seconds"] > seconds:
            break
        selected = frame
    return selected


def frames_from_events(events: Iterable[dict], *, player_id: int, game_loops: int,
                       loops_per_second: float = 22.4, interval_seconds: int = 60) -> list[dict]:
    """Reconstruct own live completed counts, processing all events at boundaries.

    Born means complete; Init is not counted until Done. Death, type changes,
    and ownership losses update the same (index, recycle) identity. Opponent
    events are never stored. Acquiring an untracked enemy unit is intentionally
    omitted; that is not production by the selected player.
    """
    if (type(player_id) is not int or player_id < 1 or type(game_loops) is not int or game_loops < 0
            or type(interval_seconds) is not int or interval_seconds < 1
            or not math.isfinite(loops_per_second) or loops_per_second <= 0):
        raise ValueError("Invalid replay timing or player")
    live: dict[tuple[int, int], dict] = {}
    frames, next_second, previous_loop = [], 0, -1

    def emit() -> None:
        counts = Counter(item["name"] for item in live.values()
                         if item["complete"] and not item["hallucination"] and item["name"] in _ALLOWED)
        frames.append({"seconds": next_second, "counts": dict(sorted(counts.items()))})

    for loop, group in groupby(events, key=lambda event: event["_gameloop"]):
        if type(loop) is not int or loop < previous_loop or loop < 0:
            raise ReplayError("Replay tracker loops are not ordered")
        if loop > game_loops:
            break
        while next_second * loops_per_second < loop - 1e-8:
            emit()
            next_second += interval_seconds
        for event in group:
            kind = event["_event"].rsplit(".", 1)[-1]
            if "m_unitTagIndex" not in event or "m_unitTagRecycle" not in event:
                continue
            tag = (int(event["m_unitTagIndex"]), int(event["m_unitTagRecycle"]))
            if kind in {"SUnitBornEvent", "SUnitInitEvent"}:
                if event.get("m_upkeepPlayerId") != player_id:
                    continue
                ability = _text(event.get("m_creatorAbilityName") or "").casefold()
                live[tag] = {"name": _text(event.get("m_unitTypeName", "")).upper(),
                             "complete": kind == "SUnitBornEvent",
                             "hallucination": "hallucinat" in ability}
            elif tag in live:
                if kind == "SUnitDoneEvent":
                    live[tag]["complete"] = True
                elif kind == "SUnitDiedEvent":
                    del live[tag]
                elif kind == "SUnitTypeChangeEvent":
                    live[tag]["name"] = _text(event.get("m_unitTypeName", "")).upper()
                elif kind == "SUnitOwnerChangeEvent" and event.get("m_upkeepPlayerId") != player_id:
                    del live[tag]
        previous_loop = loop
    while next_second * loops_per_second <= game_loops + 1e-8:
        emit()
        next_second += interval_seconds
    if not frames or frames[0]["counts"].get("PROBE") != 8:
        raise ReplayError("Target trajectory must start with exactly eight completed Probes")
    return frames


def extract_trajectory(record: dict, *, player_name: str) -> dict:
    """Verify archive identity/outcome, then reconstruct this player's units."""
    import mpyq

    path = Path(record["path"]).resolve()
    expected_hash = record["sha256"]
    if record["replay_id"] != expected_hash or _hash_file(path) != expected_hash:
        raise ReplayError("Reference replay SHA256 differs from the verified manifest")
    info = inspect_replay(path)
    matches = [player for player in info["players"]
               if player["player_id"] == record["player_id"] and player["name"].casefold() == player_name.casefold()]
    if (len(matches) != 1 or matches[0]["race"] != "Protoss" or matches[0]["result"] not in {"Win", "Victory"}
            or matches[0]["starting_workers"] != 8 or info["replay_id"] != expected_hash):
        raise ReplayError("Reference player, victory, or eight-worker start failed archive verification")
    opponents = [player for player in info["players"] if player["player_id"] != record["player_id"]]
    if (len(opponents) != 1 or "Pv" + opponents[0]["race"][0] != record["matchup"]
            or info["game_speed"] != "Faster"):
        raise ReplayError("Reference matchup or game-speed metadata differs from the supported scenario")
    archive = mpyq.MPQArchive(str(path))
    tracker = archive.read_file("replay.tracker.events")
    if not tracker:
        raise ReplayError("Reference replay has no tracker events")
    frames = frames_from_events(_metadata_protocol().decode_replay_tracker_events(tracker),
                                player_id=record["player_id"], game_loops=info["game_loops"])
    if _hash_file(path) != expected_hash:
        raise ReplayError("Reference replay changed during extraction")
    return {"replay_id": expected_hash, "matchup": record["matchup"], "result": "Victory",
            "source_path": str(path), "source_sha256": expected_hash,
            "player_id": record["player_id"], "player_name": matches[0]["name"],
            "starting_workers": 8, "game_loops": info["game_loops"], "loops_per_second": 22.4,
            "frames": frames}


def validate_targets(targets: Mapping[str, Any]) -> None:
    if targets.get("version") != VERSION:
        raise ReplayError("Unsupported reward reference version")
    train_ids = targets.get("train_replay_ids", [])
    validation_ids = targets.get("validation_replay_ids", [])
    if (not train_ids or len(set(train_ids)) != len(train_ids) or len(set(validation_ids)) != len(validation_ids)
            or set(train_ids) & set(validation_ids)):
        raise ReplayError("Reward targets require disjoint, unique train/validation replay IDs")
    seen = set()
    for trajectory in targets.get("trajectories", []):
        replay_id = trajectory["replay_id"]
        if (replay_id in seen or replay_id not in train_ids or replay_id in validation_ids
                or trajectory.get("source_sha256") != replay_id or trajectory.get("result") != "Victory"
                or trajectory.get("matchup") not in _MATCHUPS or trajectory.get("starting_workers") != 8):
            raise ReplayError("Trajectory provenance is not an eight-worker winning training replay")
        seen.add(replay_id)
        frames = trajectory.get("frames", [])
        if not frames or frames[0].get("seconds") != 0 or frames[0].get("counts", {}).get("PROBE") != 8:
            raise ReplayError("Trajectory lacks its verified initial frame")
        previous = -1
        for frame in frames:
            second = frame.get("seconds")
            if type(second) is not int or second <= previous or second % 60:
                raise ReplayError("Trajectory frames must have increasing whole-minute times")
            if not isinstance(frame.get("counts"), dict) or any(name not in _ALLOWED for name in frame["counts"]):
                raise ReplayError("Trajectory contains unsupported counts")
            _counts(frame["counts"])
            previous = second
    if not seen:
        raise ReplayError("No winning training trajectories found")


def build_targets(manifest_path: str | Path, metrics_path: str | Path, output_path: str | Path | None = None) -> dict:
    """Build without changing the source manifest, corpus, split, or checkpoints."""
    manifest_path, metrics_path = Path(manifest_path).resolve(), Path(metrics_path).resolve()
    manifest = json.loads(manifest_path.read_text(encoding="utf-8"))
    metrics = json.loads(metrics_path.read_text(encoding="utf-8"))
    train_ids, validation_ids = metrics["train_replay_ids"], metrics["validation_replay_ids"]
    if (not manifest.get("complete") or not train_ids or set(train_ids) & set(validation_ids)
            or len(set(train_ids)) != len(train_ids) or len(set(validation_ids)) != len(validation_ids)):
        raise ReplayError("Only a complete corpus and disjoint whole-replay split may supply reward targets")
    records = {record["replay_id"]: record for record in manifest["replays"]}
    if (len(records) != len(manifest["replays"])
            or not (set(train_ids) | set(validation_ids)).issubset(records)):
        raise ReplayError("Training split is missing or ambiguous in the verified manifest")
    chosen = [records[replay_id] for replay_id in sorted(train_ids)
              if records[replay_id]["result"] == "Victory"]
    for record in chosen:
        if record.get("starting_workers") != 8 or record.get("matchup") not in _MATCHUPS:
            raise ReplayError("Winning reference is not a supported eight-worker Protoss matchup")
    targets = {"version": VERSION, "created_at": datetime.now(timezone.utc).isoformat(),
               "player_name": manifest["player_name"], "interval_seconds": 60,
               "source_manifest": str(manifest_path), "source_manifest_sha256": _hash_file(manifest_path),
               "split_metrics": str(metrics_path), "split_metrics_sha256": _hash_file(metrics_path),
               "train_replay_ids": sorted(train_ids), "validation_replay_ids": sorted(validation_ids),
               "excluded_loss_replay_ids": sorted(replay_id for replay_id in train_ids
                                                   if records[replay_id]["result"] != "Victory"),
               "signal": "Completed, living own units only; individual coherent winning trajectories",
               "trajectories": [extract_trajectory(record, player_name=manifest["player_name"]) for record in chosen]}
    validate_targets(targets)
    if output_path is not None:
        destination = Path(output_path).resolve()
        if destination in {manifest_path, metrics_path} or destination.exists():
            raise FileExistsError("Reward target output must be a new file")
        destination.parent.mkdir(parents=True, exist_ok=True)
        with destination.open("x", encoding="utf-8") as stream:
            json.dump(targets, stream, indent=2, allow_nan=False)
            stream.write("\n")
    return targets


def load_targets(path: str | Path) -> dict:
    targets = json.loads(Path(path).read_text(encoding="utf-8"))
    validate_targets(targets)
    return targets


def select_trajectory(targets: Mapping[str, Any], matchup: str, seed: int) -> dict:
    """Deterministically select one training reference, fixed for the whole game."""
    validate_targets(targets)
    if matchup not in _MATCHUPS or type(seed) is not int:
        raise ValueError("Reference selection requires a supported matchup and integer seed")
    choices = sorted((item for item in targets["trajectories"] if item["matchup"] == matchup),
                     key=lambda item: item["replay_id"])
    if not choices:
        raise ReplayError(f"No winning training reference for {matchup}")
    index = int.from_bytes(hashlib.sha256(f"{VERSION}|{matchup}|{seed}".encode()).digest(), "big") % len(choices)
    return deepcopy(choices[index])


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--manifest", required=True)
    parser.add_argument("--metrics", required=True)
    parser.add_argument("--output", required=True)
    args = parser.parse_args()
    targets = build_targets(args.manifest, args.metrics, args.output)
    print(json.dumps({"output": str(Path(args.output).resolve()), "trajectories": len(targets["trajectories"]),
                      "matchups": dict(Counter(item["matchup"] for item in targets["trajectories"]))}))


if __name__ == "__main__":
    main()
