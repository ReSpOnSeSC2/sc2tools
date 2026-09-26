"""Resource-aware placement candidates for the global-own-unit opponents.

This module resolves a policy-chosen build action; it never chooses a build or
issues an order. Townhalls use SC2's startup-cached, public resource expansion
geometry. Every live placement query, including reserved Terran addon space,
requires a currently visible footprint. Hidden enemy state and refreshed global
pathing grids are never read.
"""
from __future__ import annotations

import math
from functools import lru_cache
from typing import Any, Callable, Iterable

from sc2.ids.ability_id import AbilityId
from sc2.position import Point2


BASE_TYPES = frozenset(("COMMANDCENTER", "ORBITALCOMMAND", "PLANETARYFORTRESS", "HATCHERY", "LAIR", "HIVE"))
PRODUCTION_TYPES = frozenset(("BARRACKS", "FACTORY", "STARPORT"))
_TWO_TILE = frozenset(("SUPPLYDEPOT", "SUPPLYDEPOTLOWERED", "MISSILETURRET", "SENSORTOWER",
                       "SPINECRAWLER", "SPORECRAWLER", "BARRACKSTECHLAB", "BARRACKSREACTOR",
                       "FACTORYTECHLAB", "FACTORYREACTOR", "STARPORTTECHLAB", "STARPORTREACTOR"))
MAX_RADIUS = 32
QUERY_BATCH = 48
PLACEMENT_PROFILE = "visible-resource-layout-v1"


def _point(value: Any) -> Point2:
    return value.position if hasattr(value, "position") else Point2(value)


def footprint_width(kind: Any, game_data: Any = None) -> float:
    name = kind.name
    data = getattr(game_data, "units", {}).get(kind.value) if game_data is not None else None
    radius = getattr(data, "footprint_radius", None)
    if radius is not None and math.isfinite(radius) and radius > 0:
        return float(radius * 2)
    return 5.0 if name in BASE_TYPES else 2.0 if name in _TWO_TILE else 3.0


def building_candidates(center: Any, width: float, max_radius: int = MAX_RADIUS) -> list[Point2]:
    """Deterministic complete two-tile lattice, rather than eight rays.

    Grid alignment follows SC2: even footprints have integer centers, odd ones
    have half-integer centers. Distance ordering tries nearby free gaps first.
    """
    if not math.isfinite(width) or width <= 0 or type(max_radius) is not int or max_radius < 0:
        raise ValueError("Positive footprint and nonnegative integer search radius required")
    center = _point(center)
    offset = 0.5 if round(width) % 2 else 0.0
    anchor = Point2((math.floor(center.x) + offset, math.floor(center.y) + offset))
    return list(_building_candidates(anchor.x, anchor.y, max_radius))


@lru_cache(maxsize=128)
def _building_candidates(x: float, y: float, max_radius: int) -> tuple[Point2, ...]:
    # Only immutable public geometry is cached; no visibility, occupancy,
    # ability availability or placement-query result crosses observations.
    anchor = Point2((x, y))
    offsets = [(x, y) for x in range(-max_radius, max_radius + 1, 2)
               for y in range(-max_radius, max_radius + 1, 2)]
    offsets.sort(key=lambda xy: (xy[0] * xy[0] + xy[1] * xy[1], xy[0], xy[1]))
    return tuple(anchor.offset(delta) for delta in offsets)


def expansion_candidates(locations: Iterable[Any], own_bases: Iterable[Any], origin: Any) -> list[Point2]:
    """Only resource-cluster sites, excluding existing or unfinished townhalls."""
    bases = [_point(base) for base in own_bases if not getattr(base, "is_flying", False)]
    origin = _point(origin)
    points = {_point(location) for location in locations}
    points = {point for point in points if all(point.distance_to(base) >= 10 for base in bases)}
    return sorted(points, key=lambda point: (min((point.distance_to(base) for base in bases), default=point.distance_to(origin)),
                                            point.distance_to(origin), point.x, point.y))


def visible_footprint(point: Point2, width: float, visible: Callable, area: Any) -> bool:
    """Sample every occupied terrain tile plus the footprint's four edges."""
    half = width / 2
    if (point.x - half < area.x or point.y - half < area.y
            or point.x + half > area.x + area.width or point.y + half > area.y + area.height):
        return False
    lo_x, hi_x = math.floor(point.x - half), math.ceil(point.x + half)
    lo_y, hi_y = math.floor(point.y - half), math.ceil(point.y + half)
    points = [Point2((x + 0.5, y + 0.5)) for x in range(lo_x, hi_x) for y in range(lo_y, hi_y)]
    points.extend(point.offset((x, y)) for x in (-half + .01, half - .01) for y in (-half + .01, half - .01))
    return all(visible(sample) for sample in points)


def _overlap(point: Point2, width: float, other: Point2, other_width: float, gap: float = 0) -> bool:
    distance = (width + other_width) / 2 + gap
    return abs(point.x - other.x) < distance and abs(point.y - other.y) < distance


