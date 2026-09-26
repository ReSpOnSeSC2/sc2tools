"""Bounded opportunistic worker raids from supplied permitted observations.

This planner performs no engine calls, unit lookup, resource spending or learning.
Current Unit objects or CoachMemory records may be supplied. Records need current
combat statistics to authorize a fight; absent statistics never imply safety.
Remembered bases support bounded camera reconnaissance, not hidden attacks.

Design evidence: runs/full-replay-review-20260925/PHASE_PLANS.md records two
Adepts trading for four Probes in PvP (9c809a83c5af), early SCV damage followed
by economic growth in PvT (1710066f0281), and worker/Hatchery damage during the
cohesive PvZ Adept/Sentry push (86b7fe43c494). These retrospective examples
justify economic targets, not their precise trades, timings or hidden state.
"""
from __future__ import annotations

from itertools import combinations
import math
from numbers import Real

from sc2.ids.ability_id import AbilityId as A
from sc2.ids.buff_id import BuffId as B


RAID_TYPES = {"ADEPT", "ORACLE", "STALKER", "ZEALOT"}
RAID_PRIORITY = {"ADEPT": 0, "ORACLE": 1, "STALKER": 2, "ZEALOT": 3}
RAID_SUPPLY = {"ADEPT": 2, "ORACLE": 3, "STALKER": 2, "ZEALOT": 2}
WORKER_TYPES = {"PROBE", "SCV", "DRONE", "MULE"}
BASE_TYPES = {"NEXUS", "COMMANDCENTER", "ORBITALCOMMAND", "PLANETARYFORTRESS", "HATCHERY", "LAIR", "HIVE"}
STATIC_DANGER = {"BUNKER", "PHOTONCANNON", "PLANETARYFORTRESS", "SPINECRAWLER", "AUTOTURRET"}
STATIC_AIR_DANGER = {"BUNKER", "PHOTONCANNON", "MISSILETURRET", "SPORECRAWLER", "AUTOTURRET"}
MAX_RAID_SECONDS = 20.0


def _get(value, name, default=None):
    return value.get(name, default) if isinstance(value, dict) else getattr(value, name, default)


def _number(value, default=None):
    return float(value) if isinstance(value, Real) and not isinstance(value, bool) and math.isfinite(value) else default


def _point(value):
    try:
        point = tuple(float(x) for x in value)
    except (TypeError, ValueError):
        return None
    return point if len(point) == 2 and all(math.isfinite(x) for x in point) else None


def _kind(value):
    return value.get("type") if isinstance(value, dict) else getattr(getattr(value, "type_id", None), "name", None)


def _names(values):
    return {str(getattr(value, "name", value)).upper().replace("_", "") for value in values}


def _attack_intent(unit):
    try:
        return bool(_get(unit, "is_attacking", False))
    except (KeyError, ValueError):
        # Burnysc2 decodes Unit.orders through game_data. Patch-reserved orders
        # (native 4135) can be absent there. Unknown is not an attack label and
        # must not qualify an enemy worker for the reduced mining allowance.
        return None


def _public_toggle(public, ability):
    data = public.get(ability.value) if public is not None else None
    proto = _get(data, "_proto", data)
    return proto is not None and _get(proto, "target") == 1 and _get(proto, "available", False) is True


def _oracle_state(unit, abilities_by_tag, public):
    names = _names((abilities_by_tag or {}).get(unit["tag"], ()))
    off = "BEHAVIORPULSARBEAMOFF" in names and _public_toggle(public, A.BEHAVIOR_PULSARBEAMOFF)
    active = "ORACLEWEAPON" in unit["buffs"] or str(B.ORACLEWEAPON.value) in unit["buffs"]
    return {"beam_active": active, "beam_off_available": off,
            "beam_on_available": ("BEHAVIORPULSARBEAMON" in names
                                  and _public_toggle(public, A.BEHAVIOR_PULSARBEAMON)
                                  and _public_toggle(public, A.BEHAVIOR_PULSARBEAMOFF) and not active
                                  and unit["energy"] >= 50),
            "beam_attack_available": active and off and bool(names & {"ATTACK", "ATTACKATTACK"})
                                     and unit["energy"] >= 15}


