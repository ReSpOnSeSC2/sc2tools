"""Bounded, current-camera rescue transport for the coached Protoss bot.

The pickup / move / drop decomposition is also demonstrated by Ares:
https://github.com/AresSC2/ares-sc2/blob/main/docs/tutorials/combat_maneuver_example.md
Ares is MIT (2023 AresSC2); this implementation is independently written and
does not import its global influence grids or raw unit commands. Safety here
means lower estimated exposure to currently visible weapons, not full-map safety.
"""
from __future__ import annotations

import math
from types import SimpleNamespace

from sc2.ids.ability_id import AbilityId as A
from sc2.ids.unit_typeid import UnitTypeId as U

from .adversary_orders import duplicate_order, visible
from .coach_combat import _distance, _durability, _exposure, _hits, _range, _value


RESCUE_TYPES = frozenset({U.STALKER, U.IMMORTAL, U.SENTRY, U.HIGHTEMPLAR,
                          U.DISRUPTOR, U.COLOSSUS, U.ARCHON, U.ADEPT, U.ZEALOT})
GROUND_CARGO = SimpleNamespace(is_flying=False, radius=1.0)


def _pressured(unit, point, enemies, margin=2.0):
    return any(_hits(enemy, unit) and _distance(enemy, point)
               <= _range(enemy, unit) + _value(enemy, "radius", .5)
               + _value(unit, "radius", .5) + margin for enemy in enemies)


def _cargo_left(prism):
    return max(0.0, _value(prism, "cargo_left",
                          _value(prism, "cargo_max") - _value(prism, "cargo_used")))


def _load_range(bot):
    # This is static public game data from the installed ruleset. Unknown
    # range fails closed rather than relying on an old patch's pickup radius.
    ability = bot.game_data.abilities.get(A.LOAD_WARPPRISM.value)
    return max(0.0, _value(getattr(ability, "_proto", None), "cast_range"))


def _clear_ground(bot, point, own):
    # Keep all refreshed terrain lookups behind the camera and fog boundary.
    if not bot.fairplay.on_screen(point) or not bot.is_visible(point):
        return False
    if not bot.in_pathing_grid(point):
        return False
    return not any(getattr(unit, "is_structure", False)
                   and _distance(unit, point) < _value(unit, "radius", 1.0) + 1.0
                   for unit in own)


def _clear_segment(bot, start, target, own):
    distance = start.distance_to(target)
    steps = max(1, math.ceil(distance))
    # Flight can cross buildings, but every intermediate location must remain
    # visible. Only the landing candidate requires a refreshed pathing query.
    points = (start.towards(target, distance * i / steps) for i in range(1, steps + 1))
    return (all(bot.fairplay.on_screen(point) and bot.is_visible(point) for point in points)
            and _clear_ground(bot, target, own))


