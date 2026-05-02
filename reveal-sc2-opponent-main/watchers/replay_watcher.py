"""
Replay watcher - the live bridge between SC2 and the merged toolkit.

This watcher does three things every time a .SC2Replay file lands in
the SC2 Accounts directory:

  1. LIVE PARSE (load_level=2): get players, races, map, result.
     This is what powers the existing stream overlay pop-ups, so we
     keep the same payload shape the Node backend already accepts.

  2. POST to /api/replay: tells the overlay to fire matchResult,
     opponentDetected, rematch, cheeseHistory, streak, mmrDelta...
     plus the new merged events (favoriteOpening, bestAnswer,
     postGameStrategyReveal, metaCheck).

  3. DEEP PARSE in a background thread (load_level=4): tracker events,
     strategy detection (opponent's actual strategy, our own build
     classification), full build log, first-5-minute build log for
     the !build Twitch command, and graph data series for the analyzer.
     The deep parse never blocks the live pop-up - the overlay already
     has its data within ~150 ms; the deep follow-up arrives in a
     second hit a few seconds later via /api/replay/deep.

The deep parse cross-writes both DBs through `core.data_store.DataStore`
so the analyzer's meta DB and the overlay's Black Book stay linked.
"""

from __future__ import annotations

import json
import os
import sys
import threading
import time
from typing import Any, Dict, Optional

import requests
from watchdog.events import FileSystemEventHandler
from watchdog.observers import Observer

# Allow running this module both as a package import and standalone.
_THIS_DIR = os.path.dirname(os.path.abspath(__file__))
_PROJECT_ROOT = os.path.dirname(_THIS_DIR)
if _PROJECT_ROOT not in sys.path:
    sys.path.insert(0, _PROJECT_ROOT)

from core.data_store import DataStore  # noqa: E402
from core.error_logger import ErrorLogger  # noqa: E402
from core.paths import (  # noqa: E402
    CONFIG_FILE,
    ERROR_LOG_FILE,
)
from core.sc2_replay_parser import (  # noqa: E402
    ReplayContext,
    is_me,
    parse_deep,
    parse_live,
)
from core.pulse_resolver import (  # noqa: E402
    resolve_pulse_id_by_toon,
)


# =========================================================
# Configuration
# =========================================================
DEFAULT_WATCH_DIR = r"C:\Users\jay19\OneDrive\Pictures\Documents\StarCraft II\Accounts"
DEFAULT_PLAYER = "ReSpOnSe"
SERVER_URL_LIVE = "http://localhost:3000/api/replay"
SERVER_URL_DEEP = "http://localhost:3000/api/replay/deep"

POST_TIMEOUT_SEC = 3
DEEP_POST_TIMEOUT_SEC = 6

# Catch-up scan tunables. See `_catch_up_at_startup` for context.
#
# CATCH_UP_BUFFER  - how far before the most-recent recorded game to
#                    start scanning. Replay file mtimes don't always
#                    line up with game dates (cloud-sync delays,
#                    timezone drift), so we look back a buffer to
#                    avoid missing anything that landed near the cutoff.
# CATCH_UP_FALLBACK - if both DBs are empty / unreadable, scan only
#                    the last N days. Stops a fresh install from
#                    re-parsing a 10k-replay backlog on first launch.
from datetime import datetime, timedelta  # noqa: E402
import glob  # noqa: E402

CATCH_UP_BUFFER = timedelta(hours=6)
CATCH_UP_FALLBACK = timedelta(days=14)


def _read_player_handle() -> str:
    """Read the configured player handle from data/config.json."""
    if os.path.exists(CONFIG_FILE):
        try:
            with open(CONFIG_FILE, "r", encoding="utf-8-sig") as f:
                cfg = json.load(f)
                handle = cfg.get("last_player") or cfg.get("player_name")
                if handle:
                    return handle
                # The wizard writes identities[].name; fall through to
                # the first one when neither legacy key is present.
                idents = cfg.get("identities")
                if isinstance(idents, list):
                    for ident in idents:
                        if isinstance(ident, dict):
                            name = (ident.get("name") or "").strip()
                            if name:
                                return name
        except Exception:
            pass
    return DEFAULT_PLAYER


