"""sc2reader load wrappers + the multiprocessing worker.

`load_replay_with_fallback` retries at a lower load level when sc2reader trips
on the well-known `killer_pid`/`UnitPositionsEvent` tracker bugs.

`process_replay_task` is the function executed inside `ProcessPoolExecutor`
workers, so it must remain importable as a top-level callable. Keep this
module free of UI imports - workers should not pull in tkinter/customtkinter.
"""

import os
import sys
from typing import Dict, Optional

try:
    import sc2reader
except ImportError:  # pragma: no cover
    # Lazy tkinter import so headless tooling can still see the failure cleanly.
    try:
        import tkinter as _tk
        from tkinter import messagebox as _mb
        _root = _tk.Tk()
        _root.withdraw()
        _mb.showerror(
            "Missing Library",
            "Could not import 'sc2reader'.\nPlease install it using: pip install sc2reader",
        )
    except Exception:
        print("Missing library 'sc2reader'. Install with: pip install sc2reader", file=sys.stderr)
    sys.exit(1)

from .event_extractor import extract_events, extract_macro_events, PlayerStatsEvent
from analytics.macro_score import compute_macro_score
from detectors.definitions import load_custom_builds
from detectors.opponent import OpponentStrategyDetector
from detectors.user import UserBuildDetector


def load_replay_with_fallback(file_path: str):
    """Load a replay at level 4, falling back to level 3 on tracker bugs.

    Re-raises the second-attempt exception so callers can decide how to handle
    a fully broken file.
    """
    try:
        return sc2reader.load_replay(file_path, load_level=4)
    except Exception:
        # Fallback for 'killer_pid' and 'UnitPositionsEvent' tracker bugs
        return sc2reader.load_replay(file_path, load_level=3)


