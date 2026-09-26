"""Conservative mining clearance for the separate coached Protoss bot.

This filter rejects layout conflicts, not engine-illegal placements. The adapter
still requires a currently visible complete footprint and a successful live
placement query. Its escape check is local to the visible screen; it is neither
a global route proof nor a PvZ wall planner.
"""
from __future__ import annotations

import math
from collections import deque
from typing import Any, Iterable

from sc2.ids.unit_typeid import UnitTypeId as U
from sc2.position import Point2

from .adversary_placement import site_clear
from .fairplay import CAMERA_HEIGHT, CAMERA_WIDTH
from .schema import BUILD_TYPES
from .sc2_adapter import _placement_width, screen_entities


MAX_CANDIDATE_RADIUS = 10
ESCAPE_CLEARANCE = .75  # Conservative Stalker/Immortal-sized ground clearance.
THIN_POCKET_CLEARANCE = .25  # Also detect small-unit spawn pockets erased by .75 erosion.
_GROUND_PRODUCERS = {U.NEXUS, U.GATEWAY, U.WARPGATE, U.ROBOTICSFACILITY}


def _cell(point: Point2) -> tuple[int, int]:
    return round(point.x * 2), round(point.y * 2)


def _neighbors(cell):
    x, y = cell
    return ((x - 1, y), (x + 1, y), (x, y - 1), (x, y + 1))


def _covered(cell, position, width, clearance=ESCAPE_CLEARANCE):
    half = width / 2 + clearance
    return abs(cell[0] / 2 - position.x) < half and abs(cell[1] / 2 - position.y) < half


def _reachable(cells, exits):
    parents = {cell: None for cell in exits if cell in cells}
    queue = deque(parents)
    while queue:
        cell = queue.popleft()
        for neighbor in _neighbors(cell):
            if neighbor in cells and neighbor not in parents:
                parents[neighbor] = cell
                queue.append(neighbor)
    return parents


class LocalEscapeGrid:
    """Before/after connectivity over caller-provided visible pathable cells.

    Half-tile nodes and four-way edges cannot cut diagonally through building
    corners. Already disconnected space is not evidence of a new enclosure.
    No unseen terrain, orders, unit positions or global path queries are used.
    """

    def __init__(self, cells, perimeter, *, occupied=(), ground_units=(), producers=(), clearance=ESCAPE_CLEARANCE):
        self.clearance = clearance
        self.thin_pocket_grid = None
        self.cells = {_cell(point) for point in cells}
        self.cells = {cell for cell in self.cells if not any(_covered(cell, p, w, clearance) for p, w in occupied)}
        self.perimeter = {_cell(point) for point in perimeter} & self.cells
        self.evidence_status = ("visible_perimeter_comparison" if self.perimeter
                                else "unproven_no_visible_perimeter")
        self.parents = _reachable(self.cells, self.perimeter)
        self.groups = []
        self.producer_cells = set()
        for point in ground_units:
            # A real unit may be closer to rounded building corners than our
            # conservative square. Nearby free nodes anchor that sighting.
            group = {cell for cell in self.parents if math.dist((cell[0] / 2, cell[1] / 2), point) <= 1.25}
            if group:
                self.groups.append(group)
        for point, width in producers:
            group = self._portals(point, width, self.cells) & self.parents.keys()
            if group:
                self.groups.append(group)
                self.producer_cells.update(group)
        self.path_cells = set()
        for cell in self.producer_cells | {next(iter(group)) for group in self.groups}:
            while cell is not None and cell not in self.path_cells:
                self.path_cells.add(cell)
                cell = self.parents[cell]
        self.results = {}

    def _portals(self, point, width, cells):
        half = width / 2
        return {cell for cell in cells if self.clearance <= max(
            abs(cell[0] / 2 - point.x) - half, abs(cell[1] / 2 - point.y) - half) <= self.clearance + .5}

    def allows(self, point, width, *, new_producer=False):
        key = (point.x, point.y, width, new_producer)
        if key in self.results:
            return self.results[key]
        if not self.perimeter:
            # No before/after escape claim is possible here. Leave this
            # candidate to the independent layout and native placement checks.
            self.results[key] = True
            return True
        removed = {cell for cell in self.cells if _covered(cell, point, width, self.clearance)}
        if not new_producer and not removed.intersection(self.path_cells):
            self.results[key] = True
            return True
        remaining = self.cells - removed
        reachable = _reachable(remaining, self.perimeter)
        allowed = all(group & reachable.keys() for group in self.groups)
        # Surviving producer portals must not become a disconnected pocket,
        # even if its opposite side still has an exit. Covered portals can be
        # replaced by an adjacent building in an otherwise open production row.
        allowed = allowed and self.producer_cells - removed <= reachable.keys()
        if new_producer and self.perimeter:
            portals = self._portals(point, width, remaining)
            allowed = allowed and bool(portals) and portals <= reachable.keys()
        self.results[key] = bool(allowed)
        return bool(allowed)


