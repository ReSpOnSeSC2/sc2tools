"""Bounded strategic objectives from the coached player's permitted report.

This is a heuristic planner, not learned policy, combat simulation or a rating.
It neither reads game state nor issues commands. Prices/capabilities come from
the current game's public catalog supplied by the caller. The executor still
checks current legal actions and the ordinary camera, fog and input limits.
"""
from __future__ import annotations

from collections import Counter
from collections.abc import Mapping
from dataclasses import dataclass
import math
from typing import Any

from .coach_orders import StrategyOrder
from .schema import RESEARCH_UPGRADES


VERSION = "observed-adaptive-coach-strategy-v1"
OPENING_PROTECTION_SECONDS = 240.0
FRESH_ENEMY_SECONDS = 30.0
AIR_REACTION_SECONDS = 60.0
OBJECTIVE_MEMORY_SECONDS = 180.0
_AIR = frozenset(("PHOENIX", "VOIDRAY", "ORACLE", "TEMPEST", "CARRIER"))
_WORKERS = frozenset(("PROBE", "SCV", "DRONE", "MULE"))
_ECONOMIC_BASES = frozenset(("NEXUS", "COMMANDCENTER", "ORBITALCOMMAND", "PLANETARYFORTRESS",
                             "HATCHERY", "LAIR", "HIVE"))
_INVALID_ENEMY_STATUS = frozenset(("destroyed", "not_seen_at_visible_position", "dead"))
_ALIASES = {"WARPGATE": "GATEWAY", "OBSERVERSIEGEMODE": "OBSERVER", "WARPPRISMPHASING": "WARPPRISM"}


def _number(value: Any, default: float = 0.0) -> float:
    return (float(value) if isinstance(value, (int, float)) and not isinstance(value, bool)
            and math.isfinite(value) else default)


def _records(value: Any) -> list[Mapping]:
    values = value.values() if isinstance(value, Mapping) else value or ()
    return [row for row in values if isinstance(row, Mapping)]


def _kind(row: Mapping) -> str:
    name = str(row.get("type", "")).upper()
    return _ALIASES.get(name, name)


def _age(row: Mapping, now: float, current_tags: set) -> float:
    if row.get("tag") in current_tags:
        return 0.0
    seen = _number(row.get("last_seen_seconds"), math.nan)
    return now - seen if math.isfinite(seen) and 0 <= seen <= now else math.inf


def _enemy_records(report: Mapping) -> tuple[list[Mapping], set]:
    current = _records(report.get("current_enemies"))
    current_tags = {row.get("tag") for row in current if row.get("tag") is not None}
    merged = {row.get("tag", ("memory", i)): row
              for i, row in enumerate(_records(report.get("enemy_memory")))}
    merged.update({row.get("tag", ("current", i)): row for i, row in enumerate(current)})
    return [row for row in merged.values() if row.get("status") not in _INVALID_ENEMY_STATUS
            and not row.get("destroyed", False) and not row.get("is_hallucination", False)], current_tags


def _position(value: Any) -> tuple[float, float] | None:
    if not isinstance(value, (list, tuple)) or len(value) != 2:
        return None
    point = tuple(_number(coordinate, math.nan) for coordinate in value)
    return point if all(math.isfinite(coordinate) for coordinate in point) else None


def _offensive_objective(report: Mapping, now: float, stance: str) -> dict | None:
    if stance not in {"attack", "pressure"} or report.get("defense_alert"):
        return None
    current_force = [point for row in _records(report.get("current_own"))
                     if not row.get("is_structure", False) and _kind(row) not in _WORKERS
                     and not row.get("is_hallucination", False)
                     and (row.get("can_attack_ground") or row.get("can_attack_air"))
                     and (point := _position(row.get("position"))) is not None]
    anchor = (tuple(sum(point[axis] for point in current_force) / len(current_force) for axis in (0, 1))
              if current_force else None)
    enemies, current_tags = _enemy_records(report)
    candidates = []
    for row in enemies:
        tag, point, age = row.get("tag"), _position(row.get("position")), _age(row, now, current_tags)
        if (type(tag) is not int or tag <= 0 or point is None or not row.get("is_structure", False)
                or row.get("is_flying", False) or age > OBJECTIVE_MEMORY_SECONDS):
            continue
        economic = _kind(row) in _ECONOMIC_BASES
        candidates.append(((not economic, math.dist(point, anchor) if anchor else age, age, tag),
                           row, point, age, economic))
    if not candidates:
        return None
    _, row, point, age, economic = min(candidates, key=lambda item: item[0])
    current = row["tag"] in current_tags
    return {"position": list(point), "tag": row["tag"], "type": _kind(row),
            "kind": "economic_base" if economic else "observed_structure",
            "source": "current_enemy_screen" if current else "enemy_last_seen_memory",
            "age_seconds": age, "last_seen_seconds": now - age,
            "fresh": age <= FRESH_ENEMY_SECONDS, "requires_scout_refresh": not current,
            "mode": stance,
            "reason": (("Prioritize an observed economic base over incidental structures. " if economic
                         else "Advance toward a recently observed enemy structure while scouting for economic bases. ")
                       + ("Current sighting supplies the location; unseen defenders remain unknown." if current
                          else "This is a last-seen location to scout again, not a claim the target is still there."))}


