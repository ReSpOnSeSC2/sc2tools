"""
Unified data store for the merged SC2 tools.

This module is the single point of truth for both JSON databases:

    MyOpponentHistory.json   -- pulse-id keyed Black Book (overlay)
    meta_database.json       -- build-name keyed analyzer DB

Schema (kept identical to the legacy formats so the existing
analyzer GUI and overlay backend continue to work unchanged):

    Black Book:
        {
            "<pulse_id>": {
                "Name": "Opponent",
                "Race": "Z",
                "Notes": "...",
                "Matchups": {
                    "PvZ": {
                        "Wins": int, "Losses": int,
                        "Games": [
                            {"Date": "YYYY-MM-DD HH:MM",
                             "Result": "Victory" | "Defeat",
                             "Map": "...",
                             "Duration": int,
                             "opp_strategy": "...",   (added by deep parse)
                             "my_build": "...",       (added by deep parse)
                             "build_log": [...]}      (added by deep parse)
                        ]
                    }
                }
            }
        }

    Analyzer DB (flat legacy schema):
        {
            "<my_build_name>": {
                "games": [{
                    "id": "...",
                    "opponent": "...",
                    "opp_race": "Zerg",
                    "opp_strategy": "...",
                    "map": "...",
                    "result": "Win" | "Loss" | "Tie" | "Unknown",
                    "date": "ISO8601",
                    "game_length": int,
                    "build_log": [...],
                    "file_path": "...",
                    "opp_pulse_id": "..."   (NEW: cross-link to Black Book)
                }, ...],
                "wins": int,
                "losses": int
            }
        }

All writes are atomic (tmp + os.replace) and serialized through
threading.RLock so the live watcher and the analyzer GUI can share
the files safely.
"""

from __future__ import annotations

import json
import os

from .atomic_io import (
    DataIntegrityError as _AtomicIODataIntegrityError,
    atomic_write_json as _canonical_atomic_write_json,
    atomic_write_text,
)
import shutil
import threading
from datetime import datetime
from typing import Any, Dict, List, Optional, Set

from .build_definitions import KNOWN_BUILDS
from .paths import (
    DATA_DIR,
    HISTORY_FILE,
    LEGACY_HISTORY_FILE,
    META_DB_FILE,
    existing_history_path,
)


# =========================================================
# Atomic write
# =========================================================
# Stage 4 of STAGE_DATA_INTEGRITY_ROADMAP unifies the two
# DataIntegrityError classes that used to live independently in
# core.atomic_io and core.data_store. The exception type itself is
# now defined in atomic_io (so the canonical helper can raise it
# from inside the validate-before-rename gate); this module's
# alias keeps the historical import path
# (``from core.data_store import DataIntegrityError``) working
# for every existing caller.
DataIntegrityError = _AtomicIODataIntegrityError


# Catastrophic-shrinkage threshold. Used by save() callers to refuse
# writes that would drop > 50% of top-level keys on a previously-large
# file. Floor of 100 keeps small files (e.g. fresh installs) from
# being over-protected.
_SHRINKAGE_FLOOR_RATIO = 0.5
_SHRINKAGE_FLOOR_MIN_KEYS = 100


def _existing_top_level_key_count(path: str) -> int:
    """Return the number of top-level dict keys currently on disk, or 0.

    Best-effort: a parse failure returns 0 (no shrinkage guard fires
    against an unreadable file -- the read-side guard handles that).
    """
    try:
        if not os.path.exists(path):
            return 0
        with open(path, "r", encoding="utf-8-sig") as f:
            data = json.load(f)
        return len(data) if isinstance(data, dict) else 0
    except Exception:
        return 0


