"""
core.sqlite_shadow -- Stage 8 of STAGE_DATA_INTEGRITY_ROADMAP, sub-step 1.

Read-only SQLite shadow of the JSON data store. Populated by a
one-shot loader; the JSON files remain canonical. Future sub-steps
(dual-write, cutover, deprecation) flip the canonical writer one
endpoint at a time behind feature flags.

Schema
------

    CREATE TABLE opponents (
        pulse_id   TEXT PRIMARY KEY,
        name       TEXT NOT NULL,
        race       TEXT,
        notes      TEXT,
        last_seen  TEXT
    );

    CREATE TABLE games (
        rowid      INTEGER PRIMARY KEY AUTOINCREMENT,
        pulse_id   TEXT NOT NULL REFERENCES opponents(pulse_id),
        matchup    TEXT NOT NULL,
        date_iso   TEXT NOT NULL,
        result     TEXT NOT NULL,
        map        TEXT,
        duration   INTEGER,
        my_build   TEXT,
        opp_strategy TEXT,
        build_log_json TEXT
    );
    CREATE INDEX idx_games_pulse ON games(pulse_id);
    CREATE INDEX idx_games_date  ON games(date_iso);
    CREATE INDEX idx_games_matchup ON games(matchup);

    CREATE TABLE builds (
        build_name TEXT PRIMARY KEY,
        wins INTEGER NOT NULL DEFAULT 0,
        losses INTEGER NOT NULL DEFAULT 0
    );

    CREATE TABLE meta_games (
        rowid INTEGER PRIMARY KEY AUTOINCREMENT,
        build_name TEXT NOT NULL REFERENCES builds(build_name),
        game_id TEXT NOT NULL,
        opponent TEXT,
        opp_race TEXT,
        opp_strategy TEXT,
        map TEXT,
        result TEXT,
        date_iso TEXT,
        game_length INTEGER,
        file_path TEXT,
        opp_pulse_id TEXT,
        build_log_json TEXT
    );
    CREATE INDEX idx_meta_games_build ON meta_games(build_name);
    CREATE INDEX idx_meta_games_date ON meta_games(date_iso);

    CREATE TABLE schema_meta (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL
    );

WAL mode
--------
The shadow opens with ``PRAGMA journal_mode=WAL`` so a single writer
and many concurrent readers don't block each other. The roadmap's
Stage 8 cutover assumes WAL.

Lifecycle
---------

* :func:`build_shadow(data_dir, sqlite_path)` -- one-shot loader.
  Reads every JSON file via the canonical helpers, populates the DB,
  records the load timestamp + source-file hashes in
  ``schema_meta``. Idempotent: re-running rebuilds the DB from
  scratch.

* :func:`is_shadow_fresh(data_dir, sqlite_path, max_age_sec)` --
  cheap freshness check used by the read path. Compares the
  shadow's recorded JSON file mtimes against the live mtimes; a
  mismatch means the JSON has been mutated since the last build
  and the shadow should be rebuilt before serving reads.

* :func:`enabled()` -- True when ``SC2TOOLS_ENABLE_SQLITE_READS=1``.
  The Stage 8 sub-step 1 ships ``enabled() == False`` by default.
  A future sub-step flips the default once dual-write is in place.

* CLI ``python -m core.sqlite_shadow build``  rebuilds.
* CLI ``python -m core.sqlite_shadow status`` prints the snapshot.

Stage 8 ships read-only. No writers route through this module yet.
"""

from __future__ import annotations

import argparse
import dataclasses
import hashlib
import json
import logging
import os
import sqlite3
import sys
import time
from typing import Any, Dict, Iterable, List, Optional, Tuple

logger = logging.getLogger("sqlite_shadow")


ENABLE_ENV_VAR = "SC2TOOLS_ENABLE_SQLITE_READS"
ENABLE_VALUE = "1"
DEFAULT_FRESHNESS_MAX_AGE_SEC = 600  # 10 min

DEFAULT_BASENAMES = (
    "MyOpponentHistory.json",
    "meta_database.json",
    "custom_builds.json",
    "profile.json",
    "config.json",
)