def _current(unit, now, *, own):
    # Check camera/visibility flags before reading positions or combat data.
    if isinstance(unit, dict):
        age = now - _number(unit.get("last_seen_seconds"), -math.inf)
        if unit.get("current") is not True or not 0 <= age <= 2:
            return None
    elif (not _get(unit, "is_on_screen", False) or not _get(unit, "is_visible", False)
          or _get(unit, "is_snapshot", False)):
        return None
    if (_get(unit, "is_mine", own) is not own or _get(unit, "is_hallucination", False)
            or not _get(unit, "is_ready", False)):
        return None
    kind = _kind(unit)
    if own and kind not in RAID_TYPES:
        return None  # Own builders/workers/structures are not raid candidates.
    position, tag = _point(_get(unit, "position")), _get(unit, "tag")
    health, maximum = _number(_get(unit, "health")), _number(_get(unit, "health_max"))
    shield, shield_max = _number(_get(unit, "shield"), 0), _number(_get(unit, "shield_max"), 0)
    if position is None or type(tag) is not int or tag <= 0 or health is None or maximum is None or maximum <= 0:
        return None
    return {"tag": tag, "type": kind, "position": position, "health": max(0, health),
            "durability": max(0, health + shield), "maximum": maximum + shield_max,
            "dps": _number(_get(unit, "ground_dps")), "range": _number(_get(unit, "ground_range")),
            "speed": _number(_get(unit, "movement_speed"), 2.5),
            "can_attack_ground": bool(_get(unit, "can_attack_ground", False)),
            "can_attack_air": bool(_get(unit, "can_attack_air", False)),
            "air_dps": _number(_get(unit, "air_dps")), "air_range": _number(_get(unit, "air_range")),
            "is_flying": bool(_get(unit, "is_flying", False)),
            "energy": _number(_get(unit, "energy"), 0), "buffs": _names(_get(unit, "buffs", ())),
            "is_attacking": _attack_intent(unit) if not own else None,
            "is_structure": bool(_get(unit, "is_structure", False))}


def _distance(a, b):
    return math.dist(a["position"], b["position"] if isinstance(b, dict) else b)


def _favorable(group, target, enemies):
    """Conservative local heuristic, not a prediction of battle outcome."""
    if group and all(row["type"] == "ORACLE" for row in group):
        # Burnysc2 special-cases Oracle.can_attack_ground=True even when its
        # public weapon list is empty and ground_dps=0. Never treat that flag
        # alone as an active weapon or fabricate DPS. With missing weapon stats
        # permit only an exposed ground worker and no observed local anti-air.
        return (not target["is_flying"] and all(row["is_flying"]
                and row["durability"] / row["maximum"] >= .65
                and (row.get("beam_attack_available") or row.get("beam_on_available"))
                and _distance(row, target) <= 10 for row in group)
                and not _oracle_danger(group, target, enemies))
    if not group or any(row["dps"] is None or row["dps"] <= 0 or row["range"] is None
                        or row["durability"] / row["maximum"] < .65 for row in group):
        return False
    nearby = [enemy for enemy in enemies if _distance(enemy, target) <= 10]
    if any(row["type"] == "ZEALOT" for row in group) and (
            max(_distance(row, target) for row in group) > 4
            or any(enemy["type"] not in WORKER_TYPES and enemy["can_attack_ground"] for enemy in nearby)):
        return False  # A nearby undefended opportunity, never a generic Zealot diversion.
    if any(enemy["type"] in STATIC_DANGER for enemy in nearby):
        return False
    threats = [enemy for enemy in nearby if enemy["can_attack_ground"]]
    if any(enemy["dps"] is None or enemy["range"] is None for enemy in threats):
        return False
    defending = [enemy for enemy in threats if enemy["type"] not in WORKER_TYPES or enemy["is_attacking"] is not False
                 or min(_distance(enemy, unit) for unit in group) <= enemy["range"] + 1.5]
    mining = [enemy for enemy in threats if enemy not in defending]
    # Mining workers are economic targets, not an assumed coordinated army.
    # Keep a small potential retaliation allowance; actual attacking workers
    # or workers already in contact contribute their full observed strength.
    mining_dps = min(sum(unit["dps"] for unit in mining), 2 * max((unit["dps"] for unit in mining), default=0))
    mining_power = min(sum(unit["durability"] * unit["dps"] for unit in mining),
                       2 * max((unit["durability"] * unit["dps"] for unit in mining), default=0))
    our_power = sum(unit["durability"] * unit["dps"] for unit in group)
    their_power = sum(unit["durability"] * unit["dps"] for unit in defending) + mining_power
    # Require a strong local margin and a short path to an exposed worker.
    if our_power < 1.75 * their_power or max(_distance(unit, target) for unit in group) > 12:
        return False
    first_kill_seconds = target["durability"] / sum(unit["dps"] for unit in group)
    first_kill_seconds += max(max(0, _distance(unit, target) - unit["range"] - 1)
                              / max(.5, unit["speed"]) for unit in group)
    return (sum(unit["dps"] for unit in defending) + mining_dps) * first_kill_seconds <= .3 * sum(unit["durability"] for unit in group)


