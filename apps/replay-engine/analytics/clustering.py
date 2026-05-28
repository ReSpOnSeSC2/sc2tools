"""Per-game play-style clustering.

Aggregates a single feature vector per game (median income at 4/6/8 min,
third-base timing, key tech-building timings, army peak before 8 min,
supply-blocked seconds, total APM, matchup one-hot) and runs ``KMeans`` for
``k`` in 3..7, picking the best ``k`` by silhouette score. Optionally compares
against ``DBSCAN(eps=0.6)`` and falls back to it if the silhouette is higher.

Each cluster is named from its centroid: distinctive features (largest
standardized centroid components) → human-readable label, win rate, average
key timings, dominant matchup and opening.

Public API (consumed by the UI's "Insights" tab):

    cluster = ClusterEngine.fit_from_db(db, player_name)        # ClusterResult
    cluster.persist_to_db(db, save_callback)                    # write cluster_id back
    cluster.summary_insights()                                  # 3 plain-language insights

The ``cluster_id`` (int) and ``cluster_name`` (str) are written back onto
each game dict in-place so the UI can group/filter by cluster without re-running.
"""

from __future__ import annotations

import math
import os
from collections import Counter
from dataclasses import dataclass, field
from typing import Any, Callable, Dict, List, Optional, Tuple

import numpy as np
import pandas as pd
from sklearn.cluster import DBSCAN, KMeans
from sklearn.metrics import silhouette_score
from sklearn.preprocessing import StandardScaler

from analytics.win_probability import (
    SnapshotFeatureExtractor,
    _matchup_one_hot,
    _normalize_race,
)


# ---------------------------------------------------------------------------
# Tunables
# ---------------------------------------------------------------------------
K_RANGE: List[int] = [3, 4, 5, 6, 7]
DBSCAN_EPS: float = 0.6
DBSCAN_MIN_SAMPLES: int = 5

# Key tech buildings tracked for the "key-building timings" features. Their
# first-occurrence time in seconds becomes a column; missing → 9999.
KEY_BUILDINGS: List[str] = [
    "TwilightCouncil",
    "RoboticsFacility",
    "Stargate",
    "Spire",
    "InfestationPit",
    "Factory",
    "Starport",
]

THIRD_BASE_INDEX: int = 2  # 0-indexed: 1st, 2nd, 3rd-base = index 2

# Per-game aggregate columns, in canonical order.
AGG_COLUMNS: List[str] = [
    "income_4min",
    "income_6min",
    "income_8min",
    "third_base_sec",
    *[f"key_{b}" for b in KEY_BUILDINGS],
    "army_peak_pre8",
    "supply_blocked_sec",
    "apm_total",
    "matchup_PvT",
    "matchup_PvZ",
    "matchup_PvP",
]

# Default value used for "never built" key-building timings (large enough
# that the standardizer treats it as a clear signal of "didn't go that path").
NEVER_BUILT_SENTINEL: float = 9999.0


# ---------------------------------------------------------------------------
# Cluster summary container
# ---------------------------------------------------------------------------
@dataclass
class ClusterSummary:
    """Human-readable summary for one cluster."""
    cluster_id: int
    name: str
    count: int
    win_rate: float
    avg_key_timings: Dict[str, float] = field(default_factory=dict)
    most_common_matchup: str = ""
    most_common_opening: str = ""
    distinctive_features: List[Tuple[str, float]] = field(default_factory=list)

    def to_dict(self) -> Dict[str, Any]:
        return {
            "cluster_id": int(self.cluster_id),
            "name": self.name,
            "count": int(self.count),
            "win_rate": float(self.win_rate),
            "avg_key_timings": {k: float(v) for k, v in self.avg_key_timings.items()},
            "most_common_matchup": self.most_common_matchup,
            "most_common_opening": self.most_common_opening,
            "distinctive_features": [
                {"feature": f, "z_score": float(z)}
                for f, z in self.distinctive_features
            ],
        }


