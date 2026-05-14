"""Shared helpers for the strategy-detection engine.

This module hosts the constants, tech-prereq table, race/matchup string
helpers, and the :class:`DetectionContext` wrapper used by the per-
matchup Protoss detection routines (``strategy_detector_pvz``,
``..._pvp``, ``..._pvt``).

It is intentionally side-effect free: every function and class works on
the event dicts emitted by ``core.event_extractor`` (the same shape used
by the live overlay backend and the offline reclassify CLI) and never
reaches back into the matchup-specific modules.
"""

from __future__ import annotations

from typing import Dict, List, Tuple

try:
    from .sc2_catalog import composition_summary
except ImportError:  # pragma: no cover - optional during transitional builds
    composition_summary = None  # type: ignore


# Map a 'vs <Race>' matchup string to the bare race name. Used by the
# race-aware classifier in UserBuildDetector.detect_my_build to look up
# the BUILD_SIGNATURES candidate set keyed by (my_race, vs_race).
_MATCHUP_TO_VS_RACE = {
    "vs Zerg": "Zerg",
    "vs Protoss": "Protoss",
    "vs Terran": "Terran",
}


def _matchup_to_vs_race(matchup: str) -> str:
    """Return the opponent's race name for a "vs X" matchup string.

    Falls back to "Unknown" so callers can still iterate the (empty)
    candidate set without raising.

    Example:
        >>> _matchup_to_vs_race("vs Terran")
        'Terran'
    """
    for key, race in _MATCHUP_TO_VS_RACE.items():
        if key in matchup:
            return race
    return "Unknown"


# =========================================================
# GAME-TOO-SHORT shared bucket
# =========================================================
# Replays that ended before 45 seconds have no meaningful build order
# to classify (one player conceded / disconnected / dropped). Instead
# of letting the strategy tree's catch-all bucket ("PvT - Macro
# Transition (Unclassified)" etc.) absorb them, we short-circuit at
# the top of both detectors and emit a single matchup-prefixed label
# per matchup so users can filter / drill on "no-build-order games"
# as one cohesive group.
#
# Threshold is 45 seconds. Below that, basically no production has
# happened — only the auto-spawned starting workers and maybe one
# Pylon / SupplyDepot / Overlord under construction (most racial
# first-supply builds break ground around 18-25 s). We don't
# attempt to differentiate further.
GAME_TOO_SHORT_THRESHOLD_SECONDS = 45

# Race -> one-letter prefix used to build matchup labels like "PvT".
# "Random" / unknown stays as "?" so the rule never crashes; the
# label that comes out ("?v?-Game Too Short") is still a valid
# bucket the UI can group on.
_RACE_LETTER = {"Protoss": "P", "Terran": "T", "Zerg": "Z"}


def _matchup_prefix(my_race: str, vs_race: str) -> str:
    """Build the matchup prefix from two race names ("Protoss" + "Terran"
    -> "PvT"). Unknown / "Random" races become "?" so the helper never
    raises.
    """
    return f"{_RACE_LETTER.get(my_race, '?')}v{_RACE_LETTER.get(vs_race, '?')}"


def too_short_label(my_race: str, vs_race: str) -> str:
    """Return the "<Matchup> - Game Too Short" catch-all label for the
    given matchup. The same string is emitted from both the user-side
    build classifier and the opponent-strategy classifier so the two
    fields agree when no build order had a chance to develop."""
    return f"{_matchup_prefix(my_race, vs_race)} - Game Too Short"


# Composition-tag -> human-readable phrase used for derived fallback names.
_COMPOSITION_PHRASES = {
    "ling": "Ling-heavy", "bane": "Ling/Bane", "roach": "Roach/Ravager",
    "hydra": "Hydralisk", "lurker": "Lurker", "muta": "Mutalisk",
    "swarm": "Swarm Host", "broodlord": "Brood Lord", "ultra": "Ultralisk",
    "corruptor": "Corruptor", "caster": "Caster (Infestor/Viper)",
    "gateway": "Gateway", "templar": "High Templar / Archon",
    "dt": "Dark Templar", "robo": "Robo (Immortal/Colossus)",
    "sky": "Sky / Stargate",
    "bio": "Bio", "mech": "Mech",
}


