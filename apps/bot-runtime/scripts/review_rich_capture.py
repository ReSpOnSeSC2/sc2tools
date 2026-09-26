"""Read-only, streaming fidelity review of an exact-engine rich replay capture.

This checks exported native wire/payload records, not completeness against an
independently decoded replay. Supervision flags are reported, not certified as
safe training labels. No replay, frame, label, split or model is modified.
"""
from __future__ import annotations

import argparse
import base64
from bisect import bisect_left
from collections import Counter
import gzip
import hashlib
import json
from pathlib import Path

from google.protobuf.json_format import MessageToDict
from s2clientprotocol import sc2api_pb2 as api


def _hash(path):
    digest = hashlib.sha256()
    with Path(path).open("rb") as stream:
        for block in iter(lambda: stream.read(1024 * 1024), b""):
            digest.update(block)
    return digest.hexdigest()


def _rows(path):
    with gzip.open(path, "rt", encoding="utf-8") as stream:
        for number, line in enumerate(stream, 1):
            try:
                row = json.loads(line)
                if not isinstance(row, dict):
                    raise ValueError("record is not an object")
            except (ValueError, TypeError) as exc:
                raise ValueError(f"{path.name} line {number}: invalid JSON object") from exc
            yield number, row


def _integer(value):
    return type(value) is int and value >= 0


def _payload(action):
    return MessageToDict(action, preserving_proto_field_name=True, use_integers_for_enums=True)


def _native_command(part, surface):
    target = None
    if surface == "action_raw":
        if part.HasField("target_world_space_pos"):
            target = {"kind": "world_point", "point": [part.target_world_space_pos.x, part.target_world_space_pos.y]}
        elif part.HasField("target_unit_tag"):
            target = {"kind": "unit", "tag": int(part.target_unit_tag)}
    else:
        for field, kind in (("target_screen_coord", "screen_point"), ("target_minimap_coord", "minimap_point")):
            if part.HasField(field):
                point = getattr(part, field)
                target = {"kind": kind, "point": [point.x, point.y]}
    result = {"ability_id": int(part.ability_id), "queue_command": bool(part.queue_command), "target": target}
    if surface == "action_raw":
        result["source_tags"] = list(part.unit_tags)
    return result


def _partition(capture, split_summary):
    partition = capture.get("partition")
    if partition not in {"train", "validation"}:
        raise ValueError("Capture must retain an explicit whole-replay train/validation partition")
    result = {"source_partition": partition, "whole_replay_id": capture.get("replay", {}).get("replay_id"),
              "membership_verified": False, "scope": "declared capture partition; never reassigned"}
    if split_summary is None:
        return result
    split_path = Path(split_summary).resolve()
    split = json.loads(split_path.read_text(encoding="utf-8"))
    # Both repository split artifacts retain whole replay membership: the
    # corpus listing stores replay records directly, the training summary
    # groups replay IDs by matchup. Neither may be silently repartitioned.
    if "train_replay_ids" in split and "validation_replay_ids" in split:
        groups = [split]
    elif isinstance(split.get("split", {}).get("matchups"), dict):
        groups = split["split"]["matchups"].values()
    else:
        raise ValueError("Unrecognized pinned whole-replay split format")
    memberships = [part for match in groups
                   for part, key in (("train", "train_replay_ids"), ("validation", "validation_replay_ids"))
                   for entry in match[key]
                   if (entry.get("replay_id") if isinstance(entry, dict) else entry) == result["whole_replay_id"]]
    if memberships != [partition]:
        raise ValueError("Capture partition disagrees with unique pinned whole-replay membership")
    return {**result, "membership_verified": True, "split_path": str(split_path), "split_sha256": _hash(split_path)}


