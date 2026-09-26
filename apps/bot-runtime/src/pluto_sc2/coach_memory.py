"""Last-seen memory for the separate coach bot's permitted screen observations.

The caller supplies already camera/fog-filtered units. No global own/enemy unit
collection, score, replay, opponent telemetry or production queue is queried.
Remembered counts and orders describe past sightings, never global live state.
"""
from __future__ import annotations

from collections import Counter
from copy import deepcopy
import math
from typing import Any

from sc2.dicts.unit_research_abilities import RESEARCH_INFO
from sc2.dicts.unit_train_build_abilities import TRAIN_INFO
from sc2.ids.ability_id import AbilityId
from sc2.position import Point2


MEMORY_VERSION = "coach-screen-memory-v1"
MAX_RECORDS = 1024
MAX_ORDERS = 32
# A death must follow a sighting in the immediately preceding observation, with
# at most two ordinary eight-loop observation steps between those observations.
DEATH_FRESHNESS_LOOPS = 16
_HUD_FIELDS = ("minerals", "vespene", "supply_used", "supply_cap", "supply_left",
               "supply_workers", "supply_army")


def _number(value: Any) -> float:
    result = float(value)
    if not math.isfinite(result):
        raise ValueError("Coach observations must contain finite numbers")
    return result


def _position(value: Any) -> list[float]:
    if hasattr(value, "position"):
        value = value.position
    if hasattr(value, "x"):
        return [_number(value.x), _number(value.y)]
    return [_number(value[0]), _number(value[1])]


def _visible_point(bot: Any, position: list[float]) -> bool:
    point = Point2(tuple(position))
    # Short circuit: never inspect the visibility of an off-screen location.
    return bool(bot.fairplay.on_screen(point) and bot.is_visible(point))


def _own_orders(bot: Any, unit: Any, visible_tags: set[int]) -> list[dict]:
    proto = getattr(unit, "_proto", None)
    orders = proto.orders if proto is not None else getattr(unit, "orders", ())
    records = []
    for order in list(orders)[:MAX_ORDERS]:
        ability_id = getattr(order, "ability_id", None)
        if ability_id is None:
            ability = getattr(order, "ability", None)
            ability = getattr(ability, "exact_id", getattr(ability, "id", ability))
            ability_id = int(getattr(ability, "value", ability))
        ability_id = int(ability_id)
        record = {"ability_id": ability_id, "progress": _number(getattr(order, "progress", 0))}
        try:
            ability = AbilityId(ability_id)
            # Burnysc2 maps unknown values to NULL_NULL instead of raising.
            record["ability_name"] = ability.name if ability.value == ability_id else "UNKNOWN"
        except ValueError:
            record["ability_name"] = "UNKNOWN"
        for name, definitions in (("produces", TRAIN_INFO), ("researches", RESEARCH_INFO)):
            for kind, info in definitions.get(unit.type_id, {}).items():
                if info["ability"].value == ability_id:
                    record[name] = kind.name
                    break
        target = None
        if hasattr(order, "WhichOneof"):
            field = order.WhichOneof("target")
            if field == "target_unit_tag":
                target = int(order.target_unit_tag)
            elif field == "target_world_space_pos":
                target = order.target_world_space_pos
        else:
            target = getattr(order, "target", None)
        if isinstance(target, int) and not isinstance(target, bool):
            if target in visible_tags:
                record["target"] = {"kind": "unit", "tag": target}
        elif target is not None:
            position = _position(target)
            if _visible_point(bot, position):
                record["target"] = {"kind": "point", "position": position}
        records.append(record)
    return records


def _record(bot: Any, unit: Any, *, own: bool, loop: int, seconds: float,
            visible_tags: set[int], previous: dict | None) -> dict:
    record = {
        "tag": int(unit.tag), "type": unit.type_id.name, "type_id": int(unit.type_id.value),
        "position": _position(unit.position), "first_seen_loop": previous["first_seen_loop"] if previous else loop,
        "last_seen_loop": loop, "last_seen_seconds": seconds, "current": True, "status": "current",
        "is_structure": bool(unit.is_structure), "is_flying": bool(getattr(unit, "is_flying", False)),
        "is_cloaked": bool(getattr(unit, "is_cloaked", False)),
        "is_burrowed": bool(getattr(unit, "is_burrowed", False)),
        "is_ready": bool(unit.is_ready), "build_progress": _number(unit.build_progress),
        "health": _number(unit.health), "health_max": _number(unit.health_max),
        "shield": _number(unit.shield), "shield_max": _number(unit.shield_max),
    }
    for name in ("energy", "can_attack", "can_attack_air", "can_attack_ground"):
        value = getattr(unit, name, None)
        if value is not None:
            record[name] = bool(value) if name != "energy" else _number(value)
    if own:
        record["is_hallucination"] = bool(getattr(unit, "is_hallucination", False))
        record["orders"] = _own_orders(bot, unit, visible_tags)
        record["is_idle"] = not record["orders"]
        for name in ("assigned_harvesters", "ideal_harvesters", "is_powered"):
            value = getattr(unit, name, None)
            if value is not None:
                record[name] = bool(value) if name == "is_powered" else int(value)
    return record