def _price(row: Any) -> tuple[float, float] | None:
    if not isinstance(row, Mapping):
        return None
    price = tuple(_number(row.get(key), math.nan) for key in ("minerals", "vespene"))
    return price if all(math.isfinite(value) and value >= 0 for value in price) and sum(price) > 0 else None


def _owned(report: Mapping) -> list[Mapping]:
    merged = {row.get("tag", ("memory", i)): row
              for i, row in enumerate(_records(report.get("own_memory")))}
    merged.update({row.get("tag", ("current", i)): row
                   for i, row in enumerate(_records(report.get("current_own")))})
    return [row for row in merged.values() if not row.get("is_hallucination", False)]


def _catalog_row(name: str, catalog: Mapping, costs: Mapping) -> Mapping:
    row = catalog.get(name, {})
    row = dict(row) if isinstance(row, Mapping) else {}
    # A supplied unit catalog is required for enemy values. Own train prices
    # can also come from the existing current-game action-cost report.
    if _price(row) is None:
        price = costs.get("train_" + name.lower())
        if isinstance(price, Mapping):
            row.update(price)
    return row


def _combat_evidence(report: Mapping, now: float, catalog: Mapping, costs: Mapping) -> dict:
    def value(row: Mapping) -> tuple[float | None, bool, bool]:
        data = _catalog_row(_kind(row), catalog, costs)
        ground = bool(row.get("can_attack_ground", data.get("can_attack_ground", False)))
        air = bool(row.get("can_attack_air", data.get("can_attack_air", False)))
        if _kind(row) in _WORKERS or row.get("is_hallucination", False) or not row.get("is_ready", True):
            return 0.0, False, False
        if not (ground or air):
            return (None if row.get("can_attack") else 0.0), ground, air
        price = _price(data)
        if price is None:
            return None, ground, air
        maximum = _number(row.get("health_max")) + _number(row.get("shield_max"))
        durability = (_number(row.get("health")) + _number(row.get("shield"))) / maximum if maximum > 0 else 1.0
        return (price[0] + 1.5 * price[1]) * min(1.0, max(0.0, durability)), ground, air

    # Only the current screen is an assembled force. HUD army supply and old
    # own sightings must never turn scattered rear units into a ready attack.
    own_value = own_ground = own_air = 0.0
    unknown_own = False
    for row in _records(report.get("current_own")):
        if row.get("is_structure", False):
            continue
        amount, ground, air = value(row)
        unknown_own |= amount is None
        if amount is not None:
            own_value += amount
            own_ground += amount if ground else 0.0
            own_air += amount if air else 0.0
    enemies, current_tags = _enemy_records(report)
    enemy_value = enemy_air = enemy_ground = 0.0
    fresh_air_count = fresh_count = stale_count = 0
    unknown_enemy = False
    for row in enemies:
        amount, ground, air = value(row)
        age = _age(row, now, current_tags)
        if row.get("is_flying", False) and (ground or air) and age <= AIR_REACTION_SECONDS:
            fresh_air_count += 1
        if amount is None:
            unknown_enemy = True
            continue
        if amount <= 0:
            continue
        fresh_count += age <= FRESH_ENEMY_SECONDS
        stale_count += age > FRESH_ENEMY_SECONDS
        # Old enemy value is retained, not decayed toward an invented zero.
        amount *= 1.25 if age > FRESH_ENEMY_SECONDS else 1.0
        enemy_value += amount
        if row.get("is_flying", False):
            enemy_air += amount
        else:
            enemy_ground += amount
    ratio = own_value / enemy_value if enemy_value > 0 else None
    favorable = (fresh_count > 0 and not stale_count and not unknown_enemy and not unknown_own
                 and own_value >= 600 and ratio is not None and ratio >= 1.6
                 and (enemy_air == 0 or own_air >= 1.35 * enemy_air)
                 and (enemy_ground == 0 or own_ground >= 1.35 * enemy_ground))
    return {"method": "current-screen-cost-and-target-coverage-heuristic",
            "own_current_combat_value": own_value, "known_enemy_combat_value": enemy_value,
            "own_anti_air_value": own_air, "known_enemy_air_value": enemy_air,
            "known_value_ratio": ratio, "fresh_enemy_combat_records": fresh_count,
            "stale_enemy_combat_records": stale_count, "unknown_enemy_value": unknown_enemy,
            "unknown_own_value": unknown_own, "fresh_enemy_air_count": fresh_air_count,
            "favorable": favorable,
            "uncertainty": "Enemy sightings are partial; this is not total enemy strength or a win probability."}