def review_capture(directory, *, split_summary=None, max_samples=8):
    """Read each gzip as a stream; retain only frame-loop indices and small samples."""
    if type(max_samples) is not int or not 0 <= max_samples <= 32:
        raise ValueError("Sample count must be 0..32")
    directory = Path(directory).resolve()
    metadata_path = directory / "capture.json"
    metadata_sha = _hash(metadata_path)
    capture = json.loads(metadata_path.read_text(encoding="utf-8"))
    if capture.get("status") == "running":
        raise ValueError("Wait for capture to close before reviewing its gzip streams")
    partition = _partition(capture, split_summary)
    counts, errors, error_samples = Counter(), Counter(), []
    surfaces, kinds, abilities, ability_actions, reasons = Counter(), Counter(), Counter(), Counter(), Counter()
    loops, build_samples, dual_samples = [], [], []

    def error(name, record=None):
        errors[name] += 1
        if len(error_samples) < 32:
            error_samples.append({"reason": name, "record": record})

    if capture.get("eligible_for_training") is not False or capture.get("trained_weights") is not False:
        error("capture_fidelity_only_flags_invalid")
    artifact_hashes = {}
    for filename in ("frames.jsonl.gz", "actions.jsonl.gz", "game-data.json"):
        path = directory / filename
        if not path.is_file():
            error("missing_" + filename)
            continue
        artifact_hashes[filename] = _hash(path)
        expected = capture.get("artifacts", {}).get(filename)
        if expected is not None and expected != artifact_hashes[filename]:
            error("artifact_hash_mismatch:" + filename)
    data = json.loads((directory / "game-data.json").read_text(encoding="utf-8")) if (
        directory / "game-data.json").is_file() else {}
    public_abilities = data.get("abilities", {})
    try:
        for line, frame in _rows(directory / "frames.jsonl.gz"):
            counts["frames"] += 1
            loop = frame.get("game_loop")
            if not _integer(loop) or loops and loop <= loops[-1]:
                error("frame_loop_not_strictly_increasing", line)
                continue
            loops.append(loop)
            counts["frames_with_ui"] += bool(frame.get("ui"))
            counts["frames_with_camera"] += isinstance(frame.get("camera"), list) and len(frame["camera"]) == 2
            counts["available_ability_entries"] += len(frame.get("available_abilities", []))
            counts["entity_rows"] += len(frame.get("entities", []))
    except (OSError, EOFError, ValueError) as exc:
        error("frame_stream_unreadable:" + type(exc).__name__)
    last_action_loop = -1
    try:
        for line, record in _rows(directory / "actions.jsonl.gz"):
            counts["actions"] += 1
            action_loop, preceding = record.get("game_loop"), record.get("preceding_game_loop")
            if not _integer(action_loop):
                error("action_loop_invalid", line)
            else:
                if action_loop < last_action_loop:
                    error("action_loops_out_of_order", line)
                last_action_loop = action_loop
                nearest = bisect_left(loops, action_loop) - 1
                if preceding is None:
                    counts["actions_without_preceding_frame"] += 1
                    if nearest >= 0:
                        error("missing_preceding_frame_reference", line)
                elif not _integer(preceding) or preceding >= action_loop:
                    error("reference_not_strictly_preceding", line)
                elif nearest < 0 or loops[nearest] != preceding:
                    error("reference_not_latest_captured_preceding_frame", line)
                else:
                    counts["strict_preceding_references_verified"] += 1
            supervision = record.get("supervision", {})
            excluded = supervision.get("exclusion_reasons", supervision.get("reasons", []))
            if not isinstance(excluded, list) or any(not isinstance(reason, str) for reason in excluded):
                error("exclusion_reasons_invalid", line)
                excluded = []
            reasons.update(set(excluded))  # Count each reason once per action; reasons overlap.
            trainable = supervision.get("trainable")
            if type(trainable) is not bool or trainable != (not excluded):
                error("supervision_flag_inconsistent", line)
            counts["label_flag_trainable"] += trainable is True
            counts["label_flag_excluded"] += trainable is False
            if preceding is None and (trainable is not False or "no_preceding_observation" not in excluded):
                error("unframed_action_not_explicitly_excluded", line)
            try:
                wire = base64.b64decode(record["wire_base64"], validate=True)
                action = api.Action.FromString(wire)
            except Exception:
                error("native_wire_unreadable", line)
                continue
            counts["native_wire_decoded"] += 1
            wire_sha = hashlib.sha256(wire).hexdigest()
            hash_present = "wire_sha256" in record
            if hash_present:
                counts["wire_sha_present"] += 1
                if record["wire_sha256"] != wire_sha:
                    error("wire_sha_mismatch", line)
                else:
                    counts["wire_sha_verified"] += 1
            else:
                counts["wire_sha_absent_unverified"] += 1
            if action.SerializeToString(deterministic=True) == wire:
                counts["native_wire_byte_roundtrip_verified"] += 1
            else:
                error("native_wire_byte_roundtrip_mismatch", line)
            payload = _payload(action)
            payload_matches = payload == record.get("payload")
            if payload_matches:
                counts["native_payload_matches_wire"] += 1
            else:
                error("native_payload_mismatch", line)
            if (int(action.game_loop) if action.HasField("game_loop") else None) != action_loop:
                error("native_action_loop_mismatch", line)
            clean = api.Action()
            clean.CopyFrom(action)
            clean.DiscardUnknownFields()
            counts["actions_with_unknown_wire_fields"] += clean.SerializeToString(deterministic=True) != wire
            components = record.get("components", [])
            if not isinstance(components, list):
                error("normalized_components_invalid", line)
                components = []
            counts["normalized_label_components"] += len(components)
            command_views, action_abilities = [], set()
            for descriptor, surface in action.ListFields():
                surface_name = descriptor.name
                if surface_name == "game_loop":
                    continue
                surfaces[surface_name] += 1
                if surface_name not in {"action_raw", "action_feature_layer", "action_render", "action_ui"}:
                    counts["other_native_surfaces"] += 1
                    continue
                for field, part in surface.ListFields():
                    kind = field.name
                    kinds[surface_name + "." + kind] += 1
                    counts["native_components"] += 1
                    counts["ui_components"] += surface_name == "action_ui"
                    counts["camera_components"] += kind == "camera_move"
                    counts["selection_components"] += kind.startswith("unit_selection")
                    matched = [item for item in components if isinstance(item, dict)
                               and item.get("surface") == surface_name and item.get("kind") == kind]
                    component = matched[0] if len(matched) == 1 else None
                    if component is not None and component.get("arguments") != payload[surface_name][kind]:
                        error("normalized_arguments_disagree_with_native", line)
                    if kind != "unit_command":
                        continue
                    counts["command_components"] += 1
                    expected = _native_command(part, surface_name)
                    ability_id = expected["ability_id"]
                    abilities[str(ability_id)] += 1
                    action_abilities.add(str(ability_id))
                    command_views.append({"surface": surface_name, **expected})
                    counts["commands_with_ability"] += part.HasField("ability_id")
                    counts["queued_commands"] += expected["queue_command"]
                    counts["queue_fields_present"] += part.HasField("queue_command")
                    counts["native_source_tag_entries"] += len(expected.get("source_tags", []))
                    target = expected["target"]
                    counts["unit_tag_targets"] += bool(target and target["kind"] == "unit")
                    counts["point_targets"] += bool(target and target["kind"].endswith("point"))
                    counts["targetless_commands"] += target is None
                    normalized = component.get("command") if component else None
                    if isinstance(normalized, dict):
                        counts["normalized_commands"] += 1
                        tags = normalized.get("source_tags", [])
                        if isinstance(tags, list):
                            counts["normalized_source_tag_entries"] += len(tags)
                        command_matches = all(normalized.get(key) == value for key, value in expected.items())
                        if not command_matches:
                            error("normalized_command_disagrees_with_native", line)
                    else:
                        command_matches = False
                        counts["commands_without_normalized_label"] += 1
                        if preceding is not None:
                            error("framed_command_missing_normalized_label", line)
                    ability = public_abilities.get(str(ability_id), {})
                    name = str(ability.get("name", ""))
                    if (len(build_samples) < max_samples and _integer(action_loop) and action_loop <= 300 * 22.4
                            and "BUILD" in name.upper()):
                        build_samples.append({"action_line": line, "game_loop": action_loop,
                            "game_seconds": action_loop / 22.4, "preceding_game_loop": preceding,
                            "ability_id": ability_id, "public_name": name, "surface": surface_name,
                            "wire_sha256": wire_sha, "wire_sha_verified": hash_present and record["wire_sha256"] == wire_sha,
                            "native_arguments": payload[surface_name][kind], "normalized_command": normalized,
                            "payload_matches_native_wire": payload_matches, "command_matches_native_fields": command_matches,
                            "label_flag_trainable": trainable, "exclusion_reasons": excluded})
            ability_actions.update(action_abilities)
            if len(command_views) > 1:
                counts["multi_view_command_actions"] += 1
                if len(dual_samples) < max_samples:
                    dual_samples.append({"action_line": line, "game_loop": action_loop,
                        "views": command_views, "exclusion_reasons": excluded,
                        "note": "One retained Action with multiple native views; not multiple independent inputs."})
    except (OSError, EOFError, ValueError) as exc:
        error("action_stream_unreadable:" + type(exc).__name__)
    for key in ("frames", "actions"):
        expected = capture.get("counters", {}).get(key)
        if expected is not None and expected != counts[key]:
            error("capture_counter_mismatch:" + key)
    if _hash(metadata_path) != metadata_sha:
        raise ValueError("Capture metadata changed during review; retry after capture is stable")
    return {"schema": 1, "purpose": "rich replay capture fidelity review", "capture_directory": str(directory),
        "capture_status": capture.get("status"), "full_replay": capture.get("full_replay") is True,
        "eligible_for_training": False, "trained_models": False, "partition": partition,
        "fidelity_checks_passed": not errors, "counts": dict(counts), "surfaces": dict(surfaces),
        "component_kinds": dict(kinds), "abilities": dict(abilities), "ability_action_counts": dict(ability_actions),
        "ability_count_note": "abilities counts component views; ability_action_counts counts each ID once per retained Action. Neither establishes human input count.",
        "exclusion_reasons": dict(reasons), "multi_view_command_samples": dual_samples,
        "exclusion_count_note": "Reasons overlap; their counts are not additive disjoint action totals.",
        "errors": dict(errors), "error_samples": error_samples, "early_build_samples": build_samples,
        "inputs": {"capture.json": metadata_sha, **artifact_hashes},
        "frame_loop_range": [loops[0], loops[-1]] if loops else None,
        "semantic_reproduction_verified": False,
        "limitations": ["Trainable is the captured label flag, not a certified training admission decision.",
            "Wire/JSON and normalized arguments are compared with the native payload retained by this capture, not an independent replay decoding.",
            "No proof that the engine exported every original replay action; manifest counters check only exported records.",
            "Same-frame intervening UI context is not separately persisted; full causal supervision semantics are not reproduced here.",
            "Source selection for spatial commands is a captured label, not independently reconstructed from native raw unit tags.",
            "No model was trained or evaluated and no strength/MMR inference is made."]}