def process_replay_task(file_path: str, player_name: str) -> dict:
    """Worker entry point - parses one replay end-to-end.

    Returns a status dict the parent process unpacks into the database.
    Must remain pickleable: keep module-level callable, no closures.
    """
    try:
        try:
            replay = load_replay_with_fallback(file_path)
        except Exception as e2:
            return {'status': 'error', 'file_path': file_path, 'error': f"Parse error: {e2}"}

        me, opponent = None, None
        for p in replay.players:
            if p.name == player_name:
                me = p
            else:
                opponent = p

        if not me or not opponent:
            return {'status': 'error', 'file_path': file_path, 'error': f"Player '{player_name}' not found."}

        date_str = replay.date.isoformat() if replay.date else 'unknown'
        length_sec = getattr(replay, 'game_length', None).seconds if getattr(replay, 'game_length', None) else 0
        game_id = f"{date_str}|{opponent.name}|{replay.map_name or 'unknown'}|{length_sec}"

        my_events, opp_events, ext_stats = extract_events(replay, me.pid)
        if not my_events:
            return {'status': 'error', 'file_path': file_path, 'error': "No events extracted."}

        custom_data = load_custom_builds()
        opp_detector = OpponentStrategyDetector(custom_data["Opponent"])
        my_detector = UserBuildDetector(custom_data["Self"])

        matchup = f"vs {opponent.play_race}"
        opp_strat = opp_detector.get_strategy_name(opponent.play_race, opp_events, matchup)
        my_build = my_detector.detect_my_build(matchup, my_events, me.play_race)

        build_log = []
        for e in sorted(my_events, key=lambda x: x['time']):
            m, s = int(e['time'] // 60), int(e['time'] % 60)
            build_log.append(f"[{m}:{s:02d}] {e['name']}")

        # Macro Efficiency engine. Run inside a try/except so a parse hiccup
        # in one component doesn't blow away the whole replay record.
        macro_score: Optional[int] = None
        top_3_leaks: list = []
        macro_breakdown: Optional[Dict] = None
        try:
            macro_events = extract_macro_events(replay, me.pid)
            macro_result = compute_macro_score(
                macro_events, me.play_race, length_sec
            )
            macro_score = macro_result.get("macro_score")
            top_3_leaks = macro_result.get("top_3_leaks", []) or []
            # Full breakdown is what powers the click-to-expand "how was
            # this calculated?" UI. Store it alongside the headline number
            # so the popup doesn't have to re-parse the replay.
            macro_breakdown = {
                "score": macro_score,
                "race": me.play_race,
                "game_length_sec": length_sec,
                "raw": macro_result.get("raw", {}) or {},
                "all_leaks": macro_result.get("all_leaks", []) or [],
                "top_3_leaks": top_3_leaks,
            }
        except Exception:
            # Leave macro_score=None so the UI shows a neutral placeholder
            # instead of crashing the worker.
            pass

        game_data = {
            "id": game_id,
            "opponent": opponent.name,
            "opp_race": opponent.play_race,
            "opp_strategy": opp_strat,
            "map": replay.map_name,
            "result": me.result if me.result else "Unknown",
            "date": date_str,
            "game_length": length_sec,
            "build_log": build_log,
            "macro_score": macro_score,
            "top_3_leaks": top_3_leaks,
            "macro_breakdown": macro_breakdown,
            "file_path": os.path.abspath(file_path),
        }

        return {
            'status': 'success',
            'file_path': file_path,
            'game_id': game_id,
            'my_build': my_build,
            'data': game_data,
        }

    except Exception as e:
        return {'status': 'error', 'file_path': file_path, 'error': str(e)}


def debug_analyze_replay(file_path: str, player_name: str) -> str:
    """Produce a human-readable diagnostic report for a single replay."""
    lines = ["=" * 80, f"DEBUG REPORT: {os.path.basename(file_path)}", "=" * 80]
    try:
        replay = load_replay_with_fallback(file_path)
    except Exception as e:
        lines.append(f"\n[FAIL] FAILED TO LOAD REPLAY: {e}")
        return "\n".join(lines)

    lines.append(f"\nReplay Date: {replay.date}")
    lines.append(f"Map: {replay.map_name}")
    lines.append(f"Game Length: {getattr(replay, 'game_length', None)}")
    lines.append(f"Players: {[(p.name, p.play_race, p.pid, p.result) for p in replay.players]}")

    me, opponent = None, None
    for p in replay.players:
        if p.name == player_name:
            me = p
        else:
            opponent = p

    if not me or not opponent:
        lines.append(f"\n[FAIL] Players not resolved.")
        return "\n".join(lines)

    lines.append(f"\n--- PLAYER IDENTIFICATION ---")
    lines.append(f"ME:  {me.name} (pid={me.pid}, race={me.play_race}, result={me.result})")
    lines.append(f"OPP: {opponent.name} (pid={opponent.pid}, race={opponent.play_race}, result={opponent.result})")

    my_events, opp_events, extract_stats = extract_events(replay, me.pid)
    lines.append(f"\nExtraction stats: {extract_stats}")

    custom_data = load_custom_builds()
    opp_detector = OpponentStrategyDetector(custom_data["Opponent"])
    my_detector = UserBuildDetector(custom_data["Self"])

    matchup = f"vs {opponent.play_race}"
    opp_result = opp_detector.get_strategy_name(opponent.play_race, opp_events, matchup)
    my_result = my_detector.detect_my_build(matchup, my_events, me.play_race)

    lines.append(f"\n  [OK] DETECTED MY BUILD: {my_result}")
    lines.append(f"  [OK] DETECTED OPP STRAT: {opp_result}")
    return "\n".join(lines)


def extract_graph_data(file_path: str, player_name: str) -> Optional[Dict]:
    """Pull per-second economic time series for the visualizer window."""
    if not player_name:
        return None
    try:
        replay = load_replay_with_fallback(file_path)

        me, opp = None, None
        for p in replay.players:
            if p.name == player_name:
                me = p
            elif not p.is_observer and not p.is_referee:
                opp = p

        if not me or not opp:
            return None

        data = {"me_name": me.name, "opp_name": opp.name, "time": [], "p1_series": [], "p2_series": []}
        stats_events = sorted(
            [e for e in replay.tracker_events if isinstance(e, PlayerStatsEvent)],
            key=lambda x: x.second,
        )

        p1_data, p2_data = [], []
        for e in stats_events:
            p_id = getattr(e, 'pid', getattr(getattr(e, 'player', None), 'pid', None))
            if p_id is None:
                continue

            row = {
                'time': e.second / 60.0,
                'supply': getattr(e, 'food_used', 0),
                'cap': getattr(e, 'food_made', 0),
                'min_rate': getattr(e, 'minerals_collection_rate', 0),
                'gas_rate': getattr(e, 'vespene_collection_rate', 0),
                'army_val': getattr(e, 'minerals_used_active_forces',
                                    getattr(e, 'minerals_used_current_army', 0))
                            + getattr(e, 'vespene_used_active_forces',
                                      getattr(e, 'vespene_used_current_army', 0)),
            }
            if p_id == me.pid:
                p1_data.append(row)
            elif p_id == opp.pid:
                p2_data.append(row)

        data['p1_series'], data['p2_series'] = p1_data, p2_data
        return data
    except Exception as e:
        print(f"Graph extraction failed: {e}")
        return None
