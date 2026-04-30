"""Spatial heatmap aggregation across many games on the same map.

This module exposes :class:`SpatialAggregator`, a thin facade over the
existing per-replay event extractor (`core.event_extractor.extract_events`)
and the battle-marker detector (`core.map_playback_data.detect_battle_markers`).
It rolls (x, y) building locations and engagement points across every game
the user has on a given map and produces dense numeric grids the UI layers
can render as heatmaps.

What lives here
---------------
* ``building_heatmap(map_name, owner='me')`` — 100x100 Gaussian-KDE density
  of all building placements for the chosen owner across every game of the
  user's on the requested map.
* ``proxy_heatmap(map_name)`` — same shape, but only buildings flagged
  proxy by the existing ``BaseStrategyDetector._is_proxy`` rule, owner=opp.
  Highlights where opponents tend to plant cheese.
* ``battle_heatmap(map_name)`` — KDE over engagement (battle marker)
  centroids across every game, regardless of who won.
* ``death_zone_grid(map_name, my_race)`` — 20x20 grid; for each cell the
  mean (my_army_lost - opp_army_lost) across battles in that cell. Negative
  values (red) mean the player consistently loses fights in that area.
* ``opponent_proxy_locations(opponent_name)`` — flat list of proxy points
  observed across every game the user has against this opponent. Used by
  the "Proxy patterns vs you" sidebar widget on opponent profiles.

Caching
-------
Per-replay spatial extracts are cached on disk under
``data/spatial_cache.json`` keyed by ``(file_path, mtime, size)``. A miss
loads the replay through ``core.map_playback_data.build_playback_data``
(which is the same parser the desktop map-viewer uses) and persists the
result. An in-memory LRU avoids hitting disk inside a single process.

Single-point fallback
---------------------
``scipy.stats.gaussian_kde`` raises ``LinAlgError`` on degenerate inputs
(a single point, all-collinear points, etc.). We catch that and fall back
to a 5-cell "stamp" of density centered on each surviving point so callers
always get a usable grid back.
"""

from __future__ import annotations

import json
import math
import os
import threading
from typing import Any, Dict, List, Optional, Tuple

try:
    import numpy as np
except Exception as _exc:  # pragma: no cover - numpy is a hard dep already
    raise ImportError(
        "analytics.spatial requires numpy (declared in requirements.txt)"
    ) from _exc

# scipy is added to requirements.txt by this feature. Tolerate its absence
# at import time so unit tests / headless CI without scipy installed can
# still import the module — the KDE methods will fall back to the simple
# stamp method documented above.
try:
    from scipy.stats import gaussian_kde  # type: ignore
    _HAVE_SCIPY = True
except Exception:  # pragma: no cover - tolerated
    gaussian_kde = None  # type: ignore
    _HAVE_SCIPY = False

from core.map_playback_data import (
    DEFAULT_BOUNDS,
    bounds_for as _bounds_for,
    build_playback_data as _build_playback_data,
    centroid as _centroid,
    detect_battle_markers as _detect_battle_markers,
    interp as _interp,
)
from core.paths import APP_DIR
from detectors.base import BaseStrategyDetector


# ---------------------------------------------------------------- constants
DENSITY_RES: int = 100             # building/proxy/battle heatmap grid side
DEATH_ZONE_RES: int = 20           # death-zone grid side
PROXY_DISTANCE_DEFAULT: float = 50.0  # matches BaseStrategyDetector._is_proxy
MIN_GAMES_FOR_MAP: int = 3         # the dropdown filter

# Spatial cache lives next to the existing map-bounds file so all
# spatial-only state shares a single ``data/`` directory.
SPATIAL_CACHE_FILE = os.path.join(APP_DIR, "data", "spatial_cache.json")


def _stable_game_key(game: Dict) -> str:
    """Stable cache key per game — uses ``id`` if present, else file path."""
    gid = game.get("id") or game.get("game_id")
    if gid:
        return str(gid)
    return str(game.get("file_path") or "")


def _file_signature(path: str) -> Optional[Tuple[float, int]]:
    try:
        st = os.stat(path)
        return (st.st_mtime, st.st_size)
    except OSError:
        return None


