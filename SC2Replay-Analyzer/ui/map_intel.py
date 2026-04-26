"""Map Intel tab — spatial heatmaps over a chosen map.

Reuses the same canvas-rendering coordinate system as ``ui/map_viewer.py``
(``_project`` / ``_scale`` / bounds box / start locations) so a heatmap
overlays correctly on top of the map background. The heatmap itself is
rendered via matplotlib's ``imshow`` into a hidden Figure and then either
embedded with ``FigureCanvasTkAgg`` (when matplotlib is available) or
"baked" into a Tkinter ``PhotoImage`` for the canvas to drop on top of
the map background.

Workflow
--------
1. The user picks a map from the dropdown (only maps with >= 3 games appear).
2. They toggle one of the four overlays:
       * Building heatmap (mine)        — viridis density
       * Building heatmap (opponent)    — viridis density
       * Proxy heatmap (opponent only)  — viridis density
       * Battle heatmap                 — viridis density
       * Death-zone grid                — RdYlGn_r diverging map
3. The aggregator (``analytics.spatial.SpatialAggregator``) walks every
   replay on that map, caching each one's spatial extract on disk so a
   second toggle of the same overlay is instant.
"""

from __future__ import annotations

import threading
import tkinter as tk
from typing import Dict, List, Optional

import customtkinter as ctk

from analytics.spatial import (
    DEATH_ZONE_RES,
    DENSITY_RES,
    MIN_GAMES_FOR_MAP,
    SpatialAggregator,
)
from core.map_playback_data import bounds_for as _bounds_for

from .theme import (
    COLOR_LOSS,
    COLOR_NEUTRAL,
    COLOR_WIN,
    GRAPH_BG,
    GRAPH_FG,
)


# Pull matplotlib lazily — the tab still opens without it, just without the
# rendered heatmap (the user gets a friendly message).
_HAS_MPL = False
try:
    import matplotlib  # noqa: F401
    matplotlib.use("TkAgg")
    from matplotlib.backends.backend_tkagg import FigureCanvasTkAgg
    from matplotlib.figure import Figure
    _HAS_MPL = True
except Exception:  # pragma: no cover - tolerated
    Figure = None  # type: ignore
    FigureCanvasTkAgg = None  # type: ignore


CANVAS_PX = 720
PAD_PX = 18

OVERLAY_BUILDINGS_ME    = "buildings_me"
OVERLAY_BUILDINGS_OPP   = "buildings_opp"
OVERLAY_PROXY           = "proxy"
OVERLAY_BATTLE          = "battle"
OVERLAY_DEATH_ZONE      = "death_zone"