def _oracle_danger(group, target, enemies):
    return any((enemy["can_attack_air"] or enemy["type"] in STATIC_AIR_DANGER)
               and (_distance(enemy, target) <= max(12, (enemy["air_range"] or 0) + 4)
                    or any(_distance(enemy, unit) <= max(12, (enemy["air_range"] or 0) + 4) for unit in group))
               for enemy in enemies)


class CoachHarassment:
    """Accepted raids own a short lease; failed clicks cannot reserve units."""

    def __init__(self):
        self.mission = None
        self.camera_visit = None
        self.next_raid = 0.0
        self.next_camera = 0.0
        self.next_input = 0.0
        self.last_now = 0.0
        self.serial = 0
        self.pending = None
        self.worker_health = {}
        self.observed_worker_health_decline = 0.0
        self.accepted_worker_orders = 0
        self.last_reason = None
        self.oracle_cleanup = set()

    def protected_tags(self, now):
        return ({tag: self.mission["until"] for tag in self.mission["tags"]}
                if self.mission and now < self.mission["until"] else {})

    def blocks_global_army(self, now):
        return bool(self.protected_tags(now))

    def _intent(self, name, now, *, sources=(), target=None, position=None, reason, **extra):
        self.serial += 1
        value = {"id": self.serial, "name": name, "kind": "camera" if name == "harass_camera" else
                 "release" if name == "harass_release" else "command", "source_tags": sorted(sources),
                 "target_tag": target, "position": list(position) if position is not None else None,
                 "reason": reason, "expires_at": now + 2,
                 "selection_mode": "rectangle" if len(sources) > 1 else "point",
                 "requires_current_visible_ground": name == "harass_retreat",
                 "ability_id": {"harass_workers": A.ATTACK_ATTACK.value,
                     "harass_retreat": A.MOVE_MOVE.value, "harass_oracle_beam_on": A.BEHAVIOR_PULSARBEAMON.value,
                     "harass_oracle_beam_off": A.BEHAVIOR_PULSARBEAMOFF.value}.get(name), **extra}
        self.pending, self.last_reason = value, reason
        return dict(value)

    def _retreat(self, active, enemies, now, anchor, reason):
        if not active:
            return self._intent("harass_release", now, reason=reason)
        point = _point(anchor)
        if point is not None:
            leader = min(active, key=lambda unit: unit["durability"] / unit["maximum"])
            distance = math.dist(point, leader["position"])
            if distance > 3:
                point = tuple(start + (end - start) * 3 / distance for start, end in zip(leader["position"], point))
        if point is None:
            nearest = min(enemies, key=lambda enemy: min(_distance(unit, enemy) for unit in active), default=None)
            leader = min(active, key=lambda unit: unit["durability"] / unit["maximum"])
            if nearest is not None:
                dx = leader["position"][0] - nearest["position"][0]
                dy = leader["position"][1] - nearest["position"][1]
                length = math.hypot(dx, dy)
                if length > .01:
                    point = (leader["position"][0] + dx * 3 / length, leader["position"][1] + dy * 3 / length)
        if point is None:
            return self._intent("harass_release", now, reason=reason)
        return self._intent("harass_retreat", now, sources=[unit["tag"] for unit in active],
                            position=point, reason=reason,
                            movement_domain="air_over_visible_ground" if all(unit["is_flying"] for unit in active) else "ground")

    def plan(self, own, enemies, now, hud_army, *, defense_alert=False, production_due=False,
             protected_tags=(), retreat_anchor=None, enemy_memory=(), camera=None,
             completed_upgrades=(), abilities_by_tag=None, public_abilities=None):
        now, supply = _number(now), _number(hud_army)
        if now is None or now < self.last_now or supply is None or supply < 0:
            raise ValueError("Harassment requires monotonic time and finite nonnegative own HUD army supply")
        self.last_now = now
        ours = [row for unit in own if (row := _current(unit, now, own=True)) is not None]
        for row in ours:
            if row["type"] == "ORACLE":
                row.update(_oracle_state(row, abilities_by_tag, public_abilities))
        ours_tags = {row["tag"] for row in ours}
        theirs = [row for unit in enemies if (row := _current(unit, now, own=False)) is not None
                  and row["tag"] not in ours_tags]
        workers = [row for row in theirs if row["type"] in WORKER_TYPES]
        for worker in workers:
            previous = self.worker_health.get(worker["tag"])
            if previous:
                self.observed_worker_health_decline += max(0, previous["health"] - worker["health"])
                previous.update(health=worker["health"], last_seen=now)
        self.worker_health = {tag: row for tag, row in self.worker_health.items() if now - row["last_seen"] <= 60}
        if self.pending and now <= self.pending["expires_at"]:
            return None  # Await actual input confirmation; never duplicate a requested raid.
        self.pending = None
        cleanup = next((unit for unit in ours if unit["tag"] in self.oracle_cleanup
                        and unit.get("beam_active") and unit.get("beam_off_available")), None)
        if cleanup is not None:
            return self._intent("harass_oracle_beam_off", now, sources=[cleanup["tag"]],
                                reason="stop_leftover_oracle_energy_drain", cleanup=True)
        self.oracle_cleanup.difference_update(unit["tag"] for unit in ours if unit["type"] == "ORACLE"
                                             and not unit.get("beam_active"))
        if self.camera_visit:
            visit = self.camera_visit
            if (production_due or now >= visit["until"] or not theirs and now >= visit["issued"] + .5):
                return self._intent("harass_camera", now, position=visit["return_position"],
                                    reason="return_after_bounded_raid_camera", camera_return=True)
        if self.mission:
            active = [unit for unit in ours if unit["tag"] in self.mission["tags"]]
            self.mission["seen"].update({unit["tag"]: {"position": unit["position"], "time": now} for unit in active})
            if now >= self.mission["until"]:
                oracle = next((unit for unit in active if unit.get("beam_active") and unit.get("beam_off_available")), None)
                if oracle is not None:
                    return self._intent("harass_oracle_beam_off", now, sources=[oracle["tag"]],
                                        reason="oracle_raid_complete_stop_energy", release_after=True)
                return self._intent("harass_release", now, reason="raid_lease_expired_regroup")
            if self.mission["status"] == "regrouping":
                oracle = next((unit for unit in active if unit.get("beam_active") and unit.get("beam_off_available")), None)
                if oracle is not None:
                    return self._intent("harass_oracle_beam_off", now, sources=[oracle["tag"]],
                                        reason="disable_beam_after_urgent_retreat", keep_regrouping=True)
                return None
            if defense_alert or self.mission["supply"] > .2 * supply:
                return self._retreat(active, theirs, now, retreat_anchor, "main_army_defense_or_supply_loss")
            if not active:
                seen = max(self.mission["seen"].values(), key=lambda row: row["time"])
                if (not production_due and now >= self.next_camera and now - seen["time"] <= 6
                        and _point(camera) is not None):
                    return self._intent("harass_camera", now, position=seen["position"],
                        reason="brief_reacquire_raid_from_own_observation", return_position=_point(camera))
                return self._intent("harass_release", now, reason="raiders_outside_current_vision_regroup")
            oracles = [unit for unit in active if unit["type"] == "ORACLE"]
            if oracles:
                if _oracle_danger(oracles, oracles[0], theirs) or any(unit["durability"] / unit["maximum"] < .5 for unit in oracles):
                    return self._retreat(oracles, theirs, now, retreat_anchor, "visible_oracle_anti_air_or_damage")
                if self.mission["status"] == "arming":
                    if all(unit.get("beam_attack_available") for unit in oracles):
                        self.mission["status"] = "raiding"
                    elif now - self.mission["started"] <= 3:
                        return None  # Accepted toggle is not proof that the actual weapon activated.
                    else:
                        return self._retreat(oracles, theirs, now, retreat_anchor, "oracle_weapon_activation_not_observed")
                if self.mission["status"] == "regroup_pending":
                    return self._retreat(oracles, theirs, now, retreat_anchor, "oracle_beam_disabled_regroup")
                if not workers or any(not unit.get("beam_attack_available") for unit in oracles):
                    oracle = next((unit for unit in oracles if unit.get("beam_active") and unit.get("beam_off_available")), None)
                    if oracle is not None:
                        return self._intent("harass_oracle_beam_off", now, sources=[oracle["tag"]],
                                            reason="oracle_no_target_or_low_energy")
                    return self._retreat(oracles, theirs, now, retreat_anchor, "oracle_no_current_active_weapon")
            targets = [worker for worker in workers if _favorable(active, worker, theirs)]
            if not targets or any(unit["durability"] / unit["maximum"] < .5 for unit in active):
                return self._retreat(active, theirs, now, retreat_anchor, "visible_raid_risk_or_no_current_worker_target")
            if now < self.next_input:
                return None
            target = min(targets, key=lambda worker: (worker["health"], min(_distance(unit, worker) for unit in active), worker["tag"]))
            return self._intent("harass_workers", now, sources=[unit["tag"] for unit in active], target=target["tag"],
                position=target["position"], reason="focus_current_exposed_worker", worker_health=target["health"])
        if defense_alert or production_due or now < self.next_raid or now < self.next_input:
            return None
        completed = _names(completed_upgrades)
        candidates = [unit for unit in ours if unit["type"] in RAID_TYPES and unit["tag"] not in protected_tags
                      and (unit["type"] == "ORACLE") == unit["is_flying"]
                      and (unit["type"] != "STALKER" or "BLINKTECH" in completed)]
        if candidates:
            choices = []
            for kind, priority in RAID_PRIORITY.items():
                maximum = min(1 if kind == "ORACLE" else 4, math.floor(.2 * supply / RAID_SUPPLY[kind]))
                for target in workers:
                    close = sorted((unit for unit in candidates if unit["type"] == kind),
                                   key=lambda unit: (_distance(unit, target), unit["tag"]))[:8]
                    for count in range(1 if kind == "ORACLE" else 2, min(maximum, len(close)) + 1):
                        for group in combinations(close, count):
                            if (max(_distance(a, b) for a in group for b in group) <= 6
                                    and _favorable(group, target, theirs)):
                                choices.append((priority, count, target["health"], max(_distance(unit, target) for unit in group),
                                                tuple(unit["tag"] for unit in group), group, target))
                        if choices:
                            break
                if choices:
                    break  # Adepts/Oracles own harassment; other types are fallback opportunities.
            if choices:
                *_, group, target = min(choices, key=lambda item: item[:5])
                details = {"source_positions": {unit["tag"]: unit["position"] for unit in group},
                    "source_types": {unit["tag"]: unit["type"] for unit in group},
                    "raid_supply": sum(RAID_SUPPLY[unit["type"]] for unit in group)}
                details["army_fraction"] = details["raid_supply"] / supply
                if group[0]["type"] == "ORACLE" and not group[0].get("beam_attack_available"):
                    return self._intent("harass_oracle_beam_on", now, sources=[group[0]["tag"]],
                                        reason="activate_available_oracle_weapon_before_raid", **details)
                return self._intent("harass_workers", now, sources=[unit["tag"] for unit in group],
                    target=target["tag"], position=target["position"], reason="small_exposed_worker_raid",
                    worker_health=target["health"], **details)
        # At most a short look at an actually scouted economy location. Do not
        # detach units or assume the remembered mineral line remains undefended.
        if workers or now < self.next_camera or _point(camera) is None or self.camera_visit:
            return None
        sites = [record for record in enemy_memory if isinstance(record, dict) and record.get("type") in BASE_TYPES
                 and 0 <= now - _number(record.get("last_seen_seconds"), -math.inf) <= 45
                 and record.get("status") not in {"not_seen_at_visible_position", "destroyed"}
                 and _point(record.get("position")) is not None]
        if sites:
            site = max(sites, key=lambda record: record["last_seen_seconds"])
            position = _point(site["position"])
            if math.dist(position, _point(camera)) >= 8:
                return self._intent("harass_camera", now, position=position, reason="recheck_scouted_economy_only",
                                    return_position=_point(camera))
        return None

    def confirm(self, intent, accepted, now, *, actual_source_tags=None):
        now = _number(now)
        if now is None or not isinstance(accepted, bool) or self.pending is None or intent.get("id") != self.pending["id"]:
            return False
        intended = self.pending
        self.pending = None
        actual = set(intended["source_tags"] if actual_source_tags is None else actual_source_tags)
        if not accepted or now > intended["expires_at"] or actual != set(intended["source_tags"]):
            self.next_input = max(self.next_input, now + 3)
            return False
        name = intended["name"]
        if name == "harass_release":
            if self.mission:
                self.oracle_cleanup.update(tag for tag, kind in self.mission["types"].items() if kind == "ORACLE")
            self.mission = None
            self.next_raid = now + 15
        elif name == "harass_camera":
            if intended.get("camera_return"):
                self.camera_visit = None
            else:
                self.camera_visit = {"issued": now, "until": now + 3, "return_position": intended["return_position"]}
            self.next_camera = now + 20
        elif name == "harass_retreat":
            if self.mission:
                self.mission.update(status="regrouping", until=min(self.mission["hard_until"] + 4, now + 4))
        elif name == "harass_oracle_beam_off":
            self.oracle_cleanup.difference_update(actual)
            if self.mission:
                if intended.get("release_after"):
                    self.oracle_cleanup.update(actual)  # Clear only after a fresh observation shows beam absent.
                    self.mission = None
                    self.next_raid = now + 15
                elif not intended.get("keep_regrouping"):
                    self.mission["status"] = "regroup_pending"
        elif name in {"harass_workers", "harass_oracle_beam_on"}:
            if self.mission is None:
                self.mission = {"tags": sorted(actual), "started": now, "until": now + MAX_RAID_SECONDS,
                    "hard_until": now + MAX_RAID_SECONDS,
                    "status": "arming" if name == "harass_oracle_beam_on" else "raiding",
                    "supply": intended["raid_supply"], "types": dict(intended["source_types"]),
                    "seen": {tag: {"position": position, "time": now}
                             for tag, position in intended["source_positions"].items()}}
            if name == "harass_workers":
                self.worker_health[intended["target_tag"]] = {"health": intended["worker_health"], "last_seen": now}
                self.accepted_worker_orders += 1
        self.next_input = now + 1
        return True

    def summary(self):
        return {"mission": self.mission, "camera_visit": self.camera_visit, "last_reason": self.last_reason,
                "oracle_cleanup_tags": sorted(self.oracle_cleanup),
                "accepted_worker_orders": self.accepted_worker_orders,
                "observed_target_worker_health_decline": self.observed_worker_health_decline,
                "damage_scope": "Visible targeted-worker health decline only; no kill inference or causal attribution",
                "combat_scope": "Local current-observation heuristic; unknown offscreen threats remain unknown",
                "oracle_scope": "Actual beam buff and queried abilities required; no invented DPS, no observed local anti-air; retreats use visible pathable ground"}
