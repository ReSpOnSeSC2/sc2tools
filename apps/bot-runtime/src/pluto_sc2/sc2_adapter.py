"""Protoss learned macro actions over camera-limited SC2 observations.

The policy selects strategic unit actions. Bounded runtime guidance can return
the camera to previously observed production and briefly mask camera departure.
Those paid inputs are recorded separately from policy decisions. All input goes
through the fair-play controller; no debug state changes or scripted builds are used.
"""
from __future__ import annotations

from collections import Counter
from dataclasses import dataclass
import math
from typing import Any

import numpy as np
from sc2.bot_ai import BotAI
from sc2.data import Race, Result
from sc2.dicts.unit_research_abilities import RESEARCH_INFO
from sc2.dicts.unit_train_build_abilities import TRAIN_INFO
from sc2.ids.ability_id import AbilityId
from sc2.ids.unit_typeid import UnitTypeId
from sc2.ids.upgrade_id import UpgradeId
from sc2.position import Point2

from .fairplay import CAMERA_HEIGHT, CAMERA_WIDTH
from .economic_forfeit import EconomicForfeitGuard
from .learning import Policy, Transition
from .reward_observation import RewardCollector
from .worker_scout import WorkerScoutLease
from .production_attention import ProductionAttention
from .schema import (
    ACTION_NAMES, ACTION_TO_INDEX, BASE_OBSERVATION_SIZE, BUILD_TYPES,
    ENEMY_ROLE_NAMES, GRID_CHANNELS, GRID_SIZE, HISTORY_LENGTH, OWN_TYPE_NAMES,
    RESEARCH_UPGRADES, SCALAR_NAMES, TRAIN_TYPES, ObservationStack,
)

WORKER_TYPES = {UnitTypeId.PROBE, UnitTypeId.SCV, UnitTypeId.DRONE, UnitTypeId.MULE}
TRAIN_IDS = {name: UnitTypeId[name] for name in TRAIN_TYPES}
BUILD_IDS = {name: UnitTypeId[name] for name in BUILD_TYPES}
UPGRADE_IDS = {name: UpgradeId[name] for name in RESEARCH_UPGRADES}
CONTROL_PROFILE = "protoss-scout-recovery-v1"


def _screen(bot: Any, item: Any) -> bool:
    controller = getattr(bot, "fairplay", None)
    if controller is None:
        raise RuntimeError("Camera-restricted observation requires a FairPlayController")
    return bool(controller.on_screen(item))


def screen_entities(bot: Any) -> tuple[list[Any], list[Any]]:
    """Own entities and detectable, visible enemies inside the current viewport."""
    own = [u for u in (*bot.units, *bot.structures) if _screen(bot, u)]
    enemies = [
        u for u in (*bot.enemy_units, *bot.enemy_structures)
        if u.is_visible and not getattr(u, "is_snapshot", False)
        and (not u.is_cloaked or u.is_revealed) and _screen(bot, u)
    ]
    return own, enemies


def _point(item: Any) -> Point2:
    return item.position if hasattr(item, "position") else item


def _normalized_position(bot: Any, point: Any) -> tuple[float, float]:
    area = bot.game_info.playable_area
    position = _point(point)
    return (
        float(np.clip((position.x - area.x) / max(area.width, 1), 0, 1)),
        float(np.clip((position.y - area.y) / max(area.height, 1), 0, 1)),
    )


def _is_army(unit: Any) -> bool:
    return not unit.is_structure and unit.type_id not in WORKER_TYPES


def _order_details(unit: Any, game_data: Any = None) -> list[tuple[set[int], Any, float]]:
    """Read current orders without Burnysc2's strict ability-data lookup.

    Some real replay observations contain reserved NULL_NULL (4135) orders that
    are absent from GameData. Preserve those raw IDs as unknown/busy rather than
    resolving Unit.orders, which raises KeyError for the whole observation.
    """
    proto = getattr(unit, "_proto", None)
    details = []
    if proto is not None:
        for order in proto.orders:
            ids = {int(order.ability_id)}
            ability = game_data.abilities.get(int(order.ability_id)) if game_data is not None else None
            if ability is not None:
                ids.update(int(value.value) for value in (ability.id, ability.exact_id))
            details.append((ids, int(order.target_unit_tag) or None, float(order.progress)))
    else:
        # Lightweight observation adapters/test doubles may already have parsed
        # orders. Actual SC2 Unit instances always use the raw path above.
        for order in unit.orders:
            ability = getattr(order, "ability", None)
            ids = {value.value for value in (ability.id, ability.exact_id)} if ability is not None else set()
            details.append((ids, getattr(order, "target", None), float(getattr(order, "progress", 0))))
    return details


