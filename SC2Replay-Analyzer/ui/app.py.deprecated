"""Main application window for the SC2 Meta Analyzer."""

import concurrent.futures
import glob
import json
import os
import threading
import sys
from pathlib import Path
from tkinter import filedialog, messagebox, simpledialog
import tkinter as tk
from typing import Dict, List, Optional, Tuple

try:
    import customtkinter as ctk
except ImportError:
    root = tk.Tk()
    root.withdraw()
    messagebox.showerror(
        "Missing Library",
        "Could not import 'customtkinter'.\nPlease install it using: pip install customtkinter",
    )
    sys.exit(1)

from analytics.macro_score import macro_score_color
from analytics.timing_catalog import (
    RACE_BUILDINGS,
    TimingToken,
    matchup_label as timing_matchup_label,
    normalize_race,
)
from core.paths import APP_DIR, CONFIG_FILE
from core.replay_loader import debug_analyze_replay, process_replay_task
from db.database import ReplayAnalyzer
from detectors.definitions import BUILD_DEFINITIONS

from ._tooltip import Tooltip
from .theme import (
    COLOR_LOSS,
    COLOR_NEUTRAL,
    COLOR_WIN,
    GRAPH_BG,
    GRAPH_FG,
    COLOR_P1,
    FONT_BODY,
    FONT_BOLD,
    FONT_HEADING,
    FONT_LARGE,
    FONT_SMALL,
    FONT_TITLE,
    wr_color,
)
from .visualizer import GameVisualizerWindow


# ---------------------------------------------------------------------------
# Building-icon directory resolution
# ---------------------------------------------------------------------------
#
# Timing cards in the Opponents tab render the real building icons that ship
# with the SC2-Overlay overlay project. The icon set lives under
# ``SC2-Overlay/icons/`` (the ``buildings/`` subdir contains the per-building
# PNGs we actually load). Resolution order:
#
# 1. ``icons_dir`` in ``config.json`` (absolute path), if the user has
#    explicitly pointed us at one. This is the escape hatch when neither
#    repo's path is reachable from the desktop install.
# 2. ``<this repo>/SC2-Overlay/icons``.
# 3. The sibling ``reveal-sc2-opponent-main`` repo at the same parent level
#    (``<sibling>/SC2-Overlay/icons``) - the canonical home of the asset set.
#
# The first existing directory wins. ``ICONS_DIR`` is the resolved value;
# may be ``None`` if no candidate is reachable, in which case the timing
# cards quietly degrade to text-only with a placeholder square.

def _resolve_icons_dir() -> Optional[str]:
    """Return the first existing SC2-Overlay/icons directory, or None."""
    candidates: List[Path] = []

    # 1. Explicit override in config.json. Soft-fail if the file is missing
    #    or malformed so this never blocks app startup.
    try:
        if os.path.exists(CONFIG_FILE):
            with open(CONFIG_FILE, "r") as f:
                conf = json.load(f) or {}
            override = conf.get("icons_dir")
            if override:
                candidates.append(Path(override))
    except Exception:
        pass

    # 2. This repo's own SC2-Overlay/icons.
    here = Path(__file__).resolve()
    repo_root = here.parents[1]  # ui/app.py -> repo_root
    candidates.append(repo_root / "SC2-Overlay" / "icons")

    # 3. The sibling reveal-sc2-opponent-main repo. Lets a single icon set
    #    serve both desktop apps without duplicating the PNGs on disk.
    parent = repo_root.parent
    candidates.append(parent / "reveal-sc2-opponent-main" / "SC2-Overlay" / "icons")

    for path in candidates:
        try:
            if path.is_dir():
                return str(path)
        except OSError:
            continue
    return None


ICONS_DIR: Optional[str] = _resolve_icons_dir()


_HAS_MPL = False
try:
    import matplotlib
    matplotlib.use("TkAgg")
    from matplotlib.backends.backend_tkagg import FigureCanvasTkAgg
    from matplotlib.figure import Figure
    _HAS_MPL = True
except ImportError:
    pass


ctk.set_appearance_mode("Dark")


