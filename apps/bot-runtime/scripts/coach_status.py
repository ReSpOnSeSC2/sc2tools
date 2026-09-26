"""Print a compact coaching view of the bot's permitted local report only."""
import argparse
from collections import Counter
import json
from pathlib import Path


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("session")
    parser.add_argument("--all-sightings", action="store_true")
    args = parser.parse_args()
    root = Path(args.session)
    report = json.loads((root / "report.json").read_text())
    now = report["time"]
    summary = {key: report.get(key) for key in (
        "game_id", "time", "report_sequence", "hud", "camera", "own_seen_counts",
        "own_unfinished_seen_counts", "pending_construction", "expansion_task",
        "action_counts", "fairplay", "finished", "error", "telemetry_write_errors")}
    summary["strategy"] = {key: report["strategist"].get(key) for key in (
        "last_status", "diagnostic", "accepted_revision", "active_revision")}
    summary["bases_last_seen"] = [{key: unit.get(key) for key in (
        "position", "is_ready", "assigned_harvesters", "ideal_harvesters", "last_seen_seconds")}
        for unit in report["own_memory"] if unit["type"] == "NEXUS"]
    summary["enemy_current_counts"] = dict(Counter(unit["type"] for unit in report["current_enemies"]))
    summary["enemy_last_seen_counts"] = dict(Counter(unit["type"] for unit in report["enemy_memory"]))
    summary["enemy_sightings"] = [{"type": unit["type"], "position": unit["position"],
        "last_seen_seconds": unit["last_seen_seconds"], "age_seconds": round(now - unit["last_seen_seconds"], 1)}
        for unit in report["enemy_memory"]
        if args.all_sightings or unit["is_structure"] or
        (unit["type"] not in {"SCV", "PROBE", "DRONE"} and now - unit["last_seen_seconds"] <= 30)]
    print(json.dumps(summary, indent=2))


if __name__ == "__main__":
    main()
