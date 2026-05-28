"""Bulk-import historical replays from a folder, in parallel.

Walks a directory for ``.SC2Replay`` files (recursively), filters by
modification time against an optional date range, then dispatches each
file to a ``ProcessPoolExecutor`` worker that runs the same parse
pipeline as the live watcher (build-order + opp strategy + macro
score + slim macro_breakdown). The parent process aggregates the
worker results and atomically persists ``meta_database.json``.

Designed for "production quality" use:

    * **Parallel** — ``min(--workers, cpu_count())`` workers, defaults
      to ``min(8, cpu_count())``. Pass ``--workers 0`` to use ALL cores.
    * **Resumable** — state is checkpointed to ``--state-path`` every
      ``CHECKPOINT_EVERY`` completions plus on graceful shutdown.
      Re-running with ``--resume`` skips already-processed paths.
    * **Bounded memory** — a worker only holds ONE replay at a time;
      the parent never accumulates raw replay objects.
    * **Atomic writes** — every persist goes through a ``.tmp`` rename
      (the standard pattern for the data/ directory).
    * **NDJSON progress** — one ``{"progress": ...}`` line per finished
      replay so the Express layer can stream events to the SPA.
    * **Idempotent** — uses ``game_id`` (date|opp|map|len) for dedup.
      Re-importing an already-known replay is a no-op.

CLI::

    python scripts/bulk_import_cli.py \\
        --folder PATH \\
        --player NAME \\
        [--since-iso YYYY-MM-DD] [--until-iso YYYY-MM-DD] \\
        [--workers N] [--state-path PATH] [--resume] \\
        [--db PATH] [--limit N]

Exit codes: 0 on success, 1 on usage error, 2 on runtime error,
130 on Ctrl+C / SIGTERM (state is saved before exit).

Example::

    python scripts/bulk_import_cli.py \\
        --folder "C:/Users/me/Documents/StarCraft II/.../Replays/Multiplayer" \\
        --player "ReSpOnSe" \\
        --since-iso 2026-01-01 \\
        --workers 8 \\
        --db reveal-sc2-opponent-main/data/meta_database.json
"""
from __future__ import annotations

import argparse
import json
import os
import signal
import sys
import time
from concurrent.futures import ProcessPoolExecutor, as_completed
from datetime import datetime, timezone
from typing import Any, Dict, Iterable, List, Optional, Set, Tuple

# Project root on sys.path so 'core', 'analytics', etc. import.
_HERE = os.path.dirname(os.path.abspath(__file__))
_ROOT = os.path.dirname(_HERE)
if _ROOT not in sys.path:
    sys.path.insert(0, _ROOT)

# Constants
DEFAULT_WORKER_CAP = 8
CHECKPOINT_EVERY = 25
PERSIST_EVERY = 25
REPLAY_GLOB_SUFFIX = ".SC2Replay"


def _eprint(msg: str) -> None:
    print(msg, file=sys.stderr, flush=True)


def _emit(obj: Dict[str, Any]) -> None:
    """One newline-delimited JSON record on stdout."""
    sys.stdout.write(json.dumps(obj, default=str) + "\n")
    sys.stdout.flush()


def _atomic_write_json(path: str, payload: Any) -> None:
    """Write JSON atomically: tmp → fsync → rename."""
    tmp = path + ".tmp"
    with open(tmp, "w", encoding="utf-8") as f:
        json.dump(payload, f, indent=2, default=str, ensure_ascii=False)
        f.flush()
        os.fsync(f.fileno())
    os.replace(tmp, path)


def _load_json_or(path: str, default: Any) -> Any:
    if not path or not os.path.isfile(path):
        return default
    try:
        with open(path, "r", encoding="utf-8") as f:
            return json.load(f) or default
    except Exception:
        return default


def _parse_iso_date(s: Optional[str]) -> Optional[float]:
    """Parse 'YYYY-MM-DD' or full ISO-8601 into a unix timestamp."""
    if not s:
        return None
    try:
        if "T" in s:
            dt = datetime.fromisoformat(s.replace("Z", "+00:00"))
        else:
            dt = datetime.strptime(s, "%Y-%m-%d").replace(tzinfo=timezone.utc)
        return dt.timestamp()
    except Exception as exc:
        raise ValueError(f"bad date '{s}': {exc}")


