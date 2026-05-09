"""Event extraction from sc2reader replays.

`extract_events(replay, my_pid)` is the canonical pass over a replay's tracker
events. It flattens unit/building/upgrade events into plain dictionaries that
the detectors and analytics layers consume. The constants in this module
(KNOWN_BUILDINGS, MORPH_BUILDINGS, SKIP_UNITS, SKIP_BUILDINGS) act as the
filter that prevents noise (workers, larva, locusts, etc.) from polluting
downstream feature extraction.
"""

import sys
from typing import Any, Dict, List, Optional, Set, Tuple

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

# Worker unit names — used to drive the cumulative ``workers_built``
# counter on the player_stats summary. Mirrors the lowercased set in
# ``apps/web/lib/sc2-units.ts``; MULEs are intentionally OUT because
# they're temporary calldown helpers and inflate "workers built" past
# the saturated worker line shown on the chart.
WORKER_NAMES: Set[str] = {"Drone", "Probe", "SCV"}


# Build / morph / research durations in seconds, used to convert a
# sc2reader event's "completion" timestamp back into a "construction
# start" timestamp. The user-facing build orders should always show
# the start time of an action, not when the engine notified that the
# action finished.
#
# Numbers are LotV 5.0.x balance, the same patch the timing-catalog
# tokens are aligned with. Older patches differ slightly but the
# resulting drift is well inside the natural variance the DNA cards
# already absorb.
STRUCTURE_MORPH_SECONDS: Dict[str, int] = {
    # Zerg town-hall morphs
    "Lair": 57,
    "Hive": 71,
    "GreaterSpire": 71,
    # Terran add-on / upgrade morphs
    "OrbitalCommand": 25,
    "PlanetaryFortress": 36,
    # Protoss
    "WarpGate": 7,
}

UNIT_BUILD_SECONDS: Dict[str, int] = {
    # Protoss
    "Probe": 12, "Zealot": 27, "Stalker": 30, "Sentry": 26, "Adept": 27,
    "HighTemplar": 39, "DarkTemplar": 39, "Archon": 9, "Observer": 21,
    "Immortal": 39, "WarpPrism": 36, "Colossus": 54, "Disruptor": 36,
    "Phoenix": 25, "VoidRay": 43, "Oracle": 37, "Tempest": 43,
    "Carrier": 64, "Mothership": 71,
    # Terran
    "SCV": 12, "Marine": 18, "Marauder": 21, "Reaper": 32, "Ghost": 29,
    "Hellion": 21, "Hellbat": 21, "WidowMine": 21, "Cyclone": 32,
    "SiegeTank": 32, "Thor": 43, "Viking": 30, "Medivac": 30,
    "Liberator": 43, "Banshee": 43, "Raven": 34, "Battlecruiser": 64,
    # Zerg (most are larva-morphs — duration is the morph)
    "Drone": 12, "Overlord": 18, "Queen": 36, "Zergling": 17,
    "Baneling": 14, "Roach": 19, "Ravager": 9, "Hydralisk": 24,
    "Lurker": 18, "Mutalisk": 24, "Corruptor": 29, "BroodLord": 24,
    "Infestor": 36, "SwarmHost": 29, "Viper": 29, "Ultralisk": 39,
    "Overseer": 12,
}

