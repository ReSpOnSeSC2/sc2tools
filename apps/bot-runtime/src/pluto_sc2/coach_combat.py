"""Small, screen-local combat controller for the separate coached bot.

This is a scripted baseline, not learned micro or a battle outcome predictor.
Only the supplied current screen entities participate. Every order still uses
the normal ability query, spatial selection, visibility and input budget.
"""
from __future__ import annotations

from dataclasses import dataclass
import math
from typing import Any

from sc2.ids.ability_id import AbilityId as A
from sc2.ids.buff_id import BuffId as B
from sc2.ids.unit_typeid import UnitTypeId as U

from .adversary_orders import duplicate_order


@dataclass(frozen=True)
class CombatIntent:
    sources: tuple[Any, ...]
    ability: Any
    target: Any
    reason: str
    alternatives: tuple[Any, ...] = ()


def _value(unit, name, default=0.0):
    value = getattr(unit, name, default)
    return float(value) if isinstance(value, (int, float)) and math.isfinite(value) else float(default)


def _distance(a, b):
    return a.position.distance_to(getattr(b, "position", b))


def _hits(unit, target):
    return bool(getattr(unit, "can_attack_air" if target.is_flying else "can_attack_ground", False))


def _range(unit, target):
    return _value(unit, "air_range" if target.is_flying else "ground_range")


def _durability(unit):
    maximum = _value(unit, "health_max") + _value(unit, "shield_max")
    return (_value(unit, "health") + _value(unit, "shield")) / maximum if maximum else 1.0


def _engagement_reach(unit, target, pursue):
    # Direct targeting can close a short visible gap beyond automatic firing
    # range. This is an approach allowance, never a weapon-range bonus.
    approach = 4.0 if pursue and _durability(unit) >= .5 else 2.0
    return (_range(unit, target) + _value(unit, "radius", .5)
            + _value(target, "radius", .5) + approach)


def _exposure(unit, point, enemies):
    """Local danger estimate; no claim about threats beyond the current view."""
    danger = 0.0
    for enemy in enemies:
        if not _hits(enemy, unit):
            continue
        reach = _range(enemy, unit) + _value(enemy, "radius", .5) + _value(unit, "radius", .5)
        distance = _distance(enemy, point)
        gap = max(0.0, distance - reach)
        dps = max(1.0, _value(enemy, "air_dps" if unit.is_flying else "ground_dps", 1.0))
        danger += dps * (1.0 / (1.0 + gap * gap) + .05 / (1.0 + distance))
    return danger


def _retreat_points(unit, nearest, enemies, step):
    # Ares' stutter/safety separation motivates this independent, bounded
    # screen-local implementation. See MICRO_SOURCES.md. A straight step away
    # from one enemy can walk into another group, so compare a fan of exits.
    angle = math.atan2(unit.position.y - nearest.position.y, unit.position.x - nearest.position.x)
    points = [type(unit.position)((unit.position.x + math.cos(angle + turn) * step,
                                   unit.position.y + math.sin(angle + turn) * step))
              for turn in (0, math.pi / 4, -math.pi / 4, math.pi / 2, -math.pi / 2)]
    current = _exposure(unit, unit.position, enemies)
    return tuple(sorted((p for p in points if _exposure(unit, p, enemies) < current - 1e-6),
                        key=lambda p: _exposure(unit, p, enemies)))


def _ready_attack_in_progress(unit, enemies):
    """Do not cancel a ready shot at a valid, currently visible target."""
    orders = getattr(unit, "orders", ())
    if not orders or _value(unit, "weapon_cooldown") > 2:
        return False
    order = orders[0]
    ability = getattr(order, "ability", None)
    ability = getattr(ability, "id", ability)
    if ability not in {A.ATTACK, A.ATTACK_ATTACK, A.ATTACK_ATTACKTOWARDS, A.ATTACK_ATTACKBARRAGE}:
        return False
    target_tag = getattr(order, "target", None)
    return any(e.tag == target_tag and _hits(unit, e)
               and _distance(unit, e) <= _range(unit, e) + _value(unit, "radius", .5)
               + _value(e, "radius", .5) for e in enemies)


