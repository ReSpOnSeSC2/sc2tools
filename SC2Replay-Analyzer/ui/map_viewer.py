"""Interactive map playback viewer.

`MapViewerWindow(parent, game_data, player_name)` opens from the existing
`GameVisualizerWindow` via the "Map Playback" button. It uses a Tkinter
`Canvas` (already a dependency through customtkinter) and animates building
spawns, army centroids, and battle markers along the replay timeline.

Architecture
------------

The viewer is split into three drawing layers:

1. **Background layer** — bounds rectangle + starting-location circles.
   Drawn once on every full redraw (bounds change, pan, zoom).
2. **Static building layer** — building squares with `time` <= the current
   playback position. Cached by tag ``static`` and only re-rebuilt when the
   playback time crosses a building's spawn time, when bounds change, or
   when pan/zoom invalidates the cache.
3. **Dynamic layer** — army-centroid dots, the highlighted battle markers,
   and tooltips. Cleared and redrawn every animation tick (~30 FPS).

The two-tier rebuild policy keeps the per-frame work O(small) even on long
games with hundreds of buildings.

Data shape
----------

Reuses ``core.event_extractor.extract_events`` for buildings/units, and the
same PlayerStatsEvent walk that the graph window already does for army value
sampling. The viewer pulls a fresh, bundled view of the replay through
``_build_playback_data`` rather than mutating ``game_data``.
"""

from __future__ import annotations

import os
import threading
import tkinter as tk
from typing import Dict, List, Optional, Tuple

import customtkinter as ctk

from core.map_playback_data import (
    DEFAULT_BOUNDS,
    bounds_for as _bounds_for,
    build_playback_data as _build_playback_data,
    centroid as _centroid,
    detect_battle_markers as _detect_battle_markers,
    interp as _interp,
)

from .theme import (
    COLOR_LOSS,
    COLOR_NEUTRAL,
    COLOR_P1,
    COLOR_P2,
    COLOR_WIN,
    GRAPH_BG,
    GRAPH_FG,
)


# ----------------------------------------------------------------- constants
CANVAS_PX = 800
PAD_PX = 24                 # space around the normalized map inside the canvas
FRAME_INTERVAL_MS = 33      # ~30 FPS animation tick
ANIM_SECS_PER_TICK = 1.0    # seconds of replay-time advanced per *1x* tick

BG_COLOR = "#15191F"
GRID_COLOR = "#252a33"
BOUNDS_OUTLINE = "#3b4250"
START_LOC_OUTLINE = "#5a6172"
START_LOC_FILL = "#1d222b"
BATTLE_COLOR = "#FBC02D"

ME_COLOR = COLOR_P1         # blue
OPP_COLOR = COLOR_P2        # red

