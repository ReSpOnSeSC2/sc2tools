"""Deterministic bootstrap execution of strategic orders from permitted memory.

This module consumes JSON-like reports and legal action names. It has no live
game access and issues no inputs. Static SC2 dictionaries only decode the public
meaning of orders. Old mobile sightings and queues have bounded influence on
production quotas; the underlying last-seen records remain unchanged. Cameras,
scouting and expansion are the caller's responsibility.
"""
from __future__ import annotations

from collections import Counter
from collections.abc import Mapping
import math
from typing import Any

from sc2.dicts.unit_research_abilities import RESEARCH_INFO
from sc2.dicts.unit_train_build_abilities import TRAIN_INFO


STRATEGIC_INTERVAL = 5.0
CHRONO_INTERVAL = 20.0
RESEARCH_INTERVAL = 20.0
NEXUS_WORKER_CUT_SECONDS = 8.0
MOBILE_QUOTA_MEMORY_SECONDS = 60.0
QUEUE_MEMORY_SECONDS = 120.0
MAX_QUEUE_MEMORY_SECONDS = 300.0
FIRST_STALKER_DEADLINE_SECONDS = 300.0
_STRATEGIC = frozenset(("attack_enemy_base", "attack_visible_enemy", "defend", "retreat"))
_ALIASES = {"WARPGATE": "GATEWAY", "WARPPRISMPHASING": "WARPPRISM", "OBSERVERSIEGEMODE": "OBSERVER"}
_DEPENDENCIES = {
    "PYLON": (), "GATEWAY": ("PYLON",), "CYBERNETICSCORE": ("GATEWAY",),
    "FORGE": ("PYLON",), "TWILIGHTCOUNCIL": ("CYBERNETICSCORE",),
    "ROBOTICSFACILITY": ("CYBERNETICSCORE",), "STARGATE": ("CYBERNETICSCORE",),
    "ROBOTICSBAY": ("ROBOTICSFACILITY",), "FLEETBEACON": ("STARGATE",),
    "TEMPLARARCHIVE": ("TWILIGHTCOUNCIL",), "DARKSHRINE": ("TWILIGHTCOUNCIL",),
    "PHOTONCANNON": ("FORGE",), "SHIELDBATTERY": ("CYBERNETICSCORE",),
}
_MACRO_BUILDINGS = frozenset(("NEXUS", "PYLON", "ASSIMILATOR"))
_PRODUCES = {int(info["ability"].value): unit.name
             for entries in TRAIN_INFO.values() for unit, info in entries.items()}
_RESEARCHES = {int(info["ability"].value): upgrade.name
              for entries in RESEARCH_INFO.values() for upgrade, info in entries.items()}
_UNIT_REQUIREMENTS: dict[str, tuple[str, ...]] = {}
for _producer, _entries in TRAIN_INFO.items():
    if _producer.name in {"GATEWAY", "ROBOTICSFACILITY", "STARGATE"}:
        for _unit, _info in _entries.items():
            _UNIT_REQUIREMENTS[_unit.name] = (_producer.name,) + (
                (_info["required_building"].name,) if "required_building" in _info else ())
_RESEARCH_PRODUCERS = {upgrade.name: producer.name for producer, entries in RESEARCH_INFO.items()
                       for upgrade in entries if producer.name in _DEPENDENCIES}


def _field(value: Any, key: str, default: Any = None) -> Any:
    return value.get(key, default) if isinstance(value, Mapping) else getattr(value, key, default)


def _number(value: Any, default: float = 0) -> float:
    return float(value) if isinstance(value, (int, float)) and not isinstance(value, bool) and math.isfinite(value) else default


def _kind(value: Any) -> str:
    name = str(value).upper()
    return _ALIASES.get(name, name)


def _records(value: Any) -> list[dict]:
    values = value.values() if isinstance(value, Mapping) else value or ()
    return [item for item in values if isinstance(item, Mapping)]


def _point(value: Any) -> tuple[float, float] | None:
    if isinstance(value, Mapping):
        value = value.get("position")
    if isinstance(value, (list, tuple)) and len(value) == 2:
        if all(isinstance(v, (int, float)) and not isinstance(v, bool) and math.isfinite(v) for v in value):
            return float(value[0]), float(value[1])
    return None


