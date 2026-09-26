"""Learned Terran/Zerg opponents with explicitly asymmetric input privileges.

They may command their own units anywhere and use a higher input budget. Enemy
features/targets use current visible, detectable units only. Building queries
never probe fog. There are no scripted build orders or resource/debug changes.
"""
from __future__ import annotations

from collections import Counter, deque
from dataclasses import dataclass
import math
from typing import Any, Callable

import numpy as np
from s2clientprotocol import common_pb2 as common, raw_pb2 as raw, sc2api_pb2 as api
from sc2.bot_ai import BotAI
from sc2.data import Race, Result
from sc2.dicts.unit_research_abilities import RESEARCH_INFO
from sc2.dicts.unit_train_build_abilities import TRAIN_INFO
from sc2.ids.ability_id import AbilityId as A
from sc2.ids.buff_id import BuffId
from sc2.ids.unit_typeid import UnitTypeId as U
from sc2.ids.upgrade_id import UpgradeId
from sc2.position import Point2

from .adversary_schema import GRID_SIZE, HISTORY, PROFILE, RaceSpec, get_spec, metadata
from .adversary_orders import (
    EMERGENCY_CADENCE, ORDER_PROFILE, STRATEGIC_ACTIONS, STRATEGIC_CADENCE,
    StrategicOrders, pressure_tags,
)
from .learning import Transition
from .reward_observation import RewardCollector
from .adversary_placement import PLACEMENT_PROFILE, find_placement
from .adversary_landing import LandingGuard
from .adversary_addons import ADDONS, ADDON_REUSE_PROFILE, reusable_addon_site, verified_addon_point
from .adversary_production import ProductionControl
from .adversary_infrastructure import InfrastructureGuard, KINDS as GUARDED_INFRASTRUCTURE


class AdversaryBudget:
    def __init__(self, max_apm=600):
        if type(max_apm) is not int or not 1 <= max_apm <= 10000:
            raise ValueError("Adversary max_apm must be an integer in 1..10000")
        self.max_apm = max_apm
        self.events = deque()
        self.last = -math.inf
        self.observed = -math.inf
        self.peak = 0
        self.audit = []
        self.rejected = 0

    def available(self, now):
        if isinstance(now, bool) or not isinstance(now, (int, float)) or not math.isfinite(now) or now < 0 or now < self.observed - 1e-9:
            raise ValueError("Invalid or backwards adversary game time")
        self.observed = now
        while self.events and self.events[0] <= now - 60:
            self.events.popleft()
        return len(self.events) < self.max_apm and now - self.last >= 60 / self.max_apm - 1e-9

    async def issue(self, bot, intent):
        if not self.available(float(bot.time)):
            return False
        own_tags = {u.tag for u in bot.units + bot.structures}
        if not intent.sources or any(u.tag not in own_tags for u in intent.sources):
            raise ValueError("Adversary command source is not owned")
        target = intent.target
        if hasattr(target, "tag") and getattr(target, "is_enemy", False) and not visible_enemy(target):
            raise ValueError("Adversary cannot command against a fogged enemy")
        command = raw.ActionRawUnitCommand(ability_id=int(intent.ability.value),
                                          unit_tags=[u.tag for u in intent.sources], queue_command=False)
        if target is not None:
            if hasattr(target, "tag"):
                command.target_unit_tag = target.tag
            else:
                command.target_world_space_pos.CopyFrom(common.Point2D(x=target.x, y=target.y))
        now = float(bot.time)
        self.events.append(now)
        self.last = now
        self.peak = max(self.peak, len(self.events))
        event = dict(time=now, kind="raw_command", ability=intent.ability.value,
                     source_tags=list(command.unit_tags),
                     target_tag=getattr(target, "tag", None),
                     target_position=list(target) if target is not None and not hasattr(target, "tag") else None)
        production = getattr(bot, "_production_control", None)
        if production is not None and intent.ability.name.startswith("LIFT_"):
            plan = production.proposals.get(int(intent.sources[0].tag))
            event["production_relocation"] = plan.audit() if plan is not None else None
            event["diagnostic_lift_override"] = bool(getattr(bot, "_diagnostic_allow_unpurposeful_lift", False))
        if intent.ability.name.startswith(("BUILD_TECHLAB", "BUILD_REACTOR")):
            details = getattr(bot.client, "available_ability_details", {})
            event["owned_addon_count"] = sum(unit.type_id.name in ADDONS["TECHLAB"] | ADDONS["REACTOR"]
                                             for unit in bot.structures)
            event["addon_sources"] = [
                {"tag": int(unit.tag), "type": unit.type_id.name, "flying": bool(unit.is_flying),
                 "addon_tag": int(unit.add_on_tag), "orders": [order.ability_id for order in _orders(unit)],
                 "available_abilities": details.get(unit.tag, {})}
                for unit in intent.sources]
        if intent.strategic_action is not None:
            event.update(strategic_action=intent.strategic_action,
                         strategic_emergency=intent.strategic_emergency,
                         visible_pressure_tags=list(intent.visible_pressure_tags))
        self.audit.append(event)
        try:
            response = await bot.client._execute(action=api.RequestAction(actions=[
                api.Action(action_raw=raw.ActionRaw(unit_command=command))]))
            event["result"] = list(response.action.result)
            if event["result"] != [1]:
                self.rejected += 1
                return False
            if intent.strategic_action is not None:
                bot._strategic_orders.accepted(now)
            if production is not None:
                production.accepted(now, intent)
            infrastructure = getattr(bot, "_infrastructure_guard", None)
            if infrastructure is not None:
                infrastructure.accepted(now, intent)
            return True
        except Exception:
            event["transport_error"] = True
            raise

    def summary(self):
        return dict(version=PROFILE, max_apm=self.max_apm, peak_rolling_60s_actions=self.peak,
                    total_actions=len(self.audit), minimum_input_interval_seconds=60 / self.max_apm,
                    rejected_actions=self.rejected, raw_unit_commands=len(self.audit), camera_restricted=False,
                    strategic_order_profile=ORDER_PROFILE, strategic_order_cadence_seconds=STRATEGIC_CADENCE,
                    visible_emergency_cadence_seconds=EMERGENCY_CADENCE)