def _read_replay_folders() -> List[str]:
    """Return ``paths.replay_folders`` from data/config.json, deduped.

    The wizard writes the user's chosen Multiplayer / Accounts folders
    here; we honour every entry so users with multiple SC2 installs
    (Battle.net + PTR, OneDrive + Documents) get all of them watched.
    Returns ``[]`` when the config is missing or has no entries -- the
    caller falls back to ``DEFAULT_WATCH_DIR`` in that case.
    """
    if not os.path.exists(CONFIG_FILE):
        return []
    try:
        with open(CONFIG_FILE, "r", encoding="utf-8-sig") as f:
            cfg = json.load(f) or {}
    except Exception:
        return []
    paths = cfg.get("paths")
    folders = paths.get("replay_folders") if isinstance(paths, dict) else None
    if not folders:
        # Tolerate the legacy top-level shape some hand-edited configs
        # still use ("replay_folders" at the root).
        folders = cfg.get("replay_folders")
    if not isinstance(folders, list):
        return []
    seen, out = set(), []
    for raw in folders:
        if not isinstance(raw, str):
            continue
        s = raw.strip()
        if not s or s in seen:
            continue
        seen.add(s)
        out.append(s)
    return out


# =========================================================
# Helpers
# =========================================================
def _race_initial(race_string: str) -> str:
    if not race_string:
        return "U"
    return race_string[0].upper()


def _result_str(player_result: str) -> Optional[str]:
    if player_result == "Win":
        return "Victory"
    if player_result == "Loss":
        return "Defeat"
    return None


def _wait_for_file_ready(filepath: str, timeout: int = 15) -> bool:
    """Poll the file size until it stops growing - SC2 writes incrementally."""
    start = time.time()
    last = -1
    while True:
        if time.time() - start > timeout:
            return False
        try:
            current = os.path.getsize(filepath)
            if current > 0 and current == last:
                return True
            last = current
        except OSError:
            pass
        time.sleep(1)


# =========================================================
# Payload builders
# =========================================================
def _live_payload(ctx: ReplayContext) -> Optional[Dict[str, Any]]:
    if not ctx.me or not ctx.opponent:
        return None
    me = ctx.me
    opp = ctx.opponent

    result = _result_str(me.result)
    if not result:
        return None

    opp_clean = opp.name.split("]")[-1].strip() if "]" in opp.name else opp.name

    payload: Dict[str, Any] = {
        "myRace": _race_initial(me.race),
        "oppRace": _race_initial(opp.race),
        "map": ctx.map_name,
        "result": result,
        "oppName": opp_clean,
        "duration": ctx.length_seconds,
        "gameId": ctx.game_id,
    }

    if me.mmr is not None:
        payload["myMmr"] = me.mmr
    if opp.mmr is not None:
        payload["oppMmr"] = opp.mmr
    return payload