def _near(a: Any, b: Any) -> bool:
    first, second = _point(a), _point(b)
    return first is not None and second is not None and math.dist(first, second) < 1.5


def _cost(value: Any) -> tuple[float, float] | None:
    if not isinstance(value, Mapping):
        return None
    values = tuple(_number(value.get(key), math.nan) for key in ("minerals", "vespene"))
    return values if all(math.isfinite(number) and number >= 0 for number in values) else None


def _construction_budget(report: Mapping, next_action: str | None, spending_action: str) -> tuple[bool, bool]:
    """Return (spending crosses known budget, small resource gap).

    Unknown public costs never become a reason to freeze production. The caller
    supplies costs from the current game's data, not assumed ladder prices.
    """
    next_cost = report.get("opening_next_cost")
    if not isinstance(next_cost, Mapping) or next_cost.get("action") != next_action:
        return False, False
    construction = _cost(next_cost)
    action_costs = report.get("action_costs", {})
    spending = _cost(action_costs.get(spending_action)) if isinstance(action_costs, Mapping) else None
    hud = report.get("hud", {})
    available = _cost(hud)
    if construction is None or spending is None or available is None:
        return False, False
    crosses = any(have - spend < need for have, spend, need in zip(available, spending, construction))
    small_gap = available[0] >= construction[0] - 2 * spending[0] and available[1] >= construction[1]
    return crosses, small_gap


def _name(order: Mapping, field: str, table: dict[int, str]) -> str | None:
    value = order.get(field)
    if isinstance(value, str):
        return _kind(value)
    ability = order.get("ability_id")
    return _kind(table[ability]) if isinstance(ability, int) and ability in table else None


def _memory_age(report: Mapping, record: Mapping, current_tags: set) -> float:
    if record.get("tag") in current_tags:
        return 0.0
    now = _number(report.get("time"), math.nan)
    seen = _number(record.get("last_seen_seconds"), math.nan)
    # Legacy reports lacking a timestamp retain their conservative behavior.
    return max(0.0, now - seen) if math.isfinite(now) and math.isfinite(seen) else 0.0


def _queue_memory_seconds(report: Mapping, record: Mapping) -> float:
    costs = report.get("action_costs", {})
    duration = 0.0
    for queued in _records(record.get("orders")):
        research = _name(queued, "researches", _RESEARCHES)
        unit = _name(queued, "produces", _PRODUCES)
        if research:
            action = "research_" + research.lower()
        elif unit and unit not in _DEPENDENCIES and unit not in _MACRO_BUILDINGS:
            action = "train_" + unit.lower()
        else:
            continue
        cost = costs.get(action, {}) if isinstance(costs, Mapping) else {}
        seconds = _number(cost.get("time_seconds"), math.nan) if isinstance(cost, Mapping) else math.nan
        if not math.isfinite(seconds) or seconds <= 0:
            return QUEUE_MEMORY_SECONDS
        duration += seconds
    # Allow a full observed queue plus scheduling margin. A paused/cancelled
    # off-screen queue cannot retain a quota forever; it remains in raw memory.
    return min(MAX_QUEUE_MEMORY_SECONDS, max(30.0, duration + 20.0)) if duration else QUEUE_MEMORY_SECONDS


def _army_supply_target_met(report: Mapping, composition: Mapping) -> bool:
    costs = report.get("action_costs", {})
    target_supply = 0.0
    for unit, target in composition.items():
        if target <= 0 or unit == "PROBE":
            continue
        cost = costs.get("train_" + unit.lower(), {}) if isinstance(costs, Mapping) else {}
        supply = _number(cost.get("supply"), math.nan) if isinstance(cost, Mapping) else math.nan
        if not math.isfinite(supply) or supply <= 0:
            return False
        target_supply += target * supply
    # HUD supply is current, human-visible aggregate evidence. This does not
    # assign types or deaths to unseen units, and includes reserved army supply.
    actual = _number(report.get("hud", {}).get("supply_army"), math.nan)
    return target_supply > 0 and math.isfinite(actual) and actual >= target_supply


