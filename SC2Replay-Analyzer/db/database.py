"""ReplayAnalyzer - in-memory database backed by `meta_database.json`.

Holds the per-build win/loss records and exposes the aggregate queries the UI
renders (map stats, opponent strategy stats, build-vs-strategy stats, etc.).
All on-disk reads/writes go through `db.migrations` so schema versioning is
applied automatically.
"""

import csv
import json
import os
import threading
from typing import Dict, List, Optional, Set

import sc2reader

from analytics.opponent_profiler import OpponentProfiler
from core.error_logger import ErrorLogger
from core.paths import DB_FILE
from detectors.definitions import KNOWN_BUILDS

from .migrations import (
    CURRENT_SCHEMA_VERSION,
    ensure_schema_version,
    migrate,
    stamp_schema_version,
)


class ReplayAnalyzer:
    def __init__(self):
        self._schema_version: int = CURRENT_SCHEMA_VERSION
        self._db_revision: int = 0
        self._stats_cache: Dict[str, Dict] = {}
        self.db: Dict = self.load_database()
        self.potential_player_names: Set[str] = set()
        self.selected_player_name: Optional[str] = None
        self.error_logger = ErrorLogger()
        self._lock = threading.Lock()
        self._known_game_ids: Set[str] = self._build_game_id_index()
        # Opponent DNA profiler. Holds a reference to `self.db` so in-place
        # mutations (adding games, deleting games) are visible. The cache is
        # invalidated by `save_database()` after every persisted mutation.
        self._profiler: OpponentProfiler = OpponentProfiler(self.db)

    def get_profiler(self) -> OpponentProfiler:
        """Accessor used by the UI's Opponents tab."""
        return self._profiler

    def _build_game_id_index(self) -> Set[str]:
        return {g.get('id') for bd in self.db.values() for g in bd.get('games', []) if g.get('id')}

    def load_database(self) -> Dict:
        """Load the persisted DB, recovering as much as possible if it's truncated.

        Strict `json.load` followed by a tolerant fallback parser when the file
        is partially written (e.g. crashed mid-save). The fallback walks the
        top-level "build_name": {...} entries individually and skips any whose
        value JSON didn't parse, so a single bad build doesn't lose the rest.
        Sets `self.load_error` and `self.load_warning` so the UI can surface
        the failure mode instead of silently returning {}.
        """
        self.load_error: Optional[str] = None
        self.load_warning: Optional[str] = None
        data: Dict = {}
        self._db_revision += 1

        if os.path.exists(DB_FILE):
            try:
                with open(DB_FILE, 'r', encoding='utf-8') as f:
                    raw = f.read()
                try:
                    data = json.loads(raw)
                except json.JSONDecodeError as e:
                    # Try the tolerant recovery path. Most truncations end
                    # mid-game inside the LAST top-level build entry, so we
                    # can usually save the previous N-1 builds intact.
                    recovered, recovered_count = self._recover_partial_json(raw)
                    if recovered:
                        data = recovered
                        self.load_warning = (
                            f"meta_database.json was truncated/corrupt "
                            f"(JSON error at byte {e.pos}). Recovered "
                            f"{recovered_count} build entries; the last "
                            f"build entry may be missing its newest games. "
                            f"A backup of the corrupt file was written next "
                            f"to it as meta_database.corrupt.json."
                        )
                        # Save a copy of the corrupt file for forensics.
                        try:
                            corrupt_path = DB_FILE + ".corrupt"
                            with open(corrupt_path, 'w', encoding='utf-8') as cf:
                                cf.write(raw)
                        except Exception:
                            pass
                    else:
                        self.load_error = (
                            f"Could not parse meta_database.json (corrupt at "
                            f"byte {e.pos}: {e.msg}). The DB will start empty "
                            f"to avoid overwriting it; rename or restore the "
                            f"file from a backup before re-running analysis."
                        )
            except Exception as e:
                self.load_error = f"Failed to read meta_database.json: {e}"

        # Strip metadata keys (e.g. _schema_version) from the build map and
        # apply any schema migrations before handing the dict to the rest of
        # the app.
        data, version = ensure_schema_version(data if isinstance(data, dict) else {})
        data, version = migrate(data, version)
        self._schema_version = version

        for build in KNOWN_BUILDS:
            if build not in data:
                data[build] = {"games": [], "wins": 0, "losses": 0}
        return data

    @staticmethod
    def _recover_partial_json(raw: str) -> "tuple[Dict, int]":
        """Best-effort recovery of a truncated meta_database.json.

        Walks each top-level "build_name": {...} entry and parses them
        individually with a depth-aware bracket scanner. Entries that don't
        close are dropped; everything before is preserved. Returns
        ``(data, recovered_count)`` — both will be empty/0 on total failure.
        """
        recovered: Dict = {}
        # Find every top-level key. A top-level key is a "..." at indent 4
        # followed by ': {'. The DB format uses 4-space indent.
        i, n = 0, len(raw)
        # Skip past the opening '{' of the root object.
        while i < n and raw[i] != '{':
            i += 1
        if i >= n:
            return ({}, 0)
        i += 1  # past the '{'

        while i < n:
            # Skip whitespace and commas between entries.
            while i < n and raw[i] in ' \t\r\n,':
                i += 1
            if i >= n or raw[i] == '}':
                break
            # Expect a quoted key here.
            if raw[i] != '"':
                # Unexpected token - bail.
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
            # Skip whitespace and the ':'
            while i < n and raw[i] in ' \t\r\n':
                i += 1
            if i >= n or raw[i] != ':':
                break
            i += 1
            while i < n and raw[i] in ' \t\r\n':
                i += 1
            if i >= n or raw[i] != '{':
                break
            # Scan for the matching '}', respecting strings + escapes.
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
                            value_text = raw[value_start:i]
                            try:
                                recovered[key] = json.loads(value_text)
                            except Exception:
                                # Entry didn't decode cleanly; skip it but
                                # keep walking so later entries still have a
                                # chance.
                                pass
                            break
                i += 1
            else:
                # Reached end of file without closing - this is the truncated
                # entry. Skip it.
                break

        return (recovered, len(recovered))

    def save_database(self):
        """Atomic save with read-back verification.

        Write -> fsync -> os.replace. The verification step parses the file
        we just wrote to make sure we never replace a good DB with a bad one.
        """
        with self._lock:
            self._db_revision += 1
            try:
                tmp = DB_FILE + ".tmp"
                # Re-stamp the schema version on every save so future loads
                # know what migration baseline to assume.
                payload = dict(self.db)
                stamp_schema_version(payload, self._schema_version)
                with open(tmp, 'w', encoding='utf-8') as f:
                    json.dump(payload, f, indent=4)
                    f.flush()
                    try:
                        os.fsync(f.fileno())
                    except (OSError, AttributeError):
                        # fsync isn't available everywhere; best-effort only.
                        pass
                # Verify the temp file parses before replacing the real DB.
                # If verification fails we leave the original DB untouched.
                try:
                    with open(tmp, 'r', encoding='utf-8') as vf:
                        json.load(vf)
                except Exception as ve:
                    print(f"Save aborted - tmp file failed verification: {ve}")
                    try:
                        os.remove(tmp)
                    except Exception:
                        pass
                    return
                os.replace(tmp, DB_FILE)
            except Exception as e:
                print(f"Save failed: {e}")
        # Cache invalidation lives outside the lock so a long-running profiler
        # rebuild can't deadlock against the writer.
        try:
            self._profiler.invalidate()
        except Exception:
            pass

    def scan_for_players(self, file_paths: List[str], scan_limit: int = 50) -> List[str]:
        """Scan replay headers and surface candidate human-player names.

        Filters out empty names, observers/refs, and AI players so the
        dropdown isn't cluttered with "A.I. 1 (Hard)" or "" entries. Errors
        from sc2reader are routed to the error_logger so a failing scan is
        visible in the UI's "Show Error Log" view rather than silently
        swallowed (the previous behavior left users with an empty dropdown
        and no idea why).

        `scan_limit` caps how many files we read at load_level=2; the default
        is bumped from the legacy 20 to 50 because users on slow disks were
        ending up with no names when the first 20 happened to be corrupt or
        from an old game version.
        """
        for path in file_paths[:scan_limit]:
            try:
                replay = sc2reader.load_replay(path, load_level=2)
            except Exception as exc:
                # Log the failure so the user can see *why* the scan
                # is empty. Don't let one bad file stop the rest.
                try:
                    self.error_logger.log(path, f"Name-scan error: {exc}")
                except Exception:
                    pass
                continue
            for p in getattr(replay, "players", []):
                # Filter out anything that isn't a real human handle.
                if getattr(p, "is_observer", False) or getattr(p, "is_referee", False):
                    continue
                if not getattr(p, "is_human", True):
                    continue
                name = (getattr(p, "name", "") or "").strip()
                if not name:
                    continue
                self.potential_player_names.add(name)
        return sorted(self.potential_player_names)

    def recalc_stats(self, build_name: str):
        if build_name not in self.db:
            return
        self.db[build_name]['wins'] = sum(1 for g in self.db[build_name]['games'] if g['result'] == "Win")
        self.db[build_name]['losses'] = sum(1 for g in self.db[build_name]['games'] if g['result'] == "Loss")

    def move_game(self, game_id: str, old_build: str, new_build: str):
        with self._lock:
            game_data = next((g for g in self.db.get(old_build, {}).get('games', []) if g['id'] == game_id), None)
            if game_data:
                self.db[old_build]['games'].remove(game_data)
                if new_build not in self.db:
                    self.db[new_build] = {"games": [], "wins": 0, "losses": 0}
                self.db[new_build]['games'].append(game_data)
                self.recalc_stats(old_build)
                self.recalc_stats(new_build)
        self.save_database()

    def rename_user_build(self, old_name: str, new_name: str):
        with self._lock:
            if old_name not in self.db or new_name == old_name:
                return
            if new_name in self.db:
                self.db[new_name]['games'].extend(self.db[old_name]['games'])
                self.recalc_stats(new_name)
                del self.db[old_name]
            else:
                self.db[new_name] = self.db.pop(old_name)
        self.save_database()

    def update_game_opponent_strategy(self, game_id: str, new_strat: str):
        with self._lock:
            for build_name, bd in self.db.items():
                for game in bd['games']:
                    if game['id'] == game_id:
                        game['opp_strategy'] = new_strat
                        self.save_database()
                        return

    def delete_game(self, game_id: str, build_name: str):
        with self._lock:
            if build_name in self.db:
                self.db[build_name]['games'] = [g for g in self.db[build_name]['games'] if g['id'] != game_id]
                self._known_game_ids.discard(game_id)
                self.recalc_stats(build_name)
        self.save_database()

    def get_all_build_names(self) -> List[str]:
        with self._lock:
            return sorted(list(self.db.keys()))

    def export_csv(self, path: str):
        with self._lock:
            rows = [
                {
                    'my_build': b,
                    'opponent': g.get('opponent', ''),
                    'opp_race': g.get('opp_race', ''),
                    'opp_strategy': g.get('opp_strategy', ''),
                    'map': g.get('map', ''),
                    'result': g.get('result', ''),
                    'date': g.get('date', ''),
                    'game_length_sec': g.get('game_length', ''),
                }
                for b, bd in self.db.items()
                for g in bd['games']
            ]
        if rows:
            with open(path, 'w', newline='', encoding='utf-8') as f:
                writer = csv.DictWriter(f, fieldnames=rows[0].keys())
                writer.writeheader()
                writer.writerows(rows)

    def get_map_stats(self) -> Dict[str, Dict]:
        with self._lock:
            cache_key = 'map_stats'
            if cache_key in self._stats_cache and self._stats_cache[cache_key]['rev'] == self._db_revision:
                return self._stats_cache[cache_key]['data']

            mstats: Dict[str, Dict] = {}
            for bd in self.db.values():
                for g in bd['games']:
                    m = g.get('map', 'Unknown')
                    if m not in mstats:
                        mstats[m] = {'wins': 0, 'losses': 0, 'other': 0}
                    if g['result'] == 'Win':
                        mstats[m]['wins'] += 1
                    elif g['result'] == 'Loss':
                        mstats[m]['losses'] += 1
                    else:
                        mstats[m]['other'] += 1

            self._stats_cache[cache_key] = {'rev': self._db_revision, 'data': mstats}
            return mstats

    def get_opponent_stats(self) -> Dict[str, Dict]:
        with self._lock:
            cache_key = 'opponent_stats'
            if cache_key in self._stats_cache and self._stats_cache[cache_key]['rev'] == self._db_revision:
                return self._stats_cache[cache_key]['data']

            ostats: Dict[str, Dict] = {}
            for bd in self.db.values():
                for g in bd['games']:
                    strat = g.get('opp_strategy', 'Unknown')
                    if strat not in ostats:
                        ostats[strat] = {'wins': 0, 'losses': 0}
                    if g['result'] == 'Win':
                        ostats[strat]['wins'] += 1
                    elif g['result'] == 'Loss':
                        ostats[strat]['losses'] += 1

            self._stats_cache[cache_key] = {'rev': self._db_revision, 'data': ostats}
            return ostats

    def get_matchup_stats(self) -> Dict[str, Dict]:
        with self._lock:
            cache_key = 'matchup_stats'
            if cache_key in self._stats_cache and self._stats_cache[cache_key]['rev'] == self._db_revision:
                return self._stats_cache[cache_key]['data']

            mustats: Dict[str, Dict] = {}
            for bd in self.db.values():
                for g in bd['games']:
                    mu = f"vs {g.get('opp_race', 'Unknown')}"
                    if mu not in mustats:
                        mustats[mu] = {'wins': 0, 'losses': 0}
                    if g['result'] == 'Win':
                        mustats[mu]['wins'] += 1
                    elif g['result'] == 'Loss':
                        mustats[mu]['losses'] += 1

            self._stats_cache[cache_key] = {'rev': self._db_revision, 'data': mustats}
            return mustats

    def get_build_vs_strategy_stats(self) -> List[Dict]:
        with self._lock:
            cache_key = 'build_vs_strategy_stats'
            if cache_key in self._stats_cache and self._stats_cache[cache_key]['rev'] == self._db_revision:
                return self._stats_cache[cache_key]['data']

            stats: Dict = {}
            for bname, bd in self.db.items():
                for g in bd['games']:
                    key = (bname, g.get('opp_strategy', 'Unknown'))
                    if key not in stats:
                        stats[key] = {'wins': 0, 'losses': 0}
                    if g['result'] == 'Win':
                        stats[key]['wins'] += 1
                    elif g['result'] == 'Loss':
                        stats[key]['losses'] += 1

            result = sorted(
                [
                    {'my_build': k[0], 'opp_strat': k[1], 'wins': v['wins'], 'losses': v['losses'],
                     'total': v['wins'] + v['losses']}
                    for k, v in stats.items()
                ],
                key=lambda x: x['total'],
                reverse=True,
            )
            self._stats_cache[cache_key] = {'rev': self._db_revision, 'data': result}
            return result
