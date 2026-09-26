"""Conservative current-screen Sentry barriers at observed narrow passages.

Reference: Sharpy's MIT (2019 DrInfy) MicroSentries protects ramps/gatekeepers
and avoids duplicate fields. This independent implementation uses no global
zone/enemy cache and copies no upstream code:
https://github.com/DrInfy/sharpy-sc2/blob/develop/sharpy/combat/protoss/micro_sentries.py

Geometry is a local heuristic, not proof of a sealed choke or a safe battle.
Recent targets remember our confirmed commands, not unseen active effects.
"""
from __future__ import annotations

from sc2.ids.ability_id import AbilityId as A
from sc2.ids.unit_typeid import UnitTypeId as U
from sc2.position import Point2

from .adversary_orders import duplicate_order, visible
from .coach_combat import _distance, _value


ACTION_NAME = "combat_force_field"
WORKERS = frozenset({U.PROBE, U.SCV, U.DRONE})
RECENT_TARGET_SECONDS = 15.0  # Conservative recast avoidance, not claimed effect duration.


def _project(point, origin, direction):
    return (point.x - origin.x) * direction[0] + (point.y - origin.y) * direction[1]


def _offset(point, direction, length):
    return Point2((point.x + direction[0] * length, point.y + direction[1] * length))


def _segment_distance(point, start, end):
    dx, dy = end.x - start.x, end.y - start.y
    length_squared = dx * dx + dy * dy
    if length_squared <= 1e-9:
        return point.distance_to(start)
    t = max(0.0, min(1.0, ((point.x - start.x) * dx + (point.y - start.y) * dy) / length_squared))
    return point.distance_to(Point2((start.x + t * dx, start.y + t * dy)))


def _move_target(unit):
    """Only the current owned unit's explicit move order; no global lookups."""
    proto = getattr(unit, "_proto", None)
    if proto is not None:
        orders = getattr(proto, "orders", ())
        if not orders or orders[0].ability_id not in {A.MOVE_MOVE.value, A.MOVE.value}:
            return None
        first = orders[0]
        if hasattr(first, "HasField") and not first.HasField("target_world_space_pos"):
            return None
        point = getattr(first, "target_world_space_pos", None)
        return Point2((point.x, point.y)) if point is not None else None
    # Small test doubles and alternative observation adapters expose orders.
    orders = getattr(unit, "orders", ())
    if not orders:
        return None
    ability = getattr(orders[0], "ability", None)
    if getattr(ability, "id", ability) not in {A.MOVE_MOVE, A.MOVE}:
        return None
    target = getattr(orders[0], "target", None)
    return target if hasattr(target, "x") and hasattr(target, "y") else None


def _observed_choke(bot, point, axis, retreat_center):
    """Verify a short open corridor bounded on both sides, plus local retreat.

    Check visibility for the complete sample before querying any terrain, so
    an unseen wall never becomes evidence that a passage is narrow.
    """
    normal = (-axis[1], axis[0])
    centerline = [_offset(point, axis, distance) for distance in (-1.0, 0.0, 1.0)]
    walls = [_offset(center, normal, side) for center in centerline for side in (-2.0, 2.0)]
    retreat = [_offset(retreat_center, axis, distance) for distance in (0.0, -1.5, -3.0)]
    samples = centerline + walls + retreat
    if not all(bot.fairplay.on_screen(sample) and bot.is_visible(sample) for sample in samples):
        return False
    return (all(bot.in_pathing_grid(sample) for sample in centerline + retreat)
            and all(not bot.in_pathing_grid(sample) for sample in walls))