def _inventory(report: Mapping) -> tuple[Counter, Counter, Counter, set[str], list[dict]]:
    # Illusions remain in raw screen memory for scouting but never satisfy
    # production/composition quotas or contribute remembered production orders.
    current = [record for record in _records(report.get("current_own")) if not record.get("is_hallucination", False)]
    records = [record for record in _records(report.get("own_memory")) if not record.get("is_hallucination", False)]
    # Current permitted observations supersede the same tag's old memory.
    merged = {record.get("tag", ("memory", index)): record for index, record in enumerate(records)}
    merged.update({record.get("tag", ("current", index)): record for index, record in enumerate(current)})
    own = list(merged.values())
    current_tags = {record.get("tag") for record in current if record.get("tag") is not None}
    known, ready, pending = Counter(), Counter(), Counter()
    for record in own:
        name = _kind(record.get("type", ""))
        mobile = (name != "PROBE" and name not in _DEPENDENCIES and name not in _MACRO_BUILDINGS
                  and not record.get("is_structure", False))
        if mobile and _memory_age(report, record, current_tags) > MOBILE_QUOTA_MEMORY_SECONDS:
            continue
        known[name] += 1
        if record.get("is_ready", False):
            ready[name] += 1
        else:
            pending[name] += 1

    # Commands accepted by the spatial controller may precede the first
    # observation of the structure. Match both build orders and visible assets
    # so one reservation cannot become two expected structures.
    constructions: list[dict] = []
    for reservation in _records(report.get("pending_construction")):
        name = _kind(reservation.get("type", ""))
        if any(item["type"] == name and _near(item.get("position"), reservation.get("position"))
               for item in constructions):
            continue
        if not any(_kind(record.get("type", "")) == name and _near(record.get("position"), reservation.get("position"))
                   for record in own):
            constructions.append(dict(reservation, type=name))
    researches: set[str] = set()
    for record in own:
        queue_current = _memory_age(report, record, current_tags) <= _queue_memory_seconds(report, record)
        for queued in _records(record.get("orders")):
            research = _name(queued, "researches", _RESEARCHES)
            if research and queue_current:
                researches.add(research)
            name = _name(queued, "produces", _PRODUCES)
            if not name:
                continue
            if name in _DEPENDENCIES or name in _MACRO_BUILDINGS:
                position = _point(queued.get("target"))
                if any(_kind(asset.get("type", "")) == name and _near(asset.get("position"), position) for asset in own):
                    continue
                if any(item["type"] == name and (_near(item.get("position"), position)
                       or item.get("source_tag") == record.get("tag")) for item in constructions):
                    continue
                constructions.append({"type": name, "position": position, "source_tag": record.get("tag")})
            else:
                if queue_current:
                    known[name] += 1
                    pending[name] += 1
    for item in constructions:
        known[item["type"]] += 1
        pending[item["type"]] += 1
    return known, ready, pending, researches, current


