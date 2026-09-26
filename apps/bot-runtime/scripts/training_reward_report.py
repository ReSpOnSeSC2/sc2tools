"""Read committed league matches only and report behavioral/reward diagnostics.

Uses state.json snapshot references as the commit boundary. Checkpoint hashes
are compared between the committed entry and match record; large model files
are not deserialized or rehashed. No training config, corpus or job is changed.
"""
from __future__ import annotations

import argparse
from collections import Counter
from datetime import datetime, timezone
import json
import math
from pathlib import Path
import re


RACES = ("Protoss", "Terran", "Zerg")


def committed_matches(league: Path) -> tuple[dict, list[dict], list[dict]]:
    league = league.resolve()
    state = json.loads((league / "state.json").read_text(encoding="utf-8"))
    records, errors, seen = [], [], set()
    for race in RACES:
        for entry in state.get("snapshots", {}).get(race, []):
            path = Path(str(entry.get("path", "")).replace("\\", "/"))
            if path.parts and path.parts[0] == "initial":
                continue
            try:
                checkpoint = (league / path).resolve()
                relative = checkpoint.relative_to(league)
                if len(relative.parts) != 3 or relative.parts[0] != "matches" or relative.name != "learner.pt":
                    raise ValueError("Snapshot is not a committed match checkpoint path")
                game = int(relative.parent.name.split("-", 1)[0])
                if game < 1 or game > state["games"] or game in seen:
                    raise ValueError("Duplicate or out-of-range committed game")
                digest = entry.get("sha256", "")
                if not isinstance(digest, str) or not re.fullmatch(r"[0-9a-f]{64}", digest):
                    raise ValueError("Committed checkpoint hash is missing or invalid")
                if not checkpoint.is_file():
                    raise ValueError("Committed checkpoint file is missing")
                match_path = checkpoint.parent / "match.json"
                record = json.loads(match_path.read_text(encoding="utf-8"))
                if record.get("checkpoint_sha256") != digest or record.get("learner_race") != race:
                    raise ValueError("Match hash or learner race disagrees with committed snapshot")
                seen.add(game)
                records.append({"game": game, "race": race, "match_path": str(match_path), "record": record})
            except (OSError, ValueError, KeyError, TypeError) as error:
                errors.append({"race": race, "snapshot": str(path), "error": str(error)})
    return state, sorted(records, key=lambda item: item["game"]), errors


def _numbers(value: dict) -> dict:
    return {str(key): number for key, number in value.items()
            if not isinstance(number, bool) and isinstance(number, (int, float)) and math.isfinite(number)}


def _summary(matches: list[dict]) -> dict:
    actions, outcomes, engine_outcomes, components, raw_components = (Counter() for _ in range(5))
    events, signals, profiles, opponents = (Counter() for _ in range(4))
    terminal_total = auxiliary_total = 0.0
    reward_reports = 0
    for match in matches:
        record = match["record"]
        policy = record.get("policy_actions") or [{}]
        actions.update(_numbers(policy[0]))
        results = record.get("results") or ["Unknown"]
        engine_results = record.get("engine_results") or results
        outcomes["TimeLimit" if record.get("time_limit_reached") else results[0]] += 1
        engine_outcomes[engine_results[0]] += 1
        breakdown = (record.get("reward_breakdown") or [None])[0]
        config = record.get("reward_config") or (breakdown or {}).get("config") or {}
        profiles[config.get("version", "legacy-potential")] += 1
        opponents[record.get("opponent_race", "Unknown")] += 1
        if isinstance(breakdown, dict):
            reward_reports += 1
            components.update(_numbers(breakdown.get("components", {})))
            raw_components.update(_numbers(breakdown.get("raw_components", {})))
            events.update(_numbers(breakdown.get("event_counts", {})))
            signals.update(_numbers(breakdown.get("signal_totals", {})))
            terminal_total += _numbers({"value": breakdown.get("terminal_reward")}).get("value", 0)
            auxiliary_total += _numbers({"value": breakdown.get("auxiliary_used")}).get("value", 0)
    total = sum(actions.values())
    gameplay = sum(value for key, value in actions.items() if key != "no_op" and not key.startswith("camera_"))
    non_navigation = gameplay - actions.get("scout", 0)
    return {"games": len(matches), "first_game": matches[0]["game"] if matches else None,
            "last_game": matches[-1]["game"] if matches else None,
            "outcomes": dict(outcomes), "engine_outcomes": dict(engine_outcomes), "opponent_races": dict(opponents),
            "reward_profiles": dict(profiles), "policy_actions": dict(actions), "policy_decisions": total,
            "gameplay_fraction": gameplay / total if total else None,
            "non_navigation_fraction": non_navigation / total if total else None,
            "reward_reports": reward_reports, "reward_component_totals": dict(components),
            "raw_reward_component_totals": dict(raw_components), "raw_event_counts": dict(events),
            "raw_signal_totals": dict(signals), "terminal_reward_total": terminal_total,
            "absolute_auxiliary_budget_used": auxiliary_total, "measured_mmr": None}


