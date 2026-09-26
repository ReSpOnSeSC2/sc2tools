"""Independently rederive every own-HUD sidecar from immutable real archives."""
from __future__ import annotations

import argparse
from bisect import bisect_left
from collections import Counter
import hashlib
import importlib.util
import io
import json
from pathlib import Path
import time

import mpyq
import s2protocol

ROOT = Path(__file__).resolve().parents[1]
SEQUENCE_SHA = "8cb5ac66b182e71cc2000b13503198d939be5f15e9b2904977cbee9e44685034"
MANIFEST_SHA = "350474426493bcb869baf8f82302aaf7b424c96da666188b143db70ed39c42b2"
PROTOCOL_SHA = "2941e39e970c21bfa7bb9c5c6d340c09366a5743f223b516fe19443f67c578e5"


def sha(path):
    return hashlib.sha256(Path(path).read_bytes()).hexdigest()


def canonical(value):
    return hashlib.sha256(json.dumps(value, sort_keys=True, separators=(",", ":"), allow_nan=False).encode()).hexdigest()


def require(condition, message):
    if not condition:
        raise ValueError(message)


def independent_index(events, player, race):
    groups = {}
    previous = -1
    fields = {"minerals": "m_scoreValueMineralsCurrent", "vespene": "m_scoreValueVespeneCurrent"}
    if race == "Protoss":
        fields["supply_used_raw4096"] = "m_scoreValueFoodUsed"
    for event in events:
        loop = event["_gameloop"]
        require(type(loop) is int and loop >= previous, "Unordered tracker event")
        previous = loop
        if event["_event"] != "NNet.Replay.Tracker.SPlayerStatsEvent" or event["m_playerId"] != player:
            continue
        values = {key: event["m_stats"].get(raw) for key, raw in fields.items()}
        errors = sorted(key for key, value in values.items() if type(value) is not int or value < 0)
        if loop in groups:
            saved = groups[loop]
            saved["duplicate_count"] += 1
            saved["ambiguous"] |= values != saved["values"] or errors != saved["invalid_fields"]
        else:
            groups[loop] = {"sample_loop": loop, "player_id": player, "values": values,
                            "invalid_fields": errors, "ambiguous": False, "duplicate_count": 1}
    return list(groups.values())


def independent_row(sequence, target_index, samples):
    target = sequence["events"][target_index]
    earlier = [command for command in sequence["events"][:target_index] if command["game_loop"] < target["game_loop"]]
    anchor = earlier[-1] if earlier else None
    binding = {"target_source_event_index": target["ordinal"], "target_game_loop": target["game_loop"],
        "target_command_sha256": canonical(target),
        "previous_own_macro_anchor_loop": anchor["game_loop"] if anchor else None,
        "previous_own_macro_anchor_source_event_index": anchor["ordinal"] if anchor else None,
        "previous_own_macro_anchor_command_sha256": canonical(anchor) if anchor else None,
        "sample_loop": None, "sample_player_id": None, "sample_duplicate_count": None, "sample_projection_sha256": None}
    features = dict(minerals=None, vespene=None, supply_used=None, bank_known=False,
                    supply_used_known=False, age_seconds=None)
    reason = "no_strictly_previous_own_macro_command"
    if anchor:
        offset = bisect_left([sample["sample_loop"] for sample in samples], anchor["game_loop"]) - 1
        reason = "no_own_stats_strictly_before_anchor"
        if offset >= 0:
            sample = samples[offset]
            require(sample["player_id"] == sequence["player_id"]
                    and sample["sample_loop"] < anchor["game_loop"] < target["game_loop"], "Causal/player boundary crossed")
            binding.update(sample_loop=sample["sample_loop"], sample_player_id=sample["player_id"],
                           sample_duplicate_count=sample["duplicate_count"], sample_projection_sha256=canonical(sample))
            reason = "ambiguous_same_loop_own_stats" if sample["ambiguous"] else "invalid_latest_own_stats"
            if not sample["ambiguous"] and not sample["invalid_fields"]:
                features.update(minerals=sample["values"]["minerals"], vespene=sample["values"]["vespene"],
                                bank_known=True, age_seconds=(anchor["game_loop"] - sample["sample_loop"]) / 22.4)
                if sequence["race"] == "Protoss":
                    features.update(supply_used=sample["values"]["supply_used_raw4096"] / 4096., supply_used_known=True)
                reason = None
    return {"schema": "own-hud-at-previous-command-v1", "replay_id": sequence["replay_id"],
        "player_id": sequence["player_id"], "target_source_event_index": target["ordinal"],
        "race_metadata": sequence["race"], "partition_metadata": sequence["partition"],
        "binding": binding, "features": features, "missing_reason": reason}