def _resolve_worker_count(requested: int) -> int:
    """Pick worker count.

    requested == 0  → use all cores.
    requested  < 0  → use default (min(DEFAULT_WORKER_CAP, cpu_count)).
    requested  > 0  → cap at cpu_count.
    """
    cores = os.cpu_count() or 1
    if requested == 0:
        return cores
    if requested < 0:
        return min(DEFAULT_WORKER_CAP, cores)
    return max(1, min(int(requested), cores))


def _walk_replays(folder: str) -> Iterable[str]:
    """Yield absolute paths of every .SC2Replay under folder, recursively."""
    for root, _dirs, files in os.walk(folder):
        for name in files:
            if name.lower().endswith(REPLAY_GLOB_SUFFIX.lower()):
                yield os.path.abspath(os.path.join(root, name))


def _filter_by_mtime(paths: List[str], since: Optional[float],
                     until: Optional[float]) -> List[str]:
    """Drop paths whose mtime is outside [since, until]."""
    if since is None and until is None:
        return list(paths)
    out: List[str] = []
    for p in paths:
        try:
            mt = os.path.getmtime(p)
        except OSError:
            continue
        if since is not None and mt < since:
            continue
        if until is not None and mt > until:
            continue
        out.append(p)
    return out


def _load_state(state_path: str) -> Dict[str, Any]:
    return _load_json_or(state_path, {
        "version": 1, "running": False, "started_at": None,
        "finished_at": None, "folder": None, "since": None, "until": None,
        "workers": 0, "total": 0, "completed": 0, "errors": 0,
        "processed_paths": [],
    })


def _save_state(state_path: str, state: Dict[str, Any]) -> None:
    if state_path:
        _atomic_write_json(state_path, state)


def _index_existing_paths(db: Dict[str, Any]) -> Set[str]:
    """Return the set of file_paths already represented in the meta DB."""
    seen: Set[str] = set()
    for bd in db.values():
        if not isinstance(bd, dict):
            continue
        for g in bd.get("games", []) or []:
            fp = g.get("file_path")
            if fp:
                seen.add(os.path.normcase(os.path.abspath(fp)))
    return seen


def _merge_game(db: Dict[str, Any], my_build: str, game: Dict[str, Any]) -> bool:
    """Insert a parsed game into the keyed-by-build DB. Returns True if new."""
    bd = db.setdefault(my_build, {"games": []})
    games = bd.setdefault("games", [])
    target_id = game.get("id")
    for existing in games:
        if existing.get("id") == target_id:
            return False
    games.append(game)
    return True


def _scan(folder: str, since: Optional[float],
          until: Optional[float]) -> List[str]:
    """Walk + filter; returns absolute paths sorted by mtime ascending."""
    raw = list(_walk_replays(folder))
    filtered = _filter_by_mtime(raw, since, until)
    filtered.sort(key=lambda p: os.path.getmtime(p))
    return filtered


def _emit_progress(i: int, total: int, path: str, ok: bool,
                   message: str = "", build: str = "") -> None:
    _emit({"progress": {
        "i": i, "total": total,
        "file": os.path.basename(path or ""),
        "build": build, "ok": ok, "message": message,
    }})


def cmd_scan(args) -> int:
    """Count replays in scope, split into new vs already-imported.

    The SPA uses this to set expectations before the user clicks
    Start: "X new, Y already imported, Z total" reads much better
    than a bare candidate_count, especially when a folder is fully
    in sync (the import would otherwise complete silently with 0/0).
    """
    folder = args.folder
    if not folder or not os.path.isdir(folder):
        _emit({"ok": False, "error": "folder not found"})
        return 2
    since = _parse_iso_date(args.since_iso)
    until = _parse_iso_date(args.until_iso)
    paths = _scan(folder, since, until)
    db_path = args.db or ""
    db = _load_json_or(db_path, {}) if db_path else {}
    seen = _index_existing_paths(db)
    new_count = 0
    dup_count = 0
    for p in paths:
        if os.path.normcase(p) in seen:
            dup_count += 1
        else:
            new_count += 1
    _emit({
        "ok": True,
        "folder": folder,
        "since": args.since_iso,
        "until": args.until_iso,
        "candidate_count": len(paths),
        "new_count": new_count,
        "already_imported_count": dup_count,
    })
    return 0


