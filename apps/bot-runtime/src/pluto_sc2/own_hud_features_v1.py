"""Conservative own-player replay HUD sidecars, never current legality masks.

Only the ``features`` allowlist is an actor input candidate. Identity, target
timestamps, hashes, race, partition and sample provenance are audit metadata.
"""
from __future__ import annotations

from bisect import bisect_left
import hashlib
import json
import math
from pathlib import Path

import numpy as np

SCHEMA = "own-hud-at-previous-command-v1"
FEATURE_FIELDS = frozenset({"minerals", "vespene", "supply_used", "bank_known",
                            "supply_used_known", "age_seconds"})
RAW_FIELDS = {"minerals": "m_scoreValueMineralsCurrent", "vespene": "m_scoreValueVespeneCurrent"}


def canonical_sha(value):
    return hashlib.sha256(json.dumps(value, sort_keys=True, separators=(",", ":"), allow_nan=False).encode()).hexdigest()


def project_stats(event, *, player_id, race):
    """Require own identity; never read FoodMade, enemy statistics or scores."""
    if event.get("_event") != "NNet.Replay.Tracker.SPlayerStatsEvent" or event.get("m_playerId") != player_id:
        raise ValueError("Only matching own-player stats may be projected")
    if race not in ("Protoss", "Terran", "Zerg"):
        raise ValueError("Unsupported own race")
    loop = event.get("_gameloop")
    if type(loop) is not int or loop < 0:
        raise ValueError("Invalid stats game loop")
    stats = event.get("m_stats")
    if not isinstance(stats, dict):
        raise ValueError("Missing native stats dictionary")
    values = {name: stats.get(raw) for name, raw in RAW_FIELDS.items()}
    if race == "Protoss":
        values["supply_used_raw4096"] = stats.get("m_scoreValueFoodUsed")
    invalid = sorted(name for name, value in values.items() if type(value) is not int or value < 0)
    return {"sample_loop": loop, "player_id": player_id, "values": values, "invalid_fields": invalid}


def index_own_stats(tracker_events, *, player_id, race):
    """Equal-loop duplicates are usable only if all allowed values agree."""
    grouped = {}
    previous = -1
    for event in tracker_events:
        loop = event.get("_gameloop")
        if type(loop) is not int or loop < previous:
            raise ValueError("Tracker loops must be ordered")
        previous = loop
        if (event.get("_event") != "NNet.Replay.Tracker.SPlayerStatsEvent"
                or event.get("m_playerId") != player_id):
            continue
        row = project_stats(event, player_id=player_id, race=race)
        if loop not in grouped:
            grouped[loop] = {**row, "ambiguous": False, "duplicate_count": 1}
        else:
            prior = grouped[loop]
            prior["duplicate_count"] += 1
            if prior["values"] != row["values"] or prior["invalid_fields"] != row["invalid_fields"]:
                prior["ambiguous"] = True
    return list(grouped.values())


def previous_anchor(commands, target_index):
    if not 0 <= target_index < len(commands):
        raise ValueError("Target outside the immutable own-command sequence")
    loop = commands[target_index]["game_loop"]
    before = target_index
    while before > 0 and commands[before - 1]["game_loop"] >= loop:
        before -= 1
    return commands[before - 1]["game_loop"] if before else None


def anchor_command(commands, target_index):
    loop = previous_anchor(commands, target_index)
    if loop is None:
        return None
    return next(event for event in reversed(commands[:target_index]) if event["game_loop"] == loop)


def make_sidecar(sequence, target_index, stats_index):
    """Use strict S<A<T; no target-time HUD query, interpolation or backfill."""
    commands = sequence["events"]
    target = commands[target_index]
    anchor = previous_anchor(commands, target_index)
    prior = anchor_command(commands, target_index)
    features = {"minerals": None, "vespene": None, "supply_used": None,
                "bank_known": False, "supply_used_known": False, "age_seconds": None}
    binding = {"target_source_event_index": target["ordinal"], "target_game_loop": target["game_loop"],
               "target_command_sha256": canonical_sha(target), "previous_own_macro_anchor_loop": anchor,
               "previous_own_macro_anchor_source_event_index": prior["ordinal"] if prior else None,
               "previous_own_macro_anchor_command_sha256": canonical_sha(prior) if prior else None,
               "sample_loop": None, "sample_player_id": None, "sample_duplicate_count": None,
               "sample_projection_sha256": None}
    reason = "no_strictly_previous_own_macro_command"
    if anchor is not None:
        if not anchor < target["game_loop"]:
            raise ValueError("Prior-command anchor is not strictly causal")
        loops = [row["sample_loop"] for row in stats_index]
        if loops != sorted(set(loops)):
            raise ValueError("Own stats index must have sorted unique loops")
        offset = bisect_left(loops, anchor) - 1
        reason = "no_own_stats_strictly_before_anchor"
        if offset >= 0:
            sample = stats_index[offset]
            if sample["player_id"] != sequence["player_id"] or not sample["sample_loop"] < anchor:
                raise ValueError("Cross-player or noncausal HUD sample")
            binding.update(sample_loop=sample["sample_loop"], sample_player_id=sample["player_id"],
                           sample_duplicate_count=sample["duplicate_count"], sample_projection_sha256=canonical_sha(sample))
            reason = "ambiguous_same_loop_own_stats" if sample["ambiguous"] else "invalid_latest_own_stats"
            if not sample["ambiguous"] and not sample["invalid_fields"]:
                values = sample["values"]
                features.update(minerals=values["minerals"], vespene=values["vespene"], bank_known=True,
                                age_seconds=(anchor - sample["sample_loop"]) / 22.4)
                if sequence["race"] == "Protoss":
                    features.update(supply_used=values["supply_used_raw4096"] / 4096.0, supply_used_known=True)
                reason = None
    return {"schema": SCHEMA, "replay_id": sequence["replay_id"], "player_id": sequence["player_id"],
            "target_source_event_index": target["ordinal"], "race_metadata": sequence["race"],
            "partition_metadata": sequence["partition"], "binding": binding, "features": features,
            "missing_reason": reason}