def validate_adversary_audit(data):
    summary, actions = data["summary"], data["actions"]
    budget = AdversaryBudget(summary["max_apm"])
    if summary.get("version") != PROFILE or summary.get("camera_restricted") is not False:
        raise ValueError("Wrong adversary audit profile")
    peak, rejected, last_strategic = 0, 0, -math.inf
    for event in actions:
        now = event["time"]
        if event.get("kind") != "raw_command" or not event.get("source_tags") or not budget.available(now):
            raise ValueError("Invalid adversary event or action pacing")
        if event.get("transport_error"):
            raise ValueError("Incomplete adversary input transport")
        if not isinstance(event.get("result"), list):
            raise ValueError("Missing adversary command result")
        if event.get("strategic_action") is not None:
            name = event["strategic_action"]
            emergency = event.get("strategic_emergency")
            if name not in STRATEGIC_ACTIONS or type(emergency) is not bool:
                raise ValueError("Invalid strategic command audit")
            if emergency and (name == "attack_enemy_base" or not event.get("visible_pressure_tags")):
                raise ValueError("Strategic emergency has no observed combat pressure")
            if (emergency and name == "attack_visible_enemy"
                    and event.get("target_tag") not in event["visible_pressure_tags"]):
                raise ValueError("Emergency attack target is not an observed combat threat")
            interval = EMERGENCY_CADENCE if emergency else STRATEGIC_CADENCE
            if now - last_strategic < interval - 1e-9:
                raise ValueError("Strategic order cadence violated")
            if event["result"] == [1]:
                last_strategic = now
        budget.events.append(now)
        budget.last = now
        peak = max(peak, len(budget.events))
        rejected += event["result"] != [1]
    expected = dict(total_actions=len(actions), raw_unit_commands=len(actions),
                    peak_rolling_60s_actions=peak, rejected_actions=rejected,
                    minimum_input_interval_seconds=60 / budget.max_apm)
    if any(summary.get(key) != value for key, value in expected.items()):
        raise ValueError("Adversary audit summary disagrees with events")
    return summary


def visible_enemy(unit):
    return (unit.is_visible and not unit.is_snapshot
            and (not unit.is_cloaked or unit.is_revealed))


def entities(bot):
    own = list(bot.units) + list(bot.structures)
    enemies = [u for u in list(bot.enemy_units) + list(bot.enemy_structures) if visible_enemy(u)]
    return own, enemies