def _deep_payload(ctx: ReplayContext) -> Optional[Dict[str, Any]]:
    """
    Payload for /api/replay/deep. Carries strategy detection + build
    logs so the overlay backend can fire favoriteOpening, bestAnswer,
    postGameStrategyReveal, metaCheck, and serve !build.
    """
    if not ctx.me or not ctx.opponent:
        return None
    # Build a clean OPPONENT first-5-min log: dedupe repeated unit
    # productions so the post-game timeline shows real milestones
    # (buildings, upgrades, first-of-each-unit) instead of N zergling
    # lines. Buildings and upgrades are NOT deduped.
    from core.event_extractor import build_log_lines as _build_log_lines
    opp_early_clean = _build_log_lines(
        ctx.opp_events, cutoff_seconds=300, dedupe_units=True
    )

    # Resolve the opponent's authoritative SC2Pulse character ID via
    # toon_handle when possible. Carrying both the raw toon and the
    # resolved pulse_id in the deep payload lets the Node backend
    # emit a reconcile event so the SPA / overlay can correct any
    # mis-attribution that happened during the live phase (barcode
    # collisions, name-only lookups, etc.). Best-effort: returns
    # None if SC2Pulse is offline, no candidate matches the bnid,
    # or the toon couldn't be parsed.
    opp_clean_for_lookup = (
        ctx.opponent.name.split("]")[-1].strip()
        if "]" in ctx.opponent.name
        else ctx.opponent.name
    )
    opp_toon = ctx.opponent.handle
    opp_pulse_id = resolve_pulse_id_by_toon(opp_toon, opp_clean_for_lookup)

    payload: Dict[str, Any] = {
        "gameId": ctx.game_id,
        "oppName": ctx.opponent.name,
        "oppRace": ctx.opponent.race,
        "myRace": ctx.me.race,
        "map": ctx.map_name,
        "result": _result_str(ctx.me.result) or "Unknown",
        "myBuild": ctx.my_build,
        "oppStrategy": ctx.opp_strategy,
        "buildLog": ctx.build_log,
        "earlyBuildLog": ctx.early_build_log,       # YOUR build (used by !build)
        "oppEarlyBuildLog": opp_early_clean,        # OPPONENT'S clean timeline
        "duration": ctx.length_seconds,
        # Post-game opponent identity (Stage: barcode reconciliation).
        # `oppToon` is the raw sc2reader toon_handle; `oppPulseId` is
        # the resolved SC2Pulse character ID or None when offline.
        "oppToon": opp_toon,
        "oppPulseId": opp_pulse_id,
    }
    return payload


# =========================================================
# HTTP delivery
# =========================================================
def _post_json(url: str, payload: Dict[str, Any], timeout: int) -> bool:
    try:
        r = requests.post(url, json=payload, timeout=timeout)
        r.raise_for_status()
        print(f"[Watcher] Delivered to {url}")
        return True
    except requests.exceptions.ConnectionError:
        print(f"[Watcher] POST failed: connection refused ({url})")
    except requests.exceptions.Timeout:
        print(f"[Watcher] POST failed: timeout ({url})")
    except requests.exceptions.HTTPError as e:
        print(f"[Watcher] POST failed: HTTP error {e}")
    except Exception as e:
        print(f"[Watcher] POST failed: {e}")
    return False


