"""Bounded, real-archive own-HUD sidecars; no engine, model, or label rewrite."""
from __future__ import annotations

import argparse
from collections import Counter, defaultdict
from datetime import datetime, timezone
import hashlib
import importlib.util
import io
import json
import os
from pathlib import Path
import sys
import time

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "src"))

from pluto_sc2 import own_hud_features_v1 as hud  # noqa: E402
from pluto_sc2.replays import _player_name  # noqa: E402

MANIFEST_SHA = "350474426493bcb869baf8f82302aaf7b424c96da666188b143db70ed39c42b2"
SEQUENCES_SHA = "8cb5ac66b182e71cc2000b13503198d939be5f15e9b2904977cbee9e44685034"
RESULT_SHA = "8d9d1e167f578a6e5633fec0288ba3c18322525bab5c8392ac1f0ac277b79e53"
READINESS_SHA = "e480cb80b61c723df5596eba69bd263556baef479675ad386c1ccf6d81ffed1c"
PROTOCOL_SHA = "2941e39e970c21bfa7bb9c5c6d340c09366a5743f223b516fe19443f67c578e5"
DATASET = ROOT / "runs/player-expansion-contract-review-v1/scoped619-v1/sequences-v2"
READINESS = ROOT / "runs/own-hud-feature-audit-v1/readiness.json"
ALLOWED_MATCHUPS = {"Protoss": {"PvT", "PvP", "PvZ"}, "Terran": {"TvP"}, "Zerg": {"ZvP"}}
RESULT_SCHEMA = "own-hud-sidecar-extraction-v1"


def digest(data):
    return hashlib.sha256(data).hexdigest()


def pin_bytes(path, expected=None):
    data = Path(path).read_bytes()
    actual = digest(data)
    if expected is not None and actual != expected:
        raise ValueError(f"Pinned input changed: {path}")
    return data, actual


def add_pin(pins, path, expected=None):
    path = Path(path).resolve()
    data, value = pin_bytes(path, expected)
    if str(path) in pins and pins[str(path)] != value:
        raise ValueError(f"Input changed during setup: {path}")
    pins[str(path)] = value
    return data


def unchanged(pins):
    return all(Path(path).is_file() and digest(Path(path).read_bytes()) == value for path, value in pins.items())