def report(league: str | Path, last: int = 30, race: str | None = None) -> dict:
    if type(last) is not int or last < 1 or race not in (*RACES, None):
        raise ValueError("last must be positive and race must be a supported learner")
    state, committed, errors = committed_matches(Path(league))
    eligible = [match for match in committed if race is None or match["race"] == race]
    selected = eligible[-last:]
    by_race = {name: _summary([match for match in selected if match["race"] == name]) for name in RACES}
    by_profile = {}
    for match in selected:
        record = match["record"]
        breakdown = (record.get("reward_breakdown") or [None])[0]
        profile = (record.get("reward_config") or (breakdown or {}).get("config") or {}).get("version", "legacy-potential")
        by_profile.setdefault(profile, []).append(match)
    guidance = []
    for name, stats in by_race.items():
        if stats["games"] and stats["non_navigation_fraction"] is not None and stats["non_navigation_fraction"] < .05:
            guidance.append(f"{name}: fewer than 5% of choices are non-navigation gameplay; inspect production and action masks.")
        if stats["games"] and stats["outcomes"].get("Victory", 0) == 0:
            guidance.append(f"{name}: no wins in this selected training window; no strength gain established.")
    if errors:
        guidance.append("Some committed records failed metadata integrity checks; investigate before claiming their results.")
    return {"generated_at": datetime.now(timezone.utc).isoformat(), "league": str(Path(league).resolve()),
            "committed_state_games": state.get("games"), "verified_metadata_matches": len(committed),
            "selection": {"last": last, "race": race, "scope": "latest committed matches across selected races"},
            "selected_games": [match["game"] for match in selected], "integrity_errors": errors,
            "integrity_method": "Committed snapshot path exists; match checkpoint hash equals state hash. Model bytes are not rehashed.",
            "overall": _summary(selected), "by_race": by_race,
            "by_reward_profile": {key: _summary(value) for key, value in by_profile.items()},
            "guidance": guidance, "measured_mmr": None,
            "caveats": ["Policy choices are attempts, not proof of successful production or damage.",
                        "Reward profiles are separated because their scales are not directly comparable.",
                        "Training opponents and shaped rewards do not measure ladder MMR.",
                        "Time-limit outcomes are reported separately from actual engine wins/losses."]}


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--league", required=True)
    parser.add_argument("--last", type=int, default=30)
    parser.add_argument("--race", choices=RACES)
    parser.add_argument("--output")
    args = parser.parse_args()
    result = report(args.league, args.last, args.race)
    rendered = json.dumps(result, indent=2, allow_nan=False) + "\n"
    if args.output:
        destination = Path(args.output).resolve()
        if destination.suffix.lower() != ".json":
            parser.error("report output must be a new .json file")
        with destination.open("x", encoding="utf-8") as stream:
            stream.write(rendered)
    else:
        print(rendered, end="")


if __name__ == "__main__":
    main()
