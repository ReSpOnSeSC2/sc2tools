"""Compare observed coached openings without modifying runs or rating strength."""
from __future__ import annotations

import argparse
from collections import Counter, deque
import hashlib
import json
import math
from pathlib import Path


STRUCTURES = {"NEXUS", "PYLON", "GATEWAY", "CYBERNETICSCORE", "ASSIMILATOR",
              "SHIELDBATTERY", "ROBOTICSFACILITY", "FORGE", "TWILIGHTCOUNCIL"}
OPTIONAL = {"build_shieldbattery", "build_roboticsfacility", "build_forge",
            "build_twilightcouncil", "research_warpgateresearch", "train_sentry", "train_zealot"}


def number(value):
    return type(value) in (int, float) and math.isfinite(value)


def timestamp(row):
    value = row.get("game_seconds", row.get("time"))
    return float(value) if number(value) and value >= 0 else None


def _jsonl(path):
    with path.open(encoding="utf-8") as stream:
        return [json.loads(line) for line in stream if line.strip()]


def _at(reports, at):
    return next((row for row in reversed(reports) if timestamp(row) <= at), {})


def _first(rows):
    return rows[0] if rows else None


def _base(report, position):
    if not isinstance(position, list) or len(position) != 2 or not all(map(number, position)):
        return None
    candidates = [(math.dist(position, row["position"]), row.get("base_index"))
                  for row in report.get("opening_bases", [])
                  if isinstance(row.get("position"), list) and len(row["position"]) == 2
                  and all(map(number, row["position"]))]
    return min(candidates)[1] if candidates and min(candidates)[0] <= 14 else None


