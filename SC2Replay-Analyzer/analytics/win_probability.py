"""Per-game Win Probability model and snapshot feature extractor.

This module implements two production-grade pieces:

1.  ``SnapshotFeatureExtractor`` — walks a parsed sc2reader replay and produces
    a per-snapshot pandas DataFrame keyed by minute. One row per minute with
    aggregated (mean) values across all PlayerStatsEvent samples that fell
    inside the bin.

2.  ``WinProbabilityModel`` — a logistic-regression classifier (with
    ``class_weight='balanced'``) trained on (snapshot, win-label) rows
    aggregated across the entire replay database. Persists to
    ``wp_model.pkl`` next to ``meta_database.json``. Refuses to train when
    fewer than 50 games with results are available — the cold-start branch
    returns ``None`` so the UI can render a "Need 50 games to train." message.

The model exposes two public surfaces:

    model = WinProbabilityModel.load_or_new()
    model.train(db)                                    # fit + persist
    curve = model.predict_curve(game_features_df)     # [(minute, p_win), ...]

Both pieces are deliberately decoupled from any UI imports so the analytics
layer remains importable from a headless context (browser app, CI tests).
"""

from __future__ import annotations

import concurrent.futures
import multiprocessing
import os
import pickle
import time
from dataclasses import dataclass, field
from datetime import datetime
from typing import Any, Dict, List, Optional, Tuple

import numpy as np
import pandas as pd
from sklearn.linear_model import LogisticRegression
from sklearn.metrics import roc_auc_score
from sklearn.model_selection import train_test_split
from sklearn.preprocessing import StandardScaler

from core.paths import DB_FILE


# ---------------------------------------------------------------------------
# Module configuration
# ---------------------------------------------------------------------------
WP_MODEL_FILE: str = os.path.join(os.path.dirname(DB_FILE), "wp_model.pkl")

# Below this many games-with-results we refuse to train.
COLD_START_GAMES_REQUIRED: int = 50

# Canonical feature column order — must stay stable for model persistence.
FEATURE_COLUMNS: List[str] = [
    "supply_diff",
    "income_min_diff",
    "income_gas_diff",
    "army_value_diff",
    "nexus_count_diff",
    "tech_score_self",
    "tech_score_opp",
    "matchup_PvT",
    "matchup_PvZ",
    "matchup_PvP",
]

# Tech-tier weights used for the tech_score_self / tech_score_opp features.
# Higher tier = more "researched" feel, so the score grows with tech progress.
TECH_BUILDING_TIERS: Dict[str, int] = {
    # Protoss
    "Forge": 1, "CyberneticsCore": 1, "TwilightCouncil": 2,
    "RoboticsFacility": 2, "Stargate": 2, "DarkShrine": 2,
    "TemplarArchive": 3, "RoboticsBay": 3, "FleetBeacon": 3,
    # Zerg
    "EvolutionChamber": 1, "SpawningPool": 1, "RoachWarren": 1,
    "BanelingNest": 1, "HydraliskDen": 2, "InfestationPit": 2,
    "Spire": 2, "NydusNetwork": 2, "LurkerDen": 3,
    "GreaterSpire": 3, "UltraliskCavern": 3,
    # Terran
    "EngineeringBay": 1, "Factory": 1, "Armory": 2, "Starport": 2,
    "GhostAcademy": 3, "FusionCore": 3,
    "BarracksTechLab": 1, "FactoryTechLab": 1, "StarportTechLab": 1,
    "BarracksReactor": 1, "FactoryReactor": 1, "StarportReactor": 1,
}

TOWN_HALL_TYPES: set = {
    "Nexus",
    "Hatchery", "Lair", "Hive",
    "CommandCenter", "OrbitalCommand", "PlanetaryFortress",
}


# ---------------------------------------------------------------------------
# Helpers — race/name normalization and matchup one-hot
# ---------------------------------------------------------------------------
def _normalize_race(race: Optional[str]) -> str:
    """Map sc2reader race strings (Protoss/Terran/Zerg) to a single letter."""
    if not race:
        return "?"
    r = race.strip().upper()
    if r.startswith("P"):
        return "P"
    if r.startswith("T"):
        return "T"
    if r.startswith("Z"):
        return "Z"
    return "?"


