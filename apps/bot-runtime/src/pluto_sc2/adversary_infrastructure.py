"""Bound redundant Terran infrastructure using owned observations only.

This filters legal choices before policy sampling; it never picks a build.
Radar radii come from owned units' public radar_range, never global radar rings
or sight range. Until an existing tower supplies a radius, more towers wait.
"""
from __future__ import annotations

from collections import Counter
import math

from sc2.dicts.unit_train_build_abilities import TRAIN_INFO
from sc2.ids.unit_typeid import UnitTypeId as U
from sc2.position import Point2


INFRASTRUCTURE_PROFILE = "owned-nonredundant-terran-infrastructure-v1"
KINDS = frozenset(("SENSORTOWER", "ENGINEERINGBAY", "MISSILETURRET"))
BASES = frozenset(("COMMANDCENTER", "ORBITALCOMMAND", "PLANETARYFORTRESS"))
BASE_CLUSTER_DISTANCE = 10.0
BASE_SITE_RADIUS = 18.0
TURRET_SPACING = 4.0
RESERVATION_GRACE = 5.0


def _positive(value):
    return (not isinstance(value, bool) and isinstance(value, (int, float))
            and math.isfinite(value) and value > 0)


def _target(order):
    if hasattr(order, "HasField") and not order.HasField("target_world_space_pos"):
        return None
    target = getattr(order, "target_world_space_pos", None)
    if target is None or not all(math.isfinite(v) for v in (target.x, target.y)):
        return None
    return Point2((target.x, target.y))


class InfrastructureGuard:
    def __init__(self):
        self.bases = []
        self.sites = {name: [] for name in KINDS}
        self.known_radar_radius = None
        self.reservations = []
        self.denied = Counter()
        self.denied_reasons = Counter()
        self.last_denial = None
        self.workers = self.army_supply = 0.0
        self.now = 0.0

    def observe(self, bot, own):
        self.now = float(bot.time)
        self.workers = float(bot.supply_workers)
        self.army_supply = float(bot.supply_army)
        self.bases = []
        for unit in sorted(own, key=lambda unit: unit.tag):
            if (unit.type_id.name in BASES and unit.is_ready and not unit.is_flying
                    and all(unit.position.distance_to(base) >= BASE_CLUSTER_DISTANCE for base in self.bases)):
                self.bases.append(unit.position)
        self.sites = {name: [] for name in KINDS}
        for unit in own:
            name = unit.type_id.name
            if name not in KINDS:
                continue
            radius = getattr(unit, "radar_range", None) if name == "SENSORTOWER" else None
            radius = float(radius) if _positive(radius) else None
            if radius is not None:
                self.known_radar_radius = max(radius, self.known_radar_radius or radius)
            self.sites[name].append((unit.position, radius))
        # SCV build orders reserve their actual observed world targets. Once a
        # foundation appears, that same site counts only once.
        ability_names = {}
        for name in KINDS:
            ability = TRAIN_INFO[U.SCV][U[name]]["ability"]
            ability_names[ability.value] = name
            data = bot.game_data.abilities.get(ability.value)
            if data is not None:
                ability_names[data.id.value] = name
        for unit in own:
            if unit.type_id != U.SCV:
                continue
            for order in unit._proto.orders:
                name = ability_names.get(order.ability_id)
                point = _target(order) if name is not None else None
                if point is not None:
                    self._site(name, point)
        remaining = []
        for reservation in self.reservations:
            name, point, issued = reservation
            observed = any(point.distance_to(site) < 1 for site, _ in self.sites[name])
            if not observed and self.now - issued < RESERVATION_GRACE:
                self._site(name, point)
                remaining.append(reservation)
        self.reservations = remaining

    def _site(self, name, point):
        if not any(point.distance_to(site) < 1 for site, _ in self.sites[name]):
            self.sites[name].append((point, None))

    def accepted(self, now, intent):
        """Bridge accepted input to the next owned order/foundation observation."""
        if intent.target is None or hasattr(intent.target, "tag"):
            return
        for name in KINDS:
            if intent.ability == TRAIN_INFO[U.SCV][U[name]]["ability"]:
                self.reservations.append((name, Point2(intent.target), float(now)))
                return

    def _base_index(self, point):
        return min(range(len(self.bases)), key=lambda index: point.distance_to(self.bases[index]))

    def _base_count(self, name, index):
        return sum(self._base_index(point) == index and point.distance_to(self.bases[index]) <= BASE_SITE_RADIUS
                   for point, _ in self.sites[name])

    def _deny(self, name, reason):
        self.denied["build_" + name.lower()] += 1
        self.denied_reasons[name.lower() + ":" + reason] += 1
        self.last_denial = {"action": "build_" + name.lower(), "reason": reason,
                            "game_seconds": self.now}
        return False

    def allowed(self, name):
        if name not in KINDS:
            return True
        if not self.bases:
            return self._deny(name, "no_established_base")
        if name == "ENGINEERINGBAY":
            return len(self.sites[name]) < 2 or self._deny(name, "two_upgrade_bays_reserved")
        limit = 1 if name == "SENSORTOWER" else 2
        if all(self._base_count(name, index) >= limit for index in range(len(self.bases))):
            return self._deny(name, "per_base_limit")
        if name == "SENSORTOWER":
            # A policy may buy radar after establishing workers and an army;
            # radar cannot repeatedly displace the opening economy or units.
            if self.workers < 24 or self.army_supply < 12:
                return self._deny(name, "economy_army_not_established")
            if self.sites[name] and self.known_radar_radius is None:
                return self._deny(name, "owned_radar_radius_unobserved")
        return True

    def site_allowed(self, name, point):
        if name == "ENGINEERINGBAY":
            return True
        if not self.bases:
            return False
        index = self._base_index(point)
        limit = 1 if name == "SENSORTOWER" else 2
        if point.distance_to(self.bases[index]) > BASE_SITE_RADIUS or self._base_count(name, index) >= limit:
            return False
        if name == "SENSORTOWER":
            if self.sites[name] and self.known_radar_radius is None:
                return False
            radius = self.known_radar_radius or 0.0
            return all(point.distance_to(site) >= radius + (other_radius or radius)
                       for site, other_radius in self.sites[name])
        return all(point.distance_to(site) >= TURRET_SPACING for site, _ in self.sites[name])

    def no_site(self, name):
        self._deny(name, "no_nonredundant_visible_placement")

    def summary(self):
        return {"profile": INFRASTRUCTURE_PROFILE, "established_base_sites": len(self.bases),
                "owned_and_pending_counts": {name: len(sites) for name, sites in self.sites.items()},
                "denied_action_opportunities": dict(self.denied), "denied_reasons": dict(self.denied_reasons),
                "last_denial": self.last_denial, "observed_owned_radar_radius": self.known_radar_radius,
                "sensor_towers_per_base": 1, "engineering_bays_total": 2, "turrets_per_base": 2,
                "base_cluster_distance": BASE_CLUSTER_DISTANCE, "base_site_radius": BASE_SITE_RADIUS,
                "turret_minimum_spacing": TURRET_SPACING, "sensor_minimum_workers": 24,
                "sensor_minimum_army_supply": 12, "pending_input_grace_seconds": RESERVATION_GRACE}