def validate_commands(sequence):
    previous = (-1, -1)
    seen = set()
    for event in sequence["events"]:
        values = (event.get("game_loop"), event.get("ordinal"))
        if (any(type(value) is not int or value < 0 for value in values) or values <= previous
                or values[1] in seen or values[1] <= previous[1]):
            raise ValueError("Original command identity/order changed")
        seen.add(values[1])
        previous = values


def encode_actor_features(sidecar_row):
    """Fixed float32[8] projection; identity/target time can never be features.

    Scaling uses constants, never fitted TRAIN or validation statistics. There
    is deliberately no clamping: these are stale observations, not legality.
    All-missing rows stay exactly zero, including age and sample-known slots.
    """
    if sidecar_row.get("schema") != SCHEMA:
        raise ValueError("Unsupported own-HUD feature schema")
    features = sidecar_row["features"]
    if set(features) != FEATURE_FIELDS:
        raise ValueError("HUD actor feature allowlist changed")
    bank, supply = features["bank_known"], features["supply_used_known"]
    if type(bank) is not bool or type(supply) is not bool:
        raise ValueError("HUD known flags must be booleans")
    for field, known in (("minerals", bank), ("vespene", bank), ("supply_used", supply)):
        value = features[field]
        if (known and (type(value) not in (int, float) or not math.isfinite(value) or value < 0)
                or not known and value is not None):
            raise ValueError("HUD value/missingness mismatch")
    if supply and sidecar_row.get("race_metadata") != "Protoss":
        raise ValueError("Supply display semantics are proven only for Protoss")
    known = bank or supply
    age = features["age_seconds"]
    if (known and (type(age) not in (int, float) or not math.isfinite(age) or age <= 0)
            or not known and age is not None):
        raise ValueError("HUD age/missingness mismatch")
    result = np.zeros(8, dtype=np.float32)
    if known:
        result[:] = [math.log1p(features["minerals"]) / math.log(5001) if bank else 0,
                     math.log1p(features["vespene"]) / math.log(5001) if bank else 0,
                     features["supply_used"] / 200 if supply else 0,
                     math.log1p(age) / math.log(61), bank, bank, supply, True]
    if not np.isfinite(result).all():
        raise ValueError("Nonfinite encoded HUD features")
    return result


def validate_sidecar_binding(row, sequence, target_index):
    """Validate every identity against the immutable original command sequence."""
    target = sequence["events"][target_index]
    prior = anchor_command(sequence["events"], target_index)
    if (row.get("schema") != SCHEMA or row.get("replay_id") != sequence["replay_id"]
            or row.get("player_id") != sequence["player_id"]
            or row.get("target_source_event_index") != target["ordinal"]
            or row.get("race_metadata") != sequence["race"]
            or row.get("partition_metadata") != sequence["partition"]):
        raise ValueError("HUD sidecar original perspective/target binding changed")
    binding = row["binding"]
    expected = {"target_source_event_index": target["ordinal"], "target_game_loop": target["game_loop"],
                "target_command_sha256": canonical_sha(target),
                "previous_own_macro_anchor_loop": prior["game_loop"] if prior else None,
                "previous_own_macro_anchor_source_event_index": prior["ordinal"] if prior else None,
                "previous_own_macro_anchor_command_sha256": canonical_sha(prior) if prior else None}
    if any(binding.get(key) != value for key, value in expected.items()):
        raise ValueError("HUD sidecar command/anchor identity changed")
    known = row["features"]["bank_known"] or row["features"]["supply_used_known"]
    sample = binding["sample_loop"]
    if sample is not None:
        if (type(sample) is not int or sample < 0 or prior is None
                or not sample < prior["game_loop"] < target["game_loop"]
                or binding["sample_player_id"] != sequence["player_id"]):
            raise ValueError("HUD sample violates strict own-player S<A<T")
    elif any(binding[field] is not None for field in
             ("sample_player_id", "sample_duplicate_count", "sample_projection_sha256")):
        raise ValueError("Absent sample has nonempty provenance")
    if known:
        if (sample is None or row["missing_reason"] is not None
                or row["features"]["age_seconds"] != (prior["game_loop"] - sample) / 22.4):
            raise ValueError("Known HUD age/missingness is not derived at the prior anchor")
    elif row["missing_reason"] not in ("no_strictly_previous_own_macro_command",
                                      "no_own_stats_strictly_before_anchor",
                                      "ambiguous_same_loop_own_stats", "invalid_latest_own_stats"):
        raise ValueError("Missing HUD lacks an explicit reason")
    return encode_actor_features(row)


