"""Geometric army jobs derived from observed bases and public map direction.

These are rally suggestions, not pathfinding or claims about an unseen army.
The caller must check current visible terrain before issuing a local order.
No live game object, visibility grid or enemy memory is read here.
"""
from __future__ import annotations

from dataclasses import asdict, dataclass
import math


_FRONTLINE = frozenset(("ZEALOT", "ARCHON"))
_SUPPORT = frozenset(("SENTRY", "HIGHTEMPLAR", "OBSERVER", "OBSERVERSIEGEMODE",
                      "WARPPRISM", "WARPPRISMPHASING", "DISRUPTOR"))


def _point(value):
    if not isinstance(value, (list, tuple)) or len(value) != 2:
        return None
    if not all(isinstance(v, (int, float)) and not isinstance(v, bool) and math.isfinite(v) for v in value):
        return None
    return tuple(float(v) for v in value)


@dataclass(frozen=True)
class ArmyPlan:
    job: str
    role: str
    base_tag: int
    base_position: tuple[float, float]
    candidates: tuple[tuple[float, float], ...]

    def to_dict(self):
        return asdict(self)


def defense_plan(bases, enemy_start, kind: str, *, alert_position=None, threat_position=None):
    """Guard the exposed known base; face a current threat when supplied.

    Base records are already restricted to the caller's permitted memory.
    A remembered base is an intended rendezvous, never proof it still lives.
    The role offsets keep melee in front of ranged units and support, leaving
    space around the Nexus. Terrain validation may reject every candidate.
    """
    enemy = _point(enemy_start)
    alert = _point(alert_position)
    threat = _point(threat_position)
    if enemy is None:
        return None
    eligible = [(row, _point(row.get("position"))) for row in bases
                if row.get("type") == "NEXUS" and row.get("is_ready", False)
                and type(row.get("tag")) is int]
    eligible = [(row, pos) for row, pos in eligible if pos is not None]
    if not eligible:
        return None
    row, base = min(eligible, key=lambda item: (math.dist(item[1], alert or enemy), item[0]["tag"]))
    facing = threat or enemy
    dx, dy = facing[0] - base[0], facing[1] - base[1]
    distance = math.hypot(dx, dy)
    if distance < .01:
        dx, dy = enemy[0] - base[0], enemy[1] - base[1]
        distance = math.hypot(dx, dy)
    if distance < .01:
        return None
    dx, dy = dx / distance, dy / distance
    role = "frontline" if kind in _FRONTLINE else "support" if kind in _SUPPORT else "ranged"
    # A Nexus' rendered selectable model extends beyond its ground footprint.
    # Keep even support posts clear so a MOVE pixel cannot become follow-Nexus.
    offset = {"frontline": 10.0, "ranged": 8.0, "support": 6.5}[role]
    # Symmetric alternatives permit a visible ramp/structure obstruction to be
    # resolved without consulting updated terrain beneath fog of war.
    candidates = tuple((base[0] + dx * forward - dy * lateral,
                        base[1] + dy * forward + dx * lateral)
                       for forward, lateral in ((offset, 0), (offset, 2), (offset, -2),
                                                (max(6.5, offset - 1.5), 0)))
    return ArmyPlan("defend_base" if alert is not None else "guard_base", role,
                    row["tag"], base, candidates)
