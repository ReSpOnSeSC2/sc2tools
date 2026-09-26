"""Idempotent worker scouting over remembered, permitted observations only.

Only one designated Probe can scout per game, as requested by the user.
Repeated ``scout`` choices cannot successively empty the mineral line, even
after that Probe dies or returns to mining. The policy chooses every command;
non-worker scouts and the same on-screen designated Probe remain available.
"""
from __future__ import annotations

from typing import Any

from sc2.ids.ability_id import AbilityId
from sc2.ids.unit_typeid import UnitTypeId


_HARVEST = frozenset(ability.value for ability in (
    AbilityId.HARVEST_GATHER, AbilityId.HARVEST_GATHER_PROBE,
    AbilityId.HARVEST_RETURN, AbilityId.HARVEST_RETURN_PROBE,
))


def _is_probe(unit: Any) -> bool:
    return unit.type_id == UnitTypeId.PROBE


def _economic_order(unit: Any) -> bool:
    """Recognize explicit gather/return orders, never cargo alone or SMART."""
    proto = getattr(unit, "_proto", None)
    if proto is not None:
        ids = [int(order.ability_id) for order in proto.orders]
    else:
        ids = []
        for order in getattr(unit, "orders", ()):
            ability = getattr(order, "ability", None)
            value = getattr(ability, "id", ability)
            value = getattr(value, "value", value)
            if isinstance(value, int):
                ids.append(value)
    return bool(ids) and all(ability in _HARVEST for ability in ids)


class WorkerScoutLease:
    """Call observe each frame, choose at masking, selected after spatial issue.

    ``onscreenown`` and ``scout_candidates`` must already obey camera/visibility
    rules. This helper never inspects the bot's global unit collection or issues
    inputs. An unresolved off-screen scout has no timeout: its absence is not
    evidence that it died, returned, or became available for reassignment.
    """

    def __init__(self) -> None:
        self.tag: int | None = None
        self.designated_worker_tag: int | None = None
        self._pending_index: int | None = None
        self._command_loop: int | None = None
        self._onscreen_probe_tags: set[int] = set()
        self._onscreen_probe_positions: dict[int, Any] = {}
        self._last_seen_loop: int | None = None
        self._last_seen_position: Any = None
        self._last_observation_loop: int | None = None
        self._last_release: str | None = None

    def _clear(self, reason: str) -> None:
        self.tag = self._pending_index = self._command_loop = None
        self._last_seen_loop = None
        self._last_seen_position = None
        self._last_release = reason

    def observe(self, bot: Any, onscreenown: list[Any]) -> None:
        loop = int(bot.state.game_loop)
        if self._last_observation_loop is not None and loop < self._last_observation_loop:
            raise ValueError("Worker scout observation loop moved backwards")
        previous_loop = self._last_observation_loop
        self._onscreen_probe_tags = {int(unit.tag) for unit in onscreenown if _is_probe(unit)}
        self._onscreen_probe_positions = {int(unit.tag): unit.position for unit in onscreenown if _is_probe(unit)}
        if self._pending_index is not None:
            record = bot.fairplay.audit[self._pending_index]
            confirmation = record.get("command_confirmation")
            if confirmation is not None:
                self._pending_index = None
                if confirmation == "accepted":
                    self._command_loop = int(record["command_loop"])
                    self.designated_worker_tag = self.tag
                elif self._command_loop is None:
                    # Failed re-dispatch of an already active scout does not
                    # cancel that worker's earlier successful scouting order.
                    self._clear("dispatch_failed")
        visible = next((unit for unit in onscreenown if int(unit.tag) == self.tag), None)
        if self.tag is not None:
            if (self.tag in getattr(bot.state, "dead_units", ())
                    and self._last_seen_position is not None and self._last_seen_loop == previous_loop
                    and bot.is_visible(self._last_seen_position)
                    and bot.fairplay.on_screen(self._last_seen_position)):
                self._clear("observed_death")
            elif (visible is not None and self._pending_index is None and self._command_loop is not None
                  and loop > self._command_loop and _economic_order(visible)):
                self._clear("observed_economic_return")
            elif visible is not None:
                self._last_seen_loop = loop
                self._last_seen_position = visible.position
        self._last_observation_loop = loop

    def choose(self, scout_candidates: list[Any]) -> Any | None:
        eligible = [unit for unit in scout_candidates
                    if not _is_probe(unit) or (
                        (self.tag is None or int(unit.tag) == self.tag)
                        and (self.designated_worker_tag is None or int(unit.tag) == self.designated_worker_tag))]
        return min(eligible, key=lambda unit: unit.tag) if eligible else None

    def selected(self, bot: Any, source_tag: int, accepted: bool) -> None:
        """Remember only a newly accepted on-screen Probe spatial selection."""
        if not accepted or source_tag not in self._onscreen_probe_tags:
            return
        if self.tag is not None and source_tag != self.tag:
            raise ValueError("Cannot dispatch another worker while a scout lease is unresolved")
        if self.designated_worker_tag is not None and source_tag != self.designated_worker_tag:
            raise ValueError("Only the game's designated Probe may scout")
        if not bot.fairplay.audit:
            raise ValueError("Accepted scout selection has no input audit")
        index = len(bot.fairplay.audit) - 1
        record = bot.fairplay.audit[index]
        if (record.get("kind") != "selection" or record.get("source_tags") != [source_tag]
                or record.get("result") != [1] or record.get("ability") != AbilityId.MOVE_MOVE.value):
            raise ValueError("Scout lease requires its matching accepted spatial MOVE selection")
        self.tag = source_tag
        self._pending_index = index
        self._last_seen_loop = int(bot.state.game_loop)
        self._last_seen_position = self._onscreen_probe_positions[source_tag]

    def summary(self) -> dict:
        return {"worker_tag": self.tag, "designated_worker_tag": self.designated_worker_tag,
                "pending_selection_audit_index": self._pending_index,
                "command_loop": self._command_loop, "last_seen_loop": self._last_seen_loop,
                "last_release": self._last_release}
