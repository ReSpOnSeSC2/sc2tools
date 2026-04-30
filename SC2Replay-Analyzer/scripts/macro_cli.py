"""Macro-score CLI used by the Node-backed analyzer at localhost:3000/analyzer.

Two subcommands let the SPA compute or backfill macro scores without
re-implementing the parser in JavaScript.

Subcommands
-----------

    compute    --replay PATH --player NAME [--length-sec N]
        Parse a single .SC2Replay file, run the macro engine for the named
        player, print one JSON object with the full breakdown:
            {
              "ok": true,
              "macro_score": 73,
              "race": "Protoss",
              "game_length_sec": 812,
              "raw": {...},
              "all_leaks": [...],
              "top_3_leaks": [...]
            }

    backfill   --db PATH --player NAME [--limit N] [--force]
        Walk every game in the meta_database.json file. For any game that's
        missing a macro_score (or has no macro_breakdown stored), re-parse
        the replay file and write the macro fields back to the DB. Streams
        one ``{"progress": ...}`` JSON line per processed replay, then a
        final ``{"result": ...}`` line. Exits 0 on completion.

        ``--force`` re-parses every game with a reachable replay file even
        if it already has a macro_score and macro_breakdown stored. Use
        this after the macro engine has changed (e.g. fixed chrono/inject/
        MULE counting) so previously-stored breakdowns get refreshed.

Exit codes: 0 on success, 1 on usage error, 2 on runtime error.
The CLI never prints to stderr unless something is genuinely wrong, so the
Node side can pipe stdout straight into a JSON parser.
"""
from __future__ import annotations

import argparse
import json
import os
import sys
from typing import Any, Dict, Optional

# Project root on sys.path so 'core', 'analytics', etc. import.
_HERE = os.path.dirname(os.path.abspath(__file__))
_ROOT = os.path.dirname(_HERE)
if _ROOT not in sys.path:
    sys.path.insert(0, _ROOT)


def _eprint(msg: str) -> None:
    print(msg, file=sys.stderr, flush=True)


def _emit(obj: Dict[str, Any]) -> None:
    """Write one newline-delimited JSON record to stdout."""
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


def _compute_for_replay(file_path: str, player_name: str) -> Dict[str, Any]:
    """Parse one replay and return a full breakdown dict."""
    from analytics.macro_score import compute_macro_score
    from core.event_extractor import extract_macro_events
    from core.replay_loader import load_replay_with_fallback

    replay = load_replay_with_fallback(file_path)
    me = _match_me(replay, player_name)
    if me is None:
        raise RuntimeError(f"Player '{player_name}' not found in replay.")
    length = getattr(replay, "game_length", None)
    length_sec = length.seconds if length else 0
    # Auto-detect opp_pid: the OTHER human player in the replay (skip
    # observers, computers, and the user). Falls back to None when the
    # replay only has one human, in which case extract_macro_events
    # returns empty opp data and the chart silently degrades to one-side.
    opp_pid = None
    for player in (getattr(replay, "players", None) or []):
        if not getattr(player, "is_human", False):
            continue
        ppid = getattr(player, "pid", None)
        if ppid is None or ppid == me.pid:
            continue
        opp_pid = ppid
        break
    macro_events = extract_macro_events(replay, me.pid, opp_pid)
    result = compute_macro_score(macro_events, me.play_race, length_sec)
    return {
        "macro_score": result.get("macro_score"),
        "race": me.play_race,
        "game_length_sec": length_sec,
        "raw": result.get("raw", {}) or {},
        "all_leaks": result.get("all_leaks", []) or [],
        "top_3_leaks": result.get("top_3_leaks", []) or [],
        # PlayerStatsEvent samples for army/worker/supply chart in the
        # MacroBreakdownPanel. Empty list for older replays whose tracker
        # stream is missing PlayerStatsEvent rows.
        "stats_events": result.get("stats_events", []) or [],
        # Same shape, but for the opponent. Empty when no human opp_pid
        # was found (e.g. vs AI).
        "opp_stats_events": result.get("opp_stats_events", []) or [],
        # Sampled alive-unit counts for both players keyed by canonical
        # name. Drives the Unit Roster panel that appears below the
        # chart on hover.
        "unit_timeline": result.get("unit_timeline", []) or [],
    }


def cmd_compute(args) -> int:
    if not args.replay or not os.path.isfile(args.replay):
        _emit({"ok": False, "error": "replay file not found"})
        return 2
    try:
        breakdown = _compute_for_replay(args.replay, args.player or "")
        _emit({"ok": True, **breakdown})
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
    """Atomic write so a crash mid-flush doesn't truncate the DB."""
    tmp = db_path + ".tmp"
    with open(tmp, "w", encoding="utf-8") as f:
        json.dump(db, f, indent=2, default=str)
        f.flush()
        os.fsync(f.fileno())
    os.replace(tmp, db_path)