def _atomic_write_json(
    path: str,
    data: Any,
    indent: int = 4,
    *,
    min_keep_keys: Optional[int] = None,
) -> None:
    """Atomic JSON write -- shrinkage guard + canonical helper.

    Stage 2 of STAGE_DATA_INTEGRITY_ROADMAP: this is now a thin wrapper
    around :func:`core.atomic_io.atomic_write_json`. The canonical helper
    handles the cross-process lock, the .bak snapshot, the
    flush + fsync, the validate-before-rename gate (Stage 4), and the
    atomic rename. This wrapper only adds the data-store-specific
    shrinkage guard (refuse to wipe a previously-large dict).

    The shrinkage guard fires BEFORE the canonical helper runs, so a
    rejection leaves the live file untouched and never produces a
    .tmp file.

    Args:
        path: Destination JSON file.
        data: JSON-serialisable value.
        indent: Pretty-print indent (4 to match historical format).
        min_keep_keys: When set and the file already has at least this
            many top-level keys, refuse to write ``data`` if it would
            drop the key count below ``min_keep_keys``. Raises
            ``DataIntegrityError`` so callers can log loudly and abort.

    Raises:
        DataIntegrityError: when the shrinkage guard trips. The live
            file is unchanged.
    """
    if min_keep_keys is not None and isinstance(data, dict):
        on_disk = _existing_top_level_key_count(path)
        if on_disk >= min_keep_keys and len(data) < min_keep_keys:
            raise DataIntegrityError(
                f"refusing to write {path}: would shrink top-level keys "
                f"from {on_disk} to {len(data)} (floor={min_keep_keys}). "
                f"This is the read-modify-write wipe pattern. "
                f"Inspect the caller and the on-disk file; do not retry "
                f"blindly."
            )

    # Delegate to the canonical helper. It wraps the write in the
    # cross-process file_lock, snapshots .bak, fsyncs the temp before
    # rename, runs the Stage 4 validate-before-rename gate, and does
    # the atomic os.replace.
    _canonical_atomic_write_json(path, data, indent=indent)

def _read_json(path: str, default: Any) -> Any:
    """Read JSON with crash-safety + corruption-aware return semantics.

    Three-tier resolution:
      1. Parse the primary file.
      2. On parse failure, try ``<path>.bak`` (written by every
         atomic_write_json before its rename).
      3. On .bak failure, attempt the tolerant partial-recovery walk
         (``_recover_partial_db_json``) on the primary contents.

    Critical: when the primary FILE EXISTS but cannot be parsed AND
    every fallback also fails, this raises ``DataIntegrityError``
    instead of silently returning ``default``. Returning ``{}`` to
    a watcher that then runs ``data[pulse_id] = ...; save(data)`` is
    exactly how 27MB became 15KB on 2026-05-02. The default branch is
    reserved for the "no file" case.
    """
    if not os.path.exists(path):
        return default

    # Tier 1: primary
    parsed = _try_parse_json(path)
    if parsed is not None:
        return parsed

    # Tier 2: .bak
    bak_path = path + ".bak"
    parsed = _try_parse_json(bak_path)
    if parsed is not None:
        # Best-effort: copy the .bak forward so the next call can use
        # the primary path again. Failures here just mean we keep
        # falling through to .bak each call -- not catastrophic.
        try:
            shutil.copy2(bak_path, path)
        except Exception:
            pass
        return parsed

    # Tier 3: tolerant partial-recovery on primary
    try:
        with open(path, "r", encoding="utf-8-sig") as f:
            raw = f.read()
        recovered, _n = _recover_partial_db_json(raw)
        if recovered:
            try:
                with open(path + ".corrupt", "w", encoding="utf-8") as cf:
                    cf.write(raw)
            except Exception:
                pass
            return recovered
    except Exception:
        pass

    # All recovery paths exhausted. Raise so the caller can NOT
    # silently treat this as an empty database and overwrite real data.
    raise DataIntegrityError(
        f"unreadable JSON at {path} (and .bak fallback failed). "
        f"This is a corruption signal, not 'fresh-start'. Quarantine "
        f"the file, restore from a known-good backup, then retry."
    )


def _try_parse_json(path: str) -> Any:
    """Internal: parse one file, return None on any error (missing/corrupt/etc.)."""
    try:
        if not os.path.exists(path):
            return None
        with open(path, "r", encoding="utf-8-sig") as f:
            raw = f.read()
        raw = raw.strip(" \t\r\n\x00")
        if not raw:
            return None
        return json.loads(raw)
    except Exception:
        return None