def _army(unit, spec):
    # Larva, eggs, workers, supply, tumors and transformation cocoons are not an army.
    return (not unit.is_structure and unit.type_id.name in set(spec.train + spec.morphs + spec.forms)
            and unit.type_id.name not in {spec.worker, "MULE", "LARVA", "EGG", "OVERLORD", "OVERSEER"}
            and not any(s in unit.type_id.name for s in ("COCOON", "EGG", "CREEPTUMOR")))


def encode_observation(bot):
    spec = bot.spec
    own, enemy = entities(bot)
    workers = [u for u in own if u.type_id.name == spec.worker]
    army = [u for u in own if _army(u, spec)]
    bases = [u for u in own if u.type_id.name in spec.bases]
    area = bot.game_info.playable_area
    def position(point):
        return ((point.x - area.x) / area.width, (point.y - area.y) / area.height)
    start = bot.start_location
    target = bot.enemy_start_locations[0] if bot.enemy_start_locations else bot.game_info.map_center
    scalars = [bot.time / 1800, bot.minerals / 3000, bot.vespene / 3000,
               bot.supply_used / 200, bot.supply_cap / 200, bot.supply_workers / 80,
               bot.supply_army / 200, bot.supply_left / 200,
               sum(u.is_idle for u in workers) / 80, len(bases) / 8,
               sum(u.is_ready for u in bases) / 8, len(army) / 100,
               sum(u.health for u in army) / max(1, sum(u.health_max for u in army)),
               len(enemy) / 100, *position(start), *position(target),
               len(bot.fairplay.events) / bot.fairplay.max_apm,
               sum(u.is_idle and u.is_structure for u in own) / 30]
    features = list(scalars)
    for name in spec.own_types:
        group = [u for u in own if u.type_id.name == name]
        features.extend((len(group) / 50, sum(u.build_progress for u in group) / 50))
    features.extend(float(UpgradeId[name] in bot.state.upgrades) for name in spec.upgrades)
    features.extend((sum(u.type_id in {U.SCV, U.DRONE, U.PROBE, U.MULE} for u in enemy) / 80,
                     sum(not u.is_structure and not u.is_flying for u in enemy) / 100,
                     sum(not u.is_structure and u.is_flying for u in enemy) / 100,
                     sum(u.is_structure for u in enemy) / 50,
                     sum(u.is_detector for u in enemy) / 20, sum(u.is_cloaked for u in enemy) / 20,
                     sum(u.ground_dps for u in enemy) / 1000, sum(u.air_dps for u in enemy) / 1000))
    grid = np.zeros((6, GRID_SIZE, GRID_SIZE), dtype=np.float32)
    for offset, group in ((0, own), (3, enemy)):
        for unit in group:
            x, y = position(unit.position)
            col, row = int(np.clip(x * GRID_SIZE, 0, GRID_SIZE - 1)), int(np.clip(y * GRID_SIZE, 0, GRID_SIZE - 1))
            channel = offset + (2 if unit.is_structure else 1 if unit.is_flying else 0)
            grid[channel, row, col] += .1
    vector = np.concatenate((np.asarray(features, dtype=np.float32), grid.ravel()))
    if vector.shape != (spec.base_dim,) or not np.isfinite(vector).all():
        raise ValueError("Invalid adversary observation")
    return np.clip(vector, -5, 5)


@dataclass(frozen=True)
class Intent:
    sources: tuple = ()
    ability: Any = None
    target: Any = None
    strategic_action: str | None = None
    strategic_emergency: bool = False
    visible_pressure_tags: tuple[int, ...] = ()


def _orders(unit):
    return list(unit._proto.orders)


def _resource_job(unit, mineral_tags, gas_tags):
    harvest = {A.SMART.value, A.HARVEST_GATHER.value, A.HARVEST_RETURN.value,
               A.HARVEST_GATHER_SCV.value, A.HARVEST_RETURN_SCV.value,
               A.HARVEST_GATHER_DRONE.value, A.HARVEST_RETURN_DRONE.value}
    orders = _orders(unit)
    if any(order.ability_id not in harvest for order in orders):
        return None
    if unit.is_carrying_vespene:
        return "gas"
    if unit.is_carrying_minerals:
        return "minerals"
    for order in orders:
        if order.target_unit_tag in mineral_tags:
            return "minerals"
        if order.target_unit_tag in gas_tags:
            return "gas"
    return None


