"""Derive new conservative labels from immutable rich capture wire records.

Frames and actions are joined as streams, retaining two frames at most. This
does not train a model or authorize native raw commands in a restricted bot.
"""
from __future__ import annotations

import argparse
import base64
from collections import Counter
from contextlib import closing
from datetime import datetime, timezone
import gzip
import hashlib
import json
from pathlib import Path
import shutil

from google.protobuf.json_format import MessageToDict
from s2clientprotocol import sc2api_pb2 as api

from pluto_sc2 import rich_actions

if __package__:
    from .review_rich_capture import _hash, _partition, _rows
else:
    from review_rich_capture import _hash, _partition, _rows


def _json(path, value):
    pending = path.with_suffix(path.suffix + ".pending")
    pending.write_text(json.dumps(value, indent=2, allow_nan=False) + "\n", encoding="utf-8")
    pending.replace(path)


def _integer(value):
    return type(value) is int and value >= 0


def _decode(record):
    try:
        wire = base64.b64decode(record["wire_base64"], validate=True)
        action = api.Action.FromString(wire)
    except Exception as exc:
        raise ValueError("Invalid preserved native wire payload") from exc
    payload = MessageToDict(action, preserving_proto_field_name=True, use_integers_for_enums=True)
    loop = int(action.game_loop) if action.HasField("game_loop") else None
    if (not _integer(loop) or record.get("game_loop") != loop
            or hashlib.sha256(wire).hexdigest() != record.get("wire_sha256")
            or payload != record.get("payload")
            or action.SerializeToString(deterministic=True) != wire):
        raise ValueError("Preserved native wire/hash/payload/timestamp integrity failure")
    return action


def _selection_change(action):
    return action.HasField("action_ui") or any(
        getattr(action, surface).WhichOneof("action") in ("unit_selection_point", "unit_selection_rect")
        for surface in ("action_feature_layer", "action_render"))


def _context(frame, catalog, invalidated):
    rows = frame.get("available_abilities", [])
    if not isinstance(rows, list) or any(not isinstance(row, dict) or not _integer(row.get("ability_id")) for row in rows):
        raise ValueError("Invalid preceding-frame selected ability observation")
    available = {row["ability_id"] for row in rows}
    # Do not add map dimensions, entities, queues or selection evidence absent
    # from the original frame. Public metadata is not selected availability.
    result = {**frame, "public_abilities": {key: {**value, "current_available": value["id"] in available}
                                           for key, value in catalog.items()}}
    if invalidated:
        result["selection_complete"] = False
    return result


def _unframed(action, original):
    return {"schema": rich_actions.SCHEMA, "game_loop": int(action.game_loop), "preceding_game_loop": None,
            **{key: original[key] for key in ("wire_base64", "wire_sha256", "payload")}, "components": [],
            "supervision": {"trainable": False, "exclusion_reasons": ["no_preceding_observation"],
                            "scope": "native_action_labels_require_restricted_decoder"}}