class CoachMemory:
    """Bounded JSON records from current screens, with explicit stale sightings.

    ``own``/``enemies`` hold records keyed by tag. Only passed screen units can
    introduce or refresh records. A visible empty structure position removes a
    location record without asserting a kill. Missing mobile units stay stale;
    off-screen death notifications never refresh or remove them.
    """

    def __init__(self, max_records: int = MAX_RECORDS) -> None:
        if type(max_records) is not int or not 1 <= max_records <= MAX_RECORDS:
            raise ValueError(f"max_records must be an integer in 1..{MAX_RECORDS}")
        self.max_records = max_records
        self.own: dict[int, dict] = {}
        self.enemies: dict[int, dict] = {}
        self.current_own: list[dict] = []
        self.current_enemies: list[dict] = []
        self.last_loop: int | None = None
        self.last_seconds: float | None = None

    def observe(self, bot: Any, own: list[Any], enemies: list[Any]) -> None:
        loop, seconds = int(bot.state.game_loop), _number(bot.time)
        if loop < 0 or seconds < 0 or (self.last_loop is not None and loop < self.last_loop):
            raise ValueError("Coach observation time moved backwards or is invalid")
        if self.last_seconds is not None and seconds < self.last_seconds:
            raise ValueError("Coach observation time moved backwards")
        if loop == self.last_loop:
            return
        own_tags, enemy_tags = {int(unit.tag) for unit in own}, {int(unit.tag) for unit in enemies}
        if (len(own_tags) != len(own) or len(enemy_tags) != len(enemies)
                or own_tags.intersection(enemy_tags)):
            raise ValueError("Coach screen tags must be unique across both players")
        visible_tags = own_tags | enemy_tags
        if len(visible_tags) > self.max_records:
            raise ValueError("Current screen exceeds the coach memory limit")
        previous_loop = self.last_loop
        dead_tags = set(getattr(bot.state, "dead_units", ()))
        for memory, current_tags in ((self.own, own_tags), (self.enemies, enemy_tags)):
            for tag, record in list(memory.items()):
                record["current"], record["status"] = False, "last_seen"
                if tag in current_tags:
                    continue
                position_visible = _visible_point(bot, record["position"])
                empty_static_position = (record["is_structure"] and not record["is_flying"]
                                         and not record["is_cloaked"] and not record["is_burrowed"])
                fresh_death = (tag in dead_tags and previous_loop is not None
                               and record["last_seen_loop"] == previous_loop
                               and 0 < loop - previous_loop <= DEATH_FRESHNESS_LOOPS)
                if position_visible and (empty_static_position or fresh_death):
                    del memory[tag]
        # Ownership changes, if ever observed, cannot leave two records for a tag.
        for units, memory, opposite, is_own in ((own, self.own, self.enemies, True),
                                               (enemies, self.enemies, self.own, False)):
            for unit in sorted(units, key=lambda value: int(value.tag)):
                tag = int(unit.tag)
                previous = memory.get(tag) or opposite.pop(tag, None)
                memory[tag] = _record(bot, unit, own=is_own, loop=loop, seconds=seconds,
                                      visible_tags=visible_tags, previous=previous)
        self._prune()
        self.current_own = [self.own[tag] for tag in sorted(own_tags)]
        self.current_enemies = [self.enemies[tag] for tag in sorted(enemy_tags)]
        self.last_loop, self.last_seconds = loop, seconds

    def _prune(self) -> None:
        excess = len(self.own) + len(self.enemies) - self.max_records
        if excess <= 0:
            return
        stale = [(record["is_structure"], record["last_seen_loop"], tag, side, memory)
                 for side, memory in enumerate((self.own, self.enemies))
                 for tag, record in memory.items() if not record["current"]]
        # Old nonstructures leave first; current sightings are always retained.
        for _, _, tag, _, memory in sorted(stale, key=lambda item: item[:4])[:excess]:
            del memory[tag]

    def report(self, bot: Any) -> dict:
        """Return detached JSON data from the same observed frame and player HUD."""
        if self.last_loop is None or int(bot.state.game_loop) != self.last_loop:
            raise ValueError("Observe the current game frame before requesting a coach report")
        own_records = [self.own[tag] for tag in sorted(self.own)]
        enemy_records = [self.enemies[tag] for tag in sorted(self.enemies)]
        report = {
            "version": MEMORY_VERSION, "time": self.last_seconds, "game_loop": self.last_loop,
            "hud": {name: _number(getattr(bot, name)) for name in _HUD_FIELDS},
            "camera": _position(bot.fairplay.camera_center),
            "current_own": self.current_own, "current_enemies": self.current_enemies,
            "own_memory": own_records, "enemy_memory": enemy_records,
            "own_seen_counts": dict(sorted(Counter(record["type"] for record in own_records).items())),
            "own_ready_seen_counts": dict(sorted(Counter(record["type"] for record in own_records
                                                         if record["is_ready"]).items())),
            "own_unfinished_seen_counts": dict(sorted(Counter(record["type"] for record in own_records
                                                              if not record["is_ready"]).items())),
            "memory_scope": "Last-seen records; remembered counts and queues are not global live state",
        }
        return deepcopy(report)
