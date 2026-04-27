"""
SC2 Meta Analyzer GUI (merged toolkit version).

This module is a faithful port of the original SC2ReplayAnalyzer.py
GUI, with one important change: it no longer contains its own copy of
the parsing / strategy detection / storage logic. All of that lives in
the unified `core/` engine and is shared with the live overlay
watcher, so:

    * Strategy names produced by the live overlay match the names the
      analyzer assigns post-game (no schema drift).
    * Black Book entries written during a game are linked to the
      analyzer DB by `opp_pulse_id`, so the analyzer can show "this is
      build X vs strategy Y" using the same identifiers the overlay
      already uses.

Multiprocessing note
--------------------
The legacy analyzer used a ProcessPoolExecutor and called sc2reader
directly inside the worker. The merged engine does the same, but the
worker now imports from `core.sc2_replay_parser` so there is exactly
one parser definition. The worker is a top-level function so it can
be pickled by ProcessPoolExecutor.
"""

from __future__ import annotations

import csv
import concurrent.futures
import glob
import hashlib
import json
import os
import sys
import threading
import traceback
from datetime import datetime, timedelta
from typing import Any, Dict, List, Optional, Set, Tuple

import tkinter as tk
from tkinter import filedialog, messagebox, simpledialog

# --- CUSTOMTKINTER ----------------------------------------------------
try:
    import customtkinter as ctk
except ImportError:
    root = tk.Tk()
    root.withdraw()
    messagebox.showerror(
        "Missing Library",
        "Could not import 'customtkinter'.\n"
        "Install it with:  pip install customtkinter",
    )
    sys.exit(1)

# --- MATPLOTLIB (optional; graphing degrades gracefully if missing) ---
HAS_MATPLOTLIB = False
try:
    import matplotlib
    matplotlib.use("TkAgg")
    from matplotlib.backends.backend_tkagg import FigureCanvasTkAgg
    from matplotlib.figure import Figure
    HAS_MATPLOTLIB = True
except ImportError:
    print("[Analyzer] Matplotlib not available; graphing disabled.")

# --- CORE ENGINE ------------------------------------------------------
# Allow running as `python gui/analyzer_app.py` from anywhere.
_THIS_DIR = os.path.dirname(os.path.abspath(__file__))
_PROJECT_ROOT = os.path.dirname(_THIS_DIR)
if _PROJECT_ROOT not in sys.path:
    sys.path.insert(0, _PROJECT_ROOT)

from core.build_definitions import BUILD_DEFINITIONS, KNOWN_BUILDS  # noqa: E402
from core.custom_builds import load_custom_builds  # noqa: E402
from core.data_store import AnalyzerDBStore  # noqa: E402
from core.error_logger import ErrorLogger  # noqa: E402
from core.event_extractor import build_log_lines, extract_events, extract_macro_events  # noqa: E402
from analytics.macro_score import compute_macro_score, macro_score_color  # noqa: E402
from core.paths import (  # noqa: E402
    CONFIG_FILE,
    ERROR_LOG_FILE,
    META_DB_FILE,
)
from core.sc2_replay_parser import parse_deep  # noqa: E402
from core.strategy_detector import (  # noqa: E402
    OpponentStrategyDetector,
    UserBuildDetector,
)

# sc2reader is needed directly for fast (load_level=2) name scanning
# and for the player-stats graph extraction.
import sc2reader  # noqa: E402

try:
    from sc2reader.events.tracker import PlayerStatsEvent  # noqa: E402
    HAS_PSE = True
except Exception:
    PlayerStatsEvent = None  # type: ignore[assignment]
    HAS_PSE = False


from pathlib import Path  # noqa: E402  -- TIMING_CARDS_PATCH_V1 imports
from analytics.timing_catalog import (  # noqa: E402
    RACE_BUILDINGS,
    TimingToken,
    matchup_label as timing_matchup_label,
    normalize_race,
)

# =====================================================================
# THEME / FONTS
# =====================================================================
ctk.set_appearance_mode("Dark")

FONT_TITLE = ("Arial", 20, "bold")
FONT_HEADING = ("Arial", 14, "bold")
FONT_BODY = ("Arial", 12)
FONT_SMALL = ("Arial", 10)

GRAPH_BG = "#2B2B2B"
GRAPH_FG = "#FFFFFF"
COLOR_P1 = "#42A5F5"
COLOR_P2 = "#EF5350"
COLOR_P1_DIM = "#1E88E5"
COLOR_P2_DIM = "#E53935"
COLOR_WIN = "#66BB6A"
COLOR_LOSS = "#EF5350"
COLOR_NEUTRAL = "#90A4AE"


def wr_color(wins: int, total: int) -> str:
    if total == 0:
        return COLOR_NEUTRAL
    return COLOR_WIN if (wins / total) >= 0.5 else COLOR_LOSS

# --- Timing-card extras (TIMING_CARDS_PATCH_V1) ----------------------
# Bold variant of FONT_BODY for in-card emphasis (token names, labels).
FONT_BOLD = ("Arial", 12, "bold")
# Hero number on each timing card; readable from across the screen so the
# median time pops out at a glance.
FONT_LARGE = ("Arial", 18, "bold")


def _resolve_icons_dir() -> Optional[str]:
    """Return the first existing SC2-Overlay/icons directory, or None.

    Resolution order: this repo's own ``SC2-Overlay/icons`` (the canonical
    home of the asset set), then the sibling ``SC2Replay-Analyzer`` copy
    in case both repos live next to each other on disk.
    """
    here = Path(__file__).resolve()
    repo_root = here.parents[1]            # gui/analyzer_app.py -> repo
    parent = repo_root.parent              # SC2TOOLS/
    candidates = [
        repo_root / "SC2-Overlay" / "icons",
        parent / "SC2Replay-Analyzer" / "SC2-Overlay" / "icons",
    ]
    for path in candidates:
        try:
            if path.is_dir():
                return str(path)
        except OSError:
            continue
    return None


ICONS_DIR: Optional[str] = _resolve_icons_dir()


class Tooltip:
    """Hover tooltip attached to a single widget.

    Show on ``<Enter>``, hide on ``<Leave>`` or any mouse press. The tip
    is a borderless ``Toplevel`` so it can escape the parent's clipping
    rectangle. Used by the matchup-aware timing cards in the Opponents
    tab to surface min/max/last-seen on hover.
    """

    _DELAY_MS = 350

    def __init__(self, widget: tk.Misc, text: str = "") -> None:
        self._widget = widget
        self._text = text or ""
        self._after_id: Optional[str] = None
        self._tip: Optional[tk.Toplevel] = None
        self._label: Optional[tk.Label] = None
        widget.bind("<Enter>", self._on_enter, add="+")
        widget.bind("<Leave>", self._on_leave, add="+")
        widget.bind("<ButtonPress>", self._on_leave, add="+")

    def update_text(self, text: str) -> None:
        self._text = text or ""
        if self._tip is not None and self._label is not None:
            try:
                self._label.configure(text=self._text)
            except tk.TclError:
                self._tip = None
                self._label = None

    def _on_enter(self, _event: object = None) -> None:
        self._cancel_pending()
        if not self._text:
            return
        self._after_id = self._widget.after(self._DELAY_MS, self._show)

    def _on_leave(self, _event: object = None) -> None:
        self._cancel_pending()
        self._hide()

    def _cancel_pending(self) -> None:
        if self._after_id is not None:
            try:
                self._widget.after_cancel(self._after_id)
            except tk.TclError:
                pass
            self._after_id = None

    def _show(self) -> None:
        if self._tip is not None or not self._text:
            return
        try:
            x = self._widget.winfo_rootx() + 14
            y = self._widget.winfo_rooty() + self._widget.winfo_height() + 6
        except tk.TclError:
            return
        try:
            tip = tk.Toplevel(self._widget)
        except tk.TclError:
            return
        tip.wm_overrideredirect(True)
        try:
            tip.attributes("-topmost", True)
        except tk.TclError:
            pass
        tip.geometry(f"+{x}+{y}")
        label = tk.Label(
            tip, text=self._text, justify="left",
            background="#1f1f1f", foreground="#e6e6e6",
            relief="solid", borderwidth=1,
            font=("Arial", 10), padx=8, pady=4,
        )
        label.pack()
        self._tip = tip
        self._label = label

    def _hide(self) -> None:
        if self._tip is not None:
            try:
                self._tip.destroy()
            except tk.TclError:
                pass
        self._tip = None
        self._label = None


# =====================================================================
# MULTIPROCESSING WORKER
# =====================================================================
def process_replay_task(file_path: str, player_name: str) -> Dict[str, Any]:
    """
    Worker run inside ProcessPoolExecutor. Returns a status dict that
    the main GUI thread folds into the analyzer DB.

    Uses `core.sc2_replay_parser.parse_deep` so the same parsing /
    strategy logic that produces live overlay events also produces the
    analyzer DB rows.
    """
    try:
        ctx = parse_deep(file_path, player_name)

        if ctx.is_ai_game:
            return {
                "status": "error",
                "file_path": file_path,
                "error": "AI / computer game skipped.",
            }
        if not ctx.me or not ctx.opponent:
            return {
                "status": "error",
                "file_path": file_path,
                "error": f"Player '{player_name}' not found in replay.",
            }
        if not ctx.my_events:
            return {
                "status": "error",
                "file_path": file_path,
                "error": "No events extracted.",
            }

        my_build = ctx.my_build or f"Standard / Unknown (vs {ctx.opponent.race})"
        opp_strat = ctx.opp_strategy or f"{ctx.opponent.race} - Standard Play (Unclassified)"

        # Macro Efficiency engine. The deep parse already loaded the replay,
        # so we can re-walk its tracker stream for the macro events. Wrapped
        # in try/except so a parse hiccup never blows away the whole record.
        macro_score: Optional[int] = None
        top_3_leaks: List[Dict[str, Any]] = []
        try:
            if ctx.raw is not None:
                macro_events = extract_macro_events(ctx.raw, ctx.me.pid)
                macro_result = compute_macro_score(
                    macro_events, ctx.me.race, ctx.length_seconds
                )
                macro_score = macro_result.get("macro_score")
                top_3_leaks = macro_result.get("top_3_leaks", []) or []
        except Exception:
            pass

        game_data = {
            "id": ctx.game_id,
            "opponent": ctx.opponent.name,
            "opp_race": ctx.opponent.race,
            "opp_strategy": opp_strat,
            "map": ctx.map_name,
            "result": ctx.me.result if ctx.me.result else "Unknown",
            "date": ctx.date_iso,
            "game_length": ctx.length_seconds,
            "build_log": ctx.build_log or build_log_lines(ctx.my_events, cutoff_seconds=None),
            "early_build_log": ctx.early_build_log or build_log_lines(ctx.my_events, cutoff_seconds=300),
            "macro_score": macro_score,
            "top_3_leaks": top_3_leaks,
            "file_path": os.path.abspath(file_path),
        }

        return {
            "status": "success",
            "file_path": file_path,
            "game_id": ctx.game_id,
            "my_build": my_build,
            "data": game_data,
        }

    except Exception as exc:
        return {"status": "error", "file_path": file_path, "error": str(exc)}


# =====================================================================
# DEBUG / DIAGNOSTIC TOOL
# =====================================================================
def debug_analyze_replay(file_path: str, player_name: str) -> str:
    """Produce a human-readable diagnostic report for one replay."""
    lines = ["=" * 80, f"DEBUG REPORT: {os.path.basename(file_path)}", "=" * 80]
    try:
        ctx = parse_deep(file_path, player_name)
    except Exception as exc:
        lines.append(f"\nFAILED TO LOAD REPLAY: {exc}")
        return "\n".join(lines)

    lines.append(f"\nReplay Date: {ctx.date_iso}")
    lines.append(f"Map: {ctx.map_name}")
    lines.append(f"Game Length: {ctx.length_seconds}s")
    lines.append(
        f"Players: {[(p.name, p.race, p.pid, p.result) for p in ctx.all_players]}"
    )

    if not ctx.me or not ctx.opponent:
        lines.append("\nPlayers not resolved -- check that your handle matches the replay.")
        return "\n".join(lines)

    lines.append("\n--- PLAYER IDENTIFICATION ---")
    lines.append(
        f"ME:  {ctx.me.name} (pid={ctx.me.pid}, race={ctx.me.race}, result={ctx.me.result})"
    )
    lines.append(
        f"OPP: {ctx.opponent.name} (pid={ctx.opponent.pid}, race={ctx.opponent.race}, result={ctx.opponent.result})"
    )
    lines.append(f"\nExtraction stats: {ctx.extract_stats}")
    lines.append(f"\n  DETECTED MY BUILD: {ctx.my_build}")
    lines.append(f"  DETECTED OPP STRAT: {ctx.opp_strategy}")
    return "\n".join(lines)


# =====================================================================
# GRAPH DATA EXTRACTION (kept here because it's GUI-only)
# =====================================================================
def extract_graph_data(file_path: str, player_name: str) -> Optional[Dict]:
    """Pull PlayerStatsEvent series for the supply / income / army graphs."""
    if not player_name or not HAS_PSE:
        return None
    try:
        try:
            replay = sc2reader.load_replay(file_path, load_level=4)
        except Exception:
            replay = sc2reader.load_replay(file_path, load_level=3)

        me, opp = None, None
        for p in replay.players:
            if getattr(p, "name", "") == player_name or (
                player_name and player_name in getattr(p, "name", "")
            ):
                me = p
            elif not getattr(p, "is_observer", False) and not getattr(p, "is_referee", False):
                opp = p
        if not me or not opp:
            return None

        data = {"me_name": me.name, "opp_name": opp.name, "p1_series": [], "p2_series": []}
        stats_events = sorted(
            [e for e in replay.tracker_events if isinstance(e, PlayerStatsEvent)],
            key=lambda x: x.second,
        )
        p1_data, p2_data = [], []
        for e in stats_events:
            p_id = getattr(e, "pid", getattr(getattr(e, "player", None), "pid", None))
            if p_id is None:
                continue
            row = {
                "time": e.second / 60.0,
                "supply": getattr(e, "food_used", 0),
                "cap": getattr(e, "food_made", 0),
                "min_rate": getattr(e, "minerals_collection_rate", 0),
                "gas_rate": getattr(e, "vespene_collection_rate", 0),
                "army_val": getattr(
                    e,
                    "minerals_used_active_forces",
                    getattr(e, "minerals_used_current_army", 0),
                )
                + getattr(
                    e,
                    "vespene_used_active_forces",
                    getattr(e, "vespene_used_current_army", 0),
                ),
            }
            if p_id == me.pid:
                p1_data.append(row)
            elif p_id == opp.pid:
                p2_data.append(row)

        data["p1_series"], data["p2_series"] = p1_data, p2_data
        return data
    except Exception as exc:
        print(f"[Analyzer] Graph extraction failed: {exc}")
        return None