def _matchup_one_hot(my_race: str, opp_race: str) -> Dict[str, int]:
    """Return the matchup one-hot dict in canonical column order.

    Currently we only one-hot encode the user's matchups (PvT/PvZ/PvP) since
    the spec is Protoss-centric. Mixed-race users will get all-zero matchup
    columns — the model still trains on supply/income/etc. for those rows.
    """
    me = _normalize_race(my_race)
    opp = _normalize_race(opp_race)
    return {
        "matchup_PvT": int(me == "P" and opp == "T"),
        "matchup_PvZ": int(me == "P" and opp == "Z"),
        "matchup_PvP": int(me == "P" and opp == "P"),
    }


def _clean_building_name(raw: str) -> str:
    """Strip race-prefix ('Protoss', 'Terran', 'Zerg') and Lower/Upper suffix."""
    if not raw:
        return ""
    out = raw
    for prefix in ("Protoss", "Terran", "Zerg"):
        out = out.replace(prefix, "")
    for suffix in ("Lower", "Upper"):
        out = out.replace(suffix, "")
    return out.strip()


# ---------------------------------------------------------------------------
# SnapshotFeatureExtractor
# ---------------------------------------------------------------------------
class SnapshotFeatureExtractor:
    """Build per-game per-minute snapshot DataFrames from a parsed replay.

    Pulls PlayerStatsEvent samples (~10s cadence in sc2reader) for both the
    user and the opponent, then walks UnitInit/UnitBornEvent for both players
    to build cumulative town-hall and tech-building counts over time.

    The output DataFrame has one row per snapshot (so ~6 rows per game minute)
    pre-resample, then is resampled to 1-minute bins via mean.

    Returned columns (canonical order):

        minute, supply_diff, income_min_diff, income_gas_diff,
        army_value_diff, nexus_count_diff,
        tech_score_self, tech_score_opp,
        matchup_PvT, matchup_PvZ, matchup_PvP
    """

    def extract(self, replay, my_pid: int) -> pd.DataFrame:
        """Top-level entry. Returns a DataFrame indexed 0..N minutes."""
        try:
            from core.event_extractor import (
                PlayerStatsEvent,
                UnitBornEvent,
                UnitInitEvent,
                UnitDoneEvent,
            )
        except Exception:
            # Re-raise as a clean RuntimeError so callers see a single-line
            # message rather than the sc2reader stack.
            raise RuntimeError("sc2reader / event_extractor not importable")

        me_p, opp_p = self._resolve_players(replay, my_pid)
        if opp_p is None:
            return pd.DataFrame(columns=["minute"] + FEATURE_COLUMNS)
        opp_pid = getattr(opp_p, "pid", None)
        if opp_pid is None:
            return pd.DataFrame(columns=["minute"] + FEATURE_COLUMNS)

        my_race = getattr(me_p, "play_race", "") if me_p is not None else ""
        opp_race = getattr(opp_p, "play_race", "") if opp_p is not None else ""
        matchup_oh = _matchup_one_hot(my_race, opp_race)

        # Step 1: pull PlayerStatsEvent samples for both players, indexed by
        # the integer second they fired at.
        my_stats: Dict[int, Dict[str, float]] = {}
        opp_stats: Dict[int, Dict[str, float]] = {}
        tracker = getattr(replay, "tracker_events", None) or []
        for e in tracker:
            try:
                if not isinstance(e, PlayerStatsEvent):
                    continue
                pid = getattr(e, "pid", None)
                if pid is None:
                    p = getattr(e, "player", None)
                    pid = getattr(p, "pid", None) if p else None
                if pid is None:
                    continue
                t = int(getattr(e, "second", 0))
                row = self._stats_row(e)
                if pid == my_pid:
                    my_stats[t] = row
                elif pid == opp_pid:
                    opp_stats[t] = row
            except Exception:
                continue

        # Step 2: walk building events for tech-score and nexus count.
        my_tech_events: List[Tuple[int, int]] = []   # (time_sec, tier_score)
        opp_tech_events: List[Tuple[int, int]] = []
        my_nexus_events: List[int] = []              # times at which town hall built
        opp_nexus_events: List[int] = []
        for e in tracker:
            try:
                if not isinstance(e, (UnitBornEvent, UnitInitEvent, UnitDoneEvent)):
                    continue
                pid = self._owner_pid(e)
                if pid is None:
                    continue
                raw = self._unit_name(e)
                if not raw:
                    continue
                clean = _clean_building_name(raw)
                t = int(getattr(e, "second", 0))
                # Town halls — count once per init (not done) so we don't
                # double-count the morph chain. UnitInit is the start of
                # construction; the first occurrence of a unit_id is what we
                # care about.
                if clean in TOWN_HALL_TYPES and isinstance(e, UnitInitEvent):
                    if pid == my_pid:
                        my_nexus_events.append(t)
                    elif pid == opp_pid:
                        opp_nexus_events.append(t)
                    continue
                # Zerg town halls don't fire UnitInit (drone morphs straight
                # into Hatchery); fall back to UnitBornEvent for Hatchery.
                if clean == "Hatchery" and isinstance(e, UnitBornEvent):
                    if pid == my_pid:
                        my_nexus_events.append(t)
                    elif pid == opp_pid:
                        opp_nexus_events.append(t)
                    continue
                # Tech buildings (counted at completion / Done).
                tier = TECH_BUILDING_TIERS.get(clean, 0)
                if tier <= 0:
                    continue
                # Use UnitDone for completion; for Zerg morphs (no Done) we
                # accept UnitBorn. For Init we wait for completion to count
                # it — partial buildings shouldn't add tech score.
                if isinstance(e, UnitDoneEvent) or (
                    isinstance(e, UnitBornEvent) and clean in ("SpawningPool", "RoachWarren")
                ):
                    if pid == my_pid:
                        my_tech_events.append((t, tier))
                    elif pid == opp_pid:
                        opp_tech_events.append((t, tier))
            except Exception:
                continue

        # Step 3: build cumulative tech-score / nexus-count time-series.
        my_tech_cum = self._cumsum_timeline(my_tech_events)
        opp_tech_cum = self._cumsum_timeline(opp_tech_events)
        my_nexus_cum = self._counter_timeline(my_nexus_events)
        opp_nexus_cum = self._counter_timeline(opp_nexus_events)

        # Step 4: assemble the per-snapshot DataFrame. Iterate over every
        # second the user had a stats event (the user-side cadence is the
        # canonical "tick"); look up opp stats with last-known-good carry-fwd.
        rows: List[Dict[str, float]] = []
        sorted_times = sorted(my_stats.keys())
        # Build sorted opp keys once for fast bisect-style lookup.
        opp_sorted_times = sorted(opp_stats.keys())
        for t in sorted_times:
            mine = my_stats[t]
            opp = self._lookup_carry(opp_stats, opp_sorted_times, t)
            if opp is None:
                # No opp data yet — synthesize zero so we still emit the row.
                opp = {"supply": 0.0, "min_rate": 0.0, "gas_rate": 0.0, "army_val": 0.0}
            rows.append({
                "minute": t / 60.0,
                "supply_diff": mine["supply"] - opp["supply"],
                "income_min_diff": mine["min_rate"] - opp["min_rate"],
                "income_gas_diff": mine["gas_rate"] - opp["gas_rate"],
                "army_value_diff": mine["army_val"] - opp["army_val"],
                "nexus_count_diff":
                    self._lookup_step(my_nexus_cum, t)
                    - self._lookup_step(opp_nexus_cum, t),
                "tech_score_self": float(self._lookup_step(my_tech_cum, t)),
                "tech_score_opp": float(self._lookup_step(opp_tech_cum, t)),
                **{k: float(v) for k, v in matchup_oh.items()},
            })

        if not rows:
            return pd.DataFrame(columns=["minute"] + FEATURE_COLUMNS)

        df = pd.DataFrame(rows)

        # Step 5: resample to 1-minute bins via mean.
        df["minute_bin"] = df["minute"].astype(float).apply(np.floor).astype(int)
        agg = df.groupby("minute_bin").mean(numeric_only=True).reset_index()
        agg = agg.rename(columns={"minute_bin": "minute"})
        # Drop helper minute column from the original df (the agg already has
        # 'minute' as the integer bin index).
        agg = agg.drop(columns=[c for c in agg.columns if c == "minute_bin"], errors="ignore")
        # Re-cast minute to int + reorder columns.
        agg["minute"] = agg["minute"].astype(int)
        ordered = ["minute"] + FEATURE_COLUMNS
        for c in ordered:
            if c not in agg.columns:
                agg[c] = 0.0
        return agg[ordered]

    # ------------------------------------------------------------------ utils
    @staticmethod
    def _resolve_players(replay, my_pid: int):
        """Return (me_player, opp_player) - opp is the first non-self human."""
        me = next((p for p in replay.players if getattr(p, "pid", None) == my_pid), None)
        opp = next(
            (p for p in replay.players
             if getattr(p, "pid", None) != my_pid
             and not getattr(p, "is_observer", False)
             and not getattr(p, "is_referee", False)),
            None,
        )
        return me, opp

    @staticmethod
    def _stats_row(event) -> Dict[str, float]:
        return {
            "supply": float(getattr(event, "food_used", 0)),
            "min_rate": float(getattr(event, "minerals_collection_rate", 0)),
            "gas_rate": float(getattr(event, "vespene_collection_rate", 0)),
            "army_val": float(
                getattr(event, "minerals_used_active_forces",
                        getattr(event, "minerals_used_current_army", 0))
                + getattr(event, "vespene_used_active_forces",
                          getattr(event, "vespene_used_current_army", 0))
            ),
        }

    @staticmethod
    def _owner_pid(event) -> Optional[int]:
        for attr in ("control_pid", "pid"):
            v = getattr(event, attr, None)
            if v is not None and v > 0:
                return v
        unit = getattr(event, "unit", None)
        if unit is not None:
            owner = getattr(unit, "owner", None)
            if owner is not None and getattr(owner, "pid", 0):
                return owner.pid
        player = getattr(event, "player", None)
        if player is not None and getattr(player, "pid", 0):
            return player.pid
        return None

    @staticmethod
    def _unit_name(event) -> Optional[str]:
        n = getattr(event, "unit_type_name", None)
        if n:
            return n
        u = getattr(event, "unit", None)
        if u is not None:
            return getattr(u, "name", None)
        return None

    @staticmethod
    def _cumsum_timeline(events: List[Tuple[int, int]]) -> List[Tuple[int, int]]:
        """Convert (time, delta) events into a sorted (time, cumulative)
        timeline used for fast carry-forward lookup."""
        events = sorted(events, key=lambda x: x[0])
        out: List[Tuple[int, int]] = []
        running = 0
        for t, d in events:
            running += d
            out.append((t, running))
        return out

    @staticmethod
    def _counter_timeline(events: List[int]) -> List[Tuple[int, int]]:
        """(time,) -> (time, cumulative_count) timeline."""
        events = sorted(events)
        out: List[Tuple[int, int]] = []
        running = 0
        for t in events:
            running += 1
            out.append((t, running))
        return out

    @staticmethod
    def _lookup_step(timeline: List[Tuple[int, int]], t: int) -> int:
        """Return the most-recent value at or before time `t` (or 0)."""
        if not timeline:
            return 0
        # Linear scan — N is tiny (<=50 buildings/town halls per game).
        last = 0
        for tt, v in timeline:
            if tt <= t:
                last = v
            else:
                break
        return last

    @staticmethod
    def _lookup_carry(stats: Dict[int, Dict[str, float]],
                      sorted_times: List[int],
                      t: int) -> Optional[Dict[str, float]]:
        """Last-known-good lookup. None if no sample at-or-before t."""
        if not sorted_times:
            return None
        # bisect-like manual scan because sorted_times is small (<200).
        last_t = None
        for tt in sorted_times:
            if tt <= t:
                last_t = tt
            else:
                break
        if last_t is None:
            return None
        return stats.get(last_t)


