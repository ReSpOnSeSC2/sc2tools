"""Control-group bookkeeping and scheduling over permitted observations only.

The caller performs every selection, group store/recall and unit command through
FairPlayController. Stored tags are historical selection receipts, not a global
live roster. This helper never reads positions, hidden queues, or a bot object.
"""
from __future__ import annotations

from collections import Counter
import math
from numbers import Real


PROFILE = "coached-control-group-planner-v1"
_ROLES = {1: "army", 2: "nexus", 3: "gateway", 4: "robo", 5: "stargate"}
_ROLE_GROUPS = {role: group for group, role in _ROLES.items()}
_ROLE_GROUPS.update(roboticsfacility=4, warpgate=3)
_TYPE_GROUPS = {"NEXUS": 2, "GATEWAY": 3, "WARPGATE": 3, "ROBOTICSFACILITY": 4, "STARGATE": 5}
_ACTION_GROUPS = {
    **{f"train_{name}": 2 for name in ("probe",)},
    **{f"train_{name}": 3 for name in ("zealot", "stalker", "adept", "sentry", "hightemplar", "darktemplar")},
    **{f"train_{name}": 4 for name in ("immortal", "observer", "warpprism", "colossus", "disruptor")},
    **{f"train_{name}": 5 for name in ("phoenix", "voidray", "oracle", "carrier", "tempest")},
}


def _time(value):
    if isinstance(value, bool) or not isinstance(value, Real) or not math.isfinite(value) or value < 0:
        raise ValueError("Group planner time must be finite and nonnegative")
    return float(value)


def _group(role):
    if isinstance(role, int) and not isinstance(role, bool) and role in _ROLES:
        return role
    if isinstance(role, str) and role.lower() in _ROLE_GROUPS:
        return _ROLE_GROUPS[role.lower()]
    raise ValueError("Unknown coached control-group role")


def _deadline(value):
    # Existing coach leases use a negative timestamp for "never active".
    if isinstance(value, bool) or not isinstance(value, Real) or not math.isfinite(value):
        raise ValueError("Group protection deadline must be finite")
    return float(value)


def _tags(values):
    result = set()
    for tag in values:
        if isinstance(tag, bool) or not isinstance(tag, int) or tag <= 0:
            raise ValueError("Confirmed selection tags must be positive integers")
        result.add(tag)
    return result