def _recover_partial_db_json(raw: str):
    """Best-effort recovery of a truncated analyzer DB JSON.

    Mirrors `db.database.ReplayAnalyzer._recover_partial_json` from the
    SC2Replay-Analyzer project. Walks each top-level "build_name": {...}
    entry independently so a single bad/truncated entry only loses itself.
    Returns ``(data_dict, recovered_count)``.
    """
    recovered: Dict[str, Any] = {}
    i, n = 0, len(raw)
    while i < n and raw[i] != '{':
        i += 1
    if i >= n:
        return ({}, 0)
    i += 1

    while i < n:
        while i < n and raw[i] in ' \t\r\n,':
            i += 1
        if i >= n or raw[i] == '}':
            break
        if raw[i] != '"':
            break
        key_start = i + 1
        j = key_start
        while j < n and raw[j] != '"':
            if raw[j] == '\\' and j + 1 < n:
                j += 2
                continue
            j += 1
        if j >= n:
            break
        key = raw[key_start:j]
        i = j + 1
        while i < n and raw[i] in ' \t\r\n':
            i += 1
        if i >= n or raw[i] != ':':
            break
        i += 1
        while i < n and raw[i] in ' \t\r\n':
            i += 1
        if i >= n or raw[i] != '{':
            break
        depth = 0
        value_start = i
        in_string = False
        escape = False
        while i < n:
            ch = raw[i]
            if escape:
                escape = False
            elif in_string:
                if ch == '\\':
                    escape = True
                elif ch == '"':
                    in_string = False
            else:
                if ch == '"':
                    in_string = True
                elif ch == '{':
                    depth += 1
                elif ch == '}':
                    depth -= 1
                    if depth == 0:
                        i += 1
                        try:
                            recovered[key] = json.loads(raw[value_start:i])
                        except Exception:
                            pass
                        break
            i += 1
        else:
            break
    return (recovered, len(recovered))


