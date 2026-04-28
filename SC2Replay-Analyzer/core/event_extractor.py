"""Event extraction from sc2reader replays.

`extract_events(replay, my_pid)` is the canonical pass over a replay's tracker
events. It flattens unit/building/upgrade events into plain dictionaries that
the detectors and analytics layers consume. The constants in this module
(KNOWN_BUILDINGS, MORPH_BUILDINGS, SKIP_UNITS, SKIP_BUILDINGS) act as the
filter that prevents noise (workers, larva, locusts, etc.) from polluting
downstream feature extraction.
"""

import sys
from typing import Dict, List, Optional, Set, Tuple

try:
    from sc2reader.events.tracker import (
        UnitBornEvent,
        UnitInitEvent,
        UnitDoneEvent,
        UpgradeCompleteEvent,
        UnitTypeChangeEvent,
        PlayerStatsEvent,  # re-exported for callers (graph extraction)
    )
    # CommandEvent is the parent of TargetUnit/TargetPoint/BasicCommandEvent
    # — used by the macro extractor to filter ``replay.events`` to actual
    # ability casts before checking for chained CommandManagerStateEvents.
    from sc2reader.events.game import CommandEvent  # type: ignore
    # UnitDiedEvent is the canonical "building/unit was destroyed" tracker event.
    # Some sc2reader builds spell it differently or omit it entirely; fall back
    # gracefully so the macro extractor can still run.
    try:
        from sc2reader.events.tracker import UnitDiedEvent  # type: ignore
    except ImportError:  # pragma: no cover
        UnitDiedEvent = None  # type: ignore
except ImportError:  # pragma: no cover - sc2reader is required
    # Defer the tkinter messagebox to the import-time error path so headless
    # tooling (CI, migrations, tests) can still import this module.
    try:
        import tkinter as _tk
        from tkinter import messagebox as _mb
        _root = _tk.Tk()
        _root.withdraw()
        _mb.showerror(
            "Missing Library",
            "Could not import 'sc2reader'.\nPlease install it using: pip install sc2reader",
        )
    except Exception:
        print("Missing library 'sc2reader'. Install with: pip install sc2reader", file=sys.stderr)
    sys.exit(1)


KNOWN_BUILDINGS: Set[str] = {
    "Nexus", "Pylon", "Assimilator", "Gateway", "Forge", "CyberneticsCore",
    "PhotonCannon", "ShieldBattery", "TwilightCouncil", "Stargate",
    "RoboticsFacility", "RoboticsBay", "TemplarArchive", "DarkShrine",
    "FleetBeacon", "WarpGate", "CommandCenter", "CommandCenterFlying",
    "OrbitalCommand", "OrbitalCommandFlying", "PlanetaryFortress", "SupplyDepot",
    "SupplyDepotLowered", "Refinery", "Barracks", "BarracksFlying", "Factory",
    "FactoryFlying", "Starport", "StarportFlying", "EngineeringBay", "Armory",
    "GhostAcademy", "FusionCore", "TechLab", "Reactor", "BarracksTechLab",
    "BarracksReactor", "FactoryTechLab", "FactoryReactor", "StarportTechLab",
    "StarportReactor", "MissileTurret", "SensorTower", "Bunker", "Hatchery",
    "Lair", "Hive", "SpawningPool", "EvolutionChamber", "Extractor", "RoachWarren",
    "BanelingNest", "SpineCrawler", "SporeCrawler", "HydraliskDen", "LurkerDen",
    "InfestationPit", "Spire", "GreaterSpire", "NydusNetwork", "NydusCanal",
    "UltraliskCavern", "CreepTumor", "CreepTumorBurrowed", "CreepTumorQueen",
}

MORPH_BUILDINGS: Set[str] = {
    "Lair", "Hive", "GreaterSpire", "OrbitalCommand", "PlanetaryFortress",
    "WarpGate", "LurkerDen",
}

SKIP_UNITS: Set[str] = {
    "MULE", "Larva", "LocustMP", "Probe", "SCV", "Drone", "Egg", "BroodlingEscort",
    "Broodling", "Changeling", "ChangelingMarine", "ChangelingMarineShield",
    "ChangelingZergling", "ChangelingZealot", "InfestedTerran", "AutoTurret",
    "PointDefenseDrone", "Interceptor", "AdeptPhaseShift", "Overlord",
    "OverseerCocoon", "BanelingCocoon", "RavagerCocoon", "LurkerCocoon",
    "TransportOverlordCocoon",
}

SKIP_BUILDINGS: Set[str] = {
    "SupplyDepot", "SupplyDepotLowered", "CreepTumor",
    "CreepTumorBurrowed", "CreepTumorQueen", "ShieldBattery",
}


def _clean_building_name(raw_name: str) -> str:
    for prefix in ("Protoss", "Terran", "Zerg"):
        raw_name = raw_name.replace(prefix, "")
    for suffix in ("Lower", "Upper"):
        raw_name = raw_name.replace(suffix, "")
    return raw_name.strip()


def _get_owner_pid(event) -> Optional[int]:
    for attr in ('control_pid', 'pid'):
        pid = getattr(event, attr, None)
        if pid is not None and pid > 0:
            return pid
    unit = getattr(event, 'unit', None)
    if unit is not None:
        owner = getattr(unit, 'owner', None)
        if owner is not None and getattr(owner, 'pid', None) and owner.pid > 0:
            return owner.pid
    player = getattr(event, 'player', None)
    if player is not None and getattr(player, 'pid', None) and player.pid > 0:
        return player.pid
    return None


def _get_unit_type_name(event) -> Optional[str]:
    name = getattr(event, 'unit_type_name', None)
    if name:
        return name
    unit = getattr(event, 'unit', None)
    if unit is not None:
        return getattr(unit, 'name', None)
    return None