def _escape_grid(bot, own, occupied, resources):
    """Cache one screen's sampled terrain; visibility precedes every grid read."""
    loop = getattr(getattr(bot, "state", None), "game_loop", None)
    area = getattr(getattr(bot, "game_info", None), "playable_area", None)
    pathable = getattr(bot, "in_pathing_grid", None)
    if (loop is None or area is None or not callable(pathable)
            or getattr(bot.game_info, "pathing_grid", None) is None):
        return None  # Offline geometry-only callers have no terrain observation.
    center = bot.fairplay.camera_center
    key = (int(loop), center.x, center.y)
    cached = getattr(bot, "_coach_placement_escape_grid", None)
    if cached is not None and cached[0] == key:
        return cached[1]
    left = math.ceil(max(area.x + ESCAPE_CLEARANCE, center.x - CAMERA_WIDTH / 2 + 1) * 2)
    right = math.floor(min(area.x + area.width - ESCAPE_CLEARANCE, center.x + CAMERA_WIDTH / 2 - 1) * 2)
    bottom = math.ceil(max(area.y + ESCAPE_CLEARANCE, center.y - CAMERA_HEIGHT / 2 + 1) * 2)
    top = math.floor(min(area.y + area.height - ESCAPE_CLEARANCE, center.y + CAMERA_HEIGHT / 2 - 1) * 2)
    sampled = {}

    def clear(point):
        # Cache exact samples only within this native observation. A visibility
        # boundary is not treated as a passable exit or queried through fog.
        value = (point.x, point.y)
        if value not in sampled:
            sampled[value] = bool(area.x <= point.x < area.x + area.width
                and area.y <= point.y < area.y + area.height
                and bot.fairplay.on_screen(point) and bot.is_visible(point) and pathable(point))
        return sampled[value]

    radii = (ESCAPE_CLEARANCE, THIN_POCKET_CLEARANCE)
    cells, perimeter = {radius: [] for radius in radii}, {radius: [] for radius in radii}
    for x in range(left, right + 1):
        for y in range(bottom, top + 1):
            point = Point2((x / 2, y / 2))
            for radius in radii:
                if all(clear(point.offset((dx, dy))) for dx in (-radius, 0, radius)
                       for dy in (-radius, 0, radius)):
                    cells[radius].append(point)
                    if x in {left, right} or y in {bottom, top}:
                        perimeter[radius].append(point)
    # Workers can vacate a footprint while constructing it. Mining corridors
    # already protect their economic access; army units need persistent exits.
    ground = [unit.position for unit in own if not unit.is_structure and not unit.is_flying
              and unit.type_id not in {U.PROBE, U.SCV, U.DRONE, U.MULE}
              and not getattr(unit, "is_hallucination", False)]
    producers = [(unit.position, _placement_width(bot, U.GATEWAY if unit.type_id == U.WARPGATE else unit.type_id))
                 for unit in own if unit.is_structure and unit.type_id in _GROUND_PRODUCERS and not unit.is_flying]
    grids = [LocalEscapeGrid(cells[radius], perimeter[radius], occupied=tuple(occupied) + tuple(resources),
                              ground_units=ground, producers=producers, clearance=radius) for radius in radii]
    grid = grids[0]
    grid.thin_pocket_grid = grids[1]
    bot._coach_placement_escape_grid = (key, grid)
    return grid