class CoachPrism:
    """Rescue damaged nearby army, then return observed cargo to safe ground."""

    def __init__(self):
        self.last_input = -100.0
        self.last_reason = None
        self.last_source_tag = None
        self.protected_tags = {}
        self.status = "idle"
        self._pending_pickups = {}
        self.diagnostics = {"load_ability_id": A.LOAD_WARPPRISM.value,
                            "public_load_range": None, "load_range_status": "not_checked",
                            "last_query_ability": None, "last_query_available": None,
                            "last_pickup_result": None}

    def summary(self, now):
        return {"status": self.status, "last_reason": self.last_reason,
                "last_source_tag": self.last_source_tag, "last_input_game_seconds": self.last_input,
                "protected_tags": sorted(tag for tag, until in self.protected_tags.items() if until > now),
                **self.diagnostics}

    def _escape(self, bot, prism, enemies, own, *, loaded):
        origin = prism.position
        air_now = _exposure(prism, origin, enemies)
        ground_now = _exposure(GROUND_CARGO, origin, enemies) if loaded else 0.0
        score_now = 2 * air_now + ground_now
        points = []
        for radius in (3.0, 5.0):
            for i in range(8):
                angle = i * math.pi / 4
                point = type(origin)((origin.x + radius * math.cos(angle),
                                      origin.y + radius * math.sin(angle)))
                if not _clear_segment(bot, origin, point, own):
                    continue
                air = _exposure(prism, point, enemies)
                ground = _exposure(GROUND_CARGO, point, enemies) if loaded else 0.0
                score = 2 * air + ground
                # Never retreat away from ground-only threats into new air
                # danger. With no visible threats, move off unpathable ground.
                safe_ground = not _pressured(GROUND_CARGO, point, enemies)
                if (air <= air_now + 1e-6 and (score < score_now - 1e-6
                        or (score_now <= 1e-6 and loaded and safe_ground))):
                    points.append((score, radius, i, point))
        return min(points, key=lambda row: row[:3])[-1] if points else None

    async def _issue(self, bot, prism, ability, target, reason):
        available = await bot.get_available_abilities([prism], ignore_resource_requirements=False)
        data = bot.game_data.abilities.get(ability.value)
        canonical = data.id if data else ability
        legal = bool(available and (ability in available[0] or canonical in available[0]))
        self.diagnostics.update(last_query_ability=ability.value, last_query_available=legal)
        if not legal:
            self.status = "ability_unavailable"
            return False
        if duplicate_order([prism], ability, target, bot.game_data):
            self.status = "order_in_progress"
            return False
        if not await bot.fairplay.issue(bot, [prism], ability, target, minimap=False):
            self.status = "fairplay_deferred"
            return False
        now = float(bot.time)
        self.last_input = now
        self.last_source_tag = prism.tag
        self.last_reason = reason
        self.status = "selection_pending"
        self.protected_tags[prism.tag] = now + 3.0
        if ability == A.LOAD_WARPPRISM:
            self.protected_tags[target.tag] = now + 3.0
            self._pending_pickups[prism.tag] = (target.tag, now + 2.0)
            self.diagnostics["last_pickup_result"] = "awaiting_observed_cargo"
        bot._record_selection("prism_" + reason, target)
        bot.action_counts["prism_" + reason] += 1
        return True

    async def step(self, bot, own, enemies, order=None):
        """Issue at most one ordinary spatial command; never move the camera."""
        now = float(bot.time)
        reach = _load_range(bot)
        self.diagnostics.update(public_load_range=reach,
                                load_range_status="public_data" if reach > 0 else "missing_or_zero")
        self.protected_tags = {tag: until for tag, until in self.protected_tags.items() if until > now}
        if now - self.last_input < 1.0:
            return False
        # Friendly cloak is visible to its owner and must not prevent rescue.
        own = [unit for unit in own if getattr(unit, "is_mine", False)
               and getattr(unit, "is_visible", False) and not getattr(unit, "is_snapshot", False)
               and bot.fairplay.on_screen(unit)]
        enemies = [unit for unit in enemies if visible(unit) and bot.fairplay.on_screen(unit)]
        prisms = [unit for unit in own if unit.type_id == U.WARPPRISM and unit.is_ready
                  and bot.fairplay.source_available(unit, now)]
        if not prisms:
            self.status = "no_current_prism"
            return False
        scout_tags = set(getattr(bot, "_nonworker_scout_tags", ()))
        scout_lease = getattr(bot, "_scout_camera_lease", None)
        if scout_lease:
            scout_tags.add(scout_lease.get("source_tag"))
        # Loaded cargo has priority over further pickups. Observed cargo, not
        # a previous accepted selection, determines whether the rescue worked.
        for prism in sorted(prisms, key=lambda unit: (-_value(unit, "cargo_used"), unit.tag)):
            loaded = _value(prism, "cargo_used") > 0
            pending = self._pending_pickups.get(prism.tag)
            passenger_tags = {unit.tag for unit in getattr(prism, "passengers", ())}
            if pending and (pending[0] in passenger_tags or now >= pending[1]):
                self.diagnostics["last_pickup_result"] = (
                    "observed_loaded" if pending[0] in passenger_tags else "not_observed_by_timeout")
                self._pending_pickups.pop(prism.tag, None)
                pending = None
            if pending:
                self.status = "awaiting_observed_pickup"
                continue
            air_pressure = _pressured(prism, prism.position, enemies)
            if loaded:
                safe = (not air_pressure
                        and not _pressured(GROUND_CARGO, prism.position, enemies)
                        and _clear_ground(bot, prism.position, own))
                if safe:
                    if await self._issue(bot, prism, A.UNLOADALLAT_WARPPRISM,
                                         prism.position, "safe_unload"):
                        return True
                else:
                    target = self._escape(bot, prism, enemies, own, loaded=True)
                    if target is not None:
                        if await self._issue(bot, prism, A.MOVE_MOVE, target, "cargo_retreat"):
                            return True
                    else:
                        self.status = "no_legal_local_escape"
                continue

            if reach <= 0:
                self.status = "load_range_unknown"
            candidates = [unit for unit in own if unit.type_id in RESCUE_TYPES
                          and unit.tag not in scout_tags and unit.is_ready
                          and not unit.is_structure and not unit.is_flying
                          and not getattr(unit, "is_hallucination", False)
                          and not getattr(unit, "is_burrowed", False)
                          and bot.fairplay.source_available(unit, now)
                          and _durability(unit) <= .4
                          and 0 < _value(unit, "cargo_size") <= _cargo_left(prism)
                          and reach > 0 and _distance(prism, unit) <= reach
                          and _pressured(unit, unit.position, enemies)]
            # Do not chase a damaged unit: every candidate is already inside
            # the installed ability's conservative center-to-center range.
            if candidates and _durability(prism) > .3:
                target = min(candidates, key=lambda unit: (_durability(unit),
                             -_value(unit, "cargo_size"), _distance(prism, unit), unit.tag))
                if await self._issue(bot, prism, A.LOAD_WARPPRISM, target, "rescue_load"):
                    return True
            if air_pressure:
                target = self._escape(bot, prism, enemies, own, loaded=False)
                if target is not None:
                    if await self._issue(bot, prism, A.MOVE_MOVE, target, "transport_retreat"):
                        return True
        return False
