"""Offline review of the seven frozen TRAIN exemplars; never a training input.

Run with the project virtualenv. Decodes complete protocol-97563 streams without
starting SC2, modifying source replays, or exposing tracker data to a live bot.
"""
from __future__ import annotations

from collections import Counter, defaultdict
from datetime import datetime, timezone
import hashlib
import importlib.util
import json
from pathlib import Path

import mpyq
import s2protocol

from pluto_sc2.replays import _metadata_protocol, _player_name, _text
from pluto_sc2.schema import BUILD_TYPES, OWN_TYPE_NAMES


ROOT = Path(__file__).resolve().parents[1]
LIBRARY = ROOT / "runs/build-library-review-20260925/multi-opening-library-v2.json"
SPLIT = ROOT / "runs/response90-replay-split.json"
CORPUS = ROOT / "runs/response-90-manifest.json"
OUTPUT = ROOT / "runs/full-replay-review-20260925"
BUILDINGS = frozenset((*BUILD_TYPES, "WARPGATE"))
BASES = frozenset({"NEXUS", "COMMANDCENTER", "ORBITALCOMMAND", "PLANETARYFORTRESS",
                  "COMMANDCENTERFLYING", "ORBITALCOMMANDFLYING", "HATCHERY", "LAIR", "HIVE"})
WORKERS = frozenset({"PROBE", "SCV", "DRONE"})
TRANSITION_TYPES = frozenset({"EGG", "LARVA", "BANELINGCOCOON", "RAVAGERCOCOON",
                             "BROODLORDCOCOON", "OVERLORDCOCOON", "LURKERMPEGG"})
SCOPE = "Offline omniscient tracker review only; never player-visible observations or live policy inputs."


def sha(path):
    return hashlib.sha256(Path(path).read_bytes()).hexdigest()


def read(path):
    return json.loads(Path(path).read_text(encoding="utf-8"))


def write(path, payload):
    Path(path).write_text(json.dumps(payload, indent=2, ensure_ascii=False) + "\n", encoding="utf-8")


def require(condition, message):
    if not condition:
        raise ValueError(message)


def exact_protocol():
    path = Path(s2protocol.__file__).parent / "versions/protocol97563.py"
    require(path.is_file(), "Exact protocol97563 is required; no fallback decoder is permitted.")
    spec = importlib.util.spec_from_file_location("_full_review_protocol97563", path)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module, path


def clean(value):
    if isinstance(value, bytes):
        return _text(value)
    if isinstance(value, dict):
        return {key: clean(item) for key, item in value.items()}
    if isinstance(value, (tuple, list)):
        return [clean(item) for item in value]
    return value


def tag(event):
    return (int(event["m_unitTagIndex"]) << 18) | int(event["m_unitTagRecycle"])


def timestamp(loop, lps):
    return {"game_loop": loop, "seconds": round(loop / lps, 4)}


def stats_values(raw):
    def get(name):
        return raw.get("m_scoreValue" + name)

    result = {
        "bank": {"minerals": get("MineralsCurrent"), "vespene": get("VespeneCurrent")},
        "collection_rate": {"minerals": get("MineralsCollectionRate"),
                            "vespene": get("VespeneCollectionRate")},
        "active_workers": get("WorkersActiveCount"),
        "supply_used": get("FoodUsed") / 4096 if get("FoodUsed") is not None else None,
        "supply_cap": get("FoodMade") / 4096 if get("FoodMade") is not None else None,
    }
    for label, suffix in (("army_value", "UsedCurrentArmy"), ("army_in_progress", "UsedInProgressArmy"),
                          ("active_forces_value", "UsedActiveForces")):
        result[label] = {"minerals": get("Minerals" + suffix), "vespene": get("Vespene" + suffix)}
    for label in ("Lost", "Killed", "FriendlyFire"):
        result[label.lower() + "_cumulative"] = {
            category.lower(): {resource.lower(): get(resource + label + category)
                               for resource in ("Minerals", "Vespene")}
            for category in ("Army", "Economy", "Technology")}
    return result