# =========================================================
# Watcher
# =========================================================
class ReplayHandler(FileSystemEventHandler):
    """
    Watchdog handler. On a new .SC2Replay file:
      - run a fast live parse + POST
      - dispatch a deep parse on a worker thread
      - cross-write both DBs once the deep parse completes
    """

    def __init__(
        self,
        player_handle: Optional[str] = None,
        enable_deep: bool = True,
    ):
        super().__init__()
        self.player_handle = player_handle or _read_player_handle()
        self.enable_deep = enable_deep
        self.store = DataStore()
        self.errors = ErrorLogger()
        self._deep_lock = threading.Lock()

    # --- watchdog hook ---------------------------------------------------
    def on_created(self, event):
        if event.is_directory or not event.src_path.endswith(".SC2Replay"):
            return
        print(f"\n[Watcher] New replay: {event.src_path}")
        if not _wait_for_file_ready(event.src_path):
            print("[Watcher] File never settled; skipping.")
            return
        # Live broadcast + threaded deep parse: the on-disk handler
        # always wants the live POST so the overlay fires its alerts.
        self._process_replay_path(
            event.src_path, do_live_post=True, do_deep_async=True,
        )

    # --- shared per-replay pipeline --------------------------------------
    def _process_replay_path(
        self,
        src_path: str,
        *,
        do_live_post: bool = True,
        do_deep_async: bool = True,
    ) -> str:
        """Run the parse + persist pipeline for one .SC2Replay path.

        ``do_live_post`` controls whether the fast live payload is
        POSTed to the overlay (the catch-up scan suppresses this so
        old games don't trigger stale 'Victory!' alerts).
        ``do_deep_async`` controls whether the deep parse runs in a
        background thread (live case) or inline on the calling thread
        (catch-up case, where each game must fully persist before we
        move on so the running totals are accurate).

        Returns one of:
          - 'live_only'    - live parse delivered, deep skipped
          - 'deep_queued'  - live parse delivered, deep parse spawned
          - 'deep_done'    - live parse delivered, deep persisted inline
          - 'ai'           - 1v1 vs an A.I., no broadcast or persist
          - 'unresolved'   - player handle resolution failed
          - 'parse_failed' - live parse threw; logged to error file
        """
        try:
            ctx = parse_live(src_path, self.player_handle)
        except Exception as e:
            self.errors.log(src_path, f"live parse failed: {e}")
            self.errors.append(ERROR_LOG_FILE)
            print(f"[Watcher] Live parse failed: {e}")
            return "parse_failed"

        if ctx.is_ai_game:
            print("[Watcher] AI match - ignored.")
            return "ai"
        if not ctx.me or not ctx.opponent:
            print("[Watcher] Player resolution failed; skipping.")
            return "unresolved"

        if do_live_post:
            live_pl = _live_payload(ctx)
            if live_pl:
                _post_json(SERVER_URL_LIVE, live_pl, POST_TIMEOUT_SEC)

        if not self.enable_deep:
            return "live_only"

        if do_deep_async:
            t = threading.Thread(
                target=self._run_deep_parse,
                args=(src_path, ctx.game_id),
                daemon=True,
                name=f"deep-parse-{os.path.basename(src_path)}",
            )
            t.start()
            return "deep_queued"

        # Synchronous path used by the catch-up scan.
        self._run_deep_parse(src_path, ctx.game_id)
        return "deep_done"

    # --- deep-parse worker ----------------------------------------------
    def _run_deep_parse(self, file_path: str, live_game_id: str) -> None:
        # Serialize deep parses one-at-a-time so we don't pin every CPU
        # core in a flurry of back-to-back replays.
        with self._deep_lock:
            try:
                ctx = parse_deep(file_path, self.player_handle)
            except Exception as e:
                self.errors.log(file_path, f"deep parse failed: {e}")
                self.errors.append(ERROR_LOG_FILE)
                print(f"[Watcher] Deep parse failed: {e}")
                return

            if ctx.is_ai_game or not ctx.me or not ctx.opponent:
                return
            if not ctx.my_events:
                print("[Watcher] Deep parse produced no events; skipping persist.")
                return

            # Cross-DB write
            try:
                self._persist_deep(ctx)
            except Exception as e:
                self.errors.log(file_path, f"cross-DB persist failed: {e}")
                self.errors.append(ERROR_LOG_FILE)
                print(f"[Watcher] Cross-DB write failed: {e}")

            # POST deep payload to the overlay backend
            deep_pl = _deep_payload(ctx)
            if deep_pl:
                _post_json(SERVER_URL_DEEP, deep_pl, DEEP_POST_TIMEOUT_SEC)
            print("[Watcher] Deep parse complete.")

    def _persist_deep(self, ctx: ReplayContext) -> None:
        """Resolve pulse_id and write to both DBs through DataStore."""
        if not ctx.me or not ctx.opponent:
            return

        me = ctx.me
        opp = ctx.opponent

        result = _result_str(me.result)
        if not result:
            return

        my_init = _race_initial(me.race)
        opp_init = _race_initial(opp.race)
        matchup_overlay = f"{my_init}v{opp_init}"
        matchup_analyzer = f"vs {opp.race}"

        # Resolve the opponent's pulse_id. Priority order:
        #   1. SC2Pulse lookup by toon_handle (authoritative) --
        #      survives barcode collisions because the bnid is unique.
        #   2. Name match in the existing Black Book (legacy path,
        #      kept as a fallback for offline / Pulse-down cases).
        #   3. Synthetic ``unknown:<Name>`` key when both fail.
        # The merge_unknown_pulse_ids.py offline tool folds (3) into
        # (1) once Pulse becomes reachable again, so the worst-case
        # offline outcome is still self-healing.
        opp_clean = opp.name.split("]")[-1].strip() if "]" in opp.name else opp.name
        toon_pulse_id = resolve_pulse_id_by_toon(opp.handle, opp_clean)
        name_pulse_id = self.store.black_book.find_by_name(opp_clean)
        pulse_id = toon_pulse_id or name_pulse_id or f"unknown:{opp_clean}"
        if (
            toon_pulse_id
            and name_pulse_id
            and toon_pulse_id != name_pulse_id
        ):
            # Name-based lookup would have routed this game to a
            # different person -- classic barcode collision. We log
            # at WARN-equivalent so the diagnostics page can surface
            # it; PII is hashed.
            from core.pulse_resolver import _hash_name
            print(
                "[Watcher] reconcile: name lookup pointed to "
                f"{name_pulse_id} but toon resolves to {toon_pulse_id} "
                f"for {_hash_name(opp_clean)}; using toon."
            )

        # OPPONENT build-log lines, deduped so the timeline shows real
        # milestones (buildings, upgrades, first-of-each-unit) rather
        # than N zergling lines. Persisting this alongside the user's
        # build_log lets the analyzer SPA render the OPPONENT'S build
        # order in the opponent-card view -- not just the user's.
        from core.event_extractor import build_log_lines as _bl
        opp_full_log = _bl(ctx.opp_events, cutoff_seconds=None, dedupe_units=True) \
            if ctx.opp_events else []
        opp_early_log = _bl(ctx.opp_events, cutoff_seconds=300, dedupe_units=True) \
            if ctx.opp_events else []

        # Build the analyzer game record (matches the analyzer's schema).
        analyzer_game: Dict[str, Any] = {
            "id": ctx.game_id,
            "opponent": opp.name,
            "opp_race": opp.race,
            "opp_strategy": ctx.opp_strategy,
            "map": ctx.map_name,
            "result": me.result if me.result else "Unknown",
            "date": ctx.date_iso,
            "game_length": ctx.length_seconds,
            "build_log": ctx.build_log,                 # YOUR build
            "early_build_log": ctx.early_build_log,     # YOUR early build
            "opp_build_log": opp_full_log,              # OPPONENT'S build
            "opp_early_build_log": opp_early_log,       # OPPONENT'S early build
            "file_path": ctx.file_path,
            "opp_pulse_id": pulse_id,
        }

        # Build the Black Book game record (matches existing schema +
        # new opp_strategy/my_build/build_log fields).
        black_book_game: Dict[str, Any] = {
            "Date": ctx.date_iso[:16].replace("T", " "),
            "Result": result,
            "Map": ctx.map_name,
            "Duration": ctx.length_seconds,
            "opp_strategy": ctx.opp_strategy,
            "my_build": ctx.my_build,
            "build_log": ctx.build_log,
        }

        self.store.link_game(
            pulse_id=pulse_id,
            matchup=matchup_overlay,
            opp_name=opp_clean,
            opp_race_initial=opp_init,
            my_build=ctx.my_build or "Unknown",
            opp_strategy=ctx.opp_strategy or "Unknown",
            analyzer_game=analyzer_game,
            black_book_game=black_book_game,
            result=result,
            my_race=me.race,
        )

        # If we resolved a numeric SC2Pulse ID via toon_handle and a
        # legacy ``unknown:<Name>`` twin still exists for the same
        # display name, fold the twin into the numeric record now.
        # This is the missing piece that left duplicate rows in the
        # Opponents table after the live phase saved a game under
        # ``unknown:XVec`` and a later replay resolved ``197079``.
        # No-op when toon resolution failed (offline) -- the
        # standalone merge_unknown_pulse_ids.py tool still cleans
        # those up after the fact.
        if toon_pulse_id and not str(toon_pulse_id).startswith("unknown:"):
            try:
                merged = self.store.merge_unknown_into_numeric(
                    numeric_pulse_id=str(toon_pulse_id),
                    opp_name=opp_clean,
                )
                if merged:
                    pairs = merged.get("plan", {})
                    rewritten = merged.get("meta_rewritten", 0)
                    print(
                        "[Watcher] auto-merged unknown twin(s) into "
                        f"{toon_pulse_id}: pairs={list(pairs.keys())} "
                        f"opp_pulse_id_rewritten={rewritten}"
                    )
            except Exception as exc:  # noqa: BLE001
                # Best-effort: never let a merge failure block the
                # primary persist path. Surface to the error log
                # for the diagnostics page.
                self.errors.log(ctx.file_path, f"auto-merge failed: {exc}")
                self.errors.append(ERROR_LOG_FILE)
                print(f"[Watcher] auto-merge failed: {exc}")