def inspect_opening(directory, seconds=360):
    """Read one run; current snapshots and accepted inputs remain distinct evidence."""
    directory = Path(directory).resolve()
    if not number(seconds) or not 0 < seconds <= 7200:
        raise ValueError("seconds must be finite and within (0,7200]")
    files = {name: directory / name for name in
             ("session.json", "reports.jsonl", "execution.jsonl", "audit.json")}
    session = json.loads(files["session.json"].read_text(encoding="utf-8"))
    if session.get("profile") != "session-coached-protoss-v1" or session.get("learned_policy") is not False:
        raise ValueError("Expected an explicitly nonlearned coached run")
    reports = _jsonl(files["reports.jsonl"])
    if any(row.get("game_id") != session.get("game_id") for row in reports):
        raise ValueError("Report game_id differs from session")
    if any(timestamp(row) is None for row in reports):
        raise ValueError("Reports require finite game times")
    reports = sorted((row for row in reports if timestamp(row) <= seconds), key=timestamp)
    if not reports:
        raise ValueError("No reports within requested horizon")
    execution = _jsonl(files["execution.jsonl"])
    audit = json.loads(files["audit.json"].read_text(encoding="utf-8"))
    actions = audit["actions"]
    command_by_selection = {}
    for index, event in enumerate(actions):
        if event.get("kind") == "command" and event.get("result") == [1]:
            command_by_selection.setdefault(event.get("selection_audit_index"), []).append((index, event))
    confirmed, unresolved, seen_commands = [], [], set()
    for receipt in execution:
        if receipt.get("command_result") != "accepted":
            continue
        candidates = command_by_selection.get(receipt.get("selection_audit_index"), [])
        if len(candidates) != 1:
            unresolved.append({"action": receipt.get("action"), "confirmation_record_time": timestamp(receipt),
                               "reason": "accepted_receipt_has_no_unique_accepted_command"})
            continue
        index, event = candidates[0]
        when = timestamp(event)
        if when is None or when > seconds or index in seen_commands:
            continue
        seen_commands.add(index)
        preceding = _at(reports, when)
        confirmed.append({"action": receipt.get("action"), "command_time": when,
                          "emitted_ability": event.get("emitted_ability", event.get("ability")),
                          "command_loop": event.get("game_loop"), "audit_index": index,
                          "selection_audit_index": receipt.get("selection_audit_index"),
                          "confirmation_record_time": timestamp(receipt), "source_tags": event.get("source_tags", []),
                          "target_tag": event.get("unit_target_tag"), "position": event.get("effective_target"),
                          "hud_at_preceding_report": preceding.get("hud", {}),
                          "preceding_report_time": timestamp(preceding),
                          "opening_at_selection": receipt.get("opening_at_selection"),
                          "public_cost": preceding.get("action_costs", {}).get(receipt.get("action"))})
    confirmed.sort(key=lambda row: row["command_time"])

    structures, stalker_units, stalker_queues, worker_timeline = {}, {}, [], []
    for report in reports:
        when = timestamp(report)
        decision = report.get("opening", {}).get("decision", {})
        worker_timeline.append({"report_time": when, **{key: report.get("hud", {}).get(key) for key in
            ("supply_workers", "supply_used", "supply_cap", "minerals", "vespene")},
            "planned_probe_pause": decision.get("pause_probe_production"),
            "core_foundation_observed": report.get("opening", {}).get("core_foundation_observed")})
        for unit in report.get("current_own", []):
            if unit.get("current") is False or unit.get("status") in ("destroyed", "not_seen_at_visible_position"):
                continue
            kind, tag = unit.get("type"), unit.get("tag")
            if kind in STRUCTURES and tag not in structures:
                loop = unit.get("first_seen_loop")
                first_seen = loop / 22.4 if number(loop) and 0 <= loop / 22.4 <= when else None
                progress = unit.get("build_progress")
                structures[tag] = {"type": kind, "tag": tag, "position": unit.get("position"),
                    "base_index": _base(report, unit.get("position")),
                    "first_current_report_time": when, "recorded_first_seen_time": first_seen,
                    "build_progress_at_first_report": progress,
                    "observed_under_construction": number(progress) and 0 < progress < 1,
                    "starting_structure": when == 0 and unit.get("is_ready") is True}
            if kind == "STALKER" and tag not in stalker_units:
                stalker_units[tag] = {"tag": tag, "first_current_report_time": when,
                    "recorded_first_seen_loop": unit.get("first_seen_loop"), "position": unit.get("position")}
            for order in unit.get("orders", []):
                if order.get("ability_id") == 917 or order.get("ability_name") == "GATEWAYTRAIN_STALKER":
                    stalker_queues.append({"source_tag": tag, "report_time": when,
                                           "ability_id": order.get("ability_id"), "progress": order.get("progress")})

    history = {}
    chronology = {}
    for report in reports:
        for item in report.get("opening", {}).get("history", []):
            if number(item.get("observed_or_accepted_at")) and item["observed_or_accepted_at"] <= seconds:
                history.setdefault(item.get("step"), item)
        for key in ("first_probe_order", "first_stalker_order", "first_stalker_start"):
            item = report.get("chrono_opening", {}).get(key)
            if isinstance(item, dict) and timestamp(item) is not None and timestamp(item) <= seconds:
                chronology.setdefault(key, item)
    first_stalker = _first([x for x in confirmed if x["action"] == "train_stalker"])
    before = first_stalker["command_time"] if first_stalker else seconds
    optional = []
    gateway_inputs = 0
    for command in confirmed:
        if command["command_time"] >= before:
            continue
        gateway_inputs += command["action"] == "build_gateway"
        if command["action"] in OPTIONAL or command["action"] == "build_gateway" and gateway_inputs > 1:
            optional.append(command)
    core = next((item for item in history.values()
                 if item.get("action") == "build_cyberneticscore" and item.get("via") == "observed_foundation"), None)
    core_time = core["observed_or_accepted_at"] if core else None
    probes = [x for x in confirmed if x["action"] == "train_probe"]
    pause_samples = [x for x in worker_timeline if x["planned_probe_pause"] is True]
    probe_gaps = [{"from_command_time": a["command_time"], "to_command_time": b["command_time"],
                   "gap_seconds": b["command_time"] - a["command_time"]}
                  for a, b in zip(probes, probes[1:])
                  if core_time is not None and a["command_time"] >= core_time]
    invalid_input_times = sum(timestamp(row) is None for row in actions)
    timestamps = [timestamp(row) for row in actions if timestamp(row) is not None and timestamp(row) <= seconds]
    chronological = timestamps == sorted(timestamps)
    rolling, peak = deque(), 0
    for when in sorted(timestamps):
        while rolling and rolling[0] <= when - 60:
            rolling.popleft()
        rolling.append(when)
        peak = max(peak, len(rolling))
    result = {"directory": str(directory), "game_id": session.get("game_id"), "session_status": session.get("status"),
        "raw_result": session.get("result"), "opponent_race": session.get("opponent_race"),
        "difficulty": session.get("difficulty"), "seed": session.get("seed"), "map": session.get("map"),
        "requested_seconds": seconds, "last_report_time": timestamp(reports[-1]),
        "horizon_reached": (number(session.get("game_seconds")) and session["game_seconds"] >= seconds),
        "report_count": len(reports), "sources_sha256": {name: hashlib.sha256(path.read_bytes()).hexdigest()
                                                            for name, path in files.items()},
        "opening_history": list(history.values()), "observed_structures": list(structures.values()),
        "accepted_commands": confirmed, "unresolved_accepted_receipts": unresolved,
        "workers": {"timeline": worker_timeline, "first_pause_sample": _first(pause_samples),
            "last_pause_sample": pause_samples[-1] if pause_samples else None,
            "core_foundation_record": core,
            "first_confirmed_probe_after_core": _first([x for x in probes if core_time is not None and x["command_time"] >= core_time]),
            "maximum_post_core_probe_command_gap": max(probe_gaps, key=lambda x: x["gap_seconds"], default=None),
            "scope": "HUD is sampled. Command gaps alone do not establish idle Nexuses, missed production, worker deaths or an intentional cut."},
        "first_stalker": {"accepted_command": first_stalker, "current_queue_observation": _first(stalker_queues),
            "current_unit_observation": _first(list(stalker_units.values())), "recorded_chrono_evidence": chronology},
        "first_two_chronos": [x for x in confirmed if x["action"] == "chrono_boost"][:2],
        "optional_inputs_before_first_stalker": optional,
        "optional_input_counts": dict(Counter(x["action"] for x in optional)),
        "input_cap": {"recorded_inputs": len(timestamps), "peak_rolling_60s_inputs": peak,
            "within_200_inputs": peak <= 200 if not invalid_input_times else None,
            "invalid_input_timestamps": invalid_input_times, "timestamps_chronological": chronological,
            "minimum_observed_input_interval": min((b - a for a, b in zip(timestamps, timestamps[1:])), default=None),
            "scope": "All recorded input attempts count, including rejected inputs; does not reconstruct fog or prove log completeness."},
        "limitations": ["Accepted building commands do not prove a foundation started. First-seen timestamps are observations, not construction start estimates.",
            "Optional input public costs are commitments, not verified resource debits; repeated building inputs may be retries.",
            "Confirmed Chronos are accepted native commands, not independently observed buff effects.",
            "No terrain, enclosure, exit path, micro quality, opponent MMR or playing-strength verdict is inferred."]}
    return result


