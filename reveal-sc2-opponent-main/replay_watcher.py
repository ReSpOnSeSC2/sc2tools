"""Live SC2 replay watcher.

Two responsibilities:

  1. **Live monitoring.** Use ``watchdog`` to react to new ``.SC2Replay``
     files dropped into the SC2 Accounts folder while the script is
     running. Each new replay is parsed, deduplicated, written to the
     local Black Book (``MyOpponentHistory.json``), and POSTed to the
     stream-overlay server.

  2. **Startup catch-up.** Walk the Accounts folder for any replays
     that landed while the watcher was stopped (or crashed) and replay
     the same pipeline over them, in chronological order. The Black
     Book's existing dedup check (``is_duplicate``) guarantees this is
     idempotent: replays already represented in the Black Book are
     skipped silently. Without this catch-up the watcher only ever
     sees files created *after* it started, so any session played
     while the watcher was off (or while the file system event was
     missed) is permanently invisible until you backfill manually.
"""

from __future__ import annotations

import concurrent.futures
import glob
import json
import os
import time
import traceback
from datetime import datetime, timedelta
from typing import List, Optional, Tuple

import requests
from watchdog.observers import Observer
from watchdog.events import FileSystemEventHandler

# Shared atomic-write, safe-read, and startup validation helpers.
from core.atomic_io import atomic_write_json, validate_critical_files

# Existing per-replay logic.
from UpdateHistory import process_replay, HISTORY_FILE, is_duplicate

# All your account folders across NA, EU, etc.
WATCH_DIR = r"C:\Users\jay19\OneDrive\Pictures\Documents\StarCraft II\Accounts"

# The endpoint for your local Node.js stream overlay server.
SERVER_URL = "http://localhost:3000/api/replay"