@dataclass
class ClusterResult:
    """Output of `ClusterEngine.fit_from_db`."""
    method: str = ""        # "kmeans-{k}" or "dbscan"
    k: int = 0
    silhouette: float = 0.0
    summaries: List[ClusterSummary] = field(default_factory=list)
    # Parallel arrays: per-game labels + game ids — used to write back to DB.
    game_ids: List[str] = field(default_factory=list)
    labels: List[int] = field(default_factory=list)
    # Centroids in standardized space for distinctive-feature explanation.
    centroids_std: Optional[np.ndarray] = None
    # Original aggregate matrix (for downstream analysis if any).
    feature_matrix: Optional[pd.DataFrame] = None
    insights: List[str] = field(default_factory=list)

    def name_for_id(self, gid: str) -> Optional[str]:
        for g, l in zip(self.game_ids, self.labels):
            if g == gid:
                for s in self.summaries:
                    if s.cluster_id == l:
                        return s.name
                return f"Cluster {l}"
        return None

    # ---- DB integration ----
    def persist_to_db(
        self,
        db: Dict[str, Any],
        save_callback: Optional[Callable[[], None]] = None,
    ) -> int:
        """Write cluster_id + cluster_name back onto each game dict."""
        gid_to_label = dict(zip(self.game_ids, self.labels))
        gid_to_name: Dict[str, str] = {}
        for s in self.summaries:
            for gid, lab in gid_to_label.items():
                if lab == s.cluster_id:
                    gid_to_name[gid] = s.name

        written = 0
        for bd in (db or {}).values():
            if not isinstance(bd, dict):
                continue
            for g in bd.get("games", []) or []:
                gid = g.get("id")
                if gid in gid_to_label:
                    g["cluster_id"] = int(gid_to_label[gid])
                    g["cluster_name"] = gid_to_name.get(gid, f"Cluster {gid_to_label[gid]}")
                    written += 1
        if save_callback is not None:
            try:
                save_callback()
            except Exception:
                pass
        return written

    def to_dict(self) -> Dict[str, Any]:
        return {
            "method": self.method,
            "k": int(self.k),
            "silhouette": float(self.silhouette),
            "summaries": [s.to_dict() for s in self.summaries],
            "game_ids": list(self.game_ids),
            "labels": [int(x) for x in self.labels],
            "insights": list(self.insights),
        }