def encode_observation(bot: Any) -> np.ndarray:
    """Fixed base frame. Tactical fields describe the screen, never hidden raw state.

    The economy/supply/time fields are ordinary human HUD information. Unit count,
    saturation, research progress, health and spatial channels use screen entities
    only. Enemy start coordinates are the map's public possible starting location,
    not an observation of the opponent. Camera memory is based on past screens.
    """
    own, enemies = screen_entities(bot)
    army = [u for u in own if _is_army(u)]
    workers = [u for u in own if u.type_id == UnitTypeId.PROBE]
    bases = [u for u in own if u.type_id == UnitTypeId.NEXUS and u.is_ready]
    gas = [u for u in own if u.type_id == UnitTypeId.ASSIMILATOR and u.is_ready]
    if army:
        bot._pluto_last_army_position = Point2((
            sum(u.position.x for u in army) / len(army),
            sum(u.position.y for u in army) / len(army),
        ))
    start = _normalized_position(bot, bot.start_location)
    enemy_start = _normalized_position(bot, bot.enemy_start_locations[0] if bot.enemy_start_locations else bot.game_info.map_center)
    camera = _normalized_position(bot, bot.fairplay.camera_center)
    opponent = next((p for p in getattr(bot.game_info, "players", []) if p.id != getattr(bot, "player_id", None) and hasattr(p, "race")), None)
    requested_race = opponent.race if opponent is not None else Race.Random
    race = getattr(bot, "_pluto_known_enemy_race", requested_race)
    if race == Race.Random and enemies:
        race = getattr(enemies[0], "race", Race.Random)
    bot._pluto_known_enemy_race = race
    health = sum(u.health for u in army) / max(1, sum(u.health_max for u in army))
    shields = sum(u.shield for u in army) / max(1, sum(u.shield_max for u in army))
    # APM availability is a controller budget signal, not hidden game information.
    apm_budget = float(bot.fairplay.can_issue(float(bot.time)))
    scalars = np.array([
        bot.time / 1800, bot.minerals / 2000, bot.vespene / 2000,
        bot.supply_used / 200, bot.supply_cap / 200, bot.supply_army / 200,
        bot.supply_workers / 80, bot.supply_left / 200,
        sum(u.is_idle for u in workers) / 80, health, shields,
        len(bases) / 10, sum(u.is_structure and u.is_idle for u in own) / 30,
        sum(u.assigned_harvesters for u in bases) / max(1, sum(u.ideal_harvesters for u in bases)),
        sum(u.assigned_harvesters for u in gas) / max(1, sum(u.ideal_harvesters for u in gas)),
        *start, *enemy_start, float(race == Race.Terran), float(race == Race.Zerg),
        float(race == Race.Protoss), float(race == Race.Random), len(enemies) / 100,
        *camera, apm_budget,
    ], dtype=np.float32)
    assert len(scalars) == len(SCALAR_NAMES)
    ready_counts = Counter(u.type_id.name for u in own if u.is_ready)
    unfinished = Counter(u.type_id.name for u in own if not u.is_ready)
    counts = np.array([ready_counts[n] / 20 for n in OWN_TYPE_NAMES] + [unfinished[n] / 20 for n in OWN_TYPE_NAMES], dtype=np.float32)
    # Research progress is visible on-screen production orders. No global upgrades
    # set or pending-unit count enters the observation.
    progress = np.zeros(len(RESEARCH_UPGRADES), dtype=np.float32)
    for unit in own:
        for index, name in enumerate(RESEARCH_UPGRADES):
            info = RESEARCH_INFO.get(unit.type_id, {}).get(UPGRADE_IDS[name])
            if info:
                for ability_ids, _target, fraction in _order_details(unit, bot.game_data):
                    if info["ability"].value in ability_ids:
                        progress[index] = max(progress[index], fraction)
    roles = np.zeros(len(ENEMY_ROLE_NAMES), dtype=np.float32)
    for unit in enemies:
        roles[0] += unit.type_id in WORKER_TYPES
        roles[1] += _is_army(unit) and not unit.is_flying
        roles[2] += _is_army(unit) and unit.is_flying
        roles[3] += unit.is_structure
        roles[4] += unit.is_detector
        roles[5] += unit.is_cloaked
        roles[6] += unit.ground_dps / 10
        roles[7] += unit.air_dps / 10
    roles /= 50
    grid = np.zeros((GRID_CHANNELS, GRID_SIZE, GRID_SIZE), dtype=np.float32)
    for unit in own + enemies:
        if unit in own:
            channel = 0 if unit.type_id in WORKER_TYPES else 1 if unit.is_structure else 2 if unit.is_flying else 3
        else:
            channel = 4 if unit.is_structure else 5
        # Camera-relative grid retains useful tactical distances on large maps.
        center = bot.fairplay.camera_center
        x = float(np.clip((unit.position.x - center.x) / CAMERA_WIDTH + 0.5, 0, 1))
        y = float(np.clip((unit.position.y - center.y) / CAMERA_HEIGHT + 0.5, 0, 1))
        grid[channel, min(GRID_SIZE - 1, int(y * GRID_SIZE)), min(GRID_SIZE - 1, int(x * GRID_SIZE))] += 0.1
    observation = np.clip(np.concatenate((scalars, counts, progress, roles, grid.ravel())), 0, 5).astype(np.float32)
    if observation.shape != (BASE_OBSERVATION_SIZE,) or not np.isfinite(observation).all():
        raise ValueError("Invalid SC2 observation: non-finite values or schema mismatch")
    return observation


@dataclass(frozen=True)
class ActionIntent:
    sources: tuple[Any, ...] = ()
    ability: AbilityId | None = None
    target: Any = None
    minimap: bool = False
    camera: Point2 | None = None


def _clamp_point(bot: Any, point: Point2) -> Point2:
    area = bot.game_info.playable_area
    return Point2((
        min(max(point.x, area.x + 0.5), area.x + area.width - 0.5),
        min(max(point.y, area.y + 0.5), area.y + area.height - 0.5),
    ))


def _same_type_group(units: list[Any]) -> list[Any]:
    if not units:
        return []
    counts = Counter(u.type_id for u in units)
    chosen = max(counts, key=lambda kind: (counts[kind], -kind.value))
    return sorted((u for u in units if u.type_id == chosen), key=lambda u: u.tag)