# =========================================================
# UNIT TECH PREREQUISITES (anti-hallucination guard)
# =========================================================
# Maps a unit name to a list of alternative requirement-sets. A unit
# event is treated as "real" by build classification only when at least
# one alternative is fully satisfied: every structure listed in that
# alternative must have been STARTED before the unit's appearance time.
# The structure does NOT need to still be standing -- a Stargate that
# was killed at 5:00 still satisfies the Phoenix prerequisite at 7:00,
# because the construction event remains in the event log permanently.
#
# Why we need this:
#   A Sentry's Hallucination ability spawns illusory Phoenix / Void Ray /
#   High Templar / Archon / Immortal / Colossus / Warp Prism units that
#   show up in the replay events identically to real units. Without a
#   prerequisite filter, a single Sentry hallucination would let us
#   misclassify a 2-base Charge build as a Phoenix Opener, an Archon
#   Drop, etc. The build is only that build if the relevant tech
#   structure was actually built at some point.
#
# Keep this table in sync with the mirror in
# SC2Replay-Analyzer/detectors/base.py.
UNIT_TECH_PREREQUISITES: Dict[str, List[List[str]]] = {
    # --- Protoss: Stargate path ---
    "Phoenix":       [["Stargate"]],
    "Oracle":        [["Stargate"]],
    "VoidRay":       [["Stargate"]],
    "Carrier":       [["Stargate", "FleetBeacon"]],
    "Tempest":       [["Stargate", "FleetBeacon"]],
    "Mothership":    [["Stargate", "FleetBeacon"]],
    # --- Protoss: Robotics path ---
    "Immortal":      [["RoboticsFacility"]],
    "Observer":      [["RoboticsFacility"]],
    "WarpPrism":     [["RoboticsFacility"]],
    "Colossus":      [["RoboticsFacility", "RoboticsBay"]],
    "Disruptor":     [["RoboticsFacility", "RoboticsBay"]],
    # --- Protoss: Templar / Dark path ---
    "HighTemplar":   [["TemplarArchive"]],
    "DarkTemplar":   [["DarkShrine"]],
    # Archon morphs from 2x HT, 2x DT, or 1 HT + 1 DT, so either tech
    # structure is sufficient on its own.
    "Archon":        [["TemplarArchive"], ["DarkShrine"]],
    # --- Zerg ---
    "Zergling":      [["SpawningPool"]],
    "Queen":         [["SpawningPool"]],
    "Baneling":      [["BanelingNest"]],
    "Roach":         [["RoachWarren"]],
    "Ravager":       [["RoachWarren"]],
    "Hydralisk":     [["HydraliskDen"]],
    "Lurker":        [["LurkerDen"]],
    "LurkerMP":      [["LurkerDen"]],
    "Mutalisk":      [["Spire"]],
    "Corruptor":     [["Spire"]],
    "BroodLord":     [["GreaterSpire"]],
    "Infestor":      [["InfestationPit"]],
    "SwarmHostMP":   [["InfestationPit"]],
    "Viper":         [["Hive"]],
    "Ultralisk":     [["UltraliskCavern"]],
    # --- Terran ---
    "Marine":        [["Barracks"]],
    "Reaper":        [["Barracks"]],
    "Marauder":      [["Barracks"]],
    "Ghost":         [["Barracks", "GhostAcademy"]],
    "Hellion":       [["Factory"]],
    "Hellbat":       [["Factory", "Armory"]],
    "Cyclone":       [["Factory"]],
    "WidowMine":     [["Factory"]],
    "SiegeTank":     [["Factory"]],
    "Thor":          [["Factory", "Armory"]],
    "Medivac":       [["Starport"]],
    "Liberator":     [["Starport"]],
    "Banshee":       [["Starport"]],
    "Raven":         [["Starport"]],
    "VikingFighter": [["Starport"]],
    "Battlecruiser": [["Starport", "FusionCore"]],
}


def _structures_present_by(
    names: List[str], buildings: List[Dict], by_time: float
) -> bool:
    """All `names` have at least one start event with time <= by_time."""
    earliest: Dict[str, float] = {}
    for b in buildings:
        n = b.get("name")
        t = b.get("time", float("inf"))
        if n in names:
            cur = earliest.get(n)
            if cur is None or t < cur:
                earliest[n] = t
    return all(earliest.get(n, float("inf")) <= by_time for n in names)


def unit_prereq_met(
    unit_name: str, by_time: float, buildings: List[Dict]
) -> bool:
    """True if the tech prerequisite for `unit_name` was started by `by_time`.

    A unit not registered in UNIT_TECH_PREREQUISITES is allowed
    unconditionally (no known prereq -> trust the event).
    """
    alternatives = UNIT_TECH_PREREQUISITES.get(unit_name)
    if not alternatives:
        return True
    return any(
        _structures_present_by(req_set, buildings, by_time)
        for req_set in alternatives
    )