def _visible_footprint(bot, point, width):
    area = bot.game_info.playable_area
    half = width / 2
    return all(area.x <= x < area.x + area.width and area.y <= y < area.y + area.height
               and bot.is_visible(Point2((x, y)))
               for x in np.arange(point.x - half + .05, point.x + half, .5)
               for y in np.arange(point.y - half + .05, point.y + half, .5))


async def placement(bot, ability, kind, center, width=None, *, candidate_filter=None):
    return await find_placement(bot, ability, kind, center, width, candidate_filter=candidate_filter)


async def legal_action_mask(bot):
    spec = bot.spec
    indices = {name: index for index, name in enumerate(spec.action_names)}
    intents = {0: Intent()}
    bot._action_context = intents
    mask = np.zeros(spec.action_dim, dtype=np.bool_)
    mask[0] = True
    if not bot.fairplay.available(float(bot.time)):
        return mask
    own, enemy = entities(bot)
    if spec.race == "Terran":
        landing_guard = getattr(bot, "_landing_guard", None)
        if landing_guard is None:
            bot._landing_guard = landing_guard = LandingGuard()
        landing_guard.observe(float(bot.time), own)
        production = getattr(bot, "_production_control", None)
        if production is None:
            bot._production_control = production = ProductionControl()
        production.observe(float(bot.time), own)
        infrastructure = getattr(bot, "_infrastructure_guard", None)
        if infrastructure is None:
            bot._infrastructure_guard = infrastructure = InfrastructureGuard()
        infrastructure.observe(bot, own)
    strategic = getattr(bot, "_strategic_orders", None)
    if strategic is None:
        bot._strategic_orders = strategic = StrategicOrders()
    strategic.observe_structures(enemy, bot.is_visible)
    visible_threats = pressure_tags(own, enemy)
    ready = [u for u in own if u.is_ready]
    queried = await bot.get_available_abilities(ready, ignore_resource_requirements=False) if ready else []
    available = {u.tag: set(a) for u, a in zip(ready, queried, strict=True)}
    def can(unit, ability):
        info = bot.game_data.abilities.get(ability.value)
        return ability in available.get(unit.tag, ()) or (info is not None and info.id in available.get(unit.tag, ()))
    def matches(ability, group=ready):
        return [u for u in group if can(u, ability)]
    def add(name, sources, ability, target=None):
        if sources:
            allowed, emergency = strategic.permission(name, float(bot.time), sources, ability, target,
                                                      bot.game_data, visible_threats)
            if allowed:
                intents[indices[name]] = Intent(tuple(sources), ability, target,
                    name if name in STRATEGIC_ACTIONS else None, emergency,
                    tuple(sorted(visible_threats)) if emergency else ())
    workers = [u for u in ready if u.type_id.name == spec.worker]
    minerals = [u for u in bot.mineral_field if u.is_visible and not u.is_snapshot and u.mineral_contents > 0]
    gases = [u for u in ready if u.type_id in {U.REFINERY, U.EXTRACTOR} and u.vespene_contents > 0]
    mineral_tags, gas_tags = {u.tag for u in minerals}, {u.tag for u in gases}
    gather = A.HARVEST_GATHER_SCV if spec.race == "Terran" else A.HARVEST_GATHER_DRONE
    for resource, targets in (("minerals", minerals), ("gas", [u for u in gases if u.assigned_harvesters < u.ideal_harvesters])):
        candidates = [u for u in workers if can(u, gather) and (u.is_idle or _resource_job(u, mineral_tags, gas_tags)
                     == ("minerals" if resource == "gas" else "gas"))]
        if candidates and targets:
            worker = min(candidates, key=lambda u: (not u.is_idle, u.is_carrying_resource,
                                                    min(u.distance_to(t) for t in targets), u.tag))
            add("harvest_" + resource, [worker], gather, min(targets, key=worker.distance_to))
    bases = [u for u in ready if u.type_id.name in spec.bases]
    centers = [u.position for u in bases] or [bot.start_location]
    for name in spec.buildings:
        kind = U[name]
        info = TRAIN_INFO.get(U[spec.worker], {}).get(kind)
        if info is None or not bot.can_afford(kind):
            continue
        guarded = spec.race == "Terran" and name in GUARDED_INFRASTRUCTURE
        if guarded and not infrastructure.allowed(name):
            continue
        ability = info["ability"]
        builders = [u for u in matches(ability, workers) if u.is_idle or _resource_job(u, mineral_tags, gas_tags) is not None]
        if not builders:
            continue
        target = None
        if kind in {U.REFINERY, U.EXTRACTOR}:
            for geyser in bot.vespene_geyser:
                if (geyser.is_visible and not geyser.is_snapshot and _visible_footprint(bot, geyser.position, 3)
                        and await bot.can_place_single(ability, geyser.position)):
                    target = geyser
                    break
        else:
            for center in centers:
                target = await placement(bot, ability, kind, center,
                    candidate_filter=(lambda point: infrastructure.site_allowed(name, point)) if guarded else None)
                if target is not None:
                    break
        if target is None and guarded:
            infrastructure.no_site(name)
        if target is not None:
            add("build_" + name.lower(), [min(builders, key=lambda u: u.distance_to(target))], ability, target)
    # Unit and structure transformations use the game data's incremental costs.
    reactors = {u.tag for u in own if u.type_id.name in {"BARRACKSREACTOR", "FACTORYREACTOR", "STARPORTREACTOR"}}
    for prefix, names in (("train_", spec.train), ("morph_", spec.morphs)):
        for name in names:
            kind = U[name]
            if not bot.can_afford(kind) or not bot.can_feed(kind):
                continue
            for producer in ready:
                info = TRAIN_INFO.get(producer.type_id, {}).get(kind)
                slots = 2 if getattr(producer, "add_on_tag", 0) in reactors and prefix == "train_" else 1
                if info and len(_orders(producer)) < slots and can(producer, info["ability"]):
                    add(prefix + name.lower(), [producer], info["ability"])
                    break
    for name in spec.upgrades:
        upgrade = UpgradeId[name]
        if upgrade in bot.state.upgrades or not bot.can_afford(upgrade):
            continue
        for producer in ready:
            info = RESEARCH_INFO.get(producer.type_id, {}).get(upgrade)
            if info and producer.is_idle and can(producer, info["ability"]):
                add("research_" + name.lower(), [producer], info["ability"])
                break
    army = [u for u in ready if _army(u, spec)]
    attack = matches(A.ATTACK_ATTACK, [u for u in army if u.can_attack])
    move = matches(A.MOVE_MOVE, army)
    enemy_start = bot.enemy_start_locations[0] if bot.enemy_start_locations else bot.game_info.map_center
    add("attack_enemy_base", attack, A.ATTACK_ATTACK, strategic.objective(attack, enemy_start))
    add("defend", attack, A.ATTACK_ATTACK, bot.start_location)
    add("retreat", move, A.MOVE_MOVE, bot.start_location)
    for target in sorted(enemy, key=lambda u: (u.health + u.shield, u.tag)):
        capable = [u for u in attack if (u.can_attack_air if target.is_flying else u.can_attack_ground)]
        if capable and target.can_be_attacked:
            add("attack_visible_enemy", capable, A.ATTACK_ATTACK, target)
            break
    scouts = matches(A.MOVE_MOVE, [u for u in ready if u.type_id.name in {spec.worker, "OVERLORD", "OVERSEER", "REAPER"}])
    if scouts:
        add("scout", [min(scouts, key=lambda u: (not u.is_idle, u.tag))], A.MOVE_MOVE, enemy_start)
    if spec.race == "Terran":
        await _terran_extras(bot, ready, own, minerals, can, matches, add)
    else:
        await _zerg_extras(bot, ready, own, enemy, bases, can, matches, add)
    for index in intents:
        mask[index] = True
    return mask