# =========================================================
# Black Book (MyOpponentHistory.json)
# =========================================================
class BlackBookStore:
    """
    Pulse-id keyed opponent history. Atomic, thread-safe.
    """

    def __init__(self, path: Optional[str] = None):
        self.path = path or existing_history_path()
        self._lock = threading.RLock()

    # --- read/write -----------------------------------------------------
    def load(self) -> Dict[str, Any]:
        with self._lock:
            return _read_json(self.path, {})

    def save(self, data: Dict[str, Any]) -> None:
        with self._lock:
            on_disk = _existing_top_level_key_count(self.path)
            floor = (
                max(_SHRINKAGE_FLOOR_MIN_KEYS, int(on_disk * _SHRINKAGE_FLOOR_RATIO))
                if on_disk >= _SHRINKAGE_FLOOR_MIN_KEYS
                else None
            )
            _atomic_write_json(self.path, data, min_keep_keys=floor)

    # --- helpers --------------------------------------------------------
    @staticmethod
    def _strip_clan(name: str) -> str:
        return name.split("]")[-1].strip() if "]" in name else name.strip()

    @staticmethod
    def _strip_discriminator(name: str) -> str:
        """
        Strip the BattleTag discriminator (``#1234``) off the end of a
        name. SC2Pulse stores ``Character.Name`` with the discriminator
        (``"Yamada#622"``); ``sc2reader`` returns the bare in-game name
        (``"Yamada"``). Stripping both forms lets the name lookup match
        across the two paths.
        """
        if not name:
            return name
        i = name.rfind("#")
        return name[:i] if i >= 0 else name

    @classmethod
    def _name_forms(cls, name: str) -> Set[str]:
        """
        Comparable lowercased forms of a name: original, clan-stripped,
        discriminator-stripped, and both stripped. Two records are
        considered the same person when any pair of forms matches.

        Mirrors ``nameForms()`` in stream-overlay-backend/index.js so the
        Python watcher and the Node overlay backend agree on identity.
        """
        forms: Set[str] = set()
        if not name:
            return forms

        def _add(s: str) -> None:
            if s:
                forms.add(s.strip().lower())

        _add(name)
        no_clan = cls._strip_clan(name)
        _add(no_clan)
        _add(cls._strip_discriminator(name))
        _add(cls._strip_discriminator(no_clan))
        return forms

    def find_by_name(self, name: str) -> Optional[str]:
        """
        Pulse_id of the entry whose Name matches the given name.

        A match is any overlap between the comparable name forms (clan
        tag and BattleTag discriminator stripped, case-insensitive) of
        the needle and any stored ``Name`` field.

        When more than one record matches, a numeric Pulse ID is
        preferred over a synthetic ``unknown:<Name>`` key so a replay
        whose opponent now has a resolved Pulse character ID attaches
        to the canonical record instead of a legacy unknown bucket.
        """
        if not name:
            return None
        needle = self._name_forms(name)
        if not needle:
            return None

        history = self.load()
        unknown_match: Optional[str] = None
        for pulse_id, data in history.items():
            opp = (data or {}).get("Name", "")
            if not self._name_forms(opp).isdisjoint(needle):
                if str(pulse_id).startswith("unknown:"):
                    # Defer unknown:<Name> matches until we've confirmed
                    # there's no numeric twin for the same player.
                    if unknown_match is None:
                        unknown_match = pulse_id
                    continue
                return pulse_id
        return unknown_match

    def append_game(
        self,
        pulse_id: str,
        opp_name: str,
        opp_race_initial: str,
        matchup: str,
        game: Dict[str, Any],
        result: str,
    ) -> None:
        """
        Append a single game to the matchup, increment the W/L counter,
        and save. `matchup` is e.g. "PvZ"; `result` is "Victory" or "Defeat".
        """
        with self._lock:
            data = self.load()
            entry = data.setdefault(
                pulse_id,
                {"Name": opp_name, "Race": opp_race_initial, "Notes": "", "Matchups": {}},
            )
            entry.setdefault("Name", opp_name)
            entry.setdefault("Race", opp_race_initial)
            entry.setdefault("Notes", "")
            matchups = entry.setdefault("Matchups", {})
            mu = matchups.setdefault(matchup, {"Wins": 0, "Losses": 0, "Games": []})
            mu.setdefault("Games", [])
            if result == "Victory":
                mu["Wins"] = int(mu.get("Wins", 0)) + 1
            elif result == "Defeat":
                mu["Losses"] = int(mu.get("Losses", 0)) + 1
            mu["Games"].append(game)
            self.save(data)

    # ------------------------------------------------------------------
    # Game identity helpers
    # ------------------------------------------------------------------
    # A Black Book game record is uniquely identified by the tuple
    # (Date prefix, Map, Result). Date is stored as "YYYY-MM-DD HH:MM"
    # so the minute-precision is enough to distinguish back-to-back
    # replays unless they started in the same minute on the same map
    # with the same result -- which would be impossible in practice
    # because the user can't finish two games inside one minute.
    @staticmethod
    def _game_identity(game: Dict[str, Any]) -> tuple:
        return (
            (game.get("Date") or "")[:16],
            (game.get("Map") or ""),
            (game.get("Result") or ""),
        )

    def update_latest_game(
        self,
        pulse_id: str,
        matchup: str,
        patch: Dict[str, Any],
    ) -> bool:
        """
        DEPRECATED. Patch the most recent game record for the matchup.

        This blindly patches ``Games[-1]`` and was the source of the
        2026-04-28 Mirtillo bug: when two replays in the same matchup
        deep-parsed in sequence with no PowerShell stub on disk, the
        second deep-parse overwrote the first record's deep fields.

        Use :meth:`upsert_game` instead, which finds-or-appends by
        stable identity (Date, Map, Result). Will be removed one
        minor version after callers migrate.
        """
        with self._lock:
            data = self.load()
            entry = data.get(pulse_id)
            if not entry:
                return False
            mu = entry.get("Matchups", {}).get(matchup)
            if not mu or not mu.get("Games"):
                return False
            mu["Games"][-1].update(patch)
            self.save(data)
            return True

    def upsert_game(
        self,
        pulse_id: str,
        opp_name: str,
        opp_race_initial: str,
        matchup: str,
        game: Dict[str, Any],
        result: str,
    ) -> bool:
        """
        Find-or-append a single game record by (Date, Map, Result).

        If an existing record in the matchup matches this identity,
        merge ``game``'s fields into it (preserving existing keys not
        overwritten by ``game``) and DO NOT increment the W/L counter
        -- the prior write already counted it.

        Otherwise append a fresh record and increment W or L.

        Returns ``True`` if a new record was appended, ``False`` if an
        existing record was patched in place.

        Args:
            pulse_id: SC2Pulse character id, or ``"unknown:<Name>"``
                when Pulse can't resolve one (Random opponents).
            opp_name: Display name for the opponent (clan-tag
                stripped by the caller).
            opp_race_initial: ``"P" | "T" | "Z" | "R"``.
            matchup: e.g. ``"PvZ"``.
            game: Black Book game record. Must include ``Date``,
                ``Map``, ``Result``; may include deep-parse fields.
            result: ``"Victory"`` or ``"Defeat"``. Anything else is
                treated as a non-decided game and does not bump
                counters.

        Example:
            >>> bb.upsert_game(
            ...     pulse_id="unknown:Mirtillo",
            ...     opp_name="Mirtillo",
            ...     opp_race_initial="P",
            ...     matchup="PvP",
            ...     game={"Date": "2026-04-28 17:11",
            ...           "Result": "Defeat",
            ...           "Map": "10000 Feet LE",
            ...           "Duration": 534},
            ...     result="Defeat",
            ... )
            True
        """
        target_id = self._game_identity(game)
        with self._lock:
            data = self.load()
            entry = data.setdefault(
                pulse_id,
                {"Name": opp_name, "Race": opp_race_initial, "Notes": "", "Matchups": {}},
            )
            entry.setdefault("Name", opp_name)
            entry.setdefault("Race", opp_race_initial)
            entry.setdefault("Notes", "")
            matchups = entry.setdefault("Matchups", {})
            mu = matchups.setdefault(matchup, {"Wins": 0, "Losses": 0, "Games": []})
            mu.setdefault("Games", [])

            for existing in mu["Games"]:
                if self._game_identity(existing) == target_id:
                    existing.update(game)
                    self.save(data)
                    return False

            if result == "Victory":
                mu["Wins"] = int(mu.get("Wins", 0)) + 1
            elif result == "Defeat":
                mu["Losses"] = int(mu.get("Losses", 0)) + 1
            mu["Games"].append(game)
            self.save(data)
            return True