def load_hud_sidecar(directory, *, dataset):
    """Admit only a complete immutable real-619 derivative and original targets.

    Returned hashes must be preserved/rechecked by consumers for their complete
    lifetime. Hash integrity is not a substitute for the independent raw-archive
    extraction proof; this loader does not claim current native legality.
    """
    directory, dataset = Path(directory).resolve(), Path(dataset).resolve()
    pins = {}

    def read(path, expected=None):
        path = Path(path).resolve()
        data = path.read_bytes()
        value = hashlib.sha256(data).hexdigest()
        if expected is not None and value != expected:
            raise ValueError(f"HUD derivative input hash changed: {path}")
        if str(path) in pins and pins[str(path)] != value:
            raise ValueError("HUD input changed during admission")
        pins[str(path)] = value
        return data

    result = json.loads(read(directory / "result.json"))
    if (result.get("schema") != "own-hud-sidecar-extraction-v1" or result.get("feature_schema") != SCHEMA
            or result.get("status") != "complete" or result.get("eligible_for_training") is not True
            or result.get("source_inputs_unchanged") is not True or result.get("all_originals_unchanged") is not True
            or result.get("errors") != [] or result.get("optimizer_updates") != 0
            or result.get("source_command_labels_rewritten") is not False
            or (result.get("originals_verified"), result.get("perspectives_written"), result.get("targets_written"))
            != (619, 1238, 152312)):
        raise ValueError("HUD extraction receipt is incomplete or incompatible")
    expected_sequence_sha = "8cb5ac66b182e71cc2000b13503198d939be5f15e9b2904977cbee9e44685034"
    expected_result_sha = "8d9d1e167f578a6e5633fec0288ba3c18322525bab5c8392ac1f0ac277b79e53"
    if (result.get("original_sequence_sha256") != expected_sequence_sha
            or result.get("original_result_sha256") != expected_result_sha):
        raise ValueError("HUD derivative belongs to a different original corpus")
    original_result = json.loads(read(dataset / "result.json", expected_result_sha))
    sequence_bytes = read(dataset / "sequences.jsonl", expected_sequence_sha)
    manifest = json.loads(read(original_result["source_manifest"], original_result["source_manifest_sha256"]))
    if (result.get("original_manifest_sha256") != original_result["source_manifest_sha256"]
            or result.get("fixed_partitions_sha256") != canonical_sha(manifest["fixed_partitions"])):
        raise ValueError("HUD whole-replay partitions changed")
    for path, expected in {**result["source_and_input_hashes"], **result["original_archive_hashes"]}.items():
        read(path, expected)
    if (str(Path(__file__).resolve()) not in result["source_and_input_hashes"]
            or len(result["original_archive_hashes"]) != 619):
        raise ValueError("HUD source or original-archive proof is incomplete")
    sidecar_bytes = read(directory / "sidecar.jsonl", result["sidecar_sha256"])
    perspective_bytes = read(directory / "perspectives.jsonl", result["perspectives_sha256"])
    sequences = {(r["replay_id"], r["player_id"]): r for r in map(json.loads, sequence_bytes.splitlines())}
    views = [json.loads(line) for line in perspective_bytes.splitlines()]
    if len(views) != 1238 or {(r["replay_id"], r["player_id"]) for r in views} != set(sequences):
        raise ValueError("HUD metadata does not retain all original perspectives")
    expected_targets = {}
    offset = 0
    for view in views:
        key = (view["replay_id"], view["player_id"])
        sequence = sequences[key]
        validate_commands(sequence)
        if (view["sequence_sha256"] != canonical_sha(sequence) or view["command_count"] != len(sequence["events"])
                or view["empty_view"] != (not bool(sequence["events"]))
                or view["first_sidecar_line_zero_based"] != offset
                or view["partition_metadata"] != sequence["partition"] or view["race_metadata"] != sequence["race"]):
            raise ValueError("HUD original perspective fingerprint/coverage changed")
        for index, target in enumerate(sequence["events"]):
            expected_targets[(*key, target["ordinal"])] = (sequence, index)
        offset += len(sequence["events"])
    result_map = {}
    for line in sidecar_bytes.splitlines():
        row = json.loads(line)
        key = (row["replay_id"], row["player_id"], row["target_source_event_index"])
        if key in result_map or key not in expected_targets:
            raise ValueError("Duplicate or unknown HUD target identity")
        sequence, index = expected_targets[key]
        result_map[key] = validate_sidecar_binding(row, sequence, index)
    if len(result_map) != 152312 or set(result_map) != set(expected_targets):
        raise ValueError("HUD derivative is missing original target rows")
    return result_map, pins