async def _terran_extras(bot, ready, own, minerals, can, matches, add):
    production = bot._production_control
    visible_enemies = entities(bot)[1]
    for name, ability in (("lower_depot", A.MORPH_SUPPLYDEPOT_LOWER), ("raise_depot", A.MORPH_SUPPLYDEPOT_RAISE),
                          ("siege", A.SIEGEMODE_SIEGEMODE), ("unsiege", A.UNSIEGE_UNSIEGE),
                          ("burrow_mine", A.BURROWDOWN_WIDOWMINE), ("unburrow_mine", A.BURROWUP_WIDOWMINE)):
        add(name, matches(ability), ability)
    for building in ("BARRACKS", "FACTORY", "STARPORT"):
        for addon in ("TECHLAB", "REACTOR"):
            ability = A[f"BUILD_{addon}_{building}"]
            kind = U[building + addon]
            if not bot.can_afford(kind):
                continue
            for producer in matches(ability):
                if producer.type_id != U[building] or not producer.is_idle or producer.add_on_tag:
                    continue
                details = getattr(bot.client, "available_ability_details", {}).get(producer.tag, {})
                generic = bot.game_data.abilities.get(ability.value)
                available_id = ability.value if ability.value in details else getattr(getattr(generic, "id", None), "value", ability.value)
                requires_point = details.get(available_id) is True
                if not bot._landing_guard.addon_ready(producer.tag, float(bot.time)):
                    continue
                if await reusable_addon_site(bot, U[building], producer, addon,
                                            excluded_addon_tags=production.excluded_addons(int(producer.tag))) is not None:
                    # This action means create a new addon. Reusing a detached
                    # owned one remains a separate policy-selected lift/land.
                    bot._addon_reuse_blocks = getattr(bot, "_addon_reuse_blocks", 0) + 1
                    break
                target = producer.position.offset((2.5, -.5))
                # Use Supply Depot's identical 2x2 footprint for clearance only;
                # actual addon ability availability verifies producer/tech/cost.
                command_target = None
                if requires_point:
                    command_target = await verified_addon_point(bot, producer, ability)
                    if command_target is None:
                        bot._addon_target_blocks = getattr(bot, "_addon_target_blocks", 0) + 1
                        continue
                    add(f"build_{addon.lower()}_{building.lower()}", [producer], ability, command_target)
                    break
                if _visible_footprint(bot, target, 2) and await bot.can_place_single(A.TERRANBUILD_SUPPLYDEPOT, target):
                    add(f"build_{addon.lower()}_{building.lower()}", [producer], ability, command_target)
                    break
        lift, land = A["LIFT_" + building], A["LAND_" + building]
        for producer in matches(lift):
            if not producer.is_idle:
                continue
            # Only the isolated, nonlearning mechanics harness may bypass the
            # strategic-purpose mask; queried ability and APM checks still run.
            diagnostic = getattr(bot, "_diagnostic_allow_unpurposeful_lift", False)
            if diagnostic or await production.lift_plan(bot, producer, own, visible_enemies) is not None:
                add("lift_" + building.lower(), [producer], lift)
                break
        for producer in matches(land):
            if not producer.is_idle:
                continue  # Let an accepted landing finish instead of retargeting it every decision.
            target = await production.landing_target(bot, producer)
            if target is not None:
                add("land_" + building.lower(), [producer], land, target)
                break
    for caster in matches(A.CALLDOWNMULE_CALLDOWNMULE):
        if minerals:
            add("call_mule", [caster], A.CALLDOWNMULE_CALLDOWNMULE, min(minerals, key=caster.distance_to))
            break
    repairs = matches(A.EFFECT_REPAIR_SCV, [u for u in ready if u.type_id == U.SCV])
    damaged = [u for u in own if u.is_ready and u.is_mechanical and u.health < u.health_max]
    if repairs and damaged and bot.minerals > 0:
        worker = repairs[0]
        targets = [u for u in damaged if u.tag != worker.tag]
        if targets:
            add("repair", [worker], A.EFFECT_REPAIR_SCV, min(targets, key=worker.distance_to))
    for ability in (A.EFFECT_STIM_MARINE, A.EFFECT_STIM_MARAUDER):
        eligible = [u for u in matches(ability) if u.health > (10 if u.type_id == U.MARINE else 20)]
        if eligible:
            add("stim", eligible, ability)
            break