# =========================================================
# Analyzer DB (meta_database.json) -- legacy flat schema
# =========================================================
class AnalyzerDBStore:
    """
    Build-name keyed analyzer database, legacy schema.

        { "<build>": {"games": [...], "wins": int, "losses": int} }

    The analyzer GUI works directly against this flat dict. Writes are
    atomic and serialized.
    """

    def __init__(self, path: Optional[str] = None):
        self.path = path or META_DB_FILE
        self._lock = threading.RLock()

    # --- read/write -----------------------------------------------------
    def load(self) -> Dict[str, Any]:
        """
        Load the DB, ensuring every KNOWN_BUILDS entry exists with the
        legacy {games, wins, losses} shape.
        """
        with self._lock:
            data = _read_json(self.path, {})
            if not isinstance(data, dict):
                data = {}
            for b in KNOWN_BUILDS:
                if b not in data:
                    data[b] = {"games": [], "wins": 0, "losses": 0}
                else:
                    data[b].setdefault("games", [])
                    data[b].setdefault("wins", 0)
                    data[b].setdefault("losses", 0)
            return data

    def save(self, data: Dict[str, Any]) -> None:
        with self._lock:
            on_disk = _existing_top_level_key_count(self.path)
            floor = (
                max(_SHRINKAGE_FLOOR_MIN_KEYS, int(on_disk * _SHRINKAGE_FLOOR_RATIO))
                if on_disk >= _SHRINKAGE_FLOOR_MIN_KEYS
                else None
            )
            _atomic_write_json(self.path, data, min_keep_keys=floor)

    def backup(self) -> Optional[str]:
        """Snapshot the current DB to meta_database.json.backup-<date>."""
        with self._lock:
            if not os.path.exists(self.path):
                return None
            stamp = datetime.now().strftime("%Y%m%d-%H%M%S")
            dst = f"{self.path}.backup-{stamp}"
            try:
                shutil.copy2(self.path, dst)
                return dst
            except Exception:
                return None

    # --- helpers --------------------------------------------------------
    def known_game_ids(self, db: Optional[Dict[str, Any]] = None) -> Set[str]:
        if db is None:
            db = self.load()
        return {
            g.get("id")
            for bd in db.values()
            for g in bd.get("games", [])
            if g.get("id")
        }

    @staticmethod
    def recalc_stats(db: Dict[str, Any], build_name: str) -> None:
        if build_name not in db:
            return
        wins = sum(1 for g in db[build_name].get("games", []) if g.get("result") == "Win")
        losses = sum(1 for g in db[build_name].get("games", []) if g.get("result") == "Loss")
        db[build_name]["wins"] = wins
        db[build_name]["losses"] = losses

    def add_game(
        self,
        build_name: str,
        game: Dict[str, Any],
    ) -> bool:
        """
        Insert a game into the analyzer DB (idempotent on game id).
        Returns True if newly added, False if it already existed.
        """
        with self._lock:
            db = self.load()
            existing_ids = self.known_game_ids(db)
            if game.get("id") in existing_ids:
                return False
            if build_name not in db:
                db[build_name] = {"games": [], "wins": 0, "losses": 0}
            db[build_name]["games"].append(game)
            self.recalc_stats(db, build_name)
            self.save(db)
            return True