def run(args):
    start = time.monotonic()
    directory, destination = Path(args.sidecar).resolve(), Path(args.output).resolve()
    dataset = ROOT / "runs/player-expansion-contract-review-v1/scoped619-v1/sequences-v2"
    require(not destination.exists(), "Independent report must be new")
    def check():
        require(time.monotonic() - start <= 600, "Read-only600s wall cap")
        require(not any(p.exists() for p in (ROOT / "STOP", directory / "STOP", directory.parent / "STOP",
                                            destination.parent / "STOP", dataset / "STOP")), "STOP respected")
    check()
    report_path = directory / "result.json"
    receipt = json.loads(report_path.read_bytes())
    require(receipt.get("schema") == "own-hud-sidecar-extraction-v1" and receipt.get("status") == "complete"
            and receipt.get("eligible_for_training") is True and receipt.get("source_inputs_unchanged") is True
            and receipt.get("all_originals_unchanged") is True and receipt.get("errors") == []
            and receipt.get("optimizer_updates") == 0 and receipt.get("sc2_engines_started") == 0,
            "Extraction not eligible for independent review")
    pins = dict(receipt["source_and_input_hashes"])
    pins.update(receipt["original_archive_hashes"])
    pins[str(report_path)] = sha(report_path)
    pins[str(Path(__file__).resolve())] = sha(__file__)
    for name in ("sidecar", "perspectives"):
        path = directory / (name + ".jsonl")
        require(sha(path) == receipt[name + "_sha256"], "Emitted output hash changed")
        pins[str(path)] = sha(path)
    require(all(sha(p) == digest for p, digest in pins.items()), "Pinned input changed before review")
    require(sha(dataset / "sequences.jsonl") == SEQUENCE_SHA and sha(dataset.parent / "manifest.json") == MANIFEST_SHA,
            "Original immutable cohort changed")
    sequences = {(r["replay_id"], r["player_id"]): r for r in map(json.loads, (dataset / "sequences.jsonl").read_bytes().splitlines())}
    manifest = json.loads((dataset.parent / "manifest.json").read_bytes())
    source_rows = {(r["replay_id"], r["player_id"]): r for r in manifest["perspectives"]}
    views = [json.loads(line) for line in (directory / "perspectives.jsonl").read_bytes().splitlines()]
    require(len(views) == len(sequences) == len(source_rows) == 1238
            and len(manifest["fixed_partitions"]) == 620
            and len(receipt["original_archive_hashes"]) == 619, "Coverage/split cardinality changed")
    proto_path = Path(s2protocol.__file__).parent / "versions/protocol97563.py"
    require(sha(proto_path) == PROTOCOL_SHA, "Exact protocol changed")
    spec = importlib.util.spec_from_file_location("independent_own_hud_97563", proto_path)
    protocol = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(protocol)
    count = 0
    seen = set()
    decoded = set()
    counts = Counter()
    prior_id, tracker, tracker_bytes = None, None, None
    with (directory / "sidecar.jsonl").open(encoding="utf-8") as stream:
        for view in views:
            check()
            identity = (view["replay_id"], view["player_id"])
            require(identity not in seen and identity in sequences, "Duplicated or unrecognized own perspective")
            seen.add(identity)
            sequence, metadata = sequences[identity], source_rows[identity]
            if identity[0] != prior_id:
                require(identity[0] not in decoded, "Replay perspectives are not grouped in original order")
                decoded.add(identity[0])
                original = Path(metadata["path"]).read_bytes()
                require(hashlib.sha256(original).hexdigest() == identity[0], "Original replay changed")
                archive = mpyq.MPQArchive(io.BytesIO(original))
                header = protocol.decode_replay_header(archive.header["user_data_header"]["content"])
                require(header["m_version"]["m_baseBuild"] == 97563, "Archive build changed")
                tracker_bytes = archive.read_file("replay.tracker.events")
                tracker = list(protocol.decode_replay_tracker_events(tracker_bytes))
                require(all(event["_gameloop"] <= header["m_elapsedGameLoops"] for event in tracker), "Tracker beyond replay end")
                prior_id = identity[0]
            samples = independent_index(tracker, identity[1], sequence["race"])
            expected_view = {"replay_id": identity[0], "player_id": identity[1], "race_metadata": sequence["race"],
                "partition_metadata": sequence["partition"], "command_count": len(sequence["events"]),
                "empty_view": not bool(sequence["events"]), "sequence_sha256": canonical(sequence),
                "first_sidecar_line_zero_based": count, "own_stats_count_coalesced": len(samples),
                "own_stats_index_sha256": canonical(samples), "tracker_stream_sha256": hashlib.sha256(tracker_bytes).hexdigest(),
                "source_sha256": identity[0]}
            require(view == expected_view and sequence["partition"] == manifest["fixed_partitions"][identity[0]],
                    "Perspective metadata, original sequence or split changed")
            counts["empty_views"] += int(not sequence["events"])
            for index, _ in enumerate(sequence["events"]):
                check()
                actual = json.loads(stream.readline())
                expected = independent_row(sequence, index, samples)
                require(actual == expected, "Independent raw-archive HUD rederivation disagrees: " + str(identity) + f" index{index}")
                counts["known_bank"] += actual["features"]["bank_known"]
                counts["known_supply"] += actual["features"]["supply_used_known"]
                counts[actual["missing_reason"] or "known"] += 1
                count += 1
            if len(seen) % 200 == 0:
                print(json.dumps({"perspectives_verified": len(seen), "rows_verified": count}), flush=True)
        require(stream.read() == "", "Extra sidecar target rows")
    require(count == 152312 and len(seen) == 1238 and len(decoded) == 619 and counts["empty_views"] == 2,
            "Not all original targets/empty views verified")
    require(counts["known_bank"] == receipt["coverage"]["bank_known"]
            and counts["known_supply"] == receipt["coverage"]["supply_used_known"], "Coverage summary changed")
    require(all(sha(p) == digest for p, digest in pins.items()), "Pinned input changed during review")
    report = {"schema": "independent-own-hud-sidecar-review-v1", "status": "passed", "source_inputs_unchanged": True,
        "original_archives_redecoded": len(decoded), "perspectives_verified": len(seen), "target_rows_rederived_exactly": count,
        "all_1238_view_rows_exact": True, "all_target_and_anchor_bindings_exact": True,
        "strict_sample_before_anchor_before_target_verified": True, "own_player_only_verified": True,
        "FoodMade_or_opponent_fields_projected": False, "original_sequences_and_fixed_split_unchanged": True,
        "coverage": dict(counts), "source_and_input_hashes": pins, "optimizer_updates": 0, "sc2_engines_started": 0,
        "limits": "Stale own HUD, not current affordability or native policy strength; no model trained by this review",
        "wall_seconds": time.monotonic() - start}
    destination.parent.mkdir(parents=True, exist_ok=True)
    with destination.open("x", encoding="utf-8") as stream:
        json.dump(report, stream, indent=2, allow_nan=False)
        stream.write("\n")
    print(json.dumps({"status": "passed", "rows": count, "wall_seconds": report["wall_seconds"]}))


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--sidecar", required=True)
    parser.add_argument("--output", required=True)
    run(parser.parse_args())