def _harvest_assignment(worker: Any, mineral_tags: set[int], gas_tags: set[int]) -> str | None:
    """Identify a visible probe's resource job, including its return trip.

    A worker returning cargo targets a Nexus instead of a resource. Cargo flags
    distinguish that part of the cycle without consulting off-screen units.
    """
    details = _order_details(worker)
    harvest_abilities = {ability.value for ability in (
        AbilityId.SMART, AbilityId.HARVEST_GATHER, AbilityId.HARVEST_GATHER_PROBE,
        AbilityId.HARVEST_RETURN, AbilityId.HARVEST_RETURN_PROBE,
    )}
    if any(ids and ids.isdisjoint(harvest_abilities) for ids, _target, _progress in details):
        return None  # Unknown or unrelated busy orders must never cause retasking.
    if getattr(worker, "is_carrying_vespene", False):
        return "gas"
    if getattr(worker, "is_carrying_minerals", False):
        return "minerals"
    for _ids, target, _progress in details:
        if isinstance(target, (int, np.integer)):
            if target in gas_tags:
                return "gas"
            if target in mineral_tags:
                return "minerals"
    return None


def _harvest_worker(workers: list[Any], resource: str, targets: list[Any],
                    assignments: dict[int, str | None]) -> Any | None:
    # Reassign idle workers or workers on the other resource. Do not repeatedly
    # command an already-assigned worker or interrupt an unrelated build/scout.
    other_resource = "gas" if resource == "minerals" else "minerals"
    candidates = [u for u in workers if u.is_idle or assignments[u.tag] == other_resource]
    if not candidates or not targets:
        return None
    return min(candidates, key=lambda u: (
        not u.is_idle,
        bool(getattr(u, "is_carrying_minerals", False) or getattr(u, "is_carrying_vespene", False)),
        min(u.distance_to(target) for target in targets), u.tag,
    ))


_BUILD_WIDTHS = {name: (5 if name == "NEXUS" else 2 if name in {"PYLON", "DARKSHRINE", "PHOTONCANNON", "SHIELDBATTERY"} else 3) for name in BUILD_TYPES}


def _placement_width(bot: Any, kind: UnitTypeId | None) -> float:
    if kind is None or kind.name not in _BUILD_WIDTHS:
        return 1.0  # Conservative one-tile footprint for a unit warp-in.
    data = bot.game_data.units.get(kind.value)
    radius = getattr(data, "footprint_radius", None)
    return float(2 * radius) if radius is not None and radius > 0 else float(_BUILD_WIDTHS[kind.name])


def _footprint_points(position: Point2, width: float) -> list[Point2]:
    """World tile centers covered by a placement footprint, plus its four edges."""
    half = width / 2
    xs = range(int(np.floor(position.x - half)), int(np.ceil(position.x + half)))
    ys = range(int(np.floor(position.y - half)), int(np.ceil(position.y + half)))
    tiles = [Point2((x + 0.5, y + 0.5)) for x in xs for y in ys]
    return tiles + [position.offset((dx, dy)) for dx, dy in (
        (-half + .01, -half + .01), (-half + .01, half - .01),
        (half - .01, -half + .01), (half - .01, half - .01),
    )]


def _visible_footprint(bot: Any, position: Point2, width: float) -> bool:
    # A camera rectangle can contain fog. Never send a placement query that
    # could disclose whether a hidden enemy structure blocks any footprint tile.
    return all(_screen(bot, point) and point == _clamp_point(bot, point) and bot.is_visible(point)
               for point in _footprint_points(position, width))


def _power_pixel(bot: Any, point: Point2) -> bool | None:
    """Read the current screen's power overlay, if the observer supplies it."""
    observation = getattr(bot.state, "observation", None)
    layers = getattr(getattr(observation, "feature_layer_data", None), "renders", None)
    image = getattr(layers, "power", None)
    if image is None or not image.data:
        return None
    key = (int(bot.state.game_loop), id(observation))
    cached = getattr(bot, "_pluto_power_pixels", None)
    if cached is None or cached[0] != key:
        width, height, bits = image.size.x, image.size.y, image.bits_per_pixel
        if width <= 0 or height <= 0 or bits not in {1, 8, 16, 32}:
            return None
        if bits == 1:
            pixels = np.unpackbits(np.frombuffer(image.data, dtype=np.uint8))[:width * height]
        else:
            pixels = np.frombuffer(image.data, dtype={8: np.uint8, 16: np.dtype("<u2"), 32: np.dtype("<u4")}[bits])
        if pixels.size != width * height:
            return None
        cached = (key, pixels.reshape(height, width))
        bot._pluto_power_pixels = cached
    pixels = cached[1]
    center = bot.fairplay.camera_center
    x = int((.5 + (point.x - center.x) / CAMERA_WIDTH) * pixels.shape[1])
    y = int((.5 - (point.y - center.y) / CAMERA_HEIGHT) * pixels.shape[0])
    return bool(pixels[y, x]) if 0 <= y < pixels.shape[0] and 0 <= x < pixels.shape[1] else False