UPGRADE_BUILD_SECONDS: Dict[str, int] = {
    # Protoss
    "WarpGateResearch": 100, "Charge": 100, "Blink": 121,
    "ResonatingGlaives": 100, "PsiStorm": 79, "ShadowStride": 100,
    "ExtendedThermalLance": 100, "GraviticBoosters": 57,
    "GraviticDrive": 57, "AnionPulseCrystals": 64, "FluxVanes": 43,
    "TectonicDestabilizers": 100,
    "ProtossGroundWeaponsLevel1": 128, "ProtossGroundWeaponsLevel2": 152,
    "ProtossGroundWeaponsLevel3": 176,
    "ProtossGroundArmorsLevel1": 128, "ProtossGroundArmorsLevel2": 152,
    "ProtossGroundArmorsLevel3": 176,
    "ProtossShieldsLevel1": 128, "ProtossShieldsLevel2": 152,
    "ProtossShieldsLevel3": 176,
    "ProtossAirWeaponsLevel1": 128, "ProtossAirWeaponsLevel2": 152,
    "ProtossAirWeaponsLevel3": 176,
    "ProtossAirArmorsLevel1": 128, "ProtossAirArmorsLevel2": 152,
    "ProtossAirArmorsLevel3": 176,
    # Terran
    "Stimpack": 100, "ShieldWall": 79, "CombatShield": 79,
    "ConcussiveShells": 43, "HiSecAutoTracking": 57, "StructureArmor": 100,
    "NeosteelFrame": 71, "CloakingField": 79, "HyperflightRotors": 121,
    "AdvancedBallistics": 79, "CycloneLockOnDamage": 100,
    "CycloneRapidFireLaunchers": 100, "EnhancedShockwaves": 79,
    "PersonalCloaking": 86, "InterferenceMatrix": 57,
    "TerranInfantryWeaponsLevel1": 114, "TerranInfantryWeaponsLevel2": 136,
    "TerranInfantryWeaponsLevel3": 157,
    "TerranInfantryArmorsLevel1": 114, "TerranInfantryArmorsLevel2": 136,
    "TerranInfantryArmorsLevel3": 157,
    "TerranVehicleWeaponsLevel1": 114, "TerranVehicleWeaponsLevel2": 136,
    "TerranVehicleWeaponsLevel3": 157,
    "TerranVehicleAndShipPlatingLevel1": 114,
    "TerranVehicleAndShipPlatingLevel2": 136,
    "TerranVehicleAndShipPlatingLevel3": 157,
    "TerranShipWeaponsLevel1": 114, "TerranShipWeaponsLevel2": 136,
    "TerranShipWeaponsLevel3": 157,
    # Zerg
    "ZerglingMovementSpeed": 100, "Metabolicboost": 100,
    "ZerglingAttackSpeed": 100, "CentrifugalHooks": 79,
    "GlialReconstitution": 71, "TunnelingClaws": 79, "Burrow": 71,
    "PathogenGlands": 50, "AdrenalGlands": 93, "GroovedSpines": 71,
    "MuscularAugments": 79, "AdaptiveTalons": 57, "PneumatizedCarapace": 43,
    "Overlordspeed": 43, "ChitinousPlating": 79, "AnabolicSynthesis": 43,
    "FlyerAttacks1": 114, "FlyerArmor1": 114,
    "ZergMissileWeaponsLevel1": 114, "ZergMissileWeaponsLevel2": 136,
    "ZergMissileWeaponsLevel3": 157,
    "ZergMeleeWeaponsLevel1": 114, "ZergMeleeWeaponsLevel2": 136,
    "ZergMeleeWeaponsLevel3": 157,
    "ZergGroundArmorsLevel1": 114, "ZergGroundArmorsLevel2": 136,
    "ZergGroundArmorsLevel3": 157,
    "ZergFlyerWeaponsLevel1": 114, "ZergFlyerWeaponsLevel2": 136,
    "ZergFlyerWeaponsLevel3": 157,
    "ZergFlyerArmorsLevel1": 114, "ZergFlyerArmorsLevel2": 136,
    "ZergFlyerArmorsLevel3": 157,
}


def _start_time(name: str, recorded_sec: int, kind: str) -> int:
    """Return the construction-start timestamp for an event.

    Kept here as the canonical Python-side mapping table mirrored by
    the cloud's ``apps/api/src/services/buildDurations.js`` — when one
    moves, the other should follow.

    The agent's ``extract_events`` deliberately does NOT call this on
    its own output, because ``opponent.py`` / ``user.py`` detection
    rules and the per-game uploads consume recorded (mixed-semantic)
    times. The cloud applies this conversion at the timeline-display
    layer only, so display surfaces show start times without
    perturbing rule evaluation. Standalone tooling (CLI scripts that
    want a start-time view without going through the cloud) can call
    this directly.

    ``kind`` is one of ``"struct_init"`` (already a start),
    ``"struct_morph"`` (UnitTypeChangeEvent — completion), ``"unit"``
    (UnitBornEvent for non-structure units — completion), ``"upgrade"``
    (UpgradeCompleteEvent — completion). Names not found in any
    duration table fall through and return the recorded value
    unchanged.
    """
    if recorded_sec is None or recorded_sec < 0:
        return 0
    if kind == "struct_init":
        return int(recorded_sec)
    if kind == "struct_morph":
        delta = STRUCTURE_MORPH_SECONDS.get(name)
    elif kind == "unit":
        delta = UNIT_BUILD_SECONDS.get(name)
    elif kind == "upgrade":
        delta = UPGRADE_BUILD_SECONDS.get(name)
    else:
        delta = None
    if delta is None:
        return int(recorded_sec)
    start = int(recorded_sec) - int(delta)
    return 0 if start < 0 else start


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
                    # UnitBornEvent's ``second`` is the unit-emerges
                    # (FINISH) timestamp. Detection rules in
                    # ``opponent.py`` / ``user.py`` are calibrated against
                    # this value — see ``_start_time`` for the start-time
                    # mapping the cloud applies on display.
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


