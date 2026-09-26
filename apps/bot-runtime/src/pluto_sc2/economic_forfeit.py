"""Conservative local evidence for an unrecoverable zero-Probe economy.

Only the own HUD, public unit costs, prior accepted inputs, and the caller's
on-screen own units are consulted. Unknown off-screen queues never time out.
The guard suggests a forfeit; its caller owns leaving and recording the result.
"""
from __future__ import annotations

from dataclasses import dataclass
import math
from typing import Any

from sc2.dicts.unit_research_abilities import RESEARCH_INFO
from sc2.dicts.unit_train_build_abilities import TRAIN_INFO
from sc2.ids.ability_id import AbilityId
from sc2.ids.unit_typeid import UnitTypeId
from sc2.position import Point2


_PROBE = AbilityId.NEXUSTRAIN_PROBE.value
_PRODUCTIVE = {info["ability"].value for entries in TRAIN_INFO.values() for info in entries.values()}
_PRODUCTIVE.update(info["ability"].value for entries in RESEARCH_INFO.values() for info in entries.values())
_CONSTRUCTION = {info["ability"].value: kind for kind, info in TRAIN_INFO.get(UnitTypeId.PROBE, {}).items()}


@dataclass
class _Pending:
    ability: int
    source: int | None
    loop: int
    target: Point2 | None = None


def _orders(unit: Any) -> list[int]:
    proto = getattr(unit, "_proto", None)
    if proto is not None:
        return [int(order.ability_id) for order in proto.orders]
    result = []
    for order in getattr(unit, "orders", ()):
        ability = getattr(order, "ability", None)
        result.append(int(getattr(getattr(ability, "id", ability), "value", 0)))
    return result