SCHEMA_DDL = (
    """
    CREATE TABLE IF NOT EXISTS opponents (
        pulse_id   TEXT PRIMARY KEY,
        name       TEXT NOT NULL,
        race       TEXT,
        notes      TEXT,
        last_seen  TEXT
    );
    """,
    """
    CREATE TABLE IF NOT EXISTS games (
        rowid          INTEGER PRIMARY KEY AUTOINCREMENT,
        pulse_id       TEXT NOT NULL,
        matchup        TEXT NOT NULL,
        date_iso       TEXT NOT NULL,
        result         TEXT NOT NULL,
        map            TEXT,
        duration       INTEGER,
        my_build       TEXT,
        opp_strategy   TEXT,
        build_log_json TEXT,
        FOREIGN KEY(pulse_id) REFERENCES opponents(pulse_id)
    );
    """,
    "CREATE INDEX IF NOT EXISTS idx_games_pulse   ON games(pulse_id);",
    "CREATE INDEX IF NOT EXISTS idx_games_date    ON games(date_iso);",
    "CREATE INDEX IF NOT EXISTS idx_games_matchup ON games(matchup);",
    """
    CREATE TABLE IF NOT EXISTS builds (
        build_name TEXT PRIMARY KEY,
        wins   INTEGER NOT NULL DEFAULT 0,
        losses INTEGER NOT NULL DEFAULT 0
    );
    """,
    """
    CREATE TABLE IF NOT EXISTS meta_games (
        rowid          INTEGER PRIMARY KEY AUTOINCREMENT,
        build_name     TEXT NOT NULL,
        game_id        TEXT NOT NULL,
        opponent       TEXT,
        opp_race       TEXT,
        opp_strategy   TEXT,
        map            TEXT,
        result         TEXT,
        date_iso       TEXT,
        game_length    INTEGER,
        file_path      TEXT,
        opp_pulse_id   TEXT,
        build_log_json TEXT,
        FOREIGN KEY(build_name) REFERENCES builds(build_name)
    );
    """,
    "CREATE INDEX IF NOT EXISTS idx_meta_games_build ON meta_games(build_name);",
    "CREATE INDEX IF NOT EXISTS idx_meta_games_date  ON meta_games(date_iso);",
    """
    CREATE TABLE IF NOT EXISTS schema_meta (
        key   TEXT PRIMARY KEY,
        value TEXT NOT NULL
    );
    """,
)


# ---------------------------------------------------------------------------
# Public API
# ---------------------------------------------------------------------------
def enabled() -> bool:
    """True when the SQLite read path should be served instead of JSON.

    Stage 8 sub-step 1 ships off-by-default. A future sub-step
    flips the default once dual-write is in place.
    """
    return os.environ.get(ENABLE_ENV_VAR, "0") == ENABLE_VALUE


def open_db(sqlite_path: str) -> sqlite3.Connection:
    """Open the shadow DB with WAL + sane pragmas."""
    parent = os.path.dirname(sqlite_path) or "."
    os.makedirs(parent, exist_ok=True)
    conn = sqlite3.connect(sqlite_path, isolation_level=None)
    conn.row_factory = sqlite3.Row
    conn.execute("PRAGMA journal_mode = WAL;")
    conn.execute("PRAGMA synchronous = NORMAL;")
    conn.execute("PRAGMA foreign_keys = ON;")
    return conn


def ensure_schema(conn: sqlite3.Connection) -> None:
    for stmt in SCHEMA_DDL:
        conn.execute(stmt)


# ---------------------------------------------------------------------------
# Loader
# ---------------------------------------------------------------------------
@dataclasses.dataclass
class LoadStats:
    opponents: int = 0
    games: int = 0
    builds: int = 0
    meta_games: int = 0
    duration_sec: float = 0.0
    source_file_hashes: Dict[str, str] = dataclasses.field(default_factory=dict)

    def to_dict(self) -> Dict[str, Any]:
        return dataclasses.asdict(self)