def _import_one(parent_state: Dict[str, Any], db: Dict[str, Any],
                seen: Set[str], result: Dict[str, Any]) -> Tuple[bool, str]:
    """Apply one worker result to db + state. Returns (ok, message)."""
    if result.get("status") != "success":
        err = result.get("error") or "parse failed"
        return False, err
    my_build = result.get("my_build") or "Unsorted"
    game = result.get("data") or {}
    fp = (game.get("file_path") or "").strip()
    if fp:
        seen.add(os.path.normcase(os.path.abspath(fp)))
    inserted = _merge_game(db, my_build, game)
    parent_state["processed_paths"].append(fp)
    return True, "inserted" if inserted else "duplicate (skipped)"


def _persist_db(db_path: str, db: Dict[str, Any]) -> None:
    if db_path:
        _atomic_write_json(db_path, db)


def _setup_signal_handlers(stop_flag: List[bool]) -> None:
    def _handler(signum, _frame):
        stop_flag[0] = True
        _emit({"signal": int(signum)})
    try:
        signal.signal(signal.SIGINT, _handler)
        signal.signal(signal.SIGTERM, _handler)
    except (ValueError, OSError):
        pass



def _identity_worker(file_path):
    """Worker: extract (name, toon_handle, region) tuples from one replay.

    Loads at the cheapest level that exposes the player list (sc2reader
    handles header parsing at load_level=1). Returns a list of dicts
    for non-observer/non-referee human players. Empty list on parse
    failure -- the parent skips silently.
    """
    from core.replay_loader import load_replay_with_fallback
    try:
        replay = load_replay_with_fallback(file_path)
    except Exception:
        return []
    out = []
    for p in getattr(replay, "players", None) or []:
        if getattr(p, "is_observer", False) or getattr(p, "is_referee", False):
            continue
        if not getattr(p, "is_human", True):
            continue
        name = (getattr(p, "name", "") or "").strip()
        toon = (getattr(p, "toon_handle", "") or "").strip()
        if not name and not toon:
            continue
        # toon_handle is "region-S2-realm-id"; pull the region prefix
        # so the SPA can label "Americas / Europe / Korea" sensibly.
        region = ""
        if toon and "-" in toon:
            region_code = toon.split("-", 1)[0]
            region = {"1": "us", "2": "eu", "3": "kr",
                      "5": "cn", "6": "sea"}.get(region_code, "")
        out.append({"name": name, "character_id": toon, "region": region})
    return out


def _identity_aggregate(rows):
    """Bucket worker rows into unique (name, character_id, region) tuples."""
    counts = {}
    for row in rows:
        key = (row["name"], row["character_id"])
        if key not in counts:
            counts[key] = {**row, "count": 0}
        counts[key]["count"] += 1
    return sorted(counts.values(), key=lambda r: -r["count"])


def cmd_extract_identities(args) -> int:
    """Discover (name, character_id) candidates in a folder.

    Walks the folder, parses each replay at minimum load level, and
    returns every unique (name, character_id) tuple seen across all
    non-observer/non-referee humans. The SPA uses this to surface a
    "Pick which of these are you" picker for new servers that haven't
    been onboarded yet.
    """
    folder = args.folder
    if not folder or not os.path.isdir(folder):
        _emit({"ok": False, "error": "folder not found"})
        return 2
    since = _parse_iso_date(args.since_iso)
    until = _parse_iso_date(args.until_iso)
    paths = _scan(folder, since, until)
    if args.limit and args.limit > 0:
        paths = paths[: int(args.limit)]
    if not paths:
        _emit({"ok": True, "folder": folder, "identities": [],
               "scanned": 0})
        return 0
    workers = _resolve_worker_count(args.workers)
    rows = []
    started = time.monotonic()
    with ProcessPoolExecutor(max_workers=workers) as pool:
        for result in pool.map(_identity_worker, paths, chunksize=4):
            rows.extend(result or [])
    elapsed = round(time.monotonic() - started, 2)
    _emit({
        "ok": True,
        "folder": folder,
        "scanned": len(paths),
        "elapsed_sec": elapsed,
        "workers": workers,
        "identities": _identity_aggregate(rows),
    })
    return 0