# ---------------------------------------------------------------------------
# Top-level worker for parallel replay parsing during training.
# ---------------------------------------------------------------------------
# Must remain a module-level callable so `ProcessPoolExecutor` can pickle it.
# Returns (success, X_rows, y_rows, error_message). On failure both row lists
# are empty and `error_message` carries a short reason string.
def _wp_train_worker(args):
    """Parse one replay and return the snapshot rows + label.

    Heavy lifting (sc2reader load + per-stats walk) happens entirely inside
    the worker process so the main thread stays responsive. The args tuple
    is `(file_path, game_dict, label, player_name)`.
    """
    file_path, game, label, player_name = args
    try:
        from core.replay_loader import load_replay_with_fallback
        replay = load_replay_with_fallback(file_path)
        me = WinProbabilityModel._resolve_me(replay, game, player_name)
        if me is None:
            return (False, [], [], "could not resolve player")
        df = SnapshotFeatureExtractor().extract(replay, me.pid)
        if df.empty:
            return (False, [], [], "no PlayerStatsEvent samples")
        X_rows: List[List[float]] = []
        y_rows: List[int] = []
        for _, r in df.iterrows():
            X_rows.append([float(r[c]) for c in FEATURE_COLUMNS])
            y_rows.append(int(label))
        return (True, X_rows, y_rows, None)
    except Exception as exc:
        return (False, [], [], f"{type(exc).__name__}: {exc}")


