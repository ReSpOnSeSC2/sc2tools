"""Per-entity build durations and the recorded-time -> start-time rewind.

Python port of ``apps/api/src/services/buildDurations.js``. The replay
extractor records different moments for different entities:

  * plain structures -> construction START (``UnitInitEvent``, or the
    ``UnitBornEvent`` of a Zerg drone morph);
  * units, structure morphs (Lair, Orbital, Warp Gate, ...) and upgrades
    -> the moment they FINISH (``UnitBornEvent`` / ``UnitTypeChangeEvent``
    / ``UpgradeCompleteEvent``).

The website shows every build-order row at its START time, and the build
editor saves custom-rule ``time_lt`` thresholds off that timeline. The
cloud therefore rewinds finish-time events (``eventsToStartTime``) before
it evaluates a v3 custom rule; :func:`to_start_seconds` is the same rewind
for the desktop evaluator
(``BaseStrategyDetector.check_custom_rules``), so one saved rule gives one
verdict on both sides.

The tables are the 12-worker game's balance (every patch before 5.0.16,
and 5.0.17 on). ``EIGHT_WORKER_BUILD_SECONDS`` holds the handful of
entries the 8-worker patch 5.0.16 retuned.

Keep every table identical to buildDurations.js:
``tests/fixtures/build_durations.json`` is the shared snapshot both test
suites compare against (``tests/test_custom_rule_parity.py`` here,
``__tests__/customRuleParity.test.js`` in the API).

This module has no imports beyond the standard library so the detectors
can use it without loading sc2reader.
"""

from __future__ import annotations

import math
from typing import Dict, Optional

# Morph chains: the recorded event is the morph COMPLETION.
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
    # Some replays surface alt-name forms; map them too.
    "WarpGateResearch": 100,
}

# Plain structures are recorded at their start, so these are never
# subtracted. The table only tells the rewind "this name is a structure"
# when the caller has no type for the event.
STRUCTURE_BUILD_SECONDS: Dict[str, int] = {
    # Protoss
    "Nexus": 71, "Pylon": 18, "Assimilator": 21, "Gateway": 46, "Forge": 32,
    "CyberneticsCore": 36, "PhotonCannon": 29, "ShieldBattery": 29,
    "TwilightCouncil": 36, "RoboticsFacility": 46, "Stargate": 43,
    "TemplarArchive": 36, "DarkShrine": 71, "RoboticsBay": 46,
    "FleetBeacon": 43,
    # Zerg
    "Hatchery": 71, "Extractor": 21, "SpawningPool": 46,
    "EvolutionChamber": 25, "RoachWarren": 39, "BanelingNest": 43,
    "HydraliskDen": 29, "LurkerDen": 57, "Spire": 71, "InfestationPit": 36,
    "NydusNetwork": 36, "UltraliskCavern": 46,
    # Terran
    "CommandCenter": 71, "SupplyDepot": 21, "Refinery": 21, "Barracks": 46,
    "EngineeringBay": 25, "Bunker": 29, "MissileTurret": 18,
    "SensorTower": 18, "Factory": 43, "GhostAcademy": 29, "Starport": 36,
    "Armory": 46, "FusionCore": 46, "TechLab": 18, "Reactor": 36,
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
    # Spawned / morphed mid-fight: too short / situational to subtract
    # anything sensible, treat as instant.
    "Locust": 0, "Interceptor": 9, "Changeling": 0, "Broodling": 0,
}