def write_review(directory, review):
    directory = Path(directory).resolve()
    json_path, md_path = directory / "review.json", directory / "review.md"
    if json_path.exists() or md_path.exists():
        raise FileExistsError("Review outputs already exist; existing artifacts are not overwritten")
    counts = review["counts"]
    prose = (f"Capture fidelity checks: {'passed' if review['fidelity_checks_passed'] else 'failed'}. "
             "Training eligibility remains false.\n\n"
             f"Read {counts.get('frames', 0)} frames and {counts.get('actions', 0)} retained native action records. "
             f"Verified {counts.get('native_payload_matches_wire', 0)} wire/JSON payloads and "
             f"{counts.get('wire_sha_verified', 0)} action SHA-256 values. "
             f"The capture flags {counts.get('label_flag_trainable', 0)} actions as trainable and "
             f"{counts.get('label_flag_excluded', 0)} as excluded; these flags are not certified training admission.\n\n"
             f"The source whole-replay partition is {review['partition']['source_partition']}; "
             f"pinned membership verified: {review['partition']['membership_verified']}.\n\n"
             "Exclusion reasons overlap and must not be added as disjoint totals. "
             "Early-build samples compare normalized fields with the exact native payload retained in the capture. "
             "No separate replay decoding or full semantic reproduction was performed.\n\n"
             "See [review.json](review.json) for counters, causal reference checks, errors and samples. "
             "No raw files were changed; no model or strength claim is made.\n")
    with json_path.open("x", encoding="utf-8") as stream:
        json.dump(review, stream, indent=2, allow_nan=False)
        stream.write("\n")
    with md_path.open("x", encoding="utf-8") as stream:
        stream.write(prose)
    return json_path, md_path


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("capture", type=Path)
    parser.add_argument("--split-summary", type=Path)
    parser.add_argument("--max-samples", type=int, default=8)
    args = parser.parse_args(argv)
    review = review_capture(args.capture, split_summary=args.split_summary, max_samples=args.max_samples)
    paths = write_review(args.capture, review)
    print(json.dumps({"fidelity_checks_passed": review["fidelity_checks_passed"], "counts": review["counts"],
                      "eligible_for_training": False, "review": str(paths[0])}))
    return 0 if review["fidelity_checks_passed"] else 1


if __name__ == "__main__":
    raise SystemExit(main())
