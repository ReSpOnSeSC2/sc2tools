"""Causal, immutable replay-intent derivatives for bounded AlphaStar imitation.

Native capture files stay untouched. The derivative preserves excluded inputs,
whole-game split identity and exact action wire provenance alongside its samples.
"""
from __future__ import annotations

import base64
from collections import Counter
from contextlib import closing
from datetime import datetime, timezone
import gzip
import hashlib
import json
import math
from pathlib import Path
import shutil

from google.protobuf.json_format import MessageToDict
from s2clientprotocol import sc2api_pb2 as api

SCHEMA = "alphastar-intent-dataset-v1"


def file_hash(path):
    with Path(path).open("rb") as stream:
        return hashlib.file_digest(stream, "sha256").hexdigest()


def _write(path, value):
    pending = path.with_suffix(path.suffix + ".pending")
    pending.write_text(json.dumps(value, indent=2, allow_nan=False) + "\n", encoding="utf-8")
    pending.replace(path)


def rows(path):
    with gzip.open(path, "rt", encoding="utf-8") as stream:
        for index, line in enumerate(stream):
            value = json.loads(line)
            if not isinstance(value, dict):
                raise ValueError(f"Expected object at {path}:{index + 1}")
            yield value


def replay_partitions(path):
    split = json.loads(Path(path).read_text(encoding="utf-8"))
    groups = (split["split"]["matchups"].values() if "split" in split else [split])
    result = {}
    for group in groups:
        for partition in ("train", "validation"):
            for entry in group[partition + "_replay_ids"]:
                key = entry["replay_id"] if isinstance(entry, dict) else entry
                if key in result:
                    raise ValueError("An original replay must have one unique whole-game partition")
                result[key] = partition
    return result


def _decoded(record):
    wire = base64.b64decode(record["wire_base64"], validate=True)
    action = api.Action.FromString(wire)
    payload = MessageToDict(action, preserving_proto_field_name=True, use_integers_for_enums=True)
    if (hashlib.sha256(wire).hexdigest() != record["wire_sha256"] or payload != record["payload"]
            or action.SerializeToString(deterministic=True) != wire
            or not action.HasField("game_loop") or action.game_loop != record["game_loop"]):
        raise ValueError("Native action wire, payload, hash or timestamp mismatch")
    return action


def causal_pairs(directory):
    """Join with latest strictly prior frame, adding only past neutral sightings."""
    directory = Path(directory)
    known_neutral = {}
    with closing(rows(directory / "frames.jsonl.gz")) as frames:
        last_frame = -1

        def next_frame():
            nonlocal last_frame
            frame = next(frames, None)
            if frame is None:
                return None
            loop = frame.get("game_loop")
            if type(loop) is not int or loop <= last_frame:
                raise ValueError("Frame loops must strictly increase")
            last_frame = loop
            return frame

        def remember(frame):
            for entity in frame.get("entities", []):
                if entity.get("owner") == 3 and entity.get("is_visible") is True:
                    known_neutral[entity["tag"]] = {
                        key: entity[key] for key in ("tag", "owner", "type_id", "type_name", "position")}
                    known_neutral[entity["tag"]]["last_seen_loop"] = frame["game_loop"]

        prior, following = None, next_frame()
        previous_loop, previous_reference, invalidated = -1, None, False
        for ordinal, record in enumerate(rows(directory / "actions.jsonl.gz")):
            action = _decoded(record)
            loop = action.game_loop
            if loop < previous_loop:
                raise ValueError("Action timestamps must be nondecreasing")
            while following is not None and following["game_loop"] < loop:
                prior = following
                remember(prior)
                following = next_frame()
            reference = prior["game_loop"] if prior else None
            if record.get("preceding_game_loop") != reference:
                raise ValueError("Action must reference the latest strictly preceding frame")
            if reference != previous_reference:
                invalidated = False
            context = None if prior is None else {
                **prior, "known_neutral": [dict(row) for row in known_neutral.values()],
                "selection_complete": prior.get("selection_complete") is True and not invalidated,
                "intervening_selection_input": invalidated}
            yield ordinal, record, context
            invalidated = invalidated or action.HasField("action_ui") or any(
                getattr(action, field).WhichOneof("action") in ("unit_selection_point", "unit_selection_rect")
                for field in ("action_feature_layer", "action_render"))
            previous_loop, previous_reference = loop, reference
        while next_frame() is not None:
            pass