def _replay_placement_allowed(bot: Any, position: Point2, kind: UnitTypeId, *, source: Any = None, geyser: Any = None) -> bool:
    """Conservative current-screen approximation for unsupported observer queries.

    Replay observer placement RPCs return Error even at valid points. This path
    checks public terrain only inside a visible footprint, current creep, visible
    occupants and the current power overlay. It never uses future commands to
    make an action legal. It can under/over-approximate engine placement rules;
    live participants always use the engine query instead.
    """
    width = _placement_width(bot, kind)
    if not _visible_footprint(bot, position, width):
        return False
    points = _footprint_points(position, width)
    is_gas = kind == UnitTypeId.ASSIMILATOR
    if is_gas and (geyser is None or not _screen(bot, geyser) or geyser.position != position):
        return False
    is_building = kind.name in _BUILD_WIDTHS
    terrain = bot.game_info.placement_grid if is_building else bot.game_info.pathing_grid
    for point in points:
        tile = (int(point.x), int(point.y))
        if not is_gas and not terrain[tile]:
            return False
        if bot.state.creep[tile]:
            return False
    own, enemies = screen_entities(bot)
    visible_minerals = [u for u in bot.mineral_field if _screen(bot, u)]
    visible_geysers = [u for u in bot.vespene_geyser if _screen(bot, u)]
    occupants = own + enemies + visible_minerals + visible_geysers + [u for group in (
        getattr(bot, "destructables", ()), getattr(bot, "watchtowers", ())) for u in group if _screen(bot, u)]
    excluded_tags = {getattr(source, "tag", None), getattr(geyser, "tag", None)}
    for occupant in occupants:
        if occupant.tag in excluded_tags or getattr(occupant, "is_flying", False):
            continue
        radius = getattr(occupant, "footprint_radius", None) or getattr(occupant, "radius", .75)
        dx = max(abs(occupant.position.x - position.x) - width / 2, 0)
        dy = max(abs(occupant.position.y - position.y) - width / 2, 0)
        if dx * dx + dy * dy < radius * radius:
            return False
    if kind == UnitTypeId.NEXUS:
        # Resource clearance is another current-screen check, not a lookup of
        # hidden/global expansion locations.
        if any(position.distance_to(u) < 6 for u in visible_minerals + visible_geysers):
            return False
    needs_power = kind not in {UnitTypeId.NEXUS, UnitTypeId.PYLON, UnitTypeId.ASSIMILATOR}
    if needs_power:
        powered = _power_pixel(bot, position)
        if powered is not None:
            return powered
        # If the overlay is absent, use only power sources whose owning ready
        # pylon/prism is on this screen; hidden source positions/radii are unread.
        visible_sources = {u.tag for u in own if u.is_ready and u.type_id in {UnitTypeId.PYLON, UnitTypeId.WARPPRISMPHASING}}
        sources = getattr(getattr(bot.state, "psionic_matrix", None), "sources", ())
        for power in sources:
            if power.unit_tag not in visible_sources:
                continue
            source_tile = (int(power.position.x), int(power.position.y))
            target_tile = (int(position.x), int(position.y))
            if power.covers(position) and bot.game_info.terrain_height[target_tile] <= bot.game_info.terrain_height[source_tile]:
                return True
        return False
    return True


async def _placement(bot: Any, ability: AbilityId, preferred: Point2 | None = None,
                     *, unit_type: UnitTypeId | None = None, source: Any = None) -> Point2 | None:
    """Use exact live queries or a declared replay-only visible-screen approximation."""
    if unit_type is None and ability.name.startswith("PROTOSSBUILD_"):
        unit_type = BUILD_IDS.get(ability.name.removeprefix("PROTOSSBUILD_"))
    width = _placement_width(bot, unit_type)
    center = preferred or bot.fairplay.camera_center
    candidates = [center]
    for radius in (2, 4, 6, 8, 10):
        candidates.extend(Point2((center.x + dx, center.y + dy)) for dx, dy in (
            (radius, 0), (-radius, 0), (0, radius), (0, -radius),
            (radius, radius), (radius, -radius), (-radius, radius), (-radius, -radius),
        ))
    proposal_hook = getattr(bot, "placement_candidate_points", None)
    if callable(proposal_hook):
        candidates.extend(proposal_hook(unit_type, center, width))
    if unit_type is not None and unit_type.name in _BUILD_WIDTHS:
        offset = .5 if round(width) % 2 else 0.0
        candidates = [Point2((np.floor(p.x) + offset, np.floor(p.y) + offset)) for p in candidates]
    if callable(proposal_hook):
        candidates = list(dict.fromkeys(candidates))
    candidates = [p for p in candidates if _visible_footprint(bot, p, width)]
    placement_filter = getattr(bot, "placement_candidate_allowed", None)
    if callable(placement_filter):
        candidates = [p for p in candidates if placement_filter(unit_type, p, width)]
    if not candidates:
        return None
    if getattr(bot, "_pluto_replay_mode", False):
        if unit_type is None:
            return None
        return next((p for p in candidates if _replay_placement_allowed(bot, p, unit_type, source=source)), None)
    valid = await bot.can_place(ability, candidates)
    return next((p for p, allowed in zip(candidates, valid, strict=True) if allowed), None)


