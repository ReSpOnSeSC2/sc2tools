"""Build-order CLI used by the Node analyzer at localhost:3000/analyzer.

This CLI extracts the OPPONENT's first-5-min build order from a single
.SC2Replay file (and optionally the user's, for parity). The Node side
calls it on demand from the opponent-card view so the per-game build-
order timeline can show the OPPONENT's build instead of the user's.

The user's `build_log` is captured at replay-watch time and stored in
meta_database.json, but historically the opponent's events were dropped
on the floor after strategy detection. This CLI lets the SPA back-fill
that information for any game whose `file_path` is still on disk.

Subcommands
-----------

    extract --replay PATH [--player NAME] [--cutoff-sec N]
        Parse a single replay and emit one JSON object containing both
        the user's and opponent's build-log lines (whole-game) plus an
        early slice (cutoff seconds, default 300):
            {
              "ok": true,
              "my_race":  "Protoss",
              "opp_race": "Terran",
              "opp_name": "Dephy",
              "build_log":           [...],
              "early_build_log":     [...],
              "opp_build_log":       [...],
              "opp_early_build_log": [...]
            }

        --player picks the user's row in the replay's player list. If
        omitted, falls back to the only human (1v1 case).

    backfill --db PATH [--player NAME] [--limit N] [--force]
        Walk meta_database.json and add `opp_build_log` /
        `opp_early_build_log` to every game with a reachable
        `file_path` that doesn't have them yet. Streams progress
        records and a final result line.

Exit codes: 0 on success, 1 on usage error, 2 on runtime error.
The CLI never prints to stderr unless something is genuinely wrong, so
the Node side can pipe stdout straight into a JSON parser.
"""
from __future__ import annotations

import argparse
import json
import os
import sys
from typing import Any, Dict, List, Optional

# Project root on sys.path so 'core' imports.
_HERE = os.path.dirname(os.path.abspath(__file__))
_ROOT = os.path.dirname(_HERE)
if _ROOT not in sys.path:
    sys.path.insert(0, _ROOT)


def _emit(obj: Dict[str, Any]) -> None:
    sys.stdout.write(json.dumps(obj, default=str) + "\n")
    sys.stdout.flush()


def _match_me(replay, target: str):
    """Best-effort match of `target` against a replay's player list."""
    target_low = (target or "").lower()
    if target:
        for p in replay.players:
            if getattr(p, "name", None) == target:
                return p
        for p in replay.players:
            pname = (getattr(p, "name", "") or "").lower()
            if target_low and (target_low in pname or pname in target_low):
                return p
    humans = [
        p for p in replay.players
        if getattr(p, "is_human", True)
        and not getattr(p, "is_observer", False)
        and not getattr(p, "is_referee", False)
    ]
    if len(humans) == 1:
        return humans[0]
    return None


def _opponent_of(replay, me):
    """Return the other human/AI player that isn't `me`."""
    if me is None:
        return None
    for p in replay.players:
        if getattr(p, "pid", None) == getattr(me, "pid", None):
            continue
        if getattr(p, "is_observer", False) or getattr(p, "is_referee", False):
            continue
        return p
    return None


def _extract_for_replay(file_path: str, player_name: str,
                        cutoff_sec: int = 300) -> Dict[str, Any]:
    """Parse one replay, return both build logs + metadata."""
    # sc2reader is the canonical loader the rest of the pipeline uses;
    # importing here keeps the CLI's startup cost off the hot path.
    import sc2reader  # type: ignore
    from core.event_extractor import extract_events, build_log_lines

    replay = sc2reader.load_replay(file_path, load_level=4)
    me = _match_me(replay, player_name or "")
    if me is None:
        raise RuntimeError(
            f"Could not match player '{player_name}' in {file_path}"
        )
    opp = _opponent_of(replay, me)
    my_events, opp_events, _ = extract_events(replay, me.pid)

    my_full  = build_log_lines(my_events,  cutoff_seconds=None,        dedupe_units=False)
    my_early = build_log_lines(my_events,  cutoff_seconds=cutoff_sec,  dedupe_units=False)
    # Opponent's lines are deduped so the timeline shows real milestones
    # (buildings, upgrades, first-of-each-unit) instead of N zergling lines.
    opp_full  = build_log_lines(opp_events, cutoff_seconds=None,       dedupe_units=True)
    opp_early = build_log_lines(opp_events, cutoff_seconds=cutoff_sec, dedupe_units=True)

    return {
        "my_race":  getattr(me,  "play_race", None) or getattr(me,  "race", None),
        "opp_race": getattr(opp, "play_race", None) or getattr(opp, "race", None) if opp else None,
        "my_name":  getattr(me,  "name", None),
        "opp_name": getattr(opp, "name", None) if opp else None,
        "build_log":           my_full,
        "early_build_log":     my_early,
        "opp_build_log":       opp_full,
        "opp_early_build_log": opp_early,
    }