def load_source(dataset=DATASET, readiness=READINESS):
    """This v1 admits exactly the reviewed real 619-archive corpus."""
    dataset = Path(dataset).resolve()
    pins = {}
    receipt = json.loads(add_pin(pins, dataset / "result.json", RESULT_SHA))
    source_bytes = add_pin(pins, dataset / "sequences.jsonl", SEQUENCES_SHA)
    if (receipt.get("status") != "complete" or receipt.get("source_unchanged") is not True
            or receipt.get("all_originals_unchanged") is not True or receipt.get("errors") != []
            or receipt.get("sequences_sha256") != SEQUENCES_SHA
            or receipt.get("source_manifest_sha256") != MANIFEST_SHA
            or receipt.get("extraction_contract") != "own-macro-attempt-sequences-empty-views-v2"):
        raise ValueError("Incomplete or incompatible original sequence extraction")
    manifest_path = Path(receipt["source_manifest"])
    if not manifest_path.is_absolute():
        raise ValueError("Manifest must be pinned by absolute path")
    manifest = json.loads(add_pin(pins, manifest_path, MANIFEST_SHA))
    readiness_record = json.loads(add_pin(pins, readiness, READINESS_SHA))
    if (readiness_record.get("source_inputs_unchanged") is not True
            or readiness_record.get("status") != "audited_ready_for_versioned_partial_feature_extraction"):
        raise ValueError("Readiness audit is not complete")
    for path, expected in readiness_record["source_and_input_hashes"].items():
        add_pin(pins, path, expected)
    rows = [json.loads(line) for line in source_bytes.splitlines() if line]
    sequences = {(r["replay_id"], r["player_id"]): r for r in rows}
    expected = {(r["replay_id"], r["player_id"]): r for r in manifest["perspectives"]}
    if (len(rows) != 1238 or len(sequences) != 1238 or len(expected) != 1238
            or set(sequences) != set(expected) or len(manifest["fixed_partitions"]) != 620
            or len(set(manifest["selected_original_ids"])) != 619):
        raise ValueError("Exact original perspective/split coverage changed")
    grouped = defaultdict(list)
    for key, row in sequences.items():
        metadata = expected[key]
        for field in ("race", "matchup", "partition", "training_sampling_weight", "evaluation_weight"):
            if row[field] != metadata[field]:
                raise ValueError(f"Original perspective metadata changed: {key}/{field}")
        if (row["partition"] != manifest["fixed_partitions"][row["replay_id"]]
                or row["matchup"] not in ALLOWED_MATCHUPS.get(row["race"], set())
                or row["evaluation_weight"] != 1 or metadata["start_workers"] != 8
                or metadata["base_build"] != 97563 or metadata["game_speed"] != "Faster"):
            raise ValueError("Original split, scope, or eight-worker replay contract changed")
        hud.validate_commands(row)
        grouped[row["replay_id"]].append(metadata)
    if (len(grouped) != 619 or set(grouped) != set(manifest["selected_original_ids"])
            or sum(len(r["events"]) for r in rows) != 152312):
        raise ValueError("Original command/replay coverage changed")
    empty = {(r["replay_id"], r["player_id"]) for r in receipt["empty_perspectives"]}
    if empty != {key for key, row in sequences.items() if not row["events"]} or len(empty) != 2:
        raise ValueError("Original empty-view receipts changed")
    for rid, perspectives in grouped.items():
        if (len(perspectives) != 2 or {r["player_id"] for r in perspectives} != {1, 2}
                or len({r["path"] for r in perspectives}) != 1):
            raise ValueError(f"Original player/path identity changed: {rid}")
    return manifest, sequences, grouped, pins


class Budget:
    def __init__(self, seconds, stops, *, monotonic=time.monotonic):
        if type(seconds) not in (int, float) or not 0 < seconds <= 600:
            raise ValueError("Extraction wall budget must be positive and at most 600 seconds")
        self.clock = monotonic
        self.deadline = monotonic() + seconds
        self.stops = [Path(path) for path in stops]

    def check(self):
        for path in self.stops:
            if path.exists():
                raise InterruptedError(f"STOP respected: {path}")
        if self.clock() >= self.deadline:
            raise TimeoutError("Own-HUD extraction wall bound reached")


def create_output(output):
    output = Path(output).resolve()
    output.mkdir(parents=True, exist_ok=False)
    return output


def atomic_status(output, record):
    temporary = output / "status.json.tmp"
    temporary.write_text(json.dumps(record, indent=2, allow_nan=False) + "\n", encoding="utf-8")
    os.replace(temporary, output / "status.json")


def validate_archive(header, details, perspectives):
    if (header["m_version"]["m_baseBuild"] != 97563 or details["m_gameSpeed"] != 4
            or len(details["m_playerList"]) != 2):
        raise ValueError("Archive protocol/player/speed differs from verified corpus")
    for row in perspectives:
        player = details["m_playerList"][row["player_id"] - 1]
        race = player["m_race"].decode() if isinstance(player["m_race"], bytes) else player["m_race"]
        if (race != row["race"] or _player_name(player["m_name"]).casefold() != row["player_name"].casefold()
                or header["m_elapsedGameLoops"] != row["game_loops"]):
            raise ValueError("Archive exact player identity/race/duration mismatch")


