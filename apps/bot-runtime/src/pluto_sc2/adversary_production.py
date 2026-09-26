"""Purposeful, policy-selected production relocations using owned observations.

This only changes action masks and destinations. It never picks the policy's
action or issues commands. A producer with no useful relocation stays available
for unit production. Cross-producer addons remain interchangeable.
"""
from __future__ import annotations

from dataclasses import dataclass
import math

from sc2.ids.ability_id import AbilityId as A
from sc2.ids.unit_typeid import UnitTypeId as U
from sc2.position import Point2

from .adversary_addons import ADDONS, PRODUCERS, _landing_claims, reusable_addon_site
from .adversary_orders import pressure_tags
from .adversary_placement import find_placement, site_clear, visible_footprint


PRODUCTION_CONTROL_PROFILE = "purposeful-production-relocation-v1"
GROUND_DWELL_SECONDS = 30.0
RESERVATION_SECONDS = 120.0
# A limited bootstrap preference when the recipient lacks this capability.
# No fulfilled capability is donated back down the ranking, avoiding swaps
# oscillating between producers. Policies still choose every lift and landing.
DONATION_PRIORITY = {"TECHLAB": {"FACTORY": 3, "STARPORT": 2, "BARRACKS": 1},
                     "REACTOR": {"STARPORT": 3, "BARRACKS": 2, "FACTORY": 1}}


def family(unit):
    return next((name for name, kinds in ADDONS.items() if unit.type_id.name in kinds), None)


def unclaimed(bot, producer, target):
    """Own pending landing orders reserve their full body footprint."""
    claims = _landing_claims(list(bot.structures), producer, bot.game_data)
    return target is not None and site_clear(target, 3, occupied=claims)


@dataclass(frozen=True)
class Relocation:
    reason: str
    target: Point2
    addon_tag: int | None = None
    recipient_tag: int | None = None

    def audit(self):
        return dict(reason=self.reason, destination=list(self.target), addon_tag=self.addon_tag,
                    recipient_tag=self.recipient_tag)


