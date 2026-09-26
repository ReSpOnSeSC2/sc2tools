"""Conservative, public-data hints for producing counters to observed threats.

This is a reward heuristic, not a combat simulator or an optimal-counter table.
Range, upgrades, positioning, spell use, numbers, and actual combat outcomes can
outweigh the hint. It reads no observations, enemy inventory, or hidden state.
The caller must pass only enemy types observed *before* the unit was completed,
and must separately bound/deduplicate completed-unit reward.

Weapons, costs and attributes come from SC2's public UnitTypeData definitions:
https://github.com/Blizzard/s2client-proto/blob/master/s2clientprotocol/data.proto
Those definitions have no flight flag; the explicit standard-melee type sets
below distinguish flight forms without querying unseen enemy units. Unknown
types and unsupported spell-only interactions deliberately receive no hint.
"""
from __future__ import annotations

from collections.abc import Collection
import math
from numbers import Integral
from typing import Any

from sc2.ids.unit_typeid import UnitTypeId as U
from s2clientprotocol import data_pb2 as data


_AIR = frozenset(U[name].value for name in (
    "BANSHEE", "BATTLECRUISER", "LIBERATOR", "LIBERATORAG", "MEDIVAC", "RAVEN", "VIKINGFIGHTER",
    "MUTALISK", "CORRUPTOR", "BROODLORD", "OVERLORD", "OVERLORDTRANSPORT", "OVERSEER",
    "OVERSEERSIEGEMODE", "VIPER", "PHOENIX", "VOIDRAY", "ORACLE", "CARRIER", "TEMPEST",
    "MOTHERSHIP", "OBSERVER", "OBSERVERSIEGEMODE", "WARPPRISM", "WARPPRISMPHASING",
))
_GROUND = frozenset(U[name].value for name in (
    "SCV", "PROBE", "DRONE", "MARINE", "MARAUDER", "REAPER", "GHOST", "HELLION", "HELLIONTANK",
    "WIDOWMINE", "WIDOWMINEBURROWED", "SIEGETANK", "SIEGETANKSIEGED", "CYCLONE", "THOR",
    "THORAP", "VIKINGASSAULT", "QUEEN", "QUEENBURROWED", "ZERGLING", "ZERGLINGBURROWED",
    "BANELING", "BANELINGBURROWED", "ROACH", "ROACHBURROWED", "RAVAGER", "RAVAGERBURROWED",
    "HYDRALISK", "HYDRALISKBURROWED", "LURKERMP", "LURKERMPBURROWED", "INFESTOR",
    "INFESTORBURROWED", "SWARMHOSTMP", "SWARMHOSTBURROWEDMP", "ULTRALISK", "ULTRALISKBURROWED",
    "ZEALOT", "STALKER", "ADEPT", "SENTRY", "IMMORTAL", "COLOSSUS", "DISRUPTOR",
    "HIGHTEMPLAR", "DARKTEMPLAR", "ARCHON", "PHOTONCANNON", "BUNKER", "MISSILETURRET",
    "PLANETARYFORTRESS", "SPINECRAWLER", "SPORECRAWLER",
))
_WORKERS = frozenset((U.SCV.value, U.PROBE.value, U.DRONE.value))
# Their damage can be represented by abilities or spawned units rather than a
# direct weapon in UnitTypeData. This recognizes a previously observed threat;
# it does not fabricate a weapon for the unit being rewarded.
_AIR_COMBAT_WITH_INDIRECT_WEAPONS = frozenset((U.CARRIER.value, U.BATTLECRUISER.value, U.ORACLE.value))


def _type_id(value: Any) -> int | None:
    if isinstance(value, U):
        return value.value
    return int(value) if isinstance(value, Integral) and not isinstance(value, bool) else None


def _proto(game_data: Any, type_id: int | None) -> Any:
    if type_id not in _AIR and type_id not in _GROUND:
        return None
    unit = getattr(game_data, "units", {}).get(type_id)
    return getattr(unit, "_proto", None)


def _damaging(weapon: Any) -> bool:
    return (weapon.type in (data.Weapon.Ground, data.Weapon.Air, data.Weapon.Any)
            and math.isfinite(weapon.damage) and weapon.damage > 0
            and weapon.attacks > 0 and math.isfinite(weapon.speed) and weapon.speed > 0)


def counter_match(unit_type: int, known_threats: Collection[int], game_data: Any) -> bool:
    """Whether public weapons suggest a response to a previously observed type.

    The produced unit must be a paid, non-worker army unit with a damaging
    weapon. Its compatible weapon must either have a positive damage bonus
    against an observed threat's attributes, or provide anti-air against an
    observed flying combat threat. Being able to attack ordinary ground units
    alone is insufficient. Worker sightings and unarmed supply/transport units
    do not trigger a counter reward.

    Uses exact mode data: siege/assault/fighter/burrowed forms are not aliases
    for one another. For example, an Immortal's ground-only armored bonus does
    not counter a flying armored unit. Colossi are targetable by both planes,
    but are not flying threats for the general anti-air bonus.
    """
    own_id = _type_id(unit_type)
    own = _proto(game_data, own_id)
    if (own is None or own_id in _WORKERS
            or data.Structure in own.attributes or data.Summoned in own.attributes
            or own.mineral_cost + own.vespene_cost <= 0):
        return False
    weapons = tuple(weapon for weapon in own.weapons if _damaging(weapon))
    if not weapons:
        return False
    for value in known_threats:
        threat_id = _type_id(value)
        threat = _proto(game_data, threat_id)
        if (threat is None or threat_id in _WORKERS or data.Summoned in threat.attributes
                or not (any(_damaging(weapon) for weapon in threat.weapons)
                        or threat_id in _AIR_COMBAT_WITH_INDIRECT_WEAPONS)):
            continue
        flying = threat_id in _AIR
        target_types = {data.Weapon.Any, data.Weapon.Air if flying else data.Weapon.Ground}
        if threat_id == U.COLOSSUS.value:
            target_types.add(data.Weapon.Air)
        for weapon in weapons:
            if weapon.type not in target_types:
                continue
            if flying:
                return True
            if any(bonus.attribute in threat.attributes and math.isfinite(bonus.bonus) and bonus.bonus > 0
                   for bonus in weapon.damage_bonus):
                return True
    return False