@dataclass(frozen=True)
class StrategyDecision:
    order: StrategyOrder | None
    status: str
    reasons: tuple[str, ...]
    evidence: dict

    def to_dict(self) -> dict:
        return {"version": VERSION, "status": self.status, "reasons": list(self.reasons),
                "evidence": self.evidence, "effective_order": self.order.to_dict() if self.order else None}


def adapt_strategy(order: StrategyOrder | None, report: Mapping, *, now: float,
                   opening_active: bool = False, unit_catalog: Mapping[str, Mapping] | None = None) -> StrategyDecision:
    """Return an effective order without rewriting mailbox revision/provenance.

    `unit_catalog` rows use current public game data: minerals, vespene, supply,
    can_attack_ground and can_attack_air. Reports use CoachMemory's timestamped
    records, own HUD, action_costs and optional own completed `upgrades` names.
    This does not publish a new order or extend the accepted order's lifetime.
    """
    now = _number(now, math.nan)
    if not math.isfinite(now) or now < 0:
        raise ValueError("strategy time must be finite and nonnegative")
    if not isinstance(report, Mapping):
        raise ValueError("strategy report must be a mapping")
    if (order is None or not order.issued_game_seconds <= now < order.valid_until_game_seconds
            or report.get("game_id", order.game_id) != order.game_id):
        return StrategyDecision(None, "inactive", ("No active strategy for this game.",), {})
    opening = report.get("opening", {}) or {}
    decision = opening.get("decision", {}) or {} if isinstance(opening, Mapping) else {}
    if now < OPENING_PROTECTION_SECONDS or opening_active or decision.get("active", False):
        return StrategyDecision(order, "opening_protected", ("Preserve the accepted replay opening.",), {})
    if order.stance == "retreat":
        return StrategyDecision(order, "retreat_preserved", ("Preserve the coach's explicit retreat order.",), {})

    catalog = unit_catalog or {}
    costs = report.get("action_costs", {})
    costs = costs if isinstance(costs, Mapping) else {}
    hud = report.get("hud", {})
    workers, army = _number(hud.get("supply_workers")), _number(hud.get("supply_army"))
    minerals, gas = _number(hud.get("minerals")), _number(hud.get("vespene"))
    own = _owned(report)
    counts = Counter(_kind(row) for row in own)
    bases = max(1, counts["NEXUS"])
    ready_bases = max(1, sum(_kind(row) == "NEXUS" and row.get("is_ready", False) for row in own))
    evidence = _combat_evidence(report, now, catalog, costs)
    reasons = []
    result = order.to_dict()
    production, composition = dict(order.production_targets), dict(order.composition)
    research = list(order.research)
    completed = set(report.get("upgrades", ()))
    stage = 2 if now >= 600 and workers >= 40 else 1 if now >= 420 and workers >= 28 else 0
    base_target = max(order.base_target, min(2, bases + 1))
    nexus_cost = _price(costs.get("build_nexus")) or _price(catalog.get("NEXUS"))
    near_saturation = workers >= 20 * ready_bases - 6
    affordable_base = bool(nexus_cost and minerals >= nexus_cost[0] and gas >= nexus_cost[1])
    if (now >= 420 and bases < 4 and near_saturation and affordable_base
            and not report.get("defense_alert") and not report.get("expansion_task")):
        base_target = max(base_target, bases + 1)
        reasons.append("Known bases approach worker capacity and current prices permit another expansion.")
    worker_target = max(order.worker_target, min(72, 22 * base_target))
    result.update(worker_target=worker_target, base_target=base_target,
                  gas_workers_per_base=max(order.gas_workers_per_base, 6 if workers >= 28 else 3))
    reasons.append(f"Maintain worker production toward {worker_target} across {base_target} planned bases.")

    air_plan = sum(composition.get(name, 0) for name in _AIR) > sum(
        count for name, count in composition.items() if name not in _AIR and name not in {"OBSERVER", "WARPPRISM"})

    def floor(name: str, count: int) -> None:
        if _price(costs.get("train_" + name.lower())) or _price(catalog.get(name)):
            composition[name] = max(composition.get(name, 0), count)

    def building(name: str, count: int) -> None:
        # Targets are goals, not assertions of affordability/readiness. Public
        # name availability is established by a current-game building price.
        if _price(costs.get("build_" + name.lower())) or _price(catalog.get(name)):
            production[name] = max(production.get(name, 0), count)

    def upgrade(name: str) -> None:
        if name in RESEARCH_UPGRADES and name not in completed and name not in research:
            if _price(costs.get("research_" + name.lower())):
                research.append(name)

    if not air_plan:
        targets = ((8, 10, 2, 1), (14, 18, 4, 2), (22, 24, 7, 2))[stage]
        for name, target in zip(("ZEALOT", "STALKER", "IMMORTAL", "SENTRY"), targets):
            floor(name, target)
        floor("OBSERVER", 1)
        building("GATEWAY", (4, 6, 8)[stage])
        building("ROBOTICSFACILITY", 2 if stage == 2 else 1)
        if workers >= 24:
            building("FORGE", 1)
            building("TWILIGHTCOUNCIL", 1)
            upgrade("WARPGATERESEARCH")
            upgrade("PROTOSSGROUNDWEAPONSLEVEL1")
            upgrade("BLINKTECH")
            upgrade("CHARGE")
            if stage >= 1:
                upgrade("PROTOSSGROUNDARMORSLEVEL1")
            for branch in ("PROTOSSGROUNDWEAPONS", "PROTOSSGROUNDARMORS"):
                for level in (2, 3):
                    if stage >= 1 and f"{branch}LEVEL{level - 1}" in completed:
                        upgrade(f"{branch}LEVEL{level}")
        reasons.append("Grow one Gateway/Robotics ground army with Forge upgrades and Twilight mobility.")
    else:
        reasons.append("Preserve the coach's chosen air composition rather than add unrelated ground tech.")
    if evidence["fresh_enemy_air_count"]:
        floor("STALKER", min(32, max((10, 18, 24)[stage], 4 * evidence["fresh_enemy_air_count"])))
        building("GATEWAY", (4, 6, 8)[stage])
        reasons.append("Recent observed enemy air adds Stalker anti-air coverage.")

    stance = order.stance
    if report.get("defense_alert"):
        stance = "defend"
        reasons.append("Respond to the current base-defense alert before issuing an offensive objective.")
    elif evidence["favorable"] and army >= 16:
        stance = "attack"
        reasons.append("Current-screen attack-capable units exceed fresh known opposition with air/ground coverage.")
    elif stance == "attack":
        stance = "pressure"
        reasons.append("Use pressure and scouting until current force and fresh opponent evidence justify an attack.")
    elif army >= 16 and evidence["own_current_combat_value"] >= 600 and stance == "defend":
        stance = "pressure"
        reasons.append("A current-screen fighting force permits cautious pressure and scouting; unseen opposition remains unknown.")
    objective = _offensive_objective(report, now, stance)
    if objective is not None:
        reasons.append(objective["reason"])
    scout = (order.scout or evidence["fresh_enemy_combat_records"] == 0
             or evidence["stale_enemy_combat_records"] > 0 or evidence["unknown_enemy_value"]
             or bool(objective and objective["requires_scout_refresh"]))
    result.update(stance=stance, scout=scout,
                  production_targets=production, composition=composition, research=research,
                  rationale=(order.rationale + " | Adaptive: " + " ".join(reasons))[-2000:])
    evidence.update(stage=stage, known_bases=bases, known_ready_bases=ready_bases,
                    worker_hud=workers, army_hud=army, nexus_current_price=list(nexus_cost) if nexus_cost else None,
                    near_worker_capacity=near_saturation, can_afford_nexus=affordable_base,
                    completed_upgrades=sorted(completed), preserved_air_plan=air_plan,
                    offensive_objective=objective)
    return StrategyDecision(StrategyOrder.from_dict(result), "adapted", tuple(reasons), evidence)