def export_dataset(captures, output, *, split_summary, through_seconds=300):
    """Admit planned intents, not raw-control privileges or certified policies."""
    from . import rich_actions, rich_intents

    if (isinstance(through_seconds, bool) or not isinstance(through_seconds, (int, float))
            or not math.isfinite(through_seconds) or not 1 <= through_seconds <= 7200):
        raise ValueError("A bounded 1..7200 game-second horizon is required")
    captures = [Path(path).resolve() for path in captures]
    output, split_summary = Path(output).resolve(), Path(split_summary).resolve()
    if not captures or output.exists() or any(path == output or path in output.parents for path in captures):
        raise ValueError("Use a new output directory outside all immutable captures")
    partitions = replay_partitions(split_summary)
    sources, identities, catalog_hash = [], set(), None
    for directory in captures:
        meta = json.loads((directory / "capture.json").read_text(encoding="utf-8"))
        if (meta.get("status") != "captured_full_replay" or meta.get("full_replay") is not True
                or meta.get("engine_start_workers") != 8 or meta.get("original_replay_unchanged") is not True):
            raise ValueError("A complete verified eight-worker native capture is required")
        replay_id, player_id = meta["replay"]["replay_id"], meta["player_id"]
        if partitions.get(replay_id) != meta.get("partition"):
            raise ValueError("Capture partition differs from pinned whole-replay split")
        identity = (replay_id, player_id)
        if identity in identities:
            raise ValueError("Duplicate replay perspective would silently change sampling weight")
        identities.add(identity)
        hashes = {name: file_hash(directory / name) for name in (
            "capture.json", "frames.jsonl.gz", "actions.jsonl.gz", "game-data.json", "game-info.json")}
        for name in hashes.keys() - {"capture.json"}:
            if hashes[name] != meta["artifacts"].get(name):
                raise ValueError(f"Capture artifact hash mismatch: {name}")
        if catalog_hash is not None and hashes["game-data.json"] != catalog_hash:
            raise ValueError("Different public patch catalogs require separate dataset versions")
        catalog_hash = hashes["game-data.json"]
        sources.append({"directory": str(directory), "replay_id": replay_id, "player_id": player_id,
                        "partition": meta["partition"], "hashes": hashes, "meta": meta})
    output.mkdir(parents=True)
    snapshot = output / "source-snapshot"
    snapshot.mkdir()
    code_paths = [Path(__file__), Path(rich_intents.__file__), Path(rich_actions.__file__)]
    code_hashes = {path.name: file_hash(path) for path in code_paths}
    for path in code_paths:
        shutil.copyfile(path, snapshot / path.name)
    shutil.copyfile(captures[0] / "game-data.json", output / "game-data.json")
    catalog = json.loads((output / "game-data.json").read_text(encoding="utf-8"))
    state = {"schema": SCHEMA, "status": "running", "created_at": datetime.now(timezone.utc).isoformat(),
             "eligible_for_training": False, "training_scope": "bounded_imitation_diagnostic",
             "source_captures": sources, "game_data_sha256": catalog_hash,
             "replay_partitions": {s["replay_id"]: s["partition"] for s in sources},
             "split_path": str(split_summary), "split_sha256": file_hash(split_summary),
             "through_seconds": through_seconds, "source_code": code_hashes,
             "label_semantics": "Native expert intentions; assisted targets require paid camera/selection and fresh validation",
             "models_trained": False, "live_decoder_verified": False, "tensor_bridge_verified": False}
    _write(output / "manifest.json", state)
    counts, reasons, abilities = Counter(), Counter(), Counter()
    try:
        with (gzip.open(output / "samples.jsonl.gz", "wt", encoding="utf-8", compresslevel=3) as samples,
              gzip.open(output / "action-admission.jsonl.gz", "wt", encoding="utf-8", compresslevel=3) as audit):
            for source in sources:
                source_count = 0
                for ordinal, record, context in causal_pairs(source["directory"]):
                    source_count += 1
                    if (output / "STOP").exists():
                        raise InterruptedError("Dataset STOP marker present")
                    counts["source_actions"] += 1
                    if record["game_loop"] / 22.4 > through_seconds:
                        counts["outside_horizon"] += 1
                        continue
                    counts["total_actions"] += 1
                    intent = (rich_intents.normalize_intent(record, context, catalog["abilities"]) if context else
                              {"admitted": False, "reasons": ["no_preceding_observation"]})
                    provenance = {"replay_id": source["replay_id"], "player_id": source["player_id"],
                                  "partition": source["partition"], "action_ordinal": ordinal,
                                  "action_loop": record["game_loop"], "preceding_loop": record["preceding_game_loop"],
                                  "action_wire_sha256": record["wire_sha256"]}
                    audit.write(json.dumps({**provenance, "record": record, "intent": intent},
                                           separators=(",", ":"), allow_nan=False) + "\n")
                    if intent["admitted"]:
                        row = {"schema": SCHEMA, **provenance, "frame": context, "intent": intent}
                        samples.write(json.dumps(row, separators=(",", ":"), allow_nan=False) + "\n")
                        counts["samples"] += 1
                        counts[source["partition"] + "_samples"] += 1
                        abilities[str(intent.get("ability_id", "camera"))] += 1
                    else:
                        counts["excluded"] += 1
                        reasons.update(intent.get("reasons", []))
                if source_count != source["meta"]["counters"]["actions"]:
                    raise ValueError("Native action count differs from completed capture manifest")
        if not counts["samples"]:
            raise ValueError("No admitted replay intentions in requested horizon")
        for source in sources:
            if any(file_hash(Path(source["directory"]) / name) != expected
                   for name, expected in source["hashes"].items()):
                raise ValueError("Source capture changed during export")
        if file_hash(split_summary) != state["split_sha256"]:
            raise ValueError("Whole-replay split changed during export")
        if any(file_hash(path) != code_hashes[path.name] for path in code_paths):
            raise ValueError("Exporter/normalizer code changed during export")
        state.update(status="complete", eligible_for_training=True,
                     samples_sha256=file_hash(output / "samples.jsonl.gz"),
                     admission_sha256=file_hash(output / "action-admission.jsonl.gz"),
                     source_artifacts_unchanged=True)
    except BaseException as exc:
        state.update(status="failed", eligible_for_training=False, error=f"{type(exc).__name__}: {exc}")
        raise
    finally:
        state.update(finished_at=datetime.now(timezone.utc).isoformat(), counts=dict(counts),
                     exclusion_reasons=dict(reasons), admitted_abilities=dict(abilities))
        _write(output / "manifest.json", state)
    return state


def main(argv=None):
    import argparse
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--capture", action="append", required=True)
    parser.add_argument("--output", required=True)
    parser.add_argument("--split-summary", required=True)
    parser.add_argument("--through-seconds", type=float, default=300)
    args = parser.parse_args(argv)
    state = export_dataset(args.capture, args.output, split_summary=args.split_summary,
                           through_seconds=args.through_seconds)
    print(json.dumps({key: state[key] for key in ("status", "counts", "admitted_abilities", "exclusion_reasons")}))


if __name__ == "__main__":
    main()
