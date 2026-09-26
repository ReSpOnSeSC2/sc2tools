"""Screen-local Recharge / hallucinated Phoenix scouting for the coached bot.

Spell affordability and cooldowns come from the engine's available abilities.
The caller confirms the spatial command through ``confirm``; a successful
selection alone never proves a spell was cast or a Phoenix was created.
"""
from __future__ import annotations

import math

from sc2.ids.ability_id import AbilityId as A
from sc2.ids.unit_typeid import UnitTypeId as U
from sc2.position import Point2


# Public patch references, not cooldown/affordability assumptions:
# https://news.blizzard.com/en-gb/article/24162754/starcraft-ii-5-0-14-patch-notes
# https://news.blizzard.com/en-us/article/24225313/starcraft-ii-5-0-15-patch-notes
# The former documents12 Nexus range; the latter changes the grant to50 energy.
RECHARGE_HOME_RADIUS = 12.0
RECHARGE_HEADROOM = 50.0
SCOUT_INTERVAL_SECONDS = 60.0  # Strategy cadence, not a spell cooldown.
BIRTH_OBSERVATION_SECONDS = 15.0


def _number(value, default=0.0):
    return float(value) if isinstance(value, (int, float)) and math.isfinite(value) else default


def _distance(first, second):
    return first.position.distance_to(getattr(second, "position", second))