# =========================================================
# Startup catch-up scan
# =========================================================
def _parse_date(s: str):
    """Tolerant date parser: 'YYYY-MM-DD HH:MM' first, then ISO."""
    if not s:
        return None
    for fmt in ("%Y-%m-%d %H:%M", "%Y-%m-%dT%H:%M:%S", "%Y-%m-%d"):
        try:
            return datetime.strptime(s.strip(), fmt)
        except ValueError:
            continue
    return None


def _latest_recorded_dt():
    """Newest game date across BOTH the Black Book and the analyzer
    meta DB. The watcher writes to both stores via DataStore.link_game,
    so the catch-up cutoff has to be the max of the two -- otherwise
    we'd miss games that one store saw but the other didn't (which is
    exactly what the recent corruption-rollback left behind)."""
    from core.paths import HISTORY_FILE as _HF, META_DB_FILE as _MD
    latest = None

    try:
        if os.path.exists(_HF):
            with open(_HF, "r", encoding="utf-8-sig") as f:
                bb = json.load(f)
            for data in (bb or {}).values():
                if not isinstance(data, dict):
                    continue
                for g in data.get("Games") or []:
                    if isinstance(g, dict):
                        d = _parse_date(g.get("Date") or "")
                        if d and (latest is None or d > latest):
                            latest = d
                for mu in (data.get("Matchups") or {}).values():
                    if not isinstance(mu, dict):
                        continue
                    for g in mu.get("Games") or []:
                        if isinstance(g, dict):
                            d = _parse_date(g.get("Date") or "")
                            if d and (latest is None or d > latest):
                                latest = d
    except Exception as exc:
        print(f"[catch-up] Warning: could not read Black Book: {exc}")

    try:
        if os.path.exists(_MD):
            with open(_MD, "r", encoding="utf-8-sig") as f:
                md = json.load(f)
            for build in (md or {}).values():
                if not isinstance(build, dict):
                    continue
                for g in build.get("games") or []:
                    if isinstance(g, dict):
                        d = _parse_date(g.get("date") or "")
                        if d and (latest is None or d > latest):
                            latest = d
    except Exception as exc:
        print(f"[catch-up] Warning: could not read meta DB: {exc}")

    return latest