# A small, non-empty stamp used when KDE can't be evaluated. Spreads density
# across a 5x5 region around each input point, with falloff.
_STAMP_KERNEL = np.array([
    [0.05, 0.10, 0.15, 0.10, 0.05],
    [0.10, 0.30, 0.50, 0.30, 0.10],
    [0.15, 0.50, 1.00, 0.50, 0.15],
    [0.10, 0.30, 0.50, 0.30, 0.10],
    [0.05, 0.10, 0.15, 0.10, 0.05],
], dtype=float)


# --------------------------------------------------------------- helpers
def _coords_to_grid(
    xs: np.ndarray, ys: np.ndarray, bounds: Dict, resolution: int,
) -> Tuple[np.ndarray, np.ndarray]:
    """Map world (x, y) -> integer grid (col, row) inside [0, resolution)."""
    x_min, x_max = float(bounds["x_min"]), float(bounds["x_max"])
    y_min, y_max = float(bounds["y_min"]), float(bounds["y_max"])
    bw = max(1e-6, x_max - x_min)
    bh = max(1e-6, y_max - y_min)
    cols = np.clip(((xs - x_min) / bw * resolution).astype(int), 0, resolution - 1)
    # Flip y so row=0 is the *top* of the rendered image (matches imshow).
    rows = np.clip(
        ((1.0 - (ys - y_min) / bh) * resolution).astype(int), 0, resolution - 1
    )
    return cols, rows


def _stamp_grid(xs: List[float], ys: List[float], bounds: Dict, res: int) -> np.ndarray:
    """Fallback density when KDE is unavailable / degenerate.

    Adds the 5x5 ``_STAMP_KERNEL`` around every input point, clipping at the
    grid edges. Equivalent to a tiny, separable, hand-rolled gaussian.
    """
    grid = np.zeros((res, res), dtype=float)
    if not xs:
        return grid
    cols, rows = _coords_to_grid(np.asarray(xs), np.asarray(ys), bounds, res)
    half = _STAMP_KERNEL.shape[0] // 2
    for c, r in zip(cols, rows):
        r0, r1 = max(0, r - half), min(res, r + half + 1)
        c0, c1 = max(0, c - half), min(res, c + half + 1)
        kr0, kr1 = half - (r - r0), half + (r1 - r)
        kc0, kc1 = half - (c - c0), half + (c1 - c)
        grid[r0:r1, c0:c1] += _STAMP_KERNEL[kr0:kr1, kc0:kc1]
    if grid.max() > 0:
        grid /= grid.max()
    return grid


def _kde_grid(xs: List[float], ys: List[float], bounds: Dict, res: int) -> np.ndarray:
    """Evaluate a 2D Gaussian KDE on a ``res x res`` grid over ``bounds``.

    Falls back to ``_stamp_grid`` if scipy is missing, the dataset has fewer
    than 2 points, or the KDE itself fails on a degenerate covariance.
    """
    if not xs:
        return np.zeros((res, res), dtype=float)
    if not _HAVE_SCIPY or len(xs) < 2:
        return _stamp_grid(xs, ys, bounds, res)
    try:
        sample = np.vstack([np.asarray(xs, dtype=float),
                            np.asarray(ys, dtype=float)])
        kde = gaussian_kde(sample)  # type: ignore[misc]
        x_min, x_max = float(bounds["x_min"]), float(bounds["x_max"])
        y_min, y_max = float(bounds["y_min"]), float(bounds["y_max"])
        # res samples across each axis; meshgrid yields (res, res).
        xs_ax = np.linspace(x_min, x_max, res)
        ys_ax = np.linspace(y_max, y_min, res)  # top of image = high-y
        xx, yy = np.meshgrid(xs_ax, ys_ax)
        positions = np.vstack([xx.ravel(), yy.ravel()])
        density = kde(positions).reshape(res, res)
        if density.max() > 0:
            density /= density.max()
        return density
    except Exception:
        # numpy.linalg.LinAlgError, ValueError on collinear points, etc.
        return _stamp_grid(xs, ys, bounds, res)