class CoachScoutSpells:
    def __init__(self):
        self.pending = None
        self.awaiting_birth = None
        self.recharged_sentry = None
        self.last_cast = -math.inf
        self.retry_after = -math.inf
        self.dispatched_tags = set()
        self.confirmed_recharges = 0
        self.confirmed_casts = 0
        self.confirmed_dispatches = 0
        self._first_recharge_reservation_at = None
        self._first_recharge_reservation_until = None

    @property
    def status(self):
        return {"pending_action": self.pending["name"] if self.pending else None,
                "awaiting_phoenix": self.awaiting_birth is not None,
                "last_cast_game_seconds": self.last_cast if math.isfinite(self.last_cast) else None,
                "confirmed_recharges": self.confirmed_recharges,
                "confirmed_casts": self.confirmed_casts,
                "confirmed_dispatches": self.confirmed_dispatches,
                "dispatched_tags": sorted(self.dispatched_tags)}

    def confirm(self, name, accepted, now, source_tags=(), target=None):
        """Consume the normal fairplay command confirmation, never a selection."""
        pending = self.pending
        if pending is None or name != pending["name"]:
            return
        if source_tags and pending["source_tag"] not in source_tags:
            return
        self.pending = None
        if not accepted:
            self.retry_after = float(now) + 3.0
            return
        if name == "scout_energy_recharge":
            self.confirmed_recharges += 1
            self.recharged_sentry = pending["target_tag"]
        elif name == "scout_hallucinate_phoenix":
            self.last_cast = float(now)
            self.confirmed_casts += 1
            self.recharged_sentry = None
            self.awaiting_birth = {"before_tags": pending["before_tags"],
                                   "position": pending["position"], "confirmed_at": float(now)}
        elif name == "scout_hallucinated_phoenix":
            self.dispatched_tags.add(pending["source_tag"])
            self.confirmed_dispatches += 1
            self.awaiting_birth = None

    def reserve_for_first_recharge(self, report, order, now):
        """Briefly defer optional Chrono when the first real Sentry is imminent.

        Observed queue time plus20 seconds of camera allowance is reserved,
        capped at60 seconds once. This is not an assumed Nexus spell cost or
        cooldown. Worker and army production retain their priority.
        """
        now = _number(now, math.inf)
        if (order is None or not order.scout or order.stance == "retreat" or not 0 <= now <= 300
                or self.confirmed_recharges or self.confirmed_casts):
            return False
        current = {record.get("tag"): record for record in report.get("current_own", ())}
        records = {record.get("tag"): record for record in report.get("own_memory", ())}
        records.update(current)
        reserve_windows = []
        for tag, record in records.items():
            if record.get("is_hallucination", False):
                continue
            seen = _number(record.get("last_seen_seconds"), -math.inf)
            if tag not in current and not 0 <= now - seen <= 60:
                continue
            if record.get("type") == "SENTRY":
                reserve_windows.append(20.0)
                continue
            remaining = 0.0
            costs = report.get("action_costs", {})
            for queued in record.get("orders", ()):
                sentry = (queued.get("produces") == "SENTRY"
                          or queued.get("ability_id") == A.GATEWAYTRAIN_SENTRY.value)
                action = "train_" + ("sentry" if sentry else str(queued.get("produces", "")).lower())
                duration = _number(costs.get(action, {}).get("time_seconds"), math.inf)
                progress = min(1.0, max(0.0, _number(queued.get("progress"))))
                remaining += duration * (1.0 - progress) if duration > 0 else math.inf
                if sentry:
                    age = 0.0 if tag in current else now - seen
                    reserve_windows.append(min(60.0, max(20.0, remaining - age + 20.0)))
                    break
        if not reserve_windows:
            return False
        if self._first_recharge_reservation_at is None:
            self._first_recharge_reservation_at = now
            self._first_recharge_reservation_until = now + min(reserve_windows)
        return self._first_recharge_reservation_at <= now < self._first_recharge_reservation_until

    @staticmethod
    def _available(bot, abilities, ability):
        data = bot.game_data.abilities.get(ability.value)
        return ability in abilities or (data is not None and data.id in abilities)

    @staticmethod
    def _recharge_range(bot):
        data = bot.game_data.abilities.get(A.ENERGYRECHARGE_ENERGYRECHARGE.value)
        public_range = _number(getattr(getattr(data, "_proto", None), "cast_range", None))
        return min(RECHARGE_HOME_RADIUS, public_range) if public_range > 0 else RECHARGE_HOME_RADIUS

    async def _issue(self, bot, source, ability, target, name, *, minimap=False, **metadata):
        accepted = await bot.fairplay.issue(bot, [source], ability, target, minimap=minimap)
        if accepted:
            self.pending = {"name": name, "source_tag": int(source.tag), **metadata}
            bot._record_selection(name, target)
            bot.action_counts[name] += 1
        return accepted

    async def step(self, bot, own, enemies, order):
        now = float(bot.time)
        if (self.pending is not None or now < self.retry_after or order is None
                or not order.scout or order.stance == "retreat"):
            return False
        # Never refresh a hidden unit or use an off-screen Nexus for casting.
        own = [u for u in own if getattr(u, "is_mine", False) and getattr(u, "is_visible", False)
               and not getattr(u, "is_snapshot", False) and bot.fairplay.on_screen(u)]
        selectable = [u for u in own if u.is_ready and bot.fairplay.source_available(u, now)]
        hallucinations = [u for u in selectable if u.type_id == U.PHOENIX
                          and getattr(u, "is_hallucination", False)]
        if self.awaiting_birth:
            birth = self.awaiting_birth
            if now - birth["confirmed_at"] > BIRTH_OBSERVATION_SECONDS:
                self.awaiting_birth = None
            else:
                scouts = [u for u in hallucinations if u.tag not in birth["before_tags"]
                          and u.tag not in self.dispatched_tags
                          and _distance(u, Point2(birth["position"])) <= 8]
                if scouts and bot.enemy_start_locations:
                    scout = min(scouts, key=lambda u: u.tag)
                    abilities = (await bot.get_available_abilities([scout], ignore_resource_requirements=False))[0]
                    if self._available(bot, abilities, A.MOVE_MOVE):
                        return await self._issue(bot, scout, A.MOVE_MOVE, bot.enemy_start_locations[0],
                                                 "scout_hallucinated_phoenix", minimap=True)
                return False
        if now - self.last_cast < SCOUT_INTERVAL_SECONDS:
            return False
        # Keep all Sentry energy available for Guardian Shield while a visible
        # local threat exists. Existing hallucination dispatch above stays safe.
        threats = [u for u in enemies if bot.fairplay.on_screen(u) and getattr(u, "is_visible", False)
                   and not getattr(u, "is_snapshot", False) and getattr(u, "can_attack", False)]
        if threats:
            return False
        sentries = [u for u in selectable if u.type_id == U.SENTRY and not getattr(u, "is_hallucination", False)]
        nexuses = [u for u in selectable if u.type_id == U.NEXUS]
        if not sentries:
            return False
        sources = sentries + nexuses
        queried = await bot.get_available_abilities(sources, ignore_resource_requirements=False)
        available = {u.tag: abilities for u, abilities in zip(sources, queried, strict=True)}
        sentries.sort(key=lambda u: (u.tag != self.recharged_sentry,
                      not any(_distance(u, nexus) <= RECHARGE_HOME_RADIUS for nexus in nexuses),
                      -_number(getattr(u, "energy", None)), u.tag))
        radius = self._recharge_range(bot)
        for sentry in sentries:
            energy = _number(getattr(sentry, "energy", None))
            maximum = _number(getattr(sentry, "energy_max", None))
            if sentry.tag != self.recharged_sentry and maximum - energy >= RECHARGE_HEADROOM:
                for nexus in sorted(nexuses, key=lambda u: (_distance(u, sentry), u.tag)):
                    if (_distance(nexus, sentry) <= radius
                            and self._available(bot, available[nexus.tag], A.ENERGYRECHARGE_ENERGYRECHARGE)):
                        return await self._issue(bot, nexus, A.ENERGYRECHARGE_ENERGYRECHARGE, sentry,
                                                 "scout_energy_recharge", target_tag=int(sentry.tag))
            if self._available(bot, available[sentry.tag], A.HALLUCINATION_PHOENIX):
                return await self._issue(bot, sentry, A.HALLUCINATION_PHOENIX, None,
                                         "scout_hallucinate_phoenix", position=list(sentry.position),
                                         before_tags={u.tag for u in own if u.type_id == U.PHOENIX
                                                      and getattr(u, "is_hallucination", False)})
        return False
