"""Ordered, replay-derived construction intentions for a coached opening.

This planner consumes a frozen TRAIN candidate and permitted own-memory reports.
It has no filesystem, engine, map-query or action-sending access. Replay clocks
remain references: missing resources delay a step instead of bypassing legality.
"""
from __future__ import annotations

from collections import Counter
from collections.abc import Mapping
from dataclasses import asdict, dataclass
import math
import re
from typing import Any

from .coach_executor import _inventory, _kind, _point, _records
from .schema import BUILD_TYPES


BASE_ASSOCIATION_RADIUS = 14.0


def _base_positions(report: Mapping) -> dict[int, tuple[float, float]]:
    """Use only caller-supplied, observed base roles; ambiguous roles stay unknown."""
    positions: dict[int, tuple[float, float]] = {}
    ambiguous = set()
    for base in _records(report.get("opening_bases")):
        index, point = base.get("base_index"), _point(base.get("position"))
        if type(index) is not int or index < 0 or point is None:
            continue
        if index in positions and positions[index] != point:
            ambiguous.add(index)
        positions[index] = point
    return {index: point for index, point in positions.items() if index not in ambiguous}


def _nearest_base(position: Any, bases: Mapping[int, tuple[float, float]]) -> int | None:
    point = _point(position)
    if point is None or not bases:
        return None
    distances = sorted((math.dist(point, base), index) for index, base in bases.items())
    distance, index = distances[0]
    if distance > BASE_ASSOCIATION_RADIUS or (len(distances) > 1 and
            math.isclose(distance, distances[1][0], abs_tol=1e-6)):
        return None
    return index


def opening_base_index(report: Mapping, position: Any) -> int | None:
    """Associate an observed/accepted target with a known semantic base role."""
    return _nearest_base(position, _base_positions(report))


def _base_inventory(report: Mapping) -> dict[int, Counter]:
    bases = _base_positions(report)
    # Merge before filtering: a current record must invalidate a same-tag old
    # position even when the current position is at a different/unknown base.
    current = _records(report.get("current_own"))
    memory = _records(report.get("own_memory"))
    merged = {row.get("tag", ("memory", i)): row for i, row in enumerate(memory)}
    merged.update({row.get("tag", ("current", i)): row for i, row in enumerate(current)})
    counts = {}
    for index in bases:
        own = []
        for row in merged.values():
            orders = [order for order in _records(row.get("orders"))
                      if _nearest_base(order.get("target"), bases) == index]
            if (_kind(row.get("type", "")) in BUILD_TYPES and
                    _nearest_base(row.get("position"), bases) == index) or orders:
                own.append(dict(row, orders=orders))
        scoped = dict(report, own_memory=own, current_own=[], pending_construction=[
            row for row in _records(report.get("pending_construction"))
            if _nearest_base(row.get("position"), bases) == index])
        # Retain the normal alias and reservation/order/visible-asset dedup.
        counts[index] = _inventory(scoped)[0]
    return counts


@dataclass(frozen=True)
class OpeningStep:
    kind: str
    target_count: int
    seconds: float
    base_index: int | None = None

    @property
    def action(self) -> str:
        return "build_" + self.kind.lower()


@dataclass(frozen=True)
class OpeningDecision:
    action: str | None
    next_action: str | None
    due_at: float | None
    delay_seconds: float
    reserve: bool
    status: str
    step: int
    structure_quotas: dict[str, int]
    desired_gas_count: int
    desired_gas_by_base: dict[int, int]
    allow_expansion: bool
    next_base_index: int | None = None
    reason: str | None = None

    @property
    def active(self) -> bool:
        return self.status in {"active", "waiting"}

    def to_dict(self) -> dict[str, Any]:
        return {**asdict(self), "active": self.active}


def _seconds(value: Any, label: str) -> float:
    if isinstance(value, bool) or not isinstance(value, (int, float)) or not math.isfinite(value) or value < 0:
        raise ValueError(f"{label} must be finite and nonnegative")
    return float(value)