def _resolve_target_unit_id(event) -> int:
    """Return the target unit id for a TargetUnitCommandEvent, else 0.

    Chrono Boost CommandEvents target a specific Protoss building.
    sc2reader exposes this as ``target_unit_id`` on
    TargetUnitCommandEvent. Returns 0 when the field is missing or
    the event type does not carry a target (TargetPointCommandEvent,
    BasicCommandEvent), so callers can use truthiness to detect
    "no attribution available".

    Example:
        >>> e = type("E", (), {"target_unit_id": 1234})()
        >>> _resolve_target_unit_id(e)
        1234
    """
    raw = getattr(event, "target_unit_id", None)
    if raw is None:
        return 0
    try:
        return int(raw)
    except (TypeError, ValueError):
        return 0


def _build_chrono_targets(
    ability_events: List[Dict[str, Any]],
    name_by_uid: Dict[int, str],
) -> List[Dict[str, Any]]:
    """Aggregate chrono casts into a [{building_name, count}] list.

    Walks every ability_event tagged ``category == "chrono"``, looks
    up its ``target_unit_id`` in ``name_by_uid`` (which maps every
    building seen for my_pid to its canonical name, including
    in-progress and morphed forms), and bins the count under that
    name. Targets that cannot be resolved bucket as ``"Unknown"`` —
    we never invent a name. The returned list is sorted by count
    desc, then name asc, so the SPA renders in a stable order.

    Example:
        >>> events = [
        ...     {"category": "chrono", "target_unit_id": 10},
        ...     {"category": "chrono", "target_unit_id": 10},
        ...     {"category": "chrono", "target_unit_id": 0},
        ...     {"category": "inject", "target_unit_id": 99},
        ... ]
        >>> _build_chrono_targets(events, {10: "Nexus"})
        [{'building_name': 'Nexus', 'count': 2}, {'building_name': 'Unknown', 'count': 1}]
    """
    counts: Dict[str, int] = {}
    for ev in ability_events:
        if ev.get("category") != "chrono":
            continue
        uid_raw = ev.get("target_unit_id")
        try:
            uid = int(uid_raw) if uid_raw is not None else 0
        except (TypeError, ValueError):
            uid = 0
        name = name_by_uid.get(uid) if uid else None
        if not name:
            name = "Unknown"
        counts[name] = counts.get(name, 0) + 1
    return [
        {"building_name": n, "count": c}
        for n, c in sorted(counts.items(), key=lambda kv: (-kv[1], kv[0]))
    ]


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
    # Per-player cumulative counters, populated during the tracker walk
    # and emitted on ``out["player_stats"]`` so the SPA's Replay Player
    # Unit Statistics table can render Units Produced / Killed / Lost /
    # Structures Killed / Workers Built without re-walking the events.
    # Keyed by pid; entries are zero-filled for both my_pid and opp_pid
    # (when present) so the SPA never has to handle missing keys.
    player_counters: Dict[int, Dict[str, int]] = {}
    counted_pids = [p for p in (my_pid, opp_pid) if p is not None]
    for _pid in counted_pids:
        player_counters[_pid] = {
            "units_produced": 0,
            "units_killed": 0,
            "units_lost": 0,
            "workers_built": 0,
            "structures_built": 0,
            "structures_killed": 0,
            "structures_lost": 0,
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
    # Mirror ``lifetimes`` for the opponent — only the death events are
    # needed (so we can attribute "structures killed" to my_pid in 2-player
    # games), but we record births/morphs as well so morph chains
    # (Hatch→Lair→Hive, CC→OC→PF) resolve to the destroyed canonical
    # name. Empty dict when ``opp_pid is None``.
    opp_lifetimes: Dict[int, Dict] = {}
    # building_name_by_uid mirrors lifetimes for chrono target
    # naming: it captures the canonical name of EVERY building seen
    # for my_pid (including in-progress targets that have not fired
    # UnitDoneEvent yet, since chrono on a partially-built tech
    # structure is a common opener). Morphs (Lair, Hive, etc.) are
    # followed by overwriting on UnitTypeChangeEvent.
    building_name_by_uid: Dict[int, str] = {}

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
                    # Active-forces value: minerals + vespene tied up in
                    # currently-alive non-worker, non-building units. This is
                    # sc2reader's canonical "army value" — the same number SC2
                    # itself shows on the in-game Army graph and the one
                    # sc2replaystats's Army Value chart reads. Surfacing it
                    # here lets the SPA's Active Army chart bind directly to
                    # the authoritative per-tick value rather than trying to
                    # reconstruct it from unit_timeline + buildLog (a cascade
                    # that under-counts when the timeline is sparse and
                    # over-counts via cumulative build-order when the timeline
                    # is empty — the latter is what produced the late-game
                    # vertical spike to ~9 200 reported in the bug). Older
                    # sc2reader builds expose ``*_used_current_army`` instead,
                    # so we fall back to that name when the active-forces
                    # one isn't present.
                    army_minerals = getattr(
                        event, "minerals_used_active_forces",
                        getattr(event, "minerals_used_current_army", 0),
                    )
                    army_vespene = getattr(
                        event, "vespene_used_active_forces",
                        getattr(event, "vespene_used_current_army", 0),
                    )
                    army_value = int((army_minerals or 0) + (army_vespene or 0))
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
                        # Σ minerals+gas of active (alive, non-worker)
                        # forces — the chart's primary army-value source.
                        "army_value": army_value,
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

                    # Cumulative counters. ``units_produced`` covers
                    # army units (workers and noise units like Larva /
                    # Broodling are in SKIP_UNITS so they don't inflate
                    # the count). ``workers_built`` is its own branch
                    # because the workers sit inside SKIP_UNITS. Only
                    # UnitBornEvent fires the increment — UnitInitEvent
                    # / UnitDoneEvent are the building completion paths.
                    if (pid in player_counters
                            and isinstance(event, UnitBornEvent)
                            and clean not in KNOWN_BUILDINGS
                            and clean not in SKIP_UNITS
                            and not _skip_for_unit_timeline(clean)):
                        player_counters[pid]["units_produced"] += 1
                    if (pid in player_counters
                            and isinstance(event, UnitBornEvent)
                            and clean in WORKER_NAMES):
                        player_counters[pid]["workers_built"] += 1

                    # Mirror the building lifetime tracker for opp_pid so
                    # we can attribute "structures killed" to a player on
                    # UnitDiedEvent. Without this, every opp building
                    # death is silently ignored — symptom: the SPA's
                    # stats table always reads "0 structures killed".
                    if (opp_pid is not None
                            and pid == opp_pid
                            and clean in KNOWN_BUILDINGS
                            and uid is not None):
                        is_completion = (
                            isinstance(event, UnitDoneEvent)
                            or (isinstance(event, UnitBornEvent)
                                and clean in _BASE_TYPES)
                        )
                        if is_completion:
                            entry = opp_lifetimes.get(uid)
                            if entry is None:
                                opp_lifetimes[uid] = {
                                    "name": clean, "born": t, "died": None,
                                }
                            else:
                                entry["born"] = min(entry.get("born", t), t)
                                entry["name"] = clean

                    # Increment ``structures_built`` for whichever pid
                    # this is. UnitDoneEvent fires on completion for
                    # P/T; for Z, drone-morph buildings complete on
                    # UnitBornEvent. Match the same gate the my_pid
                    # branch below uses so we're consistent across sides.
                    if (pid in player_counters
                            and clean in KNOWN_BUILDINGS
                            and clean not in SKIP_BUILDINGS
                            and uid is not None):
                        is_completion = (
                            isinstance(event, UnitDoneEvent)
                            or (isinstance(event, UnitBornEvent)
                                and clean in _BASE_TYPES)
                        )
                        if is_completion:
                            player_counters[pid]["structures_built"] += 1

                    if pid != my_pid:
                        continue
                    if clean in KNOWN_BUILDINGS:
                        # Always remember the name → unit_id mapping,
                        # even on Init/Born events that precede
                        # completion. Powers chrono target lookup.
                        if uid is not None:
                            building_name_by_uid[uid] = clean
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
                    # Mirror morph names for opp buildings so structure
                    # kill attribution lands on the destroyed canonical
                    # form (Hatch→Lair→Hive arrives as a sequence of
                    # UnitTypeChangeEvents on the same uid).
                    if (opp_pid is not None and pid == opp_pid
                            and uid in opp_lifetimes
                            and clean in KNOWN_BUILDINGS):
                        opp_lifetimes[uid]["name"] = clean
                    # Mirror name into the chrono lookup so a
                    # chrono on (e.g.) a Hatchery-becoming-Lair
                    # records under "Lair" once the morph fires.
                    if (pid == my_pid and clean in KNOWN_BUILDINGS
                            and uid is not None):
                        building_name_by_uid[uid] = clean
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
                    died_t = int(getattr(event, "second", 0))
                    # Resolve who got the kill credit. sc2reader exposes
                    # ``killing_player_id`` on UnitDiedEvent as of 1.7.x;
                    # ``killer_pid`` is the deprecated alias and a useful
                    # fallback. Both are 0 / None when the engine
                    # couldn't attribute (self-destruct, neutral, etc.).
                    killer_pid = (
                        getattr(event, "killing_player_id", None)
                        or getattr(event, "killer_pid", None)
                    )
                    if isinstance(killer_pid, int) and killer_pid == 0:
                        killer_pid = None
                    if uid in lifetimes:
                        lifetimes[uid]["died"] = died_t
                        # The victim is a my_pid building. Credit the
                        # opponent's "structures_killed" (or the
                        # explicit killer if known) and increment
                        # my_pid's "structures_lost".
                        if my_pid in player_counters:
                            player_counters[my_pid]["structures_lost"] += 1
                        cred = killer_pid if killer_pid in player_counters \
                            else opp_pid
                        if cred in player_counters and cred != my_pid:
                            player_counters[cred]["structures_killed"] += 1
                    if uid in opp_lifetimes:
                        opp_lifetimes[uid]["died"] = died_t
                        if opp_pid in player_counters:
                            player_counters[opp_pid]["structures_lost"] += 1
                        cred = killer_pid if killer_pid in player_counters \
                            else my_pid
                        if cred in player_counters and cred != opp_pid:
                            player_counters[cred]["structures_killed"] += 1
                    if uid in unit_lifetimes:
                        unit_lifetimes[uid]["died"] = died_t
                        victim_pid = unit_lifetimes[uid].get("pid")
                        if victim_pid in player_counters:
                            player_counters[victim_pid]["units_lost"] += 1
                        cred = killer_pid if killer_pid in player_counters else (
                            my_pid if victim_pid == opp_pid else opp_pid
                        )
                        if cred in player_counters and cred != victim_pid:
                            player_counters[cred]["units_killed"] += 1
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
    # last_chrono_target_per_pid runs in lock-step with
    # last_bucket_per_pid, exactly as the inject-target tracking
    # works in the missed-injects pattern: when the head
    # CommandEvent of a chrono chain has target_unit_id N, every
    # subsequent CommandManagerStateEvent re-execution attaches
    # to the same target. Cleared whenever the player issues a
    # non-chrono macro cast or any non-macro CommandEvent.
    last_chrono_target_per_pid: Dict[int, int] = {}
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
                        record = {
                            "ability_name": bucket,
                            "category": bucket,
                            "time": int(getattr(event, "second", 0)),
                            "via": "state_event",
                        }
                        if bucket == "chrono":
                            record["target_unit_id"] = (
                                last_chrono_target_per_pid.get(pid, 0))
                        out["ability_events"].append(record)
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
                    last_chrono_target_per_pid.pop(pid, None)
                    continue
                last_bucket_per_pid[pid] = bucket
                record = {
                    "ability_name": _normalize_ability_name(event) or bucket,
                    "category": bucket,
                    "time": int(getattr(event, "second", 0)),
                }
                if bucket == "chrono":
                    target = _resolve_target_unit_id(event)
                    record["target_unit_id"] = target
                    if target:
                        last_chrono_target_per_pid[pid] = target
                    else:
                        last_chrono_target_per_pid.pop(pid, None)
                else:
                    last_chrono_target_per_pid.pop(pid, None)
                out["ability_events"].append(record)
                out["ability_counts"][bucket] += 1
            except Exception:
                continue
    except Exception:
        pass

    # Aggregate chrono casts by target building. Empty list on
    # non-Protoss replays (no chrono casts → nothing to bucket);
    # the SPA gates the donut on race + non-empty list.
    out["chrono_targets"] = _build_chrono_targets(
        out["ability_events"], building_name_by_uid)

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

    # Per-player cumulative summary. The SPA's Replay Player Unit
    # Statistics table reads this directly. Keys mirror the field
    # names sc2replaystats uses for the equivalent table — the SPA
    # types (PlayerStats in MacroBreakdownPanel.types.ts) define the
    # canonical wire schema. Empty dict when no counted pids.
    out["player_stats"] = {
        str(pid): dict(stats) for pid, stats in player_counters.items()
    }

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
