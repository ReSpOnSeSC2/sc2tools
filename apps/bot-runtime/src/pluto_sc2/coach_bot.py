"""Separate session-coached Protoss executor, sharing the human input gate.

The strategist exchanges JSON with this process; no network model, optimizer,
checkpoint or replay-training corpus participates. NeuralBot supplies startup,
forfeit and result handling only. Its learned-policy step is fully replaced.
"""
from __future__ import annotations

import asyncio
import json
import math
from pathlib import Path
import time

from sc2.dicts.unit_train_build_abilities import TRAIN_INFO
from sc2.data import Alert
from sc2.ids.ability_id import AbilityId as A
from sc2.ids.unit_typeid import UnitTypeId as U
from sc2.ids.upgrade_id import UpgradeId as Upgrade
from sc2.position import Point2

from .coach_executor import CoachExecutor
from .coach_combat import CoachCombat
from .coach_chrono import CoachChrono
from .coach_cohesion import CoachCohesion
from .coach_groups import CoachGroups
from .coach_harassment import CoachHarassment
from .coach_prism import CoachPrism
from .coach_scout_spells import CoachScoutSpells
from .coach_forcefields import CoachForceFields
from .coach_army_plan import defense_plan
from .coach_memory import CoachMemory
from .coach_orders import CoachMailbox
from .coach_strategy import adapt_strategy
from .coach_opening import opening_base_index
from .coach_placement import candidate_allowed, candidate_points
from .coach_probe_route import CoachProbeRoute
from .adversary_orders import duplicate_order
from .runner import append_json, write_json
from .schema import BUILD_TYPES, RESEARCH_UPGRADES, TRAIN_TYPES
from .sc2_adapter import (
    NeuralBot, ACTION_NAMES, ACTION_TO_INDEX, screen_entities, legal_action_mask,
    execute_action, _visible_footprint, _placement_width, _clamp_point,
    _is_army, _same_type_group, _harvest_assignment, _order_details, ActionIntent,
)


PROFILE = "session-coached-protoss-v1"
GROUND_RECOVERY_SECONDS = 5.0
GROUND_RECOVERY_CADENCE = 3.0