class App(ctk.CTk):
    def __init__(self):
        super().__init__()
        self.analyzer = ReplayAnalyzer()
        self.title("SC2 Meta Analyzer")
        self.geometry("1400x900")
        self.minsize(1000, 600)

        self.queued_files: List[str] = []
        self._queue_lock = threading.Lock()
        self._processing = False

        self.sidebar = ctk.CTkFrame(self, width=260, corner_radius=0)
        self.sidebar.grid(row=0, column=0, sticky="nsew")
        self.grid_columnconfigure(1, weight=1)
        self.grid_rowconfigure(0, weight=1)

        ctk.CTkLabel(self.sidebar, text="META ANALYZER", font=FONT_TITLE).pack(pady=30)
        ctk.CTkLabel(self.sidebar, text="1. Add Replays:", text_color="gray").pack(pady=(10, 5))
        ctk.CTkButton(self.sidebar, text="Add Files", command=self.select_files).pack(pady=3, padx=20, fill="x")
        ctk.CTkButton(self.sidebar, text="Add Folder (Recursive)", command=self.select_folder, fg_color="#D84315", hover_color="#BF360C").pack(pady=3, padx=20, fill="x")
        ctk.CTkButton(self.sidebar, text="Clear Queue", command=self.clear_queue, fg_color="transparent", border_width=1, text_color="gray").pack(pady=3, padx=20, fill="x")

        self.queue_lbl = ctk.CTkLabel(self.sidebar, text="Queue: 0 replays", text_color="gray")
        self.queue_lbl.pack(pady=(5, 10))

        ctk.CTkLabel(self.sidebar, text="2. Select Your Name:", text_color="gray").pack(pady=(10, 5))
        self.profile_combo = ctk.CTkComboBox(self.sidebar, values=["Upload First..."], command=self.set_profile)
        self.profile_combo.pack(pady=5, padx=20, fill="x")

        self.btn_run = ctk.CTkButton(self.sidebar, text="3. Run Analysis", command=self.run_analysis, state="disabled", fg_color="gray", height=40)
        self.btn_run.pack(pady=20, padx=20, fill="x")

        self.progress_bar = ctk.CTkProgressBar(self.sidebar, mode="determinate")
        self.progress_bar.pack(padx=20, fill="x")
        self.progress_bar.set(0)

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
        ctk.CTkButton(self.sidebar, text="Export to CSV", command=self.export_csv, fg_color="transparent", border_width=1, text_color="gray").pack(pady=3, padx=20, fill="x")
        ctk.CTkButton(self.sidebar, text="Show Error Log", command=self.show_errors, fg_color="transparent", border_width=1, text_color="gray").pack(pady=3, padx=20, fill="x")
        ctk.CTkButton(self.sidebar, text="Debug Single Replay", command=self.debug_single_replay, fg_color="#4A148C", hover_color="#6A1B9A").pack(pady=3, padx=20, fill="x")
        # Default macro backfill: only games missing a score. This is the
        # button you reach for after adding new replays.
        ctk.CTkButton(
            self.sidebar, text="Backfill Macro Scores",
            command=self.backfill_macro_scores,
            fg_color="#00695C", hover_color="#00897B",
        ).pack(pady=3, padx=20, fill="x")
        # Edge-case: re-parse every replay overwriting stored scores.
        # Only needed after the macro engine itself changes.
        ctk.CTkButton(
            self.sidebar, text="Force Re-parse Macro (edge case)",
            command=self.force_reparse_macro_scores,
            fg_color="transparent", border_width=1, text_color="gray",
        ).pack(pady=3, padx=20, fill="x")

        self.status_lbl = ctk.CTkLabel(self.sidebar, text="Ready", text_color="gray", wraplength=220)
        self.status_lbl.pack(side="bottom", pady=20)

        self.tabview = ctk.CTkTabview(self, command=self._on_tab_changed)
        self.tabview.grid(row=0, column=1, padx=10, pady=10, sticky="nsew")
        self.tab_my_builds = self.tabview.add("My Builds")
        self.tab_opp_strats = self.tabview.add("Opp. Strategies")
        self.tab_vs_strategy = self.tabview.add("Build vs Strategy")
        self.tab_opponents = self.tabview.add("Opponents")
        self.tab_maps = self.tabview.add("Map Stats")
        self.tab_matchups = self.tabview.add("Matchups")
        self.tab_definitions = self.tabview.add("Definitions")

        self._opp_search_var = ctk.StringVar(value="")
        self._opp_min_games_var = ctk.StringVar(value="3")
        self._opp_selected: Optional[str] = None
        self._opp_list_frame: Optional[ctk.CTkScrollableFrame] = None
        self._opp_detail_frame: Optional[ctk.CTkScrollableFrame] = None
        self._opponents_rendered = False
        # Per-tab UI state for the Opponents tab. Holds transient choices that
        # should survive a section re-render (source filter chip, etc.). New
        # keys can be added here as the tab grows; nothing else in the app
        # touches this dict.
        self._opp_ui_state: Dict[str, object] = {
            "timing_source_filter": "Both",
        }
        # CTkImage cache keyed by token internal_name. CTkImage instances
        # carry their own refs to the underlying Pillow image - drop them
        # only on app exit. Re-creating them per render flickers and drops
        # frames on lower-spec laptops.
        self._timing_icon_cache: Dict[str, "ctk.CTkImage"] = {}
        # Owned by `_render_timing_grid` between calls so the icon-source
        # filter callback can rebuild without re-deriving the profile.
        self._timing_grid_state: Dict[str, object] = {}

        self._build_filter_var = ctk.StringVar(value="All")
        self._strat_search_var = ctk.StringVar(value="")
        self._strat_sort_var = ctk.StringVar(value="Games Played")
        self._build_sort_var = ctk.StringVar(value="Games Played")
        self._hide_empty_var = ctk.BooleanVar(value=True)

        self._build_filter_frame = ctk.CTkFrame(self.tab_my_builds, fg_color="transparent")
        self._build_filter_frame.pack(fill="x", padx=5, pady=(5, 0))
        ctk.CTkLabel(self._build_filter_frame, text="Filter:").pack(side="left", padx=5)
        for val in ["All", "PvZ", "PvP", "PvT"]:
            ctk.CTkRadioButton(self._build_filter_frame, text=val, variable=self._build_filter_var, value=val, command=self._render_builds_scroll).pack(side="left", padx=8)

        self._build_sort_frame = ctk.CTkFrame(self.tab_my_builds, fg_color="transparent")
        self._build_sort_frame.pack(fill="x", padx=5)
        ctk.CTkLabel(self._build_sort_frame, text="Sort:").pack(side="left", padx=5)
        ctk.CTkOptionMenu(self._build_sort_frame, values=["Games Played", "Win Rate", "Name"], variable=self._build_sort_var, command=lambda _: self._render_builds_scroll()).pack(side="left", padx=5)
        ctk.CTkCheckBox(self._build_sort_frame, text="Hide empty builds", variable=self._hide_empty_var, command=self._render_builds_scroll).pack(side="left", padx=20)

        self._builds_scroll = ctk.CTkScrollableFrame(self.tab_my_builds)
        self._builds_scroll.pack(fill="both", expand=True, padx=5, pady=5)

        self._load_config()
        self.refresh_all_tabs()
        self._show_db_load_status()

    def _ui_update(self, func, *args, **kwargs):
        self.after(0, lambda: func(*args, **kwargs))

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
        from datetime import datetime, timedelta
        cutoff = datetime.now() - timedelta(days=days)
        return cutoff.isoformat()

    def _filtered_games(self, games: List[Dict]) -> List[Dict]:
        cutoff = self._season_cutoff_iso()
        if cutoff is None:
            return games
        return [g for g in games if (g.get("date") or "") >= cutoff]

    def _on_season_filter_change(self):
        try:
            cutoff = self._season_cutoff_iso()
            if cutoff is None:
                self._season_lbl.configure(text="(scoring on all games)")
            else:
                from datetime import datetime
                d = datetime.fromisoformat(cutoff)
                self._season_lbl.configure(
                    text=f"(scoring games since {d.strftime('%Y-%m-%d')})",
                )
            self.refresh_all_tabs()
            try:
                conf = {}
                if os.path.exists(CONFIG_FILE):
                    with open(CONFIG_FILE, 'r') as f:
                        conf = json.load(f) or {}
                conf["season_filter"] = self.season_filter_var.get()
                with open(CONFIG_FILE, 'w') as f:
                    json.dump(conf, f)
            except Exception as e:
                print(f"Season filter config save failed: {e}")
        except Exception as e:
            print(f"Season filter change failed: {e}")

    def _show_db_load_status(self):
        err = getattr(self.analyzer, "load_error", None)
        warn = getattr(self.analyzer, "load_warning", None)
        if err:
            messagebox.showerror(
                "Database Load Failed",
                err + "\n\nThe app will run with an empty in-memory DB.",
            )
            self.status_lbl.configure(text="DB load FAILED - see error.", text_color="#EF5350")
        elif warn:
            try:
                self.after(800, lambda: messagebox.showwarning(
                    "Database Recovered Partially", warn,
                ))
            except Exception:
                pass
            self.status_lbl.configure(
                text="DB recovered with warnings - see popup.",
                text_color="#FBC02D",
            )

    def _load_config(self):
        if os.path.exists(CONFIG_FILE):
            try:
                with open(CONFIG_FILE, 'r') as f:
                    conf = json.load(f)
                    last_player = conf.get("last_player")
                    if last_player:
                        self.analyzer.selected_player_name = last_player
                        self.profile_combo.configure(values=[last_player])
                        self.profile_combo.set(last_player)
                        self.btn_run.configure(state="normal", fg_color="#1f538d")
                    saved_season = conf.get("season_filter")
                    if saved_season and saved_season in self._SEASON_DAYS:
                        try:
                            self.season_filter_var.set(saved_season)
                            cutoff = self._season_cutoff_iso()
                            if cutoff is None:
                                self._season_lbl.configure(text="(scoring on all games)")
                            else:
                                from datetime import datetime
                                d = datetime.fromisoformat(cutoff)
                                self._season_lbl.configure(
                                    text=f"(scoring games since {d.strftime('%Y-%m-%d')})",
                                )
                        except Exception:
                            pass
            except Exception:
                pass

    def set_profile(self, choice):
        if choice and choice != "Upload First...":
            self.analyzer.selected_player_name = choice
            try:
                with open(CONFIG_FILE, 'w') as f:
                    json.dump({"last_player": choice}, f)
            except Exception as e:
                print(f"Config save failed: {e}")

    def clear_queue(self):
        with self._queue_lock:
            self.queued_files = []
        self._ui_update(self.queue_lbl.configure, text="Queue: 0 replays")
        self._ui_update(self.status_lbl.configure, text="Queue cleared.")
        self._ui_update(self.btn_run.configure, state="disabled", text="3. Run Analysis")

    def select_folder(self):
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
        self._ui_update(self.status_lbl.configure, text=f"Added {len(new_files)} replays from folder.")
        threading.Thread(target=self._scan_names_thread, daemon=True).start()

    def select_files(self):
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

    def _scan_names_thread(self):
        with self._queue_lock:
            scan_subset = list(self.queued_files[:50])
        if not scan_subset:
            self._ui_update(self.status_lbl.configure, text="No replays to scan.")
            return
        self._ui_update(
            self.status_lbl.configure,
            text=f"Scanning {len(scan_subset)} replay(s) for player names..."
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
                self.profile_combo.configure(values=["Upload First..."])
                self.profile_combo.set("Upload First...")
                err_count = self.analyzer.error_logger.count
                if err_count > 0:
                    self.status_lbl.configure(
                        text=f"No human player names found. {err_count} error(s) logged.",
                        text_color="#EF5350",
                    )
                else:
                    self.status_lbl.configure(
                        text="No human player names found.",
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

    def run_analysis(self):
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

    def _process_thread(self):
        with self._queue_lock:
            files_to_process = list(self.queued_files)
        total = len(files_to_process)
        success_count = 0
        player_name = self.analyzer.selected_player_name

        with concurrent.futures.ProcessPoolExecutor() as executor:
            future_to_file = {executor.submit(process_replay_task, path, player_name): path for path in files_to_process}
            for i, future in enumerate(concurrent.futures.as_completed(future_to_file)):
                path = future_to_file[future]
                try:
                    result = future.result()
                    if result['status'] == 'success':
                        gid = result['game_id']
                        if gid not in self.analyzer._known_game_ids:
                            my_build = result['my_build']
                            game_data = result['data']
                            with self.analyzer._lock:
                                if my_build not in self.analyzer.db:
                                    self.analyzer.db[my_build] = {"games": [], "wins": 0, "losses": 0}
                                self.analyzer.db[my_build]['games'].append(game_data)
                                self.analyzer._known_game_ids.add(gid)
                                self.analyzer.recalc_stats(my_build)
                            success_count += 1
                    else:
                        self.analyzer.error_logger.log(path, result.get('error', 'Unknown error'))
                except Exception as e:
                    self.analyzer.error_logger.log(path, f"System Error: {str(e)}")

                if i % 2 == 0 or i == total - 1:
                    self._ui_update(self.progress_bar.set, (i + 1) / total)
                    self._ui_update(self.status_lbl.configure, text=f"Processing {i + 1}/{total}... ({success_count} new)")

        self.analyzer.save_database()
        self.analyzer.error_logger.save()
        with self._queue_lock:
            self.queued_files = []

        err_count = self.analyzer.error_logger.count
        msg = f"Done! {success_count} new games added."
        if err_count > 0:
            msg += f"\n({err_count} errors - see log)"

        self._ui_update(self.progress_bar.set, 1.0)
        self._ui_update(self.status_lbl.configure, text=msg)
        self._ui_update(self.queue_lbl.configure, text="Queue: 0 replays")
        self._ui_update(self.btn_run.configure, text="3. Run Analysis", state="disabled")
        self._ui_update(self.refresh_all_tabs)
        self._processing = False

    def export_csv(self):
        path = filedialog.asksaveasfilename(parent=self, defaultextension=".csv", filetypes=[("CSV", "*.csv")], initialfile="sc2_stats.csv")
        if path:
            self.analyzer.export_csv(path)
            self.status_lbl.configure(text=f"Exported to {os.path.basename(path)}")

    def show_errors(self):
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
            ctk.CTkLabel(frame, text=e['file'], font=("Arial", 11, "bold"), anchor="w").pack(fill="x", padx=10, pady=(5, 0))
            ctk.CTkLabel(frame, text=e['error'], text_color="#EF5350", font=FONT_SMALL, anchor="w", wraplength=650).pack(fill="x", padx=10, pady=(0, 5))

    def _compute_macro_for_games(self, games: List, parent=None, on_done=None):
        candidates = []
        for g in games or []:
            if g.get("macro_score") is not None:
                continue
            fp = g.get("file_path")
            if not fp or not os.path.exists(fp):
                continue
            gid = g.get("id")
            owner_build = None
            for bn, bd in self.analyzer.db.items():
                if not isinstance(bd, dict):
                    continue
                for og in bd.get("games", []) or []:
                    if og.get("id") == gid:
                        owner_build = bn
                        break
                if owner_build:
                    break
            candidates.append((owner_build or "Unknown", gid, fp))
        if not candidates:
            messagebox.showinfo(
                "Nothing to compute",
                "Every visible game already has a macro score.",
                parent=parent,
            )
            return
        if not messagebox.askyesno(
            "Compute macro?",
            f"Re-parse {len(candidates)} replay(s) to compute macro scores?",
            parent=parent,
        ):
            return
        threading.Thread(
            target=self._backfill_macro_thread,
            args=(candidates,),
            kwargs={"on_done": on_done},
            daemon=True,
        ).start()

    def backfill_macro_scores(self, force: bool = False):
        """Re-parse replays to compute macro scores.

        Default mode (force=False) is **incremental**: only games that
        don't already have a macro_score get re-parsed. This is what you
        want after adding new replays.

        Force mode (force=True) re-parses every reachable replay,
        overwriting existing scores. Use this only after the macro engine
        itself changes (e.g. fixed chrono / inject / MULE counting). It
        lives behind a separate sidebar button so the common case stays
        a single click.
        """
        if not self.analyzer.selected_player_name:
            messagebox.showwarning("No Player Selected", "Pick your player name first.")
            return

        with self.analyzer._lock:
            candidates: List = []
            for build_name, bd in self.analyzer.db.items():
                if not isinstance(bd, dict):
                    continue
                for g in bd.get("games", []) or []:
                    fp = g.get("file_path")
                    if not fp or not os.path.exists(fp):
                        continue
                    if not force:
                        score = g.get("macro_score")
                        if score is not None and score != 0:
                            continue
                    candidates.append((build_name, g.get("id"), fp))

        if not candidates:
            if force:
                messagebox.showinfo(
                    "Nothing to backfill",
                    "No reachable replay files found.",
                )
            else:
                messagebox.showinfo(
                    "Nothing to backfill",
                    "Every game already has a macro score. Use 'Force "
                    "Re-parse Macro' if you need to refresh existing scores "
                    "(e.g. after a macro engine update).",
                )
            return

        if force:
            prompt = (
                f"Force re-parse {len(candidates)} reachable replay(s)?\n\n"
                f"This OVERWRITES existing macro scores. Use only after the "
                f"macro engine has changed (e.g. chrono / inject / MULE fix). "
                f"Slow."
            )
        else:
            prompt = (
                f"Re-parse {len(candidates)} new replay(s) missing a macro "
                f"score?\n\nFor a full re-parse use the 'Force Re-parse "
                f"Macro' button (only needed after engine changes)."
            )

        if not messagebox.askyesno("Backfill macro scores?", prompt):
            return

        threading.Thread(
            target=self._backfill_macro_thread, args=(candidates,), daemon=True,
        ).start()

    def force_reparse_macro_scores(self):
        """Sidebar button: force-reparse every reachable replay.

        Edge-case wrapper around `backfill_macro_scores(force=True)`. Kept
        separate from the normal Backfill button so the default path stays
        cheap and obvious.
        """
        self.backfill_macro_scores(force=True)

    def _backfill_macro_thread(self, candidates: List, on_done=None):
        from analytics.macro_score import compute_macro_score
        from core.event_extractor import extract_macro_events
        from core.replay_loader import load_replay_with_fallback

        total = len(candidates)
        success = 0
        errors = 0
        player_name = self.analyzer.selected_player_name

        def _match_me(replay, target):
            target_low = (target or "").lower()
            for p in replay.players:
                if p.name == target:
                    return p
            for p in replay.players:
                pname = (getattr(p, "name", "") or "").lower()
                if target_low and (target_low in pname or pname in target_low):
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
                replay = load_replay_with_fallback(file_path)
                me = _match_me(replay, player_name)
                if not me:
                    self.analyzer.error_logger.log(file_path, f"Backfill: player not found")
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
                            g["macro_breakdown"] = {
                                "score": result.get("macro_score"),
                                "race": me.play_race,
                                "game_length_sec": length_sec,
                                "raw": result.get("raw", {}) or {},
                                "all_leaks": result.get("all_leaks", []) or [],
                                "top_3_leaks": result.get("top_3_leaks", []) or [],
                            }
                            break
                success += 1
            except Exception as exc:
                self.analyzer.error_logger.log(file_path, f"Macro backfill error: {exc}")
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
        self._ui_update(self.status_lbl.configure, text=f"Macro backfill done.")
        self._ui_update(self.refresh_all_tabs)
        if on_done is not None:
            try:
                self._ui_update(on_done)
            except Exception:
                pass

    def debug_single_replay(self):
        if not self.analyzer.selected_player_name:
            messagebox.showwarning("No Player", "Please select your player name first.")
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

    def _show_debug_window(self, report: str, file_path: str):
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
            save_path = filedialog.asksaveasfilename(parent=t, defaultextension=".txt")
            if save_path:
                with open(save_path, 'w', encoding='utf-8') as f:
                    f.write(report)

        ctk.CTkButton(btn_frame, text="Save Report to File", command=save_report).pack(side="left", padx=5)
        ctk.CTkButton(btn_frame, text="Close", command=t.destroy, fg_color="#D32F2F").pack(side="right", padx=5)
        textbox = ctk.CTkTextbox(t, font=("Consolas", 11), wrap="none")
        textbox.pack(fill="both", expand=True, padx=10, pady=10)
        textbox.insert("1.0", report)
        textbox.configure(state="disabled")

    # ====================================================================
    # Macro score breakdown popup
    # ====================================================================
    def _show_macro_breakdown(self, game: Dict):
        """Open a popup explaining how this game's macro score was computed.

        Uses the persisted `macro_breakdown` (raw SQ + penalties + all_leaks)
        when available. For games that pre-date the persisted breakdown, we
        fall back to (a) showing whatever `top_3_leaks` we have, and (b)
        offering a "Recompute" button that re-parses the replay file.
        """
        score = game.get("macro_score")
        breakdown = game.get("macro_breakdown") or {}
        leaks = breakdown.get("all_leaks") or game.get("top_3_leaks") or []
        raw = breakdown.get("raw") or {}
        race = breakdown.get("race") or game.get("opp_race") or ""

        t = ctk.CTkToplevel(self)
        t.geometry("720x720")
        t.title(f"Macro Breakdown - {game.get('opponent', '?')}")
        t.transient(self)
        t.lift()
        t.after(150, t.focus_force)

        # ---- Headline score
        head = ctk.CTkFrame(t, fg_color=("gray85", "gray18"))
        head.pack(fill="x", padx=12, pady=(12, 8))
        score_str = str(int(score)) if isinstance(score, (int, float)) else "--"
        score_color = macro_score_color(int(score)) if isinstance(score, (int, float)) else "#90A4AE"
        ctk.CTkLabel(
            head, text=f"Macro Score: {score_str} / 100",
            font=("Arial", 22, "bold"), text_color=score_color,
        ).pack(pady=(10, 2))
        ctk.CTkLabel(
            head,
            text=(
                f"vs {game.get('opponent', '?')} on {game.get('map', '?')} "
                f"({game.get('result', '?')})"
            ),
            font=FONT_BODY, text_color="gray",
        ).pack(pady=(0, 8))

        # If we have nothing to show beyond the headline, offer a recompute.
        has_raw = bool(raw)
        if not has_raw and not leaks:
            box = ctk.CTkFrame(t, fg_color="transparent")
            box.pack(fill="x", padx=12, pady=20)
            ctk.CTkLabel(
                box,
                text="No detailed breakdown stored for this game.\n"
                     "It was likely added before the breakdown was persisted.",
                font=FONT_BODY, text_color="gray", justify="center",
            ).pack(pady=10)
            fp = game.get("file_path")
            if fp and os.path.exists(fp):
                ctk.CTkButton(
                    box, text="Recompute Now (re-parses replay)",
                    fg_color="#1565C0", hover_color="#1976D2",
                    command=lambda: self._recompute_one_macro(game, t),
                ).pack(pady=8)
            else:
                ctk.CTkLabel(
                    box, text="(replay file not found - cannot recompute)",
                    font=FONT_SMALL, text_color="#EF5350",
                ).pack(pady=4)
            ctk.CTkButton(
                t, text="Close", fg_color="#D32F2F",
                command=t.destroy,
            ).pack(pady=10)
            return

        scroll = ctk.CTkScrollableFrame(t)
        scroll.pack(fill="both", expand=True, padx=12, pady=(0, 8))

        # ---- Scoring components ----
        if has_raw:
            sec = ctk.CTkFrame(scroll, fg_color=("gray85", "gray20"))
            sec.pack(fill="x", padx=4, pady=4)
            ctk.CTkLabel(
                sec, text="How this number was calculated",
                font=FONT_HEADING, anchor="w",
            ).pack(anchor="w", padx=12, pady=(6, 2))
            ctk.CTkLabel(
                sec,
                text=(
                    "Headline = Spending Quotient (SQ) - 5, then small "
                    "penalties for the SC2-specific macro disciplines."
                ),
                font=FONT_SMALL, text_color="gray", anchor="w",
                wraplength=640, justify="left",
            ).pack(anchor="w", padx=12, pady=(0, 6))

            sq = raw.get("sq")
            base = raw.get("base_score")
            sb_pen = raw.get("supply_block_penalty", 0) or 0
            race_pen = raw.get("race_penalty", 0) or 0
            float_pen = raw.get("float_penalty", 0) or 0

            def _row(label, value, color="#E0E0E0"):
                row = ctk.CTkFrame(sec, fg_color="transparent")
                row.pack(fill="x", padx=20, pady=1)
                ctk.CTkLabel(
                    row, text=label, anchor="w", font=FONT_SMALL,
                ).pack(side="left")
                ctk.CTkLabel(
                    row, text=value, anchor="e", font=FONT_SMALL,
                    text_color=color,
                ).pack(side="right")

            if sq is not None:
                _row("Spending Quotient (SQ)", f"{float(sq):.1f}")
            if base is not None:
                _row("Base score (SQ - 5)", f"{float(base):.1f}")
            _row("Supply-block penalty", f"-{float(sb_pen):.1f}",
                 "#EF5350" if sb_pen > 0 else "#66BB6A")
            penalty_label = {
                "Zerg": "Inject penalty",
                "Protoss": "Chrono penalty",
                "Terran": "MULE penalty",
            }.get(race, "Race-mechanic penalty")
            _row(penalty_label, f"-{float(race_pen):.1f}",
                 "#EF5350" if race_pen > 0 else "#66BB6A")
            _row("Mineral-float penalty", f"-{float(float_pen):.1f}",
                 "#EF5350" if float_pen > 0 else "#66BB6A")
            _row("Final score (clamped 0..100)", score_str, score_color)
            ctk.CTkLabel(sec, text="", height=4).pack()

            # Race-specific stats
            stat_lines = []
            if race == "Zerg":
                a = raw.get("injects_actual")
                e = raw.get("injects_expected")
                if a is not None and e is not None:
                    pct = int(100 * a / max(1, e))
                    stat_lines.append(f"Injects: {a} of ~{e} expected ({pct}%)")
            elif race == "Protoss":
                a = raw.get("chronos_actual")
                e = raw.get("chronos_expected")
                if a is not None and e is not None:
                    pct = int(100 * a / max(1, e))
                    stat_lines.append(f"Chronos: {a} of ~{e} expected ({pct}%)")
            elif race == "Terran":
                a = raw.get("mules_actual")
                e = raw.get("mules_expected")
                if a is not None and e is not None:
                    pct = int(100 * a / max(1, e))
                    stat_lines.append(f"MULEs: {a} of ~{e} expected ({pct}%)")
            blocked = raw.get("supply_blocked_seconds")
            if blocked is not None:
                stat_lines.append(f"Supply-blocked: {float(blocked):.0f}s total")
            spikes = raw.get("mineral_float_spikes")
            if spikes is not None:
                stat_lines.append(
                    f"Mineral float spikes (>800 after 4:00): {int(spikes)} sample(s)"
                )

            if stat_lines:
                stat_box = ctk.CTkFrame(sec, fg_color="transparent")
                stat_box.pack(fill="x", padx=12, pady=(2, 6))
                ctk.CTkLabel(
                    stat_box, text="Discipline metrics",
                    font=("Arial", 11, "bold"), anchor="w",
                ).pack(anchor="w", pady=(2, 2))
                for ln in stat_lines:
                    ctk.CTkLabel(
                        stat_box, text=ln, anchor="w", font=FONT_SMALL,
                        text_color="#90CAF9",
                    ).pack(anchor="w", padx=8, pady=1)

        # ---- What you did well ----
        if has_raw:
            wins_section = []
            if (raw.get("supply_block_penalty", 0) or 0) <= 0:
                wins_section.append(
                    "No meaningful supply-block - production never stalled."
                )
            if (raw.get("race_penalty", 0) or 0) <= 0:
                if race == "Zerg":
                    wins_section.append("Inject cadence kept up with hatchery uptime.")
                elif race == "Protoss":
                    wins_section.append("Chrono usage matched nexus uptime.")
                elif race == "Terran":
                    wins_section.append("MULE drops kept pace with orbital energy.")
            if (raw.get("float_penalty", 0) or 0) <= 0:
                wins_section.append("Bank stayed under control - no sustained float.")
            sq = raw.get("sq")
            if isinstance(sq, (int, float)) and sq >= 80:
                wins_section.append(
                    f"Spending Quotient {float(sq):.0f} - Master/Pro-tier macro pacing."
                )
            elif isinstance(sq, (int, float)) and sq >= 70:
                wins_section.append(
                    f"Spending Quotient {float(sq):.0f} - solid Diamond-tier macro pacing."
                )

            if wins_section:
                sec = ctk.CTkFrame(scroll, fg_color=("gray85", "gray20"))
                sec.pack(fill="x", padx=4, pady=4)
                ctk.CTkLabel(
                    sec, text="What you did well", font=FONT_HEADING,
                    text_color="#66BB6A", anchor="w",
                ).pack(anchor="w", padx=12, pady=(6, 2))
                for ln in wins_section:
                    row = ctk.CTkFrame(sec, fg_color="transparent")
                    row.pack(fill="x", padx=20, pady=1)
                    ctk.CTkLabel(
                        row, text="+", text_color="#66BB6A",
                        font=("Arial", 14, "bold"), width=14,
                    ).pack(side="left")
                    ctk.CTkLabel(
                        row, text=ln, anchor="w", font=FONT_SMALL,
                        wraplength=600, justify="left",
                    ).pack(side="left", fill="x", expand=True)
                ctk.CTkLabel(sec, text="", height=4).pack()

        # ---- Leaks (what hurt the score) ----
        if leaks:
            sec = ctk.CTkFrame(scroll, fg_color=("gray85", "gray20"))
            sec.pack(fill="x", padx=4, pady=4)
            ctk.CTkLabel(
                sec, text="Where you lost economy",
                font=FONT_HEADING, text_color="#EF5350", anchor="w",
            ).pack(anchor="w", padx=12, pady=(6, 2))
            for lk in leaks:
                card = ctk.CTkFrame(sec, fg_color=("gray90", "gray25"))
                card.pack(fill="x", padx=14, pady=3)
                top_row = ctk.CTkFrame(card, fg_color="transparent")
                top_row.pack(fill="x", padx=10, pady=(4, 0))
                ctk.CTkLabel(
                    top_row, text=lk.get("name", "?"),
                    font=("Arial", 12, "bold"), anchor="w",
                ).pack(side="left")
                pen = lk.get("penalty")
                if isinstance(pen, (int, float)) and pen > 0:
                    ctk.CTkLabel(
                        top_row, text=f"-{float(pen):.1f} pts",
                        text_color="#EF5350", font=("Arial", 11, "bold"),
                        anchor="e",
                    ).pack(side="right")
                detail_row = ctk.CTkFrame(card, fg_color="transparent")
                detail_row.pack(fill="x", padx=10, pady=(0, 4))
                ctk.CTkLabel(
                    detail_row, text=lk.get("detail", ""),
                    anchor="w", font=FONT_SMALL, text_color="gray",
                    wraplength=600, justify="left",
                ).pack(side="left", fill="x", expand=True)
                cost = lk.get("mineral_cost")
                if isinstance(cost, (int, float)) and cost > 0:
                    ctk.CTkLabel(
                        detail_row, text=f"~{int(cost)} min lost",
                        text_color="#FBC02D", font=FONT_SMALL, anchor="e",
                    ).pack(side="right")

        # ---- Footer ----
        footer = ctk.CTkFrame(t, fg_color="transparent")
        footer.pack(fill="x", padx=12, pady=10)
        fp = game.get("file_path")
        if fp and os.path.exists(fp):
            ctk.CTkButton(
                footer, text="Recompute",
                fg_color="#1565C0", hover_color="#1976D2",
                command=lambda: self._recompute_one_macro(game, t),
            ).pack(side="left")
        ctk.CTkButton(
            footer, text="Close", fg_color="#D32F2F", command=t.destroy,
        ).pack(side="right")

    def _recompute_one_macro(self, game: Dict, popup):
        """Re-parse a single replay and update its macro fields, then refresh
        the breakdown popup."""
        fp = game.get("file_path")
        if not fp or not os.path.exists(fp):
            messagebox.showerror("Cannot recompute", "Replay file not found.", parent=popup)
            return
        if not self.analyzer.selected_player_name:
            messagebox.showerror(
                "No player selected",
                "Select your player name in the sidebar first.",
                parent=popup,
            )
            return

        from analytics.macro_score import compute_macro_score
        from core.event_extractor import extract_macro_events
        from core.replay_loader import load_replay_with_fallback

        try:
            replay = load_replay_with_fallback(fp)
            target_low = (self.analyzer.selected_player_name or "").lower()
            me = None
            for p in replay.players:
                if p.name == self.analyzer.selected_player_name:
                    me = p
                    break
            if me is None:
                for p in replay.players:
                    pname = (getattr(p, "name", "") or "").lower()
                    if target_low and (target_low in pname or pname in target_low):
                        me = p
                        break
            if me is None:
                messagebox.showerror(
                    "Player not found", "Couldn't match your player in the replay.",
                    parent=popup,
                )
                return
            length = getattr(replay, "game_length", None)
            length_sec = length.seconds if length else 0
            macro_events = extract_macro_events(replay, me.pid)
            result = compute_macro_score(macro_events, me.play_race, length_sec)
            new_breakdown = {
                "score": result.get("macro_score"),
                "race": me.play_race,
                "game_length_sec": length_sec,
                "raw": result.get("raw", {}) or {},
                "all_leaks": result.get("all_leaks", []) or [],
                "top_3_leaks": result.get("top_3_leaks", []) or [],
            }
            # Mutate the in-memory game record (lookup by id across the DB).
            gid = game.get("id")
            with self.analyzer._lock:
                for bn, bd in self.analyzer.db.items():
                    if not isinstance(bd, dict):
                        continue
                    for og in bd.get("games", []) or []:
                        if og.get("id") == gid:
                            og["macro_score"] = result.get("macro_score")
                            og["top_3_leaks"] = result.get("top_3_leaks", []) or []
                            og["macro_breakdown"] = new_breakdown
                            break
            try:
                self.analyzer.save_database()
            except Exception:
                pass
            # Patch the live `game` dict so the popup refreshes from updated data.
            game["macro_score"] = result.get("macro_score")
            game["top_3_leaks"] = result.get("top_3_leaks", []) or []
            game["macro_breakdown"] = new_breakdown
            popup.destroy()
            self._show_macro_breakdown(game)
            self.refresh_all_tabs()
        except Exception as exc:
            messagebox.showerror("Recompute failed", str(exc), parent=popup)

    def _on_tab_changed(self):
        try:
            current = self.tabview.get()
        except Exception:
            return
        if current == "Opponents" and not self._opponents_rendered:
            self._opponents_rendered = True
            self._render_opponents_tab()

    def refresh_all_tabs(self):
        self._render_builds_scroll()
        self._render_opp_strats_tab()
        self._render_vs_strategy_tab()
        self._opponents_rendered = False
        # If the user is currently looking at the Opponents tab, re-render
        # it immediately so the list reflects new games. Otherwise the
        # render is deferred until they switch to it.
        try:
            if self.tabview.get() == "Opponents":
                self._opponents_rendered = True
                self._render_opponents_tab()
        except Exception:
            pass
        self._render_maps_tab()
        self._render_matchups_tab()
        self._render_definitions_tab()

    def _render_builds_scroll(self):
        for w in self._builds_scroll.winfo_children():
            w.destroy()
        db = self.analyzer.db
        filter_val = self._build_filter_var.get()
        sort_val = self._build_sort_var.get()
        hide_empty = self._hide_empty_var.get()
        all_builds = self.analyzer.get_all_build_names()

        items: List = []
        for name, data in db.items():
            if not isinstance(data, dict):
                continue
            if filter_val != "All" and not name.startswith(filter_val):
                continue
            games_in_season = self._filtered_games(data.get('games', []) or [])
            wins = sum(1 for g in games_in_season if g.get('result') == 'Win')
            losses = sum(1 for g in games_in_season if g.get('result') == 'Loss')
            items.append((name, {
                'games': games_in_season, 'wins': wins, 'losses': losses,
            }))

        if sort_val == "Games Played":
            items.sort(key=lambda x: len(x[1]['games']), reverse=True)
        elif sort_val == "Win Rate":
            items.sort(
                key=lambda x: (x[1]['wins'] / (x[1]['wins'] + x[1]['losses'])) if (x[1]['wins'] + x[1]['losses']) > 0 else -1,
                reverse=True,
            )
        elif sort_val == "Name":
            items.sort(key=lambda x: x[0])

        RENDER_LIMIT = 200
        rendered = 0
        for name, data in items:
            wins, losses = data['wins'], data['losses']
            total = wins + losses
            if hide_empty and total == 0:
                continue
            if rendered >= RENDER_LIMIT:
                break
            wr = int((wins / total) * 100) if total > 0 else 0
            color = wr_color(wins, total)
            card = ctk.CTkFrame(self._builds_scroll, fg_color=("gray85", "gray20"))
            card.pack(fill="x", pady=4, padx=5)
            head = ctk.CTkFrame(card, fg_color="transparent")
            head.pack(fill="x", padx=10, pady=5)
            ctk.CTkLabel(head, text=name, font=("Arial", 15, "bold")).pack(side="left")
            ctk.CTkLabel(head, text=f"{wins}W - {losses}L ({wr}%)  -  {total} games", text_color=color).pack(side="right")
            ctk.CTkButton(card, text="Deep Dive", height=26, command=lambda n=name, d=data: self.open_deep_dive(n, d, all_builds)).pack(fill="x", padx=10, pady=(0, 5))
            rendered += 1

        nonempty_count = sum(1 for _, d in items if (d['wins'] + d['losses']) > 0)
        if nonempty_count > rendered:
            ctk.CTkLabel(
                self._builds_scroll,
                text=f"Showing top {rendered} of {nonempty_count}.",
                text_color="gray", font=FONT_SMALL,
            ).pack(pady=8)

    def _render_opp_strats_tab(self):
        for w in self.tab_opp_strats.winfo_children():
            w.destroy()
        ctk.CTkLabel(self.tab_opp_strats, text="WIN RATE VS OPPONENT STRATEGIES", font=FONT_HEADING).pack(pady=10)
        scroll = ctk.CTkScrollableFrame(self.tab_opp_strats)
        scroll.pack(fill="both", expand=True, padx=10, pady=5)
        opp_stats: Dict[str, Dict] = {}
        for bd in self.analyzer.db.values():
            if not isinstance(bd, dict):
                continue
            for g in self._filtered_games(bd.get('games', []) or []):
                strat = g.get('opp_strategy', 'Unknown')
                if strat not in opp_stats:
                    opp_stats[strat] = {'wins': 0, 'losses': 0}
                if g.get('result') == 'Win':
                    opp_stats[strat]['wins'] += 1
                elif g.get('result') == 'Loss':
                    opp_stats[strat]['losses'] += 1
        items = sorted(opp_stats.items(), key=lambda x: x[1]['wins'] + x[1]['losses'], reverse=True)
        row_idx, col_idx = 0, 0
        for strat, s in items:
            total = s['wins'] + s['losses']
            if total == 0:
                continue
            wr = int((s['wins'] / total) * 100)
            color = wr_color(s['wins'], total)
            lbl = ctk.CTkLabel(scroll, text=f"{strat}\n{wr}% ({s['wins']}W - {s['losses']}L)", text_color=color, width=200, height=55, fg_color=("gray90", "gray25"), corner_radius=6, font=FONT_BODY)
            lbl.grid(row=row_idx, column=col_idx, padx=5, pady=5, sticky="ew")
            col_idx += 1
            if col_idx > 3:
                col_idx, row_idx = 0, row_idx + 1

    def _render_vs_strategy_tab(self):
        for w in self.tab_vs_strategy.winfo_children():
            w.destroy()
        ctrl_frame = ctk.CTkFrame(self.tab_vs_strategy, fg_color="transparent")
        ctrl_frame.pack(fill="x", padx=10, pady=(10, 5))
        ctk.CTkLabel(ctrl_frame, text="Search:").pack(side="left", padx=5)
        search_entry = ctk.CTkEntry(ctrl_frame, textvariable=self._strat_search_var, width=200, placeholder_text="e.g. Zerg")
        search_entry.pack(side="left", padx=5)
        search_entry.bind("<KeyRelease>", lambda e: self._render_vs_strategy_list())
        ctk.CTkLabel(ctrl_frame, text="Sort By:").pack(side="left", padx=(20, 5))
        sort_opts = ["Games Played", "Win Rate (High)", "Win Rate (Low)", "Opponent Strategy", "My Build"]
        ctk.CTkOptionMenu(ctrl_frame, values=sort_opts, variable=self._strat_sort_var, command=lambda _: self._render_vs_strategy_list()).pack(side="left", padx=5)
        ctk.CTkLabel(self.tab_vs_strategy, text="MY BUILD VS OPPONENT STRATEGY", font=FONT_HEADING).pack(pady=5)
        self._vs_strat_scroll = ctk.CTkScrollableFrame(self.tab_vs_strategy)
        self._vs_strat_scroll.pack(fill="both", expand=True, padx=10, pady=5)
        self._render_vs_strategy_list()

    def _render_vs_strategy_list(self):
        for w in self._vs_strat_scroll.winfo_children():
            w.destroy()
        agg: Dict = {}
        for bname, bd in self.analyzer.db.items():
            if not isinstance(bd, dict):
                continue
            for g in self._filtered_games(bd.get('games', []) or []):
                key = (bname, g.get('opp_strategy', 'Unknown'))
                if key not in agg:
                    agg[key] = {'wins': 0, 'losses': 0}
                if g.get('result') == 'Win':
                    agg[key]['wins'] += 1
                elif g.get('result') == 'Loss':
                    agg[key]['losses'] += 1
        stats = sorted(
            [
                {'my_build': k[0], 'opp_strat': k[1], 'wins': v['wins'],
                 'losses': v['losses'], 'total': v['wins'] + v['losses']}
                for k, v in agg.items() if (v['wins'] + v['losses']) > 0
            ],
            key=lambda x: x['total'], reverse=True,
        )
        search_txt = self._strat_search_var.get().lower()
        sort_mode = self._strat_sort_var.get()
        if search_txt:
            stats = [s for s in stats if search_txt in s['my_build'].lower() or search_txt in s['opp_strat'].lower()]
        if sort_mode == "Games Played":
            stats.sort(key=lambda x: x['total'], reverse=True)
        elif sort_mode == "Win Rate (High)":
            stats.sort(key=lambda x: (x['wins'] / x['total'] if x['total'] > 0 else 0), reverse=True)
        elif sort_mode == "Win Rate (Low)":
            stats.sort(key=lambda x: (x['wins'] / x['total'] if x['total'] > 0 else 0), reverse=False)
        for item in stats[:200]:
            wr = int((item['wins'] / item['total']) * 100) if item['total'] > 0 else 0
            color = wr_color(item['wins'], item['total'])
            row = ctk.CTkFrame(self._vs_strat_scroll, fg_color=("gray85", "gray20"))
            row.pack(fill="x", pady=2)
            ctk.CTkLabel(row, text=item['my_build'], width=300, anchor="w", font=FONT_SMALL).pack(side="left", padx=5)
            ctk.CTkLabel(row, text="vs", width=50, anchor="center", text_color="gray").pack(side="left")
            ctk.CTkLabel(row, text=item['opp_strat'], width=300, anchor="w", font=FONT_SMALL).pack(side="left", padx=5)
            ctk.CTkLabel(row, text=f"{wr}% ({item['wins']}W - {item['losses']}L)", width=150, anchor="e", text_color=color, font=("Arial", 11, "bold")).pack(side="right", padx=10)

    def _render_maps_tab(self):
        for w in self.tab_maps.winfo_children():
            w.destroy()
        ctk.CTkLabel(self.tab_maps, text="WIN RATE BY MAP", font=FONT_HEADING).pack(pady=10)
        scroll = ctk.CTkScrollableFrame(self.tab_maps)
        scroll.pack(fill="both", expand=True, padx=10, pady=5)
        map_stats: Dict[str, Dict] = {}
        for bd in self.analyzer.db.values():
            if not isinstance(bd, dict):
                continue
            for g in self._filtered_games(bd.get('games', []) or []):
                m = g.get('map', 'Unknown')
                if m not in map_stats:
                    map_stats[m] = {'wins': 0, 'losses': 0, 'other': 0}
                if g.get('result') == 'Win':
                    map_stats[m]['wins'] += 1
                elif g.get('result') == 'Loss':
                    map_stats[m]['losses'] += 1
                else:
                    map_stats[m]['other'] += 1
        items = sorted(map_stats.items(), key=lambda x: x[1]['wins'] + x[1]['losses'], reverse=True)
        for map_name, s in items:
            total = s['wins'] + s['losses']
            if total == 0:
                continue
            wr = int((s['wins'] / total) * 100)
            color = wr_color(s['wins'], total)
            row = ctk.CTkFrame(scroll, fg_color=("gray85", "gray20"))
            row.pack(fill="x", pady=3, padx=5)
            ctk.CTkLabel(row, text=map_name, font=FONT_BODY, anchor="w", width=250).pack(side="left", padx=10, pady=5)
            ctk.CTkLabel(row, text=f"{wr}%  ({s['wins']}W - {s['losses']}L)  -  {total} games", text_color=color, font=FONT_BODY).pack(side="right", padx=10, pady=5)

    def _render_matchups_tab(self):
        for w in self.tab_matchups.winfo_children():
            w.destroy()
        ctk.CTkLabel(self.tab_matchups, text="MATCHUP OVERVIEW", font=FONT_HEADING).pack(pady=10)
        mu_stats: Dict[str, Dict] = {}
        for bd in self.analyzer.db.values():
            if not isinstance(bd, dict):
                continue
            for g in self._filtered_games(bd.get('games', []) or []):
                mu = f"vs {g.get('opp_race', 'Unknown')}"
                if mu not in mu_stats:
                    mu_stats[mu] = {'wins': 0, 'losses': 0}
                if g.get('result') == 'Win':
                    mu_stats[mu]['wins'] += 1
                elif g.get('result') == 'Loss':
                    mu_stats[mu]['losses'] += 1
        frame = ctk.CTkFrame(self.tab_matchups, fg_color="transparent")
        frame.pack(pady=20)
        for i, (mu, s) in enumerate(sorted(mu_stats.items())):
            total = s['wins'] + s['losses']
            if total == 0:
                continue
            wr = int((s['wins'] / total) * 100)
            color = wr_color(s['wins'], total)
            card = ctk.CTkFrame(frame, fg_color=("gray85", "gray20"), width=200, height=100, corner_radius=10)
            card.grid(row=0, column=i, padx=15, pady=10)
            card.grid_propagate(False)
            ctk.CTkLabel(card, text=mu, font=FONT_HEADING).pack(pady=(15, 5))
            ctk.CTkLabel(card, text=f"{wr}%  ({s['wins']}W - {s['losses']}L)", text_color=color, font=("Arial", 16, "bold")).pack()

    def _render_definitions_tab(self):
        for w in self.tab_definitions.winfo_children():
            w.destroy()
        ctk.CTkLabel(self.tab_definitions, text="BUILD & STRATEGY DEFINITIONS", font=FONT_HEADING).pack(pady=10)
        scroll = ctk.CTkScrollableFrame(self.tab_definitions)
        scroll.pack(fill="both", expand=True, padx=10, pady=5)
        for name, desc in sorted(BUILD_DEFINITIONS.items()):
            row = ctk.CTkFrame(scroll, fg_color=("gray85", "gray20"))
            row.pack(fill="x", pady=2, padx=5)
            ctk.CTkLabel(row, text=name, width=300, anchor="w", font=("Arial", 11, "bold")).pack(side="left", padx=10, pady=5)
            ctk.CTkLabel(row, text=desc, anchor="w", font=("Arial", 11), wraplength=600).pack(side="left", padx=10, pady=5)

    # ------------------------------------------------------------ Opponents tab
    def _render_opponents_tab(self):
        """Two-pane Opponents view backed by `OpponentProfiler`.

        Left: searchable list of opponents (with min-games filter), right:
        detail panel for the currently selected opponent. Both panels are
        rebuilt on every render so the season filter and new replays show
        up immediately.
        """
        for w in self.tab_opponents.winfo_children():
            w.destroy()

        # Top control bar: search + min-games filter.
        ctrl = ctk.CTkFrame(self.tab_opponents, fg_color="transparent")
        ctrl.pack(fill="x", padx=10, pady=(10, 5))
        ctk.CTkLabel(ctrl, text="Search:").pack(side="left", padx=(5, 5))
        search_entry = ctk.CTkEntry(
            ctrl, textvariable=self._opp_search_var, width=220,
            placeholder_text="opponent name...",
        )
        search_entry.pack(side="left", padx=5)
        search_entry.bind("<KeyRelease>", lambda _e: self._render_opp_list())

        ctk.CTkLabel(ctrl, text="Min games:").pack(side="left", padx=(20, 5))
        ctk.CTkOptionMenu(
            ctrl, values=["1", "3", "5", "10", "20"],
            variable=self._opp_min_games_var, width=70,
            command=lambda _v: self._render_opp_list(),
        ).pack(side="left", padx=5)

        ctk.CTkLabel(
            self.tab_opponents, text="OPPONENTS",
            font=FONT_HEADING,
        ).pack(pady=(2, 6))

        # Two-pane body.
        body = ctk.CTkFrame(self.tab_opponents, fg_color="transparent")
        body.pack(fill="both", expand=True, padx=10, pady=5)
        body.grid_columnconfigure(0, weight=1, uniform="opp")
        body.grid_columnconfigure(1, weight=2, uniform="opp")
        body.grid_rowconfigure(0, weight=1)

        self._opp_list_frame = ctk.CTkScrollableFrame(body, label_text="Opponents")
        self._opp_list_frame.grid(row=0, column=0, sticky="nsew", padx=(0, 6))

        self._opp_detail_frame = ctk.CTkScrollableFrame(body, label_text="Profile")
        self._opp_detail_frame.grid(row=0, column=1, sticky="nsew", padx=(6, 0))

        self._render_opp_list()
        if self._opp_selected:
            self._render_opp_detail(self._opp_selected)
        else:
            self._render_opp_detail_empty()

    def _render_opp_list(self):
        """Populate the left pane with opponents matching search + min-games."""
        if self._opp_list_frame is None:
            return
        for w in self._opp_list_frame.winfo_children():
            w.destroy()

        try:
            min_games = int(self._opp_min_games_var.get() or "1")
        except ValueError:
            min_games = 1
        search_txt = (self._opp_search_var.get() or "").strip().lower()

        # Pass the active season cutoff down to the profiler so the W/L
        # counts and totals shown in the list reflect the season window
        # (not just the all-time roll-up filtered by last_seen).
        cutoff = self._season_cutoff_iso()
        try:
            profiler = self.analyzer.get_profiler()
            rows = profiler.list_opponents(
                min_games=min_games, since=cutoff,
            )
        except Exception as exc:
            ctk.CTkLabel(
                self._opp_list_frame,
                text=f"Could not load opponents:\n{exc}",
                text_color="#EF5350", font=FONT_SMALL, wraplength=300,
            ).pack(pady=20, padx=10)
            return

        if search_txt:
            rows = [r for r in rows if search_txt in (r.get("name", "") or "").lower()]

        if not rows:
            ctk.CTkLabel(
                self._opp_list_frame,
                text="No opponents match the current filter.",
                text_color="gray", font=FONT_SMALL, wraplength=280,
            ).pack(pady=20, padx=10)
            return

        ctk.CTkLabel(
            self._opp_list_frame,
            text=f"{len(rows)} opponent(s)",
            text_color="gray", font=FONT_SMALL, anchor="w",
        ).pack(fill="x", padx=6, pady=(0, 4))

        RENDER_LIMIT = 250
        for r in rows[:RENDER_LIMIT]:
            total = r["total"]
            wins = r["wins"]
            losses = r["losses"]
            wr = int((wins / total) * 100) if total > 0 else 0
            color = wr_color(wins, total)
            last_seen = (r.get("last_seen") or "")[:10] or "?"
            name = r["name"]

            card = ctk.CTkFrame(self._opp_list_frame, fg_color=("gray85", "gray20"))
            card.pack(fill="x", pady=2, padx=2)

            top = ctk.CTkFrame(card, fg_color="transparent")
            top.pack(fill="x", padx=8, pady=(4, 0))
            ctk.CTkLabel(
                top, text=name, font=("Arial", 12, "bold"),
                anchor="w",
            ).pack(side="left", fill="x", expand=True)
            ctk.CTkLabel(
                top, text=f"{total}g", text_color="gray",
                font=FONT_SMALL, anchor="e",
            ).pack(side="right")

            mid = ctk.CTkFrame(card, fg_color="transparent")
            mid.pack(fill="x", padx=8, pady=(0, 2))
            ctk.CTkLabel(
                mid, text=f"{wins}W - {losses}L ({wr}%)",
                text_color=color, font=FONT_SMALL, anchor="w",
            ).pack(side="left")
            ctk.CTkLabel(
                mid, text=f"last: {last_seen}",
                text_color="gray", font=FONT_SMALL, anchor="e",
            ).pack(side="right")

            ctk.CTkButton(
                card, text="View Profile", height=22,
                command=lambda n=name: self._opp_select(n),
            ).pack(fill="x", padx=8, pady=(2, 6))

        if len(rows) > RENDER_LIMIT:
            ctk.CTkLabel(
                self._opp_list_frame,
                text=f"Showing top {RENDER_LIMIT} of {len(rows)} - refine filter.",
                text_color="gray", font=FONT_SMALL,
            ).pack(pady=8)

    def _opp_select(self, name: str):
        self._opp_selected = name
        self._render_opp_detail(name)

    def _render_opp_detail_empty(self):
        if self._opp_detail_frame is None:
            return
        for w in self._opp_detail_frame.winfo_children():
            w.destroy()
        ctk.CTkLabel(
            self._opp_detail_frame,
            text="Select an opponent on the left to see their profile.",
            text_color="gray", font=FONT_BODY, wraplength=400,
        ).pack(pady=40, padx=20)

    def _render_opp_detail(self, name: str):
        """Render the right-hand profile card for the chosen opponent."""
        if self._opp_detail_frame is None:
            return
        for w in self._opp_detail_frame.winfo_children():
            w.destroy()

        try:
            profiler = self.analyzer.get_profiler()
            # Pass my_race so the timings grid can run matchup-aware. The
            # race is inferred from the build-name prefixes on this
            # opponent's games (builds are catalogued as "Zerg - ...",
            # "Protoss - ...", "Terran - ..."), which is the only race-of-
            # record stored on the game payload itself today.
            my_race = self._infer_my_race_for_opponent(name)
            # Honor the active season filter so the profile's timings,
            # map stats, top strategies, and recent games are all scoped
            # to the same window the rest of the app shows.
            since = self._season_cutoff_iso()
            prof = profiler.profile(name, my_race=my_race, since=since)
        except Exception as exc:
            ctk.CTkLabel(
                self._opp_detail_frame,
                text=f"Profile error: {exc}",
                text_color="#EF5350", font=FONT_SMALL, wraplength=500,
            ).pack(pady=20, padx=10)
            return

        if not prof or prof.get("total", 0) == 0:
            ctk.CTkLabel(
                self._opp_detail_frame,
                text=f"No games found for '{name}'.",
                text_color="gray", font=FONT_BODY,
            ).pack(pady=30, padx=10)
            return

        # Header: name + headline record.
        wins = prof["wins"]
        losses = prof["losses"]
        total = prof["total"]
        wr = int(round(prof["win_rate"] * 100))
        color = wr_color(wins, total)

        header = ctk.CTkFrame(self._opp_detail_frame, fg_color=("gray85", "gray18"))
        header.pack(fill="x", padx=4, pady=(0, 8))
        ctk.CTkLabel(
            header, text=prof["name"], font=FONT_TITLE, anchor="w",
        ).pack(anchor="w", padx=12, pady=(8, 0))
        ctk.CTkLabel(
            header,
            text=f"{wins}W - {losses}L ({wr}%) over {total} game(s)",
            font=FONT_HEADING, text_color=color, anchor="w",
        ).pack(anchor="w", padx=12, pady=(0, 4))
        last_seen = (prof.get("last_seen") or "")[:10]
        if last_seen:
            ctk.CTkLabel(
                header, text=f"Last seen: {last_seen}",
                font=FONT_SMALL, text_color="gray", anchor="w",
            ).pack(anchor="w", padx=12, pady=(0, 8))

        # Race distribution.
        race_dist = prof.get("race_distribution") or {}
        if race_dist:
            sec = ctk.CTkFrame(self._opp_detail_frame, fg_color=("gray85", "gray20"))
            sec.pack(fill="x", padx=4, pady=4)
            ctk.CTkLabel(
                sec, text="Races Played", font=FONT_HEADING, anchor="w",
            ).pack(anchor="w", padx=12, pady=(6, 2))
            for race, cnt in sorted(race_dist.items(), key=lambda kv: -kv[1]):
                pct = int(round(100 * cnt / total)) if total else 0
                ctk.CTkLabel(
                    sec, text=f"{race}: {cnt} ({pct}%)",
                    anchor="w", font=FONT_SMALL,
                ).pack(anchor="w", padx=20, pady=1)
            ctk.CTkLabel(sec, text="", height=4).pack()

        # Top strategies (with W/L per).
        top_strats = prof.get("top_strategies") or []
        if top_strats:
            sec = ctk.CTkFrame(self._opp_detail_frame, fg_color=("gray85", "gray20"))
            sec.pack(fill="x", padx=4, pady=4)
            ctk.CTkLabel(
                sec, text="Top Strategies (their openings)",
                font=FONT_HEADING, anchor="w",
            ).pack(anchor="w", padx=12, pady=(6, 2))
            for s in top_strats:
                strat = s["strategy"]
                cnt = s["count"]
                w_ = s["wins"]
                l_ = s["losses"]
                tot = w_ + l_
                wr_s = int(round(s["win_rate"] * 100)) if tot > 0 else 0
                row = ctk.CTkFrame(sec, fg_color="transparent")
                row.pack(fill="x", padx=20, pady=1)
                ctk.CTkLabel(
                    row, text=f"{strat}  x{cnt}",
                    anchor="w", font=FONT_SMALL,
                ).pack(side="left")
                if tot > 0:
                    rec_color = wr_color(w_, tot)
                    ctk.CTkLabel(
                        row, text=f"{w_}W - {l_}L ({wr_s}%)",
                        text_color=rec_color, font=FONT_SMALL, anchor="e",
                    ).pack(side="right")
            ctk.CTkLabel(sec, text="", height=4).pack()

        # Map performance.
        maps = prof.get("map_performance") or []
        if maps:
            sec = ctk.CTkFrame(self._opp_detail_frame, fg_color=("gray85", "gray20"))
            sec.pack(fill="x", padx=4, pady=4)
            ctk.CTkLabel(
                sec, text="Map Performance",
                font=FONT_HEADING, anchor="w",
            ).pack(anchor="w", padx=12, pady=(6, 2))
            for m in maps[:10]:
                mp = m["map"]
                w_ = m["wins"]
                l_ = m["losses"]
                tot = w_ + l_
                wr_m = int((w_ / tot) * 100) if tot > 0 else 0
                row = ctk.CTkFrame(sec, fg_color="transparent")
                row.pack(fill="x", padx=20, pady=1)
                ctk.CTkLabel(
                    row, text=mp, anchor="w", font=FONT_SMALL,
                ).pack(side="left")
                ctk.CTkLabel(
                    row, text=f"{w_}W - {l_}L ({wr_m}%)",
                    text_color=wr_color(w_, tot), font=FONT_SMALL, anchor="e",
                ).pack(side="right")
            ctk.CTkLabel(sec, text="", height=4).pack()

        # Median key timings - mirrors the SPA `MedianTimingsGrid` component
        # (reveal-sc2-opponent-main analyzer): a responsive card grid keyed
        # off the matchup-aware `median_timings` payload, with a `Both / Opp
        # tech / Your tech` source filter, click-to-drilldown modals, and
        # per-card hover tooltips. The empty-state fallback fires only when
        # *every* visible card has zero samples after filtering, so a partial
        # data set still surfaces the cards we do have.
        self._render_timing_grid(prof, opp_name=name)

        # Last 5 games.
        last5 = prof.get("last_5_games") or []
        if last5:
            sec = ctk.CTkFrame(self._opp_detail_frame, fg_color=("gray85", "gray20"))
            sec.pack(fill="x", padx=4, pady=4)
            ctk.CTkLabel(
                sec, text="Recent Games",
                font=FONT_HEADING, anchor="w",
            ).pack(anchor="w", padx=12, pady=(6, 2))
            for g in last5:
                res = g.get("result", "?")
                rc = COLOR_WIN if res == "Win" else (COLOR_LOSS if res == "Loss" else COLOR_NEUTRAL)
                length = g.get("game_length") or 0
                length_str = ""
                if length:
                    length_str = f" | {int(length) // 60}:{int(length) % 60:02d}"
                line = (
                    f"{g.get('date', '?')}  {g.get('map', '?')}  "
                    f"({g.get('opp_strategy', '?')}) vs my {g.get('my_build', '?')}"
                    f"{length_str}"
                )
                row = ctk.CTkFrame(sec, fg_color="transparent")
                row.pack(fill="x", padx=20, pady=1)
                ctk.CTkLabel(
                    row, text=line, anchor="w", font=FONT_SMALL,
                ).pack(side="left", fill="x", expand=True)
                ctk.CTkLabel(
                    row, text=res, text_color=rc,
                    font=("Arial", 11, "bold"), width=60, anchor="e",
                ).pack(side="right")
            ctk.CTkLabel(sec, text="", height=4).pack()

        # Predicted likely strategies (recency-weighted).
        try:
            preds = profiler.predict_likely_strategies(
                name, since=self._season_cutoff_iso(),
            )
        except Exception:
            preds = []
        if preds:
            sec = ctk.CTkFrame(self._opp_detail_frame, fg_color=("gray85", "gray20"))
            sec.pack(fill="x", padx=4, pady=4)
            ctk.CTkLabel(
                sec, text="Likely Next Strategy (recency-weighted)",
                font=FONT_HEADING, anchor="w",
            ).pack(anchor="w", padx=12, pady=(6, 2))
            for strat, prob in preds[:5]:
                row = ctk.CTkFrame(sec, fg_color="transparent")
                row.pack(fill="x", padx=20, pady=1)
                ctk.CTkLabel(
                    row, text=strat, anchor="w", font=FONT_SMALL,
                ).pack(side="left")
                ctk.CTkLabel(
                    row, text=f"{int(round(prob * 100))}%",
                    text_color="#90CAF9", font=FONT_SMALL, anchor="e",
                ).pack(side="right")
            ctk.CTkLabel(sec, text="", height=4).pack()

    # ----------------------------------------------------------- Deep dive
    def open_deep_dive(self, build_name: str, data: Dict, all_builds: List[str]):
        t = ctk.CTkToplevel(self)
        t.geometry("1100x900")
        t.title(f"Deep Dive: {build_name}")
        t.transient(self)
        t.lift()
        t.after(150, t.focus_force)

        self._dd_games_master = list(data['games'])
        self._dd_sort_mode = "Date (newest)"
        self._dd_games_sorted = self._sorted_dd_games(self._dd_games_master, self._dd_sort_mode)
        self._dd_page = 0
        self._dd_per_page = 50

        header_frame = ctk.CTkFrame(t)
        header_frame.pack(fill="x", padx=10, pady=10)
        ctk.CTkLabel(header_frame, text=build_name, font=FONT_TITLE).pack(side="left", padx=10)

        def rename_build_cmd():
            new_name = simpledialog.askstring("Rename Build", f"Enter new name for '{build_name}':", parent=t)
            if new_name:
                self.analyzer.rename_user_build(build_name, new_name)
                t.destroy()
                self.refresh_all_tabs()

        ctk.CTkButton(header_frame, text="Rename Build", command=rename_build_cmd, width=120, fg_color="#FBC02D", hover_color="#F9A825", text_color="black").pack(side="right", padx=10)

        stats_frame = ctk.CTkFrame(t)
        stats_frame.pack(fill="x", padx=10, pady=5)
        total_games = len(self._dd_games_sorted)
        wins = sum(1 for g in self._dd_games_sorted if g['result'] == "Win")
        losses = sum(1 for g in self._dd_games_sorted if g['result'] == "Loss")
        wr = int((wins / total_games) * 100) if total_games > 0 else 0
        ctk.CTkLabel(stats_frame, text=f"Total: {total_games} Games  |  Win Rate: {wr}% ({wins}W - {losses}L)", font=FONT_HEADING).pack(pady=5)

        list_label_frame = ctk.CTkFrame(t, fg_color="transparent")
        list_label_frame.pack(fill="x", pady=(10, 0), padx=10)
        self._dd_status_lbl = ctk.CTkLabel(list_label_frame, text="", font=FONT_HEADING)
        self._dd_status_lbl.pack(side="left")

        sort_options = [
            "Date (newest)", "Date (oldest)",
            "Macro (best)", "Macro (worst)",
            "Result (wins first)", "Game Length",
        ]

        def on_sort_change(choice: str):
            self._dd_sort_mode = choice
            self._dd_games_sorted = self._sorted_dd_games(self._dd_games_master, choice)
            self._dd_page = 0
            self._render_deep_dive_page(t, build_name, all_builds)

        ctk.CTkOptionMenu(list_label_frame, values=sort_options, command=on_sort_change, width=170).pack(side="right")
        ctk.CTkLabel(list_label_frame, text="Sort:", text_color="gray").pack(side="right", padx=(10, 4))

        self._dd_scroll_inner = ctk.CTkScrollableFrame(t)
        self._dd_scroll_inner.pack(fill="both", expand=True, padx=10, pady=5)

        footer = ctk.CTkFrame(t, height=50)
        footer.pack(fill="x", padx=10, pady=10)
        self._btn_prev = ctk.CTkButton(footer, text="<< Previous", width=100, command=lambda: self._change_page(-1, t, build_name, all_builds))
        self._btn_prev.pack(side="left", padx=20)
        self._btn_next = ctk.CTkButton(footer, text="Next >>", width=100, command=lambda: self._change_page(1, t, build_name, all_builds))
        self._btn_next.pack(side="right", padx=20)

        self._render_deep_dive_page(t, build_name, all_builds)

    @staticmethod
    def _sorted_dd_games(games: List[Dict], mode: str) -> List[Dict]:
        def macro_or_default(g: Dict, default: int) -> int:
            v = g.get('macro_score')
            return v if isinstance(v, (int, float)) else default
        if mode == "Date (newest)":
            return sorted(games, key=lambda x: x.get('date', ''), reverse=True)
        if mode == "Date (oldest)":
            return sorted(games, key=lambda x: x.get('date', ''))
        if mode == "Macro (best)":
            return sorted(games, key=lambda g: macro_or_default(g, -1), reverse=True)
        if mode == "Macro (worst)":
            return sorted(games, key=lambda g: macro_or_default(g, 101))
        if mode == "Result (wins first)":
            order = {"Win": 0, "Loss": 1}
            return sorted(games, key=lambda g: (order.get(g.get('result'), 2), g.get('date', '')))
        if mode == "Game Length":
            return sorted(games, key=lambda g: g.get('game_length') or 0, reverse=True)
        return games

    def _change_page(self, direction, toplevel, build_name, all_builds):
        self._dd_page += direction
        self._render_deep_dive_page(toplevel, build_name, all_builds)

    def _render_deep_dive_page(self, toplevel, build_name, all_builds):
        start_idx = self._dd_page * self._dd_per_page
        end_idx = start_idx + self._dd_per_page
        current_slice = self._dd_games_sorted[start_idx:end_idx]
        total_games = len(self._dd_games_sorted)
        self._dd_status_lbl.configure(text=f"Games {start_idx + 1} - {min(end_idx, total_games)} of {total_games}")
        self._btn_prev.configure(state="normal" if self._dd_page > 0 else "disabled")
        self._btn_next.configure(state="normal" if end_idx < total_games else "disabled")

        for w in self._dd_scroll_inner.winfo_children():
            w.destroy()

        for g in current_slice:
            row = ctk.CTkFrame(self._dd_scroll_inner, fg_color=("gray85", "gray20"))
            row.pack(fill="x", pady=4)
            color = COLOR_WIN if g['result'] == "Win" else (COLOR_LOSS if g['result'] == 'Loss' else COLOR_NEUTRAL)
            date_str = g.get('date', '')[:10]
            length_str = f" | {int(g.get('game_length')) // 60}:{int(g.get('game_length')) % 60:02d}" if g.get('game_length') else ""
            opp_strat_text = g.get('opp_strategy', '?')
            info = f"vs {g['opponent']} ({opp_strat_text}) | {g['result']} | {g['map']}{length_str} | {date_str}"

            top_line = ctk.CTkFrame(row, fg_color="transparent")
            top_line.pack(fill="x", padx=10, pady=(5, 0))
            ctk.CTkLabel(top_line, text=info, font=("Arial", 11, "bold"), text_color=color, anchor="w").pack(side="left", fill="x", expand=True)

            macro = g.get('macro_score')
            if isinstance(macro, (int, float)):
                # Clickable macro chip - opens a breakdown popup explaining
                # how the score was computed (SQ + per-discipline penalties
                # + leaks) and what the player did well.
                macro_btn = ctk.CTkButton(
                    top_line, text=f"Macro: {int(macro)}",
                    font=("Arial", 11, "bold"),
                    text_color=macro_score_color(int(macro)),
                    fg_color="transparent",
                    hover_color=("gray80", "gray30"),
                    width=80, height=22,
                    command=lambda gm=g: self._show_macro_breakdown(gm),
                )
                macro_btn.pack(side="right")
            else:
                ctk.CTkLabel(
                    top_line, text="Macro: --",
                    font=("Arial", 11), text_color="gray", width=80, anchor="e",
                ).pack(side="right")

            log_preview = " -> ".join(g.get('build_log', [])[:15])
            ctk.CTkLabel(row, text=log_preview, text_color="gray", font=FONT_SMALL, anchor="w", wraplength=900).pack(fill="x", padx=10)

            action_frame = ctk.CTkFrame(row, fg_color="transparent")
            action_frame.pack(fill="x", padx=10, pady=(0, 5))

            def open_vis(game_data=g):
                if not self.analyzer.selected_player_name:
                    messagebox.showerror("No Profile Selected", "Please select your name first.")
                    return
                GameVisualizerWindow(
                    toplevel, game_data, self.analyzer.selected_player_name,
                    analyzer=self.analyzer,
                )

            if g.get('file_path'):
                ctk.CTkButton(action_frame, text="Visualize", width=100, height=24, command=open_vis, fg_color="#388E3C", hover_color="#2E7D32").pack(side="left", padx=5)
            else:
                ctk.CTkButton(action_frame, text="Missing File", width=100, height=24, state="disabled", fg_color="gray").pack(side="left", padx=5)

            def edit_opp_strat(gid=g['id'], current=opp_strat_text):
                new_strat = simpledialog.askstring("Edit Opponent Strategy", f"Rename '{current}' to:", parent=toplevel)
                if new_strat:
                    self.analyzer.update_game_opponent_strategy(gid, new_strat)
                    toplevel.destroy()
                    self.refresh_all_tabs()

            ctk.CTkButton(action_frame, text="Edit Opp Strat", width=100, height=24, command=edit_opp_strat, fg_color="#0097A7", hover_color="#00ACC1").pack(side="left", padx=5)
            ctk.CTkLabel(action_frame, text="Reassign:", font=FONT_SMALL).pack(side="left", padx=(20, 5))

            def make_reassign_cmd(gid, old, top):
                def cmd(new_value):
                    if new_value and new_value != old:
                        self.analyzer.move_game(gid, old, new_value)
                        top.destroy()
                        self.refresh_all_tabs()
                return cmd

            combo = ctk.CTkComboBox(action_frame, values=all_builds, width=180, height=24, command=make_reassign_cmd(g['id'], build_name, toplevel))
            combo.set(build_name)
            combo.pack(side="left", padx=5)

            def make_delete_cmd(gid, bname, top):
                def cmd():
                    if messagebox.askyesno("Delete Game", "Remove this game from the database?", parent=top):
                        self.analyzer.delete_game(gid, bname)
                        top.destroy()
                        self.refresh_all_tabs()
                return cmd

            ctk.CTkButton(action_frame, text="X", width=30, height=24, fg_color="#B71C1C", hover_color="#D32F2F", command=make_delete_cmd(g['id'], build_name, toplevel)).pack(side="left", padx=3)

    # ====================================================================
    # Median key timings - matchup-aware card grid
    # ====================================================================
    #
    # Mirrors the SPA `MedianTimingsGrid` (reveal-sc2-opponent-main).
    # Methods below are private to the Opponents tab and read from the
    # ``profile()`` payload produced by ``OpponentProfiler``. The card
    # body, source filter, drilldown modal, and tooltip wiring all live
    # here so the rest of the tab stays untouched.
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
        ``my_race`` directly. Returns ``""`` if the games have no
        race-prefixed builds (which keeps timings empty rather than
        guessing).
        """
        from collections import Counter
        try:
            profiler = self.analyzer.get_profiler()
            games = profiler._games_for(opp_name)  # noqa: SLF001 - shared state
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
            head = bn.split(" - ", 1)[0]  # everything before the first " - "
            head_lower = head.lower()
            if head_lower.startswith("zerg"):
                counts["Z"] += 1
            elif head_lower.startswith("protoss"):
                counts["P"] += 1
            elif head_lower.startswith("terran"):
                counts["T"] += 1
            elif len(head) >= 2 and head[1] in ("v", "V") and head[0].upper() in ("P", "T", "Z"):
                # Matchup form: 'PvT', 'ZvP', 'TvZ'. First char is mine.
                counts[head[0].upper()] += 1
            else:
                # Last-resort: a leading 'P'/'T'/'Z' followed by a non-alpha
                # separator (e.g. "P - 4 Gate" if the user has a custom
                # one-letter prefix). Conservative -- skip if ambiguous.
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
        """Return a cached 40x40 CTkImage for this token, or ``None`` on failure.

        The cache lives on ``self._timing_icon_cache`` and is intentionally
        process-lifetime: CTkImage instances hold their own image refs and
        re-decoding the PNG on every render flickers the grid noticeably.
        Failures (missing file, Pillow not installed, decode error) are
        memoised as ``None`` so we don't retry the file system on every
        re-render.
        """
        cache = self._timing_icon_cache
        if internal_name in cache:
            return cache[internal_name]

        path = self._building_icon_path(icon_file)
        if not path:
            cache[internal_name] = None
            return None

        try:
            from PIL import Image  # Pillow already a dep elsewhere in ui/
            img = Image.open(path).convert("RGBA")
            ck_img = ctk.CTkImage(light_image=img, dark_image=img, size=(40, 40))
        except Exception as exc:
            # Log via the analyzer's error logger if available; otherwise
            # fall through silently. A broken icon is a cosmetic issue, not
            # a reason to crash the Opponents tab.
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
        (e.g. the chip was valid before, but the matchup has since aged
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
        """Return ``[(label, count), ...]`` chip data sorted by count desc.

        Empty list when ``matchup_counts`` is absent or empty (which
        means the chip row should not render at all).
        """
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
            profiler = self.analyzer.get_profiler()
            since = self._season_cutoff_iso()
            games = (
                profiler._games_for(opp_name, since=since)  # noqa: SLF001
                if profiler else []
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

    def _render_timing_grid(self, prof: Dict, opp_name: str) -> None:
        """Render the matchup-aware timing card grid into ``_opp_detail_frame``."""
        ml = prof.get("matchup_label") or ""

        sec = ctk.CTkFrame(self._opp_detail_frame, fg_color=("gray85", "gray20"))
        sec.pack(fill="x", padx=4, pady=4)

        title_text = (
            f"Median key timings - {ml}" if ml else "Median key timings"
        )
        ctk.CTkLabel(
            sec, text=title_text, font=FONT_HEADING, anchor="w",
        ).pack(anchor="w", padx=12, pady=(6, 0))
        ctk.CTkLabel(
            sec,
            text="Opponent tech parsed from opp_build_log; your tech from build_log.",
            font=FONT_SMALL, text_color="gray", anchor="w",
        ).pack(anchor="w", padx=12, pady=(0, 4))

        # ---- Matchup chips ("All  PvZ (8)  PvT (3) ...") ---------------
        # Only render when the opponent has played 2+ matchups - a single-
        # matchup opponent doesn't need a selector. The chip row sits
        # ABOVE the source filter so it reads as the primary scoping
        # control.
        chips = self._matchup_chip_labels(prof)
        active = self._active_matchup_for_opp(opp_name, [m for m, _ in chips])
        chip_row1 = None
        if len(chips) >= 2:
            chip_row1 = ctk.CTkFrame(sec, fg_color="transparent")
            chip_row1.pack(fill="x", padx=12, pady=(0, 4))
            ctk.CTkLabel(
                chip_row1, text="Matchup:",
                font=FONT_SMALL, text_color="gray",
            ).pack(side="left", padx=(0, 6))

            values = ["All"] + [f"{m} ({n})" for m, n in chips]
            # Map the displayed label back to the raw matchup string the
            # state dict stores ("All" or "PvZ" — never "PvZ (8)").
            display_to_raw = {"All": "All"}
            for m, n in chips:
                display_to_raw[f"{m} ({n})"] = m
            raw_to_display = {v: k for k, v in display_to_raw.items()}
            current_display = raw_to_display.get(active, "All")
            mu_var = ctk.StringVar(value=current_display)

            def _on_matchup_change(choice: str) -> None:
                raw = display_to_raw.get(choice, "All")
                self._set_active_matchup_for_opp(opp_name, raw)
                # Re-derive prof for the new matchup and rebuild the
                # grid body in place. The chip row + source filter row
                # stay where they are.
                new_prof = self._profile_for_matchup(prof, opp_name, raw)
                self._timing_grid_state["matchup_label"] = (
                    new_prof.get("matchup_label") or ""
                )
                self._timing_grid_state["order"] = list(
                    new_prof.get("median_timings_order") or []
                )
                self._render_timing_grid_body(
                    grid_holder, new_prof, opp_name,
                    str(self._opp_ui_state.get("timing_source_filter") or "Both"),
                )

            ctk.CTkSegmentedButton(
                chip_row1,
                values=values,
                variable=mu_var,
                command=_on_matchup_change,
            ).pack(side="left")

        # Resolve the profile view that drives the rest of this render.
        view_prof = self._profile_for_matchup(prof, opp_name, active)

        # ---- Source-filter chips (Both / Opp tech / Your tech) ---------
        chip_row = ctk.CTkFrame(sec, fg_color="transparent")
        chip_row.pack(fill="x", padx=12, pady=(0, 6))
        ctk.CTkLabel(
            chip_row, text="Show:", font=FONT_SMALL, text_color="gray",
        ).pack(side="left", padx=(0, 6))

        current = str(self._opp_ui_state.get("timing_source_filter") or "Both")
        if current not in ("Both", "Opp tech", "Your tech"):
            current = "Both"

        seg_var = ctk.StringVar(value=current)

        def _on_filter_change(choice: str) -> None:
            self._opp_ui_state["timing_source_filter"] = choice
            # Re-derive the view in case the user changed matchup since
            # this closure was defined.
            mu = self._active_matchup_for_opp(opp_name, [m for m, _ in chips])
            local_prof = self._profile_for_matchup(prof, opp_name, mu)
            self._render_timing_grid_body(grid_holder, local_prof, opp_name, choice)

        ctk.CTkSegmentedButton(
            chip_row,
            values=["Both", "Opp tech", "Your tech"],
            variable=seg_var,
            command=_on_filter_change,
        ).pack(side="left")

        # ---- Live summary (matches the SPA's aria-live status line) ----
        summary_lbl = ctk.CTkLabel(
            sec, text="", font=FONT_SMALL, text_color="gray", anchor="w",
        )
        summary_lbl.pack(anchor="w", padx=12, pady=(0, 4))
        self._timing_grid_state["summary_lbl"] = summary_lbl
        self._timing_grid_state["order"] = list(
            view_prof.get("median_timings_order") or []
        )
        self._timing_grid_state["matchup_label"] = view_prof.get("matchup_label") or ""
        self._timing_grid_state["matchup_counts"] = prof.get("matchup_counts") or {}
        self._timing_grid_state["active_matchup"] = active

        # The actual grid lives in its own scrollable frame so the cards
        # can scroll independently of the rest of the profile pane on
        # smaller resolutions.
        grid_holder = ctk.CTkScrollableFrame(
            sec, height=320, fg_color=("gray80", "gray18"),
        )
        grid_holder.pack(fill="both", expand=True, padx=8, pady=(2, 8))

        self._render_timing_grid_body(grid_holder, view_prof, opp_name, current)

    def _render_timing_grid_body(
        self,
        grid_holder: "ctk.CTkScrollableFrame",
        prof: Dict,
        opp_name: str,
        source_filter: str,
    ) -> None:
        """Populate the card grid honoring the active source filter."""
        for w in grid_holder.winfo_children():
            w.destroy()

        timings: Dict[str, Dict] = prof.get("median_timings") or {}
        order: List[str] = list(prof.get("median_timings_order") or [])
        ml = prof.get("matchup_label") or ""

        # Apply the source-filter chip.
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

        # Empty state. Only fire if EVERY visible card has zero samples
        # AFTER filtering - matches the prompt's contract.
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

        # ---- Responsive grid -------------------------------------------
        # CTk doesn't ship a CSS-grid equivalent, so we lay out the cards
        # ourselves: pick a column count from the rendered width, place
        # each card with `grid()`, and let `grid_columnconfigure(weight=1)`
        # handle horizontal stretching. The relayout closure re-runs on
        # `<Configure>` so resizing the window reflows the grid.
        CARD_MIN_W = 200
        CARD_PAD = 6

        # Token internal_name -> TimingToken catalog entry.
        tok_lookup: Dict[str, TimingToken] = {}
        for tokens in RACE_BUILDINGS.values():
            for t in tokens:
                tok_lookup[t.internal_name] = t

        # Pre-build the cards once; relayout just re-grids them.
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
                # Log-and-skip: a malformed token must never take down the
                # whole grid. The SPA does the same on its `try/catch`
                # boundary.
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
            # Reset any stale extra columns.
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
        """Construct a single card widget. Returns the unparented frame."""
        sample_count = int(info.get("sample_count") or 0)
        empty = sample_count == 0

        bg = ("gray82", "gray23") if not empty else ("gray80", "gray19")
        card = ctk.CTkFrame(parent, fg_color=bg, corner_radius=8)

        # Top row: icon + display name + median.
        top = ctk.CTkFrame(card, fg_color="transparent")
        top.pack(fill="x", padx=10, pady=(8, 2))

        icon_img = None
        if tok is not None:
            icon_img = self._get_timing_icon(internal_name, tok.icon_file)

        if icon_img is not None:
            icon_lbl = ctk.CTkLabel(top, text="", image=icon_img)
            icon_lbl.pack(side="left", padx=(0, 8))
        else:
            # Placeholder square keeps the card layout stable when an icon
            # is missing on disk; never a colored placeholder that could
            # be mistaken for real state.
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

        # Sub-line: p25-p75 range, or empty-state message.
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

        # Subtitle for empty cards lives one level higher visually so it
        # reads correctly even when the p25-p75 line is blank.
        if empty:
            ctk.CTkLabel(
                card,
                text="no samples in this matchup",
                font=FONT_SMALL, text_color="gray", anchor="w",
            ).pack(anchor="w", padx=10, pady=(0, 0))

        # Bottom row: n=, win-rate pill, trend arrow.
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
            wr_pill = ctk.CTkLabel(
                bot, text=wr_pct,
                font=FONT_SMALL, text_color="white",
                fg_color=wr_color_hex, corner_radius=8,
                width=44, height=18,
            )
            wr_pill.pack(side="left", padx=(8, 0))

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

        # ---- Click + keyboard to drill down --------------------------
        # Empty cards stay non-interactive (no drilldown), matching the
        # SPA's `if (sampleCount > 0) setDrillToken(tok)` guard. Cards
        # with samples respond to mouse, Enter, and Space, and reflect
        # keyboard focus by darkening their background so Tab navigation
        # is actually visible (mirrors :focus-visible on the web).
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
            # Keyboard handlers go on the outer card (the focus host).
            try:
                card.configure(cursor="hand2")
                # `takefocus=True` makes the card a Tab stop. <Return>
                # and <space> mirror the click target so the drilldown
                # is reachable without a mouse.
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
        """Toggle a visible focus halo on a timing card.

        We dont have CSS :focus-visible on Tk, so we just bump the
        cards background to a slightly darker shade while focused. The
        helper swallows TclError so a destroyed widget never bubbles up
        a stack trace into the Tk event loop.
        """
        try:
            if on:
                card.configure(fg_color=("gray72", "gray30"), border_width=2,
                               border_color="#42A5F5")
            else:
                card.configure(fg_color=("gray82", "gray23"), border_width=0)
        except Exception:
            pass

    # ------------------------------------------------------------------
    # Drilldown modal: lists every game that contributed to a timing.
    # Reuses the existing CTkToplevel pattern (see _show_debug_window /
    # _show_macro_breakdown above) instead of introducing a new dialog
    # framework.
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

        # ---- Header --------------------------------------------------
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

        # ---- Body: list of contributing games (lazy chunked) ---------
        body = ctk.CTkScrollableFrame(t)
        body.pack(fill="both", expand=True, padx=12, pady=4)

        rows = self._collect_timing_drilldown_rows(internal_name, opp_name)
        if not rows:
            ctk.CTkLabel(
                body,
                text="No contributing games found in the current DB.",
                text_color="gray", font=FONT_SMALL,
            ).pack(pady=20)
            load_more_btn = None
        else:
            # Lazy chunked rendering: paint the first chunk immediately so
            # the modal feels instant even on opponents with hundreds of
            # contributing games. The "Load next 50" sentinel takes the
            # next chunk on click; we keep one mutable counter inside the
            # closure so the button can mutate it without leaking state.
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
            load_more_btn = load_more_btn_holder[0]

        # ---- Footer ----------------------------------------------------
        # Copy-to-clipboard exports a Markdown table of the contributing
        # games -- handy for dropping into Discord notes or a postmortem
        # doc. The export uses the ENTIRE rows list, not just the rows
        # that have been lazily painted into the body.
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
                # Force the X11/Win clipboard sync so the value survives
                # the dialog being destroyed (Tk lazily keeps clipboard
                # ownership otherwise).
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

        Each row reproduces the fields the SPA drawer surfaces: date, map,
        my-race vs opp-race, the timestamp this token was first seen in
        that game, win/loss, and the source log we pulled it from. We
        rebuild the per-game timestamps here (rather than caching them on
        the profile payload) so the existing profile cache shape doesn't
        have to grow.
        """
        from analytics.opponent_profiler import _TIMING_RE

        try:
            profiler = self.analyzer.get_profiler()
            games = profiler._games_for(  # noqa: SLF001
                opp_name, since=self._season_cutoff_iso(),
            )
        except Exception:
            return []

        # Find the canonical token for this internal_name so we know its
        # substring-match key and which side's log to scan.
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
            log = g.get("build_log" if is_my_token else "opp_build_log") or []
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
                "map": g.get("map") or "—",
                "my_race": mine_letter,
                "opp_race": opp_race,
                "timestamp_seconds": best_t,
                "timestamp_display": (
                    f"{best_t // 60}:{best_t % 60:02d}"
                ),
                "result": g.get("result") or "?",
                "source": "build_log" if is_my_token else "opp_build_log",
                "id": g.get("id"),
                "file_path": g.get("file_path"),
                "my_build": g.get("my_build") or "",
            })

        rows.sort(key=lambda r: (r.get("date") or ""), reverse=True)
        return rows

    # Chunk size for the drilldown's lazy row renderer. 50 keeps the
    # initial paint snappy and lines up with the spec.
    _DRILLDOWN_CHUNK = 50

    @staticmethod
    def _format_drilldown_markdown(
        display_name: str,
        info: Dict,
        rows: List[Dict],
        matchup_label_str: str,
    ) -> str:
        """Render the contributing games as a Markdown table.

        Output is short enough to drop straight into Discord / Notes /
        postmortem docs. The header line summarises the matchup and the
        median/range; the table has one row per contributing game.
        """
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
        """Return a coarse relative-date label like '3d ago' / '2mo ago'."""
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
        """Click handler: open the existing full-game detail view.

        We reuse ``GameVisualizerWindow`` (the same window the Deep
        Dive build-order rows open) so the user lands in a familiar
        surface. The drilldown row stores enough of the underlying game
        record for the visualizer to load - if the file path is missing
        we fall back to a messagebox so the click never silently no-ops.
        """
        game_id = r.get("id")
        if not game_id:
            messagebox.showinfo(
                "Game record missing",
                "This drilldown row has no stored game id; cannot open "
                "the full-game viewer.",
            )
            return
        # Find the game record so the visualizer has the full payload.
        game_record: Optional[Dict] = None
        try:
            for build_name, bd in self.analyzer.db.items():
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
                "game. The Deep Dive view requires the .SC2Replay file "
                "to be present on disk.",
            )
            return
        if not getattr(self.analyzer, "selected_player_name", None):
            messagebox.showerror(
                "No Profile Selected",
                "Please select your player name before opening the "
                "full-game viewer.",
            )
            return
        try:
            GameVisualizerWindow(
                self, game_record, self.analyzer.selected_player_name,
                analyzer=self.analyzer,
            )
        except Exception as exc:
            messagebox.showerror("Failed to open game", str(exc))

    def _render_timing_drilldown_row(self, parent: tk.Widget, r: Dict) -> None:
        """One row of the drilldown list. Click anywhere opens the game."""
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
        # Win/Loss pill - small, color-coded, matches the timing-card pill.
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
        # Tooltip surfaces the absolute date on hover so the user can
        # disambiguate "3d ago" without having to read every line.
        Tooltip(date_lbl, text=(date_str or "(unknown date)"))
        # Source badge: opp_log / my_log. Same wording as the Markdown
        # export so the in-modal label and the clipboard match exactly.
        src_short = (
            "opp_log" if (r.get("source") or "") == "opp_build_log"
            else "my_log"
        )
        ctk.CTkLabel(
            line2, text=src_short,
            font=FONT_SMALL, text_color="gray", anchor="e",
        ).pack(side="right")

        # Click anywhere on the row -> open GameVisualizerWindow.
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
