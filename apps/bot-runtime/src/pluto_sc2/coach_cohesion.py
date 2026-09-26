"""Bounded shared waypoints from permitted local army observations only.

This is a rendezvous controller, not global pathfinding or an enemy simulator.
Seventy-five percent of the ordinary army-supply HUD when assembly starts
(minimum six supply) must be observed together. Losses can lower that reference;
later production cannot raise it. Arrival uses75% of the observed departing
wave, so later production cannot increase its quota while it moves. Requested
waypoints are at most eight tiles apart; confirmed pixel projections are kept
separately. Further advance requires a fresh observation of the arriving group.
"""
from __future__ import annotations

import math


def _distance(a, b):
    return math.dist(a, b)


class CoachCohesion:
    def __init__(self):
        self.phase = "inactive"
        self.rally = None
        self.waypoint = None
        self.objective = None
        self.epoch = 0
        self.members = {}
        self.dispatched = set()
        self.dispatch_targets = {}
        self.observed_arrivals = set()
        self.local_supply = 0.0
        self.expected_supply = 0.0
        self.required_supply = 6.0
        self.last_update = 0.0
        self.wave_supply = 0.0
        self.assembly_supply = 0.0
        self.assembly_started_at = None
        self.effective_waypoint = None

    @property
    def arrival_point(self):
        """Public inverse projection of the first confirmed click, if supplied."""
        return self.effective_waypoint or self.waypoint

    def update(self, units, hud_supply, rally, objective, now, *, active=True):
        self.last_update = float(now)
        if not active or rally is None or objective is None:
            self.phase = "inactive"
            self.members.clear()
            self.dispatched.clear()
            self.dispatch_targets.clear()
            self.observed_arrivals.clear()
            self.wave_supply = 0.0
            self.assembly_supply = 0.0
            self.assembly_started_at = None
            self.effective_waypoint = None
            return
        current = [row for row in units if row.get("supply", 0) > 0
                   and not row.get("is_hallucination", False)]
        visible_supply = sum(row["supply"] for row in current)
        self.expected_supply = max(float(hud_supply), visible_supply, 0.0)
        if self.phase == "inactive":
            self.phase = "assembling"
            self.assembly_supply = self.expected_supply
            self.assembly_started_at = float(now)
            self.rally, self.waypoint = tuple(rally), None
            self.members.clear()
            self.dispatched.clear()
            self.dispatch_targets.clear()
        elif self.phase == "assembling" and _distance(self.rally, rally) > 12:
            # An observed base change can invalidate the previous home post.
            self.rally = tuple(rally)
        if self.phase == "holding_objective" and _distance(self.objective, objective) > 2:
            self.phase = "assembling"
            self.assembly_supply = self.expected_supply
            self.assembly_started_at = float(now)
        self.objective = tuple(objective)
        if self.phase == "advancing":
            # Newly observed reinforcements first reach the preceding shared
            # anchor, then receive the same short waypoint as the cohort.
            self.members.update({int(row["tag"]): float(row["supply"]) for row in current
                                 if (_distance(row["position"], self.rally) <= 7
                                     or _distance(row["position"], self.arrival_point) <= 1.5)})
        if self.phase == "assembling":
            # Reserve a wave at activation instead of chasing production forever.
            # A lower current HUD can reduce this reference after casualties;
            # fresh units remain eligible to assemble and reinforce the wave.
            # The reference is never evidence that any unit is at the rally.
            self.assembly_supply = min(self.assembly_supply, self.expected_supply)
        # Both assembly and advancing waves retain bounded supply references.
        # Only fresh current-screen positions can satisfy either quorum.
        self.required_supply = max(6.0, .75 * (self.wave_supply if self.phase == "advancing"
                                              else self.assembly_supply))
        point = self.arrival_point if self.phase == "advancing" else self.rally
        radius = 6.0 if self.phase == "advancing" else 7.0
        local = [row for row in current if _distance(row["position"], point) <= radius]
        self.local_supply = sum(row["supply"] for row in local)
        if self.phase == "assembling" and self.local_supply < self.required_supply:
            # A substantial army already together elsewhere need not return to
            # a stale natural rally before attacking. Only one fresh current
            # screen can establish this cluster; never combine old sightings.
            clusters = [(sum(row["supply"] for row in current
                             if _distance(row["position"], anchor["position"]) <= radius),
                         -_distance(anchor["position"], self.rally), anchor) for anchor in current]
            if clusters:
                supply, _distance_to_rally, anchor = max(clusters, key=lambda item: item[:2])
                if supply >= self.required_supply:
                    self.rally = tuple(anchor["position"])
                    point = self.rally
                    local = [row for row in current if _distance(row["position"], point) <= radius]
                    self.local_supply = supply
        self.observed_arrivals = {int(row["tag"]) for row in current if self.phase == "advancing"
                                 and _distance(row["position"], self.arrival_point) <= 1.5}
        issued = sum(supply for tag, supply in self.members.items()
                     if tag in self.dispatched or tag in self.observed_arrivals)
        ready = self.local_supply >= self.required_supply
        if ready and (self.phase == "assembling" or (
                self.phase == "advancing" and issued >= min(self.required_supply, sum(self.members.values())))):
            if self.phase == "advancing":
                self.rally = self.arrival_point
            distance = _distance(self.rally, self.objective)
            if distance <= 2:
                self.phase = "holding_objective"
                self.rally = self.objective
                self.waypoint = self.objective
                return
            scale = min(8.0, distance) / distance
            self.waypoint = tuple(a + (b - a) * scale for a, b in zip(self.rally, self.objective, strict=True))
            self.members = {int(row["tag"]): float(row["supply"]) for row in local}
            self.wave_supply = sum(self.members.values())
            self.effective_waypoint = None
            self.dispatched.clear()
            self.dispatch_targets.clear()
            self.observed_arrivals.clear()
            self.epoch += 1
            self.phase = "advancing"

    def job(self, tag):
        if self.phase == "inactive":
            return None
        if self.phase == "advancing" and tag in self.members:
            if tag in self.dispatched:
                return None
            return {"name": "cohort_advance", "target": self.waypoint, "epoch": self.epoch}
        return {"name": "cohort_assemble", "target": self.rally, "epoch": self.epoch}

    def confirm(self, name, tags, epoch, accepted, effective_target=None):
        if (accepted and name == "cohort_advance" and epoch == self.epoch
                and self.phase == "advancing"):
            confirmed = {int(tag) for tag in tags if int(tag) in self.members}
            if not confirmed:
                return
            valid_target = (isinstance(effective_target, (tuple, list)) and len(effective_target) == 2
                            and all(isinstance(v, (int, float)) and math.isfinite(v)
                                    for v in effective_target))
            if self.effective_waypoint is None and valid_target:
                self.effective_waypoint = tuple(effective_target)
            # Each paid screen command may choose a different nearby empty
            # pixel as units fill the rendezvous. Reaching that actual click
            # must not erase its receipt merely because the first click was
            # elsewhere. This stores our command, never an inferred position.
            target = tuple(effective_target) if valid_target else self.arrival_point
            self.dispatched.update(confirmed)
            self.dispatch_targets.update({tag: target for tag in confirmed})

    def needs_redispatch(self, tag, observed_position):
        """For a currently observed idle source, did its own waypoint fall short?

        The integration still checks idleness and current-screen visibility.
        The main six-tile fresh-cluster quorum and 75% wave threshold do not
        change. Formation offsets beyond the exact-click tolerance count only
        within that same fresh arrival region, within six tiles of this source's
        confirmed click, and after observed forward progress from the old rally.
        """
        if self.phase != "advancing" or tag not in self.dispatched:
            return False
        target = self.dispatch_targets.get(tag, self.arrival_point)
        if target is None or _distance(observed_position, target) <= 1.5:
            return False
        direction = tuple(b - a for a, b in zip(self.rally, self.arrival_point, strict=True))
        length = math.hypot(*direction)
        progress = (sum((p - a) * delta for p, a, delta in
                        zip(observed_position, self.rally, direction, strict=True)) / length
                    if length > 0 else 0)
        formation_arrival = (_distance(observed_position, target) <= 6.0
                             and _distance(observed_position, self.arrival_point) <= 6.0
                             and progress > .25)
        return not formation_arrival

    def release(self, tags):
        """Permit an observed member to receive its waypoint again after override.

        The integration calls this for confirmed replacement commands or an
        observed idle member short of the waypoint, never inferred movement.
        """
        for tag in tags:
            self.dispatched.discard(int(tag))
            self.dispatch_targets.pop(int(tag), None)

    def summary(self):
        return {"phase": self.phase, "rally": self.rally, "waypoint": self.waypoint,
                "objective": self.objective, "epoch": self.epoch,
                "departing_wave_supply": self.wave_supply,
                "assembly_supply_reference": self.assembly_supply,
                "assembly_started_game_seconds": self.assembly_started_at,
                "confirmed_click_projection": self.effective_waypoint,
                "arrival_point": self.arrival_point,
                "member_tags": sorted(self.members), "dispatched_tags": sorted(self.dispatched),
                "confirmed_source_targets": {str(tag): target for tag, target in sorted(self.dispatch_targets.items())},
                "currently_observed_arrival_tags": sorted(self.observed_arrivals),
                "local_observed_supply": self.local_supply, "expected_army_supply": self.expected_supply,
                "required_supply": self.required_supply, "minimum_fraction": .75,
                "minimum_supply": 6, "assembly_radius": 7, "arrival_radius": 6,
                "maximum_advance_tiles": 8, "last_observation_game_seconds": self.last_update}