def cmd_import(args) -> int:
    """Walk folder, parse in parallel, merge into DB, checkpoint state."""
    folder = args.folder
    if not folder or not os.path.isdir(folder):
        _emit({"ok": False, "error": "folder not found"})
        return 2
    raw_names = list(getattr(args, "players", None) or [])
    if getattr(args, "player", "") and args.player not in raw_names:
        raw_names.append(args.player)
    raw_ids = list(getattr(args, "character_ids", None) or [])
    # Pad / truncate so identities zip cleanly (empty char_id == None).
    while len(raw_ids) < len(raw_names):
        raw_ids.append("")
    identities = []
    seen_pairs = set()
    for name, cid in zip(raw_names, raw_ids):
        nm = (name or "").strip()
        if not nm:
            continue
        cid_norm = (cid or "").strip() or None
        key = (nm.lower(), cid_norm or "")
        if key in seen_pairs:
            continue
        seen_pairs.add(key)
        identities.append({"name": nm, "character_id": cid_norm})
    if not identities:
        _emit({"ok": False,
               "error": "at least one --players NAME is required"})
        return 1
    player_names = [i["name"] for i in identities]  # legacy alias

    since = _parse_iso_date(args.since_iso)
    until = _parse_iso_date(args.until_iso)
    workers = _resolve_worker_count(args.workers)
    state_path = args.state_path or ""
    db_path = args.db or ""

    state = _load_state(state_path) if args.resume else {
        "version": 1, "running": True,
        "started_at": datetime.utcnow().isoformat() + "Z",
        "finished_at": None, "folder": folder,
        "since": args.since_iso, "until": args.until_iso,
        "workers": workers, "total": 0, "completed": 0, "errors": 0,
        "processed_paths": [],
    }
    state["running"] = True
    state["workers"] = workers
    if state_path:
        _save_state(state_path, state)

    paths = _scan(folder, since, until)
    if args.limit and args.limit > 0:
        paths = paths[: int(args.limit)]
    db = _load_json_or(db_path, {}) if db_path else {}
    seen = _index_existing_paths(db)
    if args.resume:
        already = {os.path.normcase(p) for p in state.get("processed_paths", [])}
        paths = [p for p in paths if os.path.normcase(p) not in already
                 and os.path.normcase(p) not in seen]
    else:
        paths = [p for p in paths if os.path.normcase(p) not in seen]

    state["total"] = len(paths)
    total = len(paths)
    if total == 0:
        state["running"] = False
        state["finished_at"] = datetime.utcnow().isoformat() + "Z"
        _save_state(state_path, state)
        _emit({"result": {"processed": 0, "ok": 0, "errors": 0,
                          "elapsed_sec": 0, "workers": workers}})
        return 0

    _emit({"start": {"total": total, "workers": workers,
                     "folder": folder, "since": args.since_iso,
                     "until": args.until_iso}})
    return _run_pool(args, db, db_path, state, state_path, paths, total,
                     workers, identities)


def _bulk_worker(file_path, identities):
    """Identity-aware bulk worker.

    Each entry in ``identities`` is ``{"name": str,
    "character_id": str|None}``. Matching strategy:

      1. character_id (toon_handle) match -- unambiguous.
      2. Substring name match -- only if exactly ONE human in the
         replay matches; if multiple humans match by name and no
         character_id discriminator was provided, emit reason
         ``ambiguous_name`` so the user knows to add their
         character_id.

    Falls through to the existing single-name worker when a match
    is found, so the rest of the pipeline (build detect, macro,
    persist) is identical to the live watcher.
    """
    from core.replay_loader import (
        load_replay_with_fallback, process_replay_task,
    )
    if not identities:
        return {"status": "error", "reason": "no_player_names",
                "file_path": file_path,
                "error": "no candidate identities supplied"}
    try:
        replay = load_replay_with_fallback(file_path)
    except Exception as exc:
        return {"status": "error", "reason": "parse_failed",
                "file_path": file_path,
                "error": f"Parse error: {exc}"}
    matched_name = _resolve_match_name(replay, identities)
    if matched_name is None:
        return _ambiguity_or_missing(replay, identities, file_path)
    return process_replay_task(file_path, matched_name)