def extract_events(replay, my_pid: int) -> Tuple[List[Dict], List[Dict], Dict]:
    """Walk a replay's tracker events and split them by player.

    Returns `(my_events, opp_events, stats)`. Each event is a dict with `type`
    in {"building", "unit", "upgrade"} plus a `time` (game seconds) and
    optional `x`/`y` for spatial events. Iteration is wrapped in try/except so
    a corrupt tracker stream still yields whatever it managed to read.
    """
    my_events: List[Dict] = []
    opp_events: List[Dict] = []
    stats = {'total': 0, 'pid_failed': 0, 'processed': 0, 'errors': 0}
    event_source = getattr(replay, 'tracker_events', None) or replay.events

    try:
        for event in event_source:
            stats['total'] += 1
            if isinstance(event, UnitInitEvent):
                pid = _get_owner_pid(event)
                raw = _get_unit_type_name(event)
                if pid is None or raw is None:
                    stats['pid_failed'] += 1
                    continue
                clean = _clean_building_name(raw)
                x = getattr(event, 'x', 0)
                y = getattr(event, 'y', 0)

                if clean in SKIP_BUILDINGS:
                    continue
                if clean in KNOWN_BUILDINGS:
                    evt = {'type': 'building', 'subtype': 'init', 'name': clean, 'time': event.second, 'x': x, 'y': y}
                    (my_events if pid == my_pid else opp_events).append(evt)
                    stats['processed'] += 1

            elif isinstance(event, UnitBornEvent):
                pid = _get_owner_pid(event)
                raw = _get_unit_type_name(event)
                if pid is None or raw is None:
                    stats['pid_failed'] += 1
                    continue
                clean = _clean_building_name(raw)
                x = getattr(event, 'x', 0)
                y = getattr(event, 'y', 0)

                is_building = clean in KNOWN_BUILDINGS
                if is_building:
                    if clean in SKIP_BUILDINGS:
                        continue
                    evt = {'type': 'building', 'subtype': 'born', 'name': clean, 'time': event.second, 'x': x, 'y': y}
                else:
                    if clean in SKIP_UNITS:
                        continue
                    evt = {'type': 'unit', 'name': clean, 'time': event.second, 'x': x, 'y': y}
                (my_events if pid == my_pid else opp_events).append(evt)
                stats['processed'] += 1

            elif isinstance(event, UnitTypeChangeEvent):
                pid = _get_owner_pid(event)
                raw = _get_unit_type_name(event)
                if pid is None or raw is None:
                    continue
                clean = _clean_building_name(raw)
                x = getattr(event.unit, 'x', 0) if getattr(event, 'unit', None) else 0
                y = getattr(event.unit, 'y', 0) if getattr(event, 'unit', None) else 0

                if clean in KNOWN_BUILDINGS and clean in MORPH_BUILDINGS:
                    if clean in SKIP_BUILDINGS:
                        continue
                    evt = {'type': 'building', 'subtype': 'morph', 'name': clean, 'time': event.second, 'x': x, 'y': y}
                    (my_events if pid == my_pid else opp_events).append(evt)
                    stats['processed'] += 1

            elif isinstance(event, UnitDoneEvent):
                pid = _get_owner_pid(event)
                raw = _get_unit_type_name(event)
                if pid is None or raw is None:
                    continue
                clean = _clean_building_name(raw)
                x = getattr(event.unit, 'x', 0) if getattr(event, 'unit', None) else 0
                y = getattr(event.unit, 'y', 0) if getattr(event, 'unit', None) else 0

                if clean in KNOWN_BUILDINGS:
                    pass
                elif clean not in SKIP_UNITS:
                    evt = {'type': 'unit', 'name': clean, 'time': event.second, 'x': x, 'y': y}
                    (my_events if pid == my_pid else opp_events).append(evt)
                    stats['processed'] += 1

            elif isinstance(event, UpgradeCompleteEvent):
                pid = _get_owner_pid(event)
                name = getattr(event, 'upgrade_type_name', None)
                if pid is None or name is None:
                    stats['pid_failed'] += 1
                    continue
                evt = {'type': 'upgrade', 'name': name, 'time': event.second}
                (my_events if pid == my_pid else opp_events).append(evt)
                stats['processed'] += 1
    except Exception:
        stats['errors'] += 1
        # Graceful exit from broken iterator
        pass

    return my_events, opp_events, stats


# ---------------------------------------------------------------------------
# Macro-event extraction
# ---------------------------------------------------------------------------
# These sets describe production buildings and town-halls for the macro
# engine. Kept here rather than in `analytics.macro_score` so the extractor
# only walks the tracker stream once even if multiple analytics modules
# care about the same shapes.
_PRODUCTION_BUILDING_TYPES: Set[str] = {
    "Barracks", "Factory", "Starport",
    "Gateway", "WarpGate", "RoboticsFacility", "Stargate",
    "Hatchery", "Lair", "Hive",
}

_BASE_TYPES: Set[str] = {
    # Zerg town-halls (morph chain)
    "Hatchery", "Lair", "Hive",
    # Protoss town-halls
    "Nexus",
    # Terran town-halls (morph chain)
    "CommandCenter", "OrbitalCommand", "PlanetaryFortress",
}

_INTERESTING_ABILITIES: Set[str] = {
    # Zerg: queen inject. sc2reader has used both names across versions.
    "InjectLarva", "SpawnLarva", "QueenSpawnLarva",
    # Protoss: chrono boost. New (LotV) and old names.
    "ChronoBoostEnergyCost", "ChronoBoost",
    # Terran: MULE.
    "CalldownMULE",
}