class MapIntelTab:
    """The actual Map Intel tab embedded inside ``App.tabview.add(...)``.

    Constructed by :class:`ui.app.App` once the analyzer is wired up. The
    parent frame is a ``CTkFrame`` (the tab itself); we own all child widgets
    and rebuild them when the active overlay changes.
    """

    def __init__(self, parent: ctk.CTkFrame, analyzer, player_name_getter):
        self.parent = parent
        self.analyzer = analyzer
        self._player_name_getter = player_name_getter
        # The aggregator is constructed lazily so opening the tab when the
        # database is empty doesn't pay the import cost of scipy.
        self._aggregator: Optional[SpatialAggregator] = None
        self._mpl_canvas = None
        self._figure = None
        self._heatmap_image_id: Optional[int] = None
        self._active_overlay: str = OVERLAY_BUILDINGS_ME
        self._current_map: Optional[str] = None
        self._current_bounds: Dict = {}
        self._render_lock = threading.Lock()

        # ------------------- top toolbar (map dropdown + overlay toggles)
        bar = ctk.CTkFrame(parent, fg_color="transparent")
        bar.pack(fill="x", padx=10, pady=(10, 6))

        ctk.CTkLabel(bar, text="Map:").pack(side="left", padx=(4, 4))
        self.map_var = ctk.StringVar(value="(no maps with 3+ games)")
        self.map_menu = ctk.CTkOptionMenu(
            bar, variable=self.map_var,
            values=["(no maps with 3+ games)"],
            width=260, command=self._on_map_change,
        )
        self.map_menu.pack(side="left", padx=4)

        # Overlay toggle buttons. We render them as a row of toggleable
        # buttons rather than radio buttons so the active overlay is more
        # visually obvious in this dark theme.
        self._toggle_buttons: Dict[str, ctk.CTkButton] = {}
        for ov_id, label, color in (
            (OVERLAY_BUILDINGS_ME,  "Buildings (me)",   "#1565C0"),
            (OVERLAY_BUILDINGS_OPP, "Buildings (opp)",  "#D84315"),
            (OVERLAY_PROXY,         "Proxy (opp)",      "#FBC02D"),
            (OVERLAY_BATTLE,        "Battles",          "#7E57C2"),
            (OVERLAY_DEATH_ZONE,    "Death zones",      "#388E3C"),
        ):
            btn = ctk.CTkButton(
                bar, text=label, width=120, fg_color="gray30",
                hover_color="gray35",
                command=lambda o=ov_id: self._on_overlay_change(o),
            )
            btn.pack(side="left", padx=2)
            self._toggle_buttons[ov_id] = btn

        # Right side: status text.
        self.status_lbl = ctk.CTkLabel(
            bar, text="", text_color="gray", font=("Arial", 11),
        )
        self.status_lbl.pack(side="right", padx=10)

        # ------------------- main canvas area
        canvas_frame = ctk.CTkFrame(parent, fg_color="transparent")
        canvas_frame.pack(fill="both", expand=True, padx=10, pady=(0, 10))
        self.canvas = tk.Canvas(
            canvas_frame, width=CANVAS_PX, height=CANVAS_PX,
            bg="#15191F", highlightthickness=0,
        )
        self.canvas.pack(expand=True)

        # ------------------- footer legend
        legend = ctk.CTkFrame(parent, fg_color="transparent")
        legend.pack(fill="x", padx=10, pady=(0, 10))
        self.legend_lbl = ctk.CTkLabel(
            legend, text="(pick a map and an overlay)",
            text_color="gray", font=("Arial", 11),
        )
        self.legend_lbl.pack(side="left")

        if not _HAS_MPL:
            self.status_lbl.configure(
                text="matplotlib missing — overlays disabled",
                text_color=COLOR_LOSS,
            )
        self._highlight_overlay(self._active_overlay)

    # --------------------------------------------------------- public API
    def refresh(self) -> None:
        """Re-read the database and rebuild the map dropdown.

        Called by ``App.refresh_all_tabs()`` after replays are added or the
        season filter changes.
        """
        if self._aggregator is None:
            self._aggregator = SpatialAggregator(
                self.analyzer.db, player_name=self._player_name_getter(),
            )
        else:
            self._aggregator.set_player_name(self._player_name_getter())

        rows = self._aggregator.list_maps_with_min_games(MIN_GAMES_FOR_MAP)
        if not rows:
            self.map_menu.configure(values=["(no maps with 3+ games)"])
            self.map_var.set("(no maps with 3+ games)")
            self._current_map = None
            self._draw_empty()
            return
        labels = [f"{r['name']}  ({r['total']} games)" for r in rows]
        self.map_menu.configure(values=labels)
        # Preserve the current selection if it's still valid.
        if self._current_map and any(
            r["name"] == self._current_map for r in rows
        ):
            for lbl, r in zip(labels, rows):
                if r["name"] == self._current_map:
                    self.map_var.set(lbl)
                    break
        else:
            self.map_var.set(labels[0])
            self._current_map = rows[0]["name"]
        self._reload_overlay()

    # ---------------------------------------------------------- handlers
    def _on_map_change(self, choice: str) -> None:
        # Strip the "(N games)" suffix to recover the bare map name.
        name = choice
        if "  (" in choice:
            name = choice.split("  (", 1)[0]
        self._current_map = name
        self._reload_overlay()

    def _on_overlay_change(self, overlay: str) -> None:
        self._active_overlay = overlay
        self._highlight_overlay(overlay)
        self._reload_overlay()

    def _highlight_overlay(self, overlay: str) -> None:
        for ov_id, btn in self._toggle_buttons.items():
            if ov_id == overlay:
                btn.configure(fg_color="#1f538d", hover_color="#1565C0")
            else:
                btn.configure(fg_color="gray30", hover_color="gray35")

    # ------------------------------------------------------------ render
    def _reload_overlay(self) -> None:
        if not self._aggregator or not self._current_map:
            self._draw_empty()
            return

        self.status_lbl.configure(
            text=f"Loading {self._active_overlay} on {self._current_map}…",
            text_color=COLOR_NEUTRAL,
        )
        threading.Thread(
            target=self._compute_and_render, daemon=True,
        ).start()

    def _compute_and_render(self) -> None:
        if not self._aggregator or not self._current_map:
            return
        try:
            ov = self._active_overlay
            if ov == OVERLAY_BUILDINGS_ME:
                payload = self._aggregator.building_heatmap(
                    self._current_map, owner="me",
                )
            elif ov == OVERLAY_BUILDINGS_OPP:
                payload = self._aggregator.building_heatmap(
                    self._current_map, owner="opponent",
                )
            elif ov == OVERLAY_PROXY:
                payload = self._aggregator.proxy_heatmap(self._current_map)
            elif ov == OVERLAY_BATTLE:
                payload = self._aggregator.battle_heatmap(self._current_map)
            else:
                payload = self._aggregator.death_zone_grid(
                    self._current_map, my_race="",
                )
        except Exception as exc:
            self.parent.after(0, lambda e=exc: self.status_lbl.configure(
                text=f"Heatmap error: {e}", text_color=COLOR_LOSS,
            ))
            return
        self.parent.after(0, lambda p=payload: self._render_payload(p))

    def _render_payload(self, payload: Dict) -> None:
        with self._render_lock:
            self.canvas.delete("all")
            self._current_bounds = payload.get("bounds") or {}
            self._draw_background()
            sample_count = int(payload.get("sample_count", 0))
            kind = payload.get("kind", "")
            if sample_count == 0:
                self.legend_lbl.configure(
                    text=f"No {kind} samples on {self._current_map} yet.",
                )
                self.status_lbl.configure(
                    text="0 samples — try another overlay or add replays.",
                    text_color="#FBC02D",
                )
                return

            if not _HAS_MPL:
                # Render text-only summary if matplotlib is unavailable.
                self.legend_lbl.configure(
                    text=f"matplotlib missing — {sample_count} samples found.",
                )
                self.status_lbl.configure(
                    text="overlay disabled (no matplotlib)",
                    text_color=COLOR_LOSS,
                )
                return

            self._draw_heatmap_layer(payload)
            self.legend_lbl.configure(
                text=(
                    f"{kind.replace('_', ' ').title()} on {self._current_map} — "
                    f"{sample_count} samples"
                    + (" (KDE fallback used)"
                       if payload.get("fallback_used") else "")
                ),
            )
            self.status_lbl.configure(
                text="Done.", text_color=COLOR_WIN,
            )

    def _draw_empty(self) -> None:
        self.canvas.delete("all")
        self.canvas.create_text(
            CANVAS_PX // 2, CANVAS_PX // 2,
            text="No data — add replays or pick a map with >= 3 games.",
            fill=GRAPH_FG, font=("Arial", 12),
        )

    def _draw_background(self) -> None:
        b = self._current_bounds or _bounds_for(self._current_map, [])
        x0, y0 = self._project(b["x_min"], b["y_max"])
        x1, y1 = self._project(b["x_max"], b["y_min"])
        self.canvas.create_rectangle(
            x0, y0, x1, y1, outline="#3b4250", width=2,
            fill="#1a1f29",
        )
        # Start locations.
        for sx, sy in (b.get("starting_locations") or []):
            cx, cy = self._project(sx, sy)
            r = 14
            self.canvas.create_oval(
                cx - r, cy - r, cx + r, cy + r,
                outline="#5a6172", fill="#1d222b", width=2,
            )

    def _draw_heatmap_layer(self, payload: Dict) -> None:
        """Render the density grid into a Tk PhotoImage and stamp it on the canvas.

        We size the image to match the projected bounds rectangle so the
        overlay aligns perfectly with the map background.
        """
        if not _HAS_MPL or Figure is None:
            return
        b = self._current_bounds
        x0, y0 = self._project(b["x_min"], b["y_max"])
        x1, y1 = self._project(b["x_max"], b["y_min"])
        # Render width/height in pixels; matplotlib's renderer is happy with
        # arbitrary pixel sizes.
        w = max(50, int(x1 - x0))
        h = max(50, int(y1 - y0))
        # Build a Figure sized exactly to (w, h) at 100 dpi so 1 cell = 1 px.
        fig = Figure(figsize=(w / 100.0, h / 100.0), dpi=100,
                     facecolor="none", frameon=False)
        ax = fig.add_axes([0, 0, 1, 1])
        ax.set_axis_off()
        grid = payload.get("grid") or []
        kind = payload.get("kind", "")
        cmap = "RdYlGn_r" if kind == "death_zone" else "viridis"
        if kind == "death_zone":
            vmin = float(payload.get("vmin", -1))
            vmax = float(payload.get("vmax", 1))
            ax.imshow(
                grid, cmap=cmap, vmin=vmin, vmax=vmax,
                interpolation="bilinear", alpha=0.65,
                extent=(0, 1, 0, 1), origin="upper",
            )
        else:
            ax.imshow(
                grid, cmap=cmap, vmin=0, vmax=1,
                interpolation="bilinear", alpha=0.55,
                extent=(0, 1, 0, 1), origin="upper",
            )
        # Render the figure to an in-memory PNG, then load that into a Tk
        # PhotoImage. This is the simplest cross-platform way to compose a
        # matplotlib heatmap on top of an existing Tk canvas.
        try:
            from io import BytesIO
            buf = BytesIO()
            fig.savefig(buf, format="png", transparent=True, dpi=100)
            buf.seek(0)
            try:
                from PIL import Image, ImageTk  # Pillow is already a dep
                img = Image.open(buf)
                img = img.resize((w, h))
                tkimg = ImageTk.PhotoImage(img)
            except Exception:
                # Bare fallback — no PIL — Tk PhotoImage from PNG bytes.
                tkimg = tk.PhotoImage(data=buf.getvalue())
            self._heatmap_photo = tkimg  # keep ref
            self.canvas.create_image(x0, y0, anchor="nw", image=tkimg)
        finally:
            try:
                fig.clear()
            except Exception:
                pass

    # ----------------------------------------------------- coord transform
    def _project(self, x: float, y: float):
        """SC2 cell coordinates -> canvas pixels. Mirrors map_viewer._project."""
        b = self._current_bounds or _bounds_for(self._current_map, [])
        bw = max(1e-6, b["x_max"] - b["x_min"])
        bh = max(1e-6, b["y_max"] - b["y_min"])
        avail = CANVAS_PX - 2 * PAD_PX
        scale = avail / max(bw, bh)
        center_x = CANVAS_PX / 2
        center_y = CANVAS_PX / 2
        cx = (b["x_min"] + b["x_max"]) / 2
        cy = (b["y_min"] + b["y_max"]) / 2
        px = center_x + (x - cx) * scale
        # Flip y so larger SC2 y values draw nearer the top of the canvas.
        py = center_y - (y - cy) * scale
        return px, py