class EconomicForfeitGuard:
    """Observe once per engine frame; return a JSON evidence dict or ``None``."""

    def __init__(self) -> None:
        self._audit_index = 0
        self._unresolved_selections: set[int] = set()
        self._pending: list[_Pending] = []
        self._unfinished: dict[int, Any] = {}
        self._visible_queues: dict[int, int] = {}
        self._observed_producers: dict[int, tuple[int, Any]] = {}
        self._previous_workers: float | None = None
        self._last_loop: int | None = None
        self._decision: dict | None = None

    @property
    def pending_probe_count(self) -> int:
        return sum(item.ability == _PROBE for item in self._pending)

    def _inputs(self, bot: Any, loop: int) -> None:
        audit = getattr(bot.fairplay, "audit", ())
        if len(audit) < self._audit_index:
            raise ValueError("Economic guard cannot reuse a reset input audit")
        for index in range(self._audit_index, len(audit)):
            event = audit[index]
            ability = event.get("ability")
            if ability not in _PRODUCTIVE:
                continue
            if event.get("kind") == "selection" and event.get("result") == [1]:
                self._unresolved_selections.add(index)
            if event.get("kind") != "command" or event.get("result") != [1]:
                continue
            sources = event.get("source_tags")
            linked = event.get("selection_audit_index")
            if not sources and isinstance(linked, int) and 0 <= linked < len(audit):
                sources = audit[linked].get("source_tags")
            # An accepted legacy command without source metadata remains
            # uncertain rather than inventing its producer from global units.
            sources = sources or [None]
            command_loop = int(event.get("game_loop", round(float(event.get("time", loop / 22.4)) * 22.4)))
            target = event.get("target")
            point = Point2(target) if isinstance(target, (list, tuple)) and len(target) == 2 else None
            for source in sources:
                self._pending.append(_Pending(int(ability), int(source) if source is not None else None,
                                              command_loop, point))
        self._audit_index = len(audit)
        self._unresolved_selections = {
            index for index in self._unresolved_selections
            if audit[index].get("command_confirmation") is None
            and audit[index].get("selection_confirmation") not in {"engine_rejected", "source_not_selected"}
            and not audit[index].get("command_abandoned")
        }

    @staticmethod
    def _position_visible(bot: Any, position: Any) -> bool:
        return bool(bot.fairplay.on_screen(position) and bot.is_visible(position))

    def observe(self, bot: Any, onscreenown: list[Any]) -> dict | None:
        loop = int(bot.state.game_loop)
        if self._last_loop is not None and loop < self._last_loop:
            raise ValueError("Economic guard observation moved backwards")
        if loop == self._last_loop:
            return self._decision
        self._decision = None
        self._inputs(bot, loop)
        workers, minerals = float(bot.supply_workers), float(bot.minerals)
        if not all(math.isfinite(value) and value >= 0 for value in (workers, minerals)):
            return None
        own = {int(unit.tag): unit for unit in onscreenown}
        orders = {tag: _orders(unit) for tag, unit in own.items()}

        # A producer that died in view cannot finish or refund its old queue.
        # Death IDs alone are not enough: the producer must have been on-screen
        # in the immediately previous observation, and that location must still
        # be visible on the current screen. Retain every off-screen ambiguity.
        dead = set(getattr(bot.state, "dead_units", ()))
        confirmed_dead = {
            tag for tag, (seen_loop, position) in self._observed_producers.items()
            if tag in dead and tag not in own and seen_loop == self._last_loop
            and self._position_visible(bot, position)
        }
        for tag in confirmed_dead:
            self._visible_queues.pop(tag, None)
            self._unfinished.pop(tag, None)
        self._observed_producers = {tag: (loop, unit.position) for tag, unit in own.items()}

        # A net HUD increase proves at most that many Probe completions. A
        # simultaneous birth and death with no increase proves nothing.
        births = max(0, int(workers - self._previous_workers)) if self._previous_workers is not None else 0
        retained = []
        for pending in self._pending:
            if pending.source in confirmed_dead and pending.ability not in _CONSTRUCTION:
                continue
            if births and pending.ability == _PROBE and pending.loop < loop:
                births -= 1
                continue
            producer = own.get(pending.source)
            if pending.ability in _CONSTRUCTION:
                if pending.target is not None and loop > pending.loop:
                    matches = [unit for unit in onscreenown if unit.type_id == _CONSTRUCTION[pending.ability]
                               and unit.position.distance_to(pending.target) < 1.5]
                    if any(unit.is_ready for unit in matches):
                        continue
                    # With no workers, an observed empty build site cannot
                    # hide a still-refundable structure or a future builder.
                    if (workers == 0 and not matches and self._position_visible(bot, pending.target)):
                        continue
            elif producer is not None and loop > pending.loop and not orders[pending.source]:
                continue  # Strictly later, visible queue proves completion/cancellation.
            retained.append(pending)
        self._pending = retained

        for tag, unit in own.items():
            if not unit.is_ready:
                self._unfinished[tag] = unit.position
            else:
                self._unfinished.pop(tag, None)
            if unit.is_structure and orders[tag]:
                self._visible_queues[tag] = loop
            elif tag in self._visible_queues and loop > self._visible_queues[tag]:
                self._visible_queues.pop(tag)
        for tag, position in list(self._unfinished.items()):
            if tag not in own and self._position_visible(bot, position):
                self._unfinished.pop(tag)

        self._previous_workers, self._last_loop = workers, loop
        data = getattr(getattr(bot, "game_data", None), "units", {}).get(UnitTypeId.PROBE.value)
        probe_cost = float(data._proto.mineral_cost) if data is not None else 50.0
        if not math.isfinite(probe_cost) or probe_cost <= 0:
            return None
        # A visible Probe with a stale zero HUD makes the observation ambiguous.
        if (workers != 0 or minerals >= probe_cost or any(unit.type_id == UnitTypeId.PROBE for unit in onscreenown)
                or self._pending or self._unfinished or self._visible_queues or self._unresolved_selections):
            return None
        self._decision = {
            "reason": "economic_forfeit_no_probes_or_recovery", "game_loop": loop,
            "workers": workers, "minerals": minerals, "probe_mineral_cost": probe_cost,
            "pending_probe_commands": 0, "known_refundable_work": 0,
            "evidence_scope": "Own HUD, accepted input history, and visible on-screen own queues/assets",
        }
        return self._decision
