"""Shared per-replay feature extraction layer.

This module is the SINGLE source of truth for game-level features that all
downstream analytics consumers depend on, including:

  * Macro-score model           (analytics/macro_score.py — to be added)
  * Win-probability model       (analytics/win_probability.py — to be added)
  * Build clustering / similarity search   (analytics/clustering.py — to be added)
  * Future replay-based ML pipelines

When a new feature is needed (e.g. "first-pylon time", "supply-blocked
seconds", "workers at 5 minutes", "saturation rate"), add it to `GameFeatures`
here so every downstream consumer sees the same canonical extraction. Do not
recompute the same feature inside detectors, the visualizer, or new analytics
modules — extend this dataclass instead.

Status
------
This is currently a STUB. The dataclass schema is in place; the body of
`extract_features` only fills out identity/race/result fields. Populate the
remaining fields incrementally as consumers come online.
"""

from dataclasses import dataclass, field
from core.event_extractor import (
    _get_owner_pid,
    _get_unit_type_name,
    _clean_building_name,
    KNOWN_BUILDINGS,
    _BASE_TYPES
)
try:
    from sc2reader.events.tracker import (
        PlayerStatsEvent,
        UnitBornEvent,
        UnitInitEvent,
        UnitDoneEvent
    )
except ImportError:
    PlayerStatsEvent = None
    UnitBornEvent = None
    UnitInitEvent = None
    UnitDoneEvent = None

from typing import Dict, Optional


@dataclass
class GameFeatures:
    """Canonical per-replay feature vector.

    Extend this class — never shadow it in another module. Downstream
    consumers may rely on the existence and naming of these fields.
    """

    # --- Identity ---
    game_id: str = ""
    my_pid: Optional[int] = None
    opp_pid: Optional[int] = None

    # --- Game properties ---
    map_name: str = ""
    game_length_sec: int = 0
    my_race: str = ""
    opp_race: str = ""
    matchup: str = ""
    result: str = ""  # "Win" | "Loss" | "Unknown"

    # --- Macro / economy (placeholders, populate as consumers come online) ---
    workers_at_4min: int = 0
    workers_at_8min: int = 0
    bases_at_5min: int = 0
    bases_at_10min: int = 0
    avg_minerals_collection_rate: float = 0.0
    avg_gas_collection_rate: float = 0.0

    # --- Supply ---
    supply_blocked_seconds: int = 0
    avg_supply_used: float = 0.0

    # --- Build pace ---
    first_gas_time_sec: int = 0
    first_expansion_time_sec: int = 0

    # --- Combat ---
    peak_army_value: int = 0

    # --- Free-form bag for experimental features that aren't promoted yet. ---
    extra: Dict[str, float] = field(default_factory=dict)