async def _zerg_extras(bot, ready, own, enemy, bases, can, matches, add):
    for queen in matches(A.EFFECT_INJECTLARVA):
        targets = [u for u in bases if not u.has_buff(BuffId.QUEENSPAWNLARVATIMER)]
        if targets:
            add("inject_larva", [queen], A.EFFECT_INJECTLARVA, min(targets, key=queen.distance_to))
            break
    for queen in matches(A.TRANSFUSION_TRANSFUSION):
        targets = [u for u in own if u.is_biological and u.health_max - u.health >= 50 and queen.distance_to(u) <= 7]
        if targets:
            add("transfuse", [queen], A.TRANSFUSION_TRANSFUSION, min(targets, key=lambda u: u.health / u.health_max))
            break
    for ability in (A.BUILD_CREEPTUMOR_QUEEN, A.BUILD_CREEPTUMOR_TUMOR):
        for source in matches(ability):
            target = await placement(bot, ability, U.CREEPTUMOR, source.position, width=1)
            if target is not None and source.distance_to(target) <= 10:
                add("creep_tumor", [source], ability, target)
                break
    for ravager in matches(A.EFFECT_CORROSIVEBILE):
        targets = [u for u in enemy if ravager.distance_to(u) <= 9]
        if targets:
            add("corrosive_bile", [ravager], A.EFFECT_CORROSIVEBILE, targets[0].position)
            break
    for name, ability in (("burrow_lurker", A.BURROWDOWN_LURKER), ("unburrow_lurker", A.BURROWUP_LURKER)):
        add(name, matches(ability), ability)