# Substring buckets for the macro ability counter. Modern sc2reader
# replays sometimes report ability names like "Effect_ChronoBoost",
# "QueenMP_SpawnLarva" or other engine-internal variants depending on
# replay version. Substring matching is much more forgiving than the
# exact-name set above and keeps the macro engine working across the
# Wings/HotS/LotV/balance-test patch zoo. The exact set is still tried
# first as a fast path.
_INJECT_TOKENS: Tuple[str, ...] = ("inject", "spawnlarva")
_CHRONO_TOKENS: Tuple[str, ...] = ("chronoboost", "chrono",)
_MULE_TOKENS: Tuple[str, ...] = ("calldownmule", "mule",)


# ---------------------------------------------------------------------------
# Build-aware ability-link resolution.
# ---------------------------------------------------------------------------
# Starcraft II ships a fresh ability table with every game-data patch, and
# the link-id of an ability can shift when Blizzard inserts/removes entries.
# Public sc2reader 1.8.0 only ships ability data up to LotV 80949 (and the
# upstream branch only to 89720), so any replay produced by patch 5.0.14+
# has chrono boost firing at a link that the bundled datapack labels as
# something else entirely — which is why ``ability_name`` returns
# "NexusMassRecall" / unknown / a Terran ability instead of
# "ChronoBoostEnergyCost" for the user's recent replays.
#
# We work around that by classifying the macro abilities directly on the
# numeric ``ability_link`` (which is a stable integer that Blizzard does
# expose), with a per-build mapping so we pick the right link for the
# replay's protocol generation.
#
# Cutoff `93272` was empirically derived from the user's replay library:
# every replay with build 92440 or earlier has chrono at link 722, every
# replay with build 93272 or later has chrono at link 723. (That's the
# 5.0.13 → 5.0.14 patch boundary, where Blizzard inserted a new ability
# in the table and shifted everything from 722 upward by one.) Inject
# (link 113) and MULE (link 92) appear unchanged across the same boundary.
_LINK_SHIFT_BUILD: int = 93272

_MACRO_LINKS_OLD = {
    722: "chrono",      # ChronoBoostEnergyCost (LotV pre-5.0.14)
    113: "inject",      # SpawnLarva
    92:  "mule",        # CalldownMULE
}
_MACRO_LINKS_NEW = {
    723: "chrono",      # ChronoBoostEnergyCost (5.0.14+, +1 shift)
    113: "inject",      # SpawnLarva (unchanged)
    92:  "mule",        # CalldownMULE (unchanged)
}


def _macro_link_table(build: int) -> Dict[int, str]:
    """Return the ``link_id -> bucket`` table appropriate for this build."""
    return _MACRO_LINKS_NEW if build >= _LINK_SHIFT_BUILD else _MACRO_LINKS_OLD


def _ability_link(event) -> Optional[int]:
    """Pull the integer ability_link off a CommandEvent, or None."""
    link = getattr(event, "ability_link", None)
    if link is None:
        ability = getattr(event, "ability", None)
        if ability is not None:
            link = getattr(ability, "id", None)
    return link if isinstance(link, int) and link > 0 else None


def _normalize_ability_name(event) -> Optional[str]:
    """Best-effort extraction of the canonical ability name.

    Tries (1) ``event.ability_name`` (sc2reader's parsed display name),
    (2) ``event.ability.name`` (the wrapped Ability object), and
    (3) ``event.ability_link``-keyed fallback by lowercasing whatever
    string-y attr we can find. Returns the name or None.
    """
    name = getattr(event, "ability_name", None)
    if name:
        return name
    ability = getattr(event, "ability", None)
    if ability is not None:
        n = getattr(ability, "name", None)
        if n:
            return n
        # Some sc2reader versions wrap as a dict-like with a build_name.
        n = getattr(ability, "build_name", None)
        if n:
            return n
    # Last resort: cast a couple of common alt attributes to string.
    for attr in ("ability_command_name", "ability_id"):
        v = getattr(event, attr, None)
        if v:
            return str(v)
    return None


def _classify_macro_ability(name: str) -> Optional[str]:
    """Bucket an ability name into 'inject' / 'chrono' / 'mule' or None.

    Exact-match against ``_INTERESTING_ABILITIES`` first (fast path),
    then a lowercased substring search against the token lists. This is
    the entry-point that lets us survive ability-name churn across SC2
    patches.
    """
    if not name:
        return None
    if name in _INTERESTING_ABILITIES:
        if "Inject" in name or "SpawnLarva" in name:
            return "inject"
        if "Chrono" in name:
            return "chrono"
        if "MULE" in name:
            return "mule"
    low = name.lower()
    if any(tok in low for tok in _INJECT_TOKENS):
        return "inject"
    if any(tok in low for tok in _CHRONO_TOKENS):
        return "chrono"
    if any(tok in low for tok in _MULE_TOKENS):
        return "mule"
    return None


def _resolve_unit_id(event) -> Optional[int]:
    """Return the most stable unit-id we can pull off a tracker event."""
    unit = getattr(event, "unit", None)
    if unit is not None:
        uid = getattr(unit, "id", None)
        if uid is not None:
            return uid
    return getattr(event, "unit_id", None)


