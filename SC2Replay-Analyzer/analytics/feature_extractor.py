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

    # TODO: populate workers_at_4min, supply_blocked_seconds, peak_army_value,
    # etc. when downstream consumers (macro_score / win_probability /
    # clustering) need them.
    return feats