def compare_openings(baseline, candidate, seconds=360):
    left, right = inspect_opening(baseline, seconds), inspect_opening(candidate, seconds)

    def value(run, key):
        if key == "first_stalker_command":
            item = run["first_stalker"]["accepted_command"]
        elif key == "probe_resume_after_core":
            item = run["workers"]["first_confirmed_probe_after_core"]
        else:
            index = 0 if key == "first_chrono" else 1
            item = run["first_two_chronos"][index] if len(run["first_two_chronos"]) > index else None
        return item["command_time"] if item else None

    changes = {}
    for key in ("first_stalker_command", "probe_resume_after_core", "first_chrono", "second_chrono"):
        old, new = value(left, key), value(right, key)
        changes[key] = {"baseline": old, "candidate": new,
                        "candidate_minus_baseline_seconds": new - old if old is not None and new is not None else None}
    return {"schema": 1, "scope": "Read-only coached opening comparison; no training or promotion decision",
            "baseline": left, "candidate": right, "timing_deltas": changes,
            "condition_differences": {key: [left[key], right[key]] for key in
                ("map", "opponent_race", "difficulty", "seed") if left[key] != right[key]}}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--baseline", type=Path, required=True)
    parser.add_argument("--candidate", type=Path, required=True)
    parser.add_argument("--seconds", type=float, default=360)
    parser.add_argument("--output", type=Path, required=True)
    args = parser.parse_args()
    result = compare_openings(args.baseline, args.candidate, args.seconds)
    args.output.parent.mkdir(parents=True, exist_ok=True)
    with args.output.open("x", encoding="utf-8") as stream:
        json.dump(result, stream, indent=2, allow_nan=False)
        stream.write("\n")
    print(json.dumps({"output": str(args.output), "timing_deltas": result["timing_deltas"]}, indent=2))


if __name__ == "__main__":
    main()
