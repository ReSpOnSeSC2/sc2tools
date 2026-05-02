"""
macro_cli -- thin Python entry point for the analyzer's backfill flows.

The Express overlay backend (analyzer.js -> /macro/backfill/start) shells
out to this CLI to import historical replays into ``meta_database.json``
during onboarding. Each line of stdout is a self-contained JSON object
the Node side consumes as a Socket.io progress event:

    {"progress": {"i": 1, "total": 47, "ok": true,  "file": "abc.SC2Replay"}}
    {"progress": {"i": 2, "total": 47, "ok": false, "file": "bad.SC2Replay",
                  "error": "live parse failed: ..."}}
    ...
    {"result":   {"updated": 41, "errors": 6, "skipped": 0, "total": 47}}

Subcommands
-----------
backfill
    Walk every folder listed under ``paths.replay_folders`` in
    ``data/config.json``, parse each ``.SC2Replay`` with
    ``core.sc2_replay_parser.parse_live`` (load_level=2 -- fast), and
    insert a game record into the analyzer DB through
    ``core.data_store.AnalyzerDBStore.add_game``. Idempotent on
    ``game_id`` -- re-running is safe.

Flags (backfill)
----------------
--db PATH         Override the analyzer DB path. Default: core.paths.META_DB_FILE.
--player NAME     Player handle for the ``is_me`` substring match.
                  Falls back to ``last_player`` from config.json then
                  the ``SC2_PLAYER`` env var.
--limit N         Stop after N replays. 0 / unset = no cap.
--force           Re-import games even if their ``id`` is already in the DB.
"""

from __future__ import annotations

import argparse
import json
import os
import sys
import traceback
from typing import Any, Dict, Iterable, List, Optional

# Allow running as ``python scripts/macro_cli.py`` from the project root.
_THIS_DIR = os.path.dirname(os.path.abspath(__file__))
_PROJECT_ROOT = os.path.dirname(_THIS_DIR)
if _PROJECT_ROOT not in sys.path:
    sys.path.insert(0, _PROJECT_ROOT)

from core.paths import CONFIG_FILE, META_DB_FILE  # noqa: E402
from core.data_store import AnalyzerDBStore  # noqa: E402
from core.sc2_replay_parser import parse_live  # noqa: E402


def _emit(obj: Dict[str, Any]) -> None:
    """Write one ndjson line and flush so the Node side sees it promptly."""
    sys.stdout.write(json.dumps(obj, ensure_ascii=False) + "\n")
    sys.stdout.flush()


def _read_config() -> Dict[str, Any]:
    if not os.path.exists(CONFIG_FILE):
        return {}
    try:
        with open(CONFIG_FILE, "r", encoding="utf-8-sig") as f:
            return json.load(f) or {}
    except Exception:
        return {}


def _resolve_player(cfg: Dict[str, Any], cli_player: Optional[str]) -> str:
    if cli_player and cli_player.strip():
        return cli_player.strip()
    last = cfg.get("last_player") or cfg.get("player_name")
    if isinstance(last, str) and last.strip():
        return last.strip()
    env = os.environ.get("SC2_PLAYER", "")
    return env.strip()


def _replay_folders(cfg: Dict[str, Any]) -> List[str]:
    """Return the configured replay folders (paths.replay_folders).

    Also tolerates the legacy top-level ``replay_folders`` shape so this
    script keeps working on configs that haven't been migrated to the
    nested layout yet.
    """
    paths = cfg.get("paths") or {}
    folders = paths.get("replay_folders")
    if not folders:
        folders = cfg.get("replay_folders")
    if not isinstance(folders, list):
        return []
    return [str(f) for f in folders if isinstance(f, str) and f.strip()]


def _iter_replay_files(folders: Iterable[str]) -> List[str]:
    """Recursively collect every .SC2Replay under each folder.

    Sorted by mtime descending so the wizard's progress bar surfaces the
    most recent games first -- if the user cancels partway through,
    they've still got their latest matches imported.
    """
    found: List[str] = []
    seen: set = set()
    for folder in folders:
        if not folder or not os.path.isdir(folder):
            continue
        for dirpath, _dirs, files in os.walk(folder):
            for name in files:
                if not name.lower().endswith(".sc2replay"):
                    continue
                full = os.path.join(dirpath, name)
                if full in seen:
                    continue
                seen.add(full)
                found.append(full)
    found.sort(key=lambda p: os.path.getmtime(p) if os.path.exists(p) else 0,
               reverse=True)
    return found


def _race_initial(race: str) -> str:
    return race[0].upper() if race else "U"


def _build_game_record(ctx: Any) -> Optional[Dict[str, Any]]:
    """Map a live ReplayContext into the analyzer DB game schema.

    parse_live (load_level=2) populates players/map/result but not
    deep-parse fields (build, opp_strategy, build_log) -- those are
    left as ``Unknown`` / empty here and filled in later by the live
    watcher's deep parse when the user replays the file.
    """
    if not ctx or not ctx.me or not ctx.opponent:
        return None
    me = ctx.me
    opp = ctx.opponent
    return {
        "id": ctx.game_id,
        "opponent": opp.name,
        "opp_race": opp.race,
        "opp_strategy": ctx.opp_strategy or "Unknown",
        "map": ctx.map_name,
        "result": me.result if me.result else "Unknown",
        "date": ctx.date_iso,
        "game_length": ctx.length_seconds,
        "build_log": list(ctx.build_log or []),
        "early_build_log": list(ctx.early_build_log or []),
        "file_path": ctx.file_path,
        "my_race_initial": _race_initial(me.race),
        "opp_race_initial": _race_initial(opp.race),
    }


