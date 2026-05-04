"""bulk_import_cli -- parallel deep-import of historical .SC2Replay files.

Walks a directory for ``.SC2Replay`` files (recursively), filters by
modification time against an optional date range, then dispatches
each file to a ``ProcessPoolExecutor`` worker that runs the same
parse pipeline as the live watcher (build-order + opp strategy +
macro score + slim macro_breakdown). The parent process aggregates
worker results and atomically persists ``meta_database.json``.

Spawned by the Express overlay backend at
``analyzer.js -> /api/analyzer/import/{scan,start,extract-identities}``
and surfaced in the SPA at Settings -> Import (and reused inside the
onboarding wizard's Step 5).

Production characteristics
--------------------------

  * **Parallel.** ``min(--workers, cpu_count())`` workers, defaults
    to ``min(8, cpu_count())``. Pass ``--workers 0`` to use ALL cores.
  * **Resumable.** State is checkpointed to ``--state-path`` every
    ``PERSIST_EVERY`` completions plus on graceful shutdown.
    Re-running with ``--resume`` skips already-processed paths.
  * **Bounded memory.** A worker only holds ONE replay at a time;
    the parent never accumulates raw replay objects.
  * **Atomic writes.** Every persist goes through a ``.tmp`` rename
    (the standard pattern for the data/ directory).
  * **NDJSON progress.** One ``{"progress": ...}`` line per finished
    replay so the Express layer can stream events to the SPA.
  * **Idempotent.** Uses ``game_id`` (date|opp|map|len) for dedup.
    Re-importing an already-known replay is a no-op.

Subcommands
-----------

  scan --folder PATH [--db PATH] [--since-iso ...] [--until-iso ...]
      Count candidate replays without parsing.

  import --folder PATH --players NAME [--players ...] [--db PATH]
         [--character-ids ID ...] [--workers N] [--state-path PATH]
         [--resume] [--since-iso ...] [--until-iso ...] [--limit N]
      Deep-parse every replay and merge into the meta DB.

  extract-identities --folder PATH [--workers N] [--limit N]
      Discover (name, character_id) candidates in a folder.

Exit codes:
  0   success
  1   usage error
  2   runtime error
  130 cancelled (SIGINT/SIGTERM); state has been saved
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

# Project root on sys.path so workers can re-import this module + the
# merged-tree analytics packages when ProcessPoolExecutor respawns them.
_HERE = os.path.dirname(os.path.abspath(__file__))
_ROOT = os.path.dirname(_HERE)
if _ROOT not in sys.path:
    sys.path.insert(0, _ROOT)

# Tunables -----------------------------------------------------------
DEFAULT_WORKER_CAP = 8
PERSIST_EVERY = 25
REPLAY_GLOB_SUFFIX = ".SC2Replay"


# =====================================================================
# I/O helpers
# =====================================================================
def _eprint(msg: str) -> None:
    print(msg, file=sys.stderr, flush=True)


def _emit(obj: Dict[str, Any]) -> None:
    """One newline-delimited JSON record on stdout."""
    sys.stdout.write(json.dumps(obj, default=str) + "\n")
    sys.stdout.flush()


def _atomic_write_json(path: str, payload: Any) -> None:
    """Atomic JSON write -- thin wrapper around the canonical helper.

    Routes through ``core.atomic_io.atomic_write_json`` (Stage 2 of the
    data-integrity roadmap) so ``bulk_import_cli`` shares the same
    cross-process file lock, ``.bak`` snapshot, and validate-before-
    rename gate as every other writer in the project.

    Kept under the legacy private name so the existing call sites do
    not need to change.
    """
    from core.atomic_io import atomic_write_json

    atomic_write_json(path, payload, indent=2)


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
        raise ValueError(f"bad date {s!r}: {exc}")


def _resolve_worker_count(requested: int) -> int:
    """Pick a worker count.

    requested == 0  -> use all cores.
    requested  < 0  -> default min(DEFAULT_WORKER_CAP, cpu_count).
    requested  > 0  -> cap at cpu_count.
    """
    cores = os.cpu_count() or 1
    if requested == 0:
        return cores
    if requested < 0:
        return min(DEFAULT_WORKER_CAP, cores)
    return max(1, min(int(requested), cores))


def _walk_replays(folder: str) -> Iterable[str]:
    for root, _dirs, files in os.walk(folder):
        for name in files:
            if name.lower().endswith(REPLAY_GLOB_SUFFIX.lower()):
                yield os.path.abspath(os.path.join(root, name))


def _filter_by_mtime(paths: List[str], since: Optional[float],
                     until: Optional[float]) -> List[str]:
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


def _scan(folder: str, since: Optional[float],
          until: Optional[float]) -> List[str]:
    """Walk + filter; returns absolute paths sorted by mtime ascending."""
    raw = list(_walk_replays(folder))
    filtered = _filter_by_mtime(raw, since, until)
    filtered.sort(key=lambda p: os.path.getmtime(p))
    return filtered


# =====================================================================
# State + DB persistence
# =====================================================================
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


def _merge_game(db: Dict[str, Any], my_build: str,
                game: Dict[str, Any]) -> bool:
    """Insert a parsed game into the keyed-by-build DB.

    Returns ``True`` if the row was new, ``False`` if a game with the
    same id already exists in the same build bucket.
    """
    bd = db.setdefault(my_build, {"games": []})
    games = bd.setdefault("games", [])
    target_id = game.get("id")
    for existing in games:
        if existing.get("id") == target_id:
            return False
    games.append(game)
    return True


def _persist_db(db_path: str, db: Dict[str, Any]) -> None:
    if db_path:
        _atomic_write_json(db_path, db)


# ---- Black Book (MyOpponentHistory.json) cross-write -----------------
# Bulk import owes the SPA's "Opponents" tab a populated Black Book.
# The live watcher does this through DataStore.link_game() but we run
# in a long-lived ProcessPool so we keep the writer in the PARENT
# process only -- workers must never touch the Black Book JSON.
_BLACK_BOOK_STORE = None  # lazy singleton, parent-process-only


def _get_black_book_store(opp_db_path: str):
    """Lazy-init a process-local BlackBookStore. Parent-only."""
    global _BLACK_BOOK_STORE
    if _BLACK_BOOK_STORE is not None:
        return _BLACK_BOOK_STORE
    try:
        from core.data_store import BlackBookStore
    except Exception as exc:
        _eprint(f"[bulk_import] black-book import failed: {exc}")
        return None
    try:
        _BLACK_BOOK_STORE = BlackBookStore(path=opp_db_path) \
            if opp_db_path else BlackBookStore()
    except TypeError:
        # Older signature without keyword path -- fall back to default.
        _BLACK_BOOK_STORE = BlackBookStore()
    return _BLACK_BOOK_STORE


_RESULT_TO_BLACK_BOOK = {"Win": "Victory", "Loss": "Defeat"}


def _format_bb_date(date_iso: str) -> str:
    """Convert sc2reader's ISO date into the Black Book 'YYYY-MM-DD HH:MM'.

    Black Book identity is (Date[:16], Map, Result). Truncate cleanly
    so a re-import doesn't double-count games whose ISO timestamps
    carry seconds vs. minutes.
    """
    if not date_iso or date_iso == "unknown":
        return ""
    cleaned = date_iso.replace("T", " ").split(".")[0]
    return cleaned[:16]


def _build_black_book_game(game: Dict[str, Any], my_build: str,
                           my_race_initial: str) -> Dict[str, Any]:
    """Translate an analyzer-DB game record into the Black Book shape."""
    bb_result = _RESULT_TO_BLACK_BOOK.get(game.get("result") or "", "")
    return {
        "Date":     _format_bb_date(game.get("date") or ""),
        "Result":   bb_result,
        "Map":      game.get("map") or "",
        "Duration": int(game.get("game_length") or 0),
        "Strategy": game.get("opp_strategy") or "Unknown",
        "MyBuild":  my_build or "Unsorted",
        "BuildLog": list(game.get("build_log") or []),
        "EarlyBuildLog": list(game.get("early_build_log") or []),
        "MyRace":   (my_race_initial or "U"),
    }


def _write_black_book_for(opp_db_path: str,
                           result: Dict[str, Any]) -> Optional[bool]:
    """Cross-write one successful import into MyOpponentHistory.json.

    Returns True if a new Black Book row was appended, False if an
    existing row was patched, None if the write was skipped (missing
    data or an unrecoverable store error). All exceptions are
    swallowed -- the analyzer DB is the source of truth, the Black
    Book is a derived projection that the watcher will reconcile
    later via merge_unknown_into_numeric.
    """
    store = _get_black_book_store(opp_db_path)
    if store is None:
        return None
    game = result.get("data") or {}
    opp_name = (game.get("opponent") or "").strip()
    if not opp_name:
        return None
    my_build = result.get("my_build") or "Unsorted"
    my_race_initial = (game.get("my_race_initial") or "U").upper()
    opp_race_initial = (game.get("opp_race_initial") or "U").upper()
    matchup = f"{my_race_initial}v{opp_race_initial}"
    bb_game = _build_black_book_game(game, my_build, my_race_initial)
    if not bb_game.get("Date") or not bb_game.get("Result"):
        # No reliable identity -- skip rather than create a phantom
        # row the watcher's reconciler can't match.
        return None
    pulse_id = f"unknown:{opp_name}"
    bb_result = bb_game["Result"]
    try:
        return store.upsert_game(
            pulse_id=pulse_id,
            opp_name=opp_name,
            opp_race_initial=opp_race_initial,
            matchup=matchup,
            game=bb_game,
            result=bb_result,
        )
    except Exception as exc:
        _eprint(f"[bulk_import] black-book upsert failed for "
                f"{opp_name!r}: {exc}")
        return None


def _setup_signal_handlers(stop_flag: List[bool]) -> None:
    def _handler(signum, _frame):
        stop_flag[0] = True
        _emit({"signal": int(signum)})
    try:
        signal.signal(signal.SIGINT, _handler)
        signal.signal(signal.SIGTERM, _handler)
    except (ValueError, OSError):
        # Not on the main thread or platform refuses; harmless.
        pass


# =====================================================================
# Replay parsing -- pickleable top-level functions for ProcessPool
# =====================================================================
# These helpers are intentionally module-level so the ProcessPoolExecutor
# can pickle them when re-spawning a worker on Windows. They lazy-import
# the heavy sc2reader/analytics modules INSIDE the function body so
# importing this CLI from the parent process stays fast.
def _load_replay_with_fallback(file_path: str):
    """Load a replay, tolerating well-known sc2reader tracker bugs.

    Tries level 4, then 3, then 2. Re-raises the last exception if
    every level fails so callers can surface a single clean error.
    """
    import sc2reader  # type: ignore
    last_exc: Optional[Exception] = None
    for lvl in (4, 3, 2):
        try:
            return sc2reader.load_replay(file_path, load_level=lvl)
        except Exception as exc:
            last_exc = exc
            continue
    raise last_exc if last_exc else RuntimeError("sc2reader load failed")


def _identity_worker(file_path):
    """ProcessPool worker: extract candidate identities from one replay.

    Returns a list of ``{"name", "character_id", "region"}`` dicts
    for non-observer/non-referee humans. Empty list on parse failure
    -- the parent skips silently so a single corrupt replay doesn't
    abort the whole scan.
    """
    try:
        replay = _load_replay_with_fallback(file_path)
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
            region = {
                "1": "us", "2": "eu", "3": "kr",
                "5": "cn", "6": "sea",
            }.get(region_code, "")
        out.append({"name": name, "character_id": toon, "region": region})
    return out


def _identity_aggregate(rows):
    """Bucket worker rows into unique (name, character_id) tuples sorted
    by frequency descending."""
    counts: Dict[Tuple[str, str], Dict[str, Any]] = {}
    for row in rows:
        key = (row["name"], row["character_id"])
        if key not in counts:
            counts[key] = {**row, "count": 0}
        counts[key]["count"] += 1
    return sorted(counts.values(), key=lambda r: -r["count"])


def _process_replay_task(file_path: str, player_name: str) -> Dict[str, Any]:
    """End-to-end deep parse of one replay. Returns a worker result dict.

    Mirrors the live watcher's pipeline so games imported here look
    identical to games captured during play:

      1. Load via ``parse_deep`` (load_level=4 with fallback).
      2. Resolve me/opponent (substring match against ``player_name``).
      3. Run UserBuildDetector + OpponentStrategyDetector.
      4. Extract macro events and compute macro score + slim breakdown.
      5. Assemble the analyzer-DB game record.

    Result shapes (always include ``status``)::

      {"status": "success", "file_path": ..., "game_id": ...,
       "my_build": "...", "data": {...}}

      {"status": "error", "file_path": ..., "reason": "<code>",
       "error": "<human-readable>", "observed_names"?: "..."}
    """
    abs_path = os.path.abspath(file_path)
    try:
        from core.sc2_replay_parser import parse_deep
        from core.event_extractor import extract_macro_events
        from analytics.macro_score import compute_macro_score
    except Exception as exc:
        return {
            "status": "error", "reason": "import_failed",
            "file_path": abs_path,
            "error": f"analytics import failed: {exc}",
        }

    try:
        ctx = parse_deep(file_path, player_name)
    except Exception as exc:
        return {
            "status": "error", "reason": "parse_failed",
            "file_path": abs_path,
            "error": f"Parse error: {exc}",
        }

    if ctx is None:
        return {
            "status": "error", "reason": "parse_failed",
            "file_path": abs_path,
            "error": "parse_deep returned no context",
        }

    if ctx.is_ai_game:
        return {
            "status": "error", "reason": "no_opponent",
            "file_path": abs_path,
            "error": "Replay has no human opponent (vs AI / solo).",
        }

    if not ctx.me:
        seen_names = ", ".join(sorted({
            (p.name or "?") for p in (ctx.all_players or [])
        })) or "?"
        return {
            "status": "error", "reason": "player_not_found",
            "file_path": abs_path,
            "error": (f"Player {player_name!r} not in replay "
                      f"(saw: {seen_names})."),
            "observed_names": seen_names,
        }

    if not ctx.opponent:
        return {
            "status": "error", "reason": "no_opponent",
            "file_path": abs_path,
            "error": "Replay has no opponent (vs AI / solo).",
        }

    if not ctx.my_events:
        return {
            "status": "error", "reason": "no_events",
            "file_path": abs_path,
            "error": "No events extracted (replay may be too short).",
        }

    macro_score: Optional[int] = None
    top_3_leaks: List[Dict[str, Any]] = []
    macro_breakdown: Optional[Dict[str, Any]] = None
    if ctx.raw is not None:
        try:
            macro_events = extract_macro_events(ctx.raw, ctx.me.pid)
            macro_result = compute_macro_score(
                macro_events, ctx.me.race, ctx.length_seconds,
            )
            macro_score = macro_result.get("macro_score")
            top_3_leaks = list(macro_result.get("top_3_leaks") or [])
            macro_breakdown = {
                "score": macro_score,
                "race": ctx.me.race,
                "game_length_sec": ctx.length_seconds,
                "raw": macro_result.get("raw") or {},
                "all_leaks": list(macro_result.get("all_leaks") or []),
                "top_3_leaks": top_3_leaks,
            }
        except Exception:
            # Macro is best-effort: a parse hiccup in one component
            # shouldn't blow away the whole replay record.
            macro_score = None
            top_3_leaks = []
            macro_breakdown = None

    my_race_initial = (ctx.me.race[0].upper() if ctx.me.race else "U")
    opp_race_initial = (ctx.opponent.race[0].upper() if ctx.opponent.race else "U")

    game_data: Dict[str, Any] = {
        "id": ctx.game_id,
        "opponent": ctx.opponent.name,
        "opp_race": ctx.opponent.race,
        "opp_strategy": ctx.opp_strategy or "Unknown",
        "map": ctx.map_name,
        "result": ctx.me.result if ctx.me.result else "Unknown",
        "date": ctx.date_iso,
        "game_length": ctx.length_seconds,
        "build_log": list(ctx.build_log or []),
        "early_build_log": list(ctx.early_build_log or []),
        "macro_score": macro_score,
        "top_3_leaks": top_3_leaks,
        "macro_breakdown": macro_breakdown,
        "file_path": abs_path,
        "my_race_initial": my_race_initial,
        "opp_race_initial": opp_race_initial,
    }

    return {
        "status": "success",
        "file_path": abs_path,
        "game_id": ctx.game_id,
        "my_build": ctx.my_build or "Unsorted",
        "data": game_data,
    }


def _humans_in_replay(replay):
    out = []
    for p in getattr(replay, "players", None) or []:
        if getattr(p, "is_observer", False):
            continue
        if getattr(p, "is_referee", False):
            continue
        out.append(p)
    return out


def _resolve_match_name(replay, identities):
    """Pick the player.name to forward to ``_process_replay_task``.

    Tries character_id (toon_handle) first -- unambiguous. Falls back
    to substring name match, but ONLY returns a name when exactly one
    human matches; multiple matches are reported as ``ambiguous_name``.
    """
    humans = _humans_in_replay(replay)
    cids = {
        (i.get("character_id") or "").strip(): i["name"]
        for i in identities if (i.get("character_id") or "").strip()
    }
    for p in humans:
        toon = getattr(p, "toon_handle", None) or ""
        if toon and toon in cids:
            return getattr(p, "name", "") or cids[toon]
    name_terms = [(i["name"] or "").lower() for i in identities]
    matched: List[str] = []
    for p in humans:
        pname = (getattr(p, "name", "") or "").lower()
        if pname and any(t and t in pname for t in name_terms):
            matched.append(getattr(p, "name", ""))
    if len(matched) == 1:
        return matched[0]
    return None


def _ambiguity_or_missing(replay, identities, file_path):
    """Build the right structured error for a non-match."""
    humans = _humans_in_replay(replay)
    name_terms = [(i["name"] or "").lower() for i in identities]
    matched = [
        getattr(p, "name", "") or "?" for p in humans
        if any(t and t in (getattr(p, "name", "") or "").lower()
               for t in name_terms)
    ]
    seen = ", ".join(sorted({
        (getattr(p, "name", "") or "?") for p in humans
    })) or "?"
    abs_path = os.path.abspath(file_path)
    if len(matched) > 1:
        return {
            "status": "error", "reason": "ambiguous_name",
            "file_path": abs_path,
            "error": (
                "Multiple humans match the configured name(s): "
                + ", ".join(matched)
                + ". Add the character_id for your account in "
                "Settings -> Profile to disambiguate."
            ),
            "observed_names": seen,
        }
    return {
        "status": "error", "reason": "player_not_found",
        "file_path": abs_path,
        "error": (
            "None of the configured names matched (saw: " + seen + ")."
        ),
        "observed_names": seen,
    }


def _bulk_worker(file_path, identities):
    """ProcessPool worker: identity-aware deep import of one replay.

    Each entry in ``identities`` is ``{"name": str,
    "character_id": str|None}``. We try character_id (unambiguous)
    first, then substring name match, then dispatch to
    ``_process_replay_task``. On non-match we return a structured
    error so the parent can bucket it by reason for the UI.
    """
    if not identities:
        return {
            "status": "error", "reason": "no_player_names",
            "file_path": os.path.abspath(file_path),
            "error": "no candidate identities supplied",
        }
    try:
        replay = _load_replay_with_fallback(file_path)
    except Exception as exc:
        return {
            "status": "error", "reason": "parse_failed",
            "file_path": os.path.abspath(file_path),
            "error": f"Parse error: {exc}",
        }
    matched_name = _resolve_match_name(replay, identities)
    if matched_name is None:
        return _ambiguity_or_missing(replay, identities, file_path)
    return _process_replay_task(file_path, matched_name)


# =====================================================================
# Subcommands
# =====================================================================
def _emit_progress(i: int, total: int, path: str, ok: bool,
                   message: str = "", build: str = "") -> None:
    _emit({"progress": {
        "i": i, "total": total,
        "file": os.path.basename(path or ""),
        "build": build, "ok": ok, "message": message,
    }})


def cmd_scan(args) -> int:
    """Count replays in scope, split into new vs already-imported."""
    folder = args.folder
    if not folder or not os.path.isdir(folder):
        _emit({"ok": False, "error": "folder not found"})
        return 2
    try:
        since = _parse_iso_date(args.since_iso)
        until = _parse_iso_date(args.until_iso)
    except ValueError as exc:
        _emit({"ok": False, "error": str(exc)})
        return 1

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


def cmd_extract_identities(args) -> int:
    """Discover (name, character_id) candidates in a folder."""
    folder = args.folder
    if not folder or not os.path.isdir(folder):
        _emit({"ok": False, "error": "folder not found"})
        return 2
    try:
        since = _parse_iso_date(args.since_iso)
        until = _parse_iso_date(args.until_iso)
    except ValueError as exc:
        _emit({"ok": False, "error": str(exc)})
        return 1

    paths = _scan(folder, since, until)
    if args.limit and args.limit > 0:
        paths = paths[: int(args.limit)]
    if not paths:
        _emit({"ok": True, "folder": folder, "identities": [],
               "scanned": 0})
        return 0
    workers = _resolve_worker_count(args.workers)
    rows: List[Dict[str, Any]] = []
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


def _normalize_identities(args) -> List[Dict[str, Any]]:
    """Merge --players / --player / --character-ids into a clean list."""
    raw_names = list(getattr(args, "players", None) or [])
    legacy_player = getattr(args, "player", "") or ""
    if legacy_player and legacy_player not in raw_names:
        raw_names.append(legacy_player)
    raw_ids = list(getattr(args, "character_ids", None) or [])
    while len(raw_ids) < len(raw_names):
        raw_ids.append("")
    identities: List[Dict[str, Any]] = []
    seen_pairs: Set[Tuple[str, str]] = set()
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
    return identities


def cmd_import(args) -> int:
    """Walk folder, parse in parallel, merge into DB, checkpoint state."""
    folder = args.folder
    if not folder or not os.path.isdir(folder):
        _emit({"ok": False, "error": "folder not found"})
        return 2
    identities = _normalize_identities(args)
    if not identities:
        _emit({"ok": False,
               "error": "at least one --players NAME is required"})
        return 1

    try:
        since = _parse_iso_date(args.since_iso)
        until = _parse_iso_date(args.until_iso)
    except ValueError as exc:
        _emit({"ok": False, "error": str(exc)})
        return 1

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
        already = {os.path.normcase(p)
                   for p in state.get("processed_paths", [])}
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


def _import_one(parent_state: Dict[str, Any], db: Dict[str, Any],
                seen: Set[str], result: Dict[str, Any],
                opp_db_path: str) -> Tuple[bool, str]:
    """Apply one worker result to db + state. Returns (ok, message).

    Also cross-writes a Black Book row so the SPA's Opponents tab
    populates without waiting for the live watcher to revisit each
    replay. Black Book writes are best-effort -- a failure there
    never demotes the analyzer-DB insert.
    """
    if result.get("status") != "success":
        err = result.get("error") or "parse failed"
        return False, err
    my_build = result.get("my_build") or "Unsorted"
    game = result.get("data") or {}
    fp = (game.get("file_path") or "").strip()
    if fp:
        seen.add(os.path.normcase(os.path.abspath(fp)))
    inserted = _merge_game(db, my_build, game)
    parent_state.setdefault("processed_paths", []).append(fp)
    _write_black_book_for(opp_db_path, result)
    return True, "inserted" if inserted else "duplicate (skipped)"


def _run_pool(args, db, db_path, state, state_path, paths, total,
              workers, identities) -> int:
    """Drive the worker pool. Split out so cmd_import stays compact."""
    stop_flag: List[bool] = [False]
    _setup_signal_handlers(stop_flag)
    started = time.monotonic()
    completed_ok = 0
    errors = 0
    error_breakdown: Dict[str, int] = {}
    error_samples: Dict[str, List[str]] = {}
    last_persist_at = 0
    seen_local: Set[str] = set()
    opp_db_path = getattr(args, "opp_db", "") or ""
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
                          "file_path": os.path.abspath(path),
                          "error": f"worker crash: {exc}"}
            ok, msg = _import_one(state, db, seen_local, result, opp_db_path)
            if ok:
                completed_ok += 1
                build_label = (result.get("my_build") or "Unsorted")
            else:
                errors += 1
                build_label = ""
                reason = result.get("reason") or "unknown"
                error_breakdown[reason] = error_breakdown.get(reason, 0) + 1
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
    _emit({"result": {
        "processed": completed_ok + errors,
        "ok": completed_ok, "errors": errors,
        "error_breakdown": error_breakdown,
        "error_samples": error_samples,
        "elapsed_sec": round(elapsed, 2), "workers": workers,
        "cancelled": bool(stop_flag[0]),
    }})
    return 130 if stop_flag[0] else 0


# =====================================================================
# CLI plumbing
# =====================================================================
def _build_argparser() -> argparse.ArgumentParser:
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
                        help=("Path to meta_database.json so the scan "
                              "can split candidates into new vs "
                              "already-imported."))
    p_scan.set_defaults(func=cmd_scan)

    p_imp = sub.add_parser("import", help="Parse + persist replays.")
    p_imp.add_argument("--folder", required=True)
    p_imp.add_argument(
        "--players", action="append", default=[], metavar="NAME",
        help=("In-game name to treat as yours. Repeat once per name; "
              "substring match, case-insensitive."))
    p_imp.add_argument(
        "--character-ids", action="append", default=[], metavar="ID",
        help=("Optional character_id (toon_handle) for each --players "
              "entry, in order. Empty string = name-only match. "
              "Preferred over name match when set."))
    # Back-compat: --player NAME maps onto --players.
    p_imp.add_argument("--player", default="", help=argparse.SUPPRESS)
    p_imp.add_argument("--since-iso", default="")
    p_imp.add_argument("--until-iso", default="")
    p_imp.add_argument(
        "--workers", type=int, default=-1,
        help=("0 = ALL cores; -1 = default min(8, cpu); "
              "N = cap at min(N, cpu)."))
    p_imp.add_argument("--state-path", default="",
                       help="Path to import_state.json for resume.")
    p_imp.add_argument("--resume", action="store_true",
                       help="Skip paths already in processed_paths state.")
    p_imp.add_argument("--db", default="",
                       help="Path to meta_database.json to merge into.")
    p_imp.add_argument(
        "--opp-db", default="",
        help=("Path to MyOpponentHistory.json for the Black Book "
              "cross-write. Empty = use core.paths default. The "
              "SPA's Opponents tab reads from this file."))
    p_imp.add_argument("--limit", type=int, default=0,
                       help="Stop after N replays (0 = no limit).")
    p_imp.set_defaults(func=cmd_import)

    p_eid = sub.add_parser(
        "extract-identities",
        help="Discover (name, character_id) candidates in a folder.")
    p_eid.add_argument("--folder", required=True)
    p_eid.add_argument("--since-iso", default="")
    p_eid.add_argument("--until-iso", default="")
    p_eid.add_argument(
        "--workers", type=int, default=-1,
        help="0 = ALL cores; -1 = default min(8, cpu).")
    p_eid.add_argument("--limit", type=int, default=0,
                       help="Stop scanning after N replays (0 = all).")
    p_eid.set_defaults(func=cmd_extract_identities)

    return parser


def main(argv: Optional[List[str]] = None) -> int:
    parser = _build_argparser()
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