class CoachExecutor:
    """Choose one legal intent without inspecting or changing the game."""

    def __init__(self, opening: Any = None) -> None:
        self._last_strategic = -math.inf
        self._last_chrono = -math.inf
        self._last_research = -math.inf
        self.opening = opening
        self.opening_decision = None
        self._first_stalker_evidence = None
        self.opening_army_priority = None

    @staticmethod
    def _time(now: float) -> float:
        if isinstance(now, bool) or not isinstance(now, (int, float)) or not math.isfinite(now) or now < 0:
            raise ValueError("Executor time must be finite and nonnegative")
        return float(now)

    def record_action(self, name: str, now: float, accepted: bool, *,
                      base_index: int | None = None) -> None:
        now = self._time(now)
        if self.opening is not None:
            self.opening.record_action(name, now, accepted, base_index=base_index)
        if accepted:
            if name == "train_stalker" and self._first_stalker_evidence is None:
                self._first_stalker_evidence = {"source": "accepted_command", "game_seconds": now}
            if name in _STRATEGIC:
                self._last_strategic = max(self._last_strategic, now)
            elif name == "chrono_boost":
                self._last_chrono = max(self._last_chrono, now)
            elif name.startswith("research_"):
                self._last_research = max(self._last_research, now)

    def choose_action(self, order: Any, report: Mapping, legal: set[str], now: float) -> str:
        now = self._time(now)
        known, ready, pending, researching, current = _inventory(report)
        hud = report.get("hud", {})
        enemies = _records(report.get("current_enemies"))
        strategic_ready = now - self._last_strategic >= STRATEGIC_INTERVAL
        stance = _field(order, "stance", "defend")
        explicit = report.get("explicit_supply_opening") is True
        if explicit and known["STALKER"] and self._first_stalker_evidence is None:
            self._first_stalker_evidence = {"source": "permitted_unit_or_production_observation",
                                            "game_seconds": now}
        first_stalker = (explicit and known["CYBERNETICSCORE"] > 0 and self._first_stalker_evidence is None
                         and now < FIRST_STALKER_DEADLINE_SECONDS
                         and not report.get("defense_alert") and stance != "retreat")
        held = set()
        if first_stalker:
            # The explicit opening commits its first fighting unit before
            # elective infrastructure. Workers, supply, gas and the original
            # Core sequence retain their existing priority and legal checks.
            held = {name for name in legal if (name.startswith("train_")
                    and name not in {"train_probe", "train_stalker"}) or name.startswith("research_")
                    or (name.startswith("build_") and name not in {
                        "build_pylon", "build_nexus", "build_assimilator", "build_cyberneticscore"}
                        and not (name == "build_gateway" and not known["GATEWAY"]))}
            legal = legal - held
        self.opening_army_priority = {"enabled": explicit, "active": bool(first_stalker),
            "status": ("disabled" if not explicit else "committed" if self._first_stalker_evidence
                       else "deadline_reached" if now >= FIRST_STALKER_DEADLINE_SECONDS
                       else "defense_override" if report.get("defense_alert") or stance == "retreat"
                       else "first_stalker_pending" if first_stalker else "waiting_for_core_foundation"),
            "deadline_game_seconds": FIRST_STALKER_DEADLINE_SECONDS, "held_actions": sorted(held),
            "first_stalker_evidence": self._first_stalker_evidence,
            "base_defense_override": bool(report.get("defense_alert") or stance == "retreat"),
            "worker_production_paused": False}
        self.opening_decision = (self.opening.decide(report, legal, now, suspended=bool(
            enemies or stance == "retreat" or report.get("opening_suspended", False)))
            if self.opening is not None else None)
        opening_active = self.opening_decision is not None and self.opening_decision.active
        opening_due = (opening_active and self.opening_decision.next_action is not None
                       and self.opening_decision.due_at is not None and now >= self.opening_decision.due_at)
        opening_lateness = self.opening_decision.delay_seconds if opening_due else math.inf
        opening_reserving = (opening_active and self.opening_decision.reserve
                             and self.opening_decision.next_action is not None)
        def reserve_training(action: str) -> bool:
            if action == "train_probe":
                if getattr(self.opening_decision, "pause_probe_production", False):
                    return True
                cap = getattr(self.opening_decision, "worker_supply_cap", None)
                if cap is not None:
                    used = _number(hud.get("supply_used"), math.nan)
                    probe = report.get("action_costs", {}).get("train_probe", {})
                    supply = _number(probe.get("supply"), 1.0)
                    if not math.isfinite(used) or supply <= 0 or used + supply > cap:
                        return True
            elif action.startswith("train_") and getattr(self.opening_decision, "hold_optional_army", False):
                return True
            if not opening_reserving or action == "train_probe" and not opening_due:
                return False
            crosses, small_gap = _construction_budget(report, self.opening_decision.next_action, action)
            if action == "train_probe":
                return (self.opening_decision.next_action == "build_nexus" and small_gap and crosses
                        and opening_lateness < NEXUS_WORKER_CUT_SECONDS)
            # Optional units/research cannot repeatedly spend the next opening
            # structure's budget just because that structure is already late.
            # The opening's existing maximum-delay fallback bounds this hold;
            # visible threats suspend it, and spare funds remain spendable.
            return crosses
        if enemies:
            weak_stalker = any(_kind(unit.get("type", "")) == "STALKER"
                and _number(unit.get("shield_max")) > 0
                and _number(unit.get("shield")) / _number(unit.get("shield_max")) <= .25 for unit in current)
            if weak_stalker and "blink_retreat" in legal:
                return "blink_retreat"
            if strategic_ready and stance != "retreat" and "attack_visible_enemy" in legal:
                return "attack_visible_enemy"
        if stance == "retreat" and strategic_ready and "retreat" in legal:
            return "retreat"
        if "harvest_minerals" in legal and any(_kind(unit.get("type", "")) == "PROBE"
                                               and unit.get("is_idle", False) for unit in current):
            return "harvest_minerals"
        bases = known["NEXUS"]
        ready_production = sum(ready[kind] for kind in ("GATEWAY", "ROBOTICSFACILITY", "STARGATE"))
        supply_buffer = max(6, 2 * ready["NEXUS"] + 2 * ready_production)
        # During a replay opening, timed Pylons provide the normal buffer;
        # only an imminent block overrides their order early.
        supply_threshold = 2 if opening_active else supply_buffer
        # One pending Pylon is only eight planned supply. It cannot cover a
        # whole large production cycle; do not let it veto every further Pylon.
        pending_supply = 8 * pending["PYLON"]
        if (_number(hud.get("supply_left")) <= supply_threshold
                and getattr(self.opening_decision, "allow_emergency_pylon", True)
                and _number(hud.get("supply_cap")) + pending_supply < 200
                and (not pending_supply or _number(hud.get("supply_left")) + pending_supply < supply_threshold)
                and "build_pylon" in legal):
            return "build_pylon"
        if (getattr(self.opening_decision, "prioritize_due_construction", False)
                and self.opening_decision.action is not None):
            return self.opening_decision.action
        worker_target = min(max(0, _number(_field(order, "worker_target", 16))), 22 * bases)
        workers = _number(hud.get("supply_workers"))
        idle_nexus = any(_kind(unit.get("type", "")) == "NEXUS" and unit.get("is_ready", False)
                         and unit.get("is_idle", False) and not unit.get("orders") for unit in current)
        candidates = report.get("group_production_candidates")
        grouped_nexus = isinstance(candidates, list) and "train_probe" in candidates
        if (not reserve_training("train_probe") and workers + pending["PROBE"] < worker_target
                and (idle_nexus or grouped_nexus) and "train_probe" in legal):
            return "train_probe"
        gas_per_base = max(0, _number(_field(order, "gas_workers_per_base", 0)))
        gases = [unit for unit in current if _kind(unit.get("type", "")) == "ASSIMILATOR" and unit.get("is_ready", False)]
        assigned_gas = sum(_number(unit.get("assigned_harvesters")) for unit in gases)
        if (workers >= 12 and ready["GATEWAY"] and gases
                and assigned_gas < gas_per_base * ready["NEXUS"] and "harvest_gas" in legal):
            return "harvest_gas"
        # Execute an affordable, due replay construction before optional army
        # or upgrades. Workers and urgent supply/mining retain priority; Nexus
        # placement remains the caller's visible expansion sequence.
        if (opening_active and self.opening_decision.action is not None
                and self.opening_decision.action != "build_nexus"):
            return self.opening_decision.action
        if (report.get("opening_chrono_priority") is True and "chrono_boost" in legal
                and now - self._last_chrono >= CHRONO_INTERVAL):
            return "chrono_boost"
        if first_stalker and "train_stalker" in legal and not reserve_training("train_stalker"):
            return "train_stalker"
        gas_construction = (not opening_active and workers >= 12 and known["GATEWAY"]
                and known["ASSIMILATOR"] < math.ceil(gas_per_base / 3) * ready["NEXUS"]
                and "build_assimilator" in legal)
        completed_upgrades = {_kind(name) for name in report.get("upgrades", ())}
        # Warp Gate is core Gateway production infrastructure. Its legal action
        # already proves current-screen Core readiness, tech and affordability;
        # do not starve it behind every optional building or composition quota.
        # Visible combat and urgent supply/economy inputs retain priority.
        if not enemies:
            if (order is not None and ready["CYBERNETICSCORE"]
                    and "WARPGATERESEARCH" not in completed_upgrades
                    and "WARPGATERESEARCH" not in researching
                    and "research_warpgateresearch" in legal
                    and not reserve_training("research_warpgateresearch")):
                return "research_warpgateresearch"
        composition = {_kind(kind): int(max(0, _number(count)))
                       for kind, count in (_field(order, "composition", {}) or {}).items()}
        production = {_kind(kind): int(max(0, _number(count)))
                      for kind, count in (_field(order, "production_targets", {}) or {}).items()
                      if _kind(kind) in _DEPENDENCIES and _kind(kind) not in _MACRO_BUILDINGS}
        research = tuple(_kind(name) for name in (_field(order, "research", ()) or ()))
        for unit, count in composition.items():
            if count > 0:
                for building in _UNIT_REQUIREMENTS.get(unit, ()):
                    production[building] = max(1, production.get(building, 0))
        for upgrade in research:
            building = _RESEARCH_PRODUCERS.get(upgrade)
            if building:
                production[building] = max(1, production.get(building, 0))
        def require(building: str) -> None:
            for dependency in _DEPENDENCIES.get(building, ()):
                production[dependency] = max(1, production.get(dependency, 0))
                require(dependency)
        for building, target in list(production.items()):
            if target > 0:
                require(building)
        # Obtain the first necessary tech building before adding extra copies.
        # Unfinished structures and unresolved build commands satisfy quantity,
        # but cannot satisfy readiness of a later prerequisite.
        construction_action = None
        for first_copy in (True, False):
            for building, dependencies in _DEPENDENCIES.items():
                target = production.get(building, 0)
                action = "build_" + building.lower()
                if ((known[building] == 0 if first_copy else known[building] > 0)
                        and not opening_active
                        and known[building] < target and all(ready[kind] for kind in dependencies)
                        and action in legal and construction_action is None):
                    construction_action = action
        # Relative shortage maintains requested mixed compositions instead of
        # filling the first listed unit's entire quota before starting another.
        # One confirmed research input per interval gets a turn before routine
        # army shortages. Otherwise an affordable, permanently replenished
        # composition can starve every requested upgrade for the whole game.
        # Urgent supply/workers/gas/combat have already had priority, and the
        # replay construction opening remains protected. Exact current-game
        # prices leave one affordable requested army unit in reserve.
        if (not opening_active and not enemies and stance != "retreat"
                and now - self._last_research >= RESEARCH_INTERVAL):
            costs = report.get("action_costs", {})
            costs = costs if isinstance(costs, Mapping) else {}
            army_prices = [_cost(costs.get("train_" + unit.lower()))
                           for unit, target in composition.items()
                           if target > known[unit] and "train_" + unit.lower() in legal]
            army_prices = [price for price in army_prices if price is not None]
            reserve = min(army_prices, key=lambda price: price[0] + 1.5 * price[1]) if army_prices else (0, 0)
            available = _cost(hud)
            for upgrade in research:
                action = "research_" + upgrade.lower()
                price = _cost(costs.get(action))
                if (upgrade not in completed_upgrades and upgrade not in researching and action in legal
                        and price is not None and available is not None
                        and all(have >= spend + keep for have, spend, keep in zip(available, price, reserve))):
                    return action
        shortages = sorted((-(target - known[unit]) / target, unit) for unit, target in composition.items()
                           if target > known[unit] and target > 0)
        army_target_met = _army_supply_target_met(report, composition)
        for _shortage, unit in shortages:
            action = "train_" + unit.lower()
            if action in legal and not (army_target_met and unit != "PROBE") and not reserve_training(action):
                return action
        if gas_construction:
            return "build_assimilator"
        if construction_action is not None:
            return construction_action
        for upgrade in research:
            action = "research_" + upgrade.lower()
            if upgrade == "WARPGATERESEARCH":
                # Handled above, with a current-threat gate even if a coach
                # explicitly listed the upgrade in the strategic order.
                continue
            if (upgrade not in completed_upgrades and upgrade not in researching and action in legal
                    and not reserve_training(action)):
                return action
        if "chrono_boost" in legal and now - self._last_chrono >= CHRONO_INTERVAL:
            return "chrono_boost"
        if strategic_ready:
            if enemies and stance != "retreat" and "defend" in legal:
                return "defend"
            if (order is not None and stance in {"attack", "pressure"}
                    and _number(hud.get("supply_army")) >= 6 and "attack_enemy_base" in legal):
                return "attack_enemy_base"
        return "no_op"
