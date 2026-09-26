"""First two Chrono timing gates for the explicit coached opening.

This helper supplies eligible target tags but never casts spells. The caller observes only
its current camera's own units and records final, accepted spatial commands.
It leaves cooldown, energy, target legality and all third/later casts to the
ordinary executor. Enemy, global unit and offscreen production data are unused.
"""
from __future__ import annotations

import math
from numbers import Real

from sc2.ids.ability_id import AbilityId as A


PROBE_ABILITY = A.NEXUSTRAIN_PROBE.value
STALKER_ABILITIES = {A.GATEWAYTRAIN_STALKER.value, A.WARPGATETRAIN_STALKER.value}


def _number(value):
    return (float(value) if isinstance(value, Real) and not isinstance(value, bool)
            and math.isfinite(value) else None)


def _kind(unit):
    return getattr(getattr(unit, "type_id", None), "name", None)


def _current_own(unit):
    # Check screen/ownership before orders or any other production field.
    return (getattr(unit, "is_on_screen", False) and getattr(unit, "is_visible", False)
            and not getattr(unit, "is_snapshot", False) and getattr(unit, "is_mine", False)
            and not getattr(unit, "is_hallucination", False))


def _orders(unit):
    proto = getattr(unit, "_proto", None)
    if proto is not None:
        # Unit.orders resolves every ability via GameData and can raise for
        # patch-reserved4135. Preserve raw queue order and skip unknown IDs.
        return [(int(order.ability_id), _number(order.progress)) for order in proto.orders]
    try:
        orders = getattr(unit, "orders", ())
    except (KeyError, ValueError):
        return []
    result = []
    for order in orders:
        ability = getattr(order, "ability", None)
        identifier = getattr(getattr(ability, "id", ability), "value", None)
        result.append((identifier, _number(getattr(order, "progress", None))))
    return result