# ---------------------------------------------------------------------------
# WinProbabilityModel
# ---------------------------------------------------------------------------
@dataclass
class TrainingReport:
    """Returned by `WinProbabilityModel.train`. Empty when cold-start failed."""
    trained: bool = False
    games_used: int = 0
    games_skipped: int = 0
    snapshots: int = 0
    auc: Optional[float] = None
    last_trained: Optional[str] = None
    games_needed: Optional[int] = None
    message: str = ""

    def to_dict(self) -> Dict[str, Any]:
        return {
            "trained": self.trained,
            "games_used": self.games_used,
            "games_skipped": self.games_skipped,
            "snapshots": self.snapshots,
            "auc": self.auc,
            "last_trained": self.last_trained,
            "games_needed": self.games_needed,
            "message": self.message,
        }


class WinProbabilityModel:
    """Logistic regression over per-snapshot game features.

    A row in the training matrix is one (minute, feature-vector) snapshot
    from one game, labeled with the game-level result (1 if Win, 0 if Loss).
    Snapshots from games whose result is "Unknown" are skipped.

    Persistence: the entire object (model + scaler + metadata) is pickled to
    `wp_model.pkl` next to the DB. Use `load_or_new()` to construct.
    """

    def __init__(self) -> None:
        self.model: Optional[LogisticRegression] = None
        self.scaler: Optional[StandardScaler] = None
        self.last_trained: Optional[str] = None
        self.auc: Optional[float] = None
        self.games_used: int = 0
        self.snapshots: int = 0
        self.feature_columns: List[str] = list(FEATURE_COLUMNS)

    # ----------------------------- IO -------------------------------------
    @classmethod
    def load_or_new(cls, path: str = WP_MODEL_FILE) -> "WinProbabilityModel":
        """Load a persisted model from disk, falling back to an untrained one."""
        if path and os.path.exists(path):
            try:
                with open(path, "rb") as f:
                    obj = pickle.load(f)
                if isinstance(obj, cls):
                    return obj
            except Exception:
                pass
        return cls()

    def save(self, path: str = WP_MODEL_FILE) -> None:
        """Pickle to disk -- atomic write (tmp + flush + fsync + rename).

        flush+fsync closes the NTFS lazy-writer window where rename
        could publish the new file before its data blocks reached the
        platter. See docs/adr/0001-atomic-file-writes.md.
        """
        os.makedirs(os.path.dirname(path) or ".", exist_ok=True)
        tmp = path + ".tmp"
        with open(tmp, "wb") as f:
            pickle.dump(self, f, protocol=pickle.HIGHEST_PROTOCOL)
            f.flush()
            os.fsync(f.fileno())
        os.replace(tmp, path)

    # ----------------------------- Training -------------------------------
    def train(
        self,
        db: Dict[str, Any],
        player_name: Optional[str] = None,
        progress_cb: Optional[Any] = None,
    ) -> Optional[TrainingReport]:
        """Train logistic regression from every game in the DB with a result.

        Returns a TrainingReport. If the DB has fewer than
        ``COLD_START_GAMES_REQUIRED`` games with results we refuse to train and
        return ``None`` with the gap reflected on the (caller-provided) UI.

        Parameters
        ----------
        db : dict
            ``ReplayAnalyzer.db`` — ``{build_name: {games: [...], ...}}``.
        player_name : str, optional
            Used to resolve ``my_pid`` per game. If omitted we fall back to
            "the first player whose result matches the saved game's result".
        progress_cb : callable(int, int), optional
            Invoked as ``cb(games_done, games_total)`` so the UI can render a
            progress bar during the (slow) replay re-parse pass.
        """
        labeled_games = self._collect_labeled_games(db)
        if len(labeled_games) < COLD_START_GAMES_REQUIRED:
            return None

        # Parallel pass: re-parse every replay in a process pool so we use
        # all CPU cores. Each worker returns its snapshot rows + label;
        # failures (replay corrupt, player can't be resolved, no stats
        # events) are counted toward `skipped` without aborting the run.
        X_rows: List[List[float]] = []
        y_rows: List[int] = []
        used = 0
        skipped = 0
        total = len(labeled_games)

        # Reserve one core for the UI / OS so the app stays responsive.
        n_workers = max(1, multiprocessing.cpu_count() - 1)

        # Each work item is a tuple — small + pickleable. `game` is a dict
        # of strings/ints (the DB record), label is 0/1, player_name is a
        # str. file_path is the SC2Replay file path.
        args_iter = [
            (file_path, game, int(label), player_name)
            for (game, label, file_path) in labeled_games
        ]

        with concurrent.futures.ProcessPoolExecutor(max_workers=n_workers) as pool:
            futures = {pool.submit(_wp_train_worker, a): i for i, a in enumerate(args_iter)}
            done = 0
            for fut in concurrent.futures.as_completed(futures):
                done += 1
                try:
                    success, x_part, y_part, _err = fut.result()
                except Exception:
                    success, x_part, y_part = False, [], []
                if success:
                    X_rows.extend(x_part)
                    y_rows.extend(y_part)
                    used += 1
                else:
                    skipped += 1
                if progress_cb is not None:
                    try:
                        progress_cb(done, total)
                    except Exception:
                        pass

        if used < COLD_START_GAMES_REQUIRED or len(set(y_rows)) < 2:
            # Even after walking the DB we may end up below the minimum
            # (replays missing on disk, parse failures, all-wins or all-losses).
            return TrainingReport(
                trained=False,
                games_used=used,
                games_skipped=skipped,
                snapshots=len(y_rows),
                games_needed=max(0, COLD_START_GAMES_REQUIRED - used),
                message=(
                    f"Need {COLD_START_GAMES_REQUIRED - used} more usable game(s) "
                    f"to train (have {used} so far)."
                ),
            )

        X = np.asarray(X_rows, dtype=float)
        y = np.asarray(y_rows, dtype=int)

        # Holdout for AUC. stratify on label so the test set has both classes.
        X_train, X_test, y_train, y_test = train_test_split(
            X, y, test_size=0.2, random_state=42, stratify=y,
        )

        scaler = StandardScaler()
        X_train_s = scaler.fit_transform(X_train)
        X_test_s = scaler.transform(X_test)

        model = LogisticRegression(
            class_weight="balanced",
            max_iter=2000,
            solver="lbfgs",
            random_state=42,
        )
        model.fit(X_train_s, y_train)

        try:
            probs = model.predict_proba(X_test_s)[:, 1]
            auc = float(roc_auc_score(y_test, probs))
        except Exception:
            auc = None

        # Commit + persist.
        self.model = model
        self.scaler = scaler
        self.last_trained = datetime.now().isoformat(timespec="seconds")
        self.auc = auc
        self.games_used = used
        self.snapshots = int(len(y_rows))
        self.feature_columns = list(FEATURE_COLUMNS)
        self.save()

        return TrainingReport(
            trained=True,
            games_used=used,
            games_skipped=skipped,
            snapshots=int(len(y_rows)),
            auc=auc,
            last_trained=self.last_trained,
            message=f"Trained on {used} games / {len(y_rows)} snapshots.",
        )

    # ----------------------------- Predict --------------------------------
    def predict_curve(self, game_features: pd.DataFrame) -> List[Tuple[float, float]]:
        """Predict win probability per minute for an already-extracted feature df.

        ``game_features`` must be the DataFrame produced by
        ``SnapshotFeatureExtractor.extract`` — minute column + the canonical
        FEATURE_COLUMNS in any order.

        Returns ``[(minute, p_win), ...]`` sorted by minute. If the model is
        not trained the list is empty.
        """
        if self.model is None or self.scaler is None:
            return []
        if game_features is None or len(game_features) == 0:
            return []
        # Ensure all expected columns exist; missing → 0.
        df = game_features.copy()
        for c in FEATURE_COLUMNS:
            if c not in df.columns:
                df[c] = 0.0
        X = df[FEATURE_COLUMNS].astype(float).values
        Xs = self.scaler.transform(X)
        probs = self.model.predict_proba(Xs)[:, 1]
        minutes = df["minute"].astype(float).values
        return list(zip([float(m) for m in minutes],
                        [float(p) for p in probs]))

    # ----------------------------- Helpers --------------------------------
    @staticmethod
    def _collect_labeled_games(db: Dict[str, Any]) -> List[Tuple[Dict, int, str]]:
        """Return [(game_dict, label, file_path), ...] for trainable games."""
        out: List[Tuple[Dict, int, str]] = []
        for bd in (db or {}).values():
            if not isinstance(bd, dict):
                continue
            for g in bd.get("games", []) or []:
                res = g.get("result")
                if res not in ("Win", "Loss"):
                    continue
                fp = g.get("file_path")
                if not fp or not os.path.exists(fp):
                    continue
                out.append((g, 1 if res == "Win" else 0, fp))
        return out

    @staticmethod
    def _resolve_me(replay, game: Dict, player_name: Optional[str]):
        """Identify the user player on this replay using best-effort matching."""
        # 1) explicit player_name match
        if player_name:
            target = player_name.lower()
            for p in replay.players:
                if (getattr(p, "name", "") or "") == player_name:
                    return p
            for p in replay.players:
                pname = (getattr(p, "name", "") or "").lower()
                if target and (target in pname or pname in target):
                    return p
        # 2) result match: pick the player whose result matches the saved row.
        target_result = game.get("result")
        humans = [
            p for p in replay.players
            if getattr(p, "is_human", True)
            and not getattr(p, "is_observer", False)
            and not getattr(p, "is_referee", False)
        ]
        if target_result in ("Win", "Loss"):
            matches = [p for p in humans if getattr(p, "result", None) == target_result]
            if len(matches) == 1:
                return matches[0]
        # 3) single-human: take them.
        if len(humans) == 1:
            return humans[0]
        return None


# ---------------------------------------------------------------------------
# Convenience: cold-start status reporting
# ---------------------------------------------------------------------------
def games_with_results(db: Dict[str, Any]) -> int:
    """How many games in the DB have a Win/Loss + a reachable replay file."""
    n = 0
    for bd in (db or {}).values():
        if not isinstance(bd, dict):
            continue
        for g in bd.get("games", []) or []:
            if g.get("result") not in ("Win", "Loss"):
                continue
            fp = g.get("file_path")
            if not fp or not os.path.exists(fp):
                continue
            n += 1
    return n


def cold_start_status(db: Dict[str, Any]) -> Dict[str, Any]:
    """Return ``{ready, have, needed}`` for the UI's cold-start banner."""
    have = games_with_results(db)
    return {
        "ready": have >= COLD_START_GAMES_REQUIRED,
        "have": have,
        "needed": max(0, COLD_START_GAMES_REQUIRED - have),
        "minimum": COLD_START_GAMES_REQUIRED,
    }
