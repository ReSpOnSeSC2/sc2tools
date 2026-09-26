"""Explicit user supply opening, separate from immutable replay references.

This pure planner consumes the permitted report. It issues no inputs and makes
no assertion that the supplied replay used these user-corrected instructions.
"""
from __future__ import annotations

from collections import Counter
from collections.abc import Mapping
from dataclasses import dataclass
import math
from typing import Any

from .coach_executor import _number, _records
from .coach_opening import OpeningDecision, OpeningPlan, OpeningStep, _base_inventory


PROFILE = "user-supply-opening-v1"
_SEQUENCE = (("PYLON", 1, 12, 0), ("GATEWAY", 1, 14, 0), ("NEXUS", 2, 17, 1),
             ("ASSIMILATOR", 1, 17, 0), ("CYBERNETICSCORE", 1, 17, 0),
             ("ASSIMILATOR", 2, 17, 0), ("PYLON", 2, 17, 1))


@dataclass(frozen=True)
class SupplyOpeningDecision(OpeningDecision):
    supply_threshold: int | None = None
    worker_supply_cap: int | None = None
    pause_probe_production: bool = False
    hold_optional_army: bool = False
    allow_emergency_pylon: bool = True
    core_foundation_observed: bool = False
    prioritize_due_construction: bool = False


