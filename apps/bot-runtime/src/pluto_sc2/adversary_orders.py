"""Stable, policy-selected army objectives for the Terran/Zerg learners.

No orders are generated here. This helper masks redundant/rapidly conflicting
whole-army choices and resolves a selected attack to observed structure memory.
It reads only explicitly supplied owned units and currently visible enemies.
"""
from __future__ import annotations

from dataclasses import dataclass
import math

from sc2.position import Point2


ORDER_PROFILE = "observed-objectives-cadence-v1"
STRATEGIC_CADENCE = 5.0
EMERGENCY_CADENCE = 1.0
STRATEGIC_ACTIONS = frozenset(("attack_enemy_base", "attack_visible_enemy", "defend", "retreat"))


def visible(unit) -> bool:
    return (getattr(unit, "is_visible", False) and not getattr(unit, "is_snapshot", False)
            and (not getattr(unit, "is_cloaked", False) or getattr(unit, "is_revealed", False)))


def pressure_tags(owned, visible_enemies) -> frozenset[int]:
    """Enemies visibly within their compatible weapon range + two world units."""
    threats = set()
    for enemy in visible_enemies:
        if not visible(enemy) or not getattr(enemy, "can_attack", False):
            continue
        for unit in owned:
            flying = getattr(unit, "is_flying", False)
            if not getattr(enemy, "can_attack_air" if flying else "can_attack_ground", False):
                continue
            attack_range = float(getattr(enemy, "air_range" if flying else "ground_range", 0.0))
            if math.isfinite(attack_range) and enemy.distance_to(unit) <= max(0.0, attack_range) + 2:
                threats.add(int(enemy.tag))
                break
    return frozenset(threats)


def _ability_id(ability, game_data) -> int:
    value = int(getattr(ability, "value", ability))
    public = getattr(game_data, "abilities", {}).get(value)
    return int(getattr(getattr(public, "id", None), "value", value))


def duplicate_order(sources, ability, target, game_data) -> bool:
    """All sources already have this first order and destination, not just one."""
    if not sources or target is None:
        return False
    wanted = _ability_id(ability, game_data)
    for unit in sources:
        orders = getattr(getattr(unit, "_proto", None), "orders", ())
        if not orders or _ability_id(orders[0].ability_id, game_data) != wanted:
            return False
        order = orders[0]
        if hasattr(target, "tag"):
            if getattr(order, "target_unit_tag", None) != target.tag:
                return False
        else:
            if hasattr(order, "HasField") and not order.HasField("target_world_space_pos"):
                return False
            point = getattr(order, "target_world_space_pos", None)
            if point is None or math.hypot(point.x - target.x, point.y - target.y) > 1.0:
                return False
    return True


@dataclass(frozen=True)
class KnownStructure:
    tag: int
    position: Point2
    flying: bool


class StrategicOrders:
    def __init__(self):
        self.last_accepted_time = -math.inf
        self.structures: dict[int, KnownStructure] = {}

    def observe_structures(self, visible_enemies, is_visible) -> None:
        observed = {int(unit.tag): unit for unit in visible_enemies if visible(unit)}
        for tag, unit in observed.items():
            if getattr(unit, "is_structure", False):
                self.structures[tag] = KnownStructure(tag, Point2(tuple(unit.position)), bool(unit.is_flying))
        for tag, known in list(self.structures.items()):
            # Visibility lookup only at an already observed position. This
            # invalidates stale memory, not a reward or a claimed hidden kill.
            if tag not in observed and is_visible(known.position):
                del self.structures[tag]

    def objective(self, attackers, fallback) -> Point2:
        if not attackers:
            return fallback
        candidates = [known for known in self.structures.values()
                      if any(getattr(unit, "can_attack_air" if known.flying else "can_attack_ground", False)
                             for unit in attackers)]
        if not candidates:
            return fallback
        center = Point2((sum(unit.position.x for unit in attackers) / len(attackers),
                         sum(unit.position.y for unit in attackers) / len(attackers)))
        return min(candidates, key=lambda known: (center.distance_to(known.position), known.tag)).position

    def permission(self, name, now, sources, ability, target, game_data, threats) -> tuple[bool, bool]:
        """Return (legal, observable-emergency override); never choose an action."""
        if name not in STRATEGIC_ACTIONS:
            return True, False
        if duplicate_order(sources, ability, target, game_data):
            return False, False
        elapsed = now - self.last_accepted_time
        if elapsed >= STRATEGIC_CADENCE - 1e-9:
            return True, False
        urgent = (name in {"defend", "retreat"} and bool(threats)
                  or name == "attack_visible_enemy" and getattr(target, "tag", None) in threats)
        return (True, True) if urgent and elapsed >= EMERGENCY_CADENCE - 1e-9 else (False, False)

    def accepted(self, now: float) -> None:
        if not math.isfinite(now) or now < self.last_accepted_time:
            raise ValueError("Strategic command time must be finite and monotonic")
        self.last_accepted_time = now