# =========================================================
# Cross-DB linking facade
# =========================================================
class DataStore:
    """
    Thin facade owning both DBs. Used by the live watcher and (via
    direct attribute access) by the analyzer GUI.
    """

    def __init__(self):
        self.black_book = BlackBookStore()
        self.analyzer = AnalyzerDBStore()

    def link_game(
        self,
        *,
        pulse_id: str,
        matchup: str,
        opp_name: str,
        opp_race_initial: str,
        my_build: str,
        opp_strategy: str,
        analyzer_game: Dict[str, Any],
        black_book_game: Dict[str, Any],
        result: str,
        my_race: str,
    ) -> None:
        """
        Atomically link a single replay across both DBs:
          * append to the analyzer DB (idempotent on game id)
          * patch the latest Black Book game with strategy/build/log;
            if no entry exists yet, append a fresh one.
        """
        analyzer_game.setdefault("opp_pulse_id", pulse_id)
        self.analyzer.add_game(my_build, analyzer_game)

        # Identity-aware upsert: find-or-append by (Date, Map, Result).
        # Replaces the legacy patch-Games[-1] flow that lost rematch
        # records for opponents without a Pulse-resolved character id.
        self.black_book.upsert_game(
            pulse_id=pulse_id,
            opp_name=opp_name,
            opp_race_initial=opp_race_initial,
            matchup=matchup,
            game=black_book_game,
            result=result,
        )

    def merge_unknown_into_numeric(
        self,
        *,
        numeric_pulse_id: str,
        opp_name: str,
    ) -> Optional[Dict[str, Any]]:
        """Fold legacy ``unknown:<Name>`` twin records into the numeric ID.

        Called inline from the watcher's ``_persist_deep`` whenever
        the SC2Pulse toon resolver returns a numeric character ID and
        the Black Book still carries a synthetic ``unknown:<Name>``
        record for the same player (typically created during an
        earlier session before SC2Pulse was reachable). The merge:

          * Walks every ``unknown:<Name>`` record whose name forms
            (clan-tag and discriminator stripped, case-insensitive)
            overlap ``opp_name``.
          * Folds their Matchups / Games into ``numeric_pulse_id``
            with identity-based dedupe (Date+Map+Result). Wins and
            losses are bumped only for newly-appended games.
          * Drops the unknown keys from history.
          * Rewrites every ``opp_pulse_id`` reference in the analyzer
            DB from the unknown key to the numeric ID.

        Atomic: each store is loaded, mutated under its own lock,
        and saved through ``_atomic_write_json``.

        Returns ``None`` when there is nothing to merge, otherwise a
        ``{plan, stats, meta_rewritten}`` dict suitable for logging.

        Args:
            numeric_pulse_id: SC2Pulse character ID resolved via the
                replay's ``toon_handle``. Must NOT be an
                ``unknown:<Name>`` key -- a no-op is returned in
                that case.
            opp_name: Display name of the opponent (clan tag
                already stripped by the caller).

        Example:
            >>> ds = DataStore()  # doctest: +SKIP
            >>> ds.merge_unknown_into_numeric(  # doctest: +SKIP
            ...     numeric_pulse_id="197079",
            ...     opp_name="XVec",
            ... )
        """
        if not numeric_pulse_id or numeric_pulse_id.startswith("unknown:"):
            return None
        # Lazy import: scripts/ depends on core/, so a top-level
        # import would create a circular dependency.
        from scripts.merge_unknown_pulse_ids import (
            UNKNOWN_PREFIX,
            merge_records_in_place,
            rewrite_analyzer_pulse_ids,
        )

        target_forms = BlackBookStore._name_forms(opp_name)
        if not target_forms:
            return None

        with self.black_book._lock:
            history = self.black_book.load()
            if numeric_pulse_id not in history:
                # The numeric record was just created by upsert_game
                # via link_game above, but the load() call here
                # could race a concurrent rewrite. Bail out cleanly.
                return None
            plan: Dict[str, str] = {}
            for key, rec in history.items():
                if not str(key).startswith(UNKNOWN_PREFIX):
                    continue
                rec_name = (rec or {}).get("Name", "") \
                    or key[len(UNKNOWN_PREFIX):]
                rec_forms = BlackBookStore._name_forms(rec_name)
                if rec_forms and not rec_forms.isdisjoint(target_forms):
                    plan[key] = numeric_pulse_id
            if not plan:
                return None
            stats = merge_records_in_place(history, plan)
            self.black_book.save(history)

        # Rewrite analyzer DB cross-links so /games/<id>/* lookups
        # resolve to the canonical record.
        rewritten = 0
        with self.analyzer._lock:
            meta = self.analyzer.load()
            rewritten = rewrite_analyzer_pulse_ids(meta, plan)
            if rewritten:
                self.analyzer.save(meta)

        return {"plan": plan, "stats": stats, "meta_rewritten": rewritten}