def _enumerate_recent_replays(watch_dir, cutoff_dt):
    """Paths of .SC2Replay files newer than cutoff, oldest first."""
    cutoff_ts = cutoff_dt.timestamp()
    out = []
    pattern = os.path.join(watch_dir, "**", "*.SC2Replay")
    for p in glob.iglob(pattern, recursive=True):
        try:
            mt = os.path.getmtime(p)
        except OSError:
            continue
        if mt >= cutoff_ts:
            out.append(p)
    out.sort(key=lambda p: os.path.getmtime(p))
    return out


def _catch_up_at_startup(handler, watch_dir):
    """Process any replays that landed while the watcher was off.

    Cutoff is `max(Black-Book newest, meta-DB newest) - CATCH_UP_BUFFER`
    so we re-import a small window around the last known game and let
    DataStore.link_game's idempotency on game id handle anything that
    was already there. Each game's deep parse runs INLINE rather than
    queued -- catch-up is a one-shot blocking operation; we want the
    totals printed at the end to reflect what actually persisted."""
    print("[catch-up] Scanning for replays played while the watcher was off...")
    if not os.path.exists(watch_dir):
        print(f"[catch-up] WATCH_DIR not found: {watch_dir}; skipping.")
        return

    latest = _latest_recorded_dt()
    if latest is None:
        cutoff = datetime.now() - CATCH_UP_FALLBACK
        print(
            f"[catch-up] Both data stores empty/unreadable; scanning the "
            f"last {CATCH_UP_FALLBACK.days} days only."
        )
    else:
        cutoff = latest - CATCH_UP_BUFFER
        print(
            f"[catch-up] Newest recorded game: {latest:%Y-%m-%d %H:%M}; "
            f"scanning replays newer than {cutoff:%Y-%m-%d %H:%M} "
            f"(with {CATCH_UP_BUFFER} buffer)."
        )

    paths = _enumerate_recent_replays(watch_dir, cutoff)
    if not paths:
        print("[catch-up] No replays in the catch-up window.")
        return

    print(f"[catch-up] Found {len(paths)} candidate replay(s); processing...")

    counters = {
        "deep_done": 0, "live_only": 0, "ai": 0,
        "unresolved": 0, "parse_failed": 0,
    }
    for i, path in enumerate(paths, start=1):
        print(f"[catch-up] ({i}/{len(paths)}) {os.path.basename(path)}")
        # Suppress live POST so the overlay doesn't fire stale alerts;
        # run deep parse inline so persistence is sequential.
        status = handler._process_replay_path(  # noqa: SLF001
            path, do_live_post=False, do_deep_async=False,
        )
        counters[status] = counters.get(status, 0) + 1

    print(
        "[catch-up] Done. "
        f"deep_done={counters.get('deep_done', 0)} "
        f"live_only={counters.get('live_only', 0)} "
        f"ignored_AI={counters.get('ai', 0)} "
        f"unresolved={counters.get('unresolved', 0)} "
        f"parse_failed={counters.get('parse_failed', 0)}"
    )