def _resolve_command_pid(event) -> Optional[int]:
    """Return the player slot id (1-indexed) that *issued* a game/command event.

    sc2reader's game-event ``event.pid`` is the *user_id* (0-indexed user
    position), which does NOT match ``replay.players[i].pid`` (1-indexed
    player slot). Comparing the two directly silently mis-attributes every
    cast — and on any replay where the user was player slot 2, every cast
    gets dropped (e.pid is 0 or 1, never 2), producing the long-standing
    "0 chronos / 0 injects / 0 MULEs" symptom.

    Resolution order, most → least authoritative:

      1. ``event.player.pid``   — sc2reader-resolved Player object slot.
      2. ``event.control_player_id`` — the player owning the unit being
         commanded; matches ``player.pid`` for normal play. Skip the
         ``0`` value, which means "no/unknown owner" (e.g. neutral or
         pre-game system events).
      3. ``event.upkeep_player_id`` — same idea, supply payer.

    Tracker events (``PlayerStatsEvent``, ``UnitBornEvent`` …) already
    expose the canonical player slot via ``event.pid`` and are handled by
    the existing ``_get_owner_pid`` helper — this function is specifically
    for command/ability events on ``replay.events``.
    """
    player = getattr(event, "player", None)
    pl_pid = getattr(player, "pid", None) if player is not None else None
    if pl_pid:
        return pl_pid
    for attr in ("control_player_id", "upkeep_player_id"):
        v = getattr(event, attr, None)
        if v:
            return v
    return None


def _skip_for_unit_timeline(clean: str) -> bool:
    """Return True for unit names that should NOT appear in the chart's
    army-composition roster.

    Beacon* names (BeaconArmy, BeaconDefend, BeaconAttack, ...) are
    click-action UI markers the SC2 client emits as UnitBornEvents at
    t=0 — they're not real army units. WidowMineBurrowed is the burrowed
    state of WidowMine; including it would double-count widow mines as
    a separate roster entry whenever the player burrows them.

    Example:
        >>> _skip_for_unit_timeline("BeaconArmy")
        True
        >>> _skip_for_unit_timeline("WidowMineBurrowed")
        True
        >>> _skip_for_unit_timeline("Stalker")
        False
    """
    if not clean:
        return True
    if clean.startswith("Beacon"):
        return True
    if clean == "WidowMineBurrowed":
        return True
    return False


def _build_unit_timeline(
    unit_lifetimes: Dict[int, Dict],
    sample_times: List[int],
    my_pid: int,
    opp_pid: Optional[int],
    game_end_sec: int,
) -> List[Dict]:
    """Sample alive-unit counts per pid at each ``sample_times`` entry.

    A unit is considered alive at time ``t`` when ``born <= t`` and either
    it has no recorded death or ``t < died``. Counts are aggregated per
    canonical unit name (UnitTypeChangeEvent rewrites are already applied
    to ``unit_lifetimes`` upstream so morphs roll into the new name).

    Returns a list of dicts, one per sample time:
        { "time": int, "my": {Name: int, ...}, "opp": {Name: int, ...} }

    Empty list when ``sample_times`` is empty. ``opp_pid`` may be ``None``
    in which case the ``opp`` map will always be empty.

    Example:
        >>> lifetimes = {1: {"pid": 1, "name": "Stalker", "born": 60, "died": 120}}
        >>> _build_unit_timeline(lifetimes, [60, 90, 120], my_pid=1,
        ...                       opp_pid=None, game_end_sec=300)
        [{'time': 60, 'my': {'Stalker': 1}, 'opp': {}},
         {'time': 90, 'my': {'Stalker': 1}, 'opp': {}},
         {'time': 120, 'my': {}, 'opp': {}}]
    """
    if not sample_times:
        return []
    timeline: List[Dict] = []
    for t in sample_times:
        my_counts: Dict[str, int] = {}
        opp_counts: Dict[str, int] = {}
        for info in unit_lifetimes.values():
            born = int(info.get("born") or 0)
            if born > t:
                continue
            died = info.get("died")
            if died is not None and int(died) <= t:
                continue
            pid = info.get("pid")
            target = (
                my_counts if pid == my_pid
                else opp_counts if (opp_pid is not None and pid == opp_pid)
                else None
            )
            if target is None:
                continue
            name = info.get("name") or "?"
            target[name] = target.get(name, 0) + 1
        timeline.append({"time": int(t), "my": my_counts, "opp": opp_counts})
    return timeline