def relabel_capture(source, output, *, split_summary):
    """Write only a new derived directory; an error leaves an explicit failed manifest."""
    source, output = Path(source).resolve(), Path(output).resolve()
    if output == source or source in output.parents or output.exists():
        raise ValueError("Derived output must be a new directory outside the original capture")
    metadata = json.loads((source / "capture.json").read_text(encoding="utf-8"))
    if metadata.get("status") in {"running", "relabeling"}:
        raise ValueError("Source capture is still active")
    if metadata.get("eligible_for_training") is not False or metadata.get("trained_weights") is not False:
        raise ValueError("Source must remain a fidelity-only capture")
    partition = _partition(metadata, split_summary)
    paths = {name: source / name for name in ("capture.json", "frames.jsonl.gz", "actions.jsonl.gz", "game-data.json")}
    source_hashes = {name: _hash(path) for name, path in paths.items()}
    for name, expected in metadata.get("artifacts", {}).items():
        if name in source_hashes and source_hashes[name] != expected:
            raise ValueError(f"Source artifact hash mismatch: {name}")
    catalog = json.loads(paths["game-data.json"].read_text(encoding="utf-8"))["abilities"]
    if (not isinstance(catalog, dict) or any(not isinstance(value, dict) or not _integer(value.get("id"))
                                           or str(value["id"]) != str(key) for key, value in catalog.items())):
        raise ValueError("Invalid public ability catalog")
    code_paths = {"rich_actions.py": Path(rich_actions.__file__).resolve(),
                  "relabel_rich_capture.py": Path(__file__).resolve(),
                  "review_rich_capture.py": Path(__file__).with_name("review_rich_capture.py").resolve()}
    code_hashes = {name: _hash(path) for name, path in code_paths.items()}
    output.parent.mkdir(parents=True, exist_ok=True)
    output.mkdir()  # Exclusive: no replacement of any prior capture or derivation.
    snapshot = output / "source-snapshot"
    snapshot.mkdir()
    for name, path in code_paths.items():
        shutil.copyfile(path, snapshot / name)
    manifest = {"source_directory": str(source), "source_artifacts": source_hashes,
                "source_code": code_hashes, "partition": partition,
                "context_policy": "Strict latest preceding frame; selection invalidated after intervening UI on same preceding frame",
                "map_dimensions_policy": "Preserve frame fields exactly; absent dimensions stay absent"}
    _json(output / "source-manifest.json", manifest)
    _json(snapshot / "manifest.json", code_hashes)
    state = {**metadata, "status": "running", "purpose": "offline rich replay supervision relabel fidelity derivation",
             "created_at": datetime.now(timezone.utc).isoformat(), "eligible_for_training": False,
             "trained_weights": False, "derived_from": str(source), "partition": partition["source_partition"],
             "counters": {}, "artifacts": {}, "source_artifacts_unchanged": None,
             "label_semantics": "Conservative serializer output; restricted decoder and dataset admission remain unverified"}
    for key in ("pid", "process_created_at", "finished_at", "wall_seconds", "error"):
        state.pop(key, None)
    _json(output / "capture.json", state)
    counters = Counter()
    reasons_before, reasons_after = Counter(), Counter()
    source_wire_digest, derived_wire_digest = hashlib.sha256(), hashlib.sha256()
    try:
        # Copy compressed bytes, never decompress/re-encode or edit feature data.
        for name in ("frames.jsonl.gz", "game-data.json"):
            shutil.copyfile(paths[name], output / name)
        with (gzip.open(output / "actions.jsonl.gz", "wt", encoding="utf-8", compresslevel=3) as labels,
              closing(_rows(paths["frames.jsonl.gz"])) as frames,
              closing(_rows(paths["actions.jsonl.gz"])) as action_rows):
            last_read_loop = -1

            def next_frame():
                nonlocal last_read_loop
                value = next(frames, None)
                if value is None:
                    return None
                line, frame = value
                loop = frame.get("game_loop")
                if not _integer(loop) or loop <= last_read_loop:
                    raise ValueError(f"Frame loops must strictly increase (line {line})")
                last_read_loop = loop
                counters["frames"] += 1
                return frame

            prior, lookahead = None, next_frame()
            last_action_loop, last_reference = -1, -1
            invalidated = False
            for line, original in action_rows:
                action = _decode(original)
                loop = int(action.game_loop)
                reference = original.get("preceding_game_loop")
                reference_key = -1 if reference is None else reference
                if (not _integer(reference_key) and reference_key != -1
                        or reference_key < last_reference or loop < last_action_loop):
                    raise ValueError(f"Actions must be ordered by preceding frame and action loop (line {line})")
                while lookahead is not None and lookahead["game_loop"] < loop:
                    prior, lookahead = lookahead, next_frame()
                nearest = prior["game_loop"] if prior else None
                if reference != nearest or reference is not None and reference >= loop:
                    raise ValueError(f"Action must reference its strict latest preceding frame (line {line})")
                if reference_key != last_reference:
                    invalidated = False
                if prior is None:
                    regenerated = _unframed(action, original)
                    counters["no_preceding_observation"] += 1
                else:
                    context = _context(prior, catalog, invalidated)
                    regenerated = rich_actions.serialize_action(action, context)
                    rich_actions.validate_action_record(regenerated, context)
                    counters["contexts_with_selection_invalidated"] += invalidated
                for key in ("wire_base64", "wire_sha256", "payload", "game_loop", "preceding_game_loop"):
                    if regenerated[key] != original[key]:
                        raise ValueError(f"Relabeling changed preserved native {key} (line {line})")
                before = original.get("supervision", {})
                after = regenerated["supervision"]
                reasons_before.update(set(before.get("exclusion_reasons", before.get("reasons", []))))
                reasons_after.update(set(after["exclusion_reasons"]))
                counters["actions"] += 1
                counters["trainable_actions"] += after["trainable"]
                counters["excluded_actions"] += not after["trainable"]
                counters["source_flag_trainable"] += before.get("trainable") is True
                counters["newly_flagged_trainable"] += before.get("trainable") is not True and after["trainable"]
                counters["newly_excluded"] += before.get("trainable") is True and not after["trainable"]
                counters["wire_inputs_preserved"] += 1
                for digest, record in ((source_wire_digest, original), (derived_wire_digest, regenerated)):
                    digest.update(bytes.fromhex(record["wire_sha256"]))  # Ordered per-record digests, including repetitions.
                labels.write(json.dumps(regenerated, separators=(",", ":"), allow_nan=False) + "\n")
                invalidated = invalidated or _selection_change(action)
                last_action_loop, last_reference = loop, reference_key
            while next_frame() is not None:
                pass
        for key in ("frames", "actions"):
            if metadata.get("counters", {}).get(key) != counters[key]:
                raise ValueError(f"Exported {key} count differs from source capture manifest")
        if source_wire_digest.digest() != derived_wire_digest.digest():
            raise ValueError("Ordered native action stream changed")
        for name, path in paths.items():
            if _hash(path) != source_hashes[name]:
                raise ValueError(f"Source artifact changed during relabeling: {name}")
        for name, path in code_paths.items():
            if _hash(path) != code_hashes[name]:
                raise ValueError(f"Serializer/relabel source changed during operation: {name}")
        if _hash(Path(split_summary)) != partition["split_sha256"]:
            raise ValueError("Pinned split changed during relabeling")
        state.update(status="relabelled_full_replay" if metadata.get("full_replay") else "relabelled_prefix",
                     source_artifacts_unchanged=True, ordered_wire_sha256=derived_wire_digest.hexdigest())
    except BaseException as exc:
        state.update(status="failed", error=f"{type(exc).__name__}: {exc}")
        raise
    finally:
        state.update(finished_at=datetime.now(timezone.utc).isoformat(), counters=dict(counters),
                     exclusion_reasons_before=dict(reasons_before), exclusion_reasons_after=dict(reasons_after),
                     exclusion_count_note="Reasons overlap; counts are not disjoint additive action totals.")
        state["artifacts"] = {name: _hash(output / name) for name in
            ("frames.jsonl.gz", "actions.jsonl.gz", "game-data.json") if (output / name).is_file()}
        _json(output / "capture.json", state)
    return state


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("source", type=Path)
    parser.add_argument("--output", type=Path, required=True)
    parser.add_argument("--split-summary", type=Path, required=True)
    args = parser.parse_args(argv)
    state = relabel_capture(args.source, args.output, split_summary=args.split_summary)
    print(json.dumps({key: state[key] for key in ("status", "partition", "eligible_for_training", "counters")}))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