# =========================================================
# CLI entry
# =========================================================
def main(watch_dir: Optional[str] = None) -> int:
    # Resolution priority for which folders to watch:
    #   1. explicit ``watch_dir`` arg (test / CLI override)
    #   2. ``paths.replay_folders`` from data/config.json (wizard output)
    #   3. ``DEFAULT_WATCH_DIR`` (legacy fallback for installs that
    #      pre-date the wizard)
    if watch_dir:
        targets = [watch_dir]
    else:
        targets = _read_replay_folders() or [DEFAULT_WATCH_DIR]

    existing = [t for t in targets if os.path.exists(t)]
    if not existing:
        print(
            "[Watcher] None of the configured replay folders exist:\n  "
            + "\n  ".join(targets)
        )
        print(
            "[Watcher] Run the onboarding wizard to set "
            "paths.replay_folders in data/config.json."
        )
        return 1
    if len(existing) != len(targets):
        missing = [t for t in targets if t not in existing]
        for t in missing:
            print(f"[Watcher] Skipping missing folder: {t}")

    handle = _read_player_handle()

    print(f"[Watcher] Player handle: {handle!r} (substring match)")
    for t in existing:
        print(f"[Watcher] Watching:       {t}")

    handler = ReplayHandler(player_handle=handle, enable_deep=True)

    # Catch up FIRST so a freshly-launched watcher absorbs anything
    # played while it was off, BEFORE we attach the live observer.
    # Doing it in this order avoids a tiny window where a brand-new
    # replay could land mid-scan and get processed twice.
    for t in existing:
        try:
            _catch_up_at_startup(handler, t)
        except Exception as exc:
            # A failed catch-up shouldn't stop the live watcher from
            # running. Log via the error logger and fall through.
            import traceback as _tb
            print(f"[catch-up] Aborted with an error in {t}:")
            _tb.print_exc()
            try:
                handler.errors.log("catch-up", f"startup catch-up failed: {exc}")
                handler.errors.append(ERROR_LOG_FILE)
            except Exception:
                pass

    print("\n[Watcher] Live observer starting...")
    observer = Observer()
    for t in existing:
        observer.schedule(handler, t, recursive=True)
    observer.start()
    try:
        while True:
            time.sleep(1)
    except KeyboardInterrupt:
        print("\n[Watcher] Stopped.")
    finally:
        observer.stop()
        observer.join()
    return 0


if __name__ == "__main__":
    sys.exit(main())