class CoachChrono:
    def __init__(self, *, enabled=False):
        if not isinstance(enabled, bool):
            raise ValueError("Chrono opening gate enabled must be boolean")
        self.enabled = enabled
        self.first_probe_order = None
        self.first_stalker_order = None
        self.first_stalker_start = None
        self.accepted_chronos = 0
        self._receipts = set()
        self.last_now = 0.0
        self.last_decision = None
        self._observed_at = None
        self._probe_targets = set()
        self._stalker_targets = set()

    def _clock(self, now):
        now = _number(now)
        if now is None or now < 0 or now < self.last_now:
            raise ValueError("Chrono opening gate requires monotonic finite nonnegative time")
        self.last_now = now
        return now

    @staticmethod
    def _evidence(now, source, tag, **extra):
        return {"game_seconds": now, "source": source, "source_tag": tag, **extra}

    def observe(self, current_own, now):
        """Remember actual current-screen queues, never inspect offscreen ones."""
        now = self._clock(now)
        self._observed_at = now
        self._probe_targets = set()
        self._stalker_targets = set()
        for unit in current_own:
            if not _current_own(unit):
                continue
            kind, tag = _kind(unit), getattr(unit, "tag", None)
            if type(tag) is not int or tag <= 0:
                continue
            if kind == "STALKER" and self.first_stalker_start is None:
                self.first_stalker_start = self._evidence(now, "observed_current_stalker", tag)
            elif kind in {"NEXUS", "GATEWAY", "WARPGATE"}:
                queue = _orders(unit)
                if kind == "NEXUS" and self.first_probe_order is None and any(
                        ability == PROBE_ABILITY for ability, _ in queue):
                    self.first_probe_order = self._evidence(now, "observed_current_probe_queue", tag)
                if (kind == "NEXUS" and queue and queue[0][0] == PROBE_ABILITY
                        and queue[0][1] is not None and 0 <= queue[0][1] <= 1):
                    self._probe_targets.add(tag)
                if (kind in {"GATEWAY", "WARPGATE"} and queue
                        and queue[0][0] in STALKER_ABILITIES and queue[0][1] is not None
                        and 0 < queue[0][1] <= 1):
                    self._stalker_targets.add(tag)
                    if self.first_stalker_start is None:
                        self.first_stalker_start = self._evidence(now, "observed_current_stalker_production", tag,
                            ability_id=queue[0][0], progress=queue[0][1])

    def record_command(self, name, accepted, now, *, audit_index, source_tags=()):
        """Call once on final command confirmation, never on accepted selection.

        Accepted Stalker orders can still be behind another unit in the queue;
        that receipt alone does not prove that Stalker production has started.
        """
        now = self._clock(now)
        if name not in {"train_probe", "train_stalker", "chrono_boost"}:
            return False
        if not isinstance(accepted, bool) or type(audit_index) is not int or audit_index < 0:
            raise ValueError("Chrono history requires a final boolean outcome and nonnegative audit index")
        if audit_index in self._receipts:
            return False
        if not accepted:
            self._receipts.add(audit_index)
            return False
        tags = list(source_tags)
        if len(tags) != 1 or type(tags[0]) is not int or tags[0] <= 0:
            raise ValueError("Confirmed opening command requires its actual single source tag")
        self._receipts.add(audit_index)
        evidence = self._evidence(now, "accepted_spatial_command", tags[0], selection_audit_index=audit_index)
        if name == "train_probe" and self.first_probe_order is None:
            self.first_probe_order = evidence
        elif name == "train_stalker" and self.first_stalker_order is None:
            self.first_stalker_order = evidence
        elif name == "chrono_boost":
            self.accepted_chronos += 1
        return True

    def decision(self, minerals, now):
        """Filter legal Chrono before executor selection and again before cast."""
        now = self._clock(now)
        minerals = _number(minerals)
        fresh = self._observed_at is not None and abs(now - self._observed_at) < 1e-6
        target_tags = None
        if not self.enabled:
            phase, allowed, reason = "ordinary", True, "explicit_opening_gate_disabled"
        elif self.accepted_chronos >= 2:
            phase, allowed, reason = "ordinary", True, "first_two_confirmed_chronos_complete"
        elif self.accepted_chronos == 0:
            phase = "first_chrono"
            target_tags = sorted(self._probe_targets) if fresh else []
            if self.first_probe_order is None:
                allowed, reason = False, "wait_for_first_probe_order"
            elif minerals is None or minerals < 40:
                allowed, reason = False, "wait_for_current_40_minerals_after_probe_order"
            elif not target_tags:
                allowed, reason = False, "wait_for_current_visible_probe_producing_nexus"
            else:
                allowed, reason = True, "first_probe_ordered_and_current_bank_at_least_40"
        else:
            phase = "second_chrono"
            target_tags = sorted(self._stalker_targets) if fresh else []
            if self.first_stalker_start is None:
                allowed, reason = False, "wait_for_first_stalker_production_start"
            elif not target_tags:
                allowed, reason = False, "wait_for_current_visible_stalker_producer"
            else:
                allowed, reason = True, "current_visible_stalker_production_observed"
        self.last_decision = {"game_seconds": now, "phase": phase, "allowed": allowed, "reason": reason,
                              "current_minerals": minerals, "accepted_chronos": self.accepted_chronos,
                              "target_tags": target_tags}
        return dict(self.last_decision)

    def summary(self):
        return {"enabled": self.enabled, "accepted_chronos": self.accepted_chronos,
                "first_probe_order": dict(self.first_probe_order) if self.first_probe_order else None,
                "first_stalker_order": dict(self.first_stalker_order) if self.first_stalker_order else None,
                "first_stalker_start": dict(self.first_stalker_start) if self.first_stalker_start else None,
                "last_decision": dict(self.last_decision) if self.last_decision else None,
                "scope": "Timing gate only; ordinary current-screen targeting, energy and cooldown rules remain required"}
