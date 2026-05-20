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


# =========================================================
# BUILDING-START-TIME HELPERS
# =========================================================
# event_extractor.py emits TWO events for each Protoss / Terran building
# the player constructs: subtype="init" when construction starts (the
# UnitInitEvent fires when a worker drops the foundation / warp-in
# begins) and subtype="born" when construction completes (~build_time
# later). Plus subtype="morph" for in-place morphs (Gateway -> WarpGate,
# Lair, Hive, ...). Build classification cares about WHEN the player
# committed to a building -- the start time -- not when it finished, so
# every count / sorted-index / threshold should be computed off init
# events only.
#
# Two failure modes the helpers below prevent:
#
#   1. Over-counting. A naive `sum(1 for b in buildings if name == X
#      and time < T)` counts both init AND born events for the same
#      building, so 3 Gateways completed by 9:00 register as 6 events.
#      Thresholds like `gate_count_6min >= 6` would then fire on as
#      little as ~3 actual gates.
#
#   2. Finish-time leakage on sorted-index access. A naive
#      `sorted([b["time"] for b in buildings if name == "Nexus"])[2]`
#      can resolve to a 2nd Nexus's BORN time rather than the 3rd
#      Nexus's INIT time when the 3rd is late (born of the 2nd at ~370
#      slots between init of the 2nd at ~270 and init of the 3rd at
#      ~500). A rule comparing "5th gateway started < 3rd nexus
#      taken" then compares against the 2nd Nexus's finish, not the
#      3rd Nexus's start.
#
# Pre-placed main town hall (Nexus / CommandCenter / Hatchery): only
# emits a UnitBornEvent at t=0 in real replays (no UnitInitEvent for
# game-placed units). Test fixtures sometimes model it as a t=0 init
# event. `start_times_excluding_main` filters t > 0 to normalise both
# shapes to the same expansion-only list -- so index-1 is always the
# 3rd base (= 2nd expansion).
#
# `subtype` fallback: events created by older test fixtures or by code
# paths that don't carry a subtype default to "init" so they count as
# starts. Real-replay events always carry an explicit subtype.

MAIN_TOWN_HALLS = ("Nexus", "CommandCenter", "Hatchery")
_START_SUBTYPES = ("init", "morph")


def _is_start_event(b: Dict) -> bool:
    """True if `b` is a construction-START event.

    UnitInitEvent ("init") fires when a worker drops the foundation.
    UnitTypeChangeEvent ("morph") fires for in-place morphs (Gateway ->
    WarpGate, Lair, Hive, GreaterSpire, Orbital, Planetary) -- the morph
    event IS the start of the new building (there is no later "born"
    twin), so it counts as a start too. Events with no `subtype` field
    default to "init" so test fixtures that omit it continue to work.
    """
    return b.get("subtype", "init") in _START_SUBTYPES


def start_times(buildings: List[Dict], name: str) -> List[float]:
    """Return sorted construction-START times for buildings of `name`.

    Filters out subtype="born" (construction-completed) events so the
    count / sorted-index resolves to actual building starts rather than
    the same building's completion event firing ~build_time later.
    """
    return sorted(
        b["time"] for b in buildings
        if b["name"] == name and _is_start_event(b)
    )


def start_times_excluding_main(buildings: List[Dict], name: str) -> List[float]:
    """Sorted construction-START times for a town-hall name, excluding
    the pre-placed main at t=0.

    Use for "the Nth expansion" / "the 3rd Nexus is the 2nd expansion"
    style rules where the pre-placed main should not occupy index 0.
    """
    return [t for t in start_times(buildings, name) if t > 0]


def count_started_before(buildings: List[Dict], name: str, time_limit: float) -> int:
    """Count distinct buildings of `name` whose construction was
    STARTED before `time_limit`.
    """
    return sum(
        1 for b in buildings
        if b["name"] == name and _is_start_event(b) and b["time"] < time_limit
    )


def nth_base_start(buildings: List[Dict], name: str, n: int) -> float:
    """Return the START time of the player's n-th town hall of `name`,
    counting the pre-placed main as base #1.

    Examples (Nexus):
        n=1 -> main (returns 0 sentinel if any Nexus event exists)
        n=2 -> natural / 1st expansion (= start_times_excluding_main[0])
        n=3 -> 3rd Nexus      (= start_times_excluding_main[1])

    Returns 9999 if the player has not started an n-th base.
    """
    if n < 1:
        return 9999
    if n == 1:
        return 0 if any(b["name"] == name for b in buildings) else 9999
    expansions = start_times_excluding_main(buildings, name)
    idx = n - 2
    return expansions[idx] if 0 <= idx < len(expansions) else 9999


def base_count_at(buildings: List[Dict], name: str, time_limit: float = 9999) -> int:
    """Count town halls of `name` STARTED by `time_limit`, including the
    pre-placed main (which is treated as present at t=0 if any event for
    `name` exists in the buildings list).
    """
    expansions = sum(
        1 for b in buildings
        if b["name"] == name
        and _is_start_event(b)
        and 0 < b["time"] <= time_limit
    )
    has_main = any(b["name"] == name for b in buildings)
    return (1 if has_main else 0) + expansions


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
        """Earliest event time for buildings of `name`. For player-built
        structures this is the construction-start (UnitInitEvent) time
        because init always precedes born. For the pre-placed main in
        real replays the only event is "born" at t=0, which is still
        the correct "when did this exist" answer.
        """
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
        return count_started_before(self.buildings, "Gateway", 540)

    @property
    def gate_count_530(self) -> int:
        return count_started_before(self.buildings, "Gateway", 480)