class CoachGroups:
    def __init__(self):
        self.registered = {group: set() for group in _ROLES}
        self._visible = {}
        self._pending = None
        self._observed_at = None
        self._registration_retry = {group: 0.0 for group in _ROLES}
        self._producer_retry = {group: 0.0 for group in _ROLES if group != 1}
        self._last_army_attempt = None
        self._last_army_refresh = None
        self._army_refresh_supply = 0.0
        self.refresh_seconds = 15.0
        self.reinforcement_supply = 6.0
        self.retry_seconds = 3.0
        self.counts = Counter()

    def observe(self, own, now):
        """Supply only current camera-filtered own entities, never global units."""
        now = _time(now)
        if self._observed_at is not None and now < self._observed_at:
            raise ValueError("Group planner observation time moved backwards")
        visible = {}
        for unit in own:
            if isinstance(unit, dict):
                kind = unit.get("type")
                mine = unit.get("is_mine", True)
                current = unit.get("current", True)
                ready, structure = unit.get("is_ready", False), unit.get("is_structure", False)
                tag = unit.get("tag")
            else:
                kind = getattr(getattr(unit, "type_id", None), "name", None)
                mine = getattr(unit, "is_mine", True)
                current = getattr(unit, "is_on_screen", True) and getattr(unit, "is_visible", True)
                ready, structure = unit.is_ready, unit.is_structure
                tag = unit.tag
            if mine and current and ready and structure and kind in _TYPE_GROUPS:
                visible[next(iter(_tags([tag])))] = {"group": _TYPE_GROUPS[kind], "type": kind}
        self._visible = visible
        self._observed_at = now

    @property
    def pending_registration(self):
        return None if self._pending is None else {**self._pending, "source_tags": list(self._pending["source_tags"])}

    def registration_candidate(self, now):
        """Optional selection-only plan for observed, untouched producers.

        Prefer piggybacking on an already confirmed ordinary production
        selection via plan_registration; this candidate itself changes no state.
        """
        now = _time(now)
        if self._pending is not None or self._observed_at != now:
            return None
        for group in (2, 3, 4, 5):
            if now < self._registration_retry[group]:
                continue
            tags = sorted(tag for tag, row in self._visible.items()
                          if row["group"] == group and tag not in self.registered[group])
            if tags:
                kinds = {self._visible[tag]["type"] for tag in tags}
                return {"group": group, "role": _ROLES[group], "source_tags": tags,
                        "append": bool(self.registered[group]), "selection_mode":
                        "point" if len(kinds) == 1 else "rectangle", "requires_current_selection": True}
        return None

    def plan_registration(self, role, selected_tags, now):
        """Queue a store after the controller confirms these actual own tags.

        For producers, every selected source must also be on this current screen
        with the matching type. Army tags may be offscreen only after a genuine
        user-authorized F2 selection; the controller verifies that selection.
        Pending storage takes priority over any subsequent selection in caller.
        """
        group, now, tags = _group(role), _time(now), _tags(selected_tags)
        if self._pending is not None or not tags or now < self._registration_retry[group]:
            return None
        if group != 1:
            if (self._observed_at != now or any(self._visible.get(tag, {}).get("group") != group for tag in tags)
                    or tags.issubset(self.registered[group])):
                return None
        self._pending = {"group": group, "role": _ROLES[group], "source_tags": sorted(tags),
                         "append": group != 1 and bool(self.registered[group]), "planned_game_seconds": now}
        return self.pending_registration

    def confirm_registration(self, accepted, now=None):
        if not isinstance(accepted, bool):
            raise ValueError("Group registration needs the paid action's boolean result")
        if self._pending is None:
            return None
        plan = self._pending
        now = _time(plan["planned_game_seconds"] if now is None else now)
        if now < plan["planned_game_seconds"]:
            raise ValueError("Group registration confirmation precedes selection")
        self._pending = None
        group = plan["group"]
        if accepted:
            if not plan["append"]:
                self.registered[group].clear()
            self.registered[group].update(plan["source_tags"])
            self.counts["army_group_stores" if group == 1 else "production_group_stores"] += 1
        else:
            self._registration_retry[group] = now + self.retry_seconds
            self.counts["rejected_group_stores"] += 1
        return {**plan, "accepted": accepted, "confirmed_game_seconds": now}

    @staticmethod
    def group_for_action(actionname):
        # Core/Forge/Bay/Twilight research has no registered producer slot here.
        # Targeted spells and construction must retain ordinary visible targeting.
        return _ACTION_GROUPS.get(actionname)

    def recall_plan(self, group, now):
        group, now = _group(group), _time(now)
        if self._pending is not None or not self.registered[group] or now < self._producer_retry.get(group, 0):
            return None
        return {"group": group, "role": _ROLES[group], "selection_mode": "control_group",
                "registered_source_tags": sorted(self.registered[group]),
                "membership_scope": "Historical confirmed group stores; not current live unit state",
                "requires_selected_ui_ability": group != 1, "requires_visible_leader": group == 1}

    def record_production_attempt(self, actionname, now, accepted):
        group, now = self.group_for_action(actionname), _time(now)
        if group is None or not isinstance(accepted, bool):
            raise ValueError("Expected a supported production action and its boolean result")
        # No hidden production queue/duration/count is used to predict readiness.
        # UI ability checks and SC2 determine whether another queue order is legal.
        self._producer_retry[group] = now + self.retry_seconds
        self.counts["accepted_production_attempts" if accepted else "rejected_production_attempts"] += 1

    def main_army_refresh_due(self, now, hud_army, *, protected_until=0, scout_until=0,
                              rescue_until=0, active=True):
        now = _time(now)
        if isinstance(hud_army, bool) or not isinstance(hud_army, Real) or not math.isfinite(hud_army) or hud_army < 0:
            raise ValueError("Army refresh requires nonnegative finite HUD supply")
        if (not active or hud_army < 6 or self._pending is not None
                or now < max(_deadline(protected_until), _deadline(scout_until), _deadline(rescue_until))
                or self._last_army_attempt is not None and now - self._last_army_attempt < self.retry_seconds):
            return None
        initial = not self.registered[1] or self._last_army_refresh is None
        growth = hud_army - self._army_refresh_supply >= self.reinforcement_supply
        expired = self._last_army_refresh is not None and now - self._last_army_refresh >= self.refresh_seconds
        if not initial and not growth and not expired:
            return None
        return {"selection_mode": "army", "save_group": 1, "replace_group": True,
                "reason": "initial_army" if initial else "reinforcements" if growth else "periodic_refresh",
                "hud_army_supply": float(hud_army), "requires_visible_leader": True,
                "requires_current_visible_ground_target": True}

    def record_army_refresh(self, now, hud_army, accepted):
        now = _time(now)
        if (not isinstance(accepted, bool) or isinstance(hud_army, bool) or not isinstance(hud_army, Real)
                or not math.isfinite(hud_army) or hud_army < 0):
            raise ValueError("Army refresh needs a boolean result and finite nonnegative HUD supply")
        self._last_army_attempt = now
        self.counts["accepted_army_refreshes" if accepted else "rejected_army_refreshes"] += 1
        if accepted:
            self._last_army_refresh = now
            self._army_refresh_supply = float(hud_army)

    def summary(self):
        return {"profile": PROFILE, "membership_scope": "Historical confirmed group stores; not current live unit state",
                "registered_groups": {str(group): {"role": _ROLES[group], "tags": sorted(tags)}
                                      for group, tags in self.registered.items()},
                "pending_registration": self.pending_registration, "counts": dict(self.counts),
                "last_army_refresh_game_seconds": self._last_army_refresh,
                "army_supply_at_refresh": self._army_refresh_supply, "refresh_seconds": self.refresh_seconds,
                "reinforcement_supply_threshold": self.reinforcement_supply, "retry_seconds": self.retry_seconds,
                "production_retry_after": dict(self._producer_retry)}