def cmd_backfill(args) -> int:
    db_path = args.db
    if not db_path or not os.path.isfile(db_path):
        _emit({"ok": False, "error": "DB file not found"})
        return 2
    db = _load_db(db_path)
    if not db:
        _emit({"ok": True, "result": {"processed": 0, "updated": 0,
                                       "skipped": 0, "errors": 0}})
        return 0

    # Build a flat work list. Two modes:
    #   normal:  games that lack macro_score OR macro_breakdown (and have
    #            a reachable file_path) -- this is the cheap incremental
    #            backfill for newly-added replays.
    #   --force: every game with a reachable file_path, regardless of
    #            stored state. Use after the macro engine itself changes.
    force = bool(getattr(args, "force", False))
    todo = []
    skipped = 0
    for build_name, bd in db.items():
        if not isinstance(bd, dict):
            continue
        for g in bd.get("games", []) or []:
            has_score = isinstance(g.get("macro_score"), (int, float))
            has_breakdown = isinstance(g.get("macro_breakdown"), dict)
            fp = g.get("file_path")
            if not fp or not os.path.isfile(fp):
                skipped += 1
                continue
            if not force and has_score and has_breakdown:
                skipped += 1
                continue
            todo.append((build_name, g))

    if args.limit and args.limit > 0:
        todo = todo[: int(args.limit)]

    total = len(todo)
    if total == 0:
        _emit({"ok": True, "result": {
            "processed": 0, "updated": 0, "skipped": skipped, "errors": 0,
            "total_in_db": sum(
                len(bd.get("games", []) or [])
                for bd in db.values() if isinstance(bd, dict)
            ),
        }})
        return 0

    updated = 0
    errors = 0
    SAVE_EVERY = 25
    for i, (bname, g) in enumerate(todo, start=1):
        fp = g.get("file_path")
        try:
            br = _compute_for_replay(fp, args.player or "")
            # Persist a SLIM macro_breakdown — exclude the bulk per-sample
            # arrays (stats_events, opp_stats_events, unit_timeline) so
            # the meta DB does not balloon past Node's 0x1fffffe8 max
            # string length on large libraries. The /macro-breakdown
            # endpoint recomputes them fresh on demand.
            g["macro_score"] = br["macro_score"]
            g["top_3_leaks"] = br.get("top_3_leaks") or []
            g["macro_breakdown"] = {
                "score": br.get("macro_score"),
                "race": br.get("race"),
                "game_length_sec": br.get("game_length_sec", 0),
                "raw": br.get("raw", {}) or {},
                "all_leaks": br.get("all_leaks", []) or [],
                "top_3_leaks": br.get("top_3_leaks", []) or [],
            }
            updated += 1
        except Exception as exc:
            errors += 1
            _emit({"progress": {
                "i": i, "total": total, "file": os.path.basename(fp or ""),
                "build": bname, "ok": False, "error": str(exc),
            }})
            continue
        _emit({"progress": {
            "i": i, "total": total, "file": os.path.basename(fp or ""),
            "build": bname, "ok": True, "score": br.get("macro_score"),
        }})
        if i % SAVE_EVERY == 0:
            try:
                _save_db(db_path, db)
            except Exception as exc:  # pragma: no cover
                errors += 1
                _emit({"progress": {"i": i, "total": total,
                                     "ok": False, "error": f"save failed: {exc}"}})

    try:
        _save_db(db_path, db)
    except Exception as exc:
        _emit({"ok": False, "error": f"final save failed: {exc}"})
        return 2

    _emit({"result": {
        "processed": total, "updated": updated, "skipped": skipped,
        "errors": errors,
    }})
    return 0


def main(argv: Optional[list] = None) -> int:
    parser = argparse.ArgumentParser(
        prog="macro_cli", description="Macro-score CLI for the SPA backend."
    )
    sub = parser.add_subparsers(dest="cmd", required=True)

    p_compute = sub.add_parser("compute", help="Compute macro for one replay.")
    p_compute.add_argument("--replay", required=True, help="Path to .SC2Replay file.")
    p_compute.add_argument("--player", default="", help="Player name to score.")
    p_compute.set_defaults(func=cmd_compute)

    p_backfill = sub.add_parser("backfill", help="Backfill macro for every game.")
    p_backfill.add_argument("--db", required=True, help="Path to meta_database.json.")
    p_backfill.add_argument("--player", default="", help="Player name to score.")
    p_backfill.add_argument("--limit", type=int, default=0,
                            help="Stop after N replays (0 = no limit).")
    p_backfill.add_argument("--force", action="store_true",
                            help="Re-parse every reachable replay even if its "
                                 "macro_score/breakdown are already stored. "
                                 "Use after macro engine changes.")
    p_backfill.set_defaults(func=cmd_backfill)

    args = parser.parse_args(argv)
    try:
        return args.func(args)
    except KeyboardInterrupt:
        return 130
    except Exception as exc:  # pragma: no cover
        _emit({"ok": False, "error": f"runtime error: {exc}"})
        return 2


if __name__ == "__main__":
    sys.exit(main())