def _file_signature(path: str) -> str:
    """Cheap stable signature: size + mtime + first 4KiB sha1.

    Used as a freshness check. A real hash of the entire file would
    be stable across renames-without-content-change but burn CPU on
    every diagnostics request.
    """
    try:
        st = os.stat(path)
    except OSError:
        return "missing"
    h = hashlib.sha1()
    try:
        with open(path, "rb") as f:
            head = f.read(4096)
        h.update(head)
    except OSError:
        pass
    return f"{st.st_size}:{int(st.st_mtime)}:{h.hexdigest()[:8]}"


def _load_history(conn: sqlite3.Connection, history: Dict[str, Any]) -> Tuple[int, int]:
    """Load history into the opponents + games tables.

    Insert order matters: each opponent is inserted BEFORE any of
    its games so the games' foreign-key reference is valid. We also
    pre-walk the matchups to compute the opponent's last_seen
    timestamp, which the SPA's "recently played" view sorts on.
    """
    n_opps = 0
    n_games = 0
    for pulse_id, rec in history.items():
        if pulse_id in {"_schema_version", "version"}:
            continue
        if not isinstance(rec, dict):
            continue
        n_opps += 1
        # Walk Matchups schema; flat-schema records (post-Stage 1
        # recovery they are converted) also work because the upgrade
        # script pulled them under "Unknown".
        matchups = rec.get("Matchups") or {}
        if not isinstance(matchups, dict):
            matchups = {}
        last_seen = ""
        pending_games: List[Tuple[Any, ...]] = []
        for mu_key, mu_val in matchups.items():
            if not isinstance(mu_val, dict):
                continue
            for g in mu_val.get("Games") or []:
                if not isinstance(g, dict):
                    continue
                build_log = g.get("build_log")
                build_log_json = (
                    json.dumps(build_log, ensure_ascii=False)
                    if isinstance(build_log, list) else None
                )
                date_iso = (g.get("Date") or "")
                if date_iso > last_seen:
                    last_seen = date_iso
                pending_games.append((
                    pulse_id,
                    mu_key,
                    date_iso,
                    g.get("Result") or "",
                    g.get("Map"),
                    g.get("Duration") if isinstance(g.get("Duration"), int) else None,
                    g.get("my_build"),
                    g.get("opp_strategy"),
                    build_log_json,
                ))
        # Insert opponent FIRST so the foreign key on games is valid.
        conn.execute(
            """INSERT OR REPLACE INTO opponents
            (pulse_id, name, race, notes, last_seen)
            VALUES (?, ?, ?, ?, ?)""",
            (
                pulse_id,
                rec.get("Name", "") or "",
                rec.get("Race"),
                rec.get("Notes"),
                last_seen or None,
            ),
        )
        if pending_games:
            conn.executemany(
                """INSERT INTO games
                (pulse_id, matchup, date_iso, result, map, duration,
                 my_build, opp_strategy, build_log_json)
                VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)""",
                pending_games,
            )
            n_games += len(pending_games)
    return n_opps, n_games


def _load_meta(conn: sqlite3.Connection, meta_db: Dict[str, Any]) -> Tuple[int, int]:
    n_builds = 0
    n_games = 0
    for build_name, bd in meta_db.items():
        if build_name in {"_schema_version", "version"}:
            continue
        if not isinstance(bd, dict):
            continue
        n_builds += 1
        wins = bd.get("wins") if isinstance(bd.get("wins"), int) else 0
        losses = bd.get("losses") if isinstance(bd.get("losses"), int) else 0
        conn.execute(
            "INSERT OR REPLACE INTO builds (build_name, wins, losses) VALUES (?, ?, ?)",
            (build_name, wins, losses),
        )
        for g in bd.get("games") or []:
            if not isinstance(g, dict):
                continue
            build_log = g.get("build_log")
            build_log_json = (
                json.dumps(build_log, ensure_ascii=False)
                if isinstance(build_log, list) else None
            )
            conn.execute(
                """INSERT INTO meta_games
                (build_name, game_id, opponent, opp_race, opp_strategy,
                 map, result, date_iso, game_length, file_path,
                 opp_pulse_id, build_log_json)
                VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)""",
                (
                    build_name,
                    str(g.get("id") or g.get("game_id") or ""),
                    g.get("opponent"),
                    g.get("opp_race"),
                    g.get("opp_strategy"),
                    g.get("map"),
                    g.get("result"),
                    g.get("date"),
                    g.get("game_length") if isinstance(g.get("game_length"), int) else None,
                    g.get("file_path"),
                    g.get("opp_pulse_id"),
                    build_log_json,
                ),
            )
            n_games += 1
    return n_builds, n_games