# =====================================================================
# ANALYZER BACKEND
# =====================================================================
class ReplayAnalyzer:
    """
    Thin wrapper around the unified `AnalyzerDBStore`. Preserves the
    method surface the legacy GUI used so the UI port is verbatim.
    """

    def __init__(self):
        self.store = AnalyzerDBStore()
        self.db: Dict = self.store.load()
        self.potential_player_names: Set[str] = set()
        self.selected_player_name: Optional[str] = None
        self.error_logger = ErrorLogger()
        self._lock = threading.Lock()
        self._known_game_ids: Set[str] = self._build_game_id_index()
        # Bumped every time the in-memory db is replaced. Aggregation
        # caches and tab renderers key off this so they recompute only
        # when the underlying data actually changed.
        self._db_revision: int = 0
        self._agg_cache: Dict[str, Tuple[int, Any]] = {}
        # Opponent DNA profiler (lazy import so we don't blow up if the
        # analytics package isn't on the path on legacy installs).
        try:
            from analytics.opponent_profiler import OpponentProfiler
            self._profiler = OpponentProfiler(self.db)
        except Exception as exc:
            print(f"[Analyzer] OpponentProfiler unavailable: {exc}")
            self._profiler = None

    def get_profiler(self):
        """Returns the OpponentProfiler bound to the live DB dict."""
        if self._profiler is None:
            try:
                from analytics.opponent_profiler import OpponentProfiler
                self._profiler = OpponentProfiler(self.db)
            except Exception:
                return None
        return self._profiler

    # ----- DB I/O -------------------------------------------------------
    def _build_game_id_index(self) -> Set[str]:
        return {
            g.get("id")
            for bd in self.db.values()
            for g in bd.get("games", [])
            if g.get("id")
        }

    def load_database(self) -> Dict:
        self.db = self.store.load()
        self._known_game_ids = self._build_game_id_index()
        self._db_revision += 1
        self._agg_cache.clear()
        # Re-bind the profiler to the new dict and drop its caches.
        if self._profiler is not None:
            try:
                self._profiler._db = self.db
                self._profiler.invalidate()
            except Exception:
                pass
        return self.db

    def save_database(self) -> None:
        with self._lock:
            self.store.save(self.db)
        # Local mutations also invalidate aggregation caches.
        self._db_revision += 1
        self._agg_cache.clear()

    @staticmethod
    def compute_db_signature(db_path: str) -> Optional[Tuple[float, int, str]]:
        """
        Cheap signature: (mtime, size, blake2-of-head-and-tail). Avoids a
        full read of the 60MB+ meta_database.json just to detect changes.
        Used by the GUI's auto-refresh tick to short-circuit reloads when
        nothing has actually changed on disk.
        """
        try:
            st = os.stat(db_path)
        except OSError:
            return None
        try:
            h = hashlib.blake2s(digest_size=8)
            with open(db_path, "rb") as f:
                h.update(f.read(4096))
                if st.st_size > 8192:
                    f.seek(-4096, 2)
                    h.update(f.read(4096))
            return (st.st_mtime, st.st_size, h.hexdigest())
        except OSError:
            return None

    def _cached(self, key: str, compute):
        """
        Return cached aggregation for `key` if computed for the current
        DB revision; otherwise compute, cache, and return. Thread-safe
        for the simple compute-once-then-read pattern the renderers use.
        """
        cached = self._agg_cache.get(key)
        if cached is not None and cached[0] == self._db_revision:
            return cached[1]
        result = compute()
        self._agg_cache[key] = (self._db_revision, result)
        return result

    # ----- Player handle scan ------------------------------------------
    def scan_for_players(self, file_paths: List[str], scan_limit: int = 50) -> List[str]:
        """Scan replay headers and surface candidate human-player names.

        Filters out empty names, observers/refs, and AI players so the
        dropdown isn't cluttered with "A.I. 1 (Hard)" or "" entries. sc2reader
        load failures are routed to the error_logger so a failing scan is
        visible in the UI's "Show Error Log" view rather than silently
        swallowed.
        """
        for path in file_paths[:scan_limit]:
            try:
                replay = sc2reader.load_replay(path, load_level=2)
            except Exception as exc:
                try:
                    self.error_logger.log(path, f"Name-scan error: {exc}")
                except Exception:
                    pass
                continue
            for p in getattr(replay, "players", []):
                if getattr(p, "is_observer", False) or getattr(p, "is_referee", False):
                    continue
                if not getattr(p, "is_human", True):
                    continue
                name = (getattr(p, "name", "") or "").strip()
                if not name:
                    continue
                self.potential_player_names.add(name)
        return sorted(self.potential_player_names)

    # ----- Mutations ----------------------------------------------------
    def recalc_stats(self, build_name: str) -> None:
        if build_name not in self.db:
            return
        AnalyzerDBStore.recalc_stats(self.db, build_name)

    def move_game(self, game_id: str, old_build: str, new_build: str) -> None:
        with self._lock:
            game_data = next(
                (
                    g
                    for g in self.db.get(old_build, {}).get("games", [])
                    if g.get("id") == game_id
                ),
                None,
            )
            if game_data:
                self.db[old_build]["games"].remove(game_data)
                if new_build not in self.db:
                    self.db[new_build] = {"games": [], "wins": 0, "losses": 0}
                self.db[new_build]["games"].append(game_data)
                AnalyzerDBStore.recalc_stats(self.db, old_build)
                AnalyzerDBStore.recalc_stats(self.db, new_build)
        self.save_database()

    def rename_user_build(self, old_name: str, new_name: str) -> None:
        with self._lock:
            if old_name not in self.db or new_name == old_name:
                return
            if new_name in self.db:
                self.db[new_name]["games"].extend(self.db[old_name]["games"])
                AnalyzerDBStore.recalc_stats(self.db, new_name)
                del self.db[old_name]
            else:
                self.db[new_name] = self.db.pop(old_name)
        self.save_database()

    def update_game_opponent_strategy(self, game_id: str, new_strat: str) -> None:
        with self._lock:
            for bd in self.db.values():
                for game in bd.get("games", []):
                    if game.get("id") == game_id:
                        game["opp_strategy"] = new_strat
                        self.save_database()
                        return

    def delete_game(self, game_id: str, build_name: str) -> None:
        with self._lock:
            if build_name in self.db:
                self.db[build_name]["games"] = [
                    g for g in self.db[build_name]["games"] if g.get("id") != game_id
                ]
                self._known_game_ids.discard(game_id)
                AnalyzerDBStore.recalc_stats(self.db, build_name)
        self.save_database()

    # ----- Read-only queries -------------------------------------------
    def get_all_build_names(self) -> List[str]:
        with self._lock:
            return sorted(list(self.db.keys()))

    def export_csv(self, path: str) -> None:
        with self._lock:
            rows = [
                {
                    "my_build": b,
                    "opponent": g.get("opponent", ""),
                    "opp_race": g.get("opp_race", ""),
                    "opp_strategy": g.get("opp_strategy", ""),
                    "map": g.get("map", ""),
                    "result": g.get("result", ""),
                    "date": g.get("date", ""),
                    "game_length_sec": g.get("game_length", ""),
                }
                for b, bd in self.db.items()
                for g in bd.get("games", [])
            ]
        if not rows:
            return
        with open(path, "w", newline="", encoding="utf-8") as f:
            writer = csv.DictWriter(f, fieldnames=rows[0].keys())
            writer.writeheader()
            writer.writerows(rows)

    def get_map_stats(self) -> Dict[str, Dict]:
        def _compute() -> Dict[str, Dict]:
            mstats: Dict[str, Dict] = {}
            with self._lock:
                for bd in self.db.values():
                    for g in bd.get("games", []):
                        m = g.get("map", "Unknown")
                        bucket = mstats.setdefault(m, {"wins": 0, "losses": 0, "other": 0})
                        if g.get("result") == "Win":
                            bucket["wins"] += 1
                        elif g.get("result") == "Loss":
                            bucket["losses"] += 1
                        else:
                            bucket["other"] += 1
            return mstats
        return self._cached("map_stats", _compute)

    def get_opponent_stats(self) -> Dict[str, Dict]:
        def _compute() -> Dict[str, Dict]:
            ostats: Dict[str, Dict] = {}
            with self._lock:
                for bd in self.db.values():
                    for g in bd.get("games", []):
                        strat = g.get("opp_strategy", "Unknown")
                        bucket = ostats.setdefault(strat, {"wins": 0, "losses": 0})
                        if g.get("result") == "Win":
                            bucket["wins"] += 1
                        elif g.get("result") == "Loss":
                            bucket["losses"] += 1
            return ostats
        return self._cached("opponent_stats", _compute)

    def get_matchup_stats(self) -> Dict[str, Dict]:
        def _compute() -> Dict[str, Dict]:
            mustats: Dict[str, Dict] = {}
            with self._lock:
                for bd in self.db.values():
                    for g in bd.get("games", []):
                        mu = f"vs {g.get('opp_race', 'Unknown')}"
                        bucket = mustats.setdefault(mu, {"wins": 0, "losses": 0})
                        if g.get("result") == "Win":
                            bucket["wins"] += 1
                        elif g.get("result") == "Loss":
                            bucket["losses"] += 1
            return mustats
        return self._cached("matchup_stats", _compute)

    def get_build_vs_strategy_stats(self) -> List[Dict]:
        def _compute() -> List[Dict]:
            stats: Dict = {}
            with self._lock:
                for bname, bd in self.db.items():
                    for g in bd.get("games", []):
                        key = (bname, g.get("opp_strategy", "Unknown"))
                        bucket = stats.setdefault(key, {"wins": 0, "losses": 0})
                        if g.get("result") == "Win":
                            bucket["wins"] += 1
                        elif g.get("result") == "Loss":
                            bucket["losses"] += 1
            return sorted(
                [
                    {
                        "my_build": k[0],
                        "opp_strat": k[1],
                        "wins": v["wins"],
                        "losses": v["losses"],
                        "total": v["wins"] + v["losses"],
                    }
                    for k, v in stats.items()
                ],
                key=lambda x: x["total"],
                reverse=True,
            )
        return self._cached("build_vs_strategy_stats", _compute)


# =====================================================================
# GAME VISUALIZER WINDOW
# =====================================================================
class GameVisualizerWindow(ctk.CTkToplevel):
    """Three-panel matplotlib viewer for a single game (supply / income / army)."""

    def __init__(self, parent, game_data: Dict, player_name: str):
        super().__init__(parent)
        self.game_data = game_data
        self.player_name = player_name
        self.title(
            f"Visualizer: {game_data.get('map', 'Unknown')} vs {game_data.get('opponent', '?')}"
        )
        self.geometry("1100x800")
        self.transient(parent)
        self.lift()
        self.after(200, lambda: self.focus_force())

        self.grid_columnconfigure(0, weight=1)
        self.grid_rowconfigure(1, weight=1)

        header = ctk.CTkFrame(self)
        header.grid(row=0, column=0, sticky="ew", padx=10, pady=10)
        title_text = (
            f"Analyzed: {str(game_data.get('date', ''))[:10]} | "
            f"Result: {game_data.get('result')}"
        )
        ctk.CTkLabel(header, text=title_text, font=("Arial", 16, "bold")).pack(pady=5)
        self.status_lbl = ctk.CTkLabel(
            header, text="Parsing replay for stats...", text_color="orange"
        )
        self.status_lbl.pack(pady=5)

        self.content_frame = ctk.CTkScrollableFrame(self)
        self.content_frame.grid(row=1, column=0, sticky="nsew", padx=10, pady=10)
        ctk.CTkButton(
            self, text="Close", command=self.destroy, fg_color="#D32F2F"
        ).grid(row=2, column=0, pady=10)

        # Macro Report renders synchronously off the cached game_data fields.
        self._render_macro_report()

        file_path = game_data.get("file_path")
        if not file_path or not os.path.exists(file_path):
            self.status_lbl.configure(
                text=f"Error: Replay file not found at {file_path}",
                text_color=COLOR_LOSS,
            )
            return
        threading.Thread(target=self._load_data, args=(file_path,), daemon=True).start()

    def _render_macro_report(self):
        """Render the Macro Report card at the top of the content frame."""
        score = self.game_data.get("macro_score")
        leaks = self.game_data.get("top_3_leaks") or []

        card = ctk.CTkFrame(self.content_frame, fg_color=("gray85", "gray18"))
        card.pack(fill="x", padx=10, pady=(0, 10))

        header = ctk.CTkFrame(card, fg_color="transparent")
        header.pack(fill="x", padx=14, pady=(10, 4))
        ctk.CTkLabel(
            header, text="Macro Report",
            font=("Arial", 16, "bold"), anchor="w",
        ).pack(side="left")

        body = ctk.CTkFrame(card, fg_color="transparent")
        body.pack(fill="x", padx=14, pady=(0, 10))

        if score is None:
            score_text = "--"
            score_color_val = "#90A4AE"
            tagline = "Macro score not computed (re-run analysis to refresh)."
        else:
            score_text = str(score)
            score_color_val = macro_score_color(score)
            tagline = self._tagline_for_score(score)

        score_frame = ctk.CTkFrame(body, fg_color="transparent")
        score_frame.pack(side="left", padx=(0, 18))
        ctk.CTkLabel(
            score_frame, text=score_text,
            font=("Arial", 56, "bold"), text_color=score_color_val,
        ).pack(anchor="w")
        ctk.CTkLabel(
            score_frame, text="/ 100",
            font=("Arial", 12), text_color="gray",
        ).pack(anchor="w")

        leaks_frame = ctk.CTkFrame(body, fg_color="transparent")
        leaks_frame.pack(side="left", fill="x", expand=True)
        ctk.CTkLabel(
            leaks_frame, text=tagline,
            font=("Arial", 12, "italic"), text_color="gray", anchor="w",
        ).pack(anchor="w", pady=(0, 4))
        if not leaks:
            ctk.CTkLabel(
                leaks_frame,
                text="No leaks detected — clean macro.",
                text_color="#66BB6A", font=("Arial", 12), anchor="w",
            ).pack(anchor="w")
            return

        ctk.CTkLabel(
            leaks_frame, text="Top 3 leaks (ranked by est. minerals lost)",
            font=("Arial", 12, "bold"), anchor="w",
        ).pack(anchor="w", pady=(2, 4))
        for leak in leaks[:3]:
            row = ctk.CTkFrame(leaks_frame, fg_color="transparent")
            row.pack(fill="x", pady=1)
            qty = leak.get("quantity", 0) or 0
            name = leak.get("name", "?")
            unit = "s" if (
                "Blocked" in name or "Idle" in name or "Oversaturation" in name
            ) else ""
            qty_text = f"{qty:.0f}{unit}" if unit else f"{int(qty)}"
            ctk.CTkLabel(
                row, text=f"  •  {name}",
                font=("Arial", 12, "bold"), anchor="w", width=220,
            ).pack(side="left")
            ctk.CTkLabel(
                row, text=f"{qty_text}",
                font=("Arial", 12), text_color="gray", width=70, anchor="w",
            ).pack(side="left")
            ctk.CTkLabel(
                row, text=f"~{int(leak.get('mineral_cost', 0))} min",
                font=("Arial", 12), text_color="#FBC02D", anchor="w",
            ).pack(side="left")

    @staticmethod
    def _tagline_for_score(score: int) -> str:
        if score >= 85:
            return "Pro-grade macro. Few leaks worth chasing."
        if score >= 70:
            return "Solid macro with room to tighten the fundamentals."
        if score >= 50:
            return "Fixable leaks — macro is the next thing to grind."
        return "Macro is the limiting factor here. Start with the top leak."

    def _load_data(self, file_path):
        data = extract_graph_data(file_path, self.player_name)
        self.after(0, lambda: self._render_graphs(data))

    def _render_graphs(self, data):
        if not HAS_MATPLOTLIB:
            messagebox.showerror(
                "Graphing Error",
                "Matplotlib is not installed.\nInstall it with:  pip install matplotlib",
            )
            return
        if not data:
            self.status_lbl.configure(
                text="Could not extract graph data from this replay.",
                text_color=COLOR_LOSS,
            )
            return

        self.status_lbl.configure(text="Data loaded.", text_color=COLOR_WIN)
        p1_name, p2_name = data["me_name"], data["opp_name"]

        def create_figure(title, y_label):
            fig = Figure(figsize=(9, 4), dpi=100)
            fig.patch.set_facecolor(GRAPH_BG)
            ax = fig.add_subplot(111)
            ax.set_facecolor(GRAPH_BG)
            ax.set_title(title, color=GRAPH_FG)
            ax.set_xlabel("Time (Minutes)", color=GRAPH_FG)
            ax.set_ylabel(y_label, color=GRAPH_FG)
            ax.tick_params(axis="x", colors=GRAPH_FG)
            ax.tick_params(axis="y", colors=GRAPH_FG)
            ax.grid(True, color="#444444", linestyle="--", alpha=0.5)
            for spine in ax.spines.values():
                spine.set_edgecolor(GRAPH_FG)
            return fig, ax

        x1 = [x["time"] for x in data["p1_series"]]
        x2 = [x["time"] for x in data["p2_series"]]

        # ---- Supply -----------------------------------------------------
        fig1, ax1 = create_figure(f"Supply Flow: {p1_name} vs {p2_name}", "Supply")
        ax1.plot(x1, [x["cap"] for x in data["p1_series"]], color=COLOR_P1,
                 linestyle=":", alpha=0.5, label=f"{p1_name} Cap")
        ax1.plot(x1, [x["supply"] for x in data["p1_series"]], color=COLOR_P1,
                 linewidth=2, label=f"{p1_name} Used")
        ax1.plot(x2, [x["cap"] for x in data["p2_series"]], color=COLOR_P2,
                 linestyle=":", alpha=0.5, label=f"{p2_name} Cap")
        ax1.plot(x2, [x["supply"] for x in data["p2_series"]], color=COLOR_P2,
                 linewidth=2, label=f"{p2_name} Used")
        ax1.legend(facecolor=GRAPH_BG, labelcolor=GRAPH_FG)

        # ---- Income -----------------------------------------------------
        fig2, ax2 = create_figure("Resource Collection Rate (Income)", "Resources / Min")
        ax2.plot(x1, [x["min_rate"] for x in data["p1_series"]], color=COLOR_P1,
                 label=f"{p1_name} Minerals")
        ax2.plot(x1, [x["gas_rate"] for x in data["p1_series"]], color=COLOR_P1_DIM,
                 linestyle="--", label=f"{p1_name} Gas")
        ax2.plot(x2, [x["min_rate"] for x in data["p2_series"]], color=COLOR_P2,
                 label=f"{p2_name} Minerals")
        ax2.plot(x2, [x["gas_rate"] for x in data["p2_series"]], color=COLOR_P2_DIM,
                 linestyle="--", label=f"{p2_name} Gas")
        ax2.legend(facecolor=GRAPH_BG, labelcolor=GRAPH_FG)

        # ---- Army Value -------------------------------------------------
        fig3, ax3 = create_figure("Army Value (Minerals + Gas)", "Value")
        y1_army = [x["army_val"] for x in data["p1_series"]]
        y2_army = [x["army_val"] for x in data["p2_series"]]
        ax3.fill_between(x1, y1_army, color=COLOR_P1, alpha=0.3)
        ax3.plot(x1, y1_army, color=COLOR_P1, label=p1_name)
        ax3.fill_between(x2, y2_army, color=COLOR_P2, alpha=0.3)
        ax3.plot(x2, y2_army, color=COLOR_P2, label=p2_name)
        ax3.legend(facecolor=GRAPH_BG, labelcolor=GRAPH_FG)

        for fig in (fig1, fig2, fig3):
            canvas = FigureCanvasTkAgg(fig, master=self.content_frame)
            canvas.draw()
            canvas.get_tk_widget().pack(fill="x", pady=10, padx=10)


