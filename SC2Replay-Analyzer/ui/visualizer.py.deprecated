"""Per-game graph window (Supply / Income / Army Value / Win Probability over time)."""

import os
import threading
from tkinter import messagebox
from typing import Dict

import customtkinter as ctk

from analytics.macro_score import macro_score_color
from analytics.win_probability import (
    SnapshotFeatureExtractor,
    WinProbabilityModel,
)
from core.replay_loader import extract_graph_data, load_replay_with_fallback
from .theme import (
    COLOR_LOSS,
    COLOR_P1,
    COLOR_P1_DIM,
    COLOR_P2,
    COLOR_P2_DIM,
    COLOR_WIN,
    GRAPH_BG,
    GRAPH_FG,
)

HAS_MATPLOTLIB = False
try:
    import matplotlib
    matplotlib.use("TkAgg")
    from matplotlib.backends.backend_tkagg import FigureCanvasTkAgg
    from matplotlib.figure import Figure
    HAS_MATPLOTLIB = True
except ImportError:
    print("Matplotlib not found or incompatible. Graphing disabled.")


class GameVisualizerWindow(ctk.CTkToplevel):
    _wp_slot = None
    _wp_pending_curve = None
    _wp_pending_status = ""

    def __init__(self, parent, game_data: Dict, player_name: str, analyzer=None):
        super().__init__(parent)
        self.game_data = game_data
        self.player_name = player_name
        self.analyzer = analyzer
        self.title(f"Visualizer: {game_data.get('map', 'Unknown')} vs {game_data.get('opponent', '?')}")
        self.geometry("1100x800")
        self.transient(parent)
        self.lift()
        self.after(200, lambda: self.focus_force())

        self.grid_columnconfigure(0, weight=1)
        self.grid_rowconfigure(2, weight=1)

        header = ctk.CTkFrame(self)
        header.grid(row=0, column=0, sticky="ew", padx=10, pady=10)
        title_text = f"Analyzed: {game_data.get('date', '')[:10]} | Result: {game_data.get('result')}"
        ctk.CTkLabel(header, text=title_text, font=("Arial", 16, "bold")).pack(pady=5)
        self.status_lbl = ctk.CTkLabel(header, text="Parsing replay for stats...", text_color="orange")
        self.status_lbl.pack(pady=5)

        self.macro_slot = ctk.CTkFrame(self, fg_color="transparent")
        self.macro_slot.grid(row=1, column=0, sticky="ew", padx=10, pady=(0, 5))

        self.content_frame = ctk.CTkScrollableFrame(self)
        self.content_frame.grid(row=2, column=0, sticky="nsew", padx=10, pady=10)

        button_row = ctk.CTkFrame(self, fg_color="transparent")
        button_row.grid(row=3, column=0, pady=10)
        ctk.CTkButton(
            button_row, text="Map Playback", command=self._open_map_playback,
            fg_color="#1565C0", hover_color="#0D47A1", width=140,
        ).pack(side="left", padx=6)
        ctk.CTkButton(
            button_row, text="Close", command=self.destroy,
            fg_color="#D32F2F", width=100,
        ).pack(side="left", padx=6)

        self._wp_slot = None
        self._wp_pending_curve = None
        self._wp_pending_status = ""

        self._render_macro_report()

        file_path = game_data.get('file_path')
        if not file_path or not os.path.exists(file_path):
            self.status_lbl.configure(text=f"Error: Replay file not found at {file_path}", text_color="#EF5350")
            return

        if self.game_data.get("macro_score") is None:
            threading.Thread(
                target=self._compute_macro_on_demand, args=(file_path,), daemon=True,
            ).start()

        threading.Thread(target=self._load_data, args=(file_path,), daemon=True).start()
        threading.Thread(
            target=self._load_win_probability, args=(file_path,), daemon=True,
        ).start()

    def _open_map_playback(self):
        """Spawn the interactive map playback window for this replay."""
        file_path = self.game_data.get("file_path")
        if not file_path or not os.path.exists(file_path):
            messagebox.showerror(
                "Map Playback",
                f"Replay file not found:\n{file_path}",
            )
            return
        # Lazy import so the desktop app starts even if Tk Canvas isn't
        # available in some niche environment.
        from .map_viewer import MapViewerWindow
        # Augment game_data with the map name we already know.
        # (MapViewerWindow looks up bounds by `game_data['map']`.)
        MapViewerWindow(self, self.game_data, self.player_name)

    def _compute_macro_on_demand(self, file_path: str):
        try:
            from analytics.macro_score import compute_macro_score
            from core.event_extractor import extract_macro_events
            replay = load_replay_with_fallback(file_path)
            me = next(
                (p for p in replay.players if p.name == self.player_name), None,
            )
            if not me:
                return
            length = getattr(replay, "game_length", None)
            length_sec = length.seconds if length else 0
            macro_events = extract_macro_events(replay, me.pid)
            result = compute_macro_score(macro_events, me.play_race, length_sec)
            score = result.get("macro_score")
            leaks = result.get("top_3_leaks", []) or []
            self.game_data["macro_score"] = score
            self.game_data["top_3_leaks"] = leaks
            if self.analyzer is not None:
                try:
                    self._persist_macro_to_db(score, leaks)
                except Exception as exc:
                    print(f"Macro persist failed: {exc}")
        except Exception as exc:
            print(f"On-demand macro compute failed for {file_path}: {exc}")
            return
        self.after(0, self._render_macro_report)

    def _persist_macro_to_db(self, score, leaks):
        gid = self.game_data.get("id")
        if not gid:
            return
        try:
            with self.analyzer._lock:
                for build_name, bd in self.analyzer.db.items():
                    if not isinstance(bd, dict):
                        continue
                    for g in bd.get("games", []) or []:
                        if g.get("id") == gid:
                            g["macro_score"] = score
                            g["top_3_leaks"] = leaks
                            break
        except Exception:
            pass
        try:
            self.analyzer.save_database()
        except Exception:
            pass

    def _render_macro_report(self):
        for w in self.macro_slot.winfo_children():
            w.destroy()

        score = self.game_data.get("macro_score")
        leaks = self.game_data.get("top_3_leaks") or []
        is_computing = (
            score is None
            and self.game_data.get("file_path")
            and os.path.exists(self.game_data.get("file_path") or "")
        )

        card = ctk.CTkFrame(self.macro_slot, fg_color=("gray85", "gray18"))
        card.pack(fill="x", padx=0, pady=0)

        header = ctk.CTkFrame(card, fg_color="transparent")
        header.pack(fill="x", padx=14, pady=(10, 4))
        ctk.CTkLabel(
            header, text="Macro Report",
            font=("Arial", 16, "bold"), anchor="w",
        ).pack(side="left")

        body = ctk.CTkFrame(card, fg_color="transparent")
        body.pack(fill="x", padx=14, pady=(0, 10))

        if score is None:
            score_text = "..." if is_computing else "--"
            score_color = "#90A4AE"
            tagline = (
                "Computing macro score in the background - this takes a few seconds."
                if is_computing
                else "Macro score not computed (replay file is missing)."
            )
        else:
            score_text = str(score)
            score_color = macro_score_color(score)
            tagline = self._tagline_for_score(score)

        score_frame = ctk.CTkFrame(body, fg_color="transparent")
        score_frame.pack(side="left", padx=(0, 18))
        ctk.CTkLabel(
            score_frame, text=score_text,
            font=("Arial", 56, "bold"), text_color=score_color,
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
                text="No leaks detected - clean macro.",
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
            unit = "s" if "Blocked" in leak.get("name", "") \
                       or "Idle" in leak.get("name", "") \
                       or "Oversaturation" in leak.get("name", "") else ""
            qty_text = f"{qty:.0f}{unit}" if unit else f"{int(qty)}"
            ctk.CTkLabel(
                row, text=f"  *  {leak.get('name', '?')}",
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
            return "Fixable leaks - macro is the next thing to grind."
        return "Macro is the limiting factor here. Start with the top leak."

    def _load_data(self, file_path):
        data = extract_graph_data(file_path, self.player_name)
        self.after(0, lambda: self._render_graphs(data))

    def _render_graphs(self, data):
        if not HAS_MATPLOTLIB:
            messagebox.showerror(
                "Graphing Error",
                "Matplotlib is not installed or incompatible.\nInstall Python 3.11/3.12 and run: pip install matplotlib",
            )
            return
        self.status_lbl.configure(text="Data loaded.", text_color="#66BB6A")
        p1_name, p2_name = data['me_name'], data['opp_name']

        def create_figure(title, y_label):
            fig = Figure(figsize=(9, 4), dpi=100)
            fig.patch.set_facecolor(GRAPH_BG)
            ax = fig.add_subplot(111)
            ax.set_facecolor(GRAPH_BG)
            ax.set_title(title, color=GRAPH_FG)
            ax.set_xlabel("Time (Minutes)", color=GRAPH_FG)
            ax.set_ylabel(y_label, color=GRAPH_FG)
            ax.tick_params(axis='x', colors=GRAPH_FG)
            ax.tick_params(axis='y', colors=GRAPH_FG)
            ax.grid(True, color="#444444", linestyle='--', alpha=0.5)
            for spine in ax.spines.values():
                spine.set_edgecolor(GRAPH_FG)
            return fig, ax

        fig1, ax1 = create_figure(f"Supply Flow: {p1_name} vs {p2_name}", "Supply")
        x1 = [x['time'] for x in data['p1_series']]
        x2 = [x['time'] for x in data['p2_series']]
        ax1.plot(x1, [x['cap'] for x in data['p1_series']], color=COLOR_P1, linestyle=':', alpha=0.5, label=f"{p1_name} Cap")
        ax1.plot(x1, [x['supply'] for x in data['p1_series']], color=COLOR_P1, linewidth=2, label=f"{p1_name} Used")
        ax1.plot(x2, [x['cap'] for x in data['p2_series']], color=COLOR_P2, linestyle=':', alpha=0.5, label=f"{p2_name} Cap")
        ax1.plot(x2, [x['supply'] for x in data['p2_series']], color=COLOR_P2, linewidth=2, label=f"{p2_name} Used")
        ax1.legend(facecolor=GRAPH_BG, labelcolor=GRAPH_FG)

        fig2, ax2 = create_figure("Resource Collection Rate (Income)", "Resources / Min")
        ax2.plot(x1, [x['min_rate'] for x in data['p1_series']], color=COLOR_P1, label=f"{p1_name} Minerals")
        ax2.plot(x1, [x['gas_rate'] for x in data['p1_series']], color=COLOR_P1_DIM, linestyle='--', label=f"{p1_name} Gas")
        ax2.plot(x2, [x['min_rate'] for x in data['p2_series']], color=COLOR_P2, label=f"{p2_name} Minerals")
        ax2.plot(x2, [x['gas_rate'] for x in data['p2_series']], color=COLOR_P2_DIM, linestyle='--', label=f"{p2_name} Gas")
        ax2.legend(facecolor=GRAPH_BG, labelcolor=GRAPH_FG)

        fig3, ax3 = create_figure("Army Value (Minerals + Gas)", "Value")
        y1_army = [x['army_val'] for x in data['p1_series']]
        y2_army = [x['army_val'] for x in data['p2_series']]
        ax3.fill_between(x1, y1_army, color=COLOR_P1, alpha=0.3)
        ax3.plot(x1, y1_army, color=COLOR_P1, label=p1_name)
        ax3.fill_between(x2, y2_army, color=COLOR_P2, alpha=0.3)
        ax3.plot(x2, y2_army, color=COLOR_P2, label=p2_name)
        ax3.legend(facecolor=GRAPH_BG, labelcolor=GRAPH_FG)

        for fig in [fig1, fig2, fig3]:
            canvas = FigureCanvasTkAgg(fig, master=self.content_frame)
            canvas.draw()
            canvas.get_tk_widget().pack(fill="x", pady=10, padx=10)

        self._wp_slot = ctk.CTkFrame(self.content_frame, fg_color="transparent")
        self._wp_slot.pack(fill="x", pady=10, padx=10)
        if self._wp_pending_curve is not None:
            self._render_win_probability(self._wp_pending_curve, self._wp_pending_status)
            self._wp_pending_curve = None
            self._wp_pending_status = ""

    def _load_win_probability(self, file_path: str):
        try:
            wp_model = WinProbabilityModel.load_or_new()
        except Exception as exc:
            self.after(0, lambda exc=exc: self._stash_or_render_wp(
                None, f"Win-probability model not available: {exc}"))
            return

        if wp_model.model is None:
            from analytics.win_probability import cold_start_status
            db = getattr(self.analyzer, "db", {}) if self.analyzer is not None else {}
            cold = cold_start_status(db)
            need = cold["needed"]
            if need > 0:
                msg = (
                    f"Win-Probability model is not trained yet "
                    f"(need {need} more game(s) - minimum {cold['minimum']}). "
                    f"Click 'Train WP Model' in the sidebar after collecting more replays."
                )
            else:
                msg = (
                    "Win-Probability model is not trained yet. "
                    "Click 'Train WP Model' in the sidebar."
                )
            self.after(0, lambda m=msg: self._stash_or_render_wp(None, m))
            return

        try:
            replay = load_replay_with_fallback(file_path)
            me = next(
                (p for p in replay.players if p.name == self.player_name), None,
            )
            if me is None:
                from analytics.win_probability import WinProbabilityModel as _WP
                me = _WP._resolve_me(replay, self.game_data, self.player_name)
            if me is None:
                self.after(0, lambda: self._stash_or_render_wp(
                    None, "Could not resolve your player in this replay."))
                return
            features = SnapshotFeatureExtractor().extract(replay, me.pid)
            if features.empty:
                self.after(0, lambda: self._stash_or_render_wp(
                    None, "No PlayerStatsEvent samples in this replay."))
                return
            curve = wp_model.predict_curve(features)
            if not curve:
                self.after(0, lambda: self._stash_or_render_wp(
                    None, "WP model returned an empty curve."))
                return
        except Exception as exc:
            self.after(0, lambda exc=exc: self._stash_or_render_wp(
                None, f"WP curve failed: {exc}"))
            return

        meta = {
            "auc": wp_model.auc,
            "trained_on": wp_model.games_used,
            "result": self.game_data.get("result", "Unknown"),
            "last_trained": wp_model.last_trained,
        }
        self.after(0, lambda c=curve, m=meta: self._stash_or_render_wp(c, "", meta=m))

    def _stash_or_render_wp(self, curve, status_message, meta=None):
        if self._wp_slot is None:
            self._wp_pending_curve = (curve, meta)
            self._wp_pending_status = status_message
            return
        self._render_win_probability((curve, meta), status_message)

    def _render_win_probability(self, payload, status_message: str):
        if not HAS_MATPLOTLIB:
            return
        if self._wp_slot is None:
            return
        for w in self._wp_slot.winfo_children():
            w.destroy()

        curve = None
        meta = None
        if payload is not None:
            curve, meta = payload

        if not curve:
            ctk.CTkLabel(
                self._wp_slot,
                text=status_message or "Win Probability not available.",
                text_color=COLOR_LOSS, font=("Arial", 12),
                wraplength=900, justify="left", anchor="w",
            ).pack(fill="x", padx=10, pady=20)
            return

        minutes = [m for m, _ in curve]
        probs = [100.0 * p for _, p in curve]

        if meta is not None:
            auc_txt = f"AUC {meta['auc']:.2f}" if meta.get("auc") is not None else "AUC n/a"
            extra = f"  |  trained on {meta.get('trained_on', '?')} games  |  {auc_txt}"
            if meta.get("last_trained"):
                extra += f"  |  retrained {meta['last_trained']}"
        else:
            extra = ""

        fig = Figure(figsize=(9, 4), dpi=100)
        fig.patch.set_facecolor(GRAPH_BG)
        ax = fig.add_subplot(111)
        ax.set_facecolor(GRAPH_BG)
        ax.set_title(f"Win Probability - you{extra}", color=GRAPH_FG)
        ax.set_xlabel("Time (Minutes)", color=GRAPH_FG)
        ax.set_ylabel("p(Win) %", color=GRAPH_FG)
        ax.tick_params(axis='x', colors=GRAPH_FG)
        ax.tick_params(axis='y', colors=GRAPH_FG)
        ax.grid(True, color="#444444", linestyle='--', alpha=0.5)
        for spine in ax.spines.values():
            spine.set_edgecolor(GRAPH_FG)
        ax.set_ylim(0, 100)
        if minutes:
            ax.set_xlim(min(minutes), max(minutes))

        fifty = [50.0] * len(minutes)
        ax.fill_between(
            minutes, probs, fifty,
            where=[p >= 50.0 for p in probs], interpolate=True,
            color=COLOR_WIN, alpha=0.35, linewidth=0,
            label="Favoured",
        )
        ax.fill_between(
            minutes, probs, fifty,
            where=[p < 50.0 for p in probs], interpolate=True,
            color=COLOR_LOSS, alpha=0.35, linewidth=0,
            label="Behind",
        )

        ax.plot(minutes, probs, color=COLOR_P1, linewidth=2.0, label="p(Win)")
        ax.axhline(50, color="#CCCCCC", linestyle="--", linewidth=1.0, alpha=0.7)

        if meta is not None:
            res = meta.get("result", "Unknown")
            res_color = COLOR_WIN if res == "Win" else (
                COLOR_LOSS if res == "Loss" else "#CCCCCC"
            )
            ax.text(
                0.99, 0.97, f"Actual: {res}",
                transform=ax.transAxes, color=res_color,
                ha="right", va="top",
                fontsize=10, fontweight="bold",
                bbox=dict(facecolor=GRAPH_BG, edgecolor=res_color, alpha=0.85),
            )

        ax.legend(facecolor=GRAPH_BG, labelcolor=GRAPH_FG, loc="lower left")
        fig.tight_layout()

        canvas = FigureCanvasTkAgg(fig, master=self._wp_slot)
        canvas.draw()
        canvas.get_tk_widget().pack(fill="x", pady=4, padx=0)