def build_shadow(
    data_dir: str,
    sqlite_path: str,
    *,
    history_path: Optional[str] = None,
    meta_path: Optional[str] = None,
) -> LoadStats:
    """Rebuild the shadow DB from the on-disk JSON files.

    Idempotent: drops existing rows from the four populated tables
    before re-inserting, so two consecutive runs with the same
    inputs produce identical row counts.
    """
    history_path = history_path or os.path.join(data_dir, "MyOpponentHistory.json")
    meta_path = meta_path or os.path.join(data_dir, "meta_database.json")
    started = time.time()
    stats = LoadStats()

    conn = open_db(sqlite_path)
    try:
        ensure_schema(conn)
        conn.execute("BEGIN")
        # Idempotent rebuild.
        for tbl in ("games", "opponents", "meta_games", "builds", "schema_meta"):
            conn.execute(f"DELETE FROM {tbl}")
        # Load -- stamp signatures even when the source file is
        # missing (so a missing file's fingerprint reads "missing"
        # and a freshness check after the file appears reports a
        # mismatch).
        sig_h = _file_signature(history_path)
        sig_m = _file_signature(meta_path)
        stats.source_file_hashes[history_path] = sig_h
        stats.source_file_hashes[meta_path] = sig_m

        from core.atomic_io import safe_read_json
        history = safe_read_json(history_path, {}) or {}
        if isinstance(history, dict):
            stats.opponents, stats.games = _load_history(conn, history)
        meta_db = safe_read_json(meta_path, {}) or {}
        if isinstance(meta_db, dict):
            stats.builds, stats.meta_games = _load_meta(conn, meta_db)
        conn.execute(
            "INSERT OR REPLACE INTO schema_meta (key, value) VALUES (?, ?)",
            ("loaded_at", str(int(started))),
        )
        for path, sig in stats.source_file_hashes.items():
            conn.execute(
                "INSERT OR REPLACE INTO schema_meta (key, value) VALUES (?, ?)",
                ("sig:" + os.path.basename(path), sig),
            )
        conn.execute("COMMIT")
    except Exception:
        conn.execute("ROLLBACK")
        raise
    finally:
        conn.close()

    stats.duration_sec = time.time() - started
    logger.info(
        "[sqlite_shadow] built: opponents=%d games=%d builds=%d meta_games=%d in %.2fs",
        stats.opponents, stats.games, stats.builds, stats.meta_games,
        stats.duration_sec,
    )
    return stats


# ---------------------------------------------------------------------------
# Freshness
# ---------------------------------------------------------------------------
def is_shadow_fresh(
    data_dir: str,
    sqlite_path: str,
    *,
    max_age_sec: float = DEFAULT_FRESHNESS_MAX_AGE_SEC,
) -> bool:
    """True when the shadow's recorded signatures match the live files.

    Used by the read path to decide whether to fall back to JSON
    (the canonical source) or trust the shadow. Returns False if
    the shadow doesn't exist yet, or if any tracked source file's
    signature has drifted.
    """
    if not os.path.exists(sqlite_path):
        return False
    try:
        conn = open_db(sqlite_path)
    except sqlite3.DatabaseError:
        return False
    try:
        cur = conn.execute("SELECT key, value FROM schema_meta")
        meta = {row["key"]: row["value"] for row in cur}
    finally:
        conn.close()

    loaded_at = int(meta.get("loaded_at", "0"))
    if loaded_at <= 0:
        return False
    if time.time() - loaded_at > max_age_sec:
        return False
    for basename in DEFAULT_BASENAMES:
        path = os.path.join(data_dir, basename)
        recorded = meta.get("sig:" + basename)
        live = _file_signature(path)
        if recorded is not None and recorded != live:
            return False
    return True


