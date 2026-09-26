"""Brief addon stabilization after an observed Terran production-building landing.

Only owned-unit observations are used. This does not restrict ordinary grounded
producers, change an ability ID, or infer that a transport defect is fixed.
"""

from __future__ import annotations

import math


LANDING_PROFILE = "observed-landing-addon-settle-v1"
ADDON_SETTLE_SECONDS = 2.0
_PRODUCTION = {"BARRACKS", "FACTORY", "STARPORT"}
_FLYING = {name + "FLYING" for name in _PRODUCTION}
_TRACKED = _PRODUCTION | _FLYING


class LandingGuard:
    def __init__(self):
        self._flying = {}
        self._blocked_until = {}
        self._last_time = -math.inf
        self.observed_landings = 0

    def observe(self, now: float, own_units) -> None:
        if not math.isfinite(now) or now < 0 or now < self._last_time:
            raise ValueError("Invalid or backwards landing observation time")
        self._last_time = now
        present = set()
        for unit in own_units:
            name = unit.type_id.name
            if name not in _TRACKED or not unit.is_mine:
                continue
            tag = int(unit.tag)
            present.add(tag)
            flying = name in _FLYING or bool(unit.is_flying)
            if self._flying.get(tag) is True and not flying:
                self._blocked_until[tag] = now + ADDON_SETTLE_SECONDS
                self.observed_landings += 1
            elif flying:
                self._blocked_until.pop(tag, None)
            self._flying[tag] = flying
        self._flying = {tag: value for tag, value in self._flying.items() if tag in present}
        self._blocked_until = {tag: value for tag, value in self._blocked_until.items()
                               if tag in present and value > now}

    def addon_ready(self, tag: int, now: float) -> bool:
        return now >= self._blocked_until.get(int(tag), -math.inf)

    def summary(self) -> dict:
        return {"version": LANDING_PROFILE, "settle_seconds": ADDON_SETTLE_SECONDS,
                "observed_landings": self.observed_landings}