def extract_macro_events(replay, my_pid: int, opp_pid: Optional[int] = None) -> Dict:
    """Walk the replay once and pull every event the macro engine needs.

    Returns a dict with the following keys:

      ``ability_events``       List[{ability_name, time}]
                               Filtered to InjectLarva / ChronoBoostEnergyCost
                               / CalldownMULE for ``my_pid``.

      ``stats_events``         List[{time, food_used, food_made,
                               minerals_current, vespene_current, food_workers,
                               minerals_collection_rate,
                               vespene_collection_rate}] for ``my_pid``.

      ``production_buildings`` List[{name, unit_id, born_time, died_time}]
                               Production buildings (Barracks, Gateway, etc.)
                               and town-halls. ``died_time`` defaults to
                               game_length when no death event was seen.

      ``bases``                List of the same shape, filtered to town-halls
                               (Hatchery/Lair/Hive, Nexus, CC/OC/PF). Used by
                               inject / chrono / MULE expectations.

      ``unit_births``          List[{name, time, unit_id}] of every non-
                               building unit owned by ``my_pid``. Used for
                               idle-production heuristics.

      ``game_length_sec``      Game length in seconds (for capping died_time).

    The function is wrapped in a broad try/except so corrupt tracker streams
    still return a partial bundle. Building type changes (Hatchery -> Lair ->
    Hive, CC -> OC -> PF) are followed by ``UnitTypeChangeEvent`` so the same
    `unit_id` records pick up the new ``name``.
    """
    out: Dict[str, list] = {
        "ability_events": [],
        "stats_events": [],
        # opp_stats_events mirrors stats_events but for opp_pid. Empty list
        # when no opp_pid was provided. Used by the SPA's Active Army &
        # Workers chart to render both players simultaneously.
        "opp_stats_events": [],
        "production_buildings": [],
        "bases": [],
        "unit_births": [],
        # unit_timeline is populated after the tracker walk below. Each
        # entry: { time, my: {UnitName: count, ...}, opp: {...} }. Only
        # non-building, non-SKIP_UNITS army units are counted.
        "unit_timeline": [],
    }
    # Track non-building unit lifetimes for my_pid AND opp_pid by unit_id.
    # Distinct from the buildings ``lifetimes`` dict above so nothing
    # cross-contaminates the macro engine's bases/production_buildings.
    unit_lifetimes: Dict[int, Dict] = {}
    gl = getattr(replay, "game_length", None)
    game_end = gl.seconds if gl is not None and hasattr(gl, "seconds") else 0
    out["game_length_sec"] = game_end

    # Track building lifetimes by unit_id so morphs are followed naturally.
    lifetimes: Dict[int, Dict] = {}

    tracker = getattr(replay, "tracker_events", None) or []
    try:
        for event in tracker:
            try:
                if isinstance(event, PlayerStatsEvent):
                    pid = getattr(event, "pid", None)
                    if pid is None:
                        player = getattr(event, "player", None)
                        pid = getattr(player, "pid", None) if player else None
                    if pid not in (my_pid, opp_pid):
                        continue
                    sample = {
                        "time": getattr(event, "second", 0),
                        "food_used": getattr(event, "food_used", 0),
                        "food_made": getattr(event, "food_made", 0),
                        "minerals_current": getattr(event, "minerals_current", 0),
                        "vespene_current": getattr(event, "vespene_current", 0),
                        # sc2reader names this workers_active_count (food_workers
                        # does not exist on PlayerStatsEvent in 1.8.x). Keep the
                        # JSON key "food_workers" so the whole pipeline stays
                        # stable.
                        "food_workers": getattr(event, "workers_active_count", 0),
                        "minerals_collection_rate":
                            getattr(event, "minerals_collection_rate", 0),
                        "vespene_collection_rate":
                            getattr(event, "vespene_collection_rate", 0),
                        # Pre-summed by sc2reader from
                        # minerals_used_in_progress_{army,economy,technology}.
                        # Drives the "Used in progress" line on the Resources
                        # over time chart in the analyzer SPA.
                        "minerals_used_in_progress":
                            getattr(event, "minerals_used_in_progress", 0),
                        "vespene_used_in_progress":
                            getattr(event, "vespene_used_in_progress", 0),
                    }
                    if pid == my_pid:
                        out["stats_events"].append(sample)
                    elif pid == opp_pid:
                        out["opp_stats_events"].append(sample)
                    continue

                if isinstance(event, (UnitBornEvent, UnitInitEvent, UnitDoneEvent)):
                    pid = _get_owner_pid(event)
                    raw = _get_unit_type_name(event)
                    if not raw:
                        continue
                    clean = _clean_building_name(raw)
                    t = int(getattr(event, "second", 0))
                    uid = _resolve_unit_id(event)

                    # Track non-building, non-skip units for BOTH pids so
                    # the unit_timeline can render both armies. Only
                    # UnitBornEvent counts for non-building units (Init/Done
                    # don't repeat for unit production). Beacons and the
                    # burrowed widow-mine variant are filtered out — see
                    # _skip_for_unit_timeline() for the rationale.
                    if (pid in (my_pid, opp_pid)
                            and pid is not None
                            and clean not in KNOWN_BUILDINGS
                            and clean not in SKIP_UNITS
                            and not _skip_for_unit_timeline(clean)
                            and isinstance(event, UnitBornEvent)
                            and uid is not None):
                        unit_lifetimes[uid] = {
                            "pid": pid, "name": clean, "born": t, "died": None,
                        }

                    if pid != my_pid:
                        continue
                    if clean in KNOWN_BUILDINGS:
                        # For Zerg, UnitBornEvent IS completion (drone morph).
                        # For Protoss/Terran, UnitDoneEvent is completion.
                        # We accept whichever fires first as the operational
                        # timestamp.
                        is_completion = (
                            isinstance(event, UnitDoneEvent)
                            or (isinstance(event, UnitBornEvent)
                                and clean in _BASE_TYPES)
                        )
                        if is_completion and uid is not None:
                            entry = lifetimes.get(uid)
                            if entry is None:
                                lifetimes[uid] = {
                                    "name": clean, "born": t, "died": None,
                                }
                            else:
                                entry["born"] = min(entry.get("born", t), t)
                                entry["name"] = clean
                    else:
                        if (clean not in SKIP_UNITS
                                and isinstance(event, UnitBornEvent)):
                            out["unit_births"].append({
                                "name": clean, "time": t, "unit_id": uid,
                            })
                    continue

                if isinstance(event, UnitTypeChangeEvent):
                    pid = _get_owner_pid(event)
                    raw = _get_unit_type_name(event)
                    if not raw:
                        continue
                    clean = _clean_building_name(raw)
                    uid = _resolve_unit_id(event)
                    # Buildings: only follow morphs for my_pid (existing
                    # behavior — the macro engine only cares about my
                    # bases / production buildings).
                    if (pid == my_pid and uid in lifetimes
                            and clean in KNOWN_BUILDINGS):
                        lifetimes[uid]["name"] = clean
                    # Units: morphs (Hellion->Hellbat, Roach->Ravager, etc.)
                    # need to follow for either side so the timeline shows
                    # the correct unit type post-morph. Beacons and
                    # WidowMineBurrowed are filtered the same way as in the
                    # birth branch — see _skip_for_unit_timeline().
                    if (uid in unit_lifetimes
                            and clean not in KNOWN_BUILDINGS
                            and clean not in SKIP_UNITS
                            and not _skip_for_unit_timeline(clean)):
                        unit_lifetimes[uid]["name"] = clean
                    continue

                if UnitDiedEvent is not None and isinstance(event, UnitDiedEvent):
                    uid = _resolve_unit_id(event)
                    if uid in lifetimes:
                        lifetimes[uid]["died"] = int(getattr(event, "second", 0))
                    if uid in unit_lifetimes:
                        unit_lifetimes[uid]["died"] = int(
                            getattr(event, "second", 0))
                    continue
            except Exception:
                # Swallow per-event errors and keep walking.
                continue
    except Exception:
        # Iterator gave up - return whatever we collected.
        pass

    # Game-event pass for ability uses (inject / chrono / MULE).
    #
    # Two layers of robustness, in order:
    #
    #   1. Classify by numeric ability_link via a build-aware lookup table.
    #      ``_macro_link_table(build)`` returns {722→chrono, 113→inject,
    #      92→mule} for builds ≤ 92440, or {723→chrono, 113→inject,
    #      92→mule} for builds ≥ 93272 (the 5.0.14+ shift). This is the
    #      authoritative path because the link integer is stable in the
    #      replay format even when sc2reader's bundled datapack (last
    #      updated for build 89720) labels it with a stale name.
    #
    #   2. Fall back to ability-name classification for ancient builds and
    #      for replays where the numeric link is missing — covers older
    #      WoL/HotS replays where the Inject/Chrono/MULE name surfaces
    #      directly.
    #
    # We also fold in ``CommandManagerStateEvent`` re-executions: when a
    # player queues N chronos / injects / MULEs in succession the FIRST is
    # a fresh CommandEvent and the next N-1 surface as
    # CommandManagerStateEvent(state=1) referencing the same sequence.
    # Counting only the head event under-reports macro casts by 70-80% in
    # modern (5.0.14+) replays — that's the main reason "0/N chronos"
    # appeared even after the link issue was understood.
    build = int(getattr(replay, "build", 0) or 0)
    link_table = _macro_link_table(build)
    game_events = getattr(replay, "events", None) or []
    out.setdefault("ability_counts",
                   {"inject": 0, "chrono": 0, "mule": 0, "other": 0})
    # last_bucket_per_pid: pid -> bucket name of the most recent macro
    # CommandEvent that player issued. Reset to None whenever they issue a
    # non-macro command so a chained state event doesn't get misattributed.
    last_bucket_per_pid: Dict[int, Optional[str]] = {}
    try:
        for event in game_events:
            try:
                pid = _resolve_command_pid(event)
                if pid != my_pid:
                    continue
                cls_name = type(event).__name__
                # Re-execution of the previous CommandEvent. State 1 is
                # "executed" (the only state we count); state 2+ are
                # cancellations and we leave them out.
                if cls_name == "CommandManagerStateEvent":
                    if (getattr(event, "state", None) == 1
                            and last_bucket_per_pid.get(pid)):
                        bucket = last_bucket_per_pid[pid]
                        out["ability_events"].append({
                            "ability_name": bucket,
                            "category": bucket,
                            "time": int(getattr(event, "second", 0)),
                            "via": "state_event",
                        })
                        out["ability_counts"][bucket] += 1
                    continue
                # Anything that isn't a CommandEvent shouldn't reset the
                # chain (selection / camera / control-group events are
                # noise between casts).
                if not isinstance(event, CommandEvent):
                    continue
                # Classify by ability_link first (build-aware, robust to
                # stale datapack), then by name as a fallback.
                link = _ability_link(event)
                bucket = link_table.get(link) if link else None
                if bucket is None:
                    name = _normalize_ability_name(event)
                    bucket = _classify_macro_ability(name) if name else None
                if bucket is None:
                    # Non-macro CommandEvent: forget the previous macro
                    # chain so subsequent state events don't attach to it.
                    last_bucket_per_pid[pid] = None
                    continue
                last_bucket_per_pid[pid] = bucket
                out["ability_events"].append({
                    "ability_name": _normalize_ability_name(event) or bucket,
                    "category": bucket,
                    "time": int(getattr(event, "second", 0)),
                })
                out["ability_counts"][bucket] += 1
            except Exception:
                continue
    except Exception:
        pass

    # Materialize lifetime records.
    for uid, info in lifetimes.items():
        born = int(info.get("born") or 0)
        died = info.get("died")
        died_time = int(died) if died is not None else int(game_end or born)
        record = {
            "unit_id": uid,
            "name": info.get("name", "?"),
            "born_time": born,
            "died_time": died_time,
        }
        out["production_buildings"].append(record)
        if record["name"] in _BASE_TYPES:
            out["bases"].append(record)

    # Sample the unit timeline at each my-stats sample time so the chart
    # x-axis aligns 1:1 with the resource curves. Each entry counts alive
    # non-building, non-SKIP_UNITS units per pid by canonical name.
    sample_times = [int(s.get("time", 0)) for s in out["stats_events"]]
    out["unit_timeline"] = _build_unit_timeline(
        unit_lifetimes, sample_times, my_pid, opp_pid, int(game_end or 0))

    return out