# ---------------------------------------------------------------------------
# Read helpers (used by Stage 8 sub-step 1's feature-flagged path)
# ---------------------------------------------------------------------------
def list_opponents(sqlite_path: str, *, limit: int = 5000) -> List[Dict[str, Any]]:
    if not enabled():
        raise RuntimeError("sqlite_shadow read path is gated by SC2TOOLS_ENABLE_SQLITE_READS=1")
    conn = open_db(sqlite_path)
    try:
        cur = conn.execute(
            "SELECT pulse_id, name, race, notes, last_seen FROM opponents "
            "ORDER BY last_seen DESC LIMIT ?",
            (int(limit),),
        )
        return [dict(row) for row in cur]
    finally:
        conn.close()


def opponent_games(sqlite_path: str, pulse_id: str) -> List[Dict[str, Any]]:
    if not enabled():
        raise RuntimeError("sqlite_shadow read path is gated by SC2TOOLS_ENABLE_SQLITE_READS=1")
    conn = open_db(sqlite_path)
    try:
        cur = conn.execute(
            """SELECT matchup, date_iso, result, map, duration, my_build,
                       opp_strategy, build_log_json
               FROM games WHERE pulse_id = ?
               ORDER BY date_iso DESC""",
            (pulse_id,),
        )
        return [dict(row) for row in cur]
    finally:
        conn.close()


# ---------------------------------------------------------------------------
# CLI
# ---------------------------------------------------------------------------
def _default_sqlite_path() -> str:
    here = os.path.dirname(os.path.abspath(__file__))
    return os.path.join(here, os.pardir, "data", "shadow.sqlite3")


def _build_argparser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(
        description="Stage 8 -- read-only SQLite shadow loader.",
    )
    sub = parser.add_subparsers(dest="cmd", required=True)
    p_build = sub.add_parser("build", help="(re)build the shadow DB")
    p_build.add_argument("--data-dir", default=None)
    p_build.add_argument("--sqlite", default=None)

    p_status = sub.add_parser("status", help="print row counts + freshness")
    p_status.add_argument("--data-dir", default=None)
    p_status.add_argument("--sqlite", default=None)
    return parser


def main(argv: Optional[List[str]] = None) -> int:
    args = _build_argparser().parse_args(argv)
    logging.basicConfig(level=logging.INFO,
                        format="%(asctime)s %(levelname)s %(name)s: %(message)s")
    here = os.path.dirname(os.path.abspath(__file__))
    data_dir = os.path.abspath(args.data_dir or os.path.join(here, os.pardir, "data"))
    sqlite_path = os.path.abspath(args.sqlite or _default_sqlite_path())

    if args.cmd == "build":
        stats = build_shadow(data_dir, sqlite_path)
        print(json.dumps(stats.to_dict(), indent=2, default=str))
        return 0
    if args.cmd == "status":
        if not os.path.exists(sqlite_path):
            print(json.dumps({"exists": False, "fresh": False}))
            return 0
        conn = open_db(sqlite_path)
        try:
            cur = conn.execute(
                "SELECT (SELECT COUNT(*) FROM opponents) AS opps, "
                "(SELECT COUNT(*) FROM games) AS games, "
                "(SELECT COUNT(*) FROM builds) AS builds, "
                "(SELECT COUNT(*) FROM meta_games) AS meta_games"
            )
            row = dict(cur.fetchone())
        finally:
            conn.close()
        row["fresh"] = is_shadow_fresh(data_dir, sqlite_path)
        row["enabled"] = enabled()
        row["sqlite_path"] = sqlite_path
        print(json.dumps(row, indent=2))
        return 0
    return 2


if __name__ == "__main__":
    sys.exit(main())