def _humans_in_replay(replay):
    """Return non-observer/non-referee players."""
    out = []
    for p in getattr(replay, "players", None) or []:
        if getattr(p, "is_observer", False):
            continue
        if getattr(p, "is_referee", False):
            continue
        out.append(p)
    return out


def _resolve_match_name(replay, identities):
    """Pick the player.name to forward to process_replay_task.

    Tries character_id first (unambiguous). Returns None if no
    unique name match is possible (caller decides ambiguity vs
    missing). character_id matching is robust to clan tags AND
    duplicate display names across regions.
    """
    humans = _humans_in_replay(replay)
    cids = {(i.get("character_id") or "").strip(): i["name"]
            for i in identities if (i.get("character_id") or "").strip()}
    for p in humans:
        toon = getattr(p, "toon_handle", None) or ""
        if toon and toon in cids:
            return getattr(p, "name", "") or cids[toon]
    # Fall back to substring name match. Only return a name when
    # EXACTLY ONE human matches -- multiple matches are ambiguous.
    matched = []
    name_terms = [(i["name"] or "").lower() for i in identities]
    for p in humans:
        pname = (getattr(p, "name", "") or "").lower()
        if pname and any(t and t in pname for t in name_terms):
            matched.append(getattr(p, "name", ""))
    if len(matched) == 1:
        return matched[0]
    return None


def _ambiguity_or_missing(replay, identities, file_path):
    """Build the proper error result for a non-match."""
    humans = _humans_in_replay(replay)
    name_terms = [(i["name"] or "").lower() for i in identities]
    matched = [getattr(p, "name", "") or "?" for p in humans
               if any(t and t in (getattr(p, "name", "") or "").lower()
                      for t in name_terms)]
    seen = ", ".join(sorted({getattr(p, "name", "") or "?"
                              for p in humans})) or "?"
    matched_str = ", ".join(matched)
    if len(matched) > 1:
        return {"status": "error", "reason": "ambiguous_name",
                "file_path": file_path,
                "error": (
                    "Multiple humans match the configured name(s): "
                    + matched_str
                    + ". Add the character_id for your account in "
                    "Settings -> Profile to disambiguate."
                ),
                "observed_names": seen}
    return {"status": "error", "reason": "player_not_found",
            "file_path": file_path,
            "error": "None of the configured names matched "
                     "(saw: " + seen + ").",
            "observed_names": seen}


def _run_pool(args, db, db_path, state, state_path, paths, total,
              workers, identities):
    """Drive the worker pool. Split out so cmd_import stays under cap."""
    stop_flag = [False]
    _setup_signal_handlers(stop_flag)
    started = time.monotonic()
    completed_ok = 0
    errors = 0
    error_breakdown: Dict[str, int] = {}
    error_samples: Dict[str, List[str]] = {}
    last_persist_at = 0
    with ProcessPoolExecutor(max_workers=workers) as pool:
        futures = {pool.submit(_bulk_worker, p, identities): p
                   for p in paths}
        for fut in as_completed(futures):
            if stop_flag[0]:
                break
            path = futures[fut]
            try:
                result = fut.result()
            except Exception as exc:
                result = {"status": "error", "reason": "worker_crash",
                          "file_path": path,
                          "error": f"worker crash: {exc}"}
            ok, msg = _import_one(state, db, set(), result)
            if ok:
                completed_ok += 1
                build_label = (result.get("my_build") or "Unsorted")
            else:
                errors += 1
                build_label = ""
                reason = result.get("reason") or "unknown"
                error_breakdown[reason] = error_breakdown.get(reason, 0) + 1
                # Keep up to 3 sample messages per reason for the UI.
                samples = error_samples.setdefault(reason, [])
                if len(samples) < 3 and result.get("error"):
                    samples.append(str(result.get("error"))[:200])
            i = completed_ok + errors
            _emit_progress(i, total, path, ok, msg, build_label)
            state["completed"] = completed_ok
            state["errors"] = errors
            state["error_breakdown"] = error_breakdown
            state["error_samples"] = error_samples
            if i - last_persist_at >= PERSIST_EVERY:
                _persist_db(db_path, db)
                _save_state(state_path, state)
                last_persist_at = i
    _persist_db(db_path, db)
    state["running"] = False
    state["finished_at"] = datetime.utcnow().isoformat() + "Z"
    _save_state(state_path, state)
    elapsed = time.monotonic() - started
    _emit({"result": {"processed": completed_ok + errors,
                      "ok": completed_ok, "errors": errors,
                      "error_breakdown": error_breakdown,
                      "error_samples": error_samples,
                      "elapsed_sec": round(elapsed, 2), "workers": workers,
                      "cancelled": bool(stop_flag[0])}})
    return 130 if stop_flag[0] else 0