class AdversaryBot(BotAI):
    def __init__(self, policy, race: str, *, record=True, deterministic=False, max_game_seconds=1800,
                 step_mul=2, gamma=1.0, reward_shaping=0.0, max_apm=600, expected_start_workers=8,
                 teacher: Callable | None = None, reward_config=None, reward_reference=None):
        super().__init__()
        metadata(race, max_apm=max_apm, step_mul=step_mul)
        numeric = (max_game_seconds, gamma, reward_shaping)
        if (any(isinstance(v, bool) or not isinstance(v, (int, float)) or not math.isfinite(v) for v in numeric)
                or type(expected_start_workers) is not int or expected_start_workers != 8
                or max_game_seconds <= 0 or not 0 <= gamma <= 1 or reward_shaping < 0):
            raise ValueError("Invalid adversary episode configuration")
        self.spec: RaceSpec = get_spec(race)
        self.policy, self.teacher = policy, teacher
        self.record, self.deterministic = record, deterministic
        self.max_game_seconds, self.step_mul = max_game_seconds, step_mul
        self.gamma, self.reward_shaping = gamma, reward_shaping
        self._reward_collector = (RewardCollector(reward_config, reward_reference)
                                  if reward_config is not None and record and teacher is None else None)
        self.reward_config = self._reward_collector.config if self._reward_collector else None
        self.expected_start_workers = expected_start_workers
        self.fairplay = AdversaryBudget(max_apm)
        self._landing_guard = LandingGuard() if race == "Terran" else None
        self._production_control = ProductionControl() if race == "Terran" else None
        self._infrastructure_guard = InfrastructureGuard() if race == "Terran" else None
        self._addon_target_blocks = self._addon_reuse_blocks = 0
        self.transitions, self.decisions = [], []
        self.action_counts, self.rejected_policy_actions = Counter(), Counter()
        self.result = self.error = None
        self.last_action_accepted = None
        self._episode_finished = self._time_limited = False
        self._frames = deque(maxlen=HISTORY)
        self._last_observation = self._pending_transition = None
        self._last_loop = None

    async def on_start(self):
        try:
            if (getattr(self, "_diagnostic_allow_unpurposeful_lift", False)
                    and (self.record or self.policy is not None or self.teacher is not None)):
                raise ValueError("Diagnostic lift override cannot be used with a policy, teacher, or training record")
            if self.race != Race[self.spec.race] or len(self.workers) != 8 or not self.townhalls:
                raise ValueError(f"Expected {self.spec.race} with exactly eight starting workers")
            self.client.game_step = self.step_mul
        except Exception as error:
            self.error = f"{type(error).__name__}: {error}"
            raise

    def _potential(self):
        return float(self.supply_workers / 80 + self.supply_army / 200)

    @property
    def control_summary(self):
        return {"strategic_orders": ORDER_PROFILE, "placement": PLACEMENT_PROFILE,
                "strategic_cadence_seconds": STRATEGIC_CADENCE,
                "emergency_cadence_seconds": EMERGENCY_CADENCE,
                "addon_landing": self._landing_guard.summary() if self._landing_guard else None,
                "addon_reuse": ADDON_REUSE_PROFILE if self.spec.race == "Terran" else None,
                "addon_target_requirement_blocks": self._addon_target_blocks,
                "addon_reuse_blocks": self._addon_reuse_blocks,
                "last_addon_point_query": getattr(self, "_addon_point_query", None),
                "production_relocation": self._production_control.summary() if self._production_control else None,
                "infrastructure": self._infrastructure_guard.summary() if self._infrastructure_guard else None}

    @property
    def reward_summary(self):
        return self._reward_collector.engine.summary() if self._reward_collector else None

    @property
    def reward_terminal_outcome(self):
        return self._reward_collector.terminal_outcome if self._reward_collector else 0.0

    def correct_reward_timeout(self):
        return self._reward_collector.correct_timeout() if self._reward_collector else 0.0

    def _observe(self):
        if self._last_loop != self.state.game_loop:
            self._frames.append(encode_observation(self))
            if self._landing_guard is not None:
                self._landing_guard.observe(float(self.time), entities(self)[0])
            if self._reward_collector is not None:
                self._reward_collector.observe(self, *entities(self), camera_restricted=False)
            pad = [np.zeros(self.spec.base_dim, dtype=np.float32)] * (HISTORY - len(self._frames))
            self._last_observation = np.concatenate(pad + list(self._frames))
            self._last_loop = self.state.game_loop
        return self._last_observation

    def _finish(self, observation, *, terminated=False, truncated=False, outcome=0.0, next_value=None):
        if self._pending_transition is None:
            return
        obs, mask, action, log_prob, value, potential = self._pending_transition
        if terminated:
            next_value = 0.0
        elif next_value is None:
            next_value = self.policy.value(observation)
        elif isinstance(next_value, bool) or not isinstance(next_value, (int, float)) or not math.isfinite(next_value):
            raise ValueError("Cached bootstrap value must be finite")
        if self._reward_collector is not None:
            reward = self._reward_collector.take()
        else:
            shaped = self.reward_shaping * ((0 if terminated else self.gamma * self._potential()) - potential)
            reward = outcome + shaped
        self.transitions.append(Transition(obs, mask, action, log_prob, value, reward,
                                           next_value, terminated, truncated))
        self._pending_transition = None

    async def on_step(self, iteration):
        try:
            if self._episode_finished:
                return
            observation = self._observe()
            if self.time >= self.max_game_seconds:
                self._time_limited = True
                return
            if not self.fairplay.available(float(self.time)):
                return
            mask = await legal_action_mask(self)
            if self.teacher is None:
                action, log_prob, value = self.policy.act(observation, mask, deterministic=self.deterministic)
            else:
                action = int(self.teacher(self, observation, mask))
                log_prob, value = 0.0, self.policy.value(observation)
            if not 0 <= action < self.spec.action_dim or not mask[action]:
                raise ValueError("Adversary selected an illegal action")
            # act() returns the critic value of this exact observation before
            # issuing any action. Reuse it for the previous transition instead
            # of running the same policy network a second time.
            self._finish(observation, next_value=value)
            name = self.spec.action_names[action]
            self.action_counts[name] += 1
            if self.record:
                self.decisions.append(dict(observation=observation.copy(), mask=mask.copy(), action=action,
                                           game_loop=int(self.state.game_loop), teacher=self.teacher is not None))
                if self.teacher is None:
                    self._pending_transition = (observation.copy(), mask.copy(), action, log_prob, value, self._potential())
            self.last_action_accepted = not action or await self.fairplay.issue(self, self._action_context[action])
            if self.record:
                self.decisions[-1]["accepted"] = self.last_action_accepted
            result_hook = getattr(self.teacher, "on_action_result", None)
            if result_hook is not None:
                result_hook(action, self.last_action_accepted)
            if not self.last_action_accepted:
                self.rejected_policy_actions[name] += 1
        except Exception as error:
            self.error = f"{type(error).__name__}: {error}"
            raise

    async def on_end(self, game_result):
        if self._episode_finished:
            return
        self._episode_finished = True
        self.result = game_result
        truncated = self._time_limited or game_result == Result.Tie
        if self._last_observation is not None:
            if self._reward_collector is not None:
                self._observe()
                self._reward_collector.finish("time_limit" if truncated else game_result.name.lower())
            outcome = 0.0 if truncated else 1.0 if game_result == Result.Victory else -1.0
            self._finish(self._last_observation, terminated=not truncated, truncated=truncated, outcome=outcome)