def _add_or_replace(store: AnalyzerDBStore,
                    build_name: str,
                    game: Dict[str, Any],
                    *,
                    force: bool) -> str:
    """Insert ``game`` into the DB. Returns 'added' / 'skipped' / 'updated'."""
    if not force:
        return "added" if store.add_game(build_name, game) else "skipped"

    # --force path: drop any existing row with the same id, then re-add.
    db = store.load()
    gid = game.get("id")
    replaced = False
    for bd in db.values():
        games = bd.get("games") or []
        kept = [g for g in games if g.get("id") != gid]
        if len(kept) != len(games):
            bd["games"] = kept
            replaced = True
    bucket = db.setdefault(build_name, {"games": [], "wins": 0, "losses": 0})
    bucket.setdefault("games", []).append(game)
    AnalyzerDBStore.recalc_stats(db, build_name)
    store.save(db)
    return "updated" if replaced else "added"


def _cmd_backfill(args: argparse.Namespace) -> int:
    cfg = _read_config()
    player = _resolve_player(cfg, args.player)
    if not player:
        _emit({"result": {"updated": 0, "errors": 0, "skipped": 0, "total": 0,
                          "fatal": "no player handle configured"}})
        sys.stderr.write(
            "macro_cli.backfill: no --player supplied and config.json has "
            "no last_player; aborting.\n")
        return 2

    folders = _replay_folders(cfg)
    if not folders:
        _emit({"result": {"updated": 0, "errors": 0, "skipped": 0, "total": 0,
                          "fatal": "no replay_folders configured"}})
        sys.stderr.write(
            "macro_cli.backfill: config.json paths.replay_folders is empty; "
            "run the onboarding wizard first.\n")
        return 2

    db_path = args.db or META_DB_FILE
    store = AnalyzerDBStore(path=db_path)

    files = _iter_replay_files(folders)
    if args.limit and args.limit > 0:
        files = files[: args.limit]
    total = len(files)

    if total == 0:
        _emit({"result": {"updated": 0, "errors": 0, "skipped": 0,
                          "total": 0}})
        return 0

    updated = 0
    errors = 0
    skipped = 0

    for i, path in enumerate(files, start=1):
        try:
            ctx = parse_live(path, player)
        except Exception as exc:
            errors += 1
            _emit({"progress": {
                "i": i, "total": total, "ok": False,
                "file": os.path.basename(path),
                "error": f"live parse failed: {exc}",
            }})
            continue

        if ctx.is_ai_game:
            skipped += 1
            _emit({"progress": {
                "i": i, "total": total, "ok": True,
                "file": os.path.basename(path),
                "action": "skipped_ai",
            }})
            continue

        record = _build_game_record(ctx)
        if not record:
            skipped += 1
            _emit({"progress": {
                "i": i, "total": total, "ok": True,
                "file": os.path.basename(path),
                "action": "skipped_unresolved",
            }})
            continue

        # parse_live doesn't classify the user's build -- bucket under
        # 'Unknown' so the row is queryable and the live watcher can
        # re-bucket it the next time the replay is touched.
        build_name = ctx.my_build or "Unknown"

        try:
            outcome = _add_or_replace(store, build_name, record,
                                      force=args.force)
        except Exception as exc:
            errors += 1
            _emit({"progress": {
                "i": i, "total": total, "ok": False,
                "file": os.path.basename(path),
                "error": f"db write failed: {exc}",
            }})
            continue

        if outcome in ("added", "updated"):
            updated += 1
        else:
            skipped += 1
        _emit({"progress": {
            "i": i, "total": total, "ok": True,
            "file": os.path.basename(path),
            "action": outcome,
        }})

    _emit({"result": {
        "updated": updated, "errors": errors, "skipped": skipped,
        "total": total,
    }})
    return 0 if errors == 0 else 1


def main(argv: Optional[List[str]] = None) -> int:
    p = argparse.ArgumentParser(prog="macro_cli")
    sub = p.add_subparsers(dest="cmd", required=True)

    bf = sub.add_parser("backfill",
                        help="Import .SC2Replay files into meta_database.json.")
    bf.add_argument("--db", default=None, help="Analyzer DB path.")
    bf.add_argument("--player", default=None, help="Player handle.")
    bf.add_argument("--limit", type=int, default=0,
                    help="Stop after N replays (0 = no cap).")
    bf.add_argument("--force", action="store_true",
                    help="Re-import games already present in the DB.")

    args = p.parse_args(argv)
    if args.cmd == "backfill":
        return _cmd_backfill(args)
    p.error(f"unknown subcommand: {args.cmd}")
    return 2


if __name__ == "__main__":
    try:
        sys.exit(main())
    except Exception as exc:
        traceback.print_exc()
        sys.stderr.write(f"macro_cli: fatal: {exc}\n")
        sys.exit(3)