# =========================================================
# Migration helper
# =========================================================
def migrate_legacy_files() -> Dict[str, str]:
    """
    Move legacy on-disk files into the unified data/ folder, taking a
    timestamped backup of meta_database.json on first run. Idempotent.

    Returns a dict {source_path: action_taken}.
    """
    actions: Dict[str, str] = {}
    os.makedirs(DATA_DIR, exist_ok=True)

    # 1. MyOpponentHistory.json: prefer existing data/ copy; otherwise
    # copy the legacy project-root file in.
    if not os.path.exists(HISTORY_FILE) and os.path.exists(LEGACY_HISTORY_FILE):
        try:
            shutil.copy2(LEGACY_HISTORY_FILE, HISTORY_FILE)
            actions[LEGACY_HISTORY_FILE] = f"copied -> {HISTORY_FILE}"
        except Exception as exc:
            actions[LEGACY_HISTORY_FILE] = f"copy failed: {exc}"

    # 2. meta_database.json from the original analyzer folder, if present.
    legacy_meta_candidates = [
        os.path.join(
            os.path.dirname(os.path.dirname(DATA_DIR)),
            "SC2Replay-Analyzer",
            "meta_database.json",
        ),
        # Some installs keep the analyzer next to the overlay folder:
        os.path.join(
            os.path.dirname(os.path.dirname(os.path.dirname(DATA_DIR))),
            "SC2Replay-Analyzer",
            "meta_database.json",
        ),
    ]
    if not os.path.exists(META_DB_FILE):
        for legacy_meta in legacy_meta_candidates:
            if os.path.exists(legacy_meta):
                try:
                    shutil.copy2(legacy_meta, META_DB_FILE)
                    actions[legacy_meta] = f"copied -> {META_DB_FILE}"
                    break
                except Exception as exc:
                    actions[legacy_meta] = f"copy failed: {exc}"

    # 3. One-time backup of meta_database.json on first migration.
    if os.path.exists(META_DB_FILE):
        backup_marker = META_DB_FILE + ".initial_backup_done"
        if not os.path.exists(backup_marker):
            try:
                stamp = datetime.now().strftime("%Y%m%d-%H%M%S")
                dst = f"{META_DB_FILE}.backup-{stamp}"
                shutil.copy2(META_DB_FILE, dst)
                # Atomic marker write -- a torn write of the timestamp
                # could trick the next migration into re-running the
                # one-time backup.
                atomic_write_text(backup_marker, stamp)
                actions[META_DB_FILE] = f"backup -> {dst}"
            except Exception as exc:
                actions[META_DB_FILE] = f"backup failed: {exc}"

    return actions