class OpeningPlan:
    """Follow construction starts, retaining original timing and actual delays."""

    def __init__(self, replay_id: str, matchup: str, label: str,
                 steps: tuple[OpeningStep, ...], *, reserve_lead_seconds: float = 10,
                 max_delay_seconds: float = 90, horizon_seconds: float = 240) -> None:
        self.replay_id, self.matchup, self.label = replay_id, matchup, label
        self.steps = steps
        self.reserve_lead_seconds = _seconds(reserve_lead_seconds, "Reserve lead")
        self.max_delay_seconds = _seconds(max_delay_seconds, "Maximum delay")
        self.horizon_seconds = _seconds(horizon_seconds, "Opening horizon")
        self._index = 0
        self._last_now = -1.0
        self._fallback_reason: str | None = None
        self.last_decision: OpeningDecision | None = None
        self.history: list[dict[str, Any]] = []

    @classmethod
    def from_candidate(cls, candidate: Mapping, train_ids, validation_ids, matchup: str,
                       horizon_seconds: float = 240, **kwargs) -> OpeningPlan:
        horizon = _seconds(horizon_seconds, "Opening horizon")
        enrichment = candidate.get("opening_enrichment")
        if isinstance(enrichment, Mapping) and horizon > _seconds(
                enrichment.get("horizon_seconds"), "Verified base-index horizon"):
            raise ValueError("Opening horizon exceeds verified base-index enrichment")
        train, validation = set(train_ids), set(validation_ids)
        if train & validation:
            raise ValueError("Opening TRAIN and validation replay sets overlap")
        replay_id = candidate.get("replay_id")
        if (not isinstance(replay_id, str) or not re.fullmatch(r"[0-9a-f]{64}", replay_id)
                or candidate.get("source_sha256") != replay_id or replay_id not in train
                or replay_id in validation or candidate.get("partition") != "train"):
            raise ValueError("Opening must identify a verified TRAIN replay")
        if (type(candidate.get("starting_workers")) is not int or candidate["starting_workers"] != 8
                or matchup not in {"PvT", "PvP", "PvZ"} or candidate.get("matchup") != matchup):
            raise ValueError("Opening requires eight workers and the selected matchup")
        events = candidate.get("milestone_events_first_10_minutes")
        if not isinstance(events, list):
            raise ValueError("Opening construction events are missing")
        # One initial Nexus is already present. Every replay start is another
        # structure; unit/upgrade completions are never interpreted as commands.
        totals = Counter({"NEXUS": 1})
        steps = []
        for event in events:
            if not isinstance(event, Mapping):
                raise ValueError("Malformed opening event")
            if event.get("meaning") != "construction_started":
                continue
            seconds = _seconds(event.get("seconds"), "Construction time")
            kind = str(event.get("name", "")).upper()
            if kind not in BUILD_TYPES:
                raise ValueError("Unsupported opening construction")
            if "game_loop" in event and abs(_seconds(event["game_loop"], "Game loop") / 22.4 - seconds) > .01:
                raise ValueError("Construction clock disagrees with its replay loop")
            if seconds == 0 or seconds > horizon:
                continue
            if steps and seconds < steps[-1].seconds:
                raise ValueError("Construction events must be chronological")
            base = event.get("base_index")
            if base is not None and (type(base) is not int or base < 0):
                raise ValueError("Base index must be a nonnegative integer when known")
            if isinstance(enrichment, Mapping) and kind == "ASSIMILATOR" and base is None:
                raise ValueError("Enriched opening gas construction is missing its verified base index")
            totals[kind] += 1
            steps.append(OpeningStep(kind, totals[kind], seconds, base))
        if not steps:
            raise ValueError("Opening has no construction starts in its horizon")
        return cls(replay_id, matchup, str(candidate.get("site_build_label") or replay_id[:12]),
                   tuple(steps), horizon_seconds=horizon, **kwargs)

    def _time(self, now: float) -> float:
        now = _seconds(now, "Opening time")
        if now < self._last_now:
            raise ValueError("Opening time cannot move backwards")
        self._last_now = now
        return now

    def _complete_step(self, now: float, via: str) -> None:
        step = self.steps[self._index]
        self.history.append({"step": self._index, "action": step.action,
                             "original_due_at": step.seconds, "observed_or_accepted_at": now,
                             "delay_seconds": max(0.0, now - step.seconds), "via": via,
                             **({"base_index": step.base_index,
                                 "target_count_at_base": self._base_target_count()}
                                if step.base_index is not None else {})})
        self._index += 1

    def _base_target_count(self) -> int:
        step = self.steps[self._index]
        return int(step.kind == "NEXUS" and step.base_index == 0) + sum(
            previous.kind == step.kind and previous.base_index == step.base_index
            for previous in self.steps[:self._index + 1])

    def _quotas(self, include_next: bool = False) -> tuple[dict[str, int], dict[int, int]]:
        quotas = {"NEXUS": 1}
        gases: Counter[int] = Counter()
        end = self._index + int(include_next and self._index < len(self.steps))
        for step in self.steps[:end]:
            quotas[step.kind] = step.target_count
            if step.kind == "ASSIMILATOR" and step.base_index is not None:
                gases[step.base_index] += 1
        return quotas, dict(gases)

    def decide(self, report: Mapping, legal: set[str], now: float,
               suspended: bool = False) -> OpeningDecision:
        now = self._time(now)
        if not suspended and self._fallback_reason is None:
            known, *_ = _inventory(report)
            by_base = _base_inventory(report)
            while self._index < len(self.steps):
                pending_step = self.steps[self._index]
                count = (known[pending_step.kind] if pending_step.base_index is None
                         else by_base.get(pending_step.base_index, Counter())[pending_step.kind])
                required = (pending_step.target_count if pending_step.base_index is None
                            else self._base_target_count())
                if count < required:
                    break
                self._complete_step(now, "observed_or_pending")
        step = self.steps[self._index] if self._index < len(self.steps) else None
        due = step is not None and now >= step.seconds
        quotas, gases = self._quotas(include_next=due and not suspended)
        if suspended:
            status, reason = "suspended", "Current scouting or defense override"
        elif self._fallback_reason is not None:
            status, reason = "fallback", self._fallback_reason
        elif step is None:
            status = "waiting" if now < self.horizon_seconds else "complete"
            reason = "Construction prefix complete; retain its quotas until the opening horizon" if status == "waiting" else None
        elif now - step.seconds > self.max_delay_seconds:
            self._fallback_reason = "Construction exceeded the opening delay bound; return to strategic macro"
            status, reason = "fallback", self._fallback_reason
        else:
            status, reason = ("active" if due else "waiting"), None
        active = status in {"active", "waiting"}
        self.last_decision = OpeningDecision(
            action=step.action if active and due and step.action in legal else None,
            next_action=step.action if step else None,
            due_at=step.seconds if step else self.horizon_seconds if active else None,
            delay_seconds=max(0.0, now - step.seconds) if step else 0.0,
            reserve=bool(active and step and now >= step.seconds - self.reserve_lead_seconds),
            status=status, step=self._index, structure_quotas=quotas,
            desired_gas_count=quotas.get("ASSIMILATOR", 0), desired_gas_by_base=gases,
            allow_expansion=bool(active and due and step and step.kind == "NEXUS"),
            next_base_index=step.base_index if step else None, reason=reason,
        )
        return self.last_decision

    def record_action(self, name: str, now: float, accepted: bool, *,
                      base_index: int | None = None) -> None:
        now = self._time(now)
        if (accepted and self.last_decision is not None and self.last_decision.active
                and self.last_decision.step == self._index and self._index < len(self.steps)
                and name == self.steps[self._index].action
                and (self.steps[self._index].base_index is None or
                     type(base_index) is int and base_index == self.steps[self._index].base_index)):
            self._complete_step(now, "accepted_input")

    def summary(self) -> dict[str, Any]:
        return {"profile": "replay-construction-opening-v1", "replay_id": self.replay_id,
                "matchup": self.matchup, "label": self.label, "steps": len(self.steps),
                "horizon_seconds": self.horizon_seconds,
                "completed_steps": self._index, "fallback_reason": self._fallback_reason,
                "history": [dict(item) for item in self.history]}