def extract(*, output, dataset=DATASET, readiness=READINESS, max_seconds=600, extra_stops=()):
    import mpyq
    import s2protocol
    import psutil

    started = time.monotonic()
    output = Path(output).resolve()
    budget = Budget(max_seconds, [ROOT / "STOP", output / "STOP", output.parent / "STOP",
                                  Path(dataset) / "STOP", *extra_stops])
    budget.check()
    manifest, sequences, grouped, pins = load_source(dataset, readiness)
    protocol_path = Path(s2protocol.__file__).parent / "versions/protocol97563.py"
    add_pin(pins, protocol_path, PROTOCOL_SHA)
    for path in (Path(__file__), Path(hud.__file__), ROOT / "src/pluto_sc2/replays.py",
                 Path(s2protocol.__file__).parent / "decoders.py", Path(mpyq.__file__)):
        add_pin(pins, path)
    spec = importlib.util.spec_from_file_location("hud_sidecar_exact97563", protocol_path)
    protocol = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(protocol)
    budget.check()
    output = create_output(output)
    report = {"schema": RESULT_SCHEMA, "feature_schema": hud.SCHEMA, "status": "running",
              "started_at": datetime.now(timezone.utc).isoformat(), "pid": os.getpid(),
              "process_create_time": psutil.Process(os.getpid()).create_time(), "max_seconds": max_seconds,
              "originals_requested": 619, "perspectives_requested": 1238, "targets_requested": 152312,
              "originals_verified": 0, "perspectives_written": 0, "targets_written": 0,
              "original_sequence_sha256": SEQUENCES_SHA, "original_manifest_sha256": MANIFEST_SHA,
              "original_result_sha256": RESULT_SHA, "readiness_sha256": READINESS_SHA,
              "fixed_partitions_sha256": hud.canonical_sha(manifest["fixed_partitions"]),
              "source_and_input_hashes": pins, "original_archive_hashes": {}, "errors": [],
              "eligible_for_training": False, "models_trained": False, "optimizer_updates": 0,
              "sc2_engines_started": 0, "native_actor_connected": False,
              "current_affordability_or_legality_claimed": False,
              "actor_feature_fields": sorted(hud.FEATURE_FIELDS),
              "encoder": {"dimensions": 8, "order": ["log1p_minerals/log5001", "log1p_vespene/log5001",
                  "protoss_supply_used/200", "log1p_age_seconds/log61", "bank_known", "bank_known",
                  "supply_used_known", "any_allowed_value_known"], "static_scaling": True,
                  "all_missing_is_exact_zero": True},
              "join_contract": "S < previous-own-macro-anchor A < target T; same-loop siblings skipped",
              "excluded_fields": ["FoodMade", "opponent state", "future statistics", "target time as actor input"],
              "source_command_labels_rewritten": False}
    atomic_status(output, report)
    coverage, group_coverage, age_loops = Counter(), defaultdict(Counter), Counter()
    failure = None
    try:
        with (output / "sidecar.jsonl").open("x", encoding="utf-8", newline="\n") as sidecars, \
                (output / "perspectives.jsonl").open("x", encoding="utf-8", newline="\n") as views:
            for rid, perspectives in sorted(grouped.items()):
                budget.check()
                path = Path(perspectives[0]["path"]).resolve()
                original, original_hash = pin_bytes(path, rid)
                archive = mpyq.MPQArchive(io.BytesIO(original))
                header = protocol.decode_replay_header(archive.header["user_data_header"]["content"])
                details = protocol.decode_replay_details(archive.read_file("replay.details"))
                validate_archive(header, details, perspectives)
                tracker_bytes = archive.read_file("replay.tracker.events")
                tracker_events = list(protocol.decode_replay_tracker_events(tracker_bytes))
                if any(event["_gameloop"] > header["m_elapsedGameLoops"] for event in tracker_events):
                    raise ValueError("Tracker event occurs beyond original replay duration")
                budget.check()
                for metadata in sorted(perspectives, key=lambda row: row["player_id"]):
                    key = (rid, metadata["player_id"])
                    sequence = sequences[key]
                    stats = hud.index_own_stats(tracker_events, player_id=key[1], race=metadata["race"])
                    stats_sha = hud.canonical_sha(stats)
                    view = {"replay_id": rid, "player_id": key[1], "race_metadata": metadata["race"],
                            "partition_metadata": metadata["partition"], "command_count": len(sequence["events"]),
                            "empty_view": not bool(sequence["events"]), "sequence_sha256": hud.canonical_sha(sequence),
                            "first_sidecar_line_zero_based": report["targets_written"],
                            "own_stats_count_coalesced": len(stats), "own_stats_index_sha256": stats_sha,
                            "tracker_stream_sha256": digest(tracker_bytes), "source_sha256": original_hash}
                    for index, command in enumerate(sequence["events"]):
                        budget.check()
                        row = hud.make_sidecar(sequence, index, stats)
                        hud.encode_actor_features(row)
                        sidecars.write(json.dumps(row, separators=(",", ":"), allow_nan=False) + "\n")
                        report["targets_written"] += 1
                        scopes = [f"{metadata['partition']}/{metadata['race']}/all"]
                        if command["game_loop"] <= 480 * 22.4:
                            scopes.append(f"{metadata['partition']}/{metadata['race']}/480s")
                        for counts in (coverage, *(group_coverage[scope] for scope in scopes)):
                            counts["targets"] += 1
                            counts["bank_known"] += row["features"]["bank_known"]
                            counts["supply_used_known"] += row["features"]["supply_used_known"]
                            if row["missing_reason"]:
                                counts[row["missing_reason"]] += 1
                        if row["features"]["bank_known"]:
                            binding = row["binding"]
                            age_loops[binding["previous_own_macro_anchor_loop"] - binding["sample_loop"]] += 1
                    views.write(json.dumps(view, separators=(",", ":"), allow_nan=False) + "\n")
                    report["perspectives_written"] += 1
                pin_bytes(path, rid)
                report["original_archive_hashes"][str(path)] = rid
                report["originals_verified"] += 1
                if report["originals_verified"] % 50 == 0:
                    sidecars.flush()
                    views.flush()
                    report["wall_seconds"] = time.monotonic() - started
                    atomic_status(output, report)
                    print(json.dumps({key: report[key] for key in ("originals_verified", "targets_written", "wall_seconds")}), flush=True)
        budget.check()
        if (report["originals_verified"], report["perspectives_written"], report["targets_written"]) != (619, 1238, 152312):
            raise ValueError("Derivative coverage is incomplete")
        report.update(status="complete", eligible_for_training=True)
    except BaseException as exc:
        failure = exc
        report.update(status="stopped_at_bound" if isinstance(exc, (InterruptedError, TimeoutError)) else "failed",
                      eligible_for_training=False, errors=[repr(exc)])
    finally:
        # No more extraction after STOP. Final receipts/hashes are permitted cleanup.
        report["source_inputs_unchanged"] = unchanged(pins)
        report["all_originals_unchanged"] = unchanged(report["original_archive_hashes"])
        if not report["source_inputs_unchanged"] or not report["all_originals_unchanged"]:
            report.update(status="failed", eligible_for_training=False)
            report["errors"].append("Pinned source/original mutation detected")
            failure = failure or ValueError("Pinned source/original mutation detected")
        report.update(coverage=dict(coverage), coverage_by_partition_race_horizon=dict(group_coverage),
                      age_at_anchor_loop_histogram=dict(age_loops), wall_seconds=time.monotonic() - started,
                      finished_at=datetime.now(timezone.utc).isoformat())
        for name in ("sidecar.jsonl", "perspectives.jsonl"):
            if (output / name).is_file():
                report[name.replace(".jsonl", "_sha256")] = digest((output / name).read_bytes())
        (output / "result.json").write_text(json.dumps(report, indent=2, allow_nan=False) + "\n", encoding="utf-8")
        atomic_status(output, report)
    if failure:
        raise failure
    return report


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--output", type=Path, required=True)
    parser.add_argument("--dataset", type=Path, default=DATASET)
    parser.add_argument("--readiness", type=Path, default=READINESS)
    parser.add_argument("--max-seconds", type=float, default=600)
    parser.add_argument("--stop-file", action="append", type=Path, default=[])
    args = parser.parse_args(argv)
    result = extract(output=args.output, dataset=args.dataset, readiness=args.readiness,
                     max_seconds=args.max_seconds, extra_stops=args.stop_file)
    print(json.dumps({key: result[key] for key in ("status", "originals_verified", "targets_written", "wall_seconds")}))


if __name__ == "__main__":
    main()