def extract_features(replay, my_pid: int) -> GameFeatures:
    """Extract canonical `GameFeatures` from a loaded sc2reader replay.

    This is currently a placeholder. As features are needed by downstream
    consumers (macro-score, win-probability, clustering), implement them here
    so every consumer pulls from the same extraction pass.

    Parameters
    ----------
    replay : sc2reader.resources.Replay
        Already-loaded replay (use `core.replay_loader.load_replay_with_fallback`).
    my_pid : int
        Player ID for the user (1 or 2).

    Returns
    -------
    GameFeatures
        Populated record. Currently fills identity/race/result and leaves the
        numeric features at their default zero values.
    """
    feats = GameFeatures()

    me = next((p for p in replay.players if getattr(p, 'pid', None) == my_pid), None)
    opp = next(
        (p for p in replay.players
         if getattr(p, 'pid', None) != my_pid
         and not getattr(p, 'is_observer', False)
         and not getattr(p, 'is_referee', False)),
        None,
    )
    if me is None or opp is None:
        return feats

    feats.my_pid = my_pid
    feats.opp_pid = opp.pid
    feats.map_name = getattr(replay, 'map_name', '') or ''
    gl = getattr(replay, 'game_length', None)
    feats.game_length_sec = gl.seconds if gl else 0
    feats.my_race = me.play_race or ''
    feats.opp_race = opp.play_race or ''
    feats.matchup = f"vs {opp.play_race}" if opp.play_race else ''
    feats.result = me.result or 'Unknown'

    if not PlayerStatsEvent:
        return feats

    tracker_events = getattr(replay, 'tracker_events', [])

    stats_events = []
    bases_built = []
    first_gas_time = 0

    for event in tracker_events:
        try:
            if isinstance(event, PlayerStatsEvent):
                pid = getattr(event, "pid", None)
                if pid is None:
                    p = getattr(event, "player", None)
                    pid = getattr(p, "pid", None) if p else None
                if pid == my_pid:
                    stats_events.append(event)

            elif isinstance(event, (UnitBornEvent, UnitInitEvent, UnitDoneEvent)):
                pid = _get_owner_pid(event)
                if pid == my_pid:
                    raw = _get_unit_type_name(event)
                    if raw:
                        clean = _clean_building_name(raw)

                        if clean in _BASE_TYPES:
                            is_completion = (
                                isinstance(event, UnitDoneEvent)
                                or (isinstance(event, UnitBornEvent)
                                    and clean in _BASE_TYPES)
                            )
                            if is_completion:
                                bases_built.append(getattr(event, "second", 0))

                        elif clean in ["Assimilator", "Extractor", "Refinery"] and first_gas_time == 0:
                            first_gas_time = getattr(event, "second", 0)
        except Exception:
            continue

    if stats_events:
        workers_4min = 0
        workers_8min = 0
        minerals_rates = []
        gas_rates = []
        supply_used_list = []
        peak_army = 0
        blocked_sec = 0.0

        for i, s in enumerate(stats_events):
            t = getattr(s, "second", 0)
            food_workers = getattr(s, "food_workers", 0)
            if t <= 240:
                workers_4min = max(workers_4min, food_workers)
            if t <= 480:
                workers_8min = max(workers_8min, food_workers)

            min_rate = getattr(s, "minerals_collection_rate", 0)
            gas_rate = getattr(s, "vespene_collection_rate", 0)
            minerals_rates.append(min_rate)
            gas_rates.append(gas_rate)

            food_used = getattr(s, "food_used", 0)
            food_made = getattr(s, "food_made", 0)
            supply_used_list.append(food_used)

            army_val = (
                getattr(s, "minerals_used_active_forces",
                        getattr(s, "minerals_used_current_army", 0))
                + getattr(s, "vespene_used_active_forces",
                          getattr(s, "vespene_used_current_army", 0))
            )
            peak_army = max(peak_army, army_val)

            if food_used >= food_made - 1 and food_used < 200:
                gap = 10
                if i + 1 < len(stats_events):
                    next_t = getattr(stats_events[i+1], "second", 0)
                    gap = next_t - t
                blocked_sec += min(gap, 4)

        feats.workers_at_4min = int(workers_4min)
        feats.workers_at_8min = int(workers_8min)
        feats.avg_minerals_collection_rate = sum(minerals_rates) / len(minerals_rates) if minerals_rates else 0.0
        feats.avg_gas_collection_rate = sum(gas_rates) / len(gas_rates) if gas_rates else 0.0
        feats.avg_supply_used = sum(supply_used_list) / len(supply_used_list) if supply_used_list else 0.0
        feats.peak_army_value = int(peak_army)
        feats.supply_blocked_seconds = int(blocked_sec)

    feats.first_gas_time_sec = first_gas_time

    # Bases counting
    bases_built.sort()
    bases_5min = 1 # Initial base
    bases_10min = 1
    for b_time in bases_built:
        if b_time > 0 and b_time <= 300:
            bases_5min += 1
        if b_time > 0 and b_time <= 600:
            bases_10min += 1

    if len(bases_built) > 0 and bases_built[0] > 0:
        feats.first_expansion_time_sec = bases_built[0]

    feats.bases_at_5min = bases_5min
    feats.bases_at_10min = bases_10min

    return feats