# =====================================================================
# MAIN APP
# =====================================================================
class App(ctk.CTk):
    """Main analyzer window. Sidebar + 6 tabs + deep-dive popup."""

    def __init__(self):
        super().__init__()
        self.analyzer = ReplayAnalyzer()
        self.title("SC2 Meta Analyzer (Merged Toolkit)")
        self.geometry("1400x900")
        self.minsize(1000, 600)

        self.queued_files: List[str] = []
        self._queue_lock = threading.Lock()
        self._processing = False
        self._config_cache: Optional[Dict[str, Any]] = None

        # ---- Sidebar ---------------------------------------------------
        self.sidebar = ctk.CTkFrame(self, width=260, corner_radius=0)
        self.sidebar.grid(row=0, column=0, sticky="nsew")
        self.grid_columnconfigure(1, weight=1)
        self.grid_rowconfigure(0, weight=1)

        ctk.CTkLabel(self.sidebar, text="META ANALYZER", font=FONT_TITLE).pack(pady=30)
        ctk.CTkLabel(self.sidebar, text="1. Add Replays:", text_color="gray").pack(pady=(10, 5))
        ctk.CTkButton(self.sidebar, text="Add Files", command=self.select_files).pack(
            pady=3, padx=20, fill="x"
        )
        ctk.CTkButton(
            self.sidebar,
            text="Add Folder (Recursive)",
            command=self.select_folder,
            fg_color="#D84315",
            hover_color="#BF360C",
        ).pack(pady=3, padx=20, fill="x")
        ctk.CTkButton(
            self.sidebar,
            text="Clear Queue",
            command=self.clear_queue,
            fg_color="transparent",
            border_width=1,
            text_color="gray",
        ).pack(pady=3, padx=20, fill="x")

        self.queue_lbl = ctk.CTkLabel(self.sidebar, text="Queue: 0 replays", text_color="gray")
        self.queue_lbl.pack(pady=(5, 10))

        ctk.CTkLabel(self.sidebar, text="2. Select Your Name:", text_color="gray").pack(
            pady=(10, 5)
        )
        self.profile_combo = ctk.CTkComboBox(
            self.sidebar, values=["Upload First..."], command=self.set_profile
        )
        self.profile_combo.pack(pady=5, padx=20, fill="x")

        self.btn_run = ctk.CTkButton(
            self.sidebar,
            text="3. Run Analysis",
            command=self.run_analysis,
            state="disabled",
            fg_color="gray",
            height=40,
        )
        self.btn_run.pack(pady=20, padx=20, fill="x")

        self.progress_bar = ctk.CTkProgressBar(self.sidebar, mode="determinate")
        self.progress_bar.pack(padx=20, fill="x")
        self.progress_bar.set(0)

        # --- Season filter ---
        # Limits which games are considered "active" for every aggregation
        # tab. Cuts startup work proportionally — picking "Last 90 days" on
        # a 12k-game DB usually drops the active set to a few hundred and
        # the tabs render almost instantly.
        ctk.CTkLabel(self.sidebar, text="Season Filter:", text_color="gray").pack(pady=(15, 5))
        self.season_filter_var = ctk.StringVar(value="All time")
        ctk.CTkOptionMenu(
            self.sidebar,
            values=["Last 30 days", "Last 90 days", "Last 6 months", "Last year", "All time"],
            variable=self.season_filter_var,
            command=lambda _v: self._on_season_filter_change(),
            width=200,
        ).pack(pady=(0, 5), padx=20, fill="x")
        self._season_lbl = ctk.CTkLabel(
            self.sidebar, text="", text_color="gray", font=("Arial", 10),
        )
        self._season_lbl.pack(pady=(0, 5))

        ctk.CTkLabel(self.sidebar, text="Utilities:", text_color="gray").pack(pady=(20, 5))
        ctk.CTkButton(
            self.sidebar,
            text="Export to CSV",
            command=self.export_csv,
            fg_color="transparent",
            border_width=1,
            text_color="gray",
        ).pack(pady=3, padx=20, fill="x")
        ctk.CTkButton(
            self.sidebar,
            text="Show Error Log",
            command=self.show_errors,
            fg_color="transparent",
            border_width=1,
            text_color="gray",
        ).pack(pady=3, padx=20, fill="x")
        ctk.CTkButton(
            self.sidebar,
            text="Debug Single Replay",
            command=self.debug_single_replay,
            fg_color="#4A148C",
            hover_color="#6A1B9A",
        ).pack(pady=3, padx=20, fill="x")
        ctk.CTkButton(
            self.sidebar,
            text="Backfill Macro Scores",
            command=self.backfill_macro_scores,
            fg_color="#00695C",
            hover_color="#00897B",
        ).pack(pady=3, padx=20, fill="x")
        self.status_lbl = ctk.CTkLabel(
            self.sidebar, text="Ready", text_color="gray", wraplength=220
        )
        self.status_lbl.pack(side="bottom", pady=20)

        # ---- Tabview ---------------------------------------------------
        # `command=` fires whenever the user clicks a different tab. We
        # use it for lazy rendering: auto-refresh marks every non-visible
        # tab dirty and only rebuilds them on first view, which keeps
        # the live-update path snappy even with thousands of records.
        self.tabview = ctk.CTkTabview(self, command=self._on_tab_changed)
        self.tabview.grid(row=0, column=1, padx=10, pady=10, sticky="nsew")
        self.tab_my_builds = self.tabview.add("My Builds")
        self.tab_opp_strats = self.tabview.add("Opp. Strategies")
        self.tab_vs_strategy = self.tabview.add("Build vs Strategy")
        self.tab_opponents = self.tabview.add("Opponents")
        self.tab_maps = self.tabview.add("Map Stats")
        self.tab_matchups = self.tabview.add("Matchups")
        self.tab_definitions = self.tabview.add("Definitions")

        # Opponents tab state — populated lazily on first view to keep
        # startup snappy on big DBs.
        self._opp_search_var = ctk.StringVar(value="")
        self._opp_min_games_var = ctk.StringVar(value="10")
        self._opp_selected: Optional[str] = None
        self._opp_list_frame: Optional[ctk.CTkScrollableFrame] = None
        self._opp_detail_frame: Optional[ctk.CTkScrollableFrame] = None

        # ---- Median-key-timings card state (TIMING_CARDS_PATCH_V1) ----
        # Per-tab UI state (segmented filter chip, etc.). Survives section
        # re-renders so toggling Both/Opp tech/Your tech doesn't reset on
        # every profile load.
        self._opp_ui_state: Dict[str, object] = {
            "timing_source_filter": "Both",
        }
        # CTkImage cache keyed by token internal_name. Process-lifetime so
        # the icons survive Opponents-tab re-renders without re-decoding
        # the underlying PNGs (which flickers visibly).
        self._timing_icon_cache: Dict[str, "ctk.CTkImage"] = {}
        # Owned by `_render_opp_timings_card`. The source-filter callback
        # reads/writes this dict so it can rebuild the grid body without
        # re-deriving the profile payload.
        self._timing_grid_state: Dict[str, object] = {}
        # Track which tabs need re-rendering because the underlying DB
        # changed since they were last drawn. Empty set == all clean.
        self._dirty_tabs: Set[str] = set()

        # Filters / sort vars
        self._build_filter_var = ctk.StringVar(value="All")
        self._strat_search_var = ctk.StringVar(value="")
        self._strat_sort_var = ctk.StringVar(value="Games Played")
        self._build_sort_var = ctk.StringVar(value="Games Played")
        self._hide_empty_var = ctk.BooleanVar(value=True)

        # ---- My Builds tab top controls --------------------------------
        self._build_filter_frame = ctk.CTkFrame(self.tab_my_builds, fg_color="transparent")
        self._build_filter_frame.pack(fill="x", padx=5, pady=(5, 0))
        ctk.CTkLabel(self._build_filter_frame, text="Filter:").pack(side="left", padx=5)
        for val in ("All", "PvZ", "PvP", "PvT"):
            ctk.CTkRadioButton(
                self._build_filter_frame,
                text=val,
                variable=self._build_filter_var,
                value=val,
                command=self._render_builds_scroll,
            ).pack(side="left", padx=8)

        self._build_sort_frame = ctk.CTkFrame(self.tab_my_builds, fg_color="transparent")
        self._build_sort_frame.pack(fill="x", padx=5)
        ctk.CTkLabel(self._build_sort_frame, text="Sort:").pack(side="left", padx=5)
        ctk.CTkOptionMenu(
            self._build_sort_frame,
            values=["Games Played", "Win Rate", "Name"],
            variable=self._build_sort_var,
            command=lambda _: self._render_builds_scroll(),
        ).pack(side="left", padx=5)
        ctk.CTkCheckBox(
            self._build_sort_frame,
            text="Hide empty builds",
            variable=self._hide_empty_var,
            command=self._render_builds_scroll,
        ).pack(side="left", padx=20)

        self._builds_scroll = ctk.CTkScrollableFrame(self.tab_my_builds)
        self._builds_scroll.pack(fill="both", expand=True, padx=5, pady=5)

        self._load_config()
        self.refresh_all_tabs()

        # ---- Live auto-refresh ----------------------------------------
        # The replay watcher (watchers/replay_watcher.py) cross-writes
        # every finished replay into data/meta_database.json via
        # DataStore.link_game(). The analyzer polls the file's signature
        # (mtime + size + tiny head/tail hash -- see
        # ReplayAnalyzer.compute_db_signature) every few seconds. When
        # the signature changes we reload the DB *once*, mark every tab
        # dirty, but only re-render the currently visible tab. The
        # others rebuild on first view via _on_tab_changed -- which
        # keeps the live-update path snappy even for big DBs.
        self._last_db_signature = ReplayAnalyzer.compute_db_signature(META_DB_FILE)
        self._auto_refresh_enabled = True
        self.after(5000, self._auto_refresh_tick)

    # ------------------------------------------------------------------
    # TAB BOOKKEEPING + LAZY RE-RENDER
    # ------------------------------------------------------------------
    # Single source of truth for the (label -> renderer) mapping. Both
    # refresh_all_tabs and the lazy-render path go through this so they
    # stay in sync if a new tab is added later.
    _TAB_RENDERERS: List[Tuple[str, str]] = [
        ("My Builds",         "_render_builds_scroll"),
        ("Opp. Strategies",   "_render_opp_strats_tab"),
        ("Build vs Strategy", "_render_vs_strategy_tab"),
        ("Opponents",         "_render_opponents_tab"),
        ("Map Stats",         "_render_maps_tab"),
        ("Matchups",          "_render_matchups_tab"),
        ("Definitions",       "_render_definitions_tab"),
    ]

    def _render_single_tab(self, tab_name: str) -> None:
        """Render exactly one tab by label. Errors are isolated."""
        for label, attr in self._TAB_RENDERERS:
            if label != tab_name:
                continue
            fn = getattr(self, attr, None)
            if not callable(fn):
                return
            try:
                fn()
            except Exception as exc:
                tb = traceback.format_exc()
                print(f"[Analyzer] Render failed for tab '{tab_name}': {exc}\n{tb}")
            return

    def _on_tab_changed(self) -> None:
        """When the user switches tabs, lazily render if it's dirty."""
        try:
            current = self.tabview.get()
        except Exception:
            return
        if current in self._dirty_tabs:
            self._render_single_tab(current)
            self._dirty_tabs.discard(current)

    def _update_db_status_label(self) -> None:
        """Cheap sidebar refresh -- doesn't touch any tab."""
        try:
            db = self.analyzer.db
            total_builds = len(db)
            non_empty = sum(1 for v in db.values() if v.get("games"))
            total_games = sum(len(v.get("games", [])) for v in db.values())
            self.status_lbl.configure(text=(
                f"DB: {non_empty} active builds / {total_builds} total\n"
                f"     {total_games} games"
            ))
        except Exception:
            pass

    def _auto_refresh_tick(self) -> None:
        """
        Periodic poll. Cheap path runs every 5s -- it just compares the
        DB file signature against the last seen one. If unchanged, no
        work happens. If changed, we reload the DB, mark every tab
        dirty, and render only the currently visible one. Other tabs
        rebuild on first view via _on_tab_changed.
        """
        try:
            if not self._auto_refresh_enabled or self._processing:
                return
            sig = ReplayAnalyzer.compute_db_signature(META_DB_FILE)
            if sig is None or sig == self._last_db_signature:
                return  # No change -- skip the entire reload + render.
            self._last_db_signature = sig
            print("[Analyzer] meta_database.json changed -- reloading "
                  "(visible tab eager, others lazy)...")
            self.analyzer.load_database()
            self._update_db_status_label()
            # Mark all tabs dirty; render the currently visible one now.
            self._dirty_tabs = {label for label, _ in self._TAB_RENDERERS}
            try:
                current = self.tabview.get()
            except Exception:
                current = None
            if current and current in self._dirty_tabs:
                self._render_single_tab(current)
                self._dirty_tabs.discard(current)
        except Exception as exc:
            print(f"[Analyzer] auto-refresh skipped: {exc}")
        finally:
            self.after(5000, self._auto_refresh_tick)

    # ----- Misc UI helpers ---------------------------------------------
    def _ui_update(self, func, *args, **kwargs):
        self.after(0, lambda: func(*args, **kwargs))

    # ---------- Season filter ------------------------------------------
    _SEASON_DAYS = {
        "Last 30 days": 30,
        "Last 90 days": 90,
        "Last 6 months": 183,
        "Last year": 365,
        "All time": None,
    }

    def _season_cutoff_iso(self) -> Optional[str]:
        choice = self.season_filter_var.get() if hasattr(self, "season_filter_var") else "All time"
        days = self._SEASON_DAYS.get(choice)
        if days is None:
            return None
        cutoff = datetime.now() - timedelta(days=days)
        return cutoff.isoformat()

    def _filtered_games(self, games):
        cutoff = self._season_cutoff_iso()
        if cutoff is None:
            return games
        return [g for g in games if (g.get("date") or "") >= cutoff]

    def _get_config(self) -> Dict[str, Any]:
        """Lazy-load the configuration and cache it."""
        if self._config_cache is None:
            if os.path.exists(CONFIG_FILE):
                try:
                    with open(CONFIG_FILE, "r", encoding="utf-8") as f:
                        self._config_cache = json.load(f) or {}
                except Exception:
                    self._config_cache = {}
            else:
                self._config_cache = {}
        return self._config_cache

    def _on_season_filter_change(self) -> None:
        try:
            cutoff = self._season_cutoff_iso()
            if cutoff is None:
                self._season_lbl.configure(text="(scoring on all games)")
            else:
                d = datetime.fromisoformat(cutoff)
                self._season_lbl.configure(
                    text=f"(scoring games since {d.strftime('%Y-%m-%d')})",
                )
            # Mark every tab dirty so the lazy-render pass picks up the
            # new filter; force-render the visible tab right now.
            self.refresh_all_tabs()
            try:
                conf = self._get_config()
                conf["season_filter"] = self.season_filter_var.get()
                from core.atomic_io import atomic_write_json
                atomic_write_json(CONFIG_FILE, conf, indent=None)
            except Exception as e:
                print(f"[Analyzer] Season filter save failed: {e}")
        except Exception as e:
            print(f"[Analyzer] Season filter change failed: {e}")

    def _load_config(self) -> None:
        try:
            conf = self._get_config()
            last_player = conf.get("last_player")
            if last_player:
                self.analyzer.selected_player_name = last_player
                self.profile_combo.configure(values=[last_player])
                self.profile_combo.set(last_player)
                self.btn_run.configure(state="normal", fg_color="#1f538d")
            # Restore last season-filter choice (defaults to All time).
            saved_season = conf.get("season_filter")
            if saved_season and saved_season in self._SEASON_DAYS:
                try:
                    self.season_filter_var.set(saved_season)
                    cutoff = self._season_cutoff_iso()
                    if cutoff is None:
                        self._season_lbl.configure(text="(scoring on all games)")
                    else:
                        d = datetime.fromisoformat(cutoff)
                        self._season_lbl.configure(
                            text=f"(scoring games since {d.strftime('%Y-%m-%d')})",
                        )
                except Exception:
                    pass
        except Exception:
            pass

    def set_profile(self, choice) -> None:
        if choice and choice != "Upload First...":
            self.analyzer.selected_player_name = choice
            try:
                os.makedirs(os.path.dirname(CONFIG_FILE), exist_ok=True)
                # Don't clobber other config keys (like season_filter).
                conf = self._get_config()
                conf["last_player"] = choice
                from core.atomic_io import atomic_write_json
                atomic_write_json(CONFIG_FILE, conf, indent=None)
            except Exception as exc:
                print(f"[Analyzer] Config save failed: {exc}")

    # ----- Queue management --------------------------------------------
    def clear_queue(self) -> None:
        with self._queue_lock:
            self.queued_files = []
        self._ui_update(self.queue_lbl.configure, text="Queue: 0 replays")
        self._ui_update(self.status_lbl.configure, text="Queue cleared.")
        self._ui_update(self.btn_run.configure, state="disabled", text="3. Run Analysis")

    def select_folder(self) -> None:
        folder = filedialog.askdirectory()
        if not folder:
            return
        files = glob.glob(os.path.join(folder, "**", "*.SC2Replay"), recursive=True)
        if not files:
            self._ui_update(self.status_lbl.configure, text="No .SC2Replay files found.")
            return
        with self._queue_lock:
            existing = set(self.queued_files)
            new_files = [f for f in files if f not in existing]
            self.queued_files.extend(new_files)
            total = len(self.queued_files)
        self._ui_update(self.queue_lbl.configure, text=f"Queue: {total} replays")
        self._ui_update(self.btn_run.configure, text=f"3. Run Analysis ({total})")
        self._ui_update(
            self.status_lbl.configure, text=f"Added {len(new_files)} replays from folder."
        )
        threading.Thread(target=self._scan_names_thread, daemon=True).start()

    def select_files(self) -> None:
        paths = filedialog.askopenfilenames(filetypes=[("SC2 Replays", "*.SC2Replay")])
        if not paths:
            return
        with self._queue_lock:
            existing = set(self.queued_files)
            new_files = [f for f in paths if f not in existing]
            self.queued_files.extend(new_files)
            total = len(self.queued_files)
        self._ui_update(self.queue_lbl.configure, text=f"Queue: {total} replays")
        self._ui_update(self.btn_run.configure, text=f"3. Run Analysis ({total})")
        threading.Thread(target=self._scan_names_thread, daemon=True).start()

    def _scan_names_thread(self) -> None:
        with self._queue_lock:
            scan_subset = list(self.queued_files[:50])
        if not scan_subset:
            self._ui_update(self.status_lbl.configure, text="No replays to scan.")
            return

        # Tell the user the (slow) load_level=2 pass is in flight so a
        # frozen-looking UI doesn't stay silent.
        self._ui_update(
            self.status_lbl.configure,
            text=f"Scanning {len(scan_subset)} replay(s) for player names...",
        )
        names = self.analyzer.scan_for_players(scan_subset)
        all_names = sorted(set(names))

        def update_ui():
            current_values: List[str] = []
            try:
                current_values = list(self.profile_combo.cget("values"))
            except Exception:
                pass
            merged = sorted(set(current_values + all_names) - {"Upload First..."})

            if not merged:
                # Scan finished but found no candidates. Surface the failure
                # rather than silently leaving the dropdown empty.
                self.profile_combo.configure(values=["Upload First..."])
                self.profile_combo.set("Upload First...")
                err_count = self.analyzer.error_logger.count
                if err_count > 0:
                    self.status_lbl.configure(
                        text=(f"No human player names found in {len(scan_subset)} "
                              f"replay(s). {err_count} error(s) logged - click "
                              f"'Show Error Log' for details."),
                        text_color=COLOR_LOSS,
                    )
                else:
                    self.status_lbl.configure(
                        text=(f"No human player names found in {len(scan_subset)} "
                              f"replay(s). Try adding more replays."),
                        text_color="#FBC02D",
                    )
                self.btn_run.configure(state="disabled")
                return

            self.profile_combo.configure(values=merged)
            current_choice = self.profile_combo.get()
            if (self.analyzer.selected_player_name
                    and self.analyzer.selected_player_name in merged):
                self.profile_combo.set(self.analyzer.selected_player_name)
            elif current_choice not in merged:
                self.profile_combo.set(merged[0])
                self.set_profile(merged[0])
            self.btn_run.configure(state="normal", fg_color="#1f538d")
            self.status_lbl.configure(
                text=f"Scan complete: {len(merged)} player name(s) available.",
                text_color="gray",
            )

        self._ui_update(update_ui)

    # ----- Run analysis -------------------------------------------------
    def run_analysis(self) -> None:
        with self._queue_lock:
            if not self.queued_files:
                return
        if self._processing:
            return
        self._processing = True
        self._ui_update(self.status_lbl.configure, text="Analyzing...")
        self._ui_update(self.btn_run.configure, state="disabled")
        self._ui_update(self.progress_bar.set, 0)
        self.analyzer.error_logger.clear()
        threading.Thread(target=self._process_thread, daemon=True).start()

    def _process_thread(self) -> None:
        with self._queue_lock:
            files_to_process = list(self.queued_files)
        total = len(files_to_process)
        success_count = 0
        player_name = self.analyzer.selected_player_name

        with concurrent.futures.ProcessPoolExecutor() as executor:
            future_to_file = {
                executor.submit(process_replay_task, path, player_name): path
                for path in files_to_process
            }
            for i, future in enumerate(concurrent.futures.as_completed(future_to_file)):
                path = future_to_file[future]
                try:
                    result = future.result()
                    if result["status"] == "success":
                        gid = result["game_id"]
                        if gid not in self.analyzer._known_game_ids:
                            my_build = result["my_build"]
                            game_data = result["data"]
                            with self.analyzer._lock:
                                if my_build not in self.analyzer.db:
                                    self.analyzer.db[my_build] = {
                                        "games": [],
                                        "wins": 0,
                                        "losses": 0,
                                    }
                                self.analyzer.db[my_build]["games"].append(game_data)
                                self.analyzer._known_game_ids.add(gid)
                                AnalyzerDBStore.recalc_stats(self.analyzer.db, my_build)
                            success_count += 1
                    else:
                        self.analyzer.error_logger.log(path, result.get("error", "Unknown error"))
                except Exception as exc:
                    self.analyzer.error_logger.log(path, f"System Error: {exc}")

                if i % 2 == 0 or i == total - 1:
                    self._ui_update(self.progress_bar.set, (i + 1) / total)
                    self._ui_update(
                        self.status_lbl.configure,
                        text=f"Processing {i + 1}/{total}... ({success_count} new)",
                    )

        self.analyzer.save_database()
        self.analyzer.error_logger.save(ERROR_LOG_FILE)
        with self._queue_lock:
            self.queued_files = []

        err_count = self.analyzer.error_logger.count
        msg = f"Done! {success_count} new games added."
        if err_count > 0:
            msg += f"\n({err_count} errors -- see log)"

        self._ui_update(self.progress_bar.set, 1.0)
        self._ui_update(self.status_lbl.configure, text=msg)
        self._ui_update(self.queue_lbl.configure, text="Queue: 0 replays")
        self._ui_update(self.btn_run.configure, text="3. Run Analysis", state="disabled")
        self._ui_update(self.refresh_all_tabs)
        self._processing = False

    # ----- Sidebar utilities -------------------------------------------
    def export_csv(self) -> None:
        path = filedialog.asksaveasfilename(
            parent=self,
            defaultextension=".csv",
            filetypes=[("CSV", "*.csv")],
            initialfile="sc2_stats.csv",
        )
        if path:
            self.analyzer.export_csv(path)
            self.status_lbl.configure(text=f"Exported to {os.path.basename(path)}")

    def show_errors(self) -> None:
        errors = self.analyzer.error_logger.errors
        t = ctk.CTkToplevel(self)
        t.geometry("700x500")
        t.title(f"Error Log ({len(errors)} errors)")
        t.transient(self)
        t.lift()
        if not errors:
            ctk.CTkLabel(t, text="No errors recorded.", font=FONT_HEADING).pack(pady=40)
            return
        scroll = ctk.CTkScrollableFrame(t)
        scroll.pack(fill="both", expand=True, padx=10, pady=10)
        for e in errors:
            frame = ctk.CTkFrame(scroll, fg_color=("gray85", "gray20"))
            frame.pack(fill="x", pady=2)
            ctk.CTkLabel(
                frame, text=e["file"], font=("Arial", 11, "bold"), anchor="w"
            ).pack(fill="x", padx=10, pady=(5, 0))
            ctk.CTkLabel(
                frame,
                text=e["error"],
                text_color=COLOR_LOSS,
                font=FONT_SMALL,
                anchor="w",
                wraplength=650,
            ).pack(fill="x", padx=10, pady=(0, 5))

    # ----- Macro backfill --------------------------------------------------
    def backfill_macro_scores(self) -> None:
        """Walk every game in the DB and compute macro_score for any that
        don't already have one, persisting results back to the DB.

        Same engine as `process_replay_task` but skips games that already
        have a macro_score, so it's safe to run any time.
        """
        if not self.analyzer.selected_player_name:
            messagebox.showwarning(
                "No Player Selected",
                "Pick your player name first so we know which side to score.",
            )
            return
        with self.analyzer._lock:
            candidates: List[Tuple[str, str, str]] = []
            for build_name, bd in self.analyzer.db.items():
                if not isinstance(bd, dict):
                    continue
                for g in bd.get("games", []) or []:
                    # Recompute games with score == 0 too — those were
                    # likely scored by the legacy too-aggressive formula
                    # and the new SQ-based engine should give a meaningful
                    # number.
                    score = g.get("macro_score")
                    if score is not None and score != 0:
                        continue
                    fp = g.get("file_path")
                    if not fp or not os.path.exists(fp):
                        continue
                    candidates.append((build_name, g.get("id"), fp))
        if not candidates:
            messagebox.showinfo(
                "Nothing to backfill",
                "Every game in the DB already has a macro score "
                "(or its replay file is missing).",
            )
            return
        if not messagebox.askyesno(
            "Backfill macro scores?",
            f"Re-parse {len(candidates)} replays to compute macro scores?\n\n"
            f"This runs in the background and takes roughly "
            f"{max(1, len(candidates) * 2 // 60)} minute(s). The app stays usable.",
        ):
            return
        threading.Thread(
            target=self._backfill_macro_thread, args=(candidates,), daemon=True,
        ).start()

    def _backfill_macro_thread(self, candidates) -> None:
        """Worker: re-parse replays, compute macro, save periodically."""
        from analytics.macro_score import compute_macro_score
        from core.event_extractor import extract_macro_events
        from core.sc2_replay_parser import _load_replay  # uses fallback chain

        total = len(candidates)
        success = 0
        errors = 0
        target = self.analyzer.selected_player_name or ""

        def _match_me(replay, target_name):
            tn = (target_name or "").lower()
            for p in replay.players:
                if p.name == target_name:
                    return p
            for p in replay.players:
                pname = (getattr(p, "name", "") or "").lower()
                if tn and (tn in pname or pname in tn):
                    return p
            humans = [p for p in replay.players
                      if getattr(p, "is_human", True)
                      and not getattr(p, "is_observer", False)
                      and not getattr(p, "is_referee", False)]
            if len(humans) == 1:
                return humans[0]
            return None

        for i, (build_name, game_id, file_path) in enumerate(candidates):
            try:
                replay = _load_replay(file_path, 4)
                me = _match_me(replay, target)
                if not me:
                    self.analyzer.error_logger.log(
                        file_path,
                        f"Backfill: player '{target}' not found in replay",
                    )
                    errors += 1
                    continue
                length = getattr(replay, "game_length", None)
                length_sec = length.seconds if length else 0
                macro_events = extract_macro_events(replay, me.pid)
                result = compute_macro_score(macro_events, me.play_race, length_sec)
                with self.analyzer._lock:
                    bd = self.analyzer.db.get(build_name) or {}
                    for g in bd.get("games", []) or []:
                        if g.get("id") == game_id:
                            g["macro_score"] = result.get("macro_score")
                            g["top_3_leaks"] = result.get("top_3_leaks", []) or []
                            break
                success += 1
            except Exception as exc:
                self.analyzer.error_logger.log(
                    file_path, f"Macro backfill error: {exc}",
                )
                errors += 1
            if i % 25 == 0 or i == total - 1:
                self._ui_update(
                    self.status_lbl.configure,
                    text=f"Backfilling macro: {i + 1}/{total} ({success} ok, {errors} err)",
                )
            if (i + 1) % 250 == 0:
                try:
                    self.analyzer.save_database()
                except Exception:
                    pass

        try:
            self.analyzer.save_database()
        except Exception:
            pass
        self._ui_update(
            self.status_lbl.configure,
            text=f"Macro backfill done: {success} computed, {errors} failed.",
        )
        self._ui_update(self.refresh_all_tabs)

    def debug_single_replay(self) -> None:
        if not self.analyzer.selected_player_name:
            messagebox.showwarning(
                "No Player", "Please select your player name first."
            )
            return
        path = filedialog.askopenfilename(filetypes=[("SC2 Replays", "*.SC2Replay")])
        if not path:
            return
        self.status_lbl.configure(text="Running debug analysis...")
        self.update_idletasks()

        def run():
            report = debug_analyze_replay(path, self.analyzer.selected_player_name)
            self.after(0, lambda: self._show_debug_window(report, path))

        threading.Thread(target=run, daemon=True).start()

    def _show_debug_window(self, report: str, file_path: str) -> None:
        self.status_lbl.configure(text="Debug complete.")
        t = ctk.CTkToplevel(self)
        t.geometry("1200x900")
        t.title(f"Debug Report: {os.path.basename(file_path)}")
        t.transient(self)
        t.lift()
        t.after(150, t.focus_force)

        btn_frame = ctk.CTkFrame(t, fg_color="transparent")
        btn_frame.pack(fill="x", padx=10, pady=5)

        def save_report():
            save_path = filedialog.asksaveasfilename(
                parent=t,
                defaultextension=".txt",
                filetypes=[("Text", "*.txt")],
                initialfile=f"debug_{os.path.basename(file_path)}.txt",
            )
            if save_path:
                with open(save_path, "w", encoding="utf-8") as f:
                    f.write(report)

        ctk.CTkButton(
            btn_frame, text="Save Report to File", command=save_report, fg_color="#1565C0"
        ).pack(side="left", padx=5)
        ctk.CTkButton(
            btn_frame, text="Close", command=t.destroy, fg_color="#D32F2F"
        ).pack(side="right", padx=5)
        textbox = ctk.CTkTextbox(t, font=("Consolas", 11), wrap="none")
        textbox.pack(fill="both", expand=True, padx=10, pady=10)
        textbox.insert("1.0", report)
        textbox.configure(state="disabled")

    # ----- Tab rendering -----------------------------------------------
    def refresh_all_tabs(self) -> None:
        """
        Force-render every tab. Used after a manual batch run, on
        startup, or when the user explicitly hits "Run Analysis". The
        live-update path through _auto_refresh_tick is far cheaper --
        it only renders the visible tab and marks the rest dirty.

        Each tab's render is isolated so one bad tab doesn't blank out
        the rest. Tracebacks go to the console for diagnosis.
        """
        # Refresh the sidebar DB stats label first so it appears even if
        # one of the tab renders blows up.
        self._update_db_status_label()
        try:
            db = self.analyzer.db
            print(
                f"[Analyzer] DB stats -- builds={len(db)}, "
                f"non-empty={sum(1 for v in db.values() if v.get('games'))}, "
                f"games={sum(len(v.get('games', [])) for v in db.values())}"
            )
        except Exception:
            pass

        for label, attr in self._TAB_RENDERERS:
            fn = getattr(self, attr, None)
            if not callable(fn):
                continue
            try:
                fn()
            except Exception as exc:
                tb = traceback.format_exc()
                print(f"[Analyzer] Render failed for tab '{label}': {exc}\n{tb}")
        # All tabs are now clean.
        self._dirty_tabs.clear()

    def _render_builds_scroll(self) -> None:
        for w in self._builds_scroll.winfo_children():
            w.destroy()
        db = self.analyzer.db
        filter_val = self._build_filter_var.get()
        sort_val = self._build_sort_var.get()
        hide_empty = self._hide_empty_var.get()
        # Apply season filter to each build's game list before counting.
        items = []
        for name, data in db.items():
            if not isinstance(data, dict):
                continue
            if filter_val != "All" and not name.startswith(filter_val):
                continue
            games_in_season = self._filtered_games(data.get("games", []) or [])
            wins_s = sum(1 for g in games_in_season if g.get("result") == "Win")
            losses_s = sum(1 for g in games_in_season if g.get("result") == "Loss")
            items.append((name, {
                "games": games_in_season, "wins": wins_s, "losses": losses_s,
            }))
        if sort_val == "Games Played":
            items.sort(key=lambda x: len(x[1].get("games", [])), reverse=True)
        elif sort_val == "Win Rate":
            def wr_key(it):
                w = it[1].get("wins", 0)
                l_ = it[1].get("losses", 0)
                return (w / (w + l_)) if (w + l_) > 0 else -1
            items.sort(key=wr_key, reverse=True)
        elif sort_val == "Name":
            items.sort(key=lambda x: x[0])
        all_builds = self.analyzer.get_all_build_names()

        # Render budget — too many CTk widgets stalls the Tk loop. Cap at
        # 200; show a hint if more are available.
        RENDER_LIMIT = 200
        cards_built = 0
        nonempty_total = sum(1 for _, d in items if (d["wins"] + d["losses"]) > 0)
        for name, data in items:
            wins = data.get("wins", 0)
            losses = data.get("losses", 0)
            total = wins + losses
            if hide_empty and total == 0:
                continue
            if cards_built >= RENDER_LIMIT:
                break
            wr = int((wins / total) * 100) if total > 0 else 0
            color = wr_color(wins, total)
            card = ctk.CTkFrame(self._builds_scroll, fg_color=("gray85", "gray20"))
            card.pack(fill="x", pady=4, padx=5)
            head = ctk.CTkFrame(card, fg_color="transparent")
            head.pack(fill="x", padx=10, pady=5)
            ctk.CTkLabel(head, text=name, font=("Arial", 15, "bold")).pack(side="left")
            ctk.CTkLabel(
                head,
                text=f"{wins}W - {losses}L ({wr}%)  -  {total} games",
                text_color=color,
            ).pack(side="right")
            ctk.CTkButton(
                card,
                text="Deep Dive",
                height=26,
                command=lambda n=name, d=data: self.open_deep_dive(n, d, all_builds),
            ).pack(fill="x", padx=10, pady=(0, 5))
            cards_built += 1

        # If nothing made it onto the scroll, drop a friendly placeholder
        # so the tab is never visually blank.
        if cards_built == 0:
            ctk.CTkLabel(
                self._builds_scroll,
                text=(
                    "No builds match the current filter.\n"
                    "Tip: uncheck 'Hide empty builds' or change the filter."
                ),
                font=FONT_BODY,
                text_color="gray",
                justify="center",
            ).pack(pady=40)
        elif nonempty_total > cards_built:
            ctk.CTkLabel(
                self._builds_scroll,
                text=(
                    f"Showing top {cards_built} of {nonempty_total}. "
                    "Filter or change Sort to see others."
                ),
                font=FONT_SMALL, text_color="gray",
            ).pack(pady=8)
        print(f"[Analyzer] My Builds rendered {cards_built} card(s).")

    def _render_opp_strats_tab(self) -> None:
        for w in self.tab_opp_strats.winfo_children():
            w.destroy()
        ctk.CTkLabel(
            self.tab_opp_strats, text="WIN RATE VS OPPONENT STRATEGIES", font=FONT_HEADING
        ).pack(pady=10)
        scroll = ctk.CTkScrollableFrame(self.tab_opp_strats)
        scroll.pack(fill="both", expand=True, padx=10, pady=5)
        # Season-aware aggregation: bypass the analyzer's cached helpers and
        # walk the DB directly through the season filter.
        opp_stats: Dict[str, Dict] = {}
        for bd in self.analyzer.db.values():
            if not isinstance(bd, dict):
                continue
            for g in self._filtered_games(bd.get("games", []) or []):
                strat = g.get("opp_strategy", "Unknown")
                if strat not in opp_stats:
                    opp_stats[strat] = {"wins": 0, "losses": 0}
                if g.get("result") == "Win":
                    opp_stats[strat]["wins"] += 1
                elif g.get("result") == "Loss":
                    opp_stats[strat]["losses"] += 1
        items = sorted(
            opp_stats.items(), key=lambda x: x[1]["wins"] + x[1]["losses"], reverse=True
        )
        row_idx, col_idx = 0, 0
        for strat, s in items:
            total = s["wins"] + s["losses"]
            if total == 0:
                continue
            wr = int((s["wins"] / total) * 100)
            color = wr_color(s["wins"], total)
            lbl = ctk.CTkLabel(
                scroll,
                text=f"{strat}\n{wr}% ({s['wins']}W - {s['losses']}L)",
                text_color=color,
                width=200,
                height=55,
                fg_color=("gray90", "gray25"),
                corner_radius=6,
                font=FONT_BODY,
            )
            lbl.grid(row=row_idx, column=col_idx, padx=5, pady=5, sticky="ew")
            col_idx += 1
            if col_idx > 3:
                col_idx, row_idx = 0, row_idx + 1

    def _render_vs_strategy_tab(self) -> None:
        for w in self.tab_vs_strategy.winfo_children():
            w.destroy()
        ctrl_frame = ctk.CTkFrame(self.tab_vs_strategy, fg_color="transparent")
        ctrl_frame.pack(fill="x", padx=10, pady=(10, 5))
        ctk.CTkLabel(ctrl_frame, text="Search:").pack(side="left", padx=5)
        search_entry = ctk.CTkEntry(
            ctrl_frame, textvariable=self._strat_search_var, width=200, placeholder_text="e.g. Zerg"
        )
        search_entry.pack(side="left", padx=5)
        search_entry.bind("<KeyRelease>", lambda e: self._render_vs_strategy_list())
        ctk.CTkLabel(ctrl_frame, text="Sort By:").pack(side="left", padx=(20, 5))
        sort_opts = [
            "Games Played",
            "Win Rate (High)",
            "Win Rate (Low)",
            "Opponent Strategy",
            "My Build",
        ]
        ctk.CTkOptionMenu(
            ctrl_frame,
            values=sort_opts,
            variable=self._strat_sort_var,
            command=lambda _: self._render_vs_strategy_list(),
        ).pack(side="left", padx=5)
        ctk.CTkLabel(
            self.tab_vs_strategy, text="MY BUILD VS OPPONENT STRATEGY", font=FONT_HEADING
        ).pack(pady=5)
        header_frame = ctk.CTkFrame(self.tab_vs_strategy, fg_color="transparent")
        header_frame.pack(fill="x", padx=20)
        ctk.CTkLabel(
            header_frame, text="My Build", width=300, anchor="w", font=("Arial", 12, "bold")
        ).pack(side="left")
        ctk.CTkLabel(
            header_frame, text="VS", width=50, anchor="center", font=("Arial", 12, "bold")
        ).pack(side="left")
        ctk.CTkLabel(
            header_frame,
            text="Opponent Strategy",
            width=300,
            anchor="w",
            font=("Arial", 12, "bold"),
        ).pack(side="left")
        ctk.CTkLabel(
            header_frame, text="Win Rate", width=150, anchor="e", font=("Arial", 12, "bold")
        ).pack(side="right", padx=10)
        self._vs_strat_scroll = ctk.CTkScrollableFrame(self.tab_vs_strategy)
        self._vs_strat_scroll.pack(fill="both", expand=True, padx=10, pady=5)
        self._render_vs_strategy_list()

    def _render_vs_strategy_list(self) -> None:
        for w in self._vs_strat_scroll.winfo_children():
            w.destroy()
        # Season-aware: aggregate from filtered subsets only.
        agg: Dict = {}
        for bname, bd in self.analyzer.db.items():
            if not isinstance(bd, dict):
                continue
            for g in self._filtered_games(bd.get("games", []) or []):
                key = (bname, g.get("opp_strategy", "Unknown"))
                if key not in agg:
                    agg[key] = {"wins": 0, "losses": 0}
                if g.get("result") == "Win":
                    agg[key]["wins"] += 1
                elif g.get("result") == "Loss":
                    agg[key]["losses"] += 1
        stats = sorted(
            [
                {"my_build": k[0], "opp_strat": k[1], "wins": v["wins"],
                 "losses": v["losses"], "total": v["wins"] + v["losses"]}
                for k, v in agg.items() if (v["wins"] + v["losses"]) > 0
            ],
            key=lambda x: x["total"], reverse=True,
        )
        search_txt = self._strat_search_var.get().lower()
        sort_mode = self._strat_sort_var.get()
        if search_txt:
            stats = [
                s
                for s in stats
                if search_txt in s["my_build"].lower() or search_txt in s["opp_strat"].lower()
            ]
        if sort_mode == "Games Played":
            stats.sort(key=lambda x: x["total"], reverse=True)
        elif sort_mode == "Win Rate (High)":
            stats.sort(
                key=lambda x: (x["wins"] / x["total"] if x["total"] > 0 else 0),
                reverse=True,
            )
        elif sort_mode == "Win Rate (Low)":
            stats.sort(
                key=lambda x: (x["wins"] / x["total"] if x["total"] > 0 else 0),
                reverse=False,
            )
        elif sort_mode == "Opponent Strategy":
            stats.sort(key=lambda x: x["opp_strat"])
        elif sort_mode == "My Build":
            stats.sort(key=lambda x: x["my_build"])
        render_limit = 200 if not search_txt else len(stats)

        for item in stats[:render_limit]:
            if item["total"] == 0:
                continue
            wr = int((item["wins"] / item["total"]) * 100)
            color = wr_color(item["wins"], item["total"])
            row = ctk.CTkFrame(self._vs_strat_scroll, fg_color=("gray85", "gray20"))
            row.pack(fill="x", pady=2)
            ctk.CTkLabel(
                row, text=item["my_build"], width=300, anchor="w", font=FONT_SMALL
            ).pack(side="left", padx=5)
            ctk.CTkLabel(row, text="vs", width=50, anchor="center", text_color="gray").pack(
                side="left"
            )
            ctk.CTkLabel(
                row, text=item["opp_strat"], width=300, anchor="w", font=FONT_SMALL
            ).pack(side="left", padx=5)
            ctk.CTkLabel(
                row,
                text=f"{wr}% ({item['wins']}W - {item['losses']}L)",
                width=150,
                anchor="e",
                text_color=color,
                font=("Arial", 11, "bold"),
            ).pack(side="right", padx=10)

    def _render_maps_tab(self) -> None:
        for w in self.tab_maps.winfo_children():
            w.destroy()
        ctk.CTkLabel(self.tab_maps, text="WIN RATE BY MAP", font=FONT_HEADING).pack(pady=10)
        scroll = ctk.CTkScrollableFrame(self.tab_maps)
        scroll.pack(fill="both", expand=True, padx=10, pady=5)
        # Season-aware aggregation.
        map_stats: Dict[str, Dict] = {}
        for bd in self.analyzer.db.values():
            if not isinstance(bd, dict):
                continue
            for g in self._filtered_games(bd.get("games", []) or []):
                m = g.get("map", "Unknown")
                if m not in map_stats:
                    map_stats[m] = {"wins": 0, "losses": 0}
                if g.get("result") == "Win":
                    map_stats[m]["wins"] += 1
                elif g.get("result") == "Loss":
                    map_stats[m]["losses"] += 1
        items = sorted(
            map_stats.items(), key=lambda x: x[1]["wins"] + x[1]["losses"], reverse=True
        )
        for map_name, s in items:
            total = s["wins"] + s["losses"]
            if total == 0:
                continue
            wr = int((s["wins"] / total) * 100)
            color = wr_color(s["wins"], total)
            row = ctk.CTkFrame(scroll, fg_color=("gray85", "gray20"))
            row.pack(fill="x", pady=3, padx=5)
            ctk.CTkLabel(row, text=map_name, font=FONT_BODY, anchor="w", width=250).pack(
                side="left", padx=10, pady=5
            )
            ctk.CTkLabel(
                row,
                text=f"{wr}%  ({s['wins']}W - {s['losses']}L)  -  {total} games",
                text_color=color,
                font=FONT_BODY,
            ).pack(side="right", padx=10, pady=5)

    def _render_matchups_tab(self) -> None:
        for w in self.tab_matchups.winfo_children():
            w.destroy()
        ctk.CTkLabel(
            self.tab_matchups, text="MATCHUP OVERVIEW", font=FONT_HEADING
        ).pack(pady=10)
        # Season-aware aggregation.
        mu_stats: Dict[str, Dict] = {}
        for bd in self.analyzer.db.values():
            if not isinstance(bd, dict):
                continue
            for g in self._filtered_games(bd.get("games", []) or []):
                mu = f"vs {g.get('opp_race', 'Unknown')}"
                if mu not in mu_stats:
                    mu_stats[mu] = {"wins": 0, "losses": 0}
                if g.get("result") == "Win":
                    mu_stats[mu]["wins"] += 1
                elif g.get("result") == "Loss":
                    mu_stats[mu]["losses"] += 1
        frame = ctk.CTkFrame(self.tab_matchups, fg_color="transparent")
        frame.pack(pady=20)
        for i, (mu, s) in enumerate(sorted(mu_stats.items())):
            total = s["wins"] + s["losses"]
            if total == 0:
                continue
            wr = int((s["wins"] / total) * 100)
            color = wr_color(s["wins"], total)
            card = ctk.CTkFrame(
                frame, fg_color=("gray85", "gray20"), width=200, height=100, corner_radius=10
            )
            card.grid(row=0, column=i, padx=15, pady=10)
            card.grid_propagate(False)
            ctk.CTkLabel(card, text=mu, font=FONT_HEADING).pack(pady=(15, 5))
            ctk.CTkLabel(
                card,
                text=f"{wr}%  ({s['wins']}W - {s['losses']}L)",
                text_color=color,
                font=("Arial", 16, "bold"),
            ).pack()

    # ============================================================
    # OPPONENTS TAB  (DNA profile per opponent, ported from
    # SC2Replay-Analyzer's app.py)
    # ============================================================
    def _render_opponents_tab(self) -> None:
        """Build the Opponents tab scaffolding (toolbar + split panes)."""
        for w in self.tab_opponents.winfo_children():
            w.destroy()

        # Toolbar
        toolbar = ctk.CTkFrame(self.tab_opponents, fg_color="transparent")
        toolbar.pack(fill="x", padx=10, pady=(8, 4))
        ctk.CTkButton(
            toolbar, text="Refresh Profiles", command=self._refresh_opp_profiles,
            width=140, fg_color="#1565C0", hover_color="#1976D2",
        ).pack(side="left")
        ctk.CTkLabel(toolbar, text="Search:").pack(side="left", padx=(15, 4))
        search_entry = ctk.CTkEntry(
            toolbar, textvariable=self._opp_search_var,
            placeholder_text="opponent name", width=200,
        )
        search_entry.pack(side="left")
        search_entry.bind("<KeyRelease>", lambda e: self._render_opponents_list())
        ctk.CTkLabel(toolbar, text="Min games:").pack(side="left", padx=(15, 4))
        ctk.CTkOptionMenu(
            toolbar, values=["1", "3", "5", "10", "25"],
            variable=self._opp_min_games_var,
            width=70, command=lambda _: self._render_opponents_list(),
        ).pack(side="left")
        self._opp_summary_lbl = ctk.CTkLabel(toolbar, text="", text_color="gray")
        self._opp_summary_lbl.pack(side="right", padx=10)

        # Body: split into left (list) and right (detail) panes.
        body = ctk.CTkFrame(self.tab_opponents, fg_color="transparent")
        body.pack(fill="both", expand=True, padx=10, pady=5)
        body.grid_columnconfigure(0, weight=1, minsize=300)
        body.grid_columnconfigure(1, weight=3)
        body.grid_rowconfigure(0, weight=1)

        self._opp_list_frame = ctk.CTkScrollableFrame(body, label_text="Opponents")
        self._opp_list_frame.grid(row=0, column=0, sticky="nsew", padx=(0, 6))

        self._opp_detail_frame = ctk.CTkScrollableFrame(body, label_text="Profile")
        self._opp_detail_frame.grid(row=0, column=1, sticky="nsew")

        self._render_opponents_list()
        if self._opp_selected:
            self._render_opponent_profile(self._opp_selected)
        else:
            self._show_empty_profile_hint()

    def _refresh_opp_profiles(self) -> None:
        """Force-rebuild the profiler cache and re-render the tab."""
        prof = self.analyzer.get_profiler()
        if prof is not None:
            try:
                prof.invalidate()
            except Exception:
                pass
        self._render_opponents_tab()
        self.status_lbl.configure(text="Opponent profiles refreshed.")

    def _render_opponents_list(self) -> None:
        """Repaint the left-pane list using current filters/search."""
        if self._opp_list_frame is None:
            return
        for w in self._opp_list_frame.winfo_children():
            w.destroy()
        try:
            min_games = int(self._opp_min_games_var.get() or "1")
        except ValueError:
            min_games = 1
        search = self._opp_search_var.get().strip().lower()

        prof = self.analyzer.get_profiler()
        rows = prof.list_opponents(min_games=min_games, since=self._season_cutoff_iso()) if prof else []
        if search:
            rows = [r for r in rows if search in r["name"].lower()]
        self._opp_summary_lbl.configure(
            text=f"{len(rows)} opponents (min {min_games} games)",
        )

        if not rows:
            ctk.CTkLabel(
                self._opp_list_frame,
                text="No opponents match your filters.",
                text_color="gray",
            ).pack(pady=20)
            return

        # Drop the selection if it's no longer in the filtered set.
        if self._opp_selected is not None and self._opp_selected not in {r["name"] for r in rows}:
            self._opp_selected = None

        # Cap to first 80 to keep the render fast on large DBs; user can
        # narrow with Search / Min games to see more.
        for r in rows[:80]:
            self._build_opponent_row(r)

    def _build_opponent_row(self, row_data: Dict) -> None:
        """One opponent card in the left pane. Click selects."""
        is_selected = row_data["name"] == self._opp_selected
        bg = ("#1f538d", "#1f538d") if is_selected else ("gray85", "gray20")
        card = ctk.CTkFrame(self._opp_list_frame, fg_color=bg, corner_radius=6)
        card.pack(fill="x", pady=2, padx=4)

        total = row_data["total"]
        wins = row_data["wins"]
        losses = row_data["losses"]
        wl_total = wins + losses
        wr = int((wins / wl_total) * 100) if wl_total > 0 else 0
        color = wr_color(wins, wl_total)

        top = ctk.CTkFrame(card, fg_color="transparent")
        top.pack(fill="x", padx=8, pady=(4, 0))
        name_lbl = ctk.CTkLabel(
            top, text=row_data["name"][:32],
            font=("Arial", 12, "bold"), anchor="w",
        )
        name_lbl.pack(side="left")
        badge = ctk.CTkLabel(
            top, text=f"{total}g", width=44,
            fg_color=("#37474F", "#263238"),
            corner_radius=10, font=FONT_SMALL,
        )
        badge.pack(side="right", padx=2)

        bot = ctk.CTkFrame(card, fg_color="transparent")
        bot.pack(fill="x", padx=8, pady=(0, 4))
        ctk.CTkLabel(
            bot, text=f"{wins}W-{losses}L ({wr}%)",
            text_color=color, font=FONT_SMALL, anchor="w",
        ).pack(side="left")
        last_seen = (row_data.get("last_seen") or "")[:10]
        ctk.CTkLabel(
            bot, text=f"last: {last_seen}",
            text_color="gray", font=FONT_SMALL, anchor="e",
        ).pack(side="right")

        def _select(_e=None, n=row_data["name"]):
            self._opp_selected = n
            self._render_opponents_list()
            self._render_opponent_profile(n)

        for w in (card, top, bot, name_lbl, badge):
            w.bind("<Button-1>", _select)

    def _show_empty_profile_hint(self) -> None:
        if self._opp_detail_frame is None:
            return
        for w in self._opp_detail_frame.winfo_children():
            w.destroy()
        ctk.CTkLabel(
            self._opp_detail_frame,
            text="Select an opponent on the left to see their DNA profile.",
            text_color="gray", font=FONT_BODY,
        ).pack(pady=40)

    def _render_opponent_profile(self, name: str) -> None:
        if self._opp_detail_frame is None:
            return
        for w in self._opp_detail_frame.winfo_children():
            w.destroy()

        prof_obj = self.analyzer.get_profiler()
        if prof_obj is None:
            ctk.CTkLabel(
                self._opp_detail_frame,
                text="Profiler unavailable (analytics package missing).",
                text_color=COLOR_LOSS,
            ).pack(pady=30)
            return

        # Pass my_race so the timings grid can run matchup-aware. The
        # race is inferred from the build-name prefixes on this
        # opponent's games (builds are catalogued as "Zerg - ...",
        # "Protoss - ...", "Terran - ..."), which is the only
        # race-of-record stored on the game payload itself today.
        my_race = self._infer_my_race_for_opponent(name)
        since = self._season_cutoff_iso()
        prof = prof_obj.profile(name, my_race=my_race, since=since)
        if prof["total"] == 0:
            ctk.CTkLabel(
                self._opp_detail_frame,
                text=f"No games found for '{name}'.",
                text_color="gray",
            ).pack(pady=30)
            return

        self._render_opp_overview_card(prof)
        self._render_opp_tendencies_card(prof)
        self._render_opp_predicted_card(prof)
        self._render_opp_build_order_card(prof)
        self._render_opp_maps_card(prof)
        self._render_opp_timings_card(prof)
        self._render_opp_last5_card(prof)

    def _render_opp_overview_card(self, prof: Dict) -> None:
        card = ctk.CTkFrame(self._opp_detail_frame, fg_color=("gray85", "gray18"))
        card.pack(fill="x", padx=4, pady=(2, 6))
        ctk.CTkLabel(card, text=prof["name"], font=FONT_TITLE, anchor="w").pack(
            anchor="w", padx=14, pady=(10, 0),
        )
        wl_total = prof["wins"] + prof["losses"]
        wr = int(prof["win_rate"] * 100) if wl_total > 0 else 0
        color = wr_color(prof["wins"], wl_total)
        ctk.CTkLabel(
            card,
            text=f"{prof['total']} games   |   {prof['wins']}W - {prof['losses']}L  ({wr}%)",
            text_color=color, font=FONT_HEADING, anchor="w",
        ).pack(anchor="w", padx=14, pady=(2, 2))
        race_summary = ", ".join(
            f"{race} {count}"
            for race, count in sorted(
                prof["race_distribution"].items(),
                key=lambda kv: -kv[1],
            )
        )
        ctk.CTkLabel(
            card, text=f"Races played: {race_summary or '-'}",
            text_color="gray", font=FONT_SMALL, anchor="w",
        ).pack(anchor="w", padx=14)
        last_seen = (prof.get("last_seen") or "")[:10]
        ctk.CTkLabel(
            card, text=f"Last seen: {last_seen or '-'}",
            text_color="gray", font=FONT_SMALL, anchor="w",
        ).pack(anchor="w", padx=14, pady=(0, 10))

    def _render_opp_tendencies_card(self, prof: Dict) -> None:
        card = ctk.CTkFrame(self._opp_detail_frame, fg_color=("gray85", "gray18"))
        card.pack(fill="x", padx=4, pady=6)
        ctk.CTkLabel(
            card, text="Build Tendencies (top 5 strategies)",
            font=FONT_HEADING, anchor="w",
        ).pack(anchor="w", padx=14, pady=(10, 4))
        top = prof.get("top_strategies") or []
        if not top:
            ctk.CTkLabel(
                card, text="No strategy data yet.", text_color="gray",
            ).pack(padx=14, pady=(0, 10))
            return
        # Plain text bars (no matplotlib needed). Each row: name, share %, W/L.
        total = sum(s["count"] for s in top) or 1
        for s in top:
            wl_t = s["wins"] + s["losses"]
            wr = int((s["wins"] / wl_t) * 100) if wl_t > 0 else 0
            share = int(100 * s["count"] / total)
            row = ctk.CTkFrame(card, fg_color="transparent")
            row.pack(fill="x", padx=14, pady=1)
            ctk.CTkLabel(
                row, text=s["strategy"][:40], width=320, anchor="w", font=FONT_SMALL,
            ).pack(side="left")
            # Share bar
            bar_holder = ctk.CTkFrame(row, fg_color=("gray80", "gray25"),
                                       width=180, height=10, corner_radius=4)
            bar_holder.pack(side="left", padx=8)
            bar_holder.pack_propagate(False)
            fill_w = max(4, int(180 * share / 100))
            ctk.CTkFrame(
                bar_holder, fg_color=COLOR_P1, width=fill_w, height=10,
                corner_radius=4,
            ).place(x=0, y=0)
            ctk.CTkLabel(
                row,
                text=f"{share}%   {s['wins']}W-{s['losses']}L ({wr}%)",
                text_color=wr_color(s["wins"], wl_t), font=FONT_SMALL,
            ).pack(side="right")
        ctk.CTkLabel(card, text="", height=4).pack()

    def _render_opp_predicted_card(self, prof: Dict) -> None:
        """Recency-weighted "what will they do next?" panel."""
        card = ctk.CTkFrame(self._opp_detail_frame, fg_color=("gray85", "gray18"))
        card.pack(fill="x", padx=4, pady=6)
        ctk.CTkLabel(
            card, text="Likely Builds Next Match  (recency-weighted)",
            font=FONT_HEADING, anchor="w",
        ).pack(anchor="w", padx=14, pady=(10, 4))

        prof_obj = self.analyzer.get_profiler()
        try:
            predictions = prof_obj.predict_likely_strategies(prof["name"], since=self._season_cutoff_iso()) if prof_obj else []
        except Exception as exc:
            ctk.CTkLabel(
                card, text=f"Could not compute predictions: {exc}",
                text_color=COLOR_LOSS, font=FONT_SMALL, anchor="w",
            ).pack(anchor="w", padx=14, pady=(0, 10))
            return

        if not predictions:
            ctk.CTkLabel(
                card, text="No prediction data yet.", text_color="gray",
                font=FONT_SMALL, anchor="w",
            ).pack(anchor="w", padx=14, pady=(0, 10))
            return

        strat_wl = {s["strategy"]: (s["wins"], s["losses"]) for s in prof.get("top_strategies", [])}
        ctk.CTkLabel(
            card,
            text="Last 10 games count 2x. Bars = probability, color = your W/L vs that strategy.",
            text_color="gray", font=FONT_SMALL, anchor="w",
        ).pack(anchor="w", padx=14, pady=(0, 6))

        for strat, prob in predictions[:5]:
            row = ctk.CTkFrame(card, fg_color="transparent")
            row.pack(fill="x", padx=14, pady=2)
            label_text = strat if len(strat) <= 38 else strat[:35] + "..."
            ctk.CTkLabel(
                row, text=label_text,
                font=("Arial", 11, "bold"), anchor="w", width=300,
            ).pack(side="left")
            bar_holder = ctk.CTkFrame(
                row, fg_color=("gray80", "gray25"),
                width=240, height=10, corner_radius=4,
            )
            bar_holder.pack(side="left", padx=8)
            bar_holder.pack_propagate(False)
            fill_w = max(4, int(240 * prob))
            ctk.CTkFrame(
                bar_holder, fg_color=COLOR_P1, width=fill_w, height=10,
                corner_radius=4,
            ).place(x=0, y=0)
            wl = strat_wl.get(strat)
            if wl:
                wins, losses = wl
                tot = wins + losses
                wr = int((wins / tot) * 100) if tot > 0 else 0
                ctk.CTkLabel(
                    row,
                    text=f"{int(prob * 100)}%   ({wins}W-{losses}L, {wr}%)",
                    text_color=wr_color(wins, tot), font=FONT_SMALL,
                ).pack(side="right")
            else:
                ctk.CTkLabel(
                    row, text=f"{int(prob * 100)}%",
                    text_color="gray", font=FONT_SMALL,
                ).pack(side="right")
        ctk.CTkLabel(card, text="", height=4).pack()

    def _render_opp_build_order_card(self, prof: Dict) -> None:
        """Per-game build-order timeline, with a dropdown game picker."""
        try:
            from core.sc2_catalog import lookup as catalog_lookup, display_name as catalog_display
        except Exception:
            catalog_lookup = lambda x: None  # noqa: E731
            catalog_display = lambda x: x  # noqa: E731

        card = ctk.CTkFrame(self._opp_detail_frame, fg_color=("gray85", "gray18"))
        card.pack(fill="x", padx=4, pady=6)
        ctk.CTkLabel(
            card, text="Build Order Timeline  (per-game)",
            font=FONT_HEADING, anchor="w",
        ).pack(anchor="w", padx=14, pady=(10, 4))

        prof_obj = self.analyzer.get_profiler()
        try:
            games = prof_obj._games_for(prof["name"], since=self._season_cutoff_iso()) if prof_obj else []
        except Exception:
            games = []
        recent = sorted(games, key=lambda g: g.get("date", "") or "", reverse=True)[:25]

        if not recent:
            ctk.CTkLabel(
                card, text="No games on file.", text_color="gray", font=FONT_SMALL,
            ).pack(padx=14, pady=(0, 10))
            return

        ctk.CTkLabel(
            card,
            text="Pick a game to expand its full build order. "
                 "Dot color = race, chip = category.",
            text_color="gray", font=FONT_SMALL, anchor="w",
        ).pack(anchor="w", padx=14)

        picker_row = ctk.CTkFrame(card, fg_color="transparent")
        picker_row.pack(fill="x", padx=14, pady=(4, 4))

        labels: List[str] = []
        game_index: Dict[str, Dict] = {}
        for g in recent:
            date_s = (g.get("date") or "")[:10]
            mp = (g.get("map") or "?")[:24]
            res = g.get("result", "?")
            label = f"{date_s} | {mp} | {res}"
            if label in game_index:
                label = f"{label}  ({(g.get('id') or '')[-6:]})"
            labels.append(label)
            game_index[label] = g

        bo_holder = ctk.CTkFrame(card, fg_color="transparent")
        bo_holder.pack(fill="x", padx=14, pady=(0, 10))

        race_dot_colors = {
            "Protoss": "#FBBF24", "Terran": "#60A5FA",
            "Zerg": "#C084FC",   "Neutral": "#9AA3B2",
        }
        import re as _re
        timing_re = _re.compile(r"^\[(\d+):(\d{2})\]\s+(.+?)\s*$")

        def render_bo(game: Dict):
            for w in bo_holder.winfo_children():
                w.destroy()
            # In the OPPONENT card, the user wants to see the OPPONENT's
            # build order. Prefer opp_build_log when persisted; fall back
            # to opp_early_build_log; fall back to the user's build_log
            # only if no opponent log was captured (legacy games).
            opp_log = game.get("opp_build_log") or game.get("opp_early_build_log") or []
            my_log = game.get("build_log") or []
            using_opp = bool(opp_log)
            log = opp_log if using_opp else my_log
            label_txt = (
                f"OPPONENT'S build order ({len(log)} milestones)"
                if using_opp
                else "YOUR build order (opponent's not captured for this game)"
            )
            ctk.CTkLabel(
                bo_holder, text=label_txt,
                text_color=("#3ddc97" if using_opp else "gray"),
                font=FONT_SMALL, anchor="w",
            ).pack(anchor="w", pady=(0, 4))
            if not log:
                ctk.CTkLabel(
                    bo_holder, text="(no build_log on this game)",
                    text_color="gray", font=FONT_SMALL,
                ).pack(anchor="w")
                return
            inner = ctk.CTkScrollableFrame(bo_holder, height=260)
            inner.pack(fill="x")
            for line in log:
                m = timing_re.match(line)
                if not m:
                    continue
                mm, ss, raw = int(m.group(1)), int(m.group(2)), m.group(3)
                entry = catalog_lookup(raw)
                race = entry.race if entry else "Neutral"
                cat = entry.category if entry else "unknown"
                disp = catalog_display(raw)
                row = ctk.CTkFrame(inner, fg_color=("gray90", "gray22"))
                row.pack(fill="x", pady=1, padx=2)
                ctk.CTkLabel(
                    row, text=f"{mm}:{ss:02d}", width=46,
                    font=("Consolas", 11), anchor="w", text_color="gray",
                ).pack(side="left", padx=(6, 4))
                ctk.CTkLabel(
                    row, text="●", width=14,
                    text_color=race_dot_colors.get(race, race_dot_colors["Neutral"]),
                    font=("Arial", 14),
                ).pack(side="left")
                ctk.CTkLabel(
                    row, text=disp, font=("Arial", 11), anchor="w",
                ).pack(side="left", padx=4, fill="x", expand=True)
                ctk.CTkLabel(
                    row, text=cat, font=("Arial", 9),
                    text_color="gray", width=70, anchor="e",
                ).pack(side="right", padx=6)

        def on_pick(label: str):
            g = game_index.get(label)
            if g:
                render_bo(g)

        if labels:
            picker = ctk.CTkOptionMenu(
                picker_row, values=labels, command=on_pick, width=460,
            )
            picker.pack(side="left")
            picker.set(labels[0])
            render_bo(game_index[labels[0]])

    def _render_opp_maps_card(self, prof: Dict) -> None:
        card = ctk.CTkFrame(self._opp_detail_frame, fg_color=("gray85", "gray18"))
        card.pack(fill="x", padx=4, pady=6)
        ctk.CTkLabel(
            card, text="Map Performance",
            font=FONT_HEADING, anchor="w",
        ).pack(anchor="w", padx=14, pady=(10, 4))
        rows = prof.get("map_performance") or []
        if not rows:
            ctk.CTkLabel(card, text="No map data.", text_color="gray").pack(
                padx=14, pady=(0, 10),
            )
            return
        hdr = ctk.CTkFrame(card, fg_color="transparent")
        hdr.pack(fill="x", padx=14)
        for text, w, anchor in (
            ("Map", 260, "w"), ("Games", 60, "e"),
            ("W-L", 80, "e"), ("Win Rate", 90, "e"),
        ):
            ctk.CTkLabel(
                hdr, text=text, anchor=anchor, width=w,
                font=("Arial", 11, "bold"),
            ).pack(side="left")
        for m in rows[:12]:
            row = ctk.CTkFrame(card, fg_color="transparent")
            row.pack(fill="x", padx=14, pady=1)
            wr_pct = int((m["wins"] / m["total"]) * 100) if m["total"] > 0 else 0
            color = wr_color(m["wins"], m["total"])
            ctk.CTkLabel(
                row, text=m["map"][:34], anchor="w", width=260, font=FONT_SMALL,
            ).pack(side="left")
            ctk.CTkLabel(
                row, text=str(m["total"]), anchor="e", width=60, font=FONT_SMALL,
            ).pack(side="left")
            ctk.CTkLabel(
                row, text=f"{m['wins']}-{m['losses']}", anchor="e",
                width=80, font=FONT_SMALL,
            ).pack(side="left")
            ctk.CTkLabel(
                row, text=f"{wr_pct}%", anchor="e", width=90,
                text_color=color, font=FONT_SMALL,
            ).pack(side="left")
        ctk.CTkLabel(card, text="", height=4).pack()

    # ====================================================================
    # Median key timings - matchup-aware card grid (TIMING_CARDS_PATCH_V1)
    # ====================================================================
    #
    # Mirrors the SPA `MedianTimingsGrid` (the ``analyzer/index.html``
    # React component) and the SC2Replay-Analyzer desktop port. The card
    # body, source filter, drilldown modal, and tooltip wiring all live
    # in this section so the rest of the Opponents tab stays untouched.
    # ====================================================================

    # Trend glyph + accent color, matching the SPA's TREND_GLYPHS table so
    # the desktop and web visuals stay in lockstep when a user has both
    # open side-by-side.
    _TIMING_TREND_GLYPHS = {
        "later":   {"glyph": "▲", "label": "trending later",   "color": "#F79E6C"},
        "earlier": {"glyph": "▼", "label": "trending earlier", "color": "#3DDC97"},
        "stable":  {"glyph": "–", "label": "stable",           "color": "#9AA3B2"},
        "unknown": {"glyph": "·", "label": "not enough data",  "color": "#5D6677"},
    }

    @staticmethod
    def _wr_pill_color(rate: Optional[float], n: int) -> str:
        """Win-rate-when-built pill color. Greys out the no-confidence case."""
        if rate is None or not n:
            return "#5D6677"
        if rate >= 0.6:
            return "#3DDC97"
        if rate >= 0.4:
            return "#F4C95D"
        return "#EF476F"

    def _infer_my_race_for_opponent(self, opp_name: str) -> str:
        """Return the user's modal race across this opponent's games.

        Build names in this app are catalogued by race prefix
        (``"Zerg - 12 Pool"``, ``"Protoss - Stargate Opener"``,
        ``"Terran - 1-1-1 Standard"``), so the modal prefix is a reliable
        proxy for the user's race when the per-game payload doesn't carry
        ``my_race`` directly. Returns ``""`` if the games have no race-
        prefixed builds (which keeps timings empty rather than guessing).
        """
        from collections import Counter
        try:
            prof_obj = self.analyzer.get_profiler()
            games = prof_obj._games_for(opp_name) if prof_obj else []  # noqa: SLF001
        except Exception:
            return ""
        counts: Counter = Counter()
        # Builds in this app are catalogued under one of two prefix
        # conventions, both of which encode the user's race in the head
        # of the build name:
        #   * race-prefixed   "Zerg - 12 Pool" / "Protoss - Stargate Opener"
        #   * matchup-prefixed "PvT - Phoenix into Robo" / "ZvP - 17 Hatch"
        # We resolve both: the explicit race prefix wins, then the first
        # letter of a matchup prefix (which is always the user's race).
        for g in games or []:
            bn = (g.get("my_build") or "").strip()
            if not bn:
                continue
            head = bn.split(" - ", 1)[0]
            head_lower = head.lower()
            if head_lower.startswith("zerg"):
                counts["Z"] += 1
            elif head_lower.startswith("protoss"):
                counts["P"] += 1
            elif head_lower.startswith("terran"):
                counts["T"] += 1
            elif len(head) >= 2 and head[1] in ("v", "V") and head[0].upper() in ("P", "T", "Z"):
                counts[head[0].upper()] += 1
            else:
                first = head[:1].upper()
                if first in ("P", "T", "Z") and (len(head) == 1 or not head[1].isalpha()):
                    counts[first] += 1
        if not counts:
            return ""
        return counts.most_common(1)[0][0]

    def _building_icon_path(self, icon_file: str) -> Optional[str]:
        """Resolve ``icon_file`` against ``ICONS_DIR/buildings``, if reachable."""
        if not ICONS_DIR or not icon_file:
            return None
        candidate = os.path.join(ICONS_DIR, "buildings", icon_file)
        return candidate if os.path.exists(candidate) else None

    def _get_timing_icon(
        self, internal_name: str, icon_file: str
    ) -> Optional["ctk.CTkImage"]:
        """Return a cached 40x40 CTkImage for this token, or None on failure.

        Process-lifetime cache; failures (missing file, Pillow not
        installed, decode error) are memoised as ``None`` so we don't
        retry the file system on every re-render.
        """
        cache = self._timing_icon_cache
        if internal_name in cache:
            return cache[internal_name]

        path = self._building_icon_path(icon_file)
        if not path:
            cache[internal_name] = None
            return None

        try:
            from PIL import Image  # Pillow is already a dep in this app
            img = Image.open(path).convert("RGBA")
            ck_img = ctk.CTkImage(light_image=img, dark_image=img, size=(40, 40))
        except Exception as exc:
            try:
                logger = getattr(self.analyzer, "error_logger", None)
                if logger is not None:
                    logger.errors.append({
                        "file": path,
                        "error": f"timing icon load failed: {exc}",
                    })
            except Exception:
                pass
            ck_img = None
        cache[internal_name] = ck_img
        return ck_img

    def _active_matchup_for_opp(self, opp_name: str, available: List[str]) -> str:
        """Return the persisted matchup chip for this opponent, or "All".

        Falls back to "All" if the persisted value isn't in ``available``
        (e.g. the chip was valid before but the matchup has since dropped
        out under the season filter).
        """
        per_opp = self._opp_ui_state.setdefault("per_opp", {})
        bucket = per_opp.setdefault(opp_name, {})
        chosen = str(bucket.get("matchup") or "All")
        if chosen != "All" and chosen not in available:
            chosen = "All"
            bucket["matchup"] = chosen
        return chosen

    def _set_active_matchup_for_opp(self, opp_name: str, matchup: str) -> None:
        per_opp = self._opp_ui_state.setdefault("per_opp", {})
        per_opp.setdefault(opp_name, {})["matchup"] = matchup or "All"

    def _matchup_chip_labels(self, prof: Dict) -> List[Tuple[str, int]]:
        """Return ``[(label, count), ...]`` chip data sorted by count desc."""
        counts = prof.get("matchup_counts") or {}
        if not isinstance(counts, dict) or not counts:
            return []
        return sorted(counts.items(), key=lambda kv: (-kv[1], kv[0]))

    def _profile_for_matchup(
        self, prof: Dict, opp_name: str, matchup: str,
    ) -> Dict:
        """Return a profile dict whose timings are filtered to ``matchup``.

        ``matchup == "All"`` returns ``prof`` unchanged. For a specific
        label like ``"PvZ"`` we re-run
        ``OpponentProfiler._compute_median_timings_for_matchup`` over
        that opponent's games and splice the result into a shallow copy
        of ``prof`` so the rest of the rendering pipeline (which reads
        ``median_timings`` / ``median_timings_order`` / ``matchup_label``
        without caring how they were derived) Just Works.
        """
        if not matchup or matchup == "All":
            return prof

        from analytics.opponent_profiler import OpponentProfiler

        my_race = prof.get("my_race") or self._infer_my_race_for_opponent(opp_name)
        opp_race = (matchup[-1:] or "").upper()

        try:
            prof_obj = self.analyzer.get_profiler()
            since = self._season_cutoff_iso()
            games = (
                prof_obj._games_for(opp_name, since=since)  # noqa: SLF001
                if prof_obj else []
            )
        except Exception:
            games = []

        try:
            t = OpponentProfiler._compute_median_timings_for_matchup(
                games, my_race, opp_race,
            )
        except Exception:
            t = {}

        out = dict(prof)
        out["median_timings"] = t
        out["median_timings_order"] = list(t.keys())
        out["matchup_label"] = matchup
        return out

    def _render_opp_timings_card(self, prof: Dict) -> None:
        """Render the matchup-aware Median Key Timings grid for an opponent.

        Reads ``prof.median_timings`` / ``median_timings_order`` /
        ``matchup_label`` / ``matchup_counts`` from the upgraded
        ``OpponentProfiler``. The matchup chip row sits above the
        source-filter chips; selecting a specific matchup re-runs
        ``_compute_median_timings_for_matchup`` over the games filtered
        to that matchup. The "All" chip remains the default and uses the
        modal opponent race for ordering, exactly like before.
        """
        ml = prof.get("matchup_label") or ""
        opp_name = prof.get("name") or ""

        card = ctk.CTkFrame(self._opp_detail_frame, fg_color=("gray85", "gray18"))
        card.pack(fill="x", padx=4, pady=6)
        title_text = (
            f"Median Key Timings - {ml}" if ml else "Median Key Timings"
        )
        ctk.CTkLabel(
            card, text=title_text, font=FONT_HEADING, anchor="w",
        ).pack(anchor="w", padx=14, pady=(10, 4))
        ctk.CTkLabel(
            card,
            text="Opponent tech parsed from opp_build_log; your tech from build_log.",
            text_color="gray", font=FONT_SMALL, anchor="w",
        ).pack(anchor="w", padx=14, pady=(0, 4))

        # ---- Matchup chips ("All  PvZ (8)  PvT (3) ...") ---------------
        # Only render when 2+ matchups are present. A single-matchup
        # opponent doesn't need a selector. Lives ABOVE the source-filter
        # chips so it reads as the primary scoping control.
        chips = self._matchup_chip_labels(prof)
        active = self._active_matchup_for_opp(opp_name, [m for m, _ in chips])
        if len(chips) >= 2:
            chip_row1 = ctk.CTkFrame(card, fg_color="transparent")
            chip_row1.pack(fill="x", padx=14, pady=(0, 4))
            ctk.CTkLabel(
                chip_row1, text="Matchup:",
                font=FONT_SMALL, text_color="gray",
            ).pack(side="left", padx=(0, 6))

            values = ["All"] + [f"{m} ({n})" for m, n in chips]
            display_to_raw = {"All": "All"}
            for m, n in chips:
                display_to_raw[f"{m} ({n})"] = m
            raw_to_display = {v: k for k, v in display_to_raw.items()}
            current_display = raw_to_display.get(active, "All")
            mu_var = ctk.StringVar(value=current_display)

            def _on_matchup_change(choice: str) -> None:
                raw = display_to_raw.get(choice, "All")
                self._set_active_matchup_for_opp(opp_name, raw)
                new_prof = self._profile_for_matchup(prof, opp_name, raw)
                self._timing_grid_state["matchup_label"] = (
                    new_prof.get("matchup_label") or ""
                )
                self._timing_grid_state["order"] = list(
                    new_prof.get("median_timings_order") or []
                )
                self._render_timing_grid_body(
                    grid_holder, new_prof,
                    str(self._opp_ui_state.get("timing_source_filter") or "Both"),
                )

            ctk.CTkSegmentedButton(
                chip_row1,
                values=values,
                variable=mu_var,
                command=_on_matchup_change,
            ).pack(side="left")

        view_prof = self._profile_for_matchup(prof, opp_name, active)

        # ---- Source-filter chips (Both / Opp tech / Your tech) ---------
        chip_row = ctk.CTkFrame(card, fg_color="transparent")
        chip_row.pack(fill="x", padx=14, pady=(0, 6))
        ctk.CTkLabel(
            chip_row, text="Show:", font=FONT_SMALL, text_color="gray",
        ).pack(side="left", padx=(0, 6))

        current = str(self._opp_ui_state.get("timing_source_filter") or "Both")
        if current not in ("Both", "Opp tech", "Your tech"):
            current = "Both"

        seg_var = ctk.StringVar(value=current)

        def _on_filter_change(choice: str) -> None:
            self._opp_ui_state["timing_source_filter"] = choice
            mu = self._active_matchup_for_opp(opp_name, [m for m, _ in chips])
            local_prof = self._profile_for_matchup(prof, opp_name, mu)
            self._render_timing_grid_body(grid_holder, local_prof, choice)

        ctk.CTkSegmentedButton(
            chip_row,
            values=["Both", "Opp tech", "Your tech"],
            variable=seg_var,
            command=_on_filter_change,
        ).pack(side="left")

        # ---- Live summary line (matches the SPA's aria-live status) ----
        summary_lbl = ctk.CTkLabel(
            card, text="", font=FONT_SMALL, text_color="gray", anchor="w",
        )
        summary_lbl.pack(anchor="w", padx=14, pady=(0, 4))
        self._timing_grid_state["summary_lbl"] = summary_lbl
        self._timing_grid_state["order"] = list(
            view_prof.get("median_timings_order") or []
        )
        self._timing_grid_state["matchup_label"] = view_prof.get("matchup_label") or ""
        self._timing_grid_state["opp_name"] = opp_name
        self._timing_grid_state["matchup_counts"] = prof.get("matchup_counts") or {}
        self._timing_grid_state["active_matchup"] = active

        grid_holder = ctk.CTkScrollableFrame(
            card, height=320, fg_color=("gray80", "gray18"),
        )
        grid_holder.pack(fill="both", expand=True, padx=10, pady=(2, 10))

        self._render_timing_grid_body(grid_holder, view_prof, current)

    def _render_timing_grid_body(
        self,
        grid_holder: "ctk.CTkScrollableFrame",
        prof: Dict,
        source_filter: str,
    ) -> None:
        """Populate the card grid honoring the active source filter."""
        for w in grid_holder.winfo_children():
            w.destroy()

        timings: Dict[str, Dict] = prof.get("median_timings") or {}
        order: List[str] = list(prof.get("median_timings_order") or [])
        ml = prof.get("matchup_label") or ""
        opp_name = prof.get("name") or ""

        def _passes(info: Dict) -> bool:
            src = info.get("source") or ""
            if source_filter == "Opp tech":
                return src == "opp_build_log"
            if source_filter == "Your tech":
                return src == "build_log"
            return True

        visible: List[str] = [
            tok for tok in order
            if tok in timings and _passes(timings[tok])
        ]

        # Refresh the live summary line. When a specific matchup is
        # active, surface "(N games)" alongside the matchup label so the
        # user knows the sample count behind the chip selection.
        summary_lbl = self._timing_grid_state.get("summary_lbl")
        if summary_lbl is not None:
            suffix = ""
            if source_filter == "Opp tech":
                suffix = " - opponent tech only"
            elif source_filter == "Your tech":
                suffix = " - your tech only"
            active = str(self._timing_grid_state.get("active_matchup") or "All")
            counts = self._timing_grid_state.get("matchup_counts") or {}
            mu_suffix = ""
            if active != "All" and isinstance(counts, dict) and counts.get(active):
                n = counts[active]
                mu_suffix = f" ({n} game{'s' if n != 1 else ''})"
            if ml:
                txt = (
                    f"Showing {len(visible)} of {len(order)} timings "
                    f"for {ml}{mu_suffix}{suffix}"
                )
            else:
                txt = f"Showing {len(visible)} of {len(order)} timings{suffix}"
            try:
                summary_lbl.configure(text=txt)
            except Exception:
                pass

        # Empty state - only fires when EVERY visible card has zero
        # samples after filtering, matching the prompt's contract.
        all_empty = all(
            (timings.get(tok, {}) or {}).get("sample_count", 0) == 0
            for tok in visible
        )
        if not visible or all_empty:
            ctk.CTkLabel(
                grid_holder,
                text="(no key building timings yet)",
                text_color="gray", font=FONT_SMALL,
            ).pack(pady=12, padx=10)
            return

        CARD_MIN_W = 200
        CARD_PAD = 6

        tok_lookup: Dict[str, TimingToken] = {}
        for tokens in RACE_BUILDINGS.values():
            for t in tokens:
                tok_lookup[t.internal_name] = t

        cards: List[tk.Widget] = []
        for internal_name in visible:
            info = timings.get(internal_name) or {}
            tok = tok_lookup.get(internal_name)
            try:
                card = self._build_timing_card(
                    grid_holder, internal_name, info, tok, opp_name, ml,
                )
                cards.append(card)
            except Exception as exc:
                # Log-and-skip: a single malformed token must never take
                # down the whole grid.
                try:
                    logger = getattr(self.analyzer, "error_logger", None)
                    if logger is not None:
                        logger.errors.append({
                            "file": f"timing-card:{internal_name}",
                            "error": f"render failed: {exc}",
                        })
                except Exception:
                    pass

        def _relayout(_event: object = None) -> None:
            try:
                width = max(1, grid_holder.winfo_width())
            except tk.TclError:
                return
            cols = max(1, width // (CARD_MIN_W + CARD_PAD))
            for idx, card in enumerate(cards):
                r, c = divmod(idx, cols)
                try:
                    card.grid(
                        row=r, column=c,
                        padx=CARD_PAD, pady=CARD_PAD, sticky="nsew",
                    )
                except tk.TclError:
                    continue
            for c in range(cols):
                grid_holder.grid_columnconfigure(c, weight=1, uniform="tcards")
            for c in range(cols, cols + 6):
                grid_holder.grid_columnconfigure(c, weight=0, uniform="")

        _relayout()
        grid_holder.bind("<Configure>", _relayout)

    def _build_timing_card(
        self,
        parent: "ctk.CTkScrollableFrame",
        internal_name: str,
        info: Dict,
        tok: Optional[TimingToken],
        opp_name: str,
        matchup_label_str: str,
    ) -> "ctk.CTkFrame":
        """Construct a single timing card. Returns the unparented frame."""
        sample_count = int(info.get("sample_count") or 0)
        empty = sample_count == 0

        bg = ("gray82", "gray23") if not empty else ("gray80", "gray19")
        card = ctk.CTkFrame(parent, fg_color=bg, corner_radius=8)

        top = ctk.CTkFrame(card, fg_color="transparent")
        top.pack(fill="x", padx=10, pady=(8, 2))

        icon_img = None
        if tok is not None:
            icon_img = self._get_timing_icon(internal_name, tok.icon_file)

        if icon_img is not None:
            ctk.CTkLabel(top, text="", image=icon_img).pack(side="left", padx=(0, 8))
        else:
            ctk.CTkFrame(
                top, width=40, height=40, fg_color=("gray75", "gray30"),
                corner_radius=4,
            ).pack(side="left", padx=(0, 8))

        text_col = ctk.CTkFrame(top, fg_color="transparent")
        text_col.pack(side="left", fill="x", expand=True)

        display_name = tok.display_name if tok is not None else internal_name
        ctk.CTkLabel(
            text_col, text=display_name, font=FONT_BOLD, anchor="w",
            text_color=("gray20", "gray90") if not empty else ("gray45", "gray55"),
        ).pack(anchor="w")

        median_display = info.get("median_display") or "-"
        ctk.CTkLabel(
            text_col,
            text=median_display,
            font=FONT_LARGE, anchor="w",
            text_color=(
                ("#1a1a1a", "#F2F4F8") if not empty
                else ("gray55", "gray45")
            ),
        ).pack(anchor="w", pady=(2, 0))

        sub_text = ""
        if not empty:
            p25 = info.get("p25_display") or "-"
            p75 = info.get("p75_display") or "-"
            if sample_count >= 2 and p25 != "-" and p75 != "-":
                sub_text = f"{p25}-{p75}"
            else:
                sub_text = "single sample"
        ctk.CTkLabel(
            card,
            text=sub_text,
            font=FONT_SMALL, text_color="gray", anchor="w",
        ).pack(anchor="w", padx=10, pady=(0, 0))

        if empty:
            ctk.CTkLabel(
                card,
                text="no samples in this matchup",
                font=FONT_SMALL, text_color="gray", anchor="w",
            ).pack(anchor="w", padx=10, pady=(0, 0))

        bot = ctk.CTkFrame(card, fg_color="transparent")
        bot.pack(fill="x", padx=10, pady=(4, 8))

        ctk.CTkLabel(
            bot, text=f"n={sample_count}",
            font=FONT_SMALL, text_color="gray", anchor="w",
        ).pack(side="left")

        if not empty:
            wr = info.get("win_rate_when_built")
            wr_pct = (
                f"{int(round(wr * 100))}%" if isinstance(wr, (int, float))
                else "-"
            )
            wr_color_hex = self._wr_pill_color(
                wr if isinstance(wr, (int, float)) else None, sample_count
            )
            ctk.CTkLabel(
                bot, text=wr_pct,
                font=FONT_SMALL, text_color="white",
                fg_color=wr_color_hex, corner_radius=8,
                width=44, height=18,
            ).pack(side="left", padx=(8, 0))

        trend = self._TIMING_TREND_GLYPHS.get(
            info.get("trend") or "unknown",
            self._TIMING_TREND_GLYPHS["unknown"],
        )
        ctk.CTkLabel(
            bot,
            text=trend["glyph"],
            font=FONT_BOLD,
            text_color=trend["color"],
        ).pack(side="right")

        # ---- Tooltip ---------------------------------------------------
        if empty:
            tip_text = (
                "No samples in this matchup\n"
                + (
                    "opponent's structures (sc2reader)"
                    if (info.get("source") or "") == "opp_build_log"
                    else "your build (proxy for matchup tendencies)"
                )
            )
        else:
            mn = info.get("min_display") or "-"
            mx = info.get("max_display") or "-"
            ls = info.get("last_seen_display") or "-"
            src_label = (
                "opponent's structures (sc2reader)"
                if (info.get("source") or "") == "opp_build_log"
                else "your build (proxy for matchup tendencies)"
            )
            tip_text = (
                f"range {mn}-{mx}\n"
                f"last seen at {ls}\n"
                f"{src_label}\n"
                f"n={sample_count} matchup samples"
            )
        Tooltip(card, text=tip_text)

        # ---- Click + keyboard to drill down ---------------------------
        if not empty:
            def _on_click(_event: object = None) -> str:
                self._open_timing_drilldown(
                    internal_name, tok, info, opp_name, matchup_label_str,
                )
                return "break"

            def _on_focus_in(_event: object = None) -> None:
                self._card_focus_visible(card, on=True)

            def _on_focus_out(_event: object = None) -> None:
                self._card_focus_visible(card, on=False)

            for w in (card, top, text_col, bot):
                try:
                    w.bind("<Button-1>", _on_click, add="+")
                except Exception:
                    pass
            try:
                card.configure(cursor="hand2")
                card.configure(takefocus=True)
                card.bind("<Return>", _on_click, add="+")
                card.bind("<space>",  _on_click, add="+")
                card.bind("<FocusIn>",  _on_focus_in,  add="+")
                card.bind("<FocusOut>", _on_focus_out, add="+")
            except Exception:
                pass

        return card

    @staticmethod
    def _card_focus_visible(card: "ctk.CTkFrame", on: bool) -> None:
        """Toggle a visible focus halo on a timing card."""
        try:
            if on:
                card.configure(fg_color=("gray72", "gray30"), border_width=2,
                               border_color="#42A5F5")
            else:
                card.configure(fg_color=("gray82", "gray23"), border_width=0)
        except Exception:
            pass

    # ------------------------------------------------------------------
    # Drilldown modal: lists every contributing game. Matches the
    # CTkToplevel pattern used elsewhere in this file (Visualizer window,
    # macro breakdown, debug log) so we don't introduce a new framework.
    # ------------------------------------------------------------------
    def _open_timing_drilldown(
        self,
        internal_name: str,
        tok: Optional[TimingToken],
        info: Dict,
        opp_name: str,
        matchup_label_str: str,
    ) -> None:
        sample_count = int(info.get("sample_count") or 0)
        if sample_count == 0:
            return  # Defensive: empty cards already gate this on the binding.

        display_name = tok.display_name if tok is not None else internal_name

        t = ctk.CTkToplevel(self)
        t.geometry("680x640")
        t.title(f"{display_name} - timings vs {opp_name}")
        t.transient(self)
        t.lift()
        t.after(150, t.focus_force)
        try:
            t.grab_set()
        except Exception:
            pass

        head = ctk.CTkFrame(t, fg_color=("gray85", "gray18"))
        head.pack(fill="x", padx=12, pady=(12, 6))

        head_top = ctk.CTkFrame(head, fg_color="transparent")
        head_top.pack(fill="x", padx=10, pady=(8, 2))

        if tok is not None:
            icon_img = self._get_timing_icon(internal_name, tok.icon_file)
            if icon_img is not None:
                ctk.CTkLabel(head_top, text="", image=icon_img).pack(
                    side="left", padx=(0, 10)
                )

        ctk.CTkLabel(
            head_top, text=display_name, font=FONT_TITLE, anchor="w",
        ).pack(side="left")

        sub_bits: List[str] = []
        if matchup_label_str:
            sub_bits.append(matchup_label_str)
        sub_bits.append(f"n={sample_count}")
        sub_bits.append(f"median {info.get('median_display') or '-'}")
        if sample_count >= 2:
            p25 = info.get("p25_display") or "-"
            p75 = info.get("p75_display") or "-"
            if p25 != "-" and p75 != "-":
                sub_bits.append(f"({p25}-{p75})")
            mn = info.get("min_display") or "-"
            mx = info.get("max_display") or "-"
            if mn != "-" and mx != "-":
                sub_bits.append(f"range {mn}-{mx}")
        ctk.CTkLabel(
            head, text=" · ".join(sub_bits),
            font=FONT_SMALL, text_color="gray", anchor="w",
        ).pack(anchor="w", padx=10, pady=(0, 6))

        src_label = (
            "opponent's structures (sc2reader)"
            if (info.get("source") or "") == "opp_build_log"
            else "your build (proxy for matchup tendencies)"
        )
        ctk.CTkLabel(
            head, text=f"{src_label} · sorted newest first",
            font=FONT_SMALL, text_color="gray", anchor="w",
        ).pack(anchor="w", padx=10, pady=(0, 8))

        # Body: lazy chunked rendering so opponents with hundreds of
        # contributing games don't make the modal hitch on open.
        body = ctk.CTkScrollableFrame(t)
        body.pack(fill="both", expand=True, padx=12, pady=4)

        rows = self._collect_timing_drilldown_rows(internal_name, opp_name)
        if not rows:
            ctk.CTkLabel(
                body,
                text="No contributing games found in the current DB.",
                text_color="gray", font=FONT_SMALL,
            ).pack(pady=20)
        else:
            state = {"rendered": 0}
            load_more_btn_holder: List[Optional["ctk.CTkButton"]] = [None]

            def _render_next_chunk() -> None:
                start = state["rendered"]
                end = min(start + self._DRILLDOWN_CHUNK, len(rows))
                for i in range(start, end):
                    self._render_timing_drilldown_row(body, rows[i])
                state["rendered"] = end
                btn = load_more_btn_holder[0]
                if btn is not None:
                    if state["rendered"] >= len(rows):
                        try:
                            btn.destroy()
                        except Exception:
                            pass
                        load_more_btn_holder[0] = None
                    else:
                        remaining = len(rows) - state["rendered"]
                        next_n = min(self._DRILLDOWN_CHUNK, remaining)
                        try:
                            btn.configure(
                                text=(
                                    f"Load next {next_n} "
                                    f"({state['rendered']}/{len(rows)} shown)"
                                )
                            )
                        except Exception:
                            pass

            _render_next_chunk()
            if state["rendered"] < len(rows):
                remaining = len(rows) - state["rendered"]
                next_n = min(self._DRILLDOWN_CHUNK, remaining)
                load_more_btn_holder[0] = ctk.CTkButton(
                    body,
                    text=f"Load next {next_n} ({state['rendered']}/{len(rows)} shown)",
                    fg_color="transparent", border_width=1,
                    text_color="gray", height=28,
                    command=_render_next_chunk,
                )
                load_more_btn_holder[0].pack(fill="x", padx=4, pady=(8, 4))

        # Footer: Copy-to-clipboard (Markdown table) + Close. The export
        # uses the ENTIRE rows list, not just the rows currently painted
        # into the body, so the user always gets the complete data set.
        footer = ctk.CTkFrame(t, fg_color="transparent")
        footer.pack(fill="x", padx=12, pady=(4, 12))

        copy_btn_label = ctk.StringVar(value="Copy timings to clipboard")

        def _copy_to_clipboard() -> None:
            md = self._format_drilldown_markdown(
                display_name, info, rows, matchup_label_str,
            )
            try:
                t.clipboard_clear()
                t.clipboard_append(md)
                t.update()
            except Exception:
                pass
            copy_btn_label.set("Copied!")
            t.after(1400, lambda: copy_btn_label.set("Copy timings to clipboard"))

        ctk.CTkButton(
            footer, textvariable=copy_btn_label, width=200,
            fg_color="transparent", border_width=1, text_color="gray",
            command=_copy_to_clipboard,
        ).pack(side="left")
        ctk.CTkButton(
            footer, text="Close", width=120, command=t.destroy,
        ).pack(side="right")

    def _collect_timing_drilldown_rows(
        self, internal_name: str, opp_name: str,
    ) -> List[Dict]:
        """Return one row per contributing game, sorted newest first.

        Mirrors the per-token resolution rule used by the build-order
        viewer card: opponent-race tokens come from ``opp_build_log``
        (or the legacy ``opp_early_build_log`` fallback used elsewhere
        in this file), user's-race tokens come from ``build_log``.
        """
        from analytics.opponent_profiler import _TIMING_RE

        try:
            prof_obj = self.analyzer.get_profiler()
            games = (
                prof_obj._games_for(  # noqa: SLF001
                    opp_name, since=self._season_cutoff_iso(),
                )
                if prof_obj else []
            )
        except Exception:
            return []

        tok: Optional[TimingToken] = None
        own_race = ""
        for race, tokens in RACE_BUILDINGS.items():
            for t in tokens:
                if t.internal_name == internal_name:
                    tok = t
                    own_race = race
                    break
            if tok is not None:
                break
        if tok is None:
            return []

        my_race = self._infer_my_race_for_opponent(opp_name)
        is_my_token = (own_race == normalize_race(my_race))
        tok_lower = tok.token.lower()

        rows: List[Dict] = []
        for g in games or []:
            if is_my_token:
                log = g.get("build_log") or []
            else:
                # Match the build-order viewer's source-resolution rule:
                # prefer opp_build_log; fall back to opp_early_build_log
                # (legacy field) before giving up.
                log = (
                    g.get("opp_build_log")
                    or g.get("opp_early_build_log")
                    or []
                )
            best_t: Optional[int] = None
            for line in log:
                m = _TIMING_RE.match(line)
                if not m:
                    continue
                mins, secs, raw = int(m.group(1)), int(m.group(2)), m.group(3)
                if tok_lower in raw.lower():
                    t_sec = mins * 60 + secs
                    if best_t is None or t_sec < best_t:
                        best_t = t_sec
            if best_t is None:
                continue

            opp_race = (g.get("opp_race") or "")[:1].upper() or "?"
            mine_letter = (my_race or "?")[:1].upper() or "?"
            rows.append({
                "date": (g.get("date") or "")[:10],
                "map": g.get("map") or "-",
                "my_race": mine_letter,
                "opp_race": opp_race,
                "timestamp_seconds": best_t,
                "timestamp_display": (
                    f"{best_t // 60}:{best_t % 60:02d}"
                ),
                "result": g.get("result") or "?",
                "source": "build_log" if is_my_token else "opp_build_log",
                "id": g.get("id"),
                "my_build": g.get("my_build") or "",
            })

        rows.sort(key=lambda r: (r.get("date") or ""), reverse=True)
        return rows

    # Chunk size for the drilldown's lazy row renderer. 50 keeps the
    # initial paint snappy and matches the cross-app spec.
    _DRILLDOWN_CHUNK = 50

    @staticmethod
    def _format_drilldown_markdown(
        display_name: str,
        info: Dict,
        rows: List[Dict],
        matchup_label_str: str,
    ) -> str:
        """Render the contributing games as a Markdown table for export."""
        n = int(info.get("sample_count") or 0)
        med = info.get("median_display") or "-"
        p25 = info.get("p25_display") or "-"
        p75 = info.get("p75_display") or "-"
        mn = info.get("min_display") or "-"
        mx = info.get("max_display") or "-"
        ml = matchup_label_str or "(matchup unknown)"

        lines: List[str] = []
        lines.append(f"### {display_name} - {ml} (n={n})")
        if n >= 2 and p25 != "-" and p75 != "-":
            lines.append(
                f"median {med} (p25-p75 {p25}-{p75}, range {mn}-{mx})"
            )
        else:
            lines.append(f"median {med}")
        lines.append("")
        lines.append("| Time | Date | Map | Matchup | Result | Source |")
        lines.append("|------|------|-----|---------|--------|--------|")
        for r in rows:
            ts = r.get("timestamp_display") or "-"
            date = r.get("date") or "-"
            mp = (r.get("map") or "-").replace("|", "/")
            mu = f"{r.get('my_race') or '?'} vs {r.get('opp_race') or '?'}"
            res = r.get("result") or "?"
            src_short = (
                "opp_log" if (r.get("source") or "") == "opp_build_log"
                else "my_log"
            )
            lines.append(
                f"| {ts} | {date} | {mp} | {mu} | {res} | {src_short} |"
            )
        return "\n".join(lines) + "\n"

    @staticmethod
    def _fmt_relative_date(date_str: str) -> str:
        """Return a coarse relative-date label ('3d ago', '2mo ago')."""
        if not date_str:
            return "-"
        try:
            from datetime import datetime
            d = datetime.fromisoformat(date_str.replace(" ", "T")[:19])
        except Exception:
            return date_str[:10] or "-"
        try:
            from datetime import datetime as _dt
            delta_days = (_dt.now() - d).days
        except Exception:
            return date_str[:10] or "-"
        if delta_days <= 0:
            return "today"
        if delta_days == 1:
            return "yesterday"
        if delta_days < 30:
            return f"{delta_days}d ago"
        if delta_days < 365:
            return f"{delta_days // 30}mo ago"
        return f"{delta_days // 365}y ago"

    def _open_game_from_drilldown(self, r: Dict) -> None:
        """Click handler: open the existing full-game GameVisualizerWindow."""
        game_id = r.get("id")
        if not game_id:
            messagebox.showinfo(
                "Game record missing",
                "This drilldown row has no stored game id; cannot open "
                "the full-game viewer.",
            )
            return
        game_record: Optional[Dict] = None
        try:
            for build_name, bd in (self.analyzer.db or {}).items():
                if not isinstance(bd, dict):
                    continue
                for og in bd.get("games", []) or []:
                    if og.get("id") == game_id:
                        game_record = og
                        break
                if game_record is not None:
                    break
        except Exception:
            game_record = None
        if game_record is None or not game_record.get("file_path"):
            messagebox.showinfo(
                "Game record unavailable",
                "Could not locate the original replay file for this "
                "game. The visualizer requires the .SC2Replay file to "
                "be present on disk.",
            )
            return
        if not getattr(self.analyzer, "selected_player_name", None):
            messagebox.showerror(
                "No Profile Selected",
                "Please select your player name in the main window "
                "before opening the visualizer.",
            )
            return
        try:
            GameVisualizerWindow(
                self, game_record, self.analyzer.selected_player_name,
            )
        except Exception as exc:
            messagebox.showerror("Failed to open game", str(exc))

    def _render_timing_drilldown_row(self, parent: tk.Widget, r: Dict) -> None:
        """One row of the drilldown list. Click opens the full-game view."""
        result = r.get("result") or ""
        is_win = result == "Win"
        is_loss = result == "Loss"
        color = COLOR_WIN if is_win else (COLOR_LOSS if is_loss else COLOR_NEUTRAL)

        row = ctk.CTkFrame(parent, fg_color=("gray85", "gray22"))
        row.pack(fill="x", pady=3, padx=2)

        line1 = ctk.CTkFrame(row, fg_color="transparent")
        line1.pack(fill="x", padx=10, pady=(6, 0))

        ctk.CTkLabel(
            line1, text=r.get("timestamp_display") or "-",
            font=FONT_BOLD, anchor="w", width=64,
        ).pack(side="left")
        ctk.CTkLabel(
            line1, text=r.get("map") or "-",
            font=FONT_SMALL, anchor="w",
        ).pack(side="left", padx=(8, 0), fill="x", expand=True)
        ctk.CTkLabel(
            line1,
            text=f"{r.get('my_race') or '?'} vs {r.get('opp_race') or '?'}",
            font=FONT_SMALL, text_color="gray", width=60, anchor="e",
        ).pack(side="right")
        pill = ctk.CTkLabel(
            line1,
            text="W" if is_win else ("L" if is_loss else "?"),
            font=FONT_BOLD, text_color="white",
            fg_color=color, corner_radius=8,
            width=24, height=18,
        )
        pill.pack(side="right", padx=(0, 6))

        line2 = ctk.CTkFrame(row, fg_color="transparent")
        line2.pack(fill="x", padx=10, pady=(0, 6))
        date_str = r.get("date") or ""
        rel = self._fmt_relative_date(date_str)
        date_lbl = ctk.CTkLabel(
            line2,
            text=f"{rel} - {date_str or '-'}",
            font=FONT_SMALL, text_color="gray", anchor="w",
        )
        date_lbl.pack(side="left")
        Tooltip(date_lbl, text=(date_str or "(unknown date)"))
        src_short = (
            "opp_log" if (r.get("source") or "") == "opp_build_log"
            else "my_log"
        )
        ctk.CTkLabel(
            line2, text=src_short,
            font=FONT_SMALL, text_color="gray", anchor="e",
        ).pack(side="right")

        def _on_click(_event: object = None) -> None:
            self._open_game_from_drilldown(r)
        for w in (row, line1, line2, date_lbl):
            try:
                w.bind("<Button-1>", _on_click, add="+")
            except Exception:
                pass
        try:
            row.configure(cursor="hand2")
        except Exception:
            pass


    def _render_opp_last5_card(self, prof: Dict) -> None:
        card = ctk.CTkFrame(self._opp_detail_frame, fg_color=("gray85", "gray18"))
        card.pack(fill="x", padx=4, pady=(6, 12))
        ctk.CTkLabel(
            card, text="Last 5 Games", font=FONT_HEADING, anchor="w",
        ).pack(anchor="w", padx=14, pady=(10, 4))

        for g in prof.get("last_5_games", []):
            pill = ctk.CTkFrame(card, fg_color=("gray90", "gray22"), corner_radius=8)
            pill.pack(fill="x", padx=14, pady=3)
            res = g.get("result", "?")
            res_color = (
                COLOR_WIN if res == "Win" else
                COLOR_LOSS if res == "Loss" else COLOR_NEUTRAL
            )
            head = ctk.CTkFrame(pill, fg_color="transparent")
            head.pack(fill="x", padx=10, pady=(4, 0))
            gl = int(g.get("game_length", 0) or 0)
            length_str = f" ({gl // 60}:{gl % 60:02d})" if gl else ""
            ctk.CTkLabel(
                head,
                text=f"{(g.get('date') or '-')[:10]}   {res}{length_str}",
                text_color=res_color, font=("Arial", 12, "bold"), anchor="w",
            ).pack(side="left")
            ctk.CTkLabel(
                head, text=(g.get("map") or "")[:30], text_color="gray",
                font=FONT_SMALL, anchor="e",
            ).pack(side="right")
            ctk.CTkLabel(
                pill,
                text=f"opp: {g.get('opp_strategy') or '-'}    "
                     f"|    me: {g.get('my_build') or '-'}",
                text_color="gray", font=FONT_SMALL, anchor="w",
                wraplength=820, justify="left",
            ).pack(fill="x", padx=10, pady=(0, 4))

        if not prof.get("last_5_games"):
            ctk.CTkLabel(card, text="No recent games.", text_color="gray").pack(
                padx=14, pady=(0, 10),
            )

    def _render_definitions_tab(self) -> None:
        for w in self.tab_definitions.winfo_children():
            w.destroy()
        ctk.CTkLabel(
            self.tab_definitions, text="BUILD & STRATEGY DEFINITIONS", font=FONT_HEADING
        ).pack(pady=10)
        scroll = ctk.CTkScrollableFrame(self.tab_definitions)
        scroll.pack(fill="both", expand=True, padx=10, pady=5)
        categories: Dict[str, List] = {
            "User (PvZ)": [],
            "User (PvP)": [],
            "User (PvT)": [],
            "Opponent (Zerg)": [],
            "Opponent (Protoss)": [],
            "Opponent (Terran)": [],
            "Other": [],
        }
        for name, desc in BUILD_DEFINITIONS.items():
            if name.startswith("PvZ"):
                categories["User (PvZ)"].append((name, desc))
            elif name.startswith("PvP"):
                categories["User (PvP)"].append((name, desc))
            elif name.startswith("PvT"):
                categories["User (PvT)"].append((name, desc))
            elif name.startswith("Zerg"):
                categories["Opponent (Zerg)"].append((name, desc))
            elif name.startswith("Protoss"):
                categories["Opponent (Protoss)"].append((name, desc))
            elif name.startswith("Terran"):
                categories["Opponent (Terran)"].append((name, desc))
            else:
                categories["Other"].append((name, desc))

        for cat, items in categories.items():
            if not items:
                continue
            ctk.CTkLabel(
                scroll,
                text=cat,
                font=("Arial", 14, "bold"),
                anchor="w",
                text_color="gray",
            ).pack(fill="x", padx=10, pady=(15, 5))
            for name, desc in sorted(items):
                row = ctk.CTkFrame(scroll, fg_color=("gray85", "gray20"))
                row.pack(fill="x", pady=2, padx=5)
                ctk.CTkLabel(
                    row, text=name, width=300, anchor="w", font=("Arial", 11, "bold")
                ).pack(side="left", padx=10, pady=5)
                ctk.CTkLabel(
                    row, text=desc, anchor="w", font=("Arial", 11), wraplength=600
                ).pack(side="left", padx=10, pady=5)

    # ----- Deep Dive popup ---------------------------------------------
    def open_deep_dive(self, build_name: str, data: Dict, all_builds: List[str]) -> None:
        t = ctk.CTkToplevel(self)
        t.geometry("1100x900")
        t.title(f"Deep Dive: {build_name}")
        t.transient(self)
        t.lift()
        t.after(150, t.focus_force)

        self._dd_games_master = list(data.get("games", []))
        self._dd_sort_mode = "Date (newest)"
        self._dd_games_sorted = self._sorted_dd_games(
            self._dd_games_master, self._dd_sort_mode
        )
        self._dd_page = 0
        self._dd_per_page = 50

        header_frame = ctk.CTkFrame(t)
        header_frame.pack(fill="x", padx=10, pady=10)
        ctk.CTkLabel(header_frame, text=build_name, font=FONT_TITLE).pack(side="left", padx=10)

        def rename_build_cmd():
            new_name = simpledialog.askstring(
                "Rename Build", f"Enter new name for '{build_name}':", parent=t
            )
            if new_name:
                self.analyzer.rename_user_build(build_name, new_name)
                t.destroy()
                self.refresh_all_tabs()

        ctk.CTkButton(
            header_frame,
            text="Rename Build",
            command=rename_build_cmd,
            width=120,
            fg_color="#FBC02D",
            hover_color="#F9A825",
            text_color="black",
        ).pack(side="right", padx=10)

        stats_frame = ctk.CTkFrame(t)
        stats_frame.pack(fill="x", padx=10, pady=5)

        total_games = len(self._dd_games_sorted)
        wins = sum(1 for g in self._dd_games_sorted if g.get("result") == "Win")
        losses = sum(1 for g in self._dd_games_sorted if g.get("result") == "Loss")
        wr = int((wins / total_games) * 100) if total_games > 0 else 0

        ctk.CTkLabel(
            stats_frame,
            text=f"Total: {total_games} Games  |  Win Rate: {wr}% ({wins}W - {losses}L)",
            font=FONT_HEADING,
        ).pack(pady=5)
        ctk.CTkLabel(
            stats_frame, text="VS OPPONENT STRATEGIES", font=("Arial", 12, "bold")
        ).pack(pady=(10, 5))

        opp_stats: Dict[str, Dict[str, int]] = {}
        for g in self._dd_games_sorted:
            strat = g.get("opp_strategy", "Unknown")
            bucket = opp_stats.setdefault(strat, {"w": 0, "l": 0})
            if g.get("result") == "Win":
                bucket["w"] += 1
            elif g.get("result") == "Loss":
                bucket["l"] += 1

        grid_frame = ctk.CTkFrame(stats_frame, fg_color="transparent")
        grid_frame.pack(fill="x", padx=10, pady=5)
        sorted_strats = sorted(
            opp_stats.items(), key=lambda x: x[1]["w"] + x[1]["l"], reverse=True
        )[:15]

        row_idx, col_idx = 0, 0
        for strat, s in sorted_strats:
            total = s["w"] + s["l"]
            s_wr = int((s["w"] / total) * 100) if total > 0 else 0
            color = wr_color(s["w"], total)
            lbl = ctk.CTkLabel(
                grid_frame,
                text=f"{strat}\n{s_wr}% ({s['w']}W - {s['l']}L)",
                text_color=color,
                width=190,
                height=45,
                fg_color=("gray90", "gray25"),
                corner_radius=6,
            )
            lbl.grid(row=row_idx, column=col_idx, padx=4, pady=4)
            col_idx += 1
            if col_idx > 4:
                col_idx, row_idx = 0, row_idx + 1

        list_label_frame = ctk.CTkFrame(t, fg_color="transparent")
        list_label_frame.pack(fill="x", pady=(10, 0), padx=10)
        self._dd_status_lbl = ctk.CTkLabel(list_label_frame, text="", font=FONT_HEADING)
        self._dd_status_lbl.pack(side="left")

        # Sort dropdown — supports the new Macro column.
        ctk.CTkLabel(list_label_frame, text="Sort:", text_color="gray").pack(
            side="right", padx=(10, 4)
        )
        sort_options = [
            "Date (newest)", "Date (oldest)",
            "Macro (best)", "Macro (worst)",
            "Result (wins first)", "Game Length",
        ]

        def on_sort_change(choice: str):
            self._dd_sort_mode = choice
            self._dd_games_sorted = self._sorted_dd_games(
                self._dd_games_master, choice
            )
            self._dd_page = 0
            self._render_deep_dive_page(t, build_name, all_builds)

        ctk.CTkOptionMenu(
            list_label_frame, values=sort_options,
            command=on_sort_change, width=170,
        ).pack(side="right")

        # Column header — gives the deep-dive table a visible Macro column.
        col_header = ctk.CTkFrame(t, fg_color="transparent")
        col_header.pack(fill="x", padx=20, pady=(4, 0))
        ctk.CTkLabel(
            col_header, text="Game", width=520, anchor="w",
            font=("Arial", 11, "bold"),
        ).pack(side="left")
        ctk.CTkLabel(
            col_header, text="Macro", width=70, anchor="e",
            font=("Arial", 11, "bold"),
        ).pack(side="left")

        self._dd_scroll_inner = ctk.CTkScrollableFrame(t)
        self._dd_scroll_inner.pack(fill="both", expand=True, padx=10, pady=5)

        footer = ctk.CTkFrame(t, height=50)
        footer.pack(fill="x", padx=10, pady=10)

        self._btn_prev = ctk.CTkButton(
            footer,
            text="<< Previous",
            width=100,
            command=lambda: self._change_page(-1, t, build_name, all_builds),
        )
        self._btn_prev.pack(side="left", padx=20)
        self._btn_next = ctk.CTkButton(
            footer,
            text="Next >>",
            width=100,
            command=lambda: self._change_page(1, t, build_name, all_builds),
        )
        self._btn_next.pack(side="right", padx=20)

        self._render_deep_dive_page(t, build_name, all_builds)

    @staticmethod
    def _sorted_dd_games(games: List[Dict], mode: str) -> List[Dict]:
        """Apply the deep-dive sort mode (incl. the new Macro column)."""
        def macro_or_default(g: Dict, default: int) -> int:
            v = g.get("macro_score")
            return v if isinstance(v, (int, float)) else default

        if mode == "Date (newest)":
            return sorted(games, key=lambda x: x.get("date", ""), reverse=True)
        if mode == "Date (oldest)":
            return sorted(games, key=lambda x: x.get("date", ""))
        if mode == "Macro (best)":
            return sorted(games, key=lambda g: macro_or_default(g, -1), reverse=True)
        if mode == "Macro (worst)":
            return sorted(games, key=lambda g: macro_or_default(g, 101))
        if mode == "Result (wins first)":
            order = {"Win": 0, "Loss": 1}
            return sorted(
                games,
                key=lambda g: (order.get(g.get("result"), 2), g.get("date", "")),
            )
        if mode == "Game Length":
            return sorted(
                games, key=lambda g: g.get("game_length") or 0, reverse=True
            )
        return games

    def _change_page(self, direction, toplevel, build_name, all_builds) -> None:
        self._dd_page += direction
        self._render_deep_dive_page(toplevel, build_name, all_builds)

    def _render_deep_dive_page(self, toplevel, build_name, all_builds) -> None:
        start_idx = self._dd_page * self._dd_per_page
        end_idx = start_idx + self._dd_per_page
        current_slice = self._dd_games_sorted[start_idx:end_idx]
        total_games = len(self._dd_games_sorted)

        self._dd_status_lbl.configure(
            text=f"Games {start_idx + 1} - {min(end_idx, total_games)} of {total_games}"
        )
        self._btn_prev.configure(state="normal" if self._dd_page > 0 else "disabled")
        self._btn_next.configure(state="normal" if end_idx < total_games else "disabled")

        for w in self._dd_scroll_inner.winfo_children():
            w.destroy()

        for g in current_slice:
            row = ctk.CTkFrame(self._dd_scroll_inner, fg_color=("gray85", "gray20"))
            row.pack(fill="x", pady=4)

            color = (
                COLOR_WIN
                if g.get("result") == "Win"
                else (COLOR_LOSS if g.get("result") == "Loss" else COLOR_NEUTRAL)
            )
            date_str = str(g.get("date", ""))[:10]
            length_str = ""
            if g.get("game_length"):
                gl = int(g["game_length"])
                length_str = f" | {gl // 60}:{gl % 60:02d}"
            opp_strat_text = g.get("opp_strategy", "?")
            info = (
                f"vs {g.get('opponent', '?')} ({opp_strat_text}) | "
                f"{g.get('result', '?')} | {g.get('map', '?')}{length_str} | {date_str}"
            )

            # Top line: info on the left, macro-score badge on the right.
            top_line = ctk.CTkFrame(row, fg_color="transparent")
            top_line.pack(fill="x", padx=10, pady=(5, 0))
            ctk.CTkLabel(
                top_line,
                text=info,
                font=("Arial", 11, "bold"),
                text_color=color,
                anchor="w",
            ).pack(side="left", fill="x", expand=True)

            macro = g.get("macro_score")
            if isinstance(macro, (int, float)):
                ctk.CTkLabel(
                    top_line,
                    text=f"Macro: {int(macro)}",
                    font=("Arial", 11, "bold"),
                    text_color=macro_score_color(int(macro)),
                    width=80,
                    anchor="e",
                ).pack(side="right")
            else:
                ctk.CTkLabel(
                    top_line,
                    text="Macro: --",
                    font=("Arial", 11),
                    text_color="gray",
                    width=80,
                    anchor="e",
                ).pack(side="right")

            log_preview = " -> ".join(g.get("build_log", [])[:15])
            ctk.CTkLabel(
                row,
                text=log_preview,
                text_color="gray",
                font=FONT_SMALL,
                anchor="w",
                wraplength=900,
            ).pack(fill="x", padx=10)

            action_frame = ctk.CTkFrame(row, fg_color="transparent")
            action_frame.pack(fill="x", padx=10, pady=(0, 5))

            def open_vis(game_data=g):
                if not self.analyzer.selected_player_name:
                    messagebox.showerror(
                        "No Profile Selected",
                        "Please select your name in the main window before visualizing graphs.",
                    )
                    return
                GameVisualizerWindow(toplevel, game_data, self.analyzer.selected_player_name)

            if g.get("file_path"):
                ctk.CTkButton(
                    action_frame,
                    text="Visualize",
                    width=100,
                    height=24,
                    command=open_vis,
                    fg_color="#388E3C",
                    hover_color="#2E7D32",
                ).pack(side="left", padx=5)
            else:
                ctk.CTkButton(
                    action_frame,
                    text="Missing File",
                    width=100,
                    height=24,
                    state="disabled",
                    fg_color="gray",
                ).pack(side="left", padx=5)

            def edit_opp_strat(gid=g.get("id"), current=opp_strat_text):
                new_strat = simpledialog.askstring(
                    "Edit Opponent Strategy",
                    f"Rename '{current}' to:",
                    parent=toplevel,
                )
                if new_strat:
                    self.analyzer.update_game_opponent_strategy(gid, new_strat)
                    toplevel.destroy()
                    self.refresh_all_tabs()

            ctk.CTkButton(
                action_frame,
                text="Edit Opp Strat",
                width=100,
                height=24,
                command=edit_opp_strat,
                fg_color="#0097A7",
                hover_color="#00ACC1",
            ).pack(side="left", padx=5)
            ctk.CTkLabel(action_frame, text="Reassign:", font=FONT_SMALL).pack(
                side="left", padx=(20, 5)
            )

            def make_reassign_cmd(gid, old, top):
                def cmd(new_value):
                    if new_value and new_value != old:
                        self.analyzer.move_game(gid, old, new_value)
                        top.destroy()
                        self.refresh_all_tabs()

                return cmd

            combo = ctk.CTkComboBox(
                action_frame,
                values=all_builds,
                width=180,
                height=24,
                command=make_reassign_cmd(g.get("id"), build_name, toplevel),
            )
            combo.set(build_name)
            combo.pack(side="left", padx=5)

            def make_custom_name_cmd(gid, old, top):
                def cmd():
                    new_name = simpledialog.askstring(
                        "New Build Name", "Enter new build name:", parent=top
                    )
                    if new_name and new_name != old:
                        self.analyzer.move_game(gid, old, new_name)
                        top.destroy()
                        self.refresh_all_tabs()

                return cmd

            ctk.CTkButton(
                action_frame,
                text="New Name",
                width=70,
                height=24,
                fg_color="#5E35B1",
                hover_color="#7E57C2",
                command=make_custom_name_cmd(g.get("id"), build_name, toplevel),
            ).pack(side="left", padx=5)

            def make_delete_cmd(gid, bname, top):
                def cmd():
                    if messagebox.askyesno(
                        "Delete Game",
                        "Remove this game from the database?",
                        parent=top,
                    ):
                        self.analyzer.delete_game(gid, bname)
                        top.destroy()
                        self.refresh_all_tabs()

                return cmd

            ctk.CTkButton(
                action_frame,
                text="X",
                width=30,
                height=24,
                fg_color="#B71C1C",
                hover_color="#D32F2F",
                command=make_delete_cmd(g.get("id"), build_name, toplevel),
            ).pack(side="left", padx=3)


def main() -> int:
    """Entry point for `python -m gui.analyzer_app` and the run_gui launcher."""
    try:
        app = App()
        app.mainloop()
        return 0
    except Exception as exc:
        root = tk.Tk()
        root.withdraw()
        messagebox.showerror(
            "Analyzer Crashed",
            f"Critical Error:\n{exc}\n\n{traceback.format_exc()}",
        )
        return 1


if __name__ == "__main__":
    sys.exit(main())