class ProductionControl:
    def __init__(self):
        self.flying = {}
        self.grounded_until = {}
        self.proposals = {}
        self.pending = {}
        self.reservations = {}
        self.last_time = -math.inf
        self.accepted_lifts = 0
        self.blocked_lifts = 0

    def observe(self, now, own):
        if not math.isfinite(now) or now < 0 or now < self.last_time:
            raise ValueError("Invalid production observation time")
        self.last_time = now
        observed = {int(u.tag): u for u in own if getattr(u, "is_mine", False)}
        producers = {tag: u for tag, u in observed.items()
                     if u.type_id.name.removesuffix("FLYING") in PRODUCERS}
        for tag, unit in producers.items():
            airborne = bool(unit.is_flying)
            if self.flying.get(tag) is True and not airborne:
                self.grounded_until[tag] = now + GROUND_DWELL_SECONDS
                self.pending.pop(tag, None)
            self.flying[tag] = airborne
        self.flying = {tag: value for tag, value in self.flying.items() if tag in producers}
        self.grounded_until = {tag: until for tag, until in self.grounded_until.items()
                               if tag in producers and until > now}
        self.pending = {tag: plan for tag, plan in self.pending.items() if tag in producers}
        self.reservations = {tag: (recipient, until) for tag, (recipient, until) in self.reservations.items()
                             if tag in observed and recipient in producers and until > now
                             and not any(u.tag == recipient and getattr(u, "add_on_tag", 0) and not u.is_flying
                                         for u in producers.values())}
        self.proposals = {}

    def excluded_addons(self, producer_tag):
        return frozenset(tag for tag, (recipient, _until) in self.reservations.items()
                         if recipient != producer_tag)

    def accepted(self, now, intent):
        if intent.ability is None or intent.ability.name not in {"LIFT_BARRACKS", "LIFT_FACTORY", "LIFT_STARPORT"}:
            return
        for producer in intent.sources:
            plan = self.proposals.get(int(producer.tag))
            if plan is None:
                continue  # Explicit diagnostic bypass is reported separately.
            self.pending[int(producer.tag)] = plan
            self.grounded_until[int(producer.tag)] = now + GROUND_DWELL_SECONDS
            if plan.recipient_tag is not None:
                self.reservations[plan.addon_tag] = (plan.recipient_tag, now + RESERVATION_SECONDS)
            elif plan.addon_tag is not None:
                self.reservations[plan.addon_tag] = (int(producer.tag), now + RESERVATION_SECONDS)
            self.accepted_lifts += 1

    async def lift_plan(self, bot, producer, own, visible_enemies):
        now, tag = float(bot.time), int(producer.tag)
        if now < self.grounded_until.get(tag, -math.inf):
            self.blocked_lifts += 1
            return None
        kind = U[producer.type_id.name.removesuffix("FLYING")]
        addon = next((u for u in own if u.tag == producer.add_on_tag), None)
        if addon is None:
            reuse = await reusable_addon_site(bot, kind, producer,
                                             excluded_addon_tags=self.excluded_addons(tag))
            if reuse is not None:
                plan = Relocation("reuse_owned_addon", reuse[1], int(reuse[0].tag))
                self.proposals[tag] = plan
                return plan
        else:
            # Release a low-priority addon only to create a missing capability
            # for a different owned, idle producer without any attached addon.
            addon_family = family(addon)
            priorities = DONATION_PRIORITY.get(addon_family, {})
            donor_priority = priorities.get(kind.name, 0)
            attached = {u.add_on_tag: u for u in own
                        if u.type_id.name in PRODUCERS and not u.is_flying and u.add_on_tag}
            recipients = []
            for unit in own:
                name = unit.type_id.name
                if (name not in PRODUCERS or priorities.get(name, 0) <= donor_priority
                        or not unit.is_ready or not unit.is_idle or unit.add_on_tag
                        or any(recipient == unit.tag for recipient, _until in self.reservations.values())):
                    continue
                if any(family(other) == addon_family and other.tag in attached
                       and attached[other.tag].type_id.name == name for other in own):
                    continue
                recipients.append(unit)
            if recipients:
                recipient = min(recipients, key=lambda u: (-priorities[u.type_id.name],
                                                          producer.distance_to(u), u.tag))
                target = await find_placement(bot, A["LAND_" + kind.name], kind, producer.position)
                if unclaimed(bot, producer, target):
                    plan = Relocation("donate_missing_addon_capability", target, int(addon.tag), int(recipient.tag))
                    self.proposals[tag] = plan
                    return plan
        # Current visible ground-only fire can justify lifting a damaged
        # building. Land near a known owned base farther from the visible fire.
        pressure = pressure_tags([producer], visible_enemies)
        attackers = [e for e in visible_enemies if e.tag in pressure
                     and not getattr(e, "can_attack_air", False)]
        if attackers and producer.health < producer.health_max * .65:
            bases = [u for u in own if u.type_id.name in {"COMMANDCENTER", "ORBITALCOMMAND", "PLANETARYFORTRESS"}
                     and not u.is_flying]
            if bases:
                center = max(bases, key=lambda u: min(u.distance_to(e) for e in attackers)).position
                target = await find_placement(bot, A["LAND_" + kind.name], kind, center)
                if unclaimed(bot, producer, target) and min(target.distance_to(e.position) for e in attackers) > 10:
                    plan = Relocation("escape_visible_ground_pressure", target)
                    self.proposals[tag] = plan
                    return plan
        # Empty addon socket known to be blocked: relocate to a queried site
        # with addon room. A fogged socket is unknown and cannot justify lift.
        socket = producer.position.offset((2.5, -.5))
        if (addon is None and bot.can_afford(U[kind.name + "TECHLAB"])
                and visible_footprint(socket, 2, bot.is_visible, bot.game_info.playable_area)
                and not await bot.can_place_single(A.TERRANBUILD_SUPPLYDEPOT, socket)):
            target = await find_placement(bot, A["LAND_" + kind.name], kind, producer.position)
            if unclaimed(bot, producer, target) and target.distance_to(producer.position) >= 3:
                plan = Relocation("clear_observed_blocked_addon_socket", target)
                self.proposals[tag] = plan
                return plan
        self.blocked_lifts += 1
        return None

    async def landing_target(self, bot, producer):
        kind = U[producer.type_id.name.removesuffix("FLYING")]
        plan = self.pending.get(int(producer.tag))
        if plan is not None:
            target = plan.target
            reserved_elsewhere = (plan.reason == "reuse_owned_addon"
                                  and plan.addon_tag in self.excluded_addons(int(producer.tag)))
            if (not reserved_elsewhere and unclaimed(bot, producer, target)
                    and visible_footprint(target, 3, bot.is_visible, bot.game_info.playable_area)
                    and await bot.can_place_single(A["LAND_" + kind.name], target)):
                return target
        # A blocked committed destination may use a different currently legal
        # one, but never reclaim a donated addon reserved for another producer.
        reuse = await reusable_addon_site(bot, kind, producer,
                                         excluded_addon_tags=self.excluded_addons(int(producer.tag)))
        target = reuse[1] if reuse is not None else await find_placement(bot, A["LAND_" + kind.name], kind, producer.position)
        return target if unclaimed(bot, producer, target) else None

    def summary(self):
        return dict(version=PRODUCTION_CONTROL_PROFILE, grounded_dwell_seconds=GROUND_DWELL_SECONDS,
                    accepted_purposeful_lifts=self.accepted_lifts, blocked_pointless_lifts=self.blocked_lifts,
                    active_reservations=len(self.reservations))