def _segment_distance(point: Point2, start: Point2, end: Point2) -> float:
    dx, dy = end.x - start.x, end.y - start.y
    squared = dx * dx + dy * dy
    proportion = min(1.0, max(0.0, ((point.x - start.x) * dx + (point.y - start.y) * dy) / squared)) if squared else 0
    return point.distance_to(Point2((start.x + proportion * dx, start.y + proportion * dy)))


def site_clear(point: Point2, width: float, *, occupied: Iterable[tuple[Point2, float]] = (),
               resources: Iterable[tuple[Point2, float]] = (),
               corridors: Iterable[tuple[Point2, Point2]] = ()) -> bool:
    """Avoid occupied footprints, mining traffic and observed rally lanes."""
    if any(_overlap(point, width, other, other_width) for other, other_width in occupied):
        return False
    if any(_overlap(point, width, other, other_width, gap=.75) for other, other_width in resources):
        return False
    # Circumscribing radius is deliberately conservative for diagonal lanes.
    return all(_segment_distance(point, start, end) >= width / math.sqrt(2) + .75 for start, end in corridors)


def _layout(bot: Any) -> tuple[list, list, list, list]:
    structures = [unit for unit in getattr(bot, "structures", ()) if not getattr(unit, "is_flying", False)]
    bases = [unit for unit in structures if unit.type_id.name in BASE_TYPES]
    occupied = [(unit.position, footprint_width(unit.type_id, bot.game_data)) for unit in structures]
    minerals = [unit for unit in getattr(bot, "mineral_field", ())
                if unit.is_visible and not getattr(unit, "is_snapshot", False)]
    geysers = [unit for unit in getattr(bot, "vespene_geyser", ())
               if unit.is_visible and not getattr(unit, "is_snapshot", False)]
    resources = [(unit.position, 2.0) for unit in minerals] + [(unit.position, 3.0) for unit in geysers]
    corridors = [(base.position, resource.position) for base in bases for resource in minerals + geysers
                 if base.position.distance_to(resource.position) <= 14]
    for producer in structures:
        if producer.type_id.name not in PRODUCTION_TYPES:
            continue
        # A later depot must not consume an existing producer's addon socket.
        occupied.append((producer.position.offset((2.5, -.5)), 2.0))
        for rally in getattr(producer, "rally_targets", ()):
            if getattr(rally, "tag", None) is None:
                end = _point(rally.point)
                if producer.position.distance_to(end) > 0:
                    end = producer.position.towards(end, min(6, producer.position.distance_to(end)))
                    corridors.append((producer.position, end))
    return bases, occupied, resources, corridors


async def find_placement(bot: Any, ability: Any, kind: Any, center: Any, width: float | None = None,
                         *, candidate_filter: Callable[[Point2], bool] | None = None) -> Point2 | None:
    """Drop-in resolver for adversary.placement; no commands or forced builds."""
    width = footprint_width(kind, bot.game_data) if width is None else float(width)
    bases, occupied, resources, corridors = _layout(bot)
    if kind.name in BASE_TYPES:
        # Burnysc2 computes these once at startup from public resource positions
        # and static placement terrain. Do not call get_next_expansion(), whose
        # refreshed global pathing query could disclose fogged blockers.
        try:
            locations = getattr(bot, "expansion_locations_list", ())
        except AssertionError:
            locations = ()
        candidates = expansion_candidates(locations, bases, center)
    else:
        candidates = building_candidates(center, width)
    area = bot.game_info.playable_area
    addon = kind.name in PRODUCTION_TYPES
    viable = []
    for point in candidates:
        # Most outer-ring cells are fogged. Reject them with one local fog-map
        # lookup before computing collision lanes or every footprint sample.
        half = width / 2
        if (point.x - half < area.x or point.y - half < area.y
                or point.x + half > area.x + area.width or point.y + half > area.y + area.height
                or not bot.is_visible(point)):
            continue
        if candidate_filter is not None and not candidate_filter(point):
            continue
        if not site_clear(point, width, occupied=occupied, resources=resources, corridors=corridors):
            continue
        if not visible_footprint(point, width, bot.is_visible, area):
            continue
        if addon:
            extra = point.offset((2.5, -.5))
            if (not site_clear(extra, 2, occupied=occupied, resources=resources, corridors=corridors)
                    or not visible_footprint(extra, 2, bot.is_visible, area)):
                continue
        viable.append(point)
        if len(viable) == QUERY_BATCH:
            found = await _query(bot, ability, viable, addon)
            if found is not None:
                return found
            viable.clear()
    return await _query(bot, ability, viable, addon) if viable else None


async def _query(bot: Any, ability: Any, points: list[Point2], addon: bool) -> Point2 | None:
    main = await bot.can_place(ability, points)
    valid = [point for point, allowed in zip(points, main, strict=True) if allowed]
    if addon and valid:
        extra = await bot.can_place(AbilityId.TERRANBUILD_SUPPLYDEPOT, [point.offset((2.5, -.5)) for point in valid])
        valid = [point for point, allowed in zip(valid, extra, strict=True) if allowed]
    return valid[0] if valid else None