class CoachForceFields:
    def __init__(self):
        self.pending = None
        self.recent_targets = []
        self.protected_tags = {}
        self.last_input = -100.0
        self.last_confirmed_command = -100.0
        self.last_source_tag = None
        self.last_reason = None
        self.retry_after = -100.0
        self.confirmed_commands = 0
        self.status = "idle"
        self.public_cast_range = None

    def summary(self, now):
        return {"status": self.status, "pending": self.pending is not None,
                "public_cast_range": self.public_cast_range,
                "confirmed_commands": self.confirmed_commands,
                "last_confirmed_game_seconds": self.last_confirmed_command,
                "last_source_tag": self.last_source_tag,
                "recent_confirmed_targets": [{"position": list(point), "avoid_until": until}
                                             for point, until in self.recent_targets if until > now],
                "protected_tags": sorted(tag for tag, until in self.protected_tags.items() if until > now),
                "recast_avoidance_seconds": RECENT_TARGET_SECONDS}

    def confirm(self, name, accepted, now, source_tags=(), target=None):
        """A selection is not a cast; only consume its eventual command result."""
        pending = self.pending
        if pending is None or name != ACTION_NAME:
            return
        if source_tags and pending["source_tag"] not in source_tags:
            return
        if target is not None and pending["target"].distance_to(Point2(target)) > .25:
            return
        self.pending = None
        if accepted:
            self.recent_targets.append((pending["target"], float(now) + RECENT_TARGET_SECONDS))
            self.confirmed_commands += 1
            self.last_confirmed_command = float(now)
            self.protected_tags[pending["source_tag"]] = float(now) + 2.0
            self.status = "command_confirmed"
        else:
            self.protected_tags.pop(pending["source_tag"], None)
            self.retry_after = float(now) + 3.0
            self.status = "command_rejected"

    def _candidate(self, bot, sentry, own, ground_enemies, ranged):
        local = [unit for unit in ranged if _distance(sentry, unit) <= 7]
        if len(local) < 2:
            return None
        center = Point2((sum(unit.position.x for unit in local) / len(local),
                         sum(unit.position.y for unit in local) / len(local)))
        melee = [unit for unit in ground_enemies if _value(unit, "ground_range") < 2
                 and _distance(unit, center) <= 10]
        if len(melee) < 2:
            return None
        closest = min(melee, key=lambda unit: (_distance(unit, center), unit.tag))
        distance = _distance(closest, center)
        if distance < 5:
            return None  # Already surrounded/contacting: a barrier can trap us.
        axis = ((closest.position.x - center.x) / distance, (closest.position.y - center.y) / distance)
        nearby_friendly_ground = [unit for unit in own if not unit.is_flying and not unit.is_structure
                                  and _distance(unit, center) <= 12]
        for separation in (3.5, 4.5, 5.5):
            point = _offset(center, axis, separation)
            if _distance(sentry, point) > self.public_cast_range:
                continue
            if any(_distance(unit, point) < 2.5 + _value(unit, "radius", .5) for unit in own
                   if not unit.is_flying):
                continue
            if any(point.distance_to(previous) < 3.5 for previous, _ in self.recent_targets):
                continue
            if any(not unit.is_flying and getattr(unit, "is_massive", False)
                   and _distance(unit, point) < 10 for unit in own + ground_enemies):
                continue
            # Every local friendly ground unit must remain on the same side,
            # including melee allies. Do not strand a Zealot beyond the field.
            if any(_project(unit.position, point, axis) >= -.5 for unit in nearby_friendly_ground):
                continue
            if len([unit for unit in melee if _project(unit.position, point, axis) >= 1.5]) < 2:
                continue
            if any(_project(unit.position, point, axis) < 1.0 for unit in melee):
                continue
            crossing_route = False
            for unit in nearby_friendly_ground:
                destination = _move_target(unit)
                if destination is not None and _segment_distance(point, unit.position, destination) < 2.5:
                    crossing_route = True
                    break
            if crossing_route:
                continue
            if _observed_choke(bot, point, axis, center):
                return point
        return None

    async def step(self, bot, own, enemies, order=None, *, protected_tags=()):
        now = float(bot.time)
        self.recent_targets = [(point, until) for point, until in self.recent_targets if until > now]
        self.protected_tags = {tag: until for tag, until in self.protected_tags.items() if until > now}
        data = bot.game_data.abilities.get(A.FORCEFIELD_FORCEFIELD.value)
        self.public_cast_range = max(0.0, _value(getattr(data, "_proto", None), "cast_range"))
        if self.pending:
            if now < self.pending["selected_at"] + 3:
                return False
            self.protected_tags.pop(self.pending["source_tag"], None)
            self.pending = None
            self.retry_after = now + 3
            self.status = "confirmation_timeout"
        if now < self.retry_after or now - self.last_confirmed_command < 2.0 or now - self.last_input < 1.0:
            return False
        if self.public_cast_range <= 0:
            self.status = "cast_range_unknown"
            return False
        # Our own cloak does not conceal friendly units from the player.
        # Keep them in footprint/retreat checks and source eligibility.
        own = [unit for unit in own if getattr(unit, "is_mine", False)
               and getattr(unit, "is_visible", False) and not getattr(unit, "is_snapshot", False)
               and bot.fairplay.on_screen(unit)]
        enemies = [unit for unit in enemies if visible(unit) and bot.fairplay.on_screen(unit)]
        ground = [unit for unit in enemies if not unit.is_flying and not unit.is_structure
                  and unit.type_id not in WORKERS and getattr(unit, "can_attack_ground", False)
                  and not getattr(unit, "is_hallucination", False)]
        ranged = [unit for unit in own if unit.is_ready and not unit.is_flying and not unit.is_structure
                  and unit.type_id not in WORKERS and getattr(unit, "can_attack_ground", False)
                  and _value(unit, "ground_range") >= 3 and not getattr(unit, "is_hallucination", False)]
        if len(ground) < 2 or len(ranged) < 2:
            self.status = "insufficient_local_force"
            return False
        self.status = "no_safe_local_choke"
        for sentry in sorted((unit for unit in ranged if unit.type_id == U.SENTRY
                              and unit.tag not in protected_tags
                              and bot.fairplay.source_available(unit, now)), key=lambda unit: unit.tag):
            point = self._candidate(bot, sentry, own, ground, ranged)
            if point is None:
                continue
            available = await bot.get_available_abilities([sentry], ignore_resource_requirements=False)
            canonical = data.id if data else A.FORCEFIELD_FORCEFIELD
            if not available or (A.FORCEFIELD_FORCEFIELD not in available[0] and canonical not in available[0]):
                self.status = "ability_unavailable"
                continue
            if duplicate_order([sentry], A.FORCEFIELD_FORCEFIELD, point, bot.game_data):
                self.status = "order_in_progress"
                continue
            if not await bot.fairplay.issue(bot, [sentry], A.FORCEFIELD_FORCEFIELD, point, minimap=False):
                self.status = "fairplay_deferred"
                return False
            self.pending = {"source_tag": sentry.tag, "target": point, "selected_at": now}
            self.protected_tags[sentry.tag] = now + 3
            self.last_input = now
            self.last_source_tag = sentry.tag
            self.last_reason = "defensive_choke"
            self.status = "selection_pending"
            bot._record_selection(ACTION_NAME, point)
            bot.action_counts[ACTION_NAME] += 1
            return True
        return False