# The 8-worker patch 5.0.16's values for the entries it retuned (the
# WarpGate morph and four unit trains); every other entry kept its
# 12-worker value.
EIGHT_WORKER_BUILD_SECONDS: Dict[str, int] = {
    # Structure morph
    "WarpGate": 4,
    # Units
    "Adept": 33, "HighTemplar": 40, "DarkTemplar": 40, "Reaper": 34,
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
    "WeaponRefit": 43, "AdvancedBallistics": 79, "CycloneLockOnDamage": 100,
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
    "ZerglingAttackSpeed": 100, "CentrificalHooks": 79,
    "CentrifugalHooks": 79, "GlialReconstitution": 71, "TunnelingClaws": 79,
    "Burrow": 71, "PathogenGlands": 50, "AdrenalGlands": 93,
    "GroovedSpines": 71, "MuscularAugments": 79, "AdaptiveTalons": 57,
    "PneumatizedCarapace": 43, "Overlordspeed": 43, "ChitinousPlating": 79,
    "AnabolicSynthesis": 43, "FlyerAttacks1": 114, "FlyerArmor1": 114,
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


def duration_key(name: object) -> str:
    """Lowercase ``name`` and drop everything but ``a-z0-9``.

    sc2reader reports some upgrades in lower case (``zerglingmovementspeed``)
    and the cloud's build log can carry spaced display names, so every
    lookup goes through this key, exactly like ``key()`` in buildDurations.js.

    Example:
        >>> duration_key("Spawning Pool")
        'spawningpool'
    """
    if not isinstance(name, str):
        return ""
    return "".join(
        ch for ch in name.lower()
        if "a" <= ch <= "z" or "0" <= ch <= "9"
    )


def _lookup(table: Dict[str, int]) -> Dict[str, int]:
    return {duration_key(name): seconds for name, seconds in table.items()}


_STRUCTURE_MORPH_LOOKUP = _lookup(STRUCTURE_MORPH_SECONDS)
_STRUCTURE_BUILD_LOOKUP = _lookup(STRUCTURE_BUILD_SECONDS)
_UNIT_BUILD_LOOKUP = _lookup(UNIT_BUILD_SECONDS)
_UPGRADE_BUILD_LOOKUP = _lookup(UPGRADE_BUILD_SECONDS)
_EIGHT_WORKER_LOOKUP = _lookup(EIGHT_WORKER_BUILD_SECONDS)


def is_finish_time_event(
    name: object, is_building: bool = False, is_upgrade: bool = False,
) -> bool:
    """Whether the recorded time of ``name`` is a finish (not a start).

    Upgrades, structure morphs and units are; plain structures are not.

    Example:
        >>> is_finish_time_event("Lair", is_building=True)
        True
        >>> is_finish_time_event("Gateway", is_building=True)
        False
    """
    k = duration_key(name)
    if not k:
        return False
    if is_upgrade or k in _UPGRADE_BUILD_LOOKUP:
        return True
    if k in _STRUCTURE_MORPH_LOOKUP:
        return True
    if is_building or k in _STRUCTURE_BUILD_LOOKUP:
        return False
    # Default: treat as a unit (finish-time event).
    return True


def build_seconds_for(
    name: object, is_upgrade: bool = False, eight_worker: bool = False,
) -> Optional[int]:
    """Build / morph / research duration of ``name``, or None when unknown.

    Example:
        >>> build_seconds_for("Adept")
        27
        >>> build_seconds_for("Adept", eight_worker=True)
        33
    """
    k = duration_key(name)
    if not k:
        return None
    if is_upgrade or k in _UPGRADE_BUILD_LOOKUP:
        return _UPGRADE_BUILD_LOOKUP.get(k)
    if eight_worker and k in _EIGHT_WORKER_LOOKUP:
        return _EIGHT_WORKER_LOOKUP[k]
    for table in (
        _STRUCTURE_MORPH_LOOKUP, _STRUCTURE_BUILD_LOOKUP, _UNIT_BUILD_LOOKUP,
    ):
        if k in table:
            return table[k]
    return None


def to_start_seconds(
    name: object,
    recorded_sec: float,
    is_building: bool = False,
    is_upgrade: bool = False,
    eight_worker: bool = False,
) -> float:
    """Rewind a recorded event time to the moment the action started.

    Returns the recorded time unchanged for a plain structure or an
    unknown name, and clamps at 0.

    Example:
        >>> to_start_seconds("Lair", 300, is_building=True)
        243
        >>> to_start_seconds("Gateway", 60, is_building=True)
        60
        >>> to_start_seconds("zerglingmovementspeed", 301, is_upgrade=True)
        201
    """
    if (
        isinstance(recorded_sec, bool)
        or not isinstance(recorded_sec, (int, float))
        or not math.isfinite(recorded_sec)
        or recorded_sec < 0
    ):
        return 0
    if not is_finish_time_event(name, is_building, is_upgrade):
        return recorded_sec
    duration = build_seconds_for(name, is_upgrade, eight_worker)
    if duration is None:
        return recorded_sec
    start = recorded_sec - duration
    return 0 if start < 0 else start