class CoachBot(NeuralBot):
    def __init__(self, session, game_id, *, max_game_seconds=900, speed=3.0, opening=None):
        super().__init__(None, record=False, max_game_seconds=max_game_seconds)
        if not 0 < speed <= 50:
            raise ValueError("Coach speed must be in (0, 50]")
        self.session, self.game_id = Path(session), game_id
        self.speed = speed
        self.mailbox = CoachMailbox(self.session, game_id)
        supply_override = self.session / "supply-opening.json"
        if supply_override.exists():
            from .coach_supply_opening import SupplyOpeningPlan
            opening = SupplyOpeningPlan.from_config(json.loads(supply_override.read_text(encoding="utf-8")),
                                                     reference=opening)
        self.opening = opening
        self.chrono = CoachChrono(enabled=supply_override.exists())
        self._post_core_probe_primed = False
        self.memory, self.executor = CoachMemory(), CoachExecutor(opening=opening)
        self._opening_decision = None
        self._opening_base_indices = {}
        self._opening_camera_until = -100.0
        self._opening_construction_status = None
        self.combat = CoachCombat()
        self.cohesion = CoachCohesion()
        self.groups = CoachGroups()
        self.harassment = CoachHarassment()
        self._group_production_intents = {}
        self._last_group_army_command = None
        self._last_group_production_check = -100.0
        self.prism = CoachPrism()
        self.scout_spells = CoachScoutSpells()
        self.force_fields = CoachForceFields()
        self._army_job_tags = set()
        self._last_cohort_camera = -100.0
        self._cohort_camera_visits = {}
        self._cohort_camera_turn = 0
        self._guard_camera_request = None
        self._cohort_blocked = None
        self._natural_base_tag = None
        self._natural_base_position = None
        self._friendly_attack_recovery = None
        self._friendly_stop_until = {}
        self._friendly_stops_confirmed = 0
        self._combat_held_tags = {}
        self._combat_camera_until = -100.0
        self._combat_view_started = None
        self._combat_upkeep_until = -100.0
        self.report_sequence = 0
        self._last_report_time = -100.0
        self._wall_start = None
        self._selected_actions = {}
        self._construction = []
        self._expansion = None
        self._public_sites = []
        self._public_geysers = []
        self._last_camera_change = 0.0
        self._last_scout_dispatch = -100.0
        self._gateway_scout_builder = None
        self.probe_route = CoachProbeRoute()
        self._nonworker_scout_tags = set()
        self._last_nonworker_scout_dispatch = -100.0
        self._last_transfer = -100.0
        self._worker_transfers = {}
        self._camera_base_index = 0
        self._current_order = None
        self._army_destination = None
        self._army_plan = None
        self._army_job_attention = {}
        self._last_guard_dispatch = -100.0
        self._army_camera_position = None
        self._last_army_attention = -100.0
        self._army_attention_until = -100.0
        self._army_attention_visits = {}
        self._army_camera_return = None
        self._army_camera_request = None
        self._telemetry_errors = 0
        self._last_scout_camera = -100.0
        self._scout_camera_lease = None
        self._defense_alert = None
        self._current_defense_threat = None
        self._defense_dispatched = set()
        self._defense_camera_visits = set()
        self._last_defense_dispatch = -100.0
        self._last_gas_camera = -100.0
        self._gas_camera_request = None
        self._gas_camera_return = None
        self._last_construction_camera = -100.0
        self._construction_camera_visits = {}
        self._construction_camera_request = None
        self._building_alert_checks = []
        self._last_building_alert = -100.0
        self._last_building_alert_camera = -100.0
        self._building_alert_events = []
        self._ground_camera_recovery = None
        self._ground_recovery_blocks = {}
        self._ground_recovery_events = []
        self._last_ground_recovery = -100.0
        self._strategy_catalog = None
        self._strategy_decision = None
        self._supply_camera_visits = {}

    async def _start(self):
        await super()._start()
        self._wall_start = time.monotonic()
        # Static map geometry is prior map knowledge, not occupancy or pathing.
        # Fresh SC2 placement queries still require camera AND current vision.
        self._public_sites = sorted(self.expansion_locations_list,
                                    key=lambda point: (point.distance_to(self.start_location), point.x, point.y))
        # Initial neutral resource coordinates are public map geometry. Keep
        # positions only: no resource contents, occupancy or hidden units.
        self._public_geysers = sorted((Point2(tuple(unit.position)) for unit in self.vespene_geyser),
                                     key=lambda point: (point.x, point.y))

    @property
    def control_summary(self):
        return {**super().control_summary, "executor": PROFILE, "brain": "local-session-mailbox",
                "learned_policy": False, "external_model_api": False}

    def placement_candidate_allowed(self, kind, point, width):
        return candidate_allowed(self, kind, point, width)

    def placement_candidate_points(self, kind, center, width):
        return candidate_points(kind, center, width)

    def placement_source_allowed(self, unit):
        reserved = {task["source_tag"] for task in self._construction} | self._worker_transfers.keys()
        if self._expansion:
            reserved.add(self._expansion["source_tag"])
        reserved.add(self._reserved_scout_worker())
        return unit.tag not in reserved

    def _report(self, *, force=False):
        if not force and self.time - self._last_report_time < 5:
            return
        self.report_sequence += 1
        data = self.memory.report(self)
        data.update(self._production_cost_fields())
        data.update(schema=1, game_id=self.game_id, report_sequence=self.report_sequence,
                    control_rules=self.control_summary, strategist=self.mailbox.status,
                    current_order=self._current_order.to_dict() if self._current_order else None,
                    adaptive_strategy=self._strategy_decision.to_dict() if self._strategy_decision else None,
                    control_groups=self.groups.summary(),
                    harassment=self.harassment.summary(),
                    pending_construction=list(self._construction),
                    defense_alert=self._defense_alert,
                    building_attack_alerts={"pending_checks": list(self._building_alert_checks),
                                            "events": list(self._building_alert_events)},
                    gas_camera_request=self._gas_camera_request,
                    gas_camera_return=self._gas_camera_return,
                    construction_camera_request=self._construction_camera_request,
                    nonworker_scout_dispatch={"tags": sorted(self._nonworker_scout_tags),
                                              "last_game_seconds": self._last_nonworker_scout_dispatch,
                                              "minimum_interval_seconds": 30},
                    scout_camera_lease=self._scout_camera_lease,
                    gateway_scout_builder=self._gateway_scout_builder,
                    critical_opening_construction=self._opening_construction_status,
                    chrono_opening=self.chrono.summary(),
                    opening_army_priority=getattr(self.executor, "opening_army_priority", None),
                    probe_scout_route=self.probe_route.summary(),
                    army_camera_request=self._army_camera_request,
                    army_plan=self._army_plan,
                    ground_target_recovery={"pending": self._ground_camera_recovery,
                        "recent_events": list(self._ground_recovery_events),
                        "minimum_interval_seconds": GROUND_RECOVERY_CADENCE,
                        "request_expiry_seconds": GROUND_RECOVERY_SECONDS,
                        "blocked_source_tags": sorted(tag for tag, block in self._ground_recovery_blocks.items()
                                                      if block["until"] > self.time)},
                    army_cohesion={**self.cohesion.summary(), "blocked": self._cohort_blocked},
                    prism=self.prism.summary(float(self.time)),
                    scout_spells=self.scout_spells.status,
                    force_fields=self.force_fields.summary(float(self.time)),
                    friendly_attack_recovery=self._friendly_attack_recovery,
                    friendly_attack_stops_confirmed=self._friendly_stops_confirmed,
                    worker_transfers=list(self._worker_transfers.values()),
                    combat={"last_reason": self.combat.last_reason,
                            "confirmed_guardian_casts": self.combat.confirmed_guardian_casts,
                            "last_selection_game_seconds": self.combat.last_input,
                            "protected_source_tags": sorted(self._combat_protected_tags()),
                            "camera_hold_until_game_seconds": self._combat_camera_until,
                            "view_started_game_seconds": self._combat_view_started,
                            "upkeep_until_game_seconds": self._combat_upkeep_until},
                    opening=({**self.opening.summary(), "decision": self._opening_decision.to_dict()
                              if self._opening_decision else None} if self.opening else None),
                    expansion_task=self._expansion, action_counts=dict(self.action_counts),
                    fairplay=self.fairplay.summary(), result=getattr(self.result, "name", None),
                    finished=self._episode_finished, error=self.error,
                    telemetry_write_errors=self._telemetry_errors)
        try:
            write_json(self.session / "report.json", data)
            append_json(self.session / "reports.jsonl", data)
        except PermissionError as error:
            # A dashboard holding a Windows read handle must not lose a match.
            # The next report retries; authoritative match/checkpoint writes
            # elsewhere remain fail-closed and are never silently skipped.
            self._telemetry_errors += 1
            from loguru import logger
            logger.warning("Coach telemetry temporarily unavailable: {}", error)
        self._last_report_time = float(self.time)

    def _confirm_commands(self, own):
        self._combat_held_tags = {tag: until for tag, until in self._combat_held_tags.items() if until > self.time}
        for index, selected in list(self._selected_actions.items()):
            event = self.fairplay.audit[index]
            result = event.get("command_confirmation")
            if result is None:
                continue
            if result == "production_subselection":
                child = next((child_index for child_index in range(index + 1, len(self.fairplay.audit))
                              if self.fairplay.audit[child_index].get("parent_selection_audit_index") == index
                              and self.fairplay.audit[child_index].get("selection_mode") == "control_group_producer"), None)
                if child is None:
                    raise RuntimeError("Production group sub-selection has no audited UI child")
                self._selected_actions[child] = {**selected, "group_parent_selection": index}
                del self._selected_actions[index]
                continue
            del self._selected_actions[index]
            accepted = result == "accepted"
            name = selected["name"]
            # AllType selection may select only a subset of its requested
            # group. Credit only the sources confirmed for the actual command.
            if accepted and "command_source_tags" in event:
                event = {**event, "source_tags": event["command_source_tags"]}
            if self.chrono.enabled and (not accepted or len(event["source_tags"]) == 1):
                self.chrono.record_command(name, accepted, float(self.time),
                    audit_index=index, source_tags=event["source_tags"])
            if (accepted and name == "train_probe"
                    and getattr(self._opening_decision, "core_foundation_observed", False)):
                self._post_core_probe_primed = True
            self._confirm_group_actions(name, event, selected, accepted)
            if selected.get("harassment"):
                if self.harassment.confirm(selected["harassment"], accepted, float(self.time),
                                            actual_source_tags=event["source_tags"]):
                    self.cohesion.release(event["source_tags"])
            if selected.get("probe_route"):
                self.probe_route.confirm(selected["probe_route"], accepted, float(self.time),
                                         actual_source_tags=event["source_tags"])
                if accepted and name == "probe_scout_home" and self._scout_camera_lease:
                    self._scout_camera_lease.update(destination=list(self.start_location),
                        next_check_game_seconds=float(self.time) + 8, status="returning_probe")
            if result == "no_clear_visible_screen_ground":
                evidence = {**event, "source_tags": event.get("selected_tags", event["source_tags"])}
                self._queue_ground_camera_recovery(evidence, index, name, own)
            self.scout_spells.confirm(name, accepted, float(self.time), event["source_tags"], selected["position"])
            self.combat.confirm(name, accepted, float(self.time), event["source_tags"])
            self.force_fields.confirm(name, accepted, float(self.time), event["source_tags"], selected["position"])
            self.cohesion.confirm(name, event["source_tags"], selected.get("cohort_epoch"), accepted,
                                  event.get("effective_target"))
            if name == "stop_friendly_fire":
                if self._friendly_attack_recovery:
                    self._friendly_attack_recovery["command_result"] = result
                if accepted:
                    self._friendly_stops_confirmed += 1
                    self._combat_held_tags.update({tag: float(self.time) + 1 for tag in event["source_tags"]})
            if accepted and (name.startswith("combat_") or name in {"defend", "retreat", "guard_base", "stop_friendly_fire"}):
                self.cohesion.release(event["source_tags"])
            if self.opening is not None and name.startswith("build_"):
                self.executor.record_action(name, float(self.time), accepted,
                    base_index=self._opening_position_index(event.get("effective_target") or selected["position"]))
            else:
                self.executor.record_action(name, float(self.time), accepted)
            append_json(self.session / "execution.jsonl", {
                "game_seconds": float(self.time), "action": name, "command_result": result,
                "selection_audit_index": index, "strategy_revision": selected["revision"],
                "target_kind": event.get("target_kind"), "effective_target": event.get("effective_target"),
                "ground_target_redirected": event.get("ground_target_redirected", False),
                "opening_at_selection": selected.get("opening")})
            if accepted and name.startswith("build_"):
                self._construction.append({"type": name[6:].upper(), "position": selected["position"],
                                           "source_tag": event["source_tags"][0],
                                           "issued_game_seconds": float(self.time)})
                if name == "build_gateway" and self._gateway_scout_builder is None:
                    self._gateway_scout_builder = {"tag": event["source_tags"][0],
                        "position": event.get("effective_target") or selected["position"],
                        "accepted_at": float(self.time), "foundation_observed": False}
            if name == "scout" and accepted:
                self._last_scout_dispatch = float(self.time)
                self._start_scout_camera_lease(int(event["source_tags"][0]), selected["position"], own)
                if selected.get("scout_source_type") == "PROBE":
                    source = next((unit for unit in own if unit.tag == event["source_tags"][0]), None)
                    if source is not None:
                        self.probe_route.start(source.tag, self.start_location, selected["position"],
                                               float(self.time), position=source.position)
                if selected.get("scout_source_type") == "OBSERVER":
                    self._nonworker_scout_tags.add(int(event["source_tags"][0]))
                    self._last_nonworker_scout_dispatch = float(self.time)
            if name == "scout_hallucinated_phoenix" and accepted:
                tag = int(event["source_tags"][0])
                self._nonworker_scout_tags.add(tag)
                self._start_scout_camera_lease(tag, selected["position"], own)
            if name == "worker_transfer" and accepted:
                tag = int(event["source_tags"][0])
                self._worker_transfers[tag] = {"source_tag": tag, "position": selected["position"],
                                               "issued_game_seconds": float(self.time)}
            if name == "worker_transfer_harvest" and accepted:
                self._worker_transfers.pop(int(event["source_tags"][0]), None)
            if name in {"attack_enemy_base", "attack_visible_enemy", "defend", "retreat"} and accepted:
                # A spatial safety resolver may shorten the order to a visible
                # waypoint. Follow the command we actually sent, without
                # assuming the army has reached the distant strategic target.
                projection = event.get("effective_target")
                self._army_destination = projection if projection is not None else selected["position"]
            if selected.get("army_plan"):
                self._army_plan = {**selected["army_plan"], "status": result,
                                   "confirmed_click_projection": event.get("effective_target"),
                                   "confirmed_game_seconds": float(self.time)}
                if accepted:
                    self._army_job_tags.update(event["source_tags"])
                    self._army_job_attention[selected["army_plan"]["unit_type"]] = float(self.time)
                    if name == "guard_base":
                        self._last_guard_dispatch = float(self.time)
            if accepted and selected.get("defense_alert_base_tag") is not None:
                self._last_defense_dispatch = float(self.time)
                self._defense_dispatched.update(event["source_tags"])
            if accepted and (name.startswith("combat_") or name.startswith("prism_")):
                self._combat_held_tags.update({tag: float(self.time) + 3 for tag in event["source_tags"]})
                if self._combat_view_started is None:
                    self._combat_view_started = float(self.time)
                self._combat_camera_until = min(float(self.time) + 2, self._combat_view_started + 8)
                if self._defense_alert:
                    self._defense_dispatched.update(event["source_tags"])
            if name == "expand_move" and self._expansion:
                self._expansion["move_confirmed"] = accepted
                if not accepted:
                    self._expansion = None
        retained = []
        for task in self._construction:
            point = Point2(task["position"])
            matched = any(unit.type_id.name == task["type"] and unit.distance_to(point) < 1.5 for unit in own)
            builder = next((unit for unit in own if unit.tag == task["source_tag"]), None)
            failed = (self.time - task["issued_game_seconds"] > 3 and builder is not None
                      and self._abandoned_construction(builder, U[task["type"]])
                      and _visible_footprint(self, point, _placement_width(self, U[task["type"]])))
            if not matched and not failed:
                retained.append(task)
        self._construction = retained
        self._retire_observed_expansion()

    def _retire_observed_expansion(self):
        task = self._expansion
        if task is not None and any(record["type"] == "NEXUS"
                and Point2(record["position"]).distance_to(Point2(task["position"])) < 3
                for record in self.memory.own.values()):
            self._expansion = None
            return True
        return False

    def _abandoned_construction(self, builder, kind):
        """An observed replacement order resolves an empty-site reservation.

        Accepted build inputs can be interrupted before a warp-in starts. A
        mining or redirected builder is just as conclusive as an idle one;
        absence of the builder or visibility of only part of the site is not.
        An outstanding build order stays reserved even during a long journey.
        """
        if builder.is_idle:
            return True
        expected = TRAIN_INFO[U.PROBE][kind]["ability"]
        data = self.game_data.abilities.get(expected.value)
        expected_ids = {expected.value, getattr(getattr(data, "id", None), "value", expected.value)}
        proto = getattr(builder, "_proto", None)
        if proto is not None:
            details = _order_details(builder, self.game_data)
            # A reserved/unknown order is busy, not evidence that construction
            # was abandoned. Never resolve it through Unit.orders, which can
            # raise for SC2's reserved NULL_NULL (4135) observations.
            return all(ids.intersection(self.game_data.abilities) and ids.isdisjoint(expected_ids)
                       for ids, _target, _progress in details)
        orders = getattr(builder, "orders", None)
        if orders is None:
            return False
        return not any(getattr(getattr(order.ability, "id", order.ability), "value", None) in expected_ids
                       for order in orders)

    def _record_selection(self, name, target=None):
        event = self.fairplay.audit[-1]
        if event["kind"] != "selection":
            return
        point = getattr(target, "position", target)
        self._selected_actions[len(self.fairplay.audit) - 1] = {
            "name": name, "position": list(point) if point is not None else None,
            "revision": self._current_order.revision if self._current_order else None,
            "opening": self._opening_decision.to_dict() if self._opening_decision else None}
        if name.startswith("cohort_"):
            self._selected_actions[len(self.fairplay.audit) - 1]["cohort_epoch"] = self.cohesion.epoch
        if (name in {"defend", "guard_base"} or name.startswith("cohort_")) and self._army_plan:
            self._army_plan["status"] = "selection_pending"
            self._selected_actions[len(self.fairplay.audit) - 1]["army_plan"] = dict(self._army_plan)

    def _combat_protected_tags(self):
        return {tag for leases in (self._combat_held_tags, self.combat.withdrawing,
                                   self.prism.protected_tags, self.force_fields.protected_tags,
                                   self.harassment.protected_tags(float(self.time)))
                for tag, until in leases.items() if until > self.time}

    async def _harassment_step(self, own, enemies, order, *, production_due):
        """Resolve a small raid using only this camera's units and real inputs."""
        now = float(self.time)
        ours = [unit for unit in own if self.fairplay.on_screen(unit)
                and getattr(unit, "is_visible", False) and not getattr(unit, "is_snapshot", False)]
        theirs = [unit for unit in enemies if self.fairplay.on_screen(unit)
                  and getattr(unit, "is_visible", False) and not getattr(unit, "is_snapshot", False)]
        ability_map = {}
        oracles = [unit for unit in ours if unit.type_id == U.ORACLE]
        if oracles:
            queried = await self.get_available_abilities(oracles, ignore_resource_requirements=False)
            ability_map = {unit.tag: values for unit, values in zip(oracles, queried, strict=True)}
        protected = self._combat_protected_tags() - self.harassment.protected_tags(now).keys()
        protected |= self._nonworker_scout_tags
        anchor = self.cohesion.rally
        if anchor is not None:
            point = Point2(anchor)
            if (not self.fairplay.on_screen(point) or not self.is_visible(point)
                    or not self.in_pathing_grid(point)):
                anchor = None
        intent = self.harassment.plan(
            ours, theirs, now, self.supply_army,
            defense_alert=bool(self._defense_alert or order is None or order.stance == "retreat"),
            production_due=production_due, protected_tags=protected, retreat_anchor=anchor,
            enemy_memory=list(getattr(self.memory, "enemies", {}).values()),
            camera=self.fairplay.camera_center,
            completed_upgrades={upgrade.name for upgrade in self.state.upgrades},
            abilities_by_tag=ability_map, public_abilities=self.game_data.abilities)
        if intent is None:
            return False
        if intent["kind"] == "release":
            self.harassment.confirm(intent, True, now, actual_source_tags=[])
            return False
        if intent["kind"] == "camera":
            point = Point2(intent["position"])
            # Revisit scouted economy only while its area has current vision;
            # ordinary return-camera movement does not authorize any attack.
            accepted = bool((intent.get("camera_return") or self.is_visible(point))
                            and await self._move_camera(point))
            self.harassment.confirm(intent, accepted, now, actual_source_tags=[])
            if accepted:
                self.action_counts[intent["name"]] += 1
            return accepted
        tags = set(intent["source_tags"])
        sources = [unit for unit in ours if unit.tag in tags
                   and self.fairplay.source_available(unit, now)]
        target = None
        if intent["target_tag"] is not None:
            target = next((unit for unit in theirs if unit.tag == intent["target_tag"]), None)
        elif intent["position"] is not None:
            target = Point2(intent["position"])
        allowed = {unit.tag for unit in sources} == tags and bool(tags)
        if intent["target_tag"] is not None:
            allowed = allowed and target is not None
            if allowed:
                for source in sources:
                    if not getattr(source, "is_flying", False):
                        continue
                    distance = source.distance_to(target)
                    steps = max(1, math.ceil(distance))
                    points = [source.position.towards(target.position, distance * i / steps)
                              for i in range(1, steps + 1)]
                    if not all(self.fairplay.on_screen(point) and self.is_visible(point) for point in points):
                        allowed = False
                        break
        elif target is not None:
            allowed = (allowed and self.fairplay.on_screen(target) and self.is_visible(target)
                       and self.in_pathing_grid(target))
            if allowed:
                # Flight is still conservatively limited to a visible route
                # ending over clear ground by the shared spatial controller.
                for source in sources:
                    distance = source.position.distance_to(target)
                    steps = max(1, math.ceil(distance))
                    points = [source.position.towards(target, distance * i / steps) for i in range(1, steps + 1)]
                    if not all(self.fairplay.on_screen(point) and self.is_visible(point) for point in points):
                        allowed = False
                        break
        if not allowed:
            self.harassment.confirm(intent, False, now, actual_source_tags=[])
            return False
        ability = A(intent["ability_id"])
        queried = await self.get_available_abilities(sources, ignore_resource_requirements=False)
        public = self.game_data.abilities.get(ability.value)
        canonical = public.id if public is not None else ability
        if any(ability not in values and canonical not in values for values in queried):
            self.harassment.confirm(intent, False, now, actual_source_tags=[])
            return False
        accepted = await self.fairplay.issue(self, sources, ability, target,
                                             selection_mode=intent["selection_mode"])
        if accepted:
            self._record_selection(intent["name"], target)
            self._selected_actions[len(self.fairplay.audit) - 1]["harassment"] = intent
            self.action_counts[intent["name"]] += 1
            if self._combat_view_started is None:
                self._combat_view_started = now
            self._combat_camera_until = min(now + 2, self._combat_view_started + 8)
        else:
            self.harassment.confirm(intent, False, now, actual_source_tags=[])
        return accepted

    def _confirm_group_actions(self, name, event, selected, accepted):
        now = float(self.time)
        if event.get("selection_mode") == "army":
            self.groups.record_army_refresh(now, self.supply_army, accepted)
            if accepted:
                tags = event.get("command_source_tags", event["source_tags"])
                self.groups.plan_registration(1, tags, now)
                # F2 commands the entire actual selection, including scouts.
                # Expired scout missions explicitly rejoin this army command.
                reassigned = set(tags) & self._nonworker_scout_tags
                self._nonworker_scout_tags.difference_update(reassigned)
                lease = self._scout_camera_lease
                if lease and lease["source_tag"] in tags:
                    lease.update(status="reassigned_to_army", next_check_game_seconds=now + 120)
                if reassigned:
                    append_json(self.session / "execution.jsonl", {
                        "game_seconds": now, "action": "scouts_reassigned_to_army", "tags": sorted(reassigned)})
        group = self.groups.group_for_action(name)
        if group is not None:
            self.groups.record_production_attempt(name, now, accepted)
            if event.get("selection_mode") in {"control_group", "control_group_producer"}:
                self.groups.counts["accepted_group_production" if accepted else "rejected_group_production"] += 1
            if accepted:
                self.groups.plan_registration(group, event["source_tags"], now)
        if selected.get("group_army_key") and accepted:
            self._last_group_army_command = {"key": selected["group_army_key"], "time": now}

    async def _store_pending_group(self):
        plan = self.groups.pending_registration
        if plan is None:
            return False
        accepted = await self.fairplay.set_control_group(self, plan["group"], append=plan["append"])
        result = self.groups.confirm_registration(accepted, float(self.time))
        append_json(self.session / "execution.jsonl", {"action": "store_control_group", **result})
        if accepted:
            self.action_counts["store_control_group"] += 1
        return accepted

    def _group_candidates(self, report, legal):
        """Queue-selection intents only; fresh selected UI decides legality."""
        self._group_production_intents = {}
        for unit_name in TRAIN_TYPES:
            name = "train_" + unit_name.lower()
            group = self.groups.group_for_action(name)
            if name in legal or group is None or self.groups.recall_plan(group, float(self.time)) is None:
                continue
            price = report.get("action_costs", {}).get(name, {})
            if (not price or "supply" not in price or self.minerals < price["minerals"]
                    or self.vespene < price["vespene"] or self.supply_left < price["supply"]):
                continue
            producer = {2: U.NEXUS, 3: U.GATEWAY, 4: U.ROBOTICSFACILITY, 5: U.STARGATE}[group]
            info = TRAIN_INFO.get(producer, {}).get(U[unit_name])
            if info is None:
                continue
            self._group_production_intents[name] = group
            self._pluto_action_context[ACTION_TO_INDEX[name]] = ActionIntent((), info["ability"], None, False)
            legal.add(name)
        report["group_production_candidates"] = sorted(self._group_production_intents)

    async def _issue_production_group(self, name):
        group = self._group_production_intents[name]
        intent = self._pluto_action_context[ACTION_TO_INDEX[name]]
        accepted = await self.fairplay.issue(self, [], intent.ability,
                                           selection_mode="control_group", control_group=group)
        if accepted:
            self._record_selection(name)
            self.action_counts[name] += 1
        else:
            self.groups.record_production_attempt(name, float(self.time), False)
        return accepted

    async def _production_group_step(self, order, *, workers_only=False):
        # A bounded offscreen queue check precedes routine camera travel.
        # Construction, mining and urgent supply still need a base visit.
        if (order is None or self.supply_left <= 2
                or getattr(self._opening_decision, "prioritize_due_construction", False)
                or self.time - self._last_group_production_check < 2.5):
            return False
        report = self.memory.report(self)
        report.update(self._production_cost_fields())
        report["pending_construction"] = self._construction
        report.update(explicit_supply_opening=self.chrono.enabled, defense_alert=self._defense_alert)
        legal = {"no_op"}
        self._group_candidates(report, legal)
        if workers_only:
            legal.intersection_update({"no_op", "train_probe"})
        if len(legal) == 1:
            return False
        name = self.executor.choose_action(order, report, legal, float(self.time))
        if name in self._group_production_intents:
            self._last_group_production_check = float(self.time)
            return await self._issue_production_group(name)
        return False

    def _global_army_allowed(self, own):
        now = float(self.time)
        if self._combat_protected_tags() or self.groups.pending_registration:
            return False
        if any(not self._ground_source_retry_allowed(unit) for unit in own):
            return False
        if any(getattr(unit, "cargo_used", 0) for unit in own if unit.type_id == U.WARPPRISM):
            return False
        lease = self._scout_camera_lease
        return not (lease and lease["source_tag"] in self._nonworker_scout_tags
                    and now < lease["issued_game_seconds"] + 45)

    async def _group_army_step(self, own, target, name, *, key):
        # This global source selection is permitted by human F2/recall; its
        # target must remain freshly visible. It never queries hidden sources.
        if (not self._global_army_allowed(own) or not self.fairplay.on_screen(target)
                or not self.is_visible(target)):
            return False
        now = float(self.time)
        refresh = self.groups.main_army_refresh_due(now, self.supply_army)
        previous = self._last_group_army_command
        if previous and previous["key"] == key and now - previous["time"] < 5:
            return False
        recall = self.groups.recall_plan(1, now)
        if refresh is None and recall is None:
            return False
        mode = "army" if refresh else "control_group"
        accepted = await self.fairplay.issue(self, [], A.ATTACK_ATTACK, target,
                                            selection_mode=mode, control_group=None if refresh else 1)
        if accepted:
            self._record_selection(name, target)
            self._selected_actions[len(self.fairplay.audit) - 1]["group_army_key"] = key
            self._last_group_army_command = {"key": key, "time": now}
            self.action_counts[name] += 1
        elif refresh:
            self.groups.record_army_refresh(now, self.supply_army, False)
        return accepted

    def _ground_source_retry_allowed(self, unit):
        """Do not repeat an army selection at its just-rejected camera view."""
        block = self._ground_recovery_blocks.get(unit.tag)
        return (block is None or self.time >= block["until"]
                or math.dist(block["camera"], self.fairplay.camera_center) >= .25)

    def _queue_ground_camera_recovery(self, event, index, name, own):
        if (not (name.startswith("cohort_") or name in {"defend", "guard_base", "attack_enemy_base"})
                or event.get("target_kind") != "ground"):
            return
        target, camera = event.get("intended_target"), event.get("camera")
        if any(not isinstance(point, (list, tuple)) or len(point) != 2
               or not all(isinstance(value, (float, int)) and math.isfinite(value) for value in point)
               for point in (target, camera)):
            return
        requested = set(event.get("source_tags", ()))
        if "selected_tags" in event:
            requested.intersection_update(event["selected_tags"])
        tags = [unit.tag for unit in own if unit.tag in requested and self.fairplay.on_screen(unit)]
        if not tags:
            return
        now = float(self.time)
        self._ground_recovery_blocks = {tag: block for tag, block in self._ground_recovery_blocks.items()
                                       if block["until"] > now}
        self._ground_recovery_blocks.update({tag: {"camera": list(camera), "until": now + GROUND_RECOVERY_SECONDS}
                                            for tag in tags})
        while len(self._ground_recovery_blocks) > 256:
            self._ground_recovery_blocks.pop(next(iter(self._ground_recovery_blocks)))
        if self._ground_camera_recovery is None or self._ground_camera_recovery["expires"] <= now:
            self._ground_camera_recovery = {"source_tags": tags, "intended_target": list(target),
                "failed_camera": list(camera), "selection_audit_index": index, "action": name,
                "queued_game_seconds": now, "expires": now + GROUND_RECOVERY_SECONDS}

    async def _ground_camera_recovery_step(self, own):
        """Reframe a blocked army from a fresh screen before retrying its goal."""
        request = self._ground_camera_recovery
        if request is None:
            return False
        now = float(self.time)
        status = None
        if now >= request["expires"]:
            status = "expired"
        sources = [unit for unit in own if unit.tag in request["source_tags"] and self.fairplay.on_screen(unit)]
        if status is None and not sources:
            status = "source_not_currently_visible"
        if status is not None:
            self._ground_recovery_events.append({**request, "status": status, "game_seconds": now})
            self._ground_recovery_events = self._ground_recovery_events[-64:]
            self._ground_camera_recovery = None
            return False
        if now - self._last_ground_recovery < GROUND_RECOVERY_CADENCE or not self.fairplay.can_issue(now):
            return False
        center = Point2((sum(unit.position.x for unit in sources) / len(sources),
                         sum(unit.position.y for unit in sources) / len(sources)))
        intended = Point2(request["intended_target"])
        distance = center.distance_to(intended)
        target = _clamp_point(self, center.towards(intended, min(2.0, distance)) if distance else center)
        index = len(self.fairplay.audit)
        accepted = await self._move_camera(target)
        emitted = len(self.fairplay.audit) > index
        if not emitted and not accepted and self.fairplay.camera_would_move(self, target):
            return False  # A combat/upkeep camera lease still owns the view.
        self._last_ground_recovery = now
        self._ground_camera_recovery = None
        self._ground_recovery_events.append({**request, "status": "camera_accepted" if accepted else
            "camera_rejected" if emitted else "camera_already_at_recovery_view", "game_seconds": now,
            "current_source_tags": [unit.tag for unit in sources], "observed_centroid": list(center),
            "camera_target": list(target), "camera_audit_index": index if emitted else None})
        self._ground_recovery_events = self._ground_recovery_events[-64:]
        if accepted:
            self._army_attention_until = now + 3
            self.action_counts["camera_recover_ground_target"] += 1
        return emitted  # Even a rejected input spends the current action opportunity.

    @staticmethod
    def _safe_army_sources(eligible, own):
        group = list(_same_type_group(eligible))
        tags = {unit.tag for unit in group}
        if group and any(unit.type_id == group[0].type_id and unit.tag not in tags for unit in own):
            # AllType selects every same-type unit on the screen, including
            # one deliberately excluded for withdrawal or an existing order.
            return group[:1]
        return group

    async def _combat_upkeep(self):
        """Give a sustained fight one bounded, ordinary base-upkeep visit."""
        if self._combat_view_started is None or self.time - self._combat_view_started < 8:
            return False
        bases = [base for base in self._known_bases() if base["is_ready"]]
        if not bases:
            return False
        base = min(bases, key=lambda row: (row["last_seen_seconds"], row["tag"]))
        point = Point2(base["position"])
        self._combat_camera_until = -100.0
        moving = self.fairplay.camera_would_move(self, point)
        if moving and not await self._move_camera(point):
            return False
        self._combat_view_started = None
        self._combat_upkeep_until = float(self.time) + 3
        if moving:
            self.action_counts["camera_combat_upkeep"] += 1
        return moving

    async def _move_camera(self, point):
        if self.time < self._combat_upkeep_until:
            return False
        if (self.time < self._combat_camera_until
                and (self._current_order is None or self._current_order.stance != "retreat")):
            return False
        point = _clamp_point(self, Point2(point))
        if not self.fairplay.camera_would_move(self, point):
            return False
        accepted = await self.fairplay.move_camera(self, point)
        if accepted:
            self._last_camera_change = float(self.time)
            self._combat_view_started = None
            self.action_counts["camera_waypoint"] += 1
        return accepted

    async def _move_worker(self, worker, point, name):
        accepted = await self.fairplay.issue(self, [worker], A.MOVE_MOVE, point, minimap=True)
        if accepted:
            self._record_selection(name, point)
            self.action_counts[name] += 1
        return accepted

    def _known_bases(self):
        return [record for record in self.memory.own.values() if record["type"] == "NEXUS"]

    def _production_cost_fields(self):
        """Public engine prices, never live unit or opponent information."""
        def cost(kind):
            try:
                price = self.calculate_cost(kind)
                minerals, gas = float(price.minerals), float(price.vespene)
            except (KeyError, AttributeError, TypeError, ValueError):
                return None
            if (not math.isfinite(minerals) or not math.isfinite(gas) or min(minerals, gas) < 0
                    or minerals + gas == 0):
                return None
            result = {"minerals": minerals, "vespene": gas}
            frames = getattr(price, "time", None)
            if isinstance(frames, (int, float)) and math.isfinite(frames) and frames > 0:
                result["time_seconds"] = frames / 22.4
            return result

        fields = {"action_costs": {}, "opening_bases": self._opening_bases() if self.opening else []}
        fields["upgrades"] = sorted(upgrade.name for upgrade in getattr(self.state, "upgrades", ())
                                    if hasattr(upgrade, "name"))
        for name in TRAIN_TYPES:
            price = cost(U[name])
            if price is not None:
                data = self.game_data.units.get(U[name].value)
                supply = getattr(getattr(data, "_proto", None), "food_required", None)
                if isinstance(supply, (int, float)) and math.isfinite(supply) and supply >= 0:
                    price["supply"] = float(supply)
                fields["action_costs"]["train_" + name.lower()] = price
        for name in BUILD_TYPES:
            price = cost(U[name])
            if price is not None:
                fields["action_costs"]["build_" + name.lower()] = price
        for name in RESEARCH_UPGRADES:
            price = cost(Upgrade[name])
            if price is not None:
                fields["action_costs"]["research_" + name.lower()] = price
        action = self._opening_decision.next_action if self._opening_decision is not None else None
        if action and action.startswith("build_"):
            price = cost(U[action[6:].upper()])
            if price is not None:
                fields["opening_next_cost"] = {"action": action, **price}
        return fields

    def _public_strategy_catalog(self):
        """Static current-engine prices and weapon target classes, not live units."""
        if self._strategy_catalog is None:
            catalog = {}
            for identifier, data in self.game_data.units.items():
                try:
                    kind = U(identifier)
                    proto = getattr(data, "_proto", None)
                    if getattr(proto, "race", 0) not in {1, 2, 3}:
                        continue  # Neutral scenery has no army replacement value.
                    if getattr(data, "creation_ability", None) is None:
                        # Morph variants can have a public price but no creation
                        # command. The creation-cost helper logs those as errors.
                        minerals, gas = float(proto.mineral_cost), float(proto.vespene_cost)
                    else:
                        price = self.calculate_cost(kind)
                        minerals, gas = float(price.minerals), float(price.vespene)
                except (KeyError, AttributeError, TypeError, ValueError):
                    continue
                if not all(math.isfinite(value) and value >= 0 for value in (minerals, gas)):
                    continue
                proto = getattr(data, "_proto", None)
                weapon_targets = {weapon.type for weapon in getattr(proto, "weapons", ())}
                catalog[kind.name] = {"minerals": minerals, "vespene": gas,
                                      "supply": float(getattr(proto, "food_required", 0)),
                                      "can_attack_ground": bool(weapon_targets & {1, 3}),
                                      "can_attack_air": bool(weapon_targets & {2, 3})}
            self._strategy_catalog = catalog
        return self._strategy_catalog

    def _adapt_current_strategy(self):
        report = self.memory.report(self)
        report.update(self._production_cost_fields())
        report.update(game_id=self.game_id, defense_alert=self._defense_alert,
                      pending_construction=self._construction)
        self._strategy_decision = adapt_strategy(
            self._current_order, report, now=float(self.time),
            opening_active=bool(self._opening_decision and self._opening_decision.active),
            unit_catalog=self._public_strategy_catalog())
        self._current_order = self._strategy_decision.order

    def _start_scout_camera_lease(self, tag, destination, own):
        if destination is None:
            return
        source = next((unit for unit in own if unit.tag == tag), None)
        self._scout_camera_lease = {
            "source_tag": tag, "destination": list(destination), "issued_game_seconds": float(self.time),
            "best_distance": source.distance_to(Point2(destination)) if source is not None else None,
            "last_progress_game_seconds": float(self.time), "last_own_seen_game_seconds": float(self.time)
            if source is not None else None, "failed_visits": 0, "pending_visit_loop": None,
            "next_check_game_seconds": float(self.time) + 25, "status": "awaiting_arrival"}

    def _observe_scout_camera(self, own):
        """Retire blind camera trips without inferring an off-screen death."""
        lease = self._scout_camera_lease
        if lease is None or lease["status"] == "reassigned_to_army":
            return
        destination = Point2(lease["destination"])
        source = next((unit for unit in own if unit.tag == lease["source_tag"]
                       and self.fairplay.on_screen(unit)), None)
        useful = source is not None and source.distance_to(destination) <= 12
        if source is not None:
            distance = source.distance_to(destination)
            lease["last_own_seen_game_seconds"] = float(self.time)
            if useful or lease["best_distance"] is None or distance < lease["best_distance"] - 3:
                stopped = lease["status"] == "stopped_no_scout_observation"
                lease.update(best_distance=distance, last_progress_game_seconds=float(self.time),
                             failed_visits=0, status="observed_scout")
                if stopped:
                    lease["next_check_game_seconds"] = float(self.time) + 20
        pending = lease["pending_visit_loop"]
        if (pending is not None and int(self.state.game_loop) > pending
                and self.fairplay.on_screen(destination)):
            lease["pending_visit_loop"] = None
            if useful:
                lease.update(failed_visits=0, status="observed_scout",
                             next_check_game_seconds=float(self.time) + 20)
            else:
                lease["failed_visits"] += 1
                lease["status"] = ("stopped_no_scout_observation" if lease["failed_visits"] >= 3
                                   else "waiting_for_scout_observation")
                lease["next_check_game_seconds"] = float(self.time) + 30 * 2 ** (lease["failed_visits"] - 1)
        if self.time - lease["last_progress_game_seconds"] >= 120:
            lease["status"] = "stopped_no_scout_observation"

    def _refresh_opening(self, enemies):
        if self.opening is None:
            return
        from .coach_supply_opening import SupplyOpeningPlan
        report = self.memory.report(self)
        report["pending_construction"] = self._construction
        report["opening_bases"] = self._opening_bases()
        # A distant scout sighting informs strategy; it does not cancel the
        # user's gas/Core sequence. Actual base threats still suspend it.
        threat = (self._defense_alert if isinstance(self.opening, SupplyOpeningPlan) else enemies)
        self._opening_decision = self.opening.decide(report, set(), float(self.time), suspended=bool(
            threat or (self._current_order and self._current_order.stance == "retreat")))

    def _index_opening_bases(self):
        # Indices describe observed own bases; replay coordinates never become
        # live destinations. Retain indices if the main is subsequently lost.
        for base in sorted(self._known_bases(), key=lambda row: (
                row.get("first_seen_loop", 0), Point2(row["position"]).distance_to(self.start_location), row["tag"])):
            if base["tag"] not in self._opening_base_indices:
                index = (0 if Point2(base["position"]).distance_to(self.start_location) <= 6 else
                         max(self._opening_base_indices.values(), default=0) + 1)
                self._opening_base_indices[base["tag"]] = index

    def _opening_bases(self):
        self._index_opening_bases()
        return [{"tag": base["tag"], "base_index": self._opening_base_indices[base["tag"]],
                 "position": list(base["position"])} for base in self._known_bases()]

    def _opening_position_index(self, position):
        return opening_base_index({"opening_bases": self._opening_bases()}, position)

    def _opening_structure_allowed(self, name, target):
        decision = self._opening_decision
        if (decision is None or not decision.active or decision.next_action != name
                or decision.next_base_index is None or name in {"build_nexus", "build_assimilator"}):
            return True
        return self._opening_position_index(target) == decision.next_base_index

    def _opening_gas_quota(self, base):
        decision = self._opening_decision
        if decision is None or not decision.active:
            return None
        self._index_opening_bases()
        index = self._opening_base_indices[base["tag"]]
        if decision.desired_gas_by_base:
            return decision.desired_gas_by_base.get(index, 0)
        # Older candidates without a base annotation place the first two gases
        # at the observed main, then two per observed expansion in order.
        return min(2, max(0, decision.desired_gas_count - 2 * index))

    def _local_gas_inventory(self, base):
        point = Point2(base["position"])
        gas = [record for record in self.memory.own.values() if record["type"] == "ASSIMILATOR"
               and Point2(record["position"]).distance_to(point) <= 12]
        reserved = [task for task in self._construction if task["type"] == "ASSIMILATOR"
                    and Point2(task["position"]).distance_to(point) <= 12
                    and not any(Point2(task["position"]).distance_to(Point2(record["position"])) < 1.5
                                for record in gas)]
        return gas, reserved

    def _opening_gas_allowed(self, target):
        if self._opening_decision is None or not self._opening_decision.active:
            return True
        point = getattr(target, "position", target)
        if point is None:
            return False
        bases = [base for base in self._known_bases() if Point2(base["position"]).distance_to(point) <= 12]
        if not bases:
            return False
        base = min(bases, key=lambda row: Point2(row["position"]).distance_to(point))
        gas, reserved = self._local_gas_inventory(base)
        return len(gas) + len(reserved) < self._opening_gas_quota(base)

    def _observe_defense(self, enemies):
        """Remember a short-lived alert from attackers actually seen at a base.

        The destination is a previously observed friendly base, not an enemy's
        hidden position. Returning the camera home must not erase the reason
        for bringing its army to an attacked expansion.
        """
        self._current_defense_threat = None
        threats = [(enemy.distance_to(Point2(base["position"])), base, list(enemy.position))
                   for enemy in enemies if enemy.can_attack and enemy.type_id not in {U.SCV, U.DRONE, U.PROBE}
                   for base in self._known_bases()
                   if enemy.distance_to(Point2(base["position"])) <= 18]
        if threats:
            _, base, self._current_defense_threat = min(threats, key=lambda item: (item[0], item[1]["tag"]))
            if self._defense_alert is None or self._defense_alert["base_tag"] != base["tag"]:
                self._defense_dispatched.clear()
                self._defense_camera_visits.clear()
            self._defense_alert = {"base_tag": base["tag"], "position": list(base["position"]),
                                   "last_seen_seconds": float(self.time)}
        elif self._defense_alert and self.time - self._defense_alert["last_seen_seconds"] > 30:
            self._defense_alert = None
            self._defense_dispatched.clear()
            self._defense_camera_visits.clear()

    def _observe_building_attack_alert(self):
        # The normal client alert is a human-available warning, not enemy
        # telemetry. It has no coordinates, so inspect remembered bases.
        if (Alert.BuildingUnderAttack.value not in getattr(self.state, "alerts", ())
                or self.time - self._last_building_alert < 10 or self._building_alert_checks):
            return
        self._last_building_alert = float(self.time)
        self._building_alert_checks = [
            {"tag": base["tag"], "position": list(base["position"]), "expires": float(self.time) + 20}
            for base in sorted(self._known_bases(), key=lambda row: (row["last_seen_seconds"], row["tag"]))]

    async def _building_attack_camera_step(self):
        if self._defense_alert:
            self._building_alert_checks.clear()  # Location already observed; ordinary defense takes over.
            return False
        if self.time - self._last_building_alert_camera < 1.5:
            return False
        while self._building_alert_checks:
            check = self._building_alert_checks[0]
            point = Point2(check["position"])
            if check["expires"] < self.time or not self.fairplay.camera_would_move(self, point):
                self._building_alert_checks.pop(0)
                continue
            if not await self._move_camera(point):
                return False  # Preserve request until the ordinary input gate allows it.
            self._building_alert_checks.pop(0)
            self._last_building_alert_camera = float(self.time)
            self._building_alert_events.append({"game_seconds": float(self.time), "base_tag": check["tag"],
                                                "position": check["position"], "source": "BuildingUnderAttack"})
            self._building_alert_events = self._building_alert_events[-64:]
            self.action_counts["camera_building_under_attack"] += 1
            return True
        return False

    def _resolve_army_plan(self, plan, own):
        if not self.fairplay.on_screen(Point2(plan.base_position)):
            # This is a strategic rendezvous from remembered own/public map
            # geometry. Its terrain will be validated when brought into view.
            return _clamp_point(self, Point2(plan.candidates[0])), True
        structures = [(unit.position, float(getattr(unit, "radius", _placement_width(self, unit.type_id) / 2)))
                      for unit in own if unit.is_structure]
        structures.extend((Point2(record["position"]), 2.5) for record in
                          getattr(self.memory, "current_enemies", ()) if record.get("is_structure", False))
        for candidate in plan.candidates:
            point = _clamp_point(self, Point2(candidate))
            if not self.fairplay.on_screen(point) or not self.is_visible(point):
                continue
            if any(point.distance_to(position) <= radius + .75 for position, radius in structures):
                continue
            if self.in_pathing_grid(point):
                return point, False
        unseen = next((point for point in plan.candidates
                       if not self.fairplay.on_screen(Point2(point))), None)
        if unseen is not None:
            self._guard_camera_request = list(unseen)
        return None

    def _idle_or_following_base(self, unit, own):
        if unit.is_idle:
            return True
        if unit.tag not in self._army_job_tags:
            return False
        details = _order_details(unit, self.game_data)
        return (len(details) == 1 and not details[0][0].isdisjoint({A.MOVE.value, A.MOVE_MOVE.value})
                and details[0][1] in {other.tag for other in own if other.is_structure})

    def _refresh_cohesion(self, own, order):
        active = bool(order and order.stance in {"attack", "pressure"} and not self._defense_alert)
        if not active:
            self.cohesion.update([], 0, None, None, float(self.time), active=False)
            return
        enemy = self.enemy_start_locations[0] if self.enemy_start_locations else self.game_info.map_center
        targets = [row for row in getattr(self.memory, "enemies", {}).values()
                   if row.get("is_structure", False) and not row.get("is_flying", False)
                   and row.get("status") not in {"destroyed", "not_seen_at_visible_position"}]
        objective = (self._strategy_decision.evidence.get("offensive_objective")
                     if self._strategy_decision else None)
        if objective is not None:
            enemy = Point2(objective["position"])
        elif targets:
            anchor = Point2(self.cohesion.rally) if self.cohesion.rally else self.start_location
            enemy = Point2(min(targets, key=lambda row: anchor.distance_to(Point2(row["position"])))["position"])
        plan = defense_plan(self._rally_bases(), list(enemy), "STALKER")
        resolved = self._resolve_army_plan(plan, own) if plan is not None else None
        rows = []
        for unit in own:
            if (not unit.is_ready or not _is_army(unit) or getattr(unit, "is_hallucination", False)
                    or unit.type_id in {U.OBSERVER, U.OBSERVERSIEGEMODE, U.WARPPRISM, U.WARPPRISMPHASING}
                    or unit.tag in self._nonworker_scout_tags
                    or unit.tag in self.harassment.protected_tags(float(self.time))):
                continue
            data = self.game_data.units.get(unit.type_id.value)
            supply = getattr(getattr(data, "_proto", None), "food_required", 0)
            if isinstance(supply, (float, int)) and math.isfinite(supply) and supply > 0:
                rows.append({"tag": unit.tag, "position": list(unit.position), "supply": supply})
        self.cohesion.update(rows, self.supply_army, resolved[0] if resolved else plan.candidates[0] if plan else None, list(enemy),
                             float(self.time), active=active)

    async def _cohesion_step(self, own, order):
        if self.cohesion.phase == "inactive" or order is None or order.stance not in {"attack", "pressure"}:
            return False
        if not self._prepare_cohort_waypoint(own):
            return False
        target = self.cohesion.waypoint if self.cohesion.phase == "advancing" else self.cohesion.rally
        name = "cohort_advance" if self.cohesion.phase == "advancing" else "cohort_assemble"
        if target is not None and await self._group_army_step(
                own, Point2(target), name, key=(name, self.cohesion.epoch, tuple(target))):
            return True
        protected = self._combat_protected_tags() | self._nonworker_scout_tags
        army = [unit for unit in own if unit.is_ready and _is_army(unit)
                and not getattr(unit, "is_hallucination", False)
                and unit.type_id not in {U.OBSERVER, U.OBSERVERSIEGEMODE, U.WARPPRISMPHASING}
                and not getattr(unit, "cargo_used", 0) and unit.tag not in protected
                and self._ground_source_retry_allowed(unit)
                and self.fairplay.source_available(unit, float(self.time))]
        if not army:
            return False
        queried = await self.get_available_abilities(army, ignore_resource_requirements=False)
        abilities = {unit.tag: values for unit, values in zip(army, queried, strict=True)}
        # A box selects every intersecting unit, including cohort members that
        # already received this waypoint. Preflight that visible occupancy;
        # an accepted selection input is not yet a confirmed command.
        mixed = []
        for unit in army:
            job = self.cohesion.job(unit.tag)
            if unit.type_id == U.WARPPRISM or not job:
                continue
            point = Point2(job["target"])
            canonical = self.game_data.abilities.get(A.ATTACK_ATTACK.value)
            if (self.fairplay.on_screen(point) and self.is_visible(point)
                    and (A.ATTACK_ATTACK in abilities[unit.tag]
                         or getattr(canonical, "id", None) in abilities[unit.tag])
                    and unit.distance_to(point) > 1.5
                    and not duplicate_order([unit], A.ATTACK_ATTACK, point, self.game_data)):
                mixed.append((unit, job, point))
        if mixed:
            _, job, point = mixed[0]
            sources = [unit for unit, other, target in mixed if other["name"] == job["name"] and target == point]
            if len({unit.type_id for unit in sources}) > 1:
                from .fairplay import CAMERA_WIDTH, SCREEN_SIZE

                pixels = [self.fairplay.screen_point(unit) for unit in sources]
                bounds = (max(0, min(pixel.x for pixel in pixels) - 1),
                          max(0, min(pixel.y for pixel in pixels) - 1),
                          min(SCREEN_SIZE[0] - 1, max(pixel.x for pixel in pixels) + 1),
                          min(SCREEN_SIZE[1] - 1, max(pixel.y for pixel in pixels) + 1))
                requested = {unit.tag for unit in sources}
                visible = {}
                occupied = False
                for unit in own:
                    if not self.fairplay.on_screen(unit):
                        continue  # Never inspect hidden/off-screen positions.
                    pixel = self.fairplay.screen_point(unit)
                    radius = float(getattr(unit, "radius", .75))
                    radius = max(.75, radius) if math.isfinite(radius) else .75
                    padding = math.ceil(radius * SCREEN_SIZE[0] / CAMERA_WIDTH) + 1
                    visible[unit.tag] = (pixel.x, pixel.y)
                    if (unit.tag not in requested
                            and pixel.x + padding >= bounds[0] and pixel.x - padding <= bounds[2]
                            and pixel.y + padding >= bounds[1] and pixel.y - padding <= bounds[3]):
                        occupied = True
                context = (self.cohesion.epoch, job["name"], tuple(point), tuple(self.fairplay.camera_center))
                previous = getattr(self, "_cohort_rectangle_attempt", None)
                retry_blocked = bool(previous and previous["context"] == context
                                     and previous["visible"].keys() == visible.keys()
                                     and all(max(abs(a - b) for a, b in zip(previous["visible"][tag], pixel,
                                                                          strict=True)) <= 3
                                             for tag, pixel in visible.items())
                                     and self.fairplay.audit[previous["audit_index"]].get("command_confirmation")
                                     == "source_not_selected")
                if not occupied and not retry_blocked:
                    accepted = await self.fairplay.issue(self, sources, A.ATTACK_ATTACK, point,
                                                         selection_mode="rectangle")
                    if accepted:
                        self._cohort_rectangle_attempt = {"context": context, "visible": visible,
                                                          "audit_index": len(self.fairplay.audit) - 1}
                        self._record_selection(job["name"], point)
                        self.action_counts[job["name"]] += 1
                        return True
                # The ordinary path below chooses one safe type or one unit.
                # Protected scouts, workers and already-dispatched members are
                # never silently added to an unrelated assignment.
        kinds = sorted({unit.type_id for unit in army}, key=lambda kind: (
            self._army_job_attention.get(kind.name, -100.0), kind.value))
        for kind in kinds:
            candidates = []
            for unit in army:
                if unit.type_id != kind:
                    continue
                if kind == U.WARPPRISM:
                    # Empty transports follow the observed army's prior anchor;
                    # they never count toward combat readiness or scout alone.
                    job = {"name": "cohort_support", "target": self.cohesion.rally,
                           "epoch": self.cohesion.epoch}
                else:
                    job = self.cohesion.job(unit.tag)
                    if (job is None and self.cohesion.phase == "advancing" and unit.is_idle
                            and self.cohesion.needs_redispatch(unit.tag, unit.position)):
                        self.cohesion.release([unit.tag])
                        job = self.cohesion.job(unit.tag)
                if job is None:
                    continue
                target = _clamp_point(self, Point2(job["target"]))
                # Combat rendezvous use the same visible-empty-ground gate as
                # advances. A minimap Move can become a follow-unit order and
                # leave the army orbiting an occupied gathering point.
                ability = A.MOVE_MOVE if kind == U.WARPPRISM else A.ATTACK_ATTACK
                public = self.game_data.abilities.get(ability.value)
                canonical = public.id if public else ability
                if ability not in abilities[unit.tag] and canonical not in abilities[unit.tag]:
                    continue
                if unit.distance_to(target) <= 1.5 or duplicate_order([unit], ability, target, self.game_data):
                    continue
                minimap = not self.fairplay.on_screen(target)
                if not minimap and not self.is_visible(target):
                    # A short strategic move into fog is a normal minimap
                    # order, not permission to inspect its hidden terrain.
                    minimap = True
                if not minimap:
                    if (not self.is_visible(target)
                            or (not getattr(unit, "is_flying", False) and not self.in_pathing_grid(target))
                            or any(other.is_structure and other.distance_to(target) <
                                   max(6.5 if other.type_id == U.NEXUS else 0,
                                       float(getattr(other, "radius", 2.5)) + 1)
                                   for other in own)):
                        continue
                candidates.append((unit, job, target, ability, minimap))
            if not candidates:
                continue
            _, job, target, ability, minimap = candidates[0]
            eligible = [unit for unit, candidate, point, action, mini in candidates
                        if candidate["name"] == job["name"] and point == target and action == ability and mini == minimap]
            sources = self._safe_army_sources(eligible, own)
            self._army_plan = {"job": job["name"], "role": "support" if kind == U.WARPPRISM else "cohort",
                               "unit_type": kind.name, "target": list(target), "minimap": minimap,
                               "source_tags": [unit.tag for unit in sources], "epoch": self.cohesion.epoch,
                               "game_seconds": float(self.time), "status": "planned",
                               "description": "Advance together by one short waypoint" if job["name"] == "cohort_advance"
                               else "Rendezvous with the shared army group"}
            accepted = await self.fairplay.issue(self, sources, ability, target, minimap=minimap)
            if accepted:
                self._record_selection(job["name"], target)
                self.action_counts[job["name"]] += 1
            return accepted
        return False

    def _prepare_cohort_waypoint(self, own):
        """Repair an observed blocked rendezvous or undispatched waypoint."""
        self._cohort_blocked = None
        if self.cohesion.phase not in {"assembling", "advancing"}:
            return True
        assembling = self.cohesion.phase == "assembling"
        point = Point2(self.cohesion.rally if assembling else self.cohesion.waypoint)
        origin = Point2(self.cohesion.rally)
        if not self.fairplay.on_screen(point) or not self.is_visible(point):
            return True  # No terrain query and no hidden pathability claim.

        def clear(candidate):
            return (self.fairplay.on_screen(candidate) and self.is_visible(candidate)
                    and self.in_pathing_grid(candidate)
                    and not any(unit.is_structure and unit.distance_to(candidate) <
                                max(6.5 if unit.type_id == U.NEXUS else 0,
                                    float(getattr(unit, "radius", 2.5)) + 1) for unit in own))

        if clear(point):
            return True
        if not assembling and self.cohesion.dispatched and self.cohesion.effective_waypoint is not None:
            confirmed = Point2(self.cohesion.effective_waypoint)
            if origin.distance_to(confirmed) <= 8.01 and clear(confirmed):
                # A guarded click can stop short of the original nominal point.
                # Complete this SAME wave at that observed clear destination;
                # retain all receipts and require the original fresh quorum.
                self.cohesion.waypoint = tuple(confirmed)
                return True
        if assembling:
            # Buildings can occupy a previously clear home post. Move the
            # shared anchor only after seeing that obstruction, using nearby
            # currently visible terrain. This does not infer unseen pathing.
            objective = Point2(self.cohesion.objective)
            angle = math.atan2(objective.y - point.y, objective.x - point.x)
            for radius in (3.0, 5.0, 7.0):
                for degrees in (0, 30, -30, 60, -60, 90, -90, 120, -120, 180):
                    direction = angle + math.radians(degrees)
                    candidate = _clamp_point(self, Point2((point.x + radius * math.cos(direction),
                                                          point.y + radius * math.sin(direction))))
                    if point.distance_to(candidate) <= 7.01 and clear(candidate):
                        self.cohesion.rally = tuple(candidate)
                        return True
            self._cohort_blocked = {"reason": "visible_rendezvous_obstructed", "position": list(point),
                                    "game_seconds": float(self.time), "orders_already_dispatched": False}
            return False
        outstanding = any(row.get("cohort_epoch") == self.cohesion.epoch
                          and row["name"] == "cohort_advance" for row in self._selected_actions.values())
        if not self.cohesion.dispatched and not outstanding:
            angle = math.atan2(point.y - origin.y, point.x - origin.x)
            length = min(8.0, origin.distance_to(point))
            for degrees in (30, -30, 45, -45, 60, -60, 90, -90):
                direction = angle + math.radians(degrees)
                candidate = _clamp_point(self, Point2((origin.x + length * math.cos(direction),
                                                       origin.y + length * math.sin(direction))))
                if origin.distance_to(candidate) <= 8.01 and clear(candidate):
                    self.cohesion.waypoint = tuple(candidate)
                    return True
        self._cohort_blocked = {"reason": "visible_waypoint_obstructed", "position": list(point),
                                "game_seconds": float(self.time), "orders_already_dispatched":
                                bool(self.cohesion.dispatched or outstanding)}
        return False

    def _planned_army_intent(self, own, eligible, ability, *, alert=None):
        eligible = [unit for unit in eligible if self._ground_source_retry_allowed(unit)]
        kinds = sorted({unit.type_id for unit in eligible}, key=lambda kind: (
            self._army_job_attention.get(kind.name, -100.0), kind.value))
        enemy_start = self.enemy_start_locations[0] if self.enemy_start_locations else self.game_info.map_center
        for kind in kinds:
            plan = defense_plan(self._known_bases() if alert else self._rally_bases(), list(enemy_start), kind.name,
                                alert_position=alert["position"] if alert else None,
                                threat_position=self._current_defense_threat if alert else None)
            if plan is None:
                continue
            resolved = self._resolve_army_plan(plan, own)
            if resolved is None:
                continue
            target, minimap = resolved
            group = [unit for unit in eligible if unit.type_id == kind and unit.distance_to(target) > 1.5
                     and not duplicate_order([unit], ability, target, self.game_data)]
            sources = self._safe_army_sources(group, own)
            if not sources:
                continue
            self._army_plan = {**plan.to_dict(), "unit_type": kind.name, "target": list(target),
                               "minimap": minimap, "source_tags": [unit.tag for unit in sources],
                               "game_seconds": float(self.time), "status": "planned", "description": (
                                   "Defend the base approach" if alert else "Guard the exposed base approach")}
            return ActionIntent(tuple(sources), ability, target, minimap)
        return None

    def _rally_bases(self):
        """Keep the first observed natural as home anchor when adding bases."""
        bases = [base for base in self._known_bases() if base["is_ready"]]
        if not bases:
            return []
        main = min(bases, key=lambda row: Point2(row["position"]).distance_to(self.start_location))
        if self._natural_base_tag is None:
            expansions = [base for base in bases if Point2(base["position"]).distance_to(self.start_location) > 8]
            if expansions:
                natural = min(expansions, key=lambda row: (row.get("first_seen_loop", 0),
                                                          Point2(row["position"]).distance_to(self.start_location), row["tag"]))
                self._natural_base_tag = natural["tag"]
                self._natural_base_position = list(natural["position"])
        natural = next((base for base in bases if base["tag"] == self._natural_base_tag), None)
        if natural is None and self._natural_base_position is not None:
            natural = next((base for base in bases if Point2(base["position"]).distance_to(
                Point2(self._natural_base_position)) <= 3), None)
        return [natural or main]

    async def _stop_friendly_attacks(self, own):
        """Stop only attacks whose target is currently observed as ours."""
        current = {unit.tag: unit for unit in own}
        attack_ids = {A.ATTACK.value, A.ATTACK_ATTACK.value}
        for unit in own:
            if (not unit.is_ready or self._friendly_stop_until.get(unit.tag, -100) > self.time
                    or not self.fairplay.source_available(unit, float(self.time))):
                continue
            if getattr(unit, "_proto", None) is None and not hasattr(unit, "orders"):
                continue  # Alternative adapters with no order evidence.
            details = _order_details(unit, self.game_data)
            targets = [target for ids, target, _ in details if not ids.isdisjoint(attack_ids) and target in current]
            if not targets:
                continue
            available = (await self.get_available_abilities([unit], ignore_resource_requirements=False))[0]
            ability = next((value for value in (A.STOP_STOP, A.STOP) if value in available), None)
            self._friendly_attack_recovery = {"source_tag": unit.tag, "target_tag": targets[0],
                                              "observed_game_seconds": float(self.time),
                                              "command_result": "stop_unavailable"}
            if ability is None:
                continue
            accepted = await self.fairplay.issue(self, [unit], ability, None)
            if accepted:
                self._friendly_stop_until[unit.tag] = float(self.time) + 2
                self._friendly_attack_recovery["command_result"] = "selection_pending"
                self._record_selection("stop_friendly_fire")
                self.action_counts["stop_friendly_fire"] += 1
            return accepted
        return False

    async def _guard_army(self, own, order):
        if (order is None or order.stance != "defend" or self._defense_alert
                or self.time - self._last_guard_dispatch < 3):
            return False
        protected = self._combat_protected_tags() | self._nonworker_scout_tags
        army = [unit for unit in own if unit.is_ready and _is_army(unit)
                and not getattr(unit, "is_hallucination", False) and self._idle_or_following_base(unit, own)
                and not getattr(unit, "cargo_used", 0)
                and unit.tag not in protected and self.fairplay.source_available(unit, float(self.time))]
        if not army:
            return False
        queried = await self.get_available_abilities(army, ignore_resource_requirements=False)
        available = {unit.tag: values for unit, values in zip(army, queried, strict=True)}
        kinds = sorted({unit.type_id for unit in army}, key=lambda kind: (
            self._army_job_attention.get(kind.name, -100.0), kind.value))
        for kind in kinds:
            group = [unit for unit in army if unit.type_id == kind]
            ability = A.ATTACK_ATTACK if getattr(group[0], "can_attack", False) else A.MOVE_MOVE
            data = self.game_data.abilities.get(ability.value)
            canonical = data.id if data else ability
            eligible = [unit for unit in group if ability in available[unit.tag] or canonical in available[unit.tag]]
            intent = self._planned_army_intent(own, eligible, ability)
            if intent is None:
                continue
            accepted = await self.fairplay.issue(self, list(intent.sources), intent.ability,
                                                 intent.target, minimap=intent.minimap)
            if accepted:
                self._record_selection("guard_base", intent.target)
                self.action_counts["guard_base"] += 1
            return accepted
        return False

    async def _defense_step(self, own, order):
        alert = self._defense_alert
        if (alert is None or self.time - alert["last_seen_seconds"] > 30
                or (order and order.stance == "retreat")
                or self.time - self._last_defense_dispatch < 5):
            return False
        if self.supply_army >= 6 and self._global_army_allowed(own):
            enemy = self.enemy_start_locations[0] if self.enemy_start_locations else self.game_info.map_center
            plan = defense_plan(self._known_bases(), list(enemy), "STALKER", alert_position=alert["position"],
                                threat_position=self._current_defense_threat)
            resolved = self._resolve_army_plan(plan, own) if plan else None
            if resolved and not resolved[1] and await self._group_army_step(
                    own, resolved[0], "defend", key=("defend", alert["base_tag"])):
                self._selected_actions[len(self.fairplay.audit) - 1]["defense_alert_base_tag"] = alert["base_tag"]
                return True
        protected = self._combat_protected_tags()
        army = [unit for unit in own if unit.is_ready and _is_army(unit) and unit.can_attack
                and not getattr(unit, "is_hallucination", False)
                and (unit.tag not in self._defense_dispatched or unit.is_idle)
                and unit.tag not in protected
                and self.fairplay.source_available(unit, float(self.time))]
        if army:
            available = await self.get_available_abilities(army, ignore_resource_requirements=False)
            canonical = self.game_data.abilities[A.ATTACK_ATTACK.value].id
            eligible = [unit for unit, abilities in zip(army, available, strict=True)
                        if A.ATTACK_ATTACK in abilities or canonical in abilities]
            intent = self._planned_army_intent(own, eligible, A.ATTACK_ATTACK, alert=alert)
            if intent is not None:
                accepted = await self.fairplay.issue(self, list(intent.sources), intent.ability,
                                                     intent.target, minimap=intent.minimap)
                if accepted:
                    self._record_selection("defend", intent.target)
                    self._selected_actions[len(self.fairplay.audit) - 1]["defense_alert_base_tag"] = alert["base_tag"]
                    self.action_counts["defend"] += 1
                return accepted
        # Only remembered positions guide the camera. A failed visit to stale
        # mobile-unit memory is not repeated until that unit is observed again.
        candidates = [record for record in self.memory.own.values()
                      if not record["is_structure"] and record["type"] != "PROBE"
                      and record.get("can_attack", False) and record["is_ready"]
                      and record["tag"] not in self._defense_dispatched
                      and self.time - record["last_seen_seconds"] <= 60
                      and (record["tag"], record["last_seen_loop"]) not in self._defense_camera_visits
                      and not self.fairplay.on_screen(Point2(record["position"]))]
        if candidates and self.time - self._last_camera_change >= 2:
            record = max(candidates, key=lambda row: (row["last_seen_seconds"], -row["tag"]))
            accepted = await self._move_camera(record["position"])
            if accepted:
                self._defense_camera_visits.add((record["tag"], record["last_seen_loop"]))
            return accepted
        return False

    async def _opening_camera_step(self):
        if self.time - self._last_camera_change < 5:
            return False
        decision = self._opening_decision
        if (decision is not None and decision.active and decision.reserve
                and decision.next_base_index is not None
                and decision.next_action not in {"build_nexus", "build_assimilator"}):
            target_base = next((row for row in self._opening_bases()
                                if row["base_index"] == decision.next_base_index), None)
            if (target_base and self.fairplay.camera_center.distance_to(Point2(target_base["position"])) > 5):
                if await self._move_camera(target_base["position"]):
                    self._opening_camera_until = float(self.time) + 3
                    self.action_counts["camera_opening_base"] += 1
                    return True
        return False

    def _apply_chrono_gate(self, own, legal):
        if "chrono_boost" not in legal:
            return
        decision = self.chrono.decision(self.minerals, float(self.time))
        if not decision["allowed"]:
            legal.discard("chrono_boost")
            return
        if decision["target_tags"] is None:
            return
        targets = [unit for unit in own if unit.tag in decision["target_tags"]
                   and self.fairplay.on_screen(unit) and self.is_visible(unit.position)]
        index = ACTION_TO_INDEX["chrono_boost"]
        intent = self._pluto_action_context.get(index)
        if not targets or intent is None:
            legal.discard("chrono_boost")
            return
        self._pluto_action_context[index] = ActionIntent(intent.sources, intent.ability,
            min(targets, key=lambda unit: unit.tag), intent.minimap)

    async def _critical_opening_step(self, own, order):
        """Give an affordable explicit opening building its current input slot."""
        decision = self._opening_decision
        if (decision is None or not decision.active or not decision.reserve
                or getattr(decision, "supply_threshold", None) is None or self._defense_alert):
            return False
        name = decision.next_action
        if name is None or not name.startswith("build_"):
            return False
        if getattr(decision, "core_foundation_observed", False):
            # Resume a real Probe command before servicing the final gas and
            # natural Pylon. Keep ordinary worker refills first thereafter;
            # do not reinstate the17-supply worker pause.
            if not self._post_core_probe_primed or name not in {"build_assimilator", "build_pylon"}:
                return False
            if await self._production_group_step(order, workers_only=True):
                return True
        price = self._production_cost_fields()["action_costs"].get(name)
        status = {"action": name, "time": float(self.time), "camera": list(self.fairplay.camera_center),
                  "stage": decision.step, "public_cost": price, "reason": "waiting_for_current_resources"}
        self._opening_construction_status = status
        pending = next((task for task in self._construction
                        if task["type"] == name.removeprefix("build_").upper()
                        and (name == "build_nexus" or self._opening_position_index(task["position"])
                             == decision.next_base_index)), None)
        if pending is not None:
            status["reason"] = "accepted_construction_awaiting_foundation"
            # The money is already spent. Revisit the accepted target to
            # verify its foundation, never order a second copy while it walks.
            point = Point2(pending["position"])
            if self.fairplay.camera_center.distance_to(point) > 3:
                self._combat_camera_until = self._combat_upkeep_until = -100.0
                self._combat_view_started = None
                await self._move_camera(point)
            return True
        if (price is None or self.minerals < price["minerals"] or self.vespene < price["vespene"]):
            return False
        status["reason"] = "affordable_current_construction_check"
        if name == "build_nexus":
            return await self._expansion_step(own, order)
        bases = self._opening_bases()
        base = next((row for row in bases if row["base_index"] == decision.next_base_index), None)
        if base is None:
            status["reason"] = "intended_base_not_yet_observed"
            return False
        index = ACTION_TO_INDEX[name]
        intent = None
        camera = Point2(base["position"])
        if name == "build_assimilator":
            # Use a legal gas site already in view before looking for another
            # geyser. Otherwise the two main geysers can bounce the camera.
            mask = await legal_action_mask(self)
            candidate = self._pluto_action_context.get(index)
            if mask[index] and candidate is not None and self._opening_gas_allowed(candidate.target):
                intent = candidate
            camera = self.fairplay.camera_center
            gas_view = self._gas_camera_target(order) if intent is None else None
            if gas_view:
                camera = Point2(gas_view["position"])
        elif name != "build_pylon":
            pylons = [row for row in self.memory.own.values() if row["type"] == "PYLON" and row["is_ready"]
                      and self._opening_position_index(row["position"]) == decision.next_base_index]
            if pylons:
                camera = Point2(min(pylons, key=lambda row: camera.distance_to(Point2(row["position"])))["position"])
        if self.fairplay.camera_would_move(self, camera):
            # Before the early Core there is no fighting army to service.
            # A scout's short camera hold must not indefinitely delay macro.
            self._combat_camera_until = self._combat_upkeep_until = -100.0
            self._combat_view_started = None
            accepted = await self._move_camera(camera)
            status["reason"] = "camera_to_required_gas_or_powered_build_area"
            if accepted:
                self._opening_camera_until = float(self.time) + 3
            return accepted
        if intent is None:
            mask = await legal_action_mask(self)
            intent = self._pluto_action_context.get(index)
            if not mask[index] or intent is None:
                status["reason"] = "no_current_legal_construction_intent"
                return False
        reserved = {task["source_tag"] for task in self._construction} | self._worker_transfers.keys()
        if self._expansion:
            reserved.add(self._expansion["source_tag"])
        reserved.add(self._reserved_scout_worker())
        if (any(unit.tag in reserved for unit in intent.sources)
                or not self._opening_structure_allowed(name, intent.target)
                or name == "build_assimilator" and not self._opening_gas_allowed(intent.target)):
            status["reason"] = "source_reserved_or_wrong_base"
            return False
        accepted = await execute_action(self, index)
        self.action_counts[name] += 1
        status["reason"] = "selection_requested" if accepted else "selection_rejected"
        if accepted:
            self._record_selection(name, intent.target)
        return accepted

    async def _expansion_step(self, own, order):
        # Retiring a fulfilled task is observation housekeeping, not permission
        # to expand again. Its Probe is free once this site's actual Nexus
        # foundation has been seen, even while later opening steps forbid a
        # new expansion. Orders and accepted construction reservations alone
        # are not foundation evidence.
        if self._retire_observed_expansion():
            return False
        bases = self._known_bases()
        opening_active = self._opening_decision is not None and self._opening_decision.active
        if opening_active and not self._opening_decision.allow_expansion:
            return False
        base_target = (self._opening_decision.structure_quotas.get("NEXUS", 1) if opening_active else
                       order.base_target if order else 1)
        if self._expansion is None and len(bases) < base_target and self.minerals >= 400:
            occupied = [Point2(record["position"]) for record in bases]
            sites = [point for point in self._public_sites if all(point.distance_to(base) >= 10 for base in occupied)]
            reserved = {task["source_tag"] for task in self._construction} | self._worker_transfers.keys()
            workers = [unit for unit in own if unit.type_id == U.PROBE
                       and unit.tag not in reserved and unit.tag != self._reserved_scout_worker()
                       and self.fairplay.source_available(unit, float(self.time))]
            if sites and workers:
                point = sites[0]
                worker = min(workers, key=lambda unit: unit.distance_to(point))
                self._expansion = {"position": list(point), "source_tag": int(worker.tag),
                                   "started": float(self.time), "move_confirmed": False,
                                   "last_visit_at": -100.0, "wait_reason": "move_confirmation"}
                accepted = await self._move_worker(worker, point, "expand_move")
                if not accepted:
                    self._expansion = None
                return accepted
        task = self._expansion
        if task is None:
            return False
        point = Point2(task["position"])
        if any(record["type"] == "NEXUS" for record in self._construction):
            task["wait_reason"] = "accepted_construction_pending"
            return False
        if not task["move_confirmed"]:
            task["wait_reason"] = "move_confirmation"
            return False
        if self.minerals < 400:
            task["wait_reason"] = "saving_400_minerals"
            return False
        if not self.fairplay.on_screen(point):
            # Let the camera spend a useful interval at home between checks of
            # the commanded destination. Do not locate the worker off-screen.
            task["wait_reason"] = "site_camera_due"
            if self.time - self._last_camera_change < 2 or self.time - task.get("last_visit_at", -100) < 10:
                return False
            accepted = await self._move_camera(point)
            if accepted:
                task.update(last_visit_at=float(self.time), wait_reason="site_camera_requested")
            return accepted
        task["last_visit_at"] = float(self.time)
        worker = next((unit for unit in own if unit.tag == task["source_tag"]), None)
        if worker is None:
            task["wait_reason"] = "builder_not_currently_visible"
            # A failed trip must not lock the controller at an empty site.
            # Expiring our task makes no claim about this off-screen worker.
            if self.time - task["started"] > 45:
                self._expansion = None
            return False
        ability = A.PROTOSSBUILD_NEXUS
        task["footprint_visible"] = _visible_footprint(self, point, 5)
        task["wait_reason"] = "footprint_not_visible"
        if task["footprint_visible"]:
            available = await self.get_available_abilities([worker], ignore_resource_requirements=False)
            canonical = self.game_data.abilities[ability.value].id
            task["build_ability_available"] = ability in available[0] or canonical in available[0]
            task["wait_reason"] = "build_ability_unavailable"
            if task["build_ability_available"]:
                task["placement_legal"] = await self.can_place_single(ability, point)
                task["wait_reason"] = "placement_rejected"
            if task["build_ability_available"] and task.get("placement_legal"):
                accepted = await self.fairplay.issue(self, [worker], ability, point)
                task["wait_reason"] = "build_selection_pending" if accepted else "input_gate"
                if accepted:
                    self._record_selection("build_nexus", point)
                    self.action_counts["build_nexus"] += 1
                return accepted
        return False

    def _transfer_arrived(self, worker, base, destination):
        """Recognize our own move without interrupting another observed job."""
        if worker.distance_to(destination) > 10:
            return False
        if worker.is_idle:
            return True
        details = _order_details(worker)
        move_ids = {A.MOVE.value, A.MOVE_MOVE.value}
        if len(details) != 1 or details[0][0].isdisjoint(move_ids):
            return False  # Includes reserved/unknown orders such as NULL_NULL.
        if details[0][1] is not None:
            return details[0][1] == base.tag
        proto = getattr(worker, "_proto", None)
        if proto is None or not proto.orders[0].HasField("target_world_space_pos"):
            return False
        point = proto.orders[0].target_world_space_pos
        # Minimap commands quantize the requested world point to a pixel.
        return Point2((point.x, point.y)).distance_to(destination) <= 3

    async def _finish_worker_transfers(self, own):
        """Hand an observed arrival to visible minerals through normal input.

        SC2 can retain MOVE targeting a Nexus forever after the worker arrives.
        Such a worker never becomes idle, so the general harvest selector cannot
        recover it. Only confirmed transfers and their matching move qualify.
        """
        if not self._worker_transfers:
            return False
        reserved = {task["source_tag"] for task in self._construction}
        reserved.add(self._reserved_scout_worker())
        if self._expansion:
            reserved.add(self._expansion["source_tag"])
        minerals = [unit for unit in self.mineral_field if self.fairplay.on_screen(unit)
                    and unit.is_visible and not unit.is_snapshot and unit.mineral_contents > 0]
        mineral_tags = {unit.tag for unit in minerals}
        gas_tags = {unit.tag for unit in own if unit.type_id == U.ASSIMILATOR}
        for worker in own:
            task = self._worker_transfers.get(worker.tag)
            if (task is None or worker.type_id != U.PROBE or worker.tag in reserved
                    or not self.fairplay.on_screen(worker)):
                continue
            if _harvest_assignment(worker, mineral_tags, gas_tags) is not None:
                del self._worker_transfers[worker.tag]  # Observed mining resolves the trip.
                continue
            point = Point2(task["position"])
            base = next((unit for unit in own if unit.type_id == U.NEXUS and unit.is_ready
                         and unit.distance_to(point) <= 3 and self.fairplay.on_screen(unit)), None)
            targets = [unit for unit in minerals if unit.distance_to(point) <= 12]
            if (base is None or not targets or not self._transfer_arrived(worker, base, point)
                    or not self.fairplay.source_available(worker, float(self.time))):
                continue
            available = (await self.get_available_abilities([worker], ignore_resource_requirements=False))[0]
            ability = next((ability for ability in (A.HARVEST_GATHER, A.HARVEST_GATHER_PROBE)
                            if ability in available), None)
            if ability is None:
                continue
            target = min(targets, key=lambda unit: (worker.distance_to(unit.position), unit.tag))
            accepted = await self.fairplay.issue(self, [worker], ability, target)
            if accepted:
                self._record_selection("worker_transfer_harvest", target)
                self.action_counts["worker_transfer_harvest"] += 1
            return accepted
        return False

    async def _transfer_worker(self, own):
        if await self._finish_worker_transfers(own):
            return True
        if self.time - self._last_transfer < 5 or len(self._known_bases()) < 2:
            return False
        local = [unit for unit in own if unit.type_id == U.NEXUS and unit.is_ready
                 and unit.assigned_harvesters > unit.ideal_harvesters]
        targets = [record for record in self._known_bases() if record["is_ready"]
                   and record.get("assigned_harvesters", 0) + sum(
                       Point2(task["position"]).distance_to(Point2(record["position"])) <= 3
                       for task in self._worker_transfers.values()) < record.get("ideal_harvesters", 16)
                   and not self.fairplay.on_screen(Point2(record["position"]))]
        reserved = {task["source_tag"] for task in self._construction} | self._worker_transfers.keys()
        if self._expansion:
            reserved.add(self._expansion["source_tag"])
        mineral_tags = {unit.tag for unit in self.mineral_field if self.fairplay.on_screen(unit)}
        gas_tags = {unit.tag for unit in own if unit.type_id == U.ASSIMILATOR}
        workers = [unit for unit in own if unit.type_id == U.PROBE and unit.tag not in reserved
                   and unit.tag != self._reserved_scout_worker()
                   and (unit.is_idle or _harvest_assignment(unit, mineral_tags, gas_tags) == "minerals")]
        if local and targets and workers:
            point = Point2(min(targets, key=lambda record: record["last_seen_seconds"])["position"])
            accepted = await self._move_worker(min(workers, key=lambda unit: unit.distance_to(point)), point, "worker_transfer")
            if accepted:
                self._last_transfer = float(self.time)
            return accepted
        return False

    def _gas_camera_target(self, order):
        """Frame a planned gas site and nearby builders using public geometry.

        Centering only on a Nexus can permanently exclude every geyser's full
        build footprint. This chooses a camera destination, not a build site
        legality result; the normal screen/fog/placement checks still decide
        whether construction or worker assignment is possible afterward.
        """
        opening_active = self._opening_decision is not None and self._opening_decision.active
        if not opening_active and (order is None or order.gas_workers_per_base == 0 or self.supply_workers < 12
                or not any(record["type"] in {"GATEWAY", "WARPGATE"} for record in self.memory.own.values())):
            return None
        bases = [base for base in self._known_bases() if base["is_ready"]]
        for base in sorted(bases, key=lambda row: (row["last_seen_seconds"], row["tag"])):
            position = Point2(base["position"])
            desired = self._opening_gas_quota(base) if opening_active else math.ceil(order.gas_workers_per_base / 3)
            if desired <= 0:
                continue
            gas_workers = desired * 3 if opening_active else order.gas_workers_per_base
            local_gas, reservations = self._local_gas_inventory(base)
            occupied = [Point2(record["position"]) for record in local_gas + reservations]
            candidates = []
            if len(occupied) < desired and self.minerals >= 75:
                candidates.extend(point for point in self._public_geysers if point.distance_to(position) <= 12
                                  and all(point.distance_to(existing) >= 1.5 for existing in occupied))
            if (sum(record.get("assigned_harvesters", 0) for record in local_gas)
                    < gas_workers):
                candidates.extend(Point2(record["position"]) for record in local_gas
                                  if not record["is_ready"] or record.get("assigned_harvesters", 0) < 3)
            # Remembered saturation is not current staffing. A gas worker may
            # die or be reassigned while its geyser lies outside the base view.
            candidates.extend(Point2(record["position"]) for record in local_gas
                              if self.time - record.get("last_seen_seconds", self.time) >= 30)
            candidates.extend(Point2(record["position"]) for record in reservations)
            for geyser in sorted(candidates, key=lambda point: (point.distance_to(position), point.x, point.y)):
                if not _visible_footprint(self, geyser, 3):
                    # Bias slightly toward the gas so minimap pixel rounding
                    # cannot leave a footprint edge outside the short screen.
                    camera = position.towards(geyser, position.distance_to(geyser) * .6)
                    return {"base_tag": base["tag"], "geyser": list(geyser), "position": list(camera)}
        return None

    async def _camera_schedule(self, own, order):
        if self.time < self._opening_camera_until:
            return False
        if self.time < self._combat_upkeep_until:
            return False
        if self.time < self._combat_camera_until and (order is None or order.stance != "retreat"):
            return False
        if self.time < self._army_attention_until:
            return False
        if self.time - self._last_camera_change < 5:
            return False
        bases = self._known_bases()
        if self.supply_left <= max(6, 2 * len(bases)) and self.supply_cap < 200:
            # Stale unfinished memory must not suppress supply forever. Visit
            # one old Pylon to verify it, without inferring unseen completion.
            candidates = [row for row in self.memory.own.values() if row["type"] == "PYLON"
                          and not row["is_ready"] and self.time - row["last_seen_seconds"] >= 25
                          and self._supply_camera_visits.get(row["tag"]) != row.get("last_seen_loop")
                          and not self.fairplay.on_screen(Point2(row["position"]))]
            if candidates:
                row = min(candidates, key=lambda item: (item["last_seen_seconds"], item["tag"]))
                if await self._move_camera(row["position"]):
                    self._supply_camera_visits[row["tag"]] = row.get("last_seen_loop")
                    self.action_counts["camera_verify_supply"] += 1
                    return True
        if self._army_camera_return:
            point = Point2(self._army_camera_return)
            if not self.fairplay.camera_would_move(self, point):
                self._army_camera_return = None
            elif await self._move_camera(point):
                self._army_camera_return = None
                self.action_counts["camera_army_return"] += 1
                return True
        if self._gas_camera_return and self.time >= self._gas_camera_return["due_game_seconds"]:
            # A gas view can still contain the Nexus while omitting Gateway
            # and Core production. Nexus freshness is not whole-base freshness.
            # Return explicitly, even for offsets smaller than the usual
            # twelve-tile home threshold or after the strategy expires.
            point = Point2(self._gas_camera_return["position"])
            if not self.fairplay.camera_would_move(self, point):
                self._gas_camera_return = None
            elif await self._move_camera(point):
                self._gas_camera_return = None
                self.action_counts["camera_gas_return"] += 1
                return True
        if (self.cohesion.phase != "inactive" and order and order.stance in {"attack", "pressure"}
                and self.time - self._last_cohort_camera >= 12):
            # A completed eight-tile order waits for a new screen observation.
            # Never extrapolate a moving army from an increasingly stale sighting.
            point = Point2(self.cohesion.arrival_point if self.cohesion.phase == "advancing"
                           and (self.cohesion.dispatched or self.cohesion.observed_arrivals)
                           else self.cohesion.rally)
            recruits = [row for row in self.memory.own.values()
                        if not row["is_structure"] and row.get("can_attack", False)
                        and row["type"] not in {"PROBE", "SCV", "DRONE"}
                        and row["tag"] not in self._nonworker_scout_tags
                        and row["tag"] != self._worker_scout_lease.designated_worker_tag
                        and not row.get("is_hallucination", False) and row["is_ready"]
                        and self.time - row["last_seen_seconds"] <= 90
                        and (self.cohesion.phase == "assembling" or row["tag"] not in self.cohesion.members)
                        and self._cohort_camera_visits.get(row["tag"]) != row["last_seen_loop"]
                        and not self.fairplay.on_screen(Point2(row["position"]))]
            if recruits and self.cohesion.phase == "assembling" and self._cohort_camera_turn % 2 == 1:
                record = min(recruits, key=lambda row: (row["last_seen_seconds"], row["tag"]))
                point = Point2(record["position"])
            moving = self.fairplay.camera_would_move(self, point)
            if not moving or await self._move_camera(point):
                self._cohort_camera_turn += 1
                self._last_cohort_camera = float(self.time)
                self._army_attention_until = float(self.time) + 3
                self._army_camera_request = {"position": list(point), "game_seconds": float(self.time),
                                             "camera_input": moving, "purpose": "cohort_arrival_or_recruitment"}
                for row in recruits:
                    if Point2(row["position"]).distance_to(point) <= 6:
                        self._cohort_camera_visits[row["tag"]] = row["last_seen_loop"]
                if bases:
                    self._army_camera_return = list(min(bases, key=lambda row: (
                        row["last_seen_seconds"], row["tag"]))["position"])
                if moving:
                    self.action_counts["camera_cohort"] += 1
                return moving
        if self._guard_camera_request is not None:
            point = Point2(self._guard_camera_request)
            self._guard_camera_request = None
            if await self._move_camera(point):
                self.action_counts["camera_guard_post"] += 1
                return True
        if (order and order.stance in {"pressure", "attack"}
                and self.cohesion.phase == "inactive"
                and self.time - self._last_army_attention >= 15):
            army = [record for record in self.memory.own.values()
                    if not record["is_structure"] and record["type"] != "PROBE"
                    and record.get("can_attack", False) and record["is_ready"]]
            if army:
                unvisited = [row for row in army
                             if self._army_attention_visits.get(row["tag"]) != row["last_seen_loop"]]
                if unvisited:
                    # Bring uncommanded groups into view, then follow older
                    # sightings. Attempted stale positions are not looped on
                    # unless those units are actually observed there again.
                    record = min(unvisited, key=lambda row: (bool(row.get("orders")),
                                                             row["last_seen_seconds"], row["tag"]))
                    point = Point2(record["position"])
                else:
                    point = self._army_camera_position or Point2(army[0]["position"])
                    if self._army_destination is not None:
                        destination = Point2(self._army_destination)
                        if point.distance_to(destination) > 0:
                            point = point.towards(destination, min(8, point.distance_to(destination)))
                moving = self.fairplay.camera_would_move(self, point)
                if not moving or await self._move_camera(point):
                    self._last_army_attention = float(self.time)
                    self._army_attention_until = float(self.time) + 5
                    self._army_camera_position = point
                    self._army_camera_request = {"position": list(point), "game_seconds": float(self.time),
                                                 "camera_input": moving}
                    for row in army:
                        if Point2(row["position"]).distance_to(point) <= 6:
                            self._army_attention_visits[row["tag"]] = row["last_seen_loop"]
                    if bases:
                        self._army_camera_return = list(min(bases, key=lambda row: (
                            row["last_seen_seconds"], row["tag"]))["position"])
                    if moving:
                        self.action_counts["camera_army_attention"] += 1
                    return moving
        if self.time - self._last_construction_camera >= 20:
            # An observed Nexus may disappear from memory while an accepted
            # build at that location is still unresolved. Revisit the known
            # footprint independently of the current base list. A visit is
            # observation only; unseen builders/tasks are never timed out.
            candidates = []
            for task in self._construction:
                key = (task["type"], *task["position"], task["issued_game_seconds"])
                if (self.time - task["issued_game_seconds"] >= 8
                        and not _visible_footprint(self, Point2(task["position"]),
                                                   _placement_width(self, U[task["type"]]))):
                    candidates.append((self._construction_camera_visits.get(key, -100.0), key, task))
            if candidates:
                _, key, task = min(candidates, key=lambda entry: (entry[0], entry[1]))
                if await self._move_camera(task["position"]):
                    self._last_construction_camera = float(self.time)
                    self._construction_camera_visits[key] = float(self.time)
                    self._construction_camera_request = {**task, "game_seconds": float(self.time)}
                    self.action_counts["camera_construction"] += 1
                    return True
        # A confirmed dispatch permits bounded arrival checks, not a permanent
        # timer that visits a fogged enemy base after the scout disappears.
        lease = self._scout_camera_lease
        if (order and order.scout and order.stance != "retreat" and lease is not None
                and lease["status"] not in {"stopped_no_scout_observation", "reassigned_to_army"}
                and self.time >= lease["next_check_game_seconds"] and self.time - self._last_scout_camera >= 20):
            point = Point2(lease["destination"])
            moving = self.fairplay.camera_would_move(self, point)
            if not moving or await self._move_camera(point):
                self._last_scout_camera = float(self.time)
                lease["pending_visit_loop"] = int(self.state.game_loop) - int(not moving)
                lease["next_check_game_seconds"] = float(self.time) + 20
                if not moving:
                    self._observe_scout_camera(own)
                else:
                    self.action_counts["camera_scout_arrival"] += 1
                    return True
        if self.time - self._last_gas_camera >= 15:
            gas = self._gas_camera_target(order)
            if gas is not None and await self._move_camera(gas["position"]):
                self._last_gas_camera = float(self.time)
                self._gas_camera_request = {**gas, "game_seconds": float(self.time)}
                base = next(record for record in bases if record["tag"] == gas["base_tag"])
                self._gas_camera_return = {"position": list(base["position"]),
                                           "due_game_seconds": float(self.time) + 5}
                self.action_counts["camera_gas"] += 1
                return True
        if bases:
            # Revisit each observed base regularly for production and saturation.
            candidate = min(bases, key=lambda record: (record["last_seen_seconds"], record["tag"]))
            if self.time - candidate["last_seen_seconds"] > 7:
                return await self._move_camera(candidate["position"])
        if self.fairplay.camera_center.distance_to(self.start_location) > 12 and self.time - self._last_camera_change > 7:
            return await self._move_camera(self.start_location)
        return False

    async def _army_intents(self, own, legal):
        """Rotate legal same-type selections instead of repeatedly selecting
        the first unit type while the rest of a mixed army stays at home."""
        army = [unit for unit in own if unit.is_ready and _is_army(unit)
                and not getattr(unit, "is_hallucination", False)
                and unit.tag not in self._nonworker_scout_tags
                and unit.tag not in self.harassment.protected_tags(float(self.time))
                and not getattr(unit, "cargo_used", 0)
                and self.prism.protected_tags.get(unit.tag, -100) <= self.time
                and self.fairplay.source_available(unit, float(self.time))]
        if not army:
            legal.difference_update({"attack_enemy_base", "attack_visible_enemy", "defend", "retreat"})
            return
        queried = await self.get_available_abilities(army, ignore_resource_requirements=False)
        abilities = {unit.tag: values for unit, values in zip(army, queried, strict=True)}
        protected = self._combat_protected_tags()
        for name in ("attack_enemy_base", "attack_visible_enemy", "defend", "retreat"):
            if name not in legal:
                continue
            if name in {"attack_enemy_base", "attack_visible_enemy"} and self.cohesion.phase != "inactive":
                legal.discard(name)
                continue
            index = ACTION_TO_INDEX[name]
            intent = self._pluto_action_context[index]
            ability, target = intent.ability, intent.target
            if name == "defend" and self._defense_alert:
                target = Point2(self._defense_alert["position"])
            canonical = self.game_data.abilities[ability.value].id
            eligible = [unit for unit in army if (ability in abilities[unit.tag] or canonical in abilities[unit.tag])
                        and (name == "retreat" or unit.tag not in protected)]
            if name == "defend" and self._defense_alert:
                eligible = [unit for unit in eligible if unit.tag not in self._defense_dispatched or unit.is_idle]
            elif name == "defend":
                eligible = [unit for unit in eligible if self._idle_or_following_base(unit, own)]
            if name == "defend":
                planned = self._planned_army_intent(own, eligible, ability, alert=self._defense_alert)
                if planned is None:
                    legal.discard(name)
                else:
                    self._pluto_action_context[index] = planned
                continue
            if ability == A.ATTACK_ATTACK:
                eligible = [unit for unit in eligible if unit.can_attack]
                if hasattr(target, "tag"):
                    eligible = [unit for unit in eligible if (unit.can_attack_air if target.is_flying else unit.can_attack_ground)]
            if name == "attack_enemy_base":
                structures = [record for record in self.memory.enemies.values() if record["is_structure"]]
                if structures:
                    ground = [record for record in structures if not record["is_flying"]]
                    if ground:
                        target = Point2(min(ground, key=lambda record: self.fairplay.camera_center.distance_to(Point2(record["position"])))["position"])
            eligible = [unit for unit in eligible if not duplicate_order([unit], ability, target, self.game_data)
                        and (ability != A.ATTACK_ATTACK or hasattr(target, "tag")
                             or self._ground_source_retry_allowed(unit))]
            if not eligible:
                legal.discard(name)
            else:
                self._pluto_action_context[index] = ActionIntent(tuple(self._safe_army_sources(eligible, own)),
                                                                 ability, target, intent.minimap)

    async def _nonworker_scout_intent(self, own, order):
        """Offer one fresh idle nonworker scout between productive actions.

        A past Probe scouting trip must not disable every later Observer. The
        worker lease is unchanged; this separate role uses only on-screen idle
        Observers, at most once per accepted unit. Prisms stay with the army.
        """
        if (order is None or not order.scout or order.stance == "retreat" or self._defense_alert
                or self.time - self._last_nonworker_scout_dispatch < 30):
            return False
        scouts = [unit for unit in own if unit.type_id == U.OBSERVER
                  and unit.is_ready and unit.is_idle and not getattr(unit, "cargo_used", 0)
                  and unit.tag not in self._nonworker_scout_tags and self.fairplay.on_screen(unit)
                  and self.fairplay.source_available(unit, float(self.time))]
        if not scouts:
            return False
        queried = await self.get_available_abilities(scouts, ignore_resource_requirements=False)
        public = self.game_data.abilities.get(A.MOVE_MOVE.value)
        canonical = public.id if public is not None else A.MOVE_MOVE
        eligible = [unit for unit, abilities in zip(scouts, queried, strict=True)
                    if A.MOVE_MOVE in abilities or canonical in abilities]
        if not eligible:
            return False
        target = self.enemy_start_locations[0] if self.enemy_start_locations else self.game_info.map_center
        self._pluto_action_context[ACTION_TO_INDEX["scout"]] = ActionIntent(
            (min(eligible, key=lambda unit: (unit.type_id != U.OBSERVER, unit.tag)),),
            A.MOVE_MOVE, target, True)
        return True

    async def _opening_probe_scout_intent(self, own, order, legal):
        # An accepted build click is not a started Gateway. Observe its
        # foundation first, then send that same builder on the one Probe trip.
        legal.discard("scout")
        builder = self._gateway_scout_builder
        if (builder is None or order is None or not order.scout or order.stance == "retreat"
                or self._defense_alert or self._last_scout_dispatch >= 0):
            return False
        if any(row["type"] == "GATEWAY" and Point2(row["position"]).distance_to(Point2(builder["position"])) < 2
               for row in self.memory.own.values()):
            builder["foundation_observed"] = True
        if not builder["foundation_observed"]:
            return False
        source = next((unit for unit in own if unit.tag == builder["tag"] and unit.type_id == U.PROBE
                       and self.fairplay.on_screen(unit) and self.fairplay.source_available(unit, float(self.time))), None)
        if source is None:
            return False
        queried = await self.get_available_abilities([source], ignore_resource_requirements=False)
        public = self.game_data.abilities.get(A.MOVE_MOVE.value)
        canonical = public.id if public is not None else A.MOVE_MOVE
        if A.MOVE_MOVE not in queried[0] and canonical not in queried[0]:
            return False
        target = self.enemy_start_locations[0] if self.enemy_start_locations else self.game_info.map_center
        self._pluto_action_context[ACTION_TO_INDEX["scout"]] = ActionIntent((source,), A.MOVE_MOVE, target, True)
        legal.add("scout")
        return True

    def _reserved_scout_worker(self):
        mission = self.probe_route.mission
        if mission and mission["status"] == "finished" and mission.get("observed_home"):
            return None  # Same designated Probe may resume ordinary mining.
        return self._worker_scout_lease.designated_worker_tag

    async def _probe_route_step(self, own, enemies, order):
        if self.probe_route.mission is None or self.time < self._combat_upkeep_until:
            return False
        now = float(self.time)
        source = next((unit for unit in own if unit.tag == self.probe_route.designated_tag
                       and self.fairplay.on_screen(unit)), None)
        safe = []
        if source is not None:
            for candidate in self.probe_route.candidate_waypoints(source, enemies, now):
                point = Point2(candidate)
                distance = source.distance_to(point)
                steps = max(1, math.ceil(distance))
                samples = [source.position.towards(point, distance * i / steps) for i in range(1, steps + 1)]
                if all(self.fairplay.on_screen(p) and self.is_visible(p) and self.in_pathing_grid(p) for p in samples):
                    safe.append(point)
        intent = self.probe_route.plan(source, enemies, now, safe_points=safe,
            camera=self.fairplay.camera_center, retreat=bool(self._defense_alert or order is None or order.stance == "retreat"))
        if intent is None:
            return False
        if intent["kind"] == "release":
            self.probe_route.confirm(intent, True, now, actual_source_tags=[])
            if self._scout_camera_lease and self._scout_camera_lease["source_tag"] == self.probe_route.designated_tag:
                self._scout_camera_lease = None
            return False
        if intent["kind"] == "camera":
            accepted = await self._move_camera(intent["position"])
            self.probe_route.confirm(intent, accepted, now, actual_source_tags=[])
            return accepted
        if source is None or not self.fairplay.source_available(source, now):
            self.probe_route.confirm(intent, False, now, actual_source_tags=[])
            return False
        target = Point2(intent["position"])
        if not intent["minimap"] and target not in safe:
            self.probe_route.confirm(intent, False, now, actual_source_tags=[])
            return False
        queried = await self.get_available_abilities([source], ignore_resource_requirements=False)
        public = self.game_data.abilities.get(A.MOVE_MOVE.value)
        canonical = public.id if public is not None else A.MOVE_MOVE
        if A.MOVE_MOVE not in queried[0] and canonical not in queried[0]:
            self.probe_route.confirm(intent, False, now, actual_source_tags=[])
            return False
        accepted = await self.fairplay.issue(self, [source], A.MOVE_MOVE, target, minimap=intent["minimap"])
        if accepted:
            self._record_selection(intent["name"], target)
            self._selected_actions[len(self.fairplay.audit) - 1]["probe_route"] = intent
            self.action_counts[intent["name"]] += 1
            if not intent["minimap"]:
                if self._combat_view_started is None:
                    self._combat_view_started = now
                self._combat_camera_until = min(now + 2, self._combat_view_started + 8)
        else:
            self.probe_route.confirm(intent, False, now, actual_source_tags=[])
        return accepted

    async def _step(self, iteration):
        if self._episode_finished or self.forfeit_reason is not None:
            return
        self.fairplay.sync_camera(self)
        own, enemies = screen_entities(self)
        self.memory.observe(self, own, enemies)
        self.chrono.observe(own, float(self.time))
        self.groups.observe(own, float(self.time))
        self._observe_defense(enemies)
        self._observe_building_attack_alert()
        self._worker_scout_lease.observe(self, own)
        self._confirm_commands(own)
        self._observe_scout_camera(own)
        evidence = self._economic_guard.observe(self, own)
        self._current_order = self.mailbox.poll(float(self.time), self.report_sequence)
        self._refresh_opening(enemies)
        self._adapt_current_strategy()
        self._refresh_cohesion(own, self._current_order)
        self._report()
        if self.time >= self.max_game_seconds:
            self._time_limited = True
            return
        if (self.session / "STOP").exists():
            await self._forfeit({"reason": "coach_session_stop"})
            return
        if evidence:
            await self._forfeit(evidence)
            return
        # Optional wall pacing leaves CPU available while Codex prepares the
        # next strategy. It does not change APM measurement in game seconds.
        remaining = self.time / self.speed - (time.monotonic() - self._wall_start)
        if remaining > 0:
            await asyncio.sleep(min(remaining, 1))
        if await self.fairplay.advance(self) or not self.fairplay.can_issue(float(self.time)):
            return
        order = self._current_order
        if await self._store_pending_group():
            return
        if await self._stop_friendly_attacks(own):
            return
        if await self._building_attack_camera_step():
            return
        if await self._critical_opening_step(own, order):
            return
        if await self._ground_camera_recovery_step(own):
            return
        if await self._combat_upkeep():
            return
        if await self._probe_route_step(own, enemies, order):
            return
        if ((self.harassment.mission or self.harassment.camera_visit
             and self.time >= self.harassment.camera_visit["until"])
                and await self._harassment_step(own, enemies, order, production_due=True)):
            return
        if self.time >= self._combat_upkeep_until:
            if await self.prism.step(self, own, enemies, order):
                if self._combat_view_started is None:
                    self._combat_view_started = float(self.time)
                self._combat_camera_until = min(float(self.time) + 2, self._combat_view_started + 8)
                return
            protected = {tag for leases in (self.prism.protected_tags, self.force_fields.protected_tags)
                         for tag, until in leases.items() if until > self.time}
            protected.update(self.harassment.protected_tags(float(self.time)))
            if await self.combat.step(self, own, enemies, order, protected_tags=protected, guardian_only=True):
                return
            if await self.force_fields.step(self, own, enemies, order, protected_tags=self._combat_protected_tags()):
                if self._combat_view_started is None:
                    self._combat_view_started = float(self.time)
                self._combat_camera_until = min(float(self.time) + 2, self._combat_view_started + 8)
                return
            # An existing, bounded army visit can take a worker opportunity
            # before generic focus-fire consumes the same combat input.
            # Economy upkeep still gets its regular camera/production window.
            if (self.supply_left > 2 and not (self._opening_decision and self._opening_decision.active)
                    and (self.time < self._army_attention_until or self._combat_view_started is not None)
                    and await self._harassment_step(own, enemies, order, production_due=False)):
                return
            if await self.combat.step(self, own, enemies, order, protected_tags=protected):
                return
        if await self._defense_step(own, order):
            return
        if await self._production_group_step(order):
            return
        # A paid camera visit reserves a short action window for the army.
        # Without this, expansion/mining/production keep consuming the visit
        # and recruitment runs only if every macro task happens to be idle.
        if self.time < self._army_attention_until and await self._cohesion_step(own, order):
            return
        if await self._opening_camera_step():
            return
        if await self._expansion_step(own, order):
            return
        if await self._transfer_worker(own):
            return
        if await self._camera_schedule(own, order):
            return
        mask = await legal_action_mask(self)
        legal = {ACTION_NAMES[index] for index, allowed in enumerate(mask) if allowed}
        for name in list(legal):
            if name.startswith("build_") and not self._opening_structure_allowed(
                    name, self._pluto_action_context[ACTION_TO_INDEX[name]].target):
                legal.discard(name)
        if "build_assimilator" in legal and not self._opening_gas_allowed(
                self._pluto_action_context[ACTION_TO_INDEX["build_assimilator"]].target):
            legal.discard("build_assimilator")
        await self._army_intents(own, legal)
        await self._opening_probe_scout_intent(own, order, legal)
        if self._defense_alert and (order is None or order.stance != "retreat"):
            legal.discard("attack_enemy_base")
        legal.discard("build_nexus")  # Exact visible resource site only.
        reserved = {task["source_tag"] for task in self._construction} | self._worker_transfers.keys()
        if self._expansion:
            reserved.add(self._expansion["source_tag"])
        for name in list(legal):
            intent = self._pluto_action_context[ACTION_TO_INDEX[name]]
            blocked = reserved | ({self._reserved_scout_worker()} if name != "scout" else set())
            if any(unit.type_id == U.PROBE and unit.tag in blocked for unit in intent.sources):
                legal.discard(name)
        report = self.memory.report(self)
        report["pending_construction"] = self._construction
        report.update(self._production_cost_fields())
        report.update(explicit_supply_opening=self.chrono.enabled, defense_alert=self._defense_alert)
        self._group_candidates(report, legal)
        self._apply_chrono_gate(own, legal)
        opening_chrono_priority = (self.chrono.enabled and self.chrono.accepted_chronos < 2
                                  and "chrono_boost" in legal)
        if (not opening_chrono_priority
                and self.scout_spells.reserve_for_first_recharge(report, order, float(self.time))):
            legal.discard("chrono_boost")
        report["opening_chrono_priority"] = opening_chrono_priority
        name = self.executor.choose_action(order, report, legal, float(self.time))
        if self.opening is not None:
            self._opening_decision = self.executor.opening_decision
        if (name in {"no_op", "chrono_boost", "defend", "attack_enemy_base", "attack_visible_enemy"}
                and not (name == "chrono_boost" and opening_chrono_priority)):
            if await self._harassment_step(own, enemies, order, production_due=False):
                return
            if await self.scout_spells.step(self, own, enemies, order):
                return
        protected_opening_action = (name == "chrono_boost" and opening_chrono_priority
            or name == "train_stalker" and bool(getattr(self.executor, "opening_army_priority", None)
                and self.executor.opening_army_priority["active"]))
        if (order and order.scout and "scout" in legal and self._last_scout_dispatch < 0
                and not protected_opening_action):
            name = "scout"
        elif name == "no_op" and await self._nonworker_scout_intent(own, order):
            name = "scout"
        if name == "no_op":
            if await self._cohesion_step(own, order):
                return
            if await self._guard_army(own, order):
                return
            await self._camera_schedule(own, order)
            return
        if name == "chrono_boost":
            self._apply_chrono_gate(own, legal)
            if name not in legal:
                return
        intent = self._pluto_action_context[ACTION_TO_INDEX[name]]
        if name in self._group_production_intents:
            await self._issue_production_group(name)
            return
        accepted = await execute_action(self, ACTION_TO_INDEX[name])
        self.action_counts[name] += 1
        if accepted:
            self._record_selection(name, intent.target)
            if name == "scout":
                self._selected_actions[len(self.fairplay.audit) - 1]["scout_source_type"] = intent.sources[0].type_id.name
        else:
            self.rejected_policy_actions[name] += 1

    async def on_end(self, game_result):
        await super().on_end(game_result)
        self.memory.observe(self, *screen_entities(self))
        self._report(force=True)