# ---------------------------------------------------------------------------
# ClusterEngine
# ---------------------------------------------------------------------------
class ClusterEngine:
    """Builds per-game aggregate features then runs KMeans / DBSCAN."""

    def __init__(self) -> None:
        self.snapshot_extractor = SnapshotFeatureExtractor()

    # ---------------------- Top-level entrypoint ----------------------------
    @classmethod
    def fit_from_db(
        cls,
        db: Dict[str, Any],
        player_name: Optional[str] = None,
        progress_cb: Optional[Callable[[int, int], None]] = None,
        min_games: int = 8,
    ) -> Optional[ClusterResult]:
        """Build the per-game aggregate matrix from the DB and cluster.

        Returns ``None`` if the DB has fewer than ``min_games`` usable games.
        """
        engine = cls()
        feature_df = engine._build_aggregate_matrix(db, player_name, progress_cb)
        if feature_df is None or len(feature_df) < min_games:
            return None
        return engine._cluster(feature_df)

    # ---------------------- Feature aggregation ----------------------------
    def _build_aggregate_matrix(
        self,
        db: Dict[str, Any],
        player_name: Optional[str],
        progress_cb: Optional[Callable[[int, int], None]],
    ) -> Optional[pd.DataFrame]:
        """Walk the DB, parse each replay, derive one feature row per game."""
        from core.replay_loader import load_replay_with_fallback
        from analytics.win_probability import WinProbabilityModel

        candidates = []
        for bd in (db or {}).values():
            if not isinstance(bd, dict):
                continue
            for g in bd.get("games", []) or []:
                fp = g.get("file_path")
                if not fp or not os.path.exists(fp):
                    continue
                candidates.append(g)

        if not candidates:
            return None

        rows: List[Dict[str, Any]] = []
        total = len(candidates)
        for idx, g in enumerate(candidates):
            try:
                replay = load_replay_with_fallback(g["file_path"])
                me = WinProbabilityModel._resolve_me(replay, g, player_name)
                if me is None:
                    continue
                row = self._aggregate_for_game(replay, me, g)
                if row is not None:
                    rows.append(row)
            except Exception:
                continue
            finally:
                if progress_cb is not None:
                    try:
                        progress_cb(idx + 1, total)
                    except Exception:
                        pass

        if not rows:
            return None
        df = pd.DataFrame(rows)
        return df

    def _aggregate_for_game(self, replay, me, game: Dict) -> Optional[Dict[str, Any]]:
        """Build the one-row feature vector for a single game."""
        try:
            from core.event_extractor import (
                PlayerStatsEvent,
                UnitBornEvent,
                UnitInitEvent,
                UnitDoneEvent,
            )
        except Exception:
            return None

        my_pid = me.pid
        my_race = getattr(me, "play_race", "") or ""
        opp_player = next(
            (p for p in replay.players
             if getattr(p, "pid", None) != my_pid
             and not getattr(p, "is_observer", False)
             and not getattr(p, "is_referee", False)),
            None,
        )
        opp_race = getattr(opp_player, "play_race", "") if opp_player else ""

        # ---- per-stats-event income series + supply-blocked seconds ----
        stats_rows: List[Tuple[int, float, float, int, int]] = []
        # (time_sec, min_rate, gas_rate, food_used, food_made)
        tracker = getattr(replay, "tracker_events", None) or []
        for e in tracker:
            try:
                if not isinstance(e, PlayerStatsEvent):
                    continue
                pid = getattr(e, "pid", None) or (
                    getattr(getattr(e, "player", None), "pid", None) if getattr(e, "player", None) else None
                )
                if pid != my_pid:
                    continue
                stats_rows.append((
                    int(getattr(e, "second", 0)),
                    float(getattr(e, "minerals_collection_rate", 0)),
                    float(getattr(e, "vespene_collection_rate", 0)),
                    int(getattr(e, "food_used", 0)),
                    int(getattr(e, "food_made", 0)),
                ))
            except Exception:
                continue

        income_at = lambda min_t: self._income_at_minute(stats_rows, min_t)
        supply_blocked_sec = self._supply_blocked_seconds(stats_rows)

        # ---- army peak before 8 min ----
        army_peak_pre8 = 0.0
        for e in tracker:
            try:
                if not isinstance(e, PlayerStatsEvent):
                    continue
                pid = getattr(e, "pid", None) or (
                    getattr(getattr(e, "player", None), "pid", None) if getattr(e, "player", None) else None
                )
                if pid != my_pid:
                    continue
                t = int(getattr(e, "second", 0))
                if t > 8 * 60:
                    continue
                a = float(
                    getattr(e, "minerals_used_active_forces",
                            getattr(e, "minerals_used_current_army", 0))
                    + getattr(e, "vespene_used_active_forces",
                              getattr(e, "vespene_used_current_army", 0))
                )
                army_peak_pre8 = max(army_peak_pre8, a)
            except Exception:
                continue

        # ---- key-building timings + town-hall (3rd base) timing ----
        key_first_seen: Dict[str, float] = {b: NEVER_BUILT_SENTINEL for b in KEY_BUILDINGS}
        town_halls_times: List[float] = []
        from analytics.win_probability import TOWN_HALL_TYPES, _clean_building_name

        for e in tracker:
            try:
                if not isinstance(e, (UnitInitEvent, UnitBornEvent, UnitDoneEvent)):
                    continue
                pid = SnapshotFeatureExtractor._owner_pid(e)
                if pid != my_pid:
                    continue
                raw = SnapshotFeatureExtractor._unit_name(e)
                if not raw:
                    continue
                clean = _clean_building_name(raw)
                t = float(getattr(e, "second", 0))
                # Town-hall timings (use init for P/T, born for Z hatcheries).
                if clean in TOWN_HALL_TYPES and (
                    isinstance(e, UnitInitEvent)
                    or (isinstance(e, UnitBornEvent) and clean == "Hatchery")
                ):
                    town_halls_times.append(t)
                # Key-building first-occurrence (any of init/born/done).
                if clean in key_first_seen:
                    if t < key_first_seen[clean]:
                        key_first_seen[clean] = t
            except Exception:
                continue
        town_halls_times.sort()
        third_base_sec = (
            town_halls_times[THIRD_BASE_INDEX]
            if len(town_halls_times) > THIRD_BASE_INDEX
            else NEVER_BUILT_SENTINEL
        )

        # ---- APM total (use sc2reader's per-player apm if available) ----
        apm_total = 0.0
        try:
            apm_dict = getattr(replay, "apm", None)
            if isinstance(apm_dict, dict) and my_pid in apm_dict:
                vals = list(apm_dict[my_pid].values())
                if vals:
                    apm_total = float(np.mean(vals))
            if apm_total == 0.0:
                # Fallback: count player command events / minutes.
                cmd_count = 0
                for e in getattr(replay, "events", []) or []:
                    pid = getattr(e, "pid", None)
                    if pid == my_pid and "Command" in type(e).__name__:
                        cmd_count += 1
                gl = getattr(replay, "game_length", None)
                game_min = (gl.seconds / 60.0) if gl else 1.0
                apm_total = float(cmd_count / max(game_min, 1.0))
        except Exception:
            apm_total = 0.0

        # ---- matchup one-hot (only my matchups for now) ----
        matchup = _matchup_one_hot(my_race, opp_race)

        # Opening label: first 3 keys from build_log if available, otherwise
        # earliest-completed tech building.
        opening = "?"
        bl = game.get("build_log") or []
        if bl:
            tokens = []
            for line in bl[:5]:
                if "] " in line:
                    tokens.append(line.split("] ", 1)[1])
            opening = " > ".join(tokens[:3]) if tokens else "?"

        return {
            "game_id": game.get("id", ""),
            "income_4min": income_at(4),
            "income_6min": income_at(6),
            "income_8min": income_at(8),
            "third_base_sec": float(third_base_sec),
            **{f"key_{b}": float(key_first_seen[b]) for b in KEY_BUILDINGS},
            "army_peak_pre8": float(army_peak_pre8),
            "supply_blocked_sec": float(supply_blocked_sec),
            "apm_total": float(apm_total),
            **{k: float(v) for k, v in matchup.items()},
            # Carry along result + matchup label for later summary work
            # (these columns are stripped before standardization).
            "_result": game.get("result", "Unknown"),
            "_matchup_label": f"{_normalize_race(my_race)}v{_normalize_race(opp_race)}",
            "_opening": opening,
        }

    # ----- per-stats-event helpers ------------------------------------
    @staticmethod
    def _income_at_minute(rows: List[Tuple[int, float, float, int, int]], min_t: int) -> float:
        """Median (mineral_rate + gas_rate) within ±30 sec of `min_t`."""
        target = min_t * 60
        window = [r for r in rows if abs(r[0] - target) <= 30]
        if not window:
            # Pick the closest sample as a fallback.
            if not rows:
                return 0.0
            r = min(rows, key=lambda x: abs(x[0] - target))
            return float(r[1] + r[2])
        return float(np.median([r[1] + r[2] for r in window]))

    @staticmethod
    def _supply_blocked_seconds(rows: List[Tuple[int, float, float, int, int]]) -> float:
        """Approx supply-blocked seconds: time food_used >= food_made and food_made < 200."""
        if len(rows) < 2:
            return 0.0
        rows = sorted(rows, key=lambda x: x[0])
        blocked = 0.0
        for prev, curr in zip(rows, rows[1:]):
            t_prev, _, _, used_p, made_p = prev
            t_curr, _, _, used_c, made_c = curr
            dt = max(0, t_curr - t_prev)
            if used_p >= made_p and made_p < 200:
                blocked += dt
        return float(blocked)

    # ---------------------- Clustering core ----------------------
    def _cluster(self, feature_df: pd.DataFrame) -> ClusterResult:
        """Standardize, run KMeans 3..7 + DBSCAN, pick best by silhouette."""
        meta_cols = [c for c in feature_df.columns if c.startswith("_") or c == "game_id"]
        feature_cols = [c for c in feature_df.columns if c not in meta_cols]
        # Enforce canonical column order (any missing → 0).
        for c in AGG_COLUMNS:
            if c not in feature_df.columns:
                feature_df[c] = 0.0
        X = feature_df[AGG_COLUMNS].astype(float).values
        scaler = StandardScaler()
        Xs = scaler.fit_transform(X)

        best = {
            "method": "kmeans-3",
            "k": 3,
            "silhouette": -1.0,
            "labels": None,
            "centroids_std": None,
        }
        n_samples = len(Xs)
        for k in K_RANGE:
            if k >= n_samples:
                continue
            km = KMeans(n_clusters=k, n_init=10, random_state=42)
            labels = km.fit_predict(Xs)
            try:
                score = silhouette_score(Xs, labels) if len(set(labels)) > 1 else -1.0
            except Exception:
                score = -1.0
            if score > best["silhouette"]:
                best.update({
                    "method": f"kmeans-{k}",
                    "k": k,
                    "silhouette": float(score),
                    "labels": labels.tolist(),
                    "centroids_std": km.cluster_centers_,
                })

        # Try DBSCAN as a comparison.
        try:
            db = DBSCAN(eps=DBSCAN_EPS, min_samples=DBSCAN_MIN_SAMPLES)
            db_labels = db.fit_predict(Xs)
            non_noise = db_labels[db_labels != -1]
            if len(set(non_noise)) > 1:
                mask = db_labels != -1
                if mask.sum() >= 2:
                    try:
                        db_score = silhouette_score(Xs[mask], db_labels[mask])
                    except Exception:
                        db_score = -1.0
                    if db_score > best["silhouette"]:
                        # Synthesize centroids by averaging Xs by label.
                        unique = sorted(set(db_labels.tolist()))
                        centroids = []
                        new_labels = []
                        # Re-map -1 (noise) into its own cluster.
                        label_remap = {lab: i for i, lab in enumerate(unique)}
                        for lab in db_labels:
                            new_labels.append(label_remap[lab])
                        for lab in unique:
                            members = Xs[np.array(db_labels) == lab]
                            centroids.append(members.mean(axis=0))
                        best.update({
                            "method": "dbscan",
                            "k": len(unique),
                            "silhouette": float(db_score),
                            "labels": new_labels,
                            "centroids_std": np.asarray(centroids),
                        })
        except Exception:
            pass

        result = ClusterResult(
            method=str(best["method"]),
            k=int(best["k"]),
            silhouette=float(best["silhouette"]),
            game_ids=feature_df["game_id"].tolist(),
            labels=[int(x) for x in (best["labels"] or [])],
            centroids_std=best["centroids_std"],
            feature_matrix=feature_df,
        )

        # Build per-cluster summaries
        result.summaries = self._build_summaries(feature_df, result)
        result.insights = self._build_insights(feature_df, result)
        return result

    # ---------------------- Naming + summarization ----------------------
    def _build_summaries(
        self, feature_df: pd.DataFrame, result: ClusterResult,
    ) -> List[ClusterSummary]:
        summaries: List[ClusterSummary] = []
        labels = np.asarray(result.labels)
        centroids = result.centroids_std
        if centroids is None:
            return summaries

        # Distinctiveness: standardize across centroids so we get the per-feature
        # z-score of each cluster's centroid, then pick the largest |z|.
        col_mean = centroids.mean(axis=0)
        col_std = centroids.std(axis=0)
        col_std[col_std == 0] = 1.0
        centroid_z = (centroids - col_mean) / col_std

        for cid in sorted(set(labels.tolist())):
            mask = labels == cid
            sub = feature_df[mask]
            count = int(mask.sum())
            if count == 0:
                continue
            results = sub.get("_result", pd.Series(["Unknown"] * count))
            wins = int((results == "Win").sum())
            losses = int((results == "Loss").sum())
            wl_total = wins + losses
            win_rate = (wins / wl_total) if wl_total > 0 else 0.0

            # Most-common matchup / opening.
            mc_matchup = (
                Counter(sub.get("_matchup_label", pd.Series([])).tolist()).most_common(1)
                or [("?", 0)]
            )[0][0]
            mc_opening = (
                Counter(sub.get("_opening", pd.Series([])).tolist()).most_common(1)
                or [("?", 0)]
            )[0][0]

            avg_key = {
                b: float(sub[f"key_{b}"].mean())
                for b in KEY_BUILDINGS
                if f"key_{b}" in sub.columns
            }
            # Distinctive features for this cluster (top 3 by |z|).
            z = centroid_z[cid] if cid < len(centroid_z) else np.zeros(len(AGG_COLUMNS))
            top_idx = np.argsort(-np.abs(z))[:3]
            distinctive: List[Tuple[str, float]] = [
                (AGG_COLUMNS[i], float(z[i])) for i in top_idx
            ]

            name = self._auto_name(
                cluster_id=int(cid),
                centroid_z=z,
                avg_third_base=float(sub["third_base_sec"].mean())
                                if "third_base_sec" in sub.columns else NEVER_BUILT_SENTINEL,
                avg_income_8min=float(sub["income_8min"].mean())
                                if "income_8min" in sub.columns else 0.0,
                win_rate=win_rate,
                avg_apm=float(sub["apm_total"].mean()) if "apm_total" in sub.columns else 0.0,
            )

            summaries.append(ClusterSummary(
                cluster_id=int(cid),
                name=name,
                count=count,
                win_rate=float(win_rate),
                avg_key_timings=avg_key,
                most_common_matchup=mc_matchup,
                most_common_opening=mc_opening,
                distinctive_features=distinctive,
            ))
        return summaries

    @staticmethod
    def _auto_name(
        cluster_id: int,
        centroid_z: np.ndarray,
        avg_third_base: float,
        avg_income_8min: float,
        win_rate: float,
        avg_apm: float,
    ) -> str:
        """Compose a punchy human-readable cluster label."""
        # Third-base classification: <4:30 = Fast, 4:30-6:00 = Standard, >6:00 = Late, never = "No 3rd"
        if avg_third_base >= NEVER_BUILT_SENTINEL - 1:
            third_label = "No 3rd Base"
        elif avg_third_base < 4.5 * 60:
            third_label = "Fast 3rd"
        elif avg_third_base < 6.0 * 60:
            third_label = "Standard 3rd"
        else:
            third_label = "Late 3rd"

        # Income classification: tag relative to average across clusters.
        # Use the standardized z-score for income_8min (column index in AGG_COLUMNS).
        try:
            income_idx = AGG_COLUMNS.index("income_8min")
            income_z = float(centroid_z[income_idx]) if income_idx < len(centroid_z) else 0.0
        except ValueError:
            income_z = 0.0
        if income_z >= 0.5:
            income_label = "High Income"
        elif income_z <= -0.5:
            income_label = "Low Income"
        else:
            income_label = "Avg Income"

        # APM tag — only added for outliers.
        apm_tag = ""
        try:
            apm_idx = AGG_COLUMNS.index("apm_total")
            apm_z = float(centroid_z[apm_idx]) if apm_idx < len(centroid_z) else 0.0
        except ValueError:
            apm_z = 0.0
        if apm_z >= 1.0:
            apm_tag = " High APM"
        elif apm_z <= -1.0:
            apm_tag = " Low APM"

        wr_pct = int(round(win_rate * 100))
        return f"{third_label} / {income_label}{apm_tag} (W:{wr_pct}%)"

    # ---------------------- Top-level insights ----------------------
    def _build_insights(
        self, feature_df: pd.DataFrame, result: ClusterResult,
    ) -> List[str]:
        """Three plain-language insights comparing high-WR vs low-WR clusters."""
        if not result.summaries:
            return []
        # Split clusters into high-WR (>=60%) vs low-WR (<=40%) when possible;
        # fall back to top-1 vs bottom-1 by WR if neither split is populated.
        high = [s for s in result.summaries if s.win_rate >= 0.6 and s.count >= 3]
        low = [s for s in result.summaries if s.win_rate <= 0.4 and s.count >= 3]
        if not high or not low:
            sorted_s = sorted(result.summaries, key=lambda s: s.win_rate, reverse=True)
            high = sorted_s[:1]
            low = sorted_s[-1:]
            if high == low:
                return [
                    f"All clusters have similar win rates "
                    f"(range: {min(s.win_rate for s in result.summaries):.0%} - "
                    f"{max(s.win_rate for s in result.summaries):.0%}). "
                    f"Style isn't the deciding factor — look at the macro report."
                ]

        insights: List[str] = []

        # Insight #1: 3rd-base timing in wins vs losses (across whole DB).
        try:
            wins_df = feature_df[feature_df["_result"] == "Win"]
            losses_df = feature_df[feature_df["_result"] == "Loss"]
            if len(wins_df) >= 3 and len(losses_df) >= 3:
                med_w = float(np.median(wins_df["third_base_sec"]))
                med_l = float(np.median(losses_df["third_base_sec"]))
                if med_w < NEVER_BUILT_SENTINEL - 1 and med_l < NEVER_BUILT_SENTINEL - 1:
                    diff = med_l - med_w
                    if abs(diff) >= 15:
                        # Express WR uplift if the user took a 3rd before med_w.
                        early_mask = feature_df["third_base_sec"] <= med_w
                        late_mask = feature_df["third_base_sec"] > med_w
                        early_wr = (
                            (feature_df[early_mask]["_result"] == "Win").mean()
                            if early_mask.sum() else 0.0
                        )
                        late_wr = (
                            (feature_df[late_mask]["_result"] == "Win").mean()
                            if late_mask.sum() else 0.0
                        )
                        delta = (early_wr - late_wr) * 100.0
                        insights.append(
                            f"Your 3rd base in wins: {self._fmt_seconds(med_w)} median. "
                            f"In losses: {self._fmt_seconds(med_l)}. "
                            f"Faster third correlates with "
                            f"{('+' if delta >= 0 else '')}{delta:.0f}% win rate."
                        )
        except Exception:
            pass

        # Insight #2: distinctive feature gap between best and worst cluster.
        try:
            best = max(result.summaries, key=lambda s: s.win_rate)
            worst = min(result.summaries, key=lambda s: s.win_rate)
            if best.cluster_id != worst.cluster_id:
                gap = (best.win_rate - worst.win_rate) * 100
                top = best.distinctive_features[0] if best.distinctive_features else None
                if top is not None:
                    direction = "high" if top[1] > 0 else "low"
                    insights.append(
                        f'"{best.name}" wins {gap:.0f}% more often than "{worst.name}". '
                        f"Its defining trait: {direction} {self._humanize_feature(top[0])}."
                    )
        except Exception:
            pass

        # Insight #3: army-peak-pre-8min comparison.
        try:
            wins_df = feature_df[feature_df["_result"] == "Win"]
            losses_df = feature_df[feature_df["_result"] == "Loss"]
            if len(wins_df) >= 3 and len(losses_df) >= 3:
                w_peak = float(np.mean(wins_df["army_peak_pre8"]))
                l_peak = float(np.mean(losses_df["army_peak_pre8"]))
                if abs(w_peak - l_peak) > 100:
                    bigger = "more" if w_peak > l_peak else "less"
                    insights.append(
                        f"In wins you carry {bigger} army before 8:00 "
                        f"(avg {int(w_peak)} vs {int(l_peak)} mineral+gas value). "
                        f"Earlier military presence is shaping your wins."
                    )
        except Exception:
            pass

        if not insights:
            insights.append(
                f"Detected {len(result.summaries)} play-styles "
                f"(silhouette {result.silhouette:.2f}). "
                f"Open a cluster card to see which games belong to it."
            )
        return insights

    @staticmethod
    def _fmt_seconds(s: float) -> str:
        if s >= NEVER_BUILT_SENTINEL - 1:
            return "never"
        m = int(s) // 60
        ss = int(s) % 60
        return f"{m}:{ss:02d}"

    @staticmethod
    def _humanize_feature(col: str) -> str:
        if col.startswith("key_"):
            return f"{col[4:]} timing"
        if col == "third_base_sec":
            return "third-base timing"
        if col == "income_4min":
            return "4-minute income"
        if col == "income_6min":
            return "6-minute income"
        if col == "income_8min":
            return "8-minute income"
        if col == "army_peak_pre8":
            return "early army value"
        if col == "supply_blocked_sec":
            return "supply-blocked seconds"
        if col == "apm_total":
            return "APM"
        if col.startswith("matchup_"):
            return col[len("matchup_"):]
        return col