# -------------------------------------------------------------- aggregator
class SpatialAggregator:
    """Per-map spatial aggregation over the user's replay database.

    The aggregator keeps a reference to the in-memory ``db`` dict managed by
    :class:`db.database.ReplayAnalyzer` so adding/removing games is visible
    immediately. The per-replay spatial extracts are cached on disk so a
    second visit to the same map is fast.
    """

    def __init__(self, db: Dict, player_name: Optional[str] = None):
        self._db = db
        self._player_name = player_name
        self._mem_cache: Dict[str, Dict] = {}
        self._disk_cache: Optional[Dict[str, Dict]] = None
        self._lock = threading.Lock()
        # Reuse the proxy-distance helper from the strategy detector so this
        # module's "is proxy" check stays in lock-step with the classifier.
        self._proxy_helper = BaseStrategyDetector(custom_builds=[])

    # ----------------------------------------------------------------- API
    def set_player_name(self, name: Optional[str]) -> None:
        """Update which handle counts as ``me`` (e.g. after profile change)."""
        with self._lock:
            self._player_name = name
            # Player change can swap me/opp roles — flush in-memory cache.
            self._mem_cache.clear()

    def list_maps_with_min_games(self, min_games: int = MIN_GAMES_FOR_MAP) -> List[Dict]:
        """Return ``[{name, total, wins, losses}]`` for maps with >= N games.

        Filters out maps lacking a usable replay file path entirely so we
        don't show a map in the dropdown that we can't actually heatmap.
        """
        out: Dict[str, Dict[str, int]] = {}
        for bd in self._db.values():
            if not isinstance(bd, dict):
                continue
            for g in bd.get("games", []) or []:
                if not isinstance(g, dict):
                    continue
                fp = g.get("file_path")
                if not fp:
                    continue
                m = g.get("map") or "Unknown"
                slot = out.setdefault(m, {"wins": 0, "losses": 0, "total": 0})
                slot["total"] += 1
                if g.get("result") == "Win":
                    slot["wins"] += 1
                elif g.get("result") == "Loss":
                    slot["losses"] += 1
        rows = [
            {"name": m, "total": s["total"], "wins": s["wins"], "losses": s["losses"]}
            for m, s in out.items() if s["total"] >= min_games
        ]
        rows.sort(key=lambda r: (-r["total"], r["name"].lower()))
        return rows

    def building_heatmap(
        self, map_name: str, owner: str = "me",
    ) -> Dict[str, Any]:
        """Density of every building placed by ``owner`` on ``map_name``."""
        xs, ys = self._collect_buildings(map_name, owner=owner, proxy_only=False)
        bounds = self._bounds_for_map(map_name)
        grid = _kde_grid(xs, ys, bounds, DENSITY_RES)
        return {
            "grid": grid.tolist(),
            "bounds": bounds,
            "resolution": DENSITY_RES,
            "sample_count": len(xs),
            "kind": "building",
            "owner": owner,
            "map_name": map_name,
            "fallback_used": (not _HAVE_SCIPY) or len(xs) < 2,
        }

    def proxy_heatmap(self, map_name: str) -> Dict[str, Any]:
        """Density restricted to opponent buildings flagged as proxy."""
        xs, ys = self._collect_buildings(
            map_name, owner="opponent", proxy_only=True,
        )
        bounds = self._bounds_for_map(map_name)
        grid = _kde_grid(xs, ys, bounds, DENSITY_RES)
        return {
            "grid": grid.tolist(),
            "bounds": bounds,
            "resolution": DENSITY_RES,
            "sample_count": len(xs),
            "kind": "proxy",
            "owner": "opponent",
            "map_name": map_name,
            "fallback_used": (not _HAVE_SCIPY) or len(xs) < 2,
        }

    def battle_heatmap(self, map_name: str) -> Dict[str, Any]:
        """Density of engagement (battle-marker) centroids across all games."""
        xs: List[float] = []
        ys: List[float] = []
        for game in self._games_on_map(map_name):
            spatial = self._get_spatial(game)
            if not spatial:
                continue
            for b in spatial.get("battles", []) or []:
                bx, by = b.get("x"), b.get("y")
                if bx is None or by is None:
                    continue
                xs.append(float(bx))
                ys.append(float(by))
        bounds = self._bounds_for_map(map_name)
        grid = _kde_grid(xs, ys, bounds, DENSITY_RES)
        return {
            "grid": grid.tolist(),
            "bounds": bounds,
            "resolution": DENSITY_RES,
            "sample_count": len(xs),
            "kind": "battle",
            "map_name": map_name,
            "fallback_used": (not _HAVE_SCIPY) or len(xs) < 2,
        }

    def death_zone_grid(
        self, map_name: str, my_race: str = "",
    ) -> Dict[str, Any]:
        """20x20 grid of mean (my_army_lost - opp_army_lost) per cell.

        Negative values mean we lose fights in that region (red on the
        ``RdYlGn_r`` colormap). ``my_race`` is currently informational only —
        it appears in the response so the UI can label the chart, but the
        scoring is race-agnostic because we already only count *our*
        engagements (``side == 'me'`` from ``detect_battle_markers``).
        """
        bounds = self._bounds_for_map(map_name)
        sums = np.zeros((DEATH_ZONE_RES, DEATH_ZONE_RES), dtype=float)
        counts = np.zeros((DEATH_ZONE_RES, DEATH_ZONE_RES), dtype=int)

        sample_total = 0
        for game in self._games_on_map(map_name):
            spatial = self._get_spatial(game)
            if not spatial:
                continue
            for b in spatial.get("battles", []) or []:
                bx, by = b.get("x"), b.get("y")
                if bx is None or by is None:
                    continue
                # army_lost_diff = my_army_lost - opp_army_lost.
                # Worse for me → more positive → grid value should be more
                # negative so RdYlGn_r colours it red. We invert below.
                diff = float(b.get("army_lost_diff") or 0.0)
                cols, rows = _coords_to_grid(
                    np.asarray([bx]), np.asarray([by]),
                    bounds, DEATH_ZONE_RES,
                )
                c = int(cols[0])
                r = int(rows[0])
                # Negative mean = red (we lose stuff here).
                sums[r, c] += -diff
                counts[r, c] += 1
                sample_total += 1

        with np.errstate(invalid="ignore", divide="ignore"):
            mean = np.where(counts > 0, sums / np.maximum(counts, 1), 0.0)

        # Symmetric color range so "neutral" maps to the colormap midpoint.
        v = float(np.nanmax(np.abs(mean))) if sample_total else 0.0
        return {
            "grid": mean.tolist(),
            "counts": counts.tolist(),
            "bounds": bounds,
            "resolution": DEATH_ZONE_RES,
            "sample_count": sample_total,
            "kind": "death_zone",
            "map_name": map_name,
            "my_race": my_race,
            "vmin": -v if v > 0 else -1.0,
            "vmax":  v if v > 0 else  1.0,
        }

    def opponent_proxy_locations(
        self, opponent_name: str, max_games: int = 200,
    ) -> Dict[str, Any]:
        """Flat list of every proxy point this opponent placed against me.

        Returned as ``{"points": [{"x", "y", "name", "time", "map", "result"}, ...]}``
        so the React sidebar can scatterplot them directly. Useful when
        scouting a known opponent: "this guy proxied 3 of his last 5 games
        — and they were always near the lower base".
        """
        all_games: List[Dict] = []
        for bd in self._db.values():
            if not isinstance(bd, dict):
                continue
            for g in bd.get("games", []) or []:
                if not isinstance(g, dict):
                    continue
                opp = (g.get("opponent") or "").strip()
                if not opp:
                    continue
                # Match either exact name or canonical (clan-tag stripped).
                if (opp.lower() == opponent_name.lower()
                        or self._strip_tag(opp).lower() == self._strip_tag(opponent_name).lower()):
                    all_games.append(g)
        all_games = all_games[:max_games]

        points: List[Dict] = []
        per_map: Dict[str, int] = {}
        for game in all_games:
            spatial = self._get_spatial(game)
            if not spatial:
                continue
            opp_main = self._main_base_loc(spatial.get("opp_buildings") or [])
            for ev in spatial.get("opp_buildings") or []:
                bx, by = ev.get("x"), ev.get("y")
                if bx is None or by is None:
                    continue
                if not self._proxy_helper._is_proxy(
                    {"x": bx, "y": by}, opp_main,
                    threshold=PROXY_DISTANCE_DEFAULT,
                ):
                    continue
                points.append({
                    "x": float(bx),
                    "y": float(by),
                    "name": ev.get("name", "?"),
                    "time": float(ev.get("time", 0)),
                    "map": game.get("map", "Unknown"),
                    "result": game.get("result", ""),
                })
                per_map[game.get("map", "Unknown")] = per_map.get(
                    game.get("map", "Unknown"), 0,
                ) + 1
        return {
            "opponent": opponent_name,
            "games_scanned": len(all_games),
            "proxies_found": len(points),
            "by_map": per_map,
            "points": points,
        }

    # ----------------------------------------------------------- internals
    def _bounds_for_map(self, map_name: str) -> Dict:
        """Resolve playable bounds. Pre-loaded from ``data/map_bounds.json``."""
        return _bounds_for(map_name, [])

    def _games_on_map(self, map_name: str) -> List[Dict]:
        out: List[Dict] = []
        for bd in self._db.values():
            if not isinstance(bd, dict):
                continue
            for g in bd.get("games", []) or []:
                if not isinstance(g, dict):
                    continue
                if (g.get("map") or "") != map_name:
                    continue
                if not g.get("file_path"):
                    continue
                out.append(g)
        return out

    def _collect_buildings(
        self, map_name: str, owner: str, proxy_only: bool,
    ) -> Tuple[List[float], List[float]]:
        """Walk all games on a map and pull (x, y) for the chosen owner."""
        xs: List[float] = []
        ys: List[float] = []
        for game in self._games_on_map(map_name):
            spatial = self._get_spatial(game)
            if not spatial:
                continue
            if owner in ("me", "self"):
                evs = spatial.get("my_buildings") or []
                main_loc = self._main_base_loc(evs)
            else:
                evs = spatial.get("opp_buildings") or []
                main_loc = self._main_base_loc(evs)
            for ev in evs:
                bx, by = ev.get("x"), ev.get("y")
                if bx is None or by is None:
                    continue
                if proxy_only and not self._proxy_helper._is_proxy(
                    {"x": bx, "y": by}, main_loc,
                    threshold=PROXY_DISTANCE_DEFAULT,
                ):
                    continue
                xs.append(float(bx))
                ys.append(float(by))
        return xs, ys

    def _main_base_loc(self, building_events: List[Dict]) -> Tuple[float, float]:
        """Earliest town-hall coordinates as the player's main."""
        town_halls = [
            b for b in building_events
            if b.get("name") in (
                "Nexus", "Hatchery", "CommandCenter",
                "OrbitalCommand", "PlanetaryFortress",
            )
        ]
        if not town_halls:
            return (0.0, 0.0)
        town_halls.sort(key=lambda x: x.get("time", 0))
        return (
            float(town_halls[0].get("x", 0)),
            float(town_halls[0].get("y", 0)),
        )

    @staticmethod
    def _strip_tag(name: str) -> str:
        if not name:
            return ""
        if name.startswith("[") and "]" in name:
            return name[name.index("]") + 1:].strip()
        return name

    # ---------------------------------------------------------- per-game cache
    def _get_spatial(self, game: Dict) -> Optional[Dict]:
        """Return a cached or freshly-extracted spatial bundle for one game.

        Bundle shape::

            {
                "my_buildings":  [{name,time,x,y}, ...],
                "opp_buildings": [{name,time,x,y}, ...],
                "battles":       [{time,x,y,side,army_lost_diff}, ...],
                "map_name":      "...",
                "game_length":   <float>,
            }
        """
        key = _stable_game_key(game)
        if not key:
            return None
        with self._lock:
            cached = self._mem_cache.get(key)
            if cached:
                return cached

        # Disk cache lookup — keyed by file signature so a re-saved replay
        # invalidates naturally.
        fp = game.get("file_path")
        sig = _file_signature(fp) if fp else None
        if sig and self._disk_cache is None:
            self._disk_cache = self._load_disk_cache()
        disk_entry = (self._disk_cache or {}).get(key) if sig else None
        if disk_entry and disk_entry.get("sig") == [sig[0], sig[1]]:
            with self._lock:
                self._mem_cache[key] = disk_entry["data"]
            return disk_entry["data"]

        if not fp or not os.path.exists(fp):
            return None

        # Parse the replay through the existing playback pipeline. This is
        # the slow path; we rely on the disk cache to amortize.
        try:
            data = _build_playback_data(fp, self._player_name or "")
        except Exception:
            return None
        if not data:
            return None

        battles = _detect_battle_markers(
            data["my_stats"], data["opp_stats"],
            data["my_events"], data["opp_events"],
            data["game_length"],
        )
        battles = self._enrich_battles_with_lost_diff(
            battles, data["my_stats"], data["opp_stats"],
        )

        my_buildings = [
            {"name": e["name"], "time": e["time"], "x": e["x"], "y": e["y"]}
            for e in data["my_events"]
            if e.get("type") == "building" and e.get("x") and e.get("y")
        ]
        opp_buildings = [
            {"name": e["name"], "time": e["time"], "x": e["x"], "y": e["y"]}
            for e in data["opp_events"]
            if e.get("type") == "building" and e.get("x") and e.get("y")
        ]
        bundle = {
            "my_buildings":  my_buildings,
            "opp_buildings": opp_buildings,
            "battles":       battles,
            "map_name":      data.get("map_name") or game.get("map", ""),
            "game_length":   float(data.get("game_length") or 0.0),
        }

        # Persist to in-memory + disk cache.
        with self._lock:
            self._mem_cache[key] = bundle
        if sig:
            self._save_disk_entry(key, sig, bundle)
        return bundle

    @staticmethod
    def _enrich_battles_with_lost_diff(
        battles: List[Dict], my_stats: List[Dict], opp_stats: List[Dict],
    ) -> List[Dict]:
        """Annotate each battle marker with ``army_lost_diff``.

        Computed as ``Δmy_army - Δopp_army`` over the battle window. Positive
        means *I* lost more value than the opponent did → bad for me. Used by
        ``death_zone_grid`` to colour cells red (lose) or green (win)."""
        out: List[Dict] = []
        for m in battles:
            t = float(m["time"])
            t_pre = max(0.0, t - 5.0)
            t_post = t + 5.0
            try:
                d_my = _interp(my_stats, t_post, "army_val") - _interp(
                    my_stats, t_pre, "army_val")
                d_opp = _interp(opp_stats, t_post, "army_val") - _interp(
                    opp_stats, t_pre, "army_val")
            except Exception:
                d_my = d_opp = 0.0
            m2 = dict(m)
            # Both deltas are usually negative during a fight (army value
            # falls). The DIFFERENCE of those negatives tells us who took
            # the worse loss.  d_my - d_opp:  -200 - (-50) = -150 → I lost
            # 150 more than them. Flip sign so positive = bad-for-me, which
            # is what death_zone_grid expects.
            m2["army_lost_diff"] = float(-(d_my - d_opp))
            out.append(m2)
        return out

    # ---------------------------------------------------------- disk cache
    def _load_disk_cache(self) -> Dict:
        try:
            with open(SPATIAL_CACHE_FILE, "r", encoding="utf-8") as f:
                return json.load(f) or {}
        except Exception:
            return {}

    def _save_disk_entry(self, key: str, sig: Tuple[float, int], bundle: Dict) -> None:
        # Coarse-grained: re-read, mutate, re-write. The cache is small
        # (a few KB per game) and writes are infrequent.
        try:
            os.makedirs(os.path.dirname(SPATIAL_CACHE_FILE), exist_ok=True)
            disk = self._load_disk_cache()
            disk[key] = {"sig": [sig[0], sig[1]], "data": bundle}
            tmp = SPATIAL_CACHE_FILE + ".tmp"
            with open(tmp, "w", encoding="utf-8") as f:
                json.dump(disk, f)
                f.flush()
                # Force data blocks to disk before the rename so an
                # NTFS lazy-writer crash doesn't truncate the cache.
                os.fsync(f.fileno())
            os.replace(tmp, SPATIAL_CACHE_FILE)
            # Keep our in-memory copy in sync so the next save has the new
            # entry without needing to read again.
            self._disk_cache = disk
        except Exception:
            # Best-effort cache; failures shouldn't break the heatmap call.
            pass


# ----------------------------------------------------------------- helpers
def kde_fallback_box(point: Tuple[float, float], bounds: Dict,
                     resolution: int = DENSITY_RES) -> Dict:
    """Public helper: 5-cell stamp around a single point.

    Exposed so the test suite can directly verify the single-point fallback
    documented in the module docstring.
    """
    grid = _stamp_grid([point[0]], [point[1]], bounds, resolution)
    return {
        "grid": grid.tolist(),
        "bounds": bounds,
        "resolution": resolution,
        "sample_count": 1,
        "kind": "fallback",
        "fallback_used": True,
    }
