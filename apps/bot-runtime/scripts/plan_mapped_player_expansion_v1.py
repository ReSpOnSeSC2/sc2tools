"""Plan incremental fog-safe player capture from completed website mappings.

Never relabel a spectator cache as actor observations, launch SC2, or mutate the
mapper queue. Each plan pins its inputs and the original whole-replay split.
"""
from __future__ import annotations

import argparse
from collections import defaultdict
from datetime import datetime, timezone
import hashlib
import json
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
MANIFEST_SHA = "350474426493bcb869baf8f82302aaf7b424c96da666188b143db70ed39c42b2"


def digest(path):
    with Path(path).open("rb") as stream:
        return hashlib.file_digest(stream, "sha256").hexdigest()


def candidates(manifest, progress, *, check_original=digest):
    """Membership is an immutable completion receipt, never a training label."""
    complete = {r["replay_id"]: r for r in progress["replays"] if r.get("capture_complete") is True}
    rows, checked = [], set()
    for row in manifest["perspectives"]:
        rid = row["replay_id"]
        if rid not in complete:
            continue
        if (row["partition"] != manifest["fixed_partitions"][rid]
                or row["start_workers"] != 8 or row["base_build"] != 97563
                or row["matchup"] not in {"PvT", "PvP", "PvZ", "TvP", "ZvP"}):
            raise ValueError("Original replay scope/start/split changed")
        if rid not in checked:
            if check_original(row["path"]) != rid:
                raise ValueError("Original replay hash changed")
            checked.add(rid)
        rows.append({key: row[key] for key in (
            "replay_id", "path", "player_id", "race", "matchup", "partition", "start_workers",
            "base_build", "data_version", "game_loops", "training_sampling_weight", "evaluation_weight")})
    return sorted(rows, key=lambda r: (r["partition"], r["matchup"], r["game_loops"], r["replay_id"], r["player_id"]))


def main(args):
    output = Path(args.output).resolve()
    if output.exists():
        raise FileExistsError("Require a new immutable plan directory")
    if (ROOT / "STOP").exists():
        raise InterruptedError("STOP respected")
    manifest_path = ROOT / "runs/player-expansion-contract-review-v1/scoped619-v1/manifest.json"
    progress_path = ROOT / "runs/replay-expansion-inventory-v1/progress-current.json"
    if digest(manifest_path) != MANIFEST_SHA:
        raise ValueError("Original partitioned corpus changed")
    progress_bytes = progress_path.read_bytes()
    progress = json.loads(progress_bytes)
    manifest = json.loads(manifest_path.read_bytes())
    rows = candidates(manifest, progress)
    grouped = defaultdict(list)
    for row in rows:
        grouped[(row["race"], row["matchup"], row["partition"])].append(row)
    initial = []
    for matchup in ("PvT", "PvP", "PvZ"):
        for partition in ("train", "validation"):
            choices = grouped[("Protoss", matchup, partition)]
            if choices:
                initial.append(choices[0])
    baseline_dir = ROOT / "runs/alphastar-rich-pilot-v3"
    baseline = json.loads((baseline_dir / "capture.json").read_text())
    expected_original = baseline["replay"]["replay_id"]
    if (baseline["status"] != "captured_full_replay" or baseline["partition"] != "train"
            or baseline["engine_start_workers"] != 8
            or manifest["fixed_partitions"][expected_original] != "train"):
        raise ValueError("Existing player capture identity changed")
    pins = {str(manifest_path): digest(manifest_path), str(Path(__file__).resolve()): digest(__file__)}
    baseline_pins = {name: digest(baseline_dir / name) for name in (
        "capture.json", "frames.jsonl.gz", "actions.jsonl.gz", "game-data.json", "game-info.json")}
    report = {
        "schema": "mapped-original-player-capture-plan-v1", "created_at": datetime.now(timezone.utc).isoformat(),
        "status": "planned_actual_player_capture_required", "executable": False,
        "completed_website_mappings_observed": progress["counts"]["complete_matching_local_capture"],
        "mapping_observed_at": progress["observed_at"],
        "completed_originals_in_scope": len({r["replay_id"] for r in rows}), "candidate_player_views": len(rows),
        "by_race_matchup_partition": {"/".join(key): len(value) for key, value in sorted(grouped.items())},
        "candidates": rows, "first_balanced_protoss_capture_batch": initial,
        "all_original_partitions": manifest["fixed_partitions"],
        "source_and_input_hashes": pins,
        "mapping_progress_snapshot_sha256": hashlib.sha256(progress_bytes).hexdigest(),
        "website_cache_actor_eligible": False,
        "website_cache_reason": "Exporter disables fog and merges owner passes; lacks causal player camera/UI/visibility state",
        "reuse": "Original replay archives, completed website playback caches and immutable metadata remain preserved",
        "existing_player_capture": {"directory": str(baseline_dir), "replay_id": expected_original,
            "player_id": baseline["player_id"], "partition": "train", "artifact_hashes": baseline_pins,
            "role": "Already-used single PvT TRAIN diagnostic, not new validation or additional game",
            "reuse_requires": "Existing derived action/tensor provenance and every-row admission checks"},
        "new_training_views_admitted": 0, "optimizer_updates": 0, "native_launches": 0,
        "capture_contract": {"disable_fog": False, "start_workers": 8,
            "Protoss": "actual player camera, UI/spatial-selection history and fog-visible entities",
            "Terran_Zerg": "separate adapter: own units and currently visible enemies; fog; no spectator substitution",
            "labels_are_not_actor_inputs": True, "no_forward_fill_of_visibility": True},
        "next_gates": [
            "Lossless serialized engine ownership handoff without disrupting active mapper",
            "Actual no-foreground native compatibility proof, not just launcher unit tests",
            "Exact replay/version/player plus initial eight workers and full capture completeness",
            "Player camera/visibility/UI and causal action alignment verified per replay",
            "Versioned tensor/action-mask admission preserving whole-original split",
            "Incremental training snapshots; repeated TRAIN passes, unweighted held-out evaluation"],
        "standing_user_authorization": "Add verified player perspectives incrementally and train continuously until told to stop",
        "never_admit": ["fog-disabled website views as actor frames", "mock replay/engine data", "fabricated wins"],
    }
    assert all(digest(path) == value for path, value in pins.items())
    output.mkdir(parents=True)
    (output / "mapping-progress-snapshot.json").write_bytes(progress_bytes)
    with (output / "plan.json").open("x", encoding="utf-8") as stream:
        json.dump(report, stream, indent=2, allow_nan=False)
        stream.write("\n")
    print(json.dumps({key: report[key] for key in ("status", "completed_originals_in_scope",
        "candidate_player_views", "new_training_views_admitted", "native_launches")}))


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--output", required=True)
    main(parser.parse_args())