class CoachCombat:
    """Rotate control among unit types; protect damaged ranged units locally."""

    def __init__(self):
        self.last_input = -100.0
        self.type_attention = {}
        self.withdrawing = {}
        self.guardian_ready_after = -100.0
        self.guardian_casters = {}
        self.confirmed_guardian_casts = 0
        self.last_reason = None

    def confirm(self, name, accepted, now, source_tags=()):
        if name != "combat_guardian_shield":
            return
        for tag in source_tags:
            if accepted:
                self.guardian_casters[tag] = float(now) + 12.0
            else:
                self.guardian_casters.pop(tag, None)
        if accepted:
            self.confirmed_guardian_casts += 1
        else:
            self.guardian_ready_after = float(now) + 3.0

    def choose(self, own, enemies, now, *, retreat=False, pursue=False):
        if now - self.last_input < 1.0:
            return None
        army = [u for u in own if u.is_ready and not u.is_structure
                and u.type_id not in {U.PROBE, U.SCV, U.DRONE}
                and not getattr(u, "is_hallucination", False)
                and getattr(u, "can_attack", False)]
        targets = [u for u in enemies if getattr(u, "can_be_attacked", False)
                   and getattr(u, "is_visible", True) and not getattr(u, "is_snapshot", False)]
        if not army or not targets:
            return None

        if now >= self.guardian_ready_after:
            active = [u for u in army if u.type_id == U.SENTRY
                      and B.GUARDIANSHIELD in getattr(u, "buffs", ())]
            options = []
            for sentry in army:
                if (sentry.type_id != U.SENTRY or _value(sentry, "energy") < 75
                        or now < self.guardian_casters.get(sentry.tag, -100)
                        or B.GUARDIANSHIELD in getattr(sentry, "buffs", ())):
                    continue
                friends = [u for u in army if _distance(sentry, u) <= 4
                           and B.GUARDIANSHIELD not in getattr(u, "buffs", ())
                           and not any(_distance(caster, u) <= 4 for caster in active)]
                threatened, shooters = set(), set()
                for friend in friends:
                    for enemy in targets:
                        if (_hits(enemy, friend) and _range(enemy, friend) >= 3
                                and _distance(enemy, friend) <= _range(enemy, friend)
                                + _value(enemy, "radius", .5) + _value(friend, "radius", .5) + 1):
                            threatened.add(friend.tag)
                            shooters.add(enemy.tag)
                if len(friends) >= 3 and len(threatened) >= 2 and len(shooters) >= 2:
                    options.append((len(threatened), len(shooters), _durability(sentry),
                                    _value(sentry, "energy"), -sentry.tag, sentry))
            if options:
                sentry = max(options, key=lambda item: item[:-1])[-1]
                return CombatIntent((sentry,), A.GUARDIANSHIELD_GUARDIANSHIELD, None, "guardian_shield")

        # Cover a retreat with Guardian Shield, but do not override it with
        # focus fire or a different movement job.
        if retreat:
            return None

        # A short retreat is useful only under immediate visible pressure.
        # Do not pull melee units out of their own attack range, or kite a
        # ready-to-fire ranged unit merely because a distant enemy exists.
        for unit in sorted(army, key=lambda u: (_durability(u), u.tag)):
            threats = [e for e in targets if _hits(e, unit)
                       and _distance(unit, e) <= _range(e, unit) + _value(e, "radius", .5)
                       + _value(unit, "radius", .5) + 2.0]
            if not threats or max(_value(unit, "ground_range"), _value(unit, "air_range")) < 3:
                continue
            nearest = min(threats, key=lambda e: (_distance(unit, e), e.tag))
            dying = _durability(unit) <= .35
            cooldown_kite = (_value(unit, "weapon_cooldown") > 8
                             and _range(unit, nearest) >= _range(nearest, unit) + 2
                             and _distance(unit, nearest) < _range(unit, nearest))
            if not dying and not cooldown_kite:
                continue
            distance = _distance(unit, nearest)
            if distance < .01:
                continue
            step = 2.5 if dying else 1.5
            points = _retreat_points(unit, nearest, targets, step)
            if points:
                return CombatIntent((unit,), A.MOVE_MOVE, points[0],
                                    "damaged_ranged_retreat" if dying else "cooldown_kite", points[1:])

        groups = {}
        for unit in army:
            if now >= self.withdrawing.get(unit.tag, -100):
                groups.setdefault(unit.type_id, []).append(unit)
        # Avoid repeatedly commanding only the first Zealot group while the
        # Stalkers and Immortals remain uncommanded.
        ordered = sorted(groups, key=lambda k: (self.type_attention.get(k, -100.0), k.value))
        for kind in ordered:
            group = groups[kind]
            reachable = [e for e in targets if any(_hits(u, e)
                         and _distance(u, e) <= _engagement_reach(u, e, pursue) for u in group)]
            if not reachable:
                continue
            fighters = [e for e in reachable if getattr(e, "can_attack", False)
                        and e.type_id not in {U.PROBE, U.SCV, U.DRONE}]
            pool = fighters or reachable
            if kind == U.IMMORTAL:
                armored = [e for e in pool if getattr(e, "is_armored", False)]
                pool = armored or pool
            target = min(pool, key=lambda e: (_value(e, "health") + _value(e, "shield"),
                                              min(_distance(u, e) for u in group), e.tag))
            sources = tuple(u for u in group if _hits(u, target)
                            and _distance(u, target) <= _engagement_reach(u, target, pursue))
            if any(u.type_id == kind and u not in sources for u in army):
                # AllType would reselect a wounded unit even if omitted from
                # sources, or pull distant reinforcements into a focus-fire
                # chase. Use a single click while other same-type units rally.
                sources = sources[:1]
            if sources:
                return CombatIntent(sources, A.ATTACK_ATTACK, target, "focus_visible_threat")
        return None

    async def step(self, bot, own, enemies, order, *, protected_tags=(), guardian_only=False):
        now = float(bot.time)
        # Defensive checks make the boundary explicit even if a future caller
        # accidentally supplies stale remembered objects or off-screen units.
        screen_own = [u for u in own if getattr(u, "is_mine", False) and bot.fairplay.on_screen(u)]
        own = [u for u in screen_own if u.tag not in protected_tags and bot.fairplay.source_available(u, now)]
        enemies = [e for e in enemies if bot.fairplay.on_screen(e)
                   and getattr(e, "is_visible", False) and not getattr(e, "is_snapshot", False)]
        intent = self.choose(own, enemies, now, retreat=bool(order and order.stance == "retreat"),
                             pursue=bool(order and order.stance in {"pressure", "attack"}))
        if intent is None or (guardian_only and intent.ability != A.GUARDIANSHIELD_GUARDIANSHIELD):
            return False
        target = intent.target
        if intent.ability == A.MOVE_MOVE:
            # Refuse to query refreshed pathing in fog or outside the camera.
            target = next((point for point in (target, *intent.alternatives)
                           if bot.fairplay.on_screen(point) and bot.is_visible(point)
                           and (getattr(intent.sources[0], "is_flying", False)
                                or bot.in_pathing_grid(point))), None)
            if target is None:
                return False
        available = await bot.get_available_abilities(list(intent.sources), ignore_resource_requirements=False)
        data = bot.game_data.abilities.get(intent.ability.value)
        canonical = data.id if data else intent.ability
        eligible = [u for u, abilities in zip(intent.sources, available, strict=True)
                    if (intent.ability in abilities or canonical in abilities)
                    and not duplicate_order([u], intent.ability, target, bot.game_data)
                    and not (intent.ability == A.ATTACK_ATTACK and _ready_attack_in_progress(u, enemies))]
        if not eligible:
            if intent.ability == A.GUARDIANSHIELD_GUARDIANSHIELD:
                self.guardian_ready_after = now + 3.0
            # Remember this type's attention even when its correct attack is
            # already executing, so a second type can be considered next tick.
            self.type_attention[intent.sources[0].type_id] = now
            return False
        # Removing a source after the ability/order checks must not cause a
        # control-click to silently reselect it anyway.
        if len(eligible) > 1 and any(u.type_id == eligible[0].type_id and u not in eligible for u in screen_own):
            eligible = eligible[:1]
        accepted = await bot.fairplay.issue(bot, eligible, intent.ability, target, minimap=False)
        if accepted:
            self.last_input = now
            self.type_attention[eligible[0].type_id] = now
            if intent.ability == A.MOVE_MOVE:
                self.withdrawing[eligible[0].tag] = now + 4.0
            if intent.ability == A.GUARDIANSHIELD_GUARDIANSHIELD:
                self.guardian_ready_after = now + 1.0
                # Provisional lease while the selection's actual command is
                # confirmed; it is not a claimed cast or full-duration lock.
                self.guardian_casters[eligible[0].tag] = now + 2.0
            self.withdrawing = {tag: until for tag, until in self.withdrawing.items() if until > now}
            self.last_reason = intent.reason
            bot._record_selection("combat_" + intent.reason, target)
            bot.action_counts["combat_" + intent.reason] += 1
        return accepted