def count_real_units(
    unit_name: str,
    time_limit: float,
    units: List[Dict],
    buildings: List[Dict],
) -> int:
    """Count `unit_name` events with time <= time_limit, excluding hallucinations.

    A unit counts only when at least one prerequisite alternative for
    that unit type is satisfied at the unit's own appearance time. This
    is the function the build-classifier calls instead of a raw count to
    keep Sentry hallucinations from triggering false positives.
    """
    alternatives = UNIT_TECH_PREREQUISITES.get(unit_name)
    if not alternatives:
        return sum(
            1 for u in units
            if u.get("name") == unit_name and u.get("time", 9999) <= time_limit
        )
    valid = 0
    for u in units:
        if u.get("name") != unit_name:
            continue
        t = u.get("time", 9999)
        if t > time_limit:
            continue
        if any(
            _structures_present_by(req_set, buildings, t)
            for req_set in alternatives
        ):
            valid += 1
    return valid


def _composition_fallback_name(race: str, enemy_events: List[Dict]) -> str:
    """Derive a meaningful name from the dominant unit composition.

    Used as the very last fallback so a game never ends up labelled
    "Unclassified" — the catalog's composition tags get aggregated and
    the top three become the strategy phrase.
    """
    if composition_summary is None:
        return f"{race} - Standard Play (Unclassified)"
    tags = composition_summary(enemy_events)
    if tags:
        phrases = [_COMPOSITION_PHRASES.get(t, t.title()) for t in tags]
        return f"{race} - {' / '.join(phrases)} Comp"
    return f"{race} - Standard Play (Unclassified)"


class DetectionContext:
    """Per-replay event accessor used by the Protoss per-matchup detectors.

    Wraps the lists of building/unit/upgrade events plus the player's
    main-base location so each ``detect_pvX`` function can call
    ``ctx.has_building(...)`` / ``ctx.count_units(...)`` / etc. without
    needing to close over a stack of nested helpers in
    :meth:`UserBuildDetector.detect_my_build`.

    The accessors are intentionally identical in behaviour to the
    closures the monolithic detector used to define inline — the split
    is pure structural cleanup. ``count_units`` calls
    :func:`count_real_units` so Sentry-hallucinated air units never
    inflate a Phoenix / Void Ray / Carrier count.
    """

    def __init__(
        self,
        buildings: List[Dict],
        units: List[Dict],
        upgrades: List[Dict],
        main_loc: Tuple[float, float],
        detector,
    ):
        self.buildings = buildings
        self.units = units
        self.upgrades = upgrades
        self.main_loc = main_loc
        self._detector = detector

    def has_building(self, name: str, time_limit: float = 9999) -> bool:
        return any(
            b["name"] == name and b["time"] <= time_limit
            for b in self.buildings
        )

    def has_proxy(
        self, name: str, time_limit: float = 9999, dist: float = 50,
    ) -> bool:
        return any(
            b["name"] == name
            and b["time"] <= time_limit
            and self._detector._is_proxy(b, self.main_loc, dist)
            for b in self.buildings
        )

    def count_units(self, name: str, time_limit: float = 9999) -> int:
        # Prereq-aware: a unit only counts toward classification when
        # its tech-structure prerequisite was started before the
        # unit appeared. Filters Sentry hallucinations (Phoenix /
        # VoidRay / HighTemplar / Archon / Immortal / Colossus /
        # WarpPrism) that would otherwise flag the wrong build.
        return count_real_units(name, time_limit, self.units, self.buildings)

    def has_upgrade_substr(
        self, sub_name: str, time_limit: float = 9999,
    ) -> bool:
        return any(
            sub_name in u["name"] and u["time"] <= time_limit
            for u in self.upgrades
        )

    def building_time(self, name: str) -> float:
        times = [b["time"] for b in self.buildings if b["name"] == name]
        return min(times) if times else 9999

    def upgrade_time(self, *sub_names: str) -> float:
        """Earliest research start where the upgrade name contains any
        of ``sub_names``. sc2reader emits raw upgrade_type_name values
        ("AdeptPiercingAttack", "BlinkTech", "Charge") so callers pass
        the raw substring (and optionally a display-name fallback).
        Returns 9999 when no matching upgrade was researched."""
        times = [
            u["time"] for u in self.upgrades
            if any(s in u["name"] for s in sub_names)
        ]
        return min(times) if times else 9999

    @property
    def gate_count_6min(self) -> int:
        return sum(
            1 for b in self.buildings
            if b["name"] == "Gateway" and b["time"] < 540
        )

    @property
    def gate_count_530(self) -> int:
        return sum(
            1 for b in self.buildings
            if b["name"] == "Gateway" and b["time"] < 480
        )
