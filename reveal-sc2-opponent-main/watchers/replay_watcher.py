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


# =========================================================
# Configuration
# =========================================================
DEFAULT_WATCH_DIR = r"C:\Users\jay19\OneDrive\Pictures\Documents\StarCraft II\Accounts"
DEFAULT_PLAYER = "ReSpOnSe"
SERVER_URL_LIVE = "http://localhost:3000/api/replay"
SERVER_URL_DEEP = "http://localhost:3000/api/replay/deep"

POST_TIMEOUT_SEC = 3
DEEP_POST_TIMEOUT_SEC = 6


def _read_player_handle() -> str:
    """Read the configured player handle from data/config.json."""
    if os.path.exists(CONFIG_FILE):
        try:
            with open(CONFIG_FILE, "r", encoding="utf-8-sig") as f:
                cfg = json.load(f)
                handle = cfg.get("last_player") or cfg.get("player_name")
                if handle:
                    return handle
        except Exception:
            pass
    return DEFAULT_PLAYER


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

        # 1. Live parse (fast)
        try:
            ctx = parse_live(event.src_path, self.player_handle)
        except Exception as e:
            self.errors.log(event.src_path, f"live parse failed: {e}")
            self.errors.append(ERROR_LOG_FILE)
            print(f"[Watcher] Live parse failed: {e}")
            return

        # AI guard - we never broadcast or persist AI matches.
        if ctx.is_ai_game:
            print("[Watcher] AI match - ignored.")
            return
        if not ctx.me or not ctx.opponent:
            print("[Watcher] Player resolution failed; skipping.")
            return

        live_pl = _live_payload(ctx)
        if live_pl:
            _post_json(SERVER_URL_LIVE, live_pl, POST_TIMEOUT_SEC)

        # 2. Deep parse (background thread, default-on)
        if self.enable_deep:
            t = threading.Thread(
                target=self._run_deep_parse,
                args=(event.src_path, ctx.game_id),
                daemon=True,
                name=f"deep-parse-{os.path.basename(event.src_path)}",
            )
            t.start()

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

        # Resolve the opponent's pulse_id by name match in the Black Book.
        opp_clean = opp.name.split("]")[-1].strip() if "]" in opp.name else opp.name
        pulse_id = self.store.black_book.find_by_name(opp_clean) or f"unknown:{opp_clean}"

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
            "build_log": ctx.build_log,
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


# =========================================================
# CLI entry
# =========================================================
def main(watch_dir: Optional[str] = None) -> int:
    target = watch_dir or DEFAULT_WATCH_DIR
    if not os.path.exists(target):
        print(f"[Watcher] Directory not found: {target}")
        return 1

    # Resolve the player handle once so we can both log it and pass it
    # to ReplayHandler. _read_player_handle() prefers data/config.json's
    # last_player/player_name, falling back to DEFAULT_PLAYER.
    handle = _read_player_handle()

    print(f"[Watcher] Player handle: {handle!r} (substring match)")
    print(f"[Watcher] Watching:       {target}")

    handler = ReplayHandler(player_handle=handle, enable_deep=True)
    observer = Observer()
    observer.schedule(handler, target, recursive=True)
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