async def legal_action_mask(bot: Any) -> np.ndarray:
    """Build a legality mask and concrete intents from the same camera observation.

    All ability queries use on-screen own units. Placements and direct targets are
    camera restricted; explicit map move/attack and camera actions use public map
    coordinates. Availability queries include resources, tech and cooldowns.
    """
    intents: dict[int, ActionIntent] = {ACTION_TO_INDEX["no_op"]: ActionIntent()}
    mask = np.zeros(len(ACTION_NAMES), dtype=np.bool_)
    mask[0] = True
    bot._pluto_action_context = intents
    if not bot.fairplay.can_issue(float(bot.time)) or bot.fairplay.pending:
        return mask
    own, enemies = screen_entities(bot)
    ready = [u for u in own if u.is_ready]
    selectable = [u for u in ready if bot.fairplay.source_available(u, float(bot.time))]
    queried = await bot.get_available_abilities(selectable, ignore_resource_requirements=False) if selectable else []
    abilities = {u.tag: set(a) for u, a in zip(selectable, queried, strict=True)}

    def available(unit: Any, ability: AbilityId) -> bool:
        data = bot.game_data.abilities.get(ability.value)
        canonical = data.id if data is not None else ability
        return ability in abilities.get(unit.tag, set()) or canonical in abilities.get(unit.tag, set())

    def matching(ability: AbilityId, units: list[Any] = ready) -> list[Any]:
        return [u for u in units if available(u, ability)]

    def add(name: str, sources: list[Any], ability: AbilityId, target: Any = None, *, minimap: bool = False) -> None:
        if sources:
            intents[ACTION_TO_INDEX[name]] = ActionIntent(tuple(sources), ability, target, minimap)

    workers = [u for u in ready if u.type_id == UnitTypeId.PROBE]
    harvesters = matching(AbilityId.HARVEST_GATHER, workers)
    # The exact probe gather ability can be returned by older game builds.
    harvest_ability = AbilityId.HARVEST_GATHER
    if not harvesters:
        harvest_ability = AbilityId.HARVEST_GATHER_PROBE
        harvesters = matching(harvest_ability, workers)
    minerals = [u for u in bot.mineral_field if _screen(bot, u) and u.mineral_contents > 0]
    gas_structures = [u for u in ready if u.type_id == UnitTypeId.ASSIMILATOR]
    gas = [u for u in gas_structures if u.vespene_contents > 0 and u.assigned_harvesters < u.ideal_harvesters]
    mineral_tags, gas_tags = {u.tag for u in minerals}, {u.tag for u in gas_structures}
    assignments = {u.tag: _harvest_assignment(u, mineral_tags, gas_tags) for u in harvesters}
    worker = _harvest_worker(harvesters, "minerals", minerals, assignments)
    if worker is not None:
        add("harvest_minerals", [worker], harvest_ability, min(minerals, key=lambda m: worker.distance_to(m)))
    worker = _harvest_worker(harvesters, "gas", gas, assignments)
    if worker is not None:
        add("harvest_gas", [worker], harvest_ability, min(gas, key=lambda g: worker.distance_to(g)))
    placement_source_filter = getattr(bot, "placement_source_allowed", None)
    for name, kind in BUILD_IDS.items():
        data = bot.game_data.units.get(kind.value)
        if data is None or data.creation_ability is None or not bot.can_afford(kind):
            continue
        ability = data.creation_ability.id
        builders = matching(ability, workers)
        if callable(placement_source_filter):
            builders = [unit for unit in builders if placement_source_filter(unit)]
        if not builders:
            continue
        target: Any = None
        if kind == UnitTypeId.ASSIMILATOR:
            geysers = [g for g in bot.vespene_geyser if _screen(bot, g) and not any(s.distance_to(g) < 1 for s in own if s.is_structure)]
            for geyser in sorted(geysers, key=lambda g: g.tag):
                if not _visible_footprint(bot, geyser.position, _placement_width(bot, kind)):
                    continue
                valid_gas = (_replay_placement_allowed(bot, geyser.position, kind, source=builders[0], geyser=geyser)
                             if getattr(bot, "_pluto_replay_mode", False) else await bot.can_place_single(ability, geyser.position))
                if valid_gas:
                    target = geyser
                    break
        else:
            target = await _placement(bot, ability, unit_type=kind, source=builders[0])
        if target is not None:
            add(f"build_{name.lower()}", [min(builders, key=lambda u: u.distance_to(target))], ability, target)
    for name, kind in TRAIN_IDS.items():
        if not bot.can_afford(kind) or not bot.can_feed(kind):
            continue
        for producer in sorted(ready, key=lambda u: u.tag):
            info = TRAIN_INFO.get(producer.type_id, {}).get(kind)
            if not info or not producer.is_idle or not available(producer, info["ability"]):
                continue
            target = None
            if info.get("requires_placement_position"):
                target = await _placement(bot, info["ability"], unit_type=kind, source=producer)
                if target is None:
                    continue
            add(f"train_{name.lower()}", [producer], info["ability"], target)
            break
    for name, upgrade in UPGRADE_IDS.items():
        if not bot.can_afford(upgrade) or upgrade in bot.state.upgrades:
            continue
        for producer in sorted(ready, key=lambda u: u.tag):
            info = RESEARCH_INFO.get(producer.type_id, {}).get(upgrade)
            if info and info.get("required_upgrade") is not None and info["required_upgrade"] not in bot.state.upgrades:
                continue
            if info and producer.is_idle and available(producer, info["ability"]):
                add(f"research_{name.lower()}", [producer], info["ability"])
                break
    simple = {
        "morph_warpgate": AbilityId.MORPH_WARPGATE,
        "morph_gateway": AbilityId.MORPH_GATEWAY,
        "phase_warpprism": AbilityId.MORPH_WARPPRISMPHASINGMODE,
        "unphase_warpprism": AbilityId.MORPH_WARPPRISMTRANSPORTMODE,
        "guardian_shield": AbilityId.GUARDIANSHIELD_GUARDIANSHIELD,
        "oracle_beam_on": AbilityId.BEHAVIOR_PULSARBEAMON,
        "oracle_beam_off": AbilityId.BEHAVIOR_PULSARBEAMOFF,
        "voidray_alignment": AbilityId.EFFECT_VOIDRAYPRISMATICALIGNMENT,
    }
    for name, ability in simple.items():
        choices = matching(ability)
        if choices:
            add(name, [min(choices, key=lambda u: u.tag)], ability)
    combat = [u for u in ready if _is_army(u) and u.can_attack]
    attack = matching(AbilityId.ATTACK_ATTACK, combat)
    move = matching(AbilityId.MOVE_MOVE, [u for u in ready if _is_army(u)])
    enemy_start = bot.enemy_start_locations[0] if bot.enemy_start_locations else bot.game_info.map_center
    add("attack_enemy_base", _same_type_group(attack), AbilityId.ATTACK_ATTACK, enemy_start, minimap=True)
    add("retreat", _same_type_group(move), AbilityId.MOVE_MOVE, bot.start_location, minimap=True)
    add("defend", _same_type_group(attack), AbilityId.ATTACK_ATTACK, bot.start_location, minimap=True)
    # A direct unit attack is legal only for units able to hit that target layer.
    for target in sorted(enemies, key=lambda u: (u.health + u.shield, u.tag)):
        eligible = [u for u in attack if (u.can_attack_air if target.is_flying else u.can_attack_ground)]
        if eligible and target.can_be_attacked:
            add("attack_visible_enemy", _same_type_group(eligible), AbilityId.ATTACK_ATTACK, target)
            break
    scouts = matching(AbilityId.MOVE_MOVE, [u for u in ready if u.type_id in {UnitTypeId.PROBE, UnitTypeId.OBSERVER, UnitTypeId.WARPPRISM}])
    lease = getattr(bot, "_worker_scout_lease", None)
    scout = lease.choose(scouts) if lease is not None else min(scouts, key=lambda u: u.tag, default=None)
    if scout is not None:
        add("scout", [scout], AbilityId.MOVE_MOVE, enemy_start, minimap=True)
    for stalker in matching(AbilityId.EFFECT_BLINK_STALKER):
        target = _clamp_point(bot, stalker.position.towards(bot.start_location, min(8, stalker.distance_to(bot.start_location))))
        # The camera may include fog: querying its refreshed pathing grid there
        # could disclose an unseen blocker through this action's legal-mask bit.
        if _screen(bot, target) and bot.is_visible(target) and bot.in_pathing_grid(target):
            add("blink_retreat", [stalker], AbilityId.EFFECT_BLINK_STALKER, target)
            break
    spells = (("psionic_storm", AbilityId.PSISTORM_PSISTORM, 9), ("force_field", AbilityId.FORCEFIELD_FORCEFIELD, 9), ("purification_nova", AbilityId.EFFECT_PURIFICATIONNOVA, 9))
    for name, ability, maximum_range in spells:
        for caster in matching(ability):
            targets = [e for e in enemies if not e.is_structure and caster.distance_to(e) <= maximum_range and (name == "psionic_storm" or not e.is_flying)]
            if targets:
                target = max(targets, key=lambda e: sum(e.distance_to(other) <= 2 for other in targets))
                add(name, [caster], ability, target.position)
                break
    for caster in matching(AbilityId.FEEDBACK_FEEDBACK):
        targets = [e for e in enemies if e.energy > 0 and e.can_be_attacked and caster.distance_to(e) <= 10 and not e.is_structure]
        if targets:
            add("feedback", [caster], AbilityId.FEEDBACK_FEEDBACK, max(targets, key=lambda e: e.energy))
            break
    for nexus in matching(AbilityId.EFFECT_CHRONOBOOSTENERGYCOST):
        targets = [s for s in ready if s.is_structure and any(
            any(ability_id in bot.game_data.abilities for ability_id in ids)
            for ids, _target, _progress in _order_details(s, bot.game_data)
        )]
        if targets:
            add("chrono_boost", [nexus], AbilityId.EFFECT_CHRONOBOOSTENERGYCOST, min(targets, key=lambda s: s.tag))
            break
    templars = matching(AbilityId.MORPH_ARCHON, [u for u in ready if u.type_id in {UnitTypeId.HIGHTEMPLAR, UnitTypeId.DARKTEMPLAR}])
    same_templars = _same_type_group(templars)
    if len(same_templars) >= 2:
        add("morph_archon", same_templars[:2], AbilityId.MORPH_ARCHON)
    center = bot.fairplay.camera_center
    camera_targets = {
        "camera_home": bot.start_location,
        "camera_army": getattr(bot, "_pluto_last_army_position", bot.start_location),
        "camera_enemy_start": enemy_start,
        "camera_north": center.offset((0, 10)), "camera_south": center.offset((0, -10)),
        "camera_east": center.offset((18, 0)), "camera_west": center.offset((-18, 0)),
    }
    for name, target in camera_targets.items():
        target = _clamp_point(bot, target)
        if bot.fairplay.camera_would_move(bot, target):
            intents[ACTION_TO_INDEX[name]] = ActionIntent(camera=target)
    for index in intents:
        mask[index] = True
    return mask