# Catch-up scan tunables.
#
# CATCH_UP_BUFFER  - how far before the most-recent Black Book entry
#                    to start scanning. Replay file mtimes don't always
#                    line up with game dates (cloud-sync delays,
#                    timezone drift), so we look back a buffer to
#                    avoid missing anything that landed near the cutoff.
# CATCH_UP_FALLBACK - if the Black Book is empty / unreadable, scan
#                    only the last N days. Stops a fresh install from
#                    re-parsing 10k historical replays on first launch.
# CATCH_UP_WORKERS  - how many CPU cores to throw at the parse phase.
#                    sc2reader is single-threaded per replay and
#                    CPU-bound, so a process pool gives a near-linear
#                    speedup. Default to half of the visible cores so
#                    the rest of the machine stays responsive.
CATCH_UP_BUFFER = timedelta(hours=6)
CATCH_UP_FALLBACK = timedelta(days=14)
CATCH_UP_WORKERS = max(1, (os.cpu_count() or 2) // 2)


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------


def wait_for_file_ready(filepath: str, timeout: float = 15.0) -> bool:
    """Wait for SC2 to finish writing the .SC2Replay file to disk."""
    start_time = time.time()
    previous_size = -1
    while True:
        if time.time() - start_time > timeout:
            print(f"Timeout waiting for file to finish writing: {filepath}")
            return False
        try:
            current_size = os.path.getsize(filepath)
            if current_size > 0 and current_size == previous_size:
                return True
            previous_size = current_size
        except OSError:
            pass
        time.sleep(1)


def send_replay_to_server(game_data: dict) -> None:
    """POST a freshly-parsed replay to the local stream-overlay server."""
    payload = {
        "myRace":   game_data["my_race"],
        "oppRace":  game_data["opp_race"],
        "map":      game_data["map"],
        "result":   game_data["result"],
        "oppName":  game_data.get("opp_name"),
        "duration": game_data.get("duration"),
    }
    if game_data.get("my_mmr")  is not None: payload["myMmr"]  = game_data["my_mmr"]
    if game_data.get("opp_mmr") is not None: payload["oppMmr"] = game_data["opp_mmr"]
    try:
        response = requests.post(SERVER_URL, json=payload, timeout=3)
        response.raise_for_status()
        print(f"Server Update Success: Payload delivered to {SERVER_URL}.")
    except requests.exceptions.ConnectionError:
        print(f"Server Update Failed: Connection refused. Is the server running at {SERVER_URL}?")
    except requests.exceptions.Timeout:
        print("Server Update Failed: The request timed out.")
    except requests.exceptions.HTTPError as err:
        print(f"Server Update Failed: HTTP Error occurred: {err}")
    except Exception as err:
        print(f"Server Update Failed: An unexpected error occurred: {err}")


def _load_history() -> dict:
    """Read MyOpponentHistory.json. Tolerant of missing / BOM-prefixed."""
    if not os.path.exists(HISTORY_FILE):
        return {}
    with open(HISTORY_FILE, "r", encoding="utf-8-sig") as f:
        return json.load(f)


def _known_opponent_names(history: dict) -> set:
    """Return the set of normalized opponent names already in the Book."""
    out = set()
    for data in (history or {}).values():
        if isinstance(data, dict) and data.get("Name"):
            n = data["Name"]
            out.add(n.split("]")[-1].strip() if "]" in n else n)
    return out


def update_single_replay(game_data: dict) -> bool:
    """Append a parsed replay to the local Black Book.

    Returns True when the local JSON was updated (a new game was
    appended), False otherwise (duplicate, unknown opponent, missing
    history file). The return value is what lets the catch-up scan
    print accurate "added / skipped" totals.
    """
    if not os.path.exists(HISTORY_FILE):
        print(f"History file {HISTORY_FILE} not found. Cannot update locally.")
        return False

    history = _load_history()
    name_to_pulse_id: dict = {}
    for pulse_id, data in history.items():
        opp_name = data.get("Name")
        if opp_name:
            clean = opp_name.split("]")[-1].strip() if "]" in opp_name else opp_name
            name_to_pulse_id[clean] = pulse_id

    opp_name = game_data["opp_name"]
    if opp_name not in name_to_pulse_id:
        print(f"Opponent {opp_name} not found in Black Book. Skipping local JSON update.")
        return False

    pulse_id = name_to_pulse_id[opp_name]
    matchup_string = f"{game_data['my_race']}v{game_data['opp_race']}"

    if "Matchups" not in history[pulse_id]:
        history[pulse_id]["Matchups"] = {}
    if matchup_string not in history[pulse_id]["Matchups"]:
        history[pulse_id]["Matchups"][matchup_string] = {
            "Wins": 0, "Losses": 0, "Games": [],
        }
    existing_games = history[pulse_id]["Matchups"][matchup_string]["Games"]

    if is_duplicate(game_data, existing_games):
        return False

    if game_data["result"] == "Victory":
        history[pulse_id]["Matchups"][matchup_string]["Wins"] += 1
    else:
        history[pulse_id]["Matchups"][matchup_string]["Losses"] += 1

    history[pulse_id]["Matchups"][matchup_string]["Games"].append({
        "Date": game_data["date"],
        "Result": game_data["result"],
        "Map": game_data["map"],
        "Duration": game_data.get("duration"),
    })

    # Atomic write: tmp + os.replace. Survives mid-write process
    # termination without leaving a half-written file.
    atomic_write_json(HISTORY_FILE, history, indent=4, encoding="utf-8-sig")
    print(f"Local JSON Updated! Added game vs {opp_name} ({game_data['result']}).")
    return True


def _process_one_replay(path: str, *, post_to_server: bool = True) -> str:
    """Parse + dedupe + persist one replay file. Returns a status tag.

    Status tags (used by the catch-up scan for its summary line):

      - ``"added"``      - parsed and appended to the Black Book.
      - ``"duplicate"``  - parsed but already represented in the Book.
      - ``"ignored"``    - 1v1 vs an A.I. opponent.
      - ``"unparseable"`` - sc2reader could not extract a 1v1 game.
      - ``"unknown_opp"`` - opponent isn't in the Black Book yet
        (run the pulse-id scanner to seed them, then retry).
      - ``"error"``      - any other failure path; details on stderr.

    ``post_to_server=False`` is what the catch-up uses so we don't spam
    the live overlay with stale game broadcasts during a backfill.
    """
    try:
        game_data = process_replay(path)
    except Exception as exc:
        print(f"  ERROR parsing {path}: {exc}")
        return "error"

    if not game_data:
        return "unparseable"

    if "A.I." in (game_data.get("opp_name") or ""):
        return "ignored"

    # Snapshot the Black Book opponent set so we can distinguish
    # "added" from "unknown opponent" without parsing the file twice.
    try:
        known = _known_opponent_names(_load_history())
    except Exception:
        known = set()
    if game_data["opp_name"] not in known:
        return "unknown_opp"

    try:
        was_added = update_single_replay(game_data)
    except Exception as exc:
        print(f"  ERROR updating Black Book from {path}: {exc}")
        return "error"

    if post_to_server:
        try:
            send_replay_to_server(game_data)
        except Exception:
            # send_replay_to_server already logs; don't let a server
            # outage block the local write that already succeeded.
            traceback.print_exc()

    return "added" if was_added else "duplicate"


# ---------------------------------------------------------------------------
# Startup catch-up scan
# ---------------------------------------------------------------------------


def _parse_date(s: str) -> Optional[datetime]:
    """Tolerant date parser: 'YYYY-MM-DD HH:MM' first, then ISO."""
    if not s:
        return None
    for fmt in ("%Y-%m-%d %H:%M", "%Y-%m-%dT%H:%M:%S", "%Y-%m-%d"):
        try:
            return datetime.strptime(s.strip(), fmt)
        except ValueError:
            continue
    return None


def _latest_recorded_game_dt() -> Optional[datetime]:
    """Return the most recent game date in the Black Book, or None.

    Walks every game under every opponent's ``Matchups[mu].Games`` list
    AND the legacy top-level ``Games`` list. Returns the max parsed
    date, or ``None`` if the Black Book is missing / unreadable / empty.
    """
    try:
        history = _load_history()
    except Exception as exc:
        print(f"[catch-up] Warning: could not read {HISTORY_FILE}: {exc}")
        return None

    latest: Optional[datetime] = None
    for data in (history or {}).values():
        if not isinstance(data, dict):
            continue
        for g in data.get("Games") or []:
            if isinstance(g, dict) and g.get("Date"):
                d = _parse_date(g["Date"])
                if d and (latest is None or d > latest):
                    latest = d
        for mu_data in (data.get("Matchups") or {}).values():
            if not isinstance(mu_data, dict):
                continue
            for g in mu_data.get("Games") or []:
                if isinstance(g, dict) and g.get("Date"):
                    d = _parse_date(g["Date"])
                    if d and (latest is None or d > latest):
                        latest = d
    return latest


def _enumerate_recent_replays(cutoff_dt: datetime) -> List[str]:
    """Return paths of .SC2Replay files newer than cutoff, oldest first.

    Sorted by mtime ascending so we process them in the same order
    they were played -- keeps the Wins/Losses counters monotonic if
    anyone reads the Black Book mid-backfill.
    """
    cutoff_ts = cutoff_dt.timestamp()
    paths: List[str] = []
    pattern = os.path.join(WATCH_DIR, "**", "*.SC2Replay")
    for p in glob.iglob(pattern, recursive=True):
        try:
            mtime = os.path.getmtime(p)
        except OSError:
            continue
        if mtime >= cutoff_ts:
            paths.append(p)
    paths.sort(key=lambda p: os.path.getmtime(p))
    return paths


def _catch_up_at_startup() -> None:
    """Scan WATCH_DIR for recent replays that the watcher missed."""
    print("[catch-up] Scanning for replays played while the watcher was off...")
    if not os.path.exists(WATCH_DIR):
        print(f"[catch-up] WATCH_DIR not found: {WATCH_DIR}; skipping.")
        return

    latest = _latest_recorded_game_dt()
    if latest is None:
        cutoff = datetime.now() - CATCH_UP_FALLBACK
        print(
            f"[catch-up] Black Book empty or unreadable; "
            f"scanning the last {CATCH_UP_FALLBACK.days} days only."
        )
    else:
        cutoff = latest - CATCH_UP_BUFFER
        print(
            f"[catch-up] Most recent recorded game: "
            f"{latest:%Y-%m-%d %H:%M}; scanning replays newer than "
            f"{cutoff:%Y-%m-%d %H:%M} (with {CATCH_UP_BUFFER} buffer)."
        )

    paths = _enumerate_recent_replays(cutoff)
    if not paths:
        print("[catch-up] No replays in the catch-up window.")
        return

    print(
        f"[catch-up] Found {len(paths)} candidate replay(s); "
        f"parsing on {CATCH_UP_WORKERS} worker(s)..."
    )

    # Parse phase: ProcessPoolExecutor for CPU-bound sc2reader work.
    parsed: List[Tuple[str, Optional[dict]]] = []
    if CATCH_UP_WORKERS > 1 and len(paths) > 1:
        with concurrent.futures.ProcessPoolExecutor(max_workers=CATCH_UP_WORKERS) as ex:
            for path, result in zip(paths, ex.map(process_replay, paths)):
                parsed.append((path, result))
    else:
        for path in paths:
            try:
                parsed.append((path, process_replay(path)))
            except Exception as exc:
                print(f"  ERROR parsing {path}: {exc}")
                parsed.append((path, None))

    # Write phase: sequential. Each call re-reads / re-writes the Black
    # Book; the parsed payload is small so the cost is fine for a
    # one-shot startup scan.
    counters = {
        "added": 0, "duplicate": 0, "ignored": 0,
        "unparseable": 0, "unknown_opp": 0, "error": 0,
    }
    for path, game_data in parsed:
        if game_data is None:
            counters["unparseable"] += 1
            continue
        if "A.I." in (game_data.get("opp_name") or ""):
            counters["ignored"] += 1
            continue
        try:
            known = _known_opponent_names(_load_history())
            if game_data["opp_name"] not in known:
                counters["unknown_opp"] += 1
                continue
            was_added = update_single_replay(game_data)
            counters["added" if was_added else "duplicate"] += 1
        except Exception as exc:
            print(f"  ERROR updating from {path}: {exc}")
            counters["error"] += 1

    print(
        "[catch-up] Done. "
        f"added={counters['added']} "
        f"duplicate={counters['duplicate']} "
        f"unknown_opp={counters['unknown_opp']} "
        f"ignored_AI={counters['ignored']} "
        f"unparseable={counters['unparseable']} "
        f"errors={counters['error']}"
    )
    if counters["unknown_opp"]:
        print(
            f"[catch-up] {counters['unknown_opp']} replay(s) involve opponents "
            f"not yet in the Black Book. Run your SC2-Pulse scanner to seed "
            f"them, then re-launch the watcher to import those games."
        )


# ---------------------------------------------------------------------------
# Live watcher
# ---------------------------------------------------------------------------


class ReplayHandler(FileSystemEventHandler):
    """Listen for new .SC2Replay files dropped into WATCH_DIR."""

    def on_created(self, event):
        if event.is_directory or not event.src_path.endswith(".SC2Replay"):
            return
        path = event.src_path
        print(f"\nNew replay detected: {path}")
        if not wait_for_file_ready(path):
            return
        print("Parsing replay data...")
        status = _process_one_replay(path, post_to_server=True)
        if status == "added":
            return
        if status == "duplicate":
            print("  Already in Black Book (no-op).")
        elif status == "ignored":
            print("  Ignored: match against an A.I.")
        elif status == "unparseable":
            print("  Ignored: not a valid 1v1 match or parsing failed.")
        elif status == "unknown_opp":
            print("  Skipped: opponent not in Black Book yet.")
        elif status == "error":
            print("  Failed: see stderr for details.")


def main() -> int:
    if not os.path.exists(WATCH_DIR):
        print(f"Directory not found: {WATCH_DIR}")
        return 1

    # 0) Startup validation: check every critical JSON file is readable and
    #    auto-recover from .bak where possible.  Problems are logged as
    #    warnings so the watcher still starts even if a file is corrupt.
    from core.paths import HISTORY_FILE as _HF, META_DB_FILE as _MDB, CONFIG_FILE as _CF
    validate_critical_files([_HF, _MDB, _CF])

    # 0a) Stage 5 of STAGE_DATA_INTEGRITY_ROADMAP -- run the boot-time
    # integrity sweep. Surfaces orphans + corrupt live files so the
    # SPA's Diagnostics tab can offer the user a one-click recovery.
    # NEVER auto-publishes; only stages candidates under
    # data/.recovery/. Best-effort: a sweep failure must not block
    # the watcher from coming up.
    try:
        from core import integrity_sweep as _isweep
        from core.paths import DATA_DIR as _DATA_DIR
        _boot_report = _isweep.run_sweep(_DATA_DIR)
        if _boot_report.candidates_staged:
            print(
                f"[integrity] {len(_boot_report.candidates_staged)} "
                f"recovery candidate(s) staged at boot; visit the "
                f"Diagnostics tab in the SPA to apply"
            )
        elif _boot_report.warnings:
            print("[integrity] sweep warnings: " + " | ".join(_boot_report.warnings))
        else:
            print("[integrity] OK")
    except Exception as _sweep_exc:  # noqa: BLE001
        print(f"[integrity] boot sweep error: {_sweep_exc}")

    # 1) Catch up first so a freshly-launched watcher absorbs anything
    #    played while it was off, BEFORE we attach the live observer.
    #    Doing it in this order avoids a tiny window where a brand-new
    #    replay could land mid-scan and get processed twice.
    try:
        _catch_up_at_startup()
    except Exception:
        # A failed catch-up shouldn't stop the live watcher from running.
        # Print the trace so the user can see what happened, then fall through.
        print("[catch-up] Aborted with an error:")
        traceback.print_exc()

    # 2) Live monitoring.
    print(f"\nStarting Replay Watcher on: {WATCH_DIR}")
    print("Waiting for new matches... (Press Ctrl+C to stop)")

    event_handler = ReplayHandler()
    observer = Observer()
    observer.schedule(event_handler, WATCH_DIR, recursive=True)
    observer.start()
    try:
        while True:
            time.sleep(1)
    except KeyboardInterrupt:
        observer.stop()
        print("\nWatcher stopped.")
    observer.join()
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