def cmd_extract(args) -> int:
    if not args.replay or not os.path.isfile(args.replay):
        _emit({"ok": False, "error": "replay file not found"})
        return 2
    try:
        cutoff = int(args.cutoff_sec or 300)
        result = _extract_for_replay(args.replay, args.player or "", cutoff_sec=cutoff)
        _emit({"ok": True, **result})
        return 0
    except Exception as exc:  # pragma: no cover
        _emit({"ok": False, "error": str(exc)})
        return 2


def _load_db(db_path: str) -> Dict[str, Any]:
    if not os.path.isfile(db_path):
        return {}
    with open(db_path, "r", encoding="utf-8") as f:
        return json.load(f) or {}


def _save_db(db_path: str, db: Dict[str, Any]) -> None:
    tmp = db_path + ".tmp"
    with open(tmp, "w", encoding="utf-8") as f:
        json.dump(db, f, indent=2, default=str)
    os.replace(tmp, db_path)


def cmd_backfill(args) -> int:
    db_path = args.db
    if not db_path or not os.path.isfile(db_path):
        _emit({"ok": False, "error": "DB file not found"})
        return 2
    db = _load_db(db_path)
    force = bool(getattr(args, "force", False))
    todo: List[Any] = []
    skipped = 0
    for build_name, bd in db.items():
        if not isinstance(bd, dict):
            continue
        for g in bd.get("games", []) or []:
            has_opp = isinstance(g.get("opp_early_build_log"), list) \
                  and len(g.get("opp_early_build_log") or []) > 0
            fp = g.get("file_path")
            if not fp or not os.path.isfile(fp):
                skipped += 1
                continue
            if not force and has_opp:
                skipped += 1
                continue
            todo.append((build_name, g))

    if args.limit and int(args.limit) > 0:
        todo = todo[: int(args.limit)]

    total = len(todo)
    updated = 0
    errors = 0
    cutoff = int(getattr(args, "cutoff_sec", 0) or 300)
    for i, (_build, g) in enumerate(todo, start=1):
        try:
            res = _extract_for_replay(g.get("file_path"), args.player or "", cutoff_sec=cutoff)
            g["opp_build_log"]       = res["opp_build_log"]
            g["opp_early_build_log"] = res["opp_early_build_log"]
            updated += 1
            _emit({"progress": {"i": i, "total": total,
                                "id": g.get("id"), "ok": True}})
        except Exception as exc:
            errors += 1
            _emit({"progress": {"i": i, "total": total,
                                "id": g.get("id"), "ok": False,
                                "error": str(exc)}})

    _save_db(db_path, db)
    _emit({"ok": True, "result": {
        "processed": total, "updated": updated,
        "skipped": skipped, "errors": errors,
    }})
    return 0


def main(argv: Optional[List[str]] = None) -> int:
    parser = argparse.ArgumentParser(prog="buildorder_cli")
    sub = parser.add_subparsers(dest="cmd", required=True)

    p_extract = sub.add_parser("extract", help="Extract opp build log from a replay")
    p_extract.add_argument("--replay", required=True)
    p_extract.add_argument("--player", default="")
    p_extract.add_argument("--cutoff-sec", type=int, default=300, dest="cutoff_sec")
    p_extract.set_defaults(fn=cmd_extract)

    p_back = sub.add_parser("backfill", help="Backfill opp_build_log for all games")
    p_back.add_argument("--db", required=True)
    p_back.add_argument("--player", default="")
    p_back.add_argument("--limit", type=int, default=0)
    p_back.add_argument("--force", action="store_true")
    p_back.add_argument("--cutoff-sec", type=int, default=300, dest="cutoff_sec")
    p_back.set_defaults(fn=cmd_backfill)

    args = parser.parse_args(argv)
    return args.fn(args)


if __name__ == "__main__":
    sys.exit(main())