# ---------------------------------------------------------------------------
# Unit movement tracks (for the playback viewer)
# ---------------------------------------------------------------------------
# Combine three sources to get plausible per-unit movement:
#   1. UnitBornEvent / UnitInitEvent  -> initial position waypoint
#   2. UnitPositionsEvent             -> true-position waypoints (sparse,
#                                        only damaged units, every 15s)
#   3. TargetPointCommandEvent + the issuing player's current selection
#      (tracked from SelectionEvent)  -> destination-point waypoints
#   4. UnitDiedEvent                  -> died_t (unit disappears)
# The browser linearly interpolates between consecutive waypoints to render
# each unit at the current scrub time.

try:
    from sc2reader.events.game import (
        TargetPointCommandEvent as _TargetPointCommandEvent,
        SelectionEvent as _SelectionEvent,
    )
except Exception:
    _TargetPointCommandEvent = None
    _SelectionEvent = None

try:
    from sc2reader.events.tracker import UnitPositionsEvent as _UnitPositionsEvent
except Exception:
    _UnitPositionsEvent = None


# Map sc2reader unit-type variants to a single canonical name so the
# frontend can find one PNG per unit type instead of failing on a dozen
# variants per unit (sieged tank, burrowed roach, "MP" suffix, etc.).
_UNIT_NAME_ALIASES = {
    "SiegeTank": "SiegeTank",          "SiegeTankSieged": "SiegeTank",
    "VikingFighter": "Viking",         "VikingAssault": "Viking",
    "HellionTank": "Hellbat",          "Hellion": "Hellion",
    "ThorAP": "Thor",                  "ThorAA": "Thor",
    "WidowMineBurrowed": "WidowMine",
    "LiberatorAG": "Liberator",        "Liberator": "Liberator",
    "WarpPrismPhasing": "WarpPrism",   "WarpPrism": "WarpPrism",
    "ZealotWarp": "Zealot",            "StalkerWarp": "Stalker",
    "SentryWarp": "Sentry",            "AdeptWarp": "Adept",
    "DarkTemplarWarp": "DarkTemplar",  "HighTemplarWarp": "HighTemplar",
    "ImmortalWarp": "Immortal",        "ColossusWarp": "Colossus",
    "ObserverSiegeMode": "Observer",
    "BanelingMP": "Baneling",          "BanelingBurrowed": "Baneling",
    "RoachBurrowed": "Roach",          "RoachMP": "Roach",
    "ZerglingBurrowed": "Zergling",
    "HydraliskBurrowed": "Hydralisk",
    "InfestorBurrowed": "Infestor",
    "LurkerMP": "Lurker",              "LurkerMPBurrowed": "Lurker",
    "Lurker": "Lurker",                "LurkerBurrowed": "Lurker",
    "RavagerBurrowed": "Ravager",
    "SwarmHostMP": "SwarmHost",        "SwarmHostMPBurrowed": "SwarmHost",
    "QueenBurrowed": "Queen",
    "BroodLordCocoon": "BroodLord",
    "OverseerSiegeMode": "Overseer",   "OverlordTransport": "Overlord",
    "OverlordTransportCocoon": "Overlord",
    "BroodLord": "BroodLord",
}