async def execute_action(bot: Any, action: int) -> bool:
    intent = bot._pluto_action_context.get(action)
    if intent is None:
        raise ValueError(f"Policy selected unavailable action {action}")
    if action == ACTION_TO_INDEX["no_op"]:
        return True
    if intent.camera is not None:
        return await bot.fairplay.move_camera(bot, intent.camera)
    accepted = await bot.fairplay.issue(bot, list(intent.sources), intent.ability, intent.target, minimap=intent.minimap)
    lease = getattr(bot, "_worker_scout_lease", None)
    if action == ACTION_TO_INDEX["scout"] and lease is not None:
        lease.selected(bot, int(intent.sources[0].tag), accepted)
    return accepted


class NeuralBot(BotAI):
    """Eight-worker Protoss policy with explicit, bounded camera guidance."""

    def __init__(
        self, policy: Policy, *, record: bool = True, deterministic: bool = False,
        max_game_seconds: float = 1200, step_mul: int = 8, gamma: float = 1.0,
        reward_shaping: float = 0.0, history_length: int = HISTORY_LENGTH,
        expected_start_workers: int | None = 8, fairplay: Any = None, reward_config: Any = None,
        reward_reference: dict | None = None,
    ):
        super().__init__()
        if max_game_seconds <= 0 or step_mul < 1 or not 0 <= gamma <= 1 or reward_shaping < 0:
            raise ValueError("Invalid game duration, step size, discount or shaping weight")
        if expected_start_workers is not None and expected_start_workers != 8:
            raise ValueError("This experiment supports the requested eight-worker start only")
        self.policy = policy
        self.record = record
        self.deterministic = deterministic
        self.max_game_seconds = float(max_game_seconds)
        self.step_mul = int(step_mul)
        self.gamma = float(gamma)
        self.reward_shaping = float(reward_shaping)
        self._reward_collector = (RewardCollector(reward_config, reward_reference)
                                  if reward_config is not None and record else None)
        self.reward_config = self._reward_collector.config if self._reward_collector else None
        self.expected_start_workers = expected_start_workers
        if fairplay is None:
            from .fairplay import FairPlayController
            fairplay = FairPlayController()
        self.fairplay = fairplay
        self.history = ObservationStack(history_length)
        self.transitions: list[Transition] = []
        self.action_counts: Counter[str] = Counter()
        self.rejected_policy_actions: Counter[str] = Counter()
        self.result: Result | None = None
        self.error: str | None = None
        self._pending_transition: tuple[np.ndarray, np.ndarray, int, float, float, float] | None = None
        self._episode_finished = False
        self._time_limited = False
        self._last_observation_loop: int | None = None
        self._last_observation: np.ndarray | None = None
        self._worker_scout_lease: WorkerScoutLease | None = None
        self._economic_guard: EconomicForfeitGuard | None = None
        self._economic_forfeit_candidate: dict | None = None
        self.forfeit_reason: dict | None = None
        self._friendly_fire_recoveries: list[dict] = []
        self._friendly_fire_stop_until: dict[int, float] = {}
        # Created by NeuralBot._step only. CoachBot owns its own step/camera
        # scheduling and therefore never activates this neural-only guidance.
        self._production_attention: ProductionAttention | None = None
        self._production_attention_loop: int | None = None

    async def on_start(self) -> None:
        try:
            await self._start()
        except Exception as error:
            if self.error is None:
                self.error = f"{type(error).__name__}: {error}"
            raise

    async def _start(self) -> None:
        workers = len(self.workers)
        if self.race != Race.Protoss or not self.townhalls or (self.expected_start_workers is not None and workers != self.expected_start_workers):
            self.error = (
                f"Eight-worker Protoss scenario required: observed race={self.race.name}, "
                f"workers={workers}, townhalls={len(self.townhalls)}. "
                "Use a supported melee map on StarCraft II 5.0.16 or later with the eight-worker start; "
                "the agent will not alter starting units."
            )
            raise ValueError(self.error)
        self.client.game_step = self.step_mul
        self.fairplay.reset(self.start_location)
        self._pluto_last_army_position = self.start_location
        self._worker_scout_lease = WorkerScoutLease()
        self._economic_guard = EconomicForfeitGuard()

    @property
    def control_summary(self) -> dict:
        return {"version": CONTROL_PROFILE,
                "worker_scout": self._worker_scout_lease.summary() if self._worker_scout_lease else None,
                "economic_forfeit_enabled": self._economic_guard is not None,
                "ground_attack": "current-visible-empty-screen-attack23-v1",
                "production_attention": self._production_attention.summary() if self._production_attention else None,
                "friendly_fire_recoveries": [{**event, "command_confirmation":
                    self.fairplay.audit[event["selection_audit_index"]].get("command_confirmation")}
                    for event in self._friendly_fire_recoveries]}

    async def _recover_friendly_attack(self) -> bool:
        """Safety Stop only for a currently seen own source attacking an own tag.

        This is a paced command-safety intervention, never a policy sample or
        demonstration. Unknown/off-screen targets do not trigger it. The normal
        pending-transition accounting continues across the input wait.
        """
        own, _ = screen_entities(self)
        own_tags = {unit.tag for unit in own}
        attack_ids = {AbilityId.ATTACK.value, AbilityId.ATTACK_ATTACK.value}
        for unit in own:
            if (not unit.is_ready or self._friendly_fire_stop_until.get(unit.tag, -1) > self.time
                    or not self.fairplay.source_available(unit, float(self.time))):
                continue
            targets = [target for ids, target, _ in _order_details(unit, self.game_data)
                       if isinstance(target, int) and target in own_tags and not ids.isdisjoint(attack_ids)]
            if not targets:
                continue
            queried = (await self.get_available_abilities([unit], ignore_resource_requirements=False))[0]
            stop = next((ability for ability in (AbilityId.STOP_STOP, AbilityId.STOP)
                         if ability in queried), None)
            if stop is None:
                continue
            if await self.fairplay.issue(self, [unit], stop):
                self._friendly_fire_stop_until[unit.tag] = float(self.time) + 2
                self._friendly_fire_recoveries.append({"source_tag": int(unit.tag),
                    "target_tag": targets[0], "time": float(self.time),
                    "selection_audit_index": len(self.fairplay.audit) - 1})
                self.action_counts["safety_stop_friendly_attack"] += 1
                return True
        return False

    def _potential(self) -> float:
        # Shaping uses HUD quantities only and defaults to disabled.
        return float(self.supply_workers / 80 + self.supply_army / 200)

    @property
    def reward_summary(self) -> dict | None:
        return self._reward_collector.engine.summary() if self._reward_collector else None

    @property
    def reward_terminal_outcome(self) -> float:
        return self._reward_collector.terminal_outcome if self._reward_collector else 0.0

    def correct_reward_timeout(self) -> float:
        return self._reward_collector.correct_timeout() if self._reward_collector else 0.0

    def _observe(self) -> np.ndarray:
        """Append exactly once per engine observation, including selection waits."""
        loop = int(self.state.game_loop)
        if self._last_observation_loop != loop:
            self._last_observation = self.history.push(encode_observation(self))
            if self._reward_collector is not None or self._worker_scout_lease is not None or self._economic_guard is not None:
                own, enemies = screen_entities(self)
                if self._worker_scout_lease is not None:
                    self._worker_scout_lease.observe(self, own)
                if self._economic_guard is not None:
                    self._economic_forfeit_candidate = self._economic_guard.observe(self, own)
                if self._reward_collector is not None:
                    self._reward_collector.observe(self, own, enemies, camera_restricted=True)
            self._last_observation_loop = loop
        assert self._last_observation is not None
        return self._last_observation

    def _finish_transition(self, observation: np.ndarray, *, terminated: bool, truncated: bool,
                           outcome: float = 0.0, next_value: float | None = None) -> None:
        if self._pending_transition is None:
            return
        old_obs, old_mask, action, log_prob, value, old_potential = self._pending_transition
        if self._reward_collector is not None:
            reward = self._reward_collector.take()
        else:
            next_potential = 0.0 if terminated else self._potential()
            reward = outcome + self.reward_shaping * (self.gamma * next_potential - old_potential)
        next_value = 0.0 if terminated else self.policy.value(observation) if next_value is None else float(next_value)
        if not math.isfinite(next_value):
            raise ValueError("Transition bootstrap must be finite")
        if self.record:
            self.transitions.append(Transition(old_obs, old_mask, action, log_prob, value, reward, next_value, terminated, truncated))
        self._pending_transition = None

    async def on_step(self, iteration: int) -> None:
        try:
            await self._step(iteration)
        except Exception as error:
            # Preserve a diagnostic so runners reject an incomplete episode
            # instead of accidentally using it as ordinary training experience.
            self.error = f"{type(error).__name__}: {error}"
            raise

    async def _step(self, iteration: int) -> None:
        if self._episode_finished or self.forfeit_reason is not None:
            return
        self.fairplay.sync_camera(self)
        observation = self._observe()
        if self.time >= self.max_game_seconds:
            self._time_limited = True
            # The runner's shared game_time_limit ends both self-play perspectives
            # together. Leaving here would incorrectly award the other side a win.
            return
        if self._economic_forfeit_candidate is not None:
            await self._forfeit(self._economic_forfeit_candidate)
            return
        if self._production_attention is not None:
            self._observe_production_attention()
        if await self.fairplay.advance(self):
            return
        if not self.fairplay.can_issue(float(self.time)):
            return
        if await self._recover_friendly_attack():
            return
        if self._production_attention is None:
            self._production_attention = ProductionAttention()
            self._observe_production_attention()
        request = self._production_attention.request(float(self.time))
        if request is not None:
            before = len(self.fairplay.audit)
            accepted = await self.fairplay.move_camera(self, Point2(request["target"]))
            index = before if len(self.fairplay.audit) > before else None
            if index is not None:
                self.fairplay.audit[index].update(input_origin="production_attention", policy_sample=False)
            self._production_attention.attempted(request, float(self.time), accepted, index)
            # Keep the prior real decision pending across the paid camera
            # intervention. Do not fabricate a camera action or teacher label.
            return
        mask = await legal_action_mask(self)
        mask = self._production_attention.restrict_mask(mask, float(self.time))
        action, log_prob, value = self.policy.act(observation, mask, deterministic=self.deterministic)
        if not 0 <= action < len(ACTION_NAMES) or not mask[action]:
            raise ValueError("Policy returned an action outside its legal mask")
        self._finish_transition(observation, terminated=False, truncated=False, next_value=value)
        accepted = await execute_action(self, action)
        if not accepted:
            # SC2 can reject a pixel selection or command as the scene changes.
            # It still counts as the policy's attempted action and consumes APM.
            # Transport exceptions and programming errors propagate unchanged.
            self.rejected_policy_actions[ACTION_NAMES[action]] += 1
        self.action_counts[ACTION_NAMES[action]] += 1
        self._pending_transition = (observation.copy(), mask.copy(), action, log_prob, value, self._potential())

    def _observe_production_attention(self) -> None:
        loop = int(self.state.game_loop)
        if self._production_attention_loop != loop:
            self._production_attention.observe(self, *screen_entities(self))
            self._production_attention_loop = loop

    async def _forfeit(self, evidence: dict) -> None:
        """User-authorized resignation; SC2 supplies the actual defeat result."""
        if self.forfeit_reason is not None:
            return
        self.forfeit_reason = dict(evidence)
        from loguru import logger
        logger.info("Protoss resigns: {}", self.forfeit_reason)
        await self.client.leave()

    async def on_end(self, game_result: Result) -> None:
        if self._episode_finished:
            return
        self.result = game_result
        self._time_limited = self._time_limited or game_result == Result.Tie or self.time >= self.max_game_seconds
        if self._pending_transition is not None:
            observation = self._observe()
            outcome = 1.0 if game_result == Result.Victory else -1.0 if game_result == Result.Defeat else 0.0
            if self._reward_collector is not None:
                self._reward_collector.finish("time_limit" if self._time_limited else game_result.name.lower())
            self._finish_transition(observation, terminated=not self._time_limited, truncated=self._time_limited, outcome=0.0 if self._time_limited else outcome)
        self._episode_finished = True