def snapshot(loop, live, players, last_stats, lps):
    inventories = {}
    for player in players:
        units = [unit for unit in live.values() if unit["owner_player_id"] == player]
        real = [unit for unit in units if not unit["explicit_hallucination"]]
        inventories[str(player)] = {
            "completed_alive_counts": dict(sorted(Counter(u["type"] for u in real if u["complete"]).items())),
            "incomplete_alive_counts": dict(sorted(Counter(u["type"] for u in real if not u["complete"]).items())),
            "explicit_hallucination_counts": dict(sorted(Counter(u["type"] for u in units
                                                                  if u["explicit_hallucination"]).items())),
            "last_stats": last_stats.get(player),
        }
    return {**timestamp(loop, lps), "players": inventories}


def review(candidate, record, protocol, protocol_path):
    replay_id = candidate["replay_id"]
    path = Path(candidate["source_path"]).resolve()
    require(path == Path(record["path"]).resolve(), "Library/corpus source path mismatch")
    require(sha(path) == replay_id == candidate["source_sha256"] == record["sha256"], "Replay SHA mismatch")
    archive = mpyq.MPQArchive(str(path))
    header = _metadata_protocol().decode_replay_header(archive.header["user_data_header"]["content"])
    require(header["m_version"]["m_baseBuild"] == 97563 == record["base_build"], "Unexpected replay build")
    details = protocol.decode_replay_details(archive.read_file("replay.details"))
    require(details["m_gameSpeed"] == 4, "These verified exemplars must use Faster game speed")
    lps = 22.4
    end = header["m_elapsedGameLoops"]
    require(end == record["game_loops"], "Header/corpus game duration mismatch")
    own = record["player_id"]
    players = {index + 1: {"player_id": index + 1, "name": _player_name(player["m_name"]),
                           "race": _text(player["m_race"]), "result_code": player["m_result"]}
               for index, player in enumerate(details["m_playerList"])}
    require(len(players) == 2 and players[own]["name"].casefold() == "response", "Wrong selected player")
    require(players[own]["result_code"] == 1 and candidate["result"] == "Victory", "Expected winning exemplar")
    # Materialize each stream fully: no opening-horizon or ten-minute cutoff.
    tracker = list(protocol.decode_replay_tracker_events(archive.read_file("replay.tracker.events")))
    game = list(protocol.decode_replay_game_events(archive.read_file("replay.game.events")))
    require(tracker and game, "Missing event stream")
    require(all(a["_gameloop"] <= b["_gameloop"] for a, b in zip(tracker, tracker[1:])), "Unsorted tracker")
    require(max(e["_gameloop"] for e in tracker) <= end, "Tracker exceeds header duration")
    game_end = max(e["_gameloop"] for e in game)
    require(0 <= end - game_end <= 1, "Game stream does not reach replay end")
    setups = [event for event in tracker if event["_event"].endswith("SPlayerSetupEvent")]
    user_to_player = {e["m_userId"]: e["m_playerId"] for e in setups if e.get("m_userId") is not None}
    require(own in user_to_player.values(), "Selected player has no exact user mapping")

    live, active_index, history = {}, {}, {}
    events, position_updates, stats, minutes = [], [], [], []
    base_placements, own_buildings, initial_workers = [], [], Counter()
    last_stats, last_stats_loop = {}, {}
    next_minute = 0
    for event in tracker:
        loop = event["_gameloop"]
        while next_minute < loop and next_minute <= end:
            minutes.append(snapshot(next_minute, live, players, last_stats, lps))
            next_minute += round(60 * lps)
        kind = event["_event"].rsplit(".", 1)[-1]
        stamp = timestamp(loop, lps)
        if kind == "SPlayerStatsEvent" and event["m_playerId"] in players:
            player = event["m_playerId"]
            row = {**stamp, "player_id": player, "perspective": "own" if player == own else "opponent_omniscient",
                   **stats_values(event["m_stats"]), "raw_stats": event["m_stats"]}
            stats.append(row)
            last_stats[player] = {key: value for key, value in row.items() if key != "raw_stats"}
            last_stats_loop[player] = loop
        elif kind in {"SUnitBornEvent", "SUnitInitEvent"}:
            unit_tag = tag(event)
            owner = event.get("m_upkeepPlayerId", 0)
            unit = {"unit_tag": unit_tag, "unit_index": event["m_unitTagIndex"],
                    "type": _text(event["m_unitTypeName"]), "owner_player_id": owner,
                    "control_player_id": event.get("m_controlPlayerId", owner),
                    "position": [event["m_x"], event["m_y"]], "position_game_loop": loop,
                    "complete": kind == "SUnitBornEvent", "birth_game_loop": loop,
                    "explicit_hallucination": "hallucinat" in _text(event.get("m_creatorAbilityName") or "").lower()}
            live[unit_tag] = unit
            active_index[event["m_unitTagIndex"]] = unit_tag
            history[unit_tag] = unit
            if loop == 0 and owner in players and unit["type"].upper() in WORKERS:
                initial_workers[owner] += 1
            if owner not in players:
                continue
            meaning = ("initial_unit" if loop == 0 else "completed_birth") if kind == "SUnitBornEvent" else "initialization"
            row = {**stamp, "event": kind, "meaning": meaning, **unit,
                   "creator_ability_name": _text(event.get("m_creatorAbilityName") or "") or None}
            events.append(row)
            if unit["type"].upper() in BASES:
                base_placements.append(row.copy())
            if owner == own and unit["type"].upper() in BUILDINGS:
                own_buildings.append(row.copy())
        elif kind in {"SUnitDoneEvent", "SUnitTypeChangeEvent", "SUnitOwnerChangeEvent", "SUnitDiedEvent"}:
            unit_tag = tag(event)
            unit = live.get(unit_tag)
            if unit is None:
                # Preserve unlinked records; do not invent a unit type/owner.
                events.append({**stamp, "event": kind, "unit_tag": unit_tag, "unresolved": True,
                               "raw_event": clean(event)})
                continue
            old_owner = unit["owner_player_id"]
            row = {**stamp, "event": kind, "unit_tag": unit_tag, "type": unit["type"],
                   "owner_player_id": old_owner, "explicit_hallucination": unit["explicit_hallucination"],
                   "last_known_position": unit["position"], "position_game_loop": unit["position_game_loop"]}
            if kind == "SUnitDoneEvent":
                unit["complete"] = True
                row["meaning"] = "completion_not_training_command"
            elif kind == "SUnitTypeChangeEvent":
                row["new_type"] = _text(event["m_unitTypeName"])
                unit["type"] = row["new_type"]
                unit["complete"] = unit["type"].upper() not in TRANSITION_TYPES
                row["meaning"] = "observed_type_change_not_command"
            elif kind == "SUnitOwnerChangeEvent":
                unit["owner_player_id"] = event["m_upkeepPlayerId"]
                unit["control_player_id"] = event["m_controlPlayerId"]
                row["new_owner_player_id"] = unit["owner_player_id"]
                row["new_control_player_id"] = unit["control_player_id"]
            else:
                row.update(position=[event["m_x"], event["m_y"]],
                           killer_player_id=event.get("m_killerPlayerId"),
                           killer_unit_tag=((event["m_killerUnitTagIndex"] << 18) | event["m_killerUnitTagRecycle"])
                           if event.get("m_killerUnitTagIndex") is not None else None,
                           meaning="death_not_necessarily_combat_loss")
                live.pop(unit_tag)
                if active_index.get(unit["unit_index"]) == unit_tag:
                    active_index.pop(unit["unit_index"])
            if old_owner in players or unit["owner_player_id"] in players:
                events.append(row)
        elif kind == "SUnitPositionsEvent":
            require(len(event["m_items"]) % 3 == 0, "Malformed tracker position payload")
            index = event["m_firstUnitIndex"]
            for offset in range(0, len(event["m_items"]), 3):
                delta, x, y = event["m_items"][offset:offset + 3]
                index += delta
                unit_tag = active_index.get(index)
                unit = live.get(unit_tag)
                if unit is None:
                    position_updates.append({**stamp, "unit_index": index, "position": [x, y], "unresolved": True})
                    continue
                unit["position"], unit["position_game_loop"] = [x, y], loop
                if unit["owner_player_id"] in players:
                    position_updates.append({**stamp, "unit_tag": unit_tag, "type": unit["type"],
                                             "owner_player_id": unit["owner_player_id"], "position": [x, y]})
        elif kind == "SUpgradeEvent" and event["m_playerId"] in players:
            events.append({**stamp, "event": kind, "owner_player_id": event["m_playerId"],
                           "type": _text(event["m_upgradeTypeName"]), "count": event["m_count"],
                           "meaning": "initial_upgrade_or_cosmetic" if loop == 0 else "upgrade_completed"})
    require(all(initial_workers[player] == 8 for player in players), "Both players must start with eight workers")
    while next_minute <= end:
        minutes.append(snapshot(next_minute, live, players, last_stats, lps))
        next_minute += round(60 * lps)
    final_inventory = snapshot(end, live, players, last_stats, lps)
    require(all(end - last_stats_loop.get(player, -10000) <= 16 * lps for player in players), "Missing final stats")

    # Keep exact issued commands for the entire game without guessing semantics
    # from old ability dictionaries. Target coordinates are protocol fixed point.
    commands, leaves, cameras = [], [], Counter()
    for event in game:
        kind = event["_event"].rsplit(".", 1)[-1]
        player = user_to_player.get(event.get("_userid", {}).get("m_userId"))
        if kind == "SCmdEvent" and player == own:
            row = {**timestamp(event["_gameloop"], lps), "ability": clean(event.get("m_abil")),
                   "target_raw": clean(event["m_data"]), "sequence": event.get("m_sequence"),
                   "flags": event.get("m_cmdFlags"), "success": "issued_only_not_success_verified"}
            target = event["m_data"].get("TargetPoint")
            if target:
                row["target_world_xy"] = [target["x"] / 4096, target["y"] / 4096]
            commands.append(row)
        elif kind == "SGameUserLeaveEvent":
            leaves.append({**timestamp(event["_gameloop"], lps), "player_id": player,
                           "leave_reason": event.get("m_leaveReason")})
        elif kind == "SCameraUpdateEvent" and player == own:
            cameras["own_camera_updates"] += 1

    # Fixed 30-second review windows, not inferred battle boundaries. Per-player
    # deltas retain economy/technology loss separately; no guessed unit costs.
    windows = defaultdict(lambda: {"deaths": [], "stats_deltas": []})
    for event in events:
        if event["event"] == "SUnitDiedEvent" and not event.get("unresolved"):
            windows[int(event["seconds"] // 30)]["deaths"].append(event)
    previous = {}
    for row in stats:
        player = row["player_id"]
        before = previous.get(player)
        previous[player] = row
        if before is None:
            continue
        deltas = {key: value - before["raw_stats"].get(key, value)
                  for key, value in row["raw_stats"].items()
                  if any(token in key for token in ("Lost", "Killed", "FriendlyFire"))}
        if any(deltas.values()):
            windows[int(row["seconds"] // 30)]["stats_deltas"].append({
                "player_id": player, "interval_start_seconds": before["seconds"],
                "interval_end_seconds": row["seconds"], "raw_cumulative_deltas": deltas})
    loss_windows = [{"start_seconds": index * 30, "end_seconds": min((index + 1) * 30, end / lps),
                     **data} for index, data in sorted(windows.items())]
    require(sha(path) == replay_id, "Source replay changed during review")
    return {"schema": 1, "scope": SCOPE, "activation": "Review only; not loaded by a coach or learner",
            "replay_id": replay_id, "source_path": str(path), "source_sha256": replay_id,
            "partition": "train", "site_build_label": candidate["site_build_label"],
            "opponent_site_label": candidate["opponent_site_label"], "map": candidate["map"],
            "matchup": candidate["matchup"], "selected_player_id": own, "players": list(players.values()),
            "protocol": {"base_build": 97563, "path": str(protocol_path), "sha256": sha(protocol_path)},
            "initial_workers": dict(initial_workers), "loops_per_second": lps,
            "coverage": {"header_end_game_loop": end, "duration_seconds": end / lps,
                         "game_stream_end_game_loop": game_end, "tracker_end_game_loop": tracker[-1]["_gameloop"],
                         "tracker_events": len(tracker), "game_events": len(game), "both_streams_decoded_to_eof": True,
                         "final_stats_game_loop_by_player": last_stats_loop, "user_leave_events": leaves,
                         "own_camera_update_count": cameras["own_camera_updates"], "visible_playback_review": "separate_pending"},
            "limitations": [
                "Complete stream decoding is not a claim of visible full-replay playback or game-state simulation.",
                "All tracker-derived data is omniscient offline evidence. Opponent events do not establish what ReSpOnSe saw.",
                "Unit births/done/upgrades are completions, not issued-command times. Init events mark on-map initialization.",
                "Tracker positions are sparse integer coordinates, often for recently damaged units; never continuous paths or pixel-exact wall coordinates.",
                "Resource collection rates retain engine score units; this file does not integrate them into total income.",
                "Unit deaths include consumed morph intermediates, expiration and cancellations; use killer fields and score deltas before calling them combat losses.",
                "Only explicit creator-ability Hallucination flags are excluded from real inventories; absence of that flag is not a universal hallucination detector.",
                "Initial cosmetic/beacon records are preserved in inventories, not silently presented as army. Form changes set completion except named intermediates.",
                "Supply score values are decoded from 4096 fixed point. No old-patch unit-cost table is used.",
                "Raw own commands have exact timestamps but no success or unit-selection inference; ability link/index names need separately verified anchors.",
            ], "player_stats_intervals": stats, "unit_and_upgrade_events": events,
            "sparse_position_updates": position_updates, "minute_inventories": minutes,
            "final_inventory": final_inventory, "base_placements": base_placements,
            "own_building_initializations": own_buildings, "combat_loss_review_windows": loss_windows,
            "own_issued_commands": commands}


def main():
    source_hashes = {str(path): sha(path) for path in (LIBRARY, SPLIT, CORPUS)}
    library, split, corpus = read(LIBRARY), read(SPLIT), read(CORPUS)
    train = {row["replay_id"] for row in split["train_replay_ids"]}
    validation = {row["replay_id"] for row in split["validation_replay_ids"]}
    require(not train & validation, "Whole-replay split overlaps")
    candidates = library["protoss_candidates"]
    require(len(candidates) == 7 and len({c["replay_id"] for c in candidates}) == 7, "Expected seven exemplars")
    records = {row["replay_id"]: row for row in corpus["replays"]}
    for candidate in candidates:
        require(candidate["replay_id"] in train and candidate["replay_id"] not in validation,
                "Candidate is not exclusively TRAIN")
        require(candidate["partition"] == "train" and candidate["starting_workers"] == 8, "Ineligible candidate")
    protocol, protocol_path = exact_protocol()
    OUTPUT.mkdir(parents=True, exist_ok=True)
    rows = []
    checked_inventory_frames = 0
    for candidate in candidates:
        artifact = review(candidate, records[candidate["replay_id"]], protocol, protocol_path)
        # Independent prior trajectory extraction provides a useful regression
        # check of lifecycle/morph/hallucination bookkeeping at shared moments.
        selected = str(artifact["selected_player_id"])
        allowed = frozenset((*OWN_TYPE_NAMES, "OBSERVERSIEGEMODE"))
        frames = {frame["seconds"]: frame for frame in artifact["minute_inventories"]}
        for expected in candidate["completed_alive_counts"]:
            if expected["seconds"] not in frames:
                continue
            actual = {name.upper(): count for name, count in frames[expected["seconds"]]["players"][selected]
                      ["completed_alive_counts"].items() if name.upper() in allowed}
            require(actual == {name: count for name, count in expected["counts"].items() if count},
                    "Full replay inventory disagrees with prior verified trajectory")
            checked_inventory_frames += 1
        target = OUTPUT / (candidate["replay_id"][:12] + ".json")
        write(target, artifact)
        row = {key: artifact[key] for key in ("replay_id", "site_build_label", "matchup", "map", "coverage", "initial_workers")}
        row.update(path=str(target), sha256=sha(target), own_issued_commands=len(artifact["own_issued_commands"]))
        rows.append(row)
        print(json.dumps({"artifact": target.name, "seconds": artifact["coverage"]["duration_seconds"],
                          "tracker_events": artifact["coverage"]["tracker_events"], "train_only": True}), flush=True)
    require(all(sha(path) == digest for path, digest in source_hashes.items()), "Input manifests changed during review")
    manifest = {"schema": 1, "created_at": datetime.now(timezone.utc).isoformat(), "scope": SCOPE,
                "script": {"path": str(Path(__file__).resolve()), "sha256": sha(__file__)},
                "sources": [{"path": path, "sha256": digest} for path, digest in source_hashes.items()],
                "train_replays": len(train), "validation_replays": len(validation), "heldout_overlap": 0,
                "prior_trajectory_inventory_checkpoints_matched": checked_inventory_frames,
                "reviewed_full_streams": len(rows), "corpus_and_models_modified": False, "replays": rows}
    write(OUTPUT / "manifest.json", manifest)


if __name__ == "__main__":
    main()