# Skip workers + transient fluff. Overlord, Overseer, Queen STAY -- the
# user wants more units rendered, not fewer.
# Workers (Drone/Probe/SCV/MULE) are intentionally NOT skipped --
# they're tracked so the viewer can show them mining + shuttling
# between mineral patches and townhalls. Worker waypoints are
# downsampled to 1Hz in extract_unit_tracks below to keep the
# payload tame.
_SKIP_FOR_TRACKING = {
    "Larva", "Egg",
    # Selection beacons (army/idle/scout/...) are sc2reader artifacts,
    # not real units. Always filter them.
    "BeaconArmy", "BeaconDefend", "BeaconAttack", "BeaconHarass",
    "BeaconIdle", "BeaconAuto", "BeaconDetect", "BeaconScout",
    "BeaconRally", "BeaconCustom1", "BeaconCustom2", "BeaconCustom3",
    "BeaconCustom4",
    "Broodling", "BroodlingEscort",
    "Changeling", "ChangelingMarine", "ChangelingMarineShield",
    "ChangelingZergling", "ChangelingZealot",
    "InfestedTerran",
    "AutoTurret", "PointDefenseDrone", "Interceptor", "AdeptPhaseShift",
    "OverseerCocoon", "BanelingCocoon", "RavagerCocoon", "LurkerCocoon",
    "TransportOverlordCocoon", "BroodLordCocoon",
    "LocustMP", "LocustMPFlying",
    "Spray", "SprayProtoss", "SprayTerran", "SprayZerg",
    "BanelingNestCocoon", "GreaterSpireCocoon",
}


_WORKER_NAMES = {"Drone", "Probe", "SCV", "MULE"}


def _downsample_waypoints_1hz(waypoints):
    """Keep at most one waypoint per integer game-second (the latest one).

    sc2reader's ``UnitPositionsEvent`` fires every game tick (~14Hz at
    Faster speed) and we accumulate every position. For the viewer we
    only need second-resolution snapshots; this reduces a 11-minute
    game's worker waypoint count by ~14x without visible quality loss.
    """
    if not waypoints:
        return waypoints
    by_sec = {}
    for (t, x, y) in waypoints:
        by_sec[int(t)] = (float(t), float(x), float(y))
    return [by_sec[k] for k in sorted(by_sec)]


def _canonical_unit_name(raw):
    """Map a raw sc2reader unit_type_name to its canonical playback name."""
    if not raw:
        return raw
    name = _clean_building_name(raw)
    return _UNIT_NAME_ALIASES.get(name, name)


def _resolve_command_pid_simple(event):
    pl = getattr(event, "player", None)
    pid = getattr(pl, "pid", None) if pl is not None else None
    if pid:
        return pid
    for attr in ("control_player_id", "upkeep_player_id"):
        v = getattr(event, attr, None)
        if v:
            return v
    return None