def candidate_points(kind: U | None, center: Point2, width: float) -> list[Point2]:
    """Propose every one-tile building center within ten tiles of this view.

    Only immutable geometry is used here. Each proposal still needs the
    adapter's full visible footprint, mining clearance and live engine query.
    Existing dedicated expansion, gas and unit warp-in searches stay unchanged.
    """
    if kind is None or kind.name not in BUILD_TYPES or kind in {U.NEXUS, U.ASSIMILATOR}:
        return []
    if (not math.isfinite(width) or width <= 0
            or not all(math.isfinite(value) for value in center)):
        raise ValueError("Placement proposals require a finite center and positive footprint")
    offset = .5 if round(width) % 2 else 0.0
    radius = MAX_CANDIDATE_RADIUS
    points = [Point2((x + offset, y + offset))
              for x in range(math.ceil(center.x - radius - offset), math.floor(center.x + radius - offset) + 1)
              for y in range(math.ceil(center.y - radius - offset), math.floor(center.y + radius - offset) + 1)]
    points = [point for point in points if point.distance_to(center) <= radius]
    return sorted(points, key=lambda point: (point.distance_to(center), point.x, point.y))


def layout_allowed(point: Point2, width: float, *,
                   structures: Iterable[tuple[Point2, float]] = (),
                   resources: Iterable[tuple[Point2, float]] = (),
                   bases: Iterable[Point2] = (),
                   expansions: Iterable[Point2] = (),
                   expansion_width: float = 5.0) -> bool:
    """Pure geometry over caller-supplied current observations/public sites."""
    resources = tuple(resources)
    occupied = list(structures) + [(position, expansion_width) for position in expansions]
    corridors = [(base, resource) for base in bases for resource, _ in resources
                 if base.distance_to(resource) <= 14]
    return site_clear(point, width, occupied=occupied, resources=resources, corridors=corridors)


def candidate_allowed(bot: Any, kind: U | None, point: Point2, width: float) -> bool:
    """Coach-only adapter hook; never inspect hidden orders or resource amounts.

    Townhalls and gas have their own placement rules. Unit warp-ins likewise
    retain their normal tactical placement rather than reserving mining lanes.
    """
    if kind is None or kind.name not in BUILD_TYPES or kind in {U.NEXUS, U.ASSIMILATOR}:
        return True
    own, _ = screen_entities(bot)
    structures = [unit for unit in own if unit.is_structure and not unit.is_flying
                  and bot.is_visible(unit.position)]
    # Warp Gate is a morph of the placed Gateway; its morph ability may expose
    # zero placement radius. Use the public Gateway construction footprint.
    occupied = [(unit.position, _placement_width(bot, U.GATEWAY if unit.type_id == U.WARPGATE
                                                 else unit.type_id)) for unit in structures]
    bases = [unit.position for unit in structures if unit.type_id == U.NEXUS]
    resources = [(unit.position, _placement_width(bot, U.ASSIMILATOR))
                 for unit in structures if unit.type_id == U.ASSIMILATOR]
    for group, resource_width in ((bot.mineral_field, 2.0), (bot.vespene_geyser, 3.0)):
        for unit in group:
            # Snapshot positions, hidden resource contents and old orders are
            # not read. Neutral footprint sizes are conservative map geometry.
            if (unit.is_visible and not getattr(unit, "is_snapshot", False)
                    and bot.fairplay.on_screen(unit) and bot.is_visible(unit.position)):
                resources.append((unit.position, resource_width))
    if not layout_allowed(point, width, structures=occupied, resources=resources,
                          bases=bases, expansions=getattr(bot, "_public_sites", ()),
                          expansion_width=_placement_width(bot, U.NEXUS)):
        return False
    grid = _escape_grid(bot, own, occupied, resources)
    if grid is None:
        return True
    guards = (grid, grid.thin_pocket_grid)
    if not any(guard.perimeter for guard in guards):
        # No terrain proof must not authorize another tight packing decision.
        # The ordinary coached layout leaves two tiles between buildings when
        # both local graphs are unproven. This is spacing, not a route proof.
        return all(abs(point.x - other.x) >= (width + other_width) / 2 + 2
                   or abs(point.y - other.y) >= (width + other_width) / 2 + 2
                   for other, other_width in occupied)
    return all(guard.allows(point, width, new_producer=kind in _GROUND_PRODUCERS) for guard in guards)