class SupplyOpeningPlan(OpeningPlan):
    """12 Pylon,14 Gateway,17 Nexus/gas/Core, then gas2/natural Pylon.

    The HUD's used supply includes queued reservations. Reaching17 latches a
    worker-production pause even if a scouting Probe is subsequently lost.
    Only observed Core construction, not an accepted build input, releases it.
    A per-stage90-second deadline bounds resource, placement and supply stalls.
    """

    def __init__(self, *, reference: OpeningPlan | None = None,
                 max_delay_seconds: float = 90) -> None:
        super().__init__("", reference.matchup if reference else "PvT", "User supply opening",
                         tuple(OpeningStep(kind, count, 0, base) for kind, count, _, base in _SEQUENCE),
                         reserve_lead_seconds=0, max_delay_seconds=max_delay_seconds, horizon_seconds=0)
        if not 0 < self.max_delay_seconds <= 180:
            raise ValueError("Supply-opening maximum delay must be in (0,180]")
        self.reference = reference
        self._stage_entered: float | None = None
        self._threshold_reached: float | None = None
        self._seventeen_reached = False
        self._core_observed = False
        self._core_input: dict[str, Any] | None = None

    @classmethod
    def from_config(cls, config: Mapping, *, reference: OpeningPlan | None = None) -> SupplyOpeningPlan:
        if (not isinstance(config, Mapping) or type(config.get("schema")) is not int
                or config["schema"] != 1 or config.get("profile") != PROFILE
                or set(config) - {"schema", "profile", "max_delay_seconds"}):
            raise ValueError("Invalid explicit user supply-opening configuration")
        return cls(reference=reference, max_delay_seconds=config.get("max_delay_seconds", 90))

    def _complete_step(self, now: float, via: str) -> None:
        step = self.steps[self._index]
        self.history.append({"step": self._index, "action": step.action, "base_index": step.base_index,
                             "target_count_at_base": self._base_target_count(),
                             "supply_threshold": _SEQUENCE[self._index][2],
                             "threshold_reached_at": self._threshold_reached,
                             "observed_or_accepted_at": now,
                             "delay_seconds": max(0.0, now - self._threshold_reached)
                                 if self._threshold_reached is not None else 0.0,
                             "via": via})
        self._index += 1
        self._stage_entered = now
        self._threshold_reached = None

    def decide(self, report: Mapping, legal: set[str], now: float,
               suspended: bool = False) -> SupplyOpeningDecision:
        now = self._time(now)
        if self._stage_entered is None:
            self._stage_entered = now
        used = _number(report.get("hud", {}).get("supply_used"), math.nan)
        if math.isfinite(used) and used >= 17:
            self._seventeen_reached = True
        # Orders/reservations are not observed foundations. Keep them out of
        # this one proof even though other steps retain ordinary pending dedup.
        actual = dict(report, pending_construction=[], **{
            field: [dict(row, orders=[]) for row in _records(report.get(field))]
            for field in ("own_memory", "current_own")})
        actual_by_base = _base_inventory(actual)
        self._core_observed |= actual_by_base.get(0, Counter())["CYBERNETICSCORE"] > 0
        if not suspended and self._fallback_reason is None:
            counts = _base_inventory(report)
            while self._index < len(self.steps):
                step = self.steps[self._index]
                reached = ((math.isfinite(used) and used >= _SEQUENCE[self._index][2])
                           or self._index >= 2 and self._seventeen_reached)
                if reached and self._threshold_reached is None:
                    self._threshold_reached = now
                observed = actual_by_base if step.kind == "CYBERNETICSCORE" else counts
                if observed.get(step.base_index, Counter())[step.kind] < self._base_target_count():
                    break
                self._complete_step(now, "observed_foundation" if step.kind == "CYBERNETICSCORE"
                                    else "observed_or_pending")
        step = self.steps[self._index] if self._index < len(self.steps) else None
        due = bool(step and self._threshold_reached is not None)
        if self._fallback_reason is None and step and now - self._stage_entered > self.max_delay_seconds:
            self._fallback_reason = "Supply opening exceeded its stage delay bound; return to strategic macro"
        if self._fallback_reason:
            status, reason = "fallback", self._fallback_reason
        elif step is None:
            status, reason = "complete", None
        elif suspended:
            status, reason = "suspended", "Current scouting or defense override"
        else:
            status, reason = ("active" if due else "waiting"), None
        active = status in {"active", "waiting"}
        unfinished = status not in {"complete", "fallback"}
        quotas, gases = self._quotas(include_next=due and active)
        cap = 17 if unfinished and not self._core_observed else None
        pause = bool(unfinished and self._seventeen_reached and not self._core_observed)
        self.last_decision = SupplyOpeningDecision(
            action=step.action if step and active and due and step.action in legal else None,
            next_action=step.action if step else None, due_at=self._threshold_reached,
            delay_seconds=max(0.0, now - self._threshold_reached) if due else 0.0,
            reserve=bool(active and due), status=status, step=self._index,
            structure_quotas=quotas, desired_gas_count=quotas.get("ASSIMILATOR", 0),
            desired_gas_by_base=gases, allow_expansion=bool(active and due and step.kind == "NEXUS"),
            next_base_index=step.base_index if step else None, reason=reason,
            supply_threshold=_SEQUENCE[self._index][2] if step else None,
            worker_supply_cap=cap, pause_probe_production=pause,
            hold_optional_army=bool(active and not self._core_observed),
            allow_emergency_pylon=not unfinished,
            core_foundation_observed=self._core_observed,
            prioritize_due_construction=bool(active and due and self._index < 2))
        return self.last_decision

    def record_action(self, name: str, now: float, accepted: bool, *,
                      base_index: int | None = None) -> None:
        now = self._time(now)
        if (accepted and self.last_decision is not None and self.last_decision.active
                and self.last_decision.step == self._index and self._index < len(self.steps)
                and self._threshold_reached is not None and name == self.steps[self._index].action
                and type(base_index) is int and base_index == self.steps[self._index].base_index):
            if name == "build_cyberneticscore":
                self._core_input = {"accepted_at": now, "base_index": base_index,
                                    "waiting_for": "observed_own_core_foundation"}
            else:
                self._complete_step(now, "accepted_input")

    def summary(self) -> dict[str, Any]:
        return {"profile": PROFILE, "source": "explicit_user_instruction", "label": self.label,
                "matchup": self.matchup, "steps": len(self.steps), "completed_steps": self._index,
                "timing_basis": "HUD supply_used including queued reservations; not replay clocks",
                "sequence": [{"action": "build_" + kind.lower(), "supply": supply,
                              "global_target_count": count, "base_index": base}
                             for kind, count, supply, base in _SEQUENCE],
                "stage_entered_at": self._stage_entered, "maximum_stage_delay_seconds": self.max_delay_seconds,
                "seventeen_supply_reached": self._seventeen_reached,
                "core_foundation_observed": self._core_observed,
                "accepted_core_input": dict(self._core_input) if self._core_input else None,
                "fallback_reason": self._fallback_reason, "history": [dict(row) for row in self.history],
                "reference_opening": self.reference.summary() if self.reference else None}