def extract_unit_tracks(replay, my_pid):
    """Walk the replay once and produce per-unit movement tracks.

    Returns ``{"my_units": [...], "opp_units": [...]}``. Each entry::

        {"id": int, "name": str, "born": float, "died": float|None,
         "waypoints": [t0, x0, y0, t1, x1, y1, ...]}   # flat for compactness

    Buildings and SKIP-listed units are filtered out.
    """
    units = {}
    selections = {}

    tracker = getattr(replay, "tracker_events", None) or []
    try:
        for ev in tracker:
            try:
                if isinstance(ev, (UnitBornEvent, UnitInitEvent)):
                    pid = _get_owner_pid(ev)
                    raw = _get_unit_type_name(ev)
                    if pid is None or raw is None:
                        continue
                    name = _canonical_unit_name(raw)
                    if name in KNOWN_BUILDINGS:
                        continue
                    if name in _SKIP_FOR_TRACKING:
                        continue
                    uid = getattr(ev, "unit_id", None)
                    if uid is None:
                        u = getattr(ev, "unit", None)
                        uid = getattr(u, "id", None) if u is not None else None
                    if uid is None:
                        continue
                    t = float(getattr(ev, "second", 0.0))
                    x = float(getattr(ev, "x", 0) or 0)
                    y = float(getattr(ev, "y", 0) or 0)
                    rec = units.get(uid)
                    if rec is None:
                        units[uid] = {
                            "name": name, "owner_pid": pid, "born": t,
                            "died": None,
                            "waypoints": ([(t, x, y)] if (x or y) else []),
                        }
                    else:
                        rec["name"] = name
                        rec["owner_pid"] = pid
                        rec["born"] = min(rec["born"], t)
                        if x or y:
                            rec["waypoints"].append((t, x, y))

                elif _UnitPositionsEvent is not None and isinstance(ev, _UnitPositionsEvent):
                    t = float(getattr(ev, "second", 0.0))
                    for (uid, (x, y)) in (getattr(ev, "positions", []) or []):
                        rec = units.get(uid)
                        if rec is None:
                            continue
                        # sc2reader stores grid units / 4. Normalize to cells.
                        rec["waypoints"].append((t, float(x) / 4.0, float(y) / 4.0))

                elif UnitDiedEvent is not None and isinstance(ev, UnitDiedEvent):
                    uid = getattr(ev, "unit_id", None)
                    if uid is None:
                        u = getattr(ev, "unit", None)
                        uid = getattr(u, "id", None) if u is not None else None
                    rec = units.get(uid)
                    if rec is not None:
                        rec["died"] = float(getattr(ev, "second", 0.0))

                elif isinstance(ev, UnitTypeChangeEvent):
                    uid = getattr(ev, "unit_id", None)
                    if uid is None:
                        u = getattr(ev, "unit", None)
                        uid = getattr(u, "id", None) if u is not None else None
                    rec = units.get(uid)
                    raw = _get_unit_type_name(ev)
                    if rec is not None and raw:
                        c = _canonical_unit_name(raw)
                        if c not in KNOWN_BUILDINGS and c not in _SKIP_FOR_TRACKING:
                            rec["name"] = c
            except Exception:
                continue
    except Exception:
        pass

    # Game-event pass: track selection + emit destination waypoints.
    if _TargetPointCommandEvent is not None and _SelectionEvent is not None:
        for ev in (getattr(replay, "events", None) or []):
            try:
                if isinstance(ev, _SelectionEvent):
                    if getattr(ev, "control_group", -1) != 10:
                        continue
                    pid = _resolve_command_pid_simple(ev)
                    if not pid:
                        continue
                    new_ids = list(getattr(ev, "new_unit_ids", []) or [])
                    if new_ids:
                        selections[pid] = set(new_ids)
                    continue
                if isinstance(ev, _TargetPointCommandEvent):
                    pid = _resolve_command_pid_simple(ev)
                    if not pid:
                        continue
                    sel = selections.get(pid)
                    if not sel:
                        continue
                    t = float(getattr(ev, "second", 0.0))
                    x = float(getattr(ev, "x", 0) or 0)
                    y = float(getattr(ev, "y", 0) or 0)
                    if not (x or y):
                        continue
                    for uid in sel:
                        rec = units.get(uid)
                        if rec is None or rec.get("owner_pid") != pid:
                            continue
                        if rec.get("died") is not None and t > rec["died"]:
                            continue
                        rec["waypoints"].append((t, x, y))
            except Exception:
                continue

    my_units, opp_units = [], []
    for uid, rec in units.items():
        wps = rec["waypoints"]
        if not wps:
            continue
        wps.sort(key=lambda p: p[0])
        is_worker = rec["name"] in _WORKER_NAMES
        # Workers shuttle mineral->base->mineral every ~6s and fire
        # UnitPositionsEvent every game tick. Downsample to 1Hz so the
        # per-tick noise compresses to one waypoint per game-second.
        # Non-workers use the original "skip if barely moved" compaction
        # so combat micro and unit pathing stay visible.
        if is_worker:
            wps = _downsample_waypoints_1hz(wps)
            compact = wps
        else:
            compact = [wps[0]]
            for (t, x, y) in wps[1:]:
                (pt, px, py) = compact[-1]
                if abs(x - px) < 0.5 and abs(y - py) < 0.5 and (t - pt) < 30:
                    continue
                compact.append((t, x, y))
        flat = []
        for (t, x, y) in compact:
            flat.extend([round(t, 2), round(x, 2), round(y, 2)])
        out = {
            "id": uid,
            "name": rec["name"],
            "is_worker": is_worker,
            "born": round(rec["born"], 2),
            "died": (round(rec["died"], 2) if rec["died"] is not None else None),
            "waypoints": flat,
        }
        (my_units if rec["owner_pid"] == my_pid else opp_units).append(out)

    return {"my_units": my_units, "opp_units": opp_units}
