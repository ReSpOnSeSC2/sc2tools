"""Prepare a separate whole-replay expansion plan without changing active data.

The SC2TOOLS mapping batch remains spectator playback. This manifest identifies
the player-perspective captures still required before it can train a policy.
"""
from __future__ import annotations

import argparse
from collections import Counter, defaultdict
from datetime import datetime, timezone
import hashlib
import json
from pathlib import Path
import sys

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "src"))
from pluto_sc2.rich_dataset import file_hash, replay_partitions  # noqa: E402


def make_plan(inventory, existing_partitions, *, seed="response-rich-v1"):
    if inventory.get("complete") is not True or inventory.get("errors"):
        raise ValueError("A completed error-free native inventory is required")
    replays = inventory["replays"]
    ids = [row["replay_id"] for row in replays]
    if len(set(ids)) != len(ids) or not set(existing_partitions).issubset(ids):
        raise ValueError("Inventory must be unique and preserve all pinned originals")
    if any(value not in ("train", "validation") for value in existing_partitions.values()):
        raise ValueError("Invalid pinned partition")
    groups = defaultdict(list)
    for row in replays:
        players = row["players"]
        if (row.get("base_build") != 97563 or row.get("game_speed") != "Faster"
                or len(players) != 2 or len({p["player_id"] for p in players}) != 2
                or any(p.get("starting_workers") != 8 for p in players)
                or any(p.get("race") not in ("Protoss", "Terran", "Zerg") for p in players)
                or row.get("duration_seconds", 0) < 60):
            raise ValueError("Unverified eight-worker current-patch original")
        selected = [p for p in players if p["player_id"] == row["player_id"]
                    and p["name"].casefold() == "response"]
        if len(selected) != 1 or selected[0]["result"] not in ("Win", "Loss"):
            raise ValueError("Original player identity or outcome is unresolved")
        groups[row["matchup"], selected[0]["result"]].append(row)
    partitions = dict(existing_partitions)
    for key, rows in sorted(groups.items()):
        candidates = [row for row in rows if row["replay_id"] not in partitions]
        candidates.sort(key=lambda row: hashlib.sha256(
            (seed + ":" + row["replay_id"]).encode()).hexdigest())
        # Preserve existing holdouts even if they already exceed the target.
        old_validation = sum(partitions.get(row["replay_id"]) == "validation" for row in rows)
        wanted = round(len(rows) * .2)
        if len(rows) >= 2:
            wanted = max(1, wanted)
        extra = max(0, min(len(candidates), wanted - old_validation))
        for index, row in enumerate(candidates):
            partitions[row["replay_id"]] = "validation" if index < extra else "train"
    captures = []
    for row in sorted(replays, key=lambda row: row["replay_id"]):
        partition = partitions[row["replay_id"]]
        for player in sorted(row["players"], key=lambda p: p["player_id"]):
            other = next(p for p in row["players"] if p["player_id"] != player["player_id"])
            opponent = player["player_id"] != row["player_id"]
            weighted_opponent = opponent and player["result"] == "Win"
            captures.append({
                "replay_id": row["replay_id"], "path": row["path"], "player_id": player["player_id"],
                "race": player["race"], "matchup": player["race"][0] + "v" + other["race"][0],
                "perspective": "opponent" if opponent else "ReSpOnSe", "result": player["result"],
                "partition": partition, "start_workers": 8, "base_build": row["base_build"],
                "data_version": row["data_version"], "map_name": row["map_name"],
                "duration_seconds": row["duration_seconds"],
                "training_sampling_weight": 2.0 if partition == "train" and weighted_opponent else 1.0,
                "evaluation_weight": 1.0,
                "actor_contract": {"fog": True, "camera_restricted": player["race"] == "Protoss",
                                   "max_apm": 200 if player["race"] == "Protoss" else 600},
                "capture_status": "not_collected_by_this_plan", "eligible_for_training": False,
                "spectator_mapping_is_actor_observation": False,
            })
    return {"schema": "rich-replay-expansion-plan-v1", "created_at": datetime.now(timezone.utc).isoformat(),
            "status": "prepared", "active_corpus_changed": False, "eligible_for_training": False,
            "split_strategy": "whole original SHA, matchup/outcome stratified; preserve prior split, hash-order new originals",
            "seed": seed, "preserved_originals": len(existing_partitions),
            "originals": len(partitions), "perspectives": len(captures),
            "partition_counts": dict(Counter(partitions.values())),
            "perspective_matchups": dict(Counter(row["matchup"] for row in captures)),
            "train_replay_ids": sorted(key for key, value in partitions.items() if value == "train"),
            "validation_replay_ids": sorted(key for key, value in partitions.items() if value == "validation"),
            "captures": captures,
            "next_gates": ["SC2TOOLS mapping completion is distinct from player capture",
                           "player-visible native capture with exact engine and selected-player worker verification",
                           "race-specific intent, tensor and paid decoder validation",
                           "unweighted whole-replay evaluation before policy promotion"]}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--inventory", type=Path, required=True)
    parser.add_argument("--existing-split", type=Path, required=True)
    parser.add_argument("--output", type=Path, required=True)
    args = parser.parse_args()
    hashes = {"inventory": file_hash(args.inventory), "existing_split": file_hash(args.existing_split)}
    plan = make_plan(json.loads(args.inventory.read_text(encoding="utf-8")),
                     replay_partitions(args.existing_split))
    plan["source_hashes"] = hashes
    plan["source_paths"] = {"inventory": str(args.inventory.resolve()),
                            "existing_split": str(args.existing_split.resolve())}
    if hashes != {"inventory": file_hash(args.inventory), "existing_split": file_hash(args.existing_split)}:
        raise ValueError("Source inventory or existing split changed")
    args.output.parent.mkdir(parents=True, exist_ok=True)
    with args.output.open("x", encoding="utf-8") as stream:
        json.dump(plan, stream, indent=2, allow_nan=False)
        stream.write("\n")
    print(json.dumps({key: plan[key] for key in (
        "status", "originals", "perspectives", "preserved_originals", "partition_counts", "perspective_matchups")}))


if __name__ == "__main__":
    main()