# --------------------------------------------------------------- viewer class
class MapViewerWindow(ctk.CTkToplevel):
    """Toplevel window with a Tkinter Canvas-driven playback viewer."""

    def __init__(self, parent, game_data: Dict, player_name: str):
        super().__init__(parent)
        self.title(
            f"Map Playback: {game_data.get('map', 'Unknown')} "
            f"vs {game_data.get('opponent', '?')}"
        )
        self.geometry(f"{CANVAS_PX + 60}x{CANVAS_PX + 180}")
        self.transient(parent)
        self.lift()
        self.after(200, lambda: self.focus_force())
        self.configure(fg_color=GRAPH_BG)

        self.game_data = game_data
        self.player_name = player_name

        # Playback state
        self.data: Optional[Dict] = None
        self.bounds: Dict = dict(DEFAULT_BOUNDS)
        self.zoom: float = 1.0
        self.pan_x: float = 0.0
        self.pan_y: float = 0.0
        self.current_time: float = 0.0
        self.is_playing: bool = False
        self.speed: float = 1.0
        self._anim_after_id: Optional[str] = None
        self._static_dirty: bool = True
        self._last_static_time: float = -1.0
        self._tooltip_after_id: Optional[str] = None
        self._tooltip_id: Optional[int] = None
        self._building_lookup: Dict[int, Dict] = {}
        self._slider_user_held = False
        self.battles: List[Dict] = []

        # ------------------- Top toolbar
        bar = ctk.CTkFrame(self, fg_color="transparent")
        bar.pack(fill="x", padx=10, pady=(10, 6))

        ctk.CTkButton(bar, text="-", width=32, command=self._zoom_out).pack(side="left", padx=2)
        ctk.CTkButton(bar, text="Reset", width=60, command=self._zoom_reset).pack(side="left", padx=2)
        ctk.CTkButton(bar, text="+", width=32, command=self._zoom_in).pack(side="left", padx=2)

        self.play_btn = ctk.CTkButton(
            bar, text="Play", width=70,
            fg_color="#388E3C", hover_color="#2E7D32",
            command=self._toggle_play,
        )
        self.play_btn.pack(side="left", padx=(20, 4))

        ctk.CTkLabel(bar, text="Speed").pack(side="left", padx=(10, 4))
        self.speed_var = ctk.StringVar(value="1x")
        self.speed_menu = ctk.CTkOptionMenu(
            bar, variable=self.speed_var, values=["1x", "2x", "4x"],
            width=70, command=self._on_speed_change,
        )
        self.speed_menu.pack(side="left", padx=2)

        self.time_lbl = ctk.CTkLabel(bar, text="0:00 / 0:00", width=110)
        self.time_lbl.pack(side="right", padx=4)

        # ------------------- Timeline slider
        slider_frame = ctk.CTkFrame(self, fg_color="transparent")
        slider_frame.pack(fill="x", padx=10, pady=(0, 6))
        self.slider_var = tk.DoubleVar(value=0.0)
        self.slider = ctk.CTkSlider(
            slider_frame, from_=0, to=1, number_of_steps=1000,
            variable=self.slider_var, command=self._on_slider_drag,
        )
        self.slider.pack(fill="x", padx=4, pady=4)
        self.slider.bind("<ButtonPress-1>", self._on_slider_press)
        self.slider.bind("<ButtonRelease-1>", self._on_slider_release)

        # ------------------- Canvas
        canvas_frame = ctk.CTkFrame(self, fg_color="transparent")
        canvas_frame.pack(fill="both", expand=True, padx=10, pady=(0, 10))
        self.canvas = tk.Canvas(
            canvas_frame, width=CANVAS_PX, height=CANVAS_PX,
            bg=BG_COLOR, highlightthickness=0,
        )
        self.canvas.pack(expand=True)

        # Pan via middle-drag or right-drag; zoom via mouse wheel.
        self.canvas.bind("<ButtonPress-2>", self._pan_start)
        self.canvas.bind("<B2-Motion>", self._pan_drag)
        self.canvas.bind("<ButtonPress-3>", self._pan_start)
        self.canvas.bind("<B3-Motion>", self._pan_drag)
        self.canvas.bind("<MouseWheel>", self._on_wheel)
        self.canvas.bind("<Button-4>", lambda e: self._on_wheel_linux(e, +1))
        self.canvas.bind("<Button-5>", lambda e: self._on_wheel_linux(e, -1))
        self.canvas.bind("<Motion>", self._on_canvas_motion)
        self.canvas.bind("<Leave>", lambda _e: self._hide_tooltip())

        # ------------------- Status / legend
        legend = ctk.CTkFrame(self, fg_color="transparent")
        legend.pack(fill="x", padx=10, pady=(0, 6))
        self.status_lbl = ctk.CTkLabel(
            legend, text="Loading replay...", text_color="#FBC02D",
        )
        self.status_lbl.pack(side="left")

        ctk.CTkLabel(
            legend, text="  You", text_color=ME_COLOR,
            font=("Arial", 11, "bold"),
        ).pack(side="right", padx=4)
        ctk.CTkLabel(
            legend, text="Opponent  ", text_color=OPP_COLOR,
            font=("Arial", 11, "bold"),
        ).pack(side="right", padx=4)
        ctk.CTkLabel(
            legend, text="Battles  ", text_color=BATTLE_COLOR,
            font=("Arial", 11, "bold"),
        ).pack(side="right", padx=4)

        self.protocol("WM_DELETE_WINDOW", self._on_close)

        # Load data in background so opening the window doesn't block the UI.
        file_path = game_data.get("file_path")
        if not file_path or not os.path.exists(file_path):
            self.status_lbl.configure(
                text=f"Replay file not found: {file_path}",
                text_color=COLOR_LOSS,
            )
            return
        threading.Thread(
            target=self._async_load, args=(file_path,), daemon=True,
        ).start()

    # ---------------- background load
    def _async_load(self, file_path: str) -> None:
        data = _build_playback_data(file_path, self.player_name)
        self.after(0, lambda: self._on_data_ready(data))

    def _on_data_ready(self, data: Optional[Dict]) -> None:
        if data is None:
            self.status_lbl.configure(
                text="Could not parse replay for map playback.",
                text_color=COLOR_LOSS,
            )
            return
        self.data = data
        # Combine event lists for empirical bounds derivation.
        all_events = (data["my_events"] or []) + (data["opp_events"] or [])
        self.bounds = _bounds_for(data["map_name"], all_events)
        self.battles = _detect_battle_markers(
            data["my_stats"], data["opp_stats"],
            data["my_events"], data["opp_events"],
            data["game_length"],
        )
        self.slider.configure(to=max(1.0, data["game_length"]))
        result = data.get("result", "Unknown")
        result_color = (
            COLOR_WIN if result == "Win"
            else COLOR_LOSS if result == "Loss"
            else COLOR_NEUTRAL
        )
        self.status_lbl.configure(
            text=(
                f"{data['me_name']} vs {data['opp_name']}  -  "
                f"{int(data['game_length'] // 60)}:"
                f"{int(data['game_length'] % 60):02d}  -  Result: {result}"
            ),
            text_color=result_color,
        )
        self._static_dirty = True
        self._redraw_all()

    # ---------------- coordinate transforms
    def _project(self, x: float, y: float) -> Tuple[float, float]:
        """SC2 cell coordinates -> canvas pixel coordinates.

        Tkinter Canvas has y growing downward; SC2 has y growing upward, so
        the y axis is flipped. Pan/zoom are applied around the canvas center.
        """
        b = self.bounds
        bw = max(1e-6, b["x_max"] - b["x_min"])
        bh = max(1e-6, b["y_max"] - b["y_min"])
        avail = CANVAS_PX - 2 * PAD_PX
        scale = avail / max(bw, bh) * self.zoom
        # Center the map inside the canvas.
        center_x = CANVAS_PX / 2 + self.pan_x
        center_y = CANVAS_PX / 2 + self.pan_y
        cx = (b["x_min"] + b["x_max"]) / 2
        cy = (b["y_min"] + b["y_max"]) / 2
        px = center_x + (x - cx) * scale
        # Flip y.
        py = center_y - (y - cy) * scale
        return px, py

    def _scale(self) -> float:
        """Pixels per SC2 cell at the current zoom (used for sizing dots)."""
        b = self.bounds
        bw = max(1e-6, b["x_max"] - b["x_min"])
        bh = max(1e-6, b["y_max"] - b["y_min"])
        avail = CANVAS_PX - 2 * PAD_PX
        return avail / max(bw, bh) * self.zoom

    # ---------------- zoom / pan handlers
    def _zoom_in(self) -> None:
        self.zoom = min(8.0, self.zoom * 1.25)
        self._static_dirty = True
        self._redraw_all()

    def _zoom_out(self) -> None:
        self.zoom = max(0.25, self.zoom / 1.25)
        self._static_dirty = True
        self._redraw_all()

    def _zoom_reset(self) -> None:
        self.zoom = 1.0
        self.pan_x = 0.0
        self.pan_y = 0.0
        self._static_dirty = True
        self._redraw_all()

    def _on_wheel(self, event) -> None:
        if event.delta > 0:
            self._zoom_in()
        else:
            self._zoom_out()

    def _on_wheel_linux(self, _event, direction: int) -> None:
        if direction > 0:
            self._zoom_in()
        else:
            self._zoom_out()

    def _pan_start(self, event) -> None:
        self._pan_anchor = (event.x, event.y, self.pan_x, self.pan_y)

    def _pan_drag(self, event) -> None:
        anchor = getattr(self, "_pan_anchor", None)
        if anchor is None:
            return
        ax, ay, px, py = anchor
        self.pan_x = px + (event.x - ax)
        self.pan_y = py + (event.y - ay)
        self._static_dirty = True
        self._redraw_all()

    # ---------------- playback / slider
    def _on_speed_change(self, choice: str) -> None:
        try:
            self.speed = float(choice.rstrip("x"))
        except ValueError:
            self.speed = 1.0

    def _toggle_play(self) -> None:
        if not self.data:
            return
        if self.is_playing:
            self.is_playing = False
            self.play_btn.configure(text="Play", fg_color="#388E3C", hover_color="#2E7D32")
            if self._anim_after_id:
                try:
                    self.after_cancel(self._anim_after_id)
                except Exception:
                    pass
                self._anim_after_id = None
        else:
            if self.current_time >= self.data["game_length"]:
                self.current_time = 0.0
            self.is_playing = True
            self.play_btn.configure(text="Pause", fg_color="#D84315", hover_color="#BF360C")
            self._tick()

    def _tick(self) -> None:
        if not self.is_playing or not self.data:
            return
        self.current_time = min(
            self.data["game_length"],
            self.current_time + ANIM_SECS_PER_TICK * self.speed,
        )
        self.slider_var.set(self.current_time)
        self._redraw_dynamic()
        if self.current_time >= self.data["game_length"]:
            self._toggle_play()
            return
        self._anim_after_id = self.after(FRAME_INTERVAL_MS, self._tick)

    def _on_slider_press(self, _event) -> None:
        self._slider_user_held = True

    def _on_slider_release(self, _event) -> None:
        self._slider_user_held = False

    def _on_slider_drag(self, value) -> None:
        if not self.data:
            return
        try:
            t = float(value)
        except (TypeError, ValueError):
            return
        # Slider drives the timeline whether or not playback is running.
        self.current_time = max(0.0, min(self.data["game_length"], t))
        self._redraw_dynamic()

    # ---------------- drawing
    def _redraw_all(self) -> None:
        """Wipe every layer and rebuild from scratch (zoom, pan, init)."""
        self.canvas.delete("all")
        self._draw_background()
        if self.data:
            self._draw_static_buildings()
            self._redraw_dynamic()

    def _draw_background(self) -> None:
        b = self.bounds
        x0, y0 = self._project(b["x_min"], b["y_max"])
        x1, y1 = self._project(b["x_max"], b["y_min"])
        self.canvas.create_rectangle(
            x0, y0, x1, y1, outline=BOUNDS_OUTLINE, width=2,
            fill="#1a1f29", tags=("background",),
        )
        # Light grid every 16 cells for visual reference.
        step = 16
        x_cell = b["x_min"]
        while x_cell <= b["x_max"]:
            gx0, _ = self._project(x_cell, b["y_min"])
            gx1, _ = self._project(x_cell, b["y_max"])
            _, gy0 = self._project(x_cell, b["y_min"])
            _, gy1 = self._project(x_cell, b["y_max"])
            self.canvas.create_line(
                gx0, gy0, gx1, gy1, fill=GRID_COLOR, tags=("background",),
            )
            x_cell += step
        y_cell = b["y_min"]
        while y_cell <= b["y_max"]:
            gx0, gy0 = self._project(b["x_min"], y_cell)
            gx1, gy1 = self._project(b["x_max"], y_cell)
            self.canvas.create_line(
                gx0, gy0, gx1, gy1, fill=GRID_COLOR, tags=("background",),
            )
            y_cell += step
        # Starting locations.
        radius_cells = 5
        scale = self._scale()
        r = max(6, radius_cells * scale)
        for sx, sy in (b.get("starting_locations") or []):
            cx, cy = self._project(sx, sy)
            self.canvas.create_oval(
                cx - r, cy - r, cx + r, cy + r,
                outline=START_LOC_OUTLINE, fill=START_LOC_FILL,
                width=2, tags=("background",),
            )

    def _draw_static_buildings(self) -> None:
        """Re-draw all buildings whose ``time`` <= ``current_time``."""
        if self.data is None:
            return
        # Only rebuild if we passed a new spawn or the cache is dirty.
        if not self._static_dirty and self.current_time == self._last_static_time:
            return
        self.canvas.delete("static")
        self._building_lookup.clear()
        scale = self._scale()
        # Building square side in pixels (~3 SC2 cells, with floor).
        size = max(4, 3 * scale)
        t = self.current_time

        for who, evts, color in (
            ("me", self.data["my_events"], ME_COLOR),
            ("opp", self.data["opp_events"], OPP_COLOR),
        ):
            for e in evts:
                if e.get("type") != "building":
                    continue
                if e.get("time", 0) > t:
                    break  # events are sorted; nothing later qualifies
                x, y = e.get("x"), e.get("y")
                if not x or not y:
                    continue
                cx, cy = self._project(x, y)
                cid = self.canvas.create_rectangle(
                    cx - size / 2, cy - size / 2,
                    cx + size / 2, cy + size / 2,
                    outline=color, fill=color, width=1,
                    tags=("static", f"building_{who}"),
                )
                self._building_lookup[cid] = {
                    "name": e.get("name", "?"),
                    "time": e.get("time", 0),
                    "side": who,
                }
        self._static_dirty = False
        self._last_static_time = t

    def _redraw_dynamic(self) -> None:
        """Update labels, the army centroids, and battle markers."""
        if self.data is None:
            return
        # Rebuild static layer if the cursor crossed a new building spawn.
        if self.current_time != self._last_static_time:
            self._draw_static_buildings()
        self.canvas.delete("dynamic")

        t = self.current_time
        gl = self.data["game_length"]
        self.time_lbl.configure(
            text=f"{int(t // 60)}:{int(t % 60):02d} / "
                 f"{int(gl // 60)}:{int(gl % 60):02d}",
        )

        # Battle markers up to current time (yellow X).
        scale = self._scale()
        x_size = max(6, 3 * scale)
        for m in self.battles:
            if m["time"] > t:
                continue
            cx, cy = self._project(m["x"], m["y"])
            self.canvas.create_line(
                cx - x_size, cy - x_size, cx + x_size, cy + x_size,
                fill=BATTLE_COLOR, width=2, tags=("dynamic", "battle"),
            )
            self.canvas.create_line(
                cx - x_size, cy + x_size, cx + x_size, cy - x_size,
                fill=BATTLE_COLOR, width=2, tags=("dynamic", "battle"),
            )

        # Army centroid dots.
        for events, stats, color in (
            (self.data["my_events"], self.data["my_stats"], ME_COLOR),
            (self.data["opp_events"], self.data["opp_stats"], OPP_COLOR),
        ):
            cen = _centroid(events, t)
            if cen is None:
                continue
            army_val = _interp(stats, t, "army_val") if stats else 0.0
            # Diameter scales with sqrt(army_val) so 4x value = 2x radius.
            base = max(8, 1.6 * scale)
            r = base + min(40, (army_val / 250.0) ** 0.5 * 8)
            cx, cy = self._project(cen[0], cen[1])
            self.canvas.create_oval(
                cx - r, cy - r, cx + r, cy + r,
                outline=color, fill=color, stipple="gray50",
                width=2, tags=("dynamic", "army"),
            )

    # ---------------- tooltip
    def _on_canvas_motion(self, event) -> None:
        # Slight debounce so we don't redraw a tooltip every motion.
        if self._tooltip_after_id:
            try:
                self.after_cancel(self._tooltip_after_id)
            except Exception:
                pass
        self._tooltip_after_id = self.after(
            40, lambda e=event: self._maybe_show_tooltip(e),
        )

    def _maybe_show_tooltip(self, event) -> None:
        items = self.canvas.find_overlapping(
            event.x - 1, event.y - 1, event.x + 1, event.y + 1,
        )
        for cid in reversed(items):
            info = self._building_lookup.get(cid)
            if info is None:
                continue
            self._show_tooltip(event.x + 12, event.y + 8, info)
            return
        self._hide_tooltip()

    def _show_tooltip(self, px: float, py: float, info: Dict) -> None:
        self._hide_tooltip()
        m, s = int(info["time"] // 60), int(info["time"] % 60)
        side = "You" if info["side"] == "me" else "Opponent"
        result = self.data.get("result", "?") if self.data else "?"
        text = f" {info['name']}  [{side}]\n {m}:{s:02d} - game result: {result} "
        # Drop a label on the canvas so it pans/zooms with everything else.
        self._tooltip_id = self.canvas.create_text(
            px, py, text=text, anchor="nw", fill=GRAPH_FG,
            font=("Arial", 10), tags=("dynamic", "tooltip"),
        )
        bbox = self.canvas.bbox(self._tooltip_id)
        if bbox:
            bx0, by0, bx1, by1 = bbox
            bg = self.canvas.create_rectangle(
                bx0 - 4, by0 - 2, bx1 + 4, by1 + 2,
                fill="#1f2630", outline=BOUNDS_OUTLINE,
                tags=("dynamic", "tooltip"),
            )
            self.canvas.tag_lower(bg, self._tooltip_id)

    def _hide_tooltip(self) -> None:
        self.canvas.delete("tooltip")
        self._tooltip_id = None

    # ---------------- shutdown
    def _on_close(self) -> None:
        self.is_playing = False
        if self._anim_after_id:
            try:
                self.after_cancel(self._anim_after_id)
            except Exception:
                pass
            self._anim_after_id = None
        if self._tooltip_after_id:
            try:
                self.after_cancel(self._tooltip_after_id)
            except Exception:
                pass
            self._tooltip_after_id = None
        self.destroy()