def main(argv: Optional[List[str]] = None) -> int:
    parser = argparse.ArgumentParser(
        prog="bulk_import_cli",
        description="Bulk-import historical .SC2Replay files (parallel).",
    )
    sub = parser.add_subparsers(dest="cmd", required=True)

    p_scan = sub.add_parser("scan", help="Count candidate replays only.")
    p_scan.add_argument("--folder", required=True)
    p_scan.add_argument("--since-iso", default="")
    p_scan.add_argument("--until-iso", default="")
    p_scan.add_argument("--db", default="",
                        help="Path to meta_database.json so the scan can\n                              report how many candidates are already\n                              imported.")
    p_scan.set_defaults(func=cmd_scan)

    p_imp = sub.add_parser("import", help="Parse + persist replays.")
    p_imp.add_argument("--folder", required=True)
    p_imp.add_argument("--players", action="append", default=[],
                       metavar="NAME",
                       help="In-game name to treat as yours. Repeat once per name; substring match, case-insensitive.")
    p_imp.add_argument("--character-ids", action="append", default=[],
                       metavar="ID",
                       help=("Optional character_id (toon_handle) "
                             "for each --players entry, in order. "
                             "Empty string = name-only match. "
                             "Preferred over name match when set."))
    # Back-compat: --player NAME maps onto --players.
    p_imp.add_argument("--player", default="", help=argparse.SUPPRESS)
    p_imp.add_argument("--since-iso", default="")
    p_imp.add_argument("--until-iso", default="")
    p_imp.add_argument("--workers", type=int, default=-1,
                       help="0 = ALL cores; -1 = default min(8,cpu); "
                            "N = cap at min(N, cpu).")
    p_imp.add_argument("--state-path", default="",
                       help="Path to import_state.json for resume.")
    p_imp.add_argument("--resume", action="store_true",
                       help="Skip paths already in processed_paths state.")
    p_imp.add_argument("--db", default="",
                       help="Path to meta_database.json to merge into.")
    p_imp.add_argument("--limit", type=int, default=0,
                       help="Stop after N replays (0 = no limit).")
    p_imp.set_defaults(func=cmd_import)

    p_eid = sub.add_parser("extract-identities",
        help="Discover (name, character_id) candidates in a folder.")
    p_eid.add_argument("--folder", required=True)
    p_eid.add_argument("--since-iso", default="")
    p_eid.add_argument("--until-iso", default="")
    p_eid.add_argument("--workers", type=int, default=-1,
                       help="0 = ALL cores; -1 = default min(8,cpu).")
    p_eid.add_argument("--limit", type=int, default=0,
                       help="Stop scanning after N replays (0 = all).")
    p_eid.set_defaults(func=cmd_extract_identities)

    args = parser.parse_args(argv)
    try:
        return args.func(args)
    except KeyboardInterrupt:
        _emit({"ok": False, "error": "interrupted"})
        return 130
    except Exception as exc:
        _emit({"ok": False, "error": f"runtime error: {exc}"})
        return 2


if __name__ == "__main__":
    sys.exit(main())
