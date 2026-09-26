"""Ordinary-resource native UI group mechanics fixture; never starts learning.

Creates a Zealot, Stalker and a second Nexus using eight starting workers.
The extra Nexus is a controls fixture, not a proposed expansion build.
Every input goes through the production FairPlayController and HumanClient.
Only current-screen entities, remembered own observations, public map geometry,
the HUD and controller-confirmed UI selection receipts inform this fixture.
"""
from __future__ import annotations

import argparse
import asyncio
from datetime import datetime, timezone
import hashlib
import json
import math
from pathlib import Path

import psutil
from sc2.bot_ai import BotAI
from sc2.data import Race, Result
from sc2.ids.ability_id import AbilityId as A
from sc2.ids.unit_typeid import UnitTypeId as U
from sc2.main import run_game
from sc2.player import Bot
from sc2.position import Point2

from pluto_sc2.fairplay import FairPlayController
from pluto_sc2.league_client import league_clients
from pluto_sc2.runner import ManagedSC2Process, resolve_map, validate_action_audit, write_json
from pluto_sc2.sc2_adapter import (
    _placement_width, _visible_footprint, execute_action, legal_action_mask, screen_entities,
)
from pluto_sc2.schema import ACTION_TO_INDEX


PURPOSE = "Native rectangle, F2, army/production control-group mechanics; no learning or strength claim"
SETUP = [("build_pylon", U.PYLON), ("build_gateway", U.GATEWAY),
         ("build_assimilator", U.ASSIMILATOR), ("build_cyberneticscore", U.CYBERNETICSCORE),
         ("train_zealot", U.ZEALOT), ("train_stalker", U.STALKER), ("build_nexus", U.NEXUS)]
ARMY_TYPES = {U.ZEALOT, U.STALKER}


def require(condition, message):
    if not condition:
        raise RuntimeError(message)


def point_values(value):
    """Point2 can contain NumPy scalars; never test its truth value."""
    return [float(x) for x in (value.position if hasattr(value, "position") else value)] if value is not None else None


def orders(unit):
    return [int(order.ability_id) for order in unit._proto.orders]


def selection_leaf(audit, index):
    """Follow the real paid portrait selection after a producer-group recall."""
    children = [i for i, event in enumerate(audit) if event.get("parent_selection_audit_index") == index
                and event.get("selection_mode") == "control_group_producer"]
    require(len(children) <= 1, "Producer recall has multiple child selections")
    return children[0] if children else index


def fixture_expansion_site(public_sites, home):
    """Static initial map-resource coordinates only; this does not test occupancy."""
    sites = [Point2(point) for point in public_sites if Point2(point).distance_to(home) >= 10]
    require(bool(sites), "No public expansion coordinate exists for the second Nexus fixture")
    return min(sites, key=lambda point: (point.distance_to(home), point.x, point.y))


def ui_panel_snapshot(observation):
    """Actual selected UI only; a SinglePanel is not assigned an invented queue."""
    panel = getattr(observation, "ui_data", None)
    kind = panel.WhichOneof("panel") if panel is not None else None
    result = {"panel": kind, "abilities": [int(item.ability_id) for item in observation.abilities],
              "unit": None, "build_queue_count": None, "production_queue_count": None}

    def unit_data(unit):
        return {"unit_type": int(unit.unit_type), "player_relative": int(unit.player_relative),
                "build_progress": float(unit.build_progress)}

    if kind in {"single", "production"}:
        result["unit"] = unit_data(getattr(panel, kind).unit)
    if kind == "multi":
        result["units"] = [unit_data(unit) for unit in panel.multi.units]
    if kind == "production":
        result.update(build_queue_count=len(panel.production.build_queue),
            production_queue_count=len(panel.production.production_queue),
            build_queue=[unit_data(unit) for unit in panel.production.build_queue],
            production_queue=[{"ability_id": int(item.ability_id), "build_progress": float(item.build_progress)}
                              for item in panel.production.production_queue])
    return result


def observed_probe_queue(snapshot):
    unit = snapshot.get("unit") or {}
    return (snapshot.get("panel") == "production" and unit.get("unit_type") == U.NEXUS.value
            and unit.get("player_relative") == 1
            and (any(row.get("unit_type") == U.PROBE.value for row in snapshot.get("build_queue", []))
                 or any(row.get("ability_id") == A.NEXUSTRAIN_PROBE.value
                        for row in snapshot.get("production_queue", []))))


def _event(audit, index, kind, mode=None):
    actions = audit.get("actions", [])
    require(type(index) is int and 0 <= index < len(actions), "Missing native audit event index")
    event = actions[index]
    require(event.get("kind") == kind and event.get("result") == [1], "Native input was not accepted")
    if mode is not None:
        require(event.get("selection_mode") == mode, f"Expected real UI selection mode {mode}")
    return event


def _selection(report, audit, name, mode):
    evidence = report.get("cases", {}).get(name, {})
    event = _event(audit, evidence.get("selection_index"), "selection", mode)
    require(event.get("selection_confirmation") == "confirmed"
            and event.get("command_confirmation") == "selection_only",
            f"Missing engine-confirmed selection-only receipt: {name}")
    require(evidence.get("selected_tags") == event.get("selected_tags")
            and bool(evidence.get("selected_tags"))
            and evidence.get("observation_loop", -1) >= event.get("command_loop", math.inf),
            f"Missing subsequent native selected members: {name}")
    return evidence, event


def verify_evidence(report, audit):
    """Fail closed on accepted-only clicks, empty groups or unobserved production."""
    require(report.get("starting_workers") == [8, 8], "Both players must start with exactly eight workers")
    require(report.get("engine_results") == ["Defeat", "Victory"]
            and report.get("concession_reason") == "verification_complete", "Missing paired normal concession")
    require(not report.get("bot_error"), "Diagnostic reported a bot error")
    require(report.get("debug_used") is False and report.get("learned_policy_used") is False
            and report.get("ppo_updates") == 0 and report.get("corpus_writes") is False,
            "Missing diagnostic isolation contract")
    rectangle, rectangle_input = _selection(report, audit, "mixed_rectangle", "rectangle")
    army_tags = set(rectangle["selected_tags"])
    require(len(army_tags) == 2 and set(rectangle.get("types", {}).values()) == {U.ZEALOT.value, U.STALKER.value},
            "Rectangle must actually select a Zealot and a Stalker")
    require(set(rectangle_input.get("source_tags", [])) == army_tags
            and isinstance(rectangle_input.get("selection_rectangle"), list), "Missing actual rectangle drag")
    f2, _ = _selection(report, audit, "army_f2", "army")
    require(set(f2["selected_tags"]) == army_tags, "F2 did not select both army members")
    prior_offscreen = set(f2.get("previously_seen_offscreen_tags", []))
    require(bool(prior_offscreen) and prior_offscreen.issubset(army_tags)
            and prior_offscreen.isdisjoint(f2.get("current_visible_tags", [])),
            "F2 did not include a previously seen offscreen army member")
    require(prior_offscreen.issubset(report.get("previously_seen_army_tags", [])),
            "Offscreen army identity lacks prior current-screen observation")
    army_set = _event(audit, report["cases"].get("army_set", {}).get("assignment_index"),
                      "selection", "control_group_set")
    require(army_set.get("control_group") == 1 and set(army_set.get("registered_tags", [])) == army_tags
            and army_set.get("selection_provenance_audit_index") == f2["selection_index"],
            "Army group was not saved from the actual F2 selection")
    deselect, _ = _selection(report, audit, "army_deselect", "point")
    recall, recall_input = _selection(report, audit, "army_recall", "control_group")
    require(set(deselect["selected_tags"]) < army_tags and set(recall["selected_tags"]) == army_tags
            and recall_input.get("control_group") == 1
            and f2["selection_index"] < deselect["selection_index"] < recall["selection_index"],
            "Group 1 did not preserve its members after deselection")
    movement = report["cases"].get("army_ground", {})
    army_command = _event(audit, movement.get("command_index"), "command")
    army_selection = _event(audit, army_command.get("selection_audit_index"), "selection", "control_group")
    require(army_command.get("ability") == A.ATTACK_ATTACK.value
            and army_command.get("minimap") is False and army_command.get("target_kind") == "ground"
            and army_command.get("ground_target_safety") == "current_visible_empty_screen"
            and army_command.get("control_group") == 1 and set(army_command.get("source_tags", [])) == army_tags
            and army_command.get("offscreen_selected_count", 0) >= 1
            and army_selection.get("source_tags") == [], "Missing real group command to visible guarded ground")
    tag = movement.get("previously_offscreen_tag")
    native = movement.get("native_order", {})
    require(tag in prior_offscreen and movement.get("last_seen_loop", math.inf) < army_command.get("game_loop", -1)
            and movement.get("native_order_loop", -1) > army_command.get("game_loop", math.inf)
            and native.get("ability_id") in {23, 3674} and not native.get("target_unit_tag")
            and native.get("target_world_position") is not None
            and math.dist(native["target_world_position"], army_command["effective_target"]) <= 6,
            "Formerly offscreen army member lacks a subsequently observed native point order")
    require(movement.get("friendly_order_seen") is False and movement.get("distance_moved", 0) >= 2
            and movement.get("distance_to_command", math.inf) <= 6
            and movement.get("arrival_loop", -1) >= movement.get("native_order_loop", math.inf),
            "Formerly offscreen army member did not visibly arrive safely")
    first, _ = _selection(report, audit, "nexus_first", "point")
    second, _ = _selection(report, audit, "nexus_second", "point")
    require(len(first["selected_tags"]) == len(second["selected_tags"]) == 1
            and first["selected_tags"] != second["selected_tags"]
            and set(first.get("types", {}).values()) == set(second.get("types", {}).values()) == {U.NEXUS.value},
            "Need two different current-screen Nexus selections")
    nexus_tags = set(first["selected_tags"] + second["selected_tags"])
    for name, mode, selected in (("nexus_set", "control_group_set", first),
                                 ("nexus_append", "control_group_append", second)):
        event = _event(audit, report["cases"].get(name, {}).get("assignment_index"), "selection", mode)
        require(event.get("control_group") == 2
                and event.get("selection_provenance_audit_index") == selected["selection_index"],
                "Nexus assignment lacks its actual on-screen selection")
        expected = set(first["selected_tags"]) if name == "nexus_set" else nexus_tags
        require(set(event.get("registered_tags", [])) == expected, "Nexus group append lost a producer")
    production = report["cases"].get("offscreen_production", {})
    commands = production.get("command_indices", [])
    require(len(commands) == 2, "Need two native offscreen Probe commands")
    for index in commands:
        command = _event(audit, index, "command")
        selection = _event(audit, command.get("selection_audit_index"), "selection", "control_group_producer")
        parent = _event(audit, selection.get("parent_selection_audit_index"), "selection", "control_group")
        detail = command.get("group_production", {})
        require(command.get("ability") == A.NEXUSTRAIN_PROBE.value and command.get("target") is None
                and selection.get("control_group") == 2 and len(selection.get("selected_tags", [])) == 1
                and set(selection.get("selected_tags", [])).issubset(nexus_tags)
                and set(parent.get("selected_tags", [])) == nexus_tags
                and parent.get("command_confirmation") == "production_subselection"
                and detail.get("group") == 2 and detail.get("kind") == "train"
                and A.NEXUSTRAIN_PROBE.value in detail.get("selection_ui_abilities", []),
                "Probe command lacks recalled Nexus membership and selected UI ability validation")
        queue = detail.get("queue_evidence", {})
        require(queue.get("source") in {"selected_production_panel", "selected_idle_single_panel"}
                and queue.get("producer_count") == 1
                and queue.get("producer_type") == U.NEXUS.value and queue.get("queue_item_count", math.inf) <= 1,
                "Probe command lacks an observed bounded selected production queue")
        require(command.get("diagnostic_visible_nexus_tags") == []
                and selection.get("diagnostic_visible_nexus_tags") == []
                and parent.get("diagnostic_visible_nexus_tags") == [],
                "Production was not offscreen at selection and command time")
    first_command = audit["actions"][commands[0]]
    before, after = first_command.get("diagnostic_ui_before", {}), production.get("first_observed_queue", {})
    owner = before.get("unit") or {}
    require(before.get("panel") in {"single", "production"} and owner.get("unit_type") == U.NEXUS.value
            and owner.get("player_relative") == 1 and A.NEXUSTRAIN_PROBE.value in before.get("abilities", [])
            and before.get("game_loop") == first_command.get("game_loop")
            and (before["panel"] == "single" or max(before.get("build_queue_count", 0),
                                                    before.get("production_queue_count", 0)) == 0),
            "First Probe order lacks an actual matching idle producer panel")
    require(observed_probe_queue(after) and after.get("selected_tags") == first_command.get("source_tags")
            and after.get("game_loop", -1) > first_command.get("game_loop", math.inf)
            and after.get("game_loop", math.inf) < audit["actions"][commands[1]]["game_loop"],
            "First idle producer did not visibly transition to an actual Probe production queue")
    require(production.get("workers_after", 0) - production.get("workers_before", math.inf) >= 2
            and production.get("worker_observation_loop", -1) > max(audit["actions"][i]["game_loop"] for i in commands)
            and production.get("no_other_probe_orders_during_measurement") is True,
            "Accepted commands did not produce two observed additional workers")
    start_loop = production.get("baseline_loop", math.inf)
    other_probes = [i for i, event in enumerate(audit["actions"]) if event.get("kind") == "command"
                    and event.get("ability") == A.NEXUSTRAIN_PROBE.value
                    and event.get("game_loop", -1) >= start_loop and i not in commands]
    require(not other_probes, "Additional Probe orders contaminate the production measurement")
    require(report.get("setup_probe_queues_empty") is True, "Setup Probe queues could contaminate HUD gain")
    validate_action_audit(audit)


class PassivePeer(BotAI):
    def __init__(self, report):
        super().__init__()
        self.report, self.result = report, None

    async def on_start(self):
        require(self.race == Race.Protoss and self.supply_workers == 8, "Invalid passive eight-worker start")
        self.report["starting_workers"][1] = 8
        self.client.game_step = 2

    async def on_step(self, iteration):
        pass

    async def on_end(self, result):
        self.result = result


class GroupControlsProbe(BotAI):
    def __init__(self, report, output, seconds):
        super().__init__()
        self.report, self.output, self.seconds = report, Path(output), seconds
        self.fairplay = FairPlayController(200)
        self.phase, self.phase_started = "setup", 0.0
        self.last_save, self.last_setup_check = -100.0, -100.0
        self.result, self.leaving = None, False
        self.home = None
        self.initial_nexus = None
        self.setup_done, self.setup_pending, self.setup_attempts = set(), None, {}
        self.army_seen, self.nexuses_seen = {}, {}
        self.operation = None
        self.stage_goal, self.travel_goal = None, None
        self.move_receipts = {}
        self.public_sites, self.nexus_task = [], None
        self.last_ui_key = None

    async def on_start(self):
        require(self.race == Race.Protoss and self.supply_workers == 8, "Invalid eight-worker fixture start")
        self.client.game_step = 2
        self.fairplay.reset(self.start_location)
        self.fairplay.sync_camera(self)
        self._pluto_last_army_position = self.start_location
        own, _ = screen_entities(self)
        nexus = next((unit for unit in own if unit.type_id == U.NEXUS), None)
        require(nexus is not None, "Initial Nexus is not currently visible")
        self.home, self.initial_nexus = nexus.position, int(nexus.tag)
        # Cache positions only, at initialization. Never query hidden occupancy,
        # enemy units or dynamic pathing to choose a fixture site.
        self.public_sites = [Point2(tuple(point)) for point in self.expansion_locations_list]
        self.report["starting_workers"][0] = 8
        self.save()

    def save(self):
        self.report.update(phase=self.phase, game_seconds=float(self.time) if getattr(self, "state", None) else 0)
        write_json(self.output / "verification.json", self.report)
        write_json(self.output / "audit.json", {"summary": self.fairplay.summary(), "actions": self.fairplay.audit})
        self.last_save = self.report["game_seconds"]

    def phase_to(self, phase):
        self.phase, self.phase_started = phase, float(self.time)
        self.save()

    async def concede(self, reason):
        if not self.leaving:
            self.leaving = True
            self.report["concession_reason"] = reason
            self.save()
            await self.client.leave()

    def remember(self, own):
        for unit in own:
            if unit.type_id in ARMY_TYPES:
                self.army_seen[int(unit.tag)] = {"position": point_values(unit.position),
                    "type_id": unit.type_id.value, "loop": int(self.state.game_loop)}
            elif unit.type_id == U.NEXUS:
                self.nexuses_seen[int(unit.tag)] = {"position": point_values(unit.position),
                    "ready": unit.is_ready, "loop": int(self.state.game_loop)}
        self.report["previously_seen_army_tags"] = sorted(self.army_seen)

    def record_production_ui(self, own):
        snapshot = ui_panel_snapshot(self.state.observation)
        # Global selected tags/alliance are explicit UI selection evidence;
        # no offscreen positions, orders, resources or live unit properties.
        selected = [row for row in self.state.observation_raw.units if row.is_selected]
        snapshot.update(game_loop=int(self.state.game_loop), game_seconds=float(self.time), phase=self.phase,
            camera=point_values(self.fairplay.camera_center), selected_tags=sorted(int(row.tag) for row in selected),
            selected_alliances=sorted({int(row.alliance) for row in selected}),
            visible_nexus_tags=[int(unit.tag) for unit in own if unit.type_id == U.NEXUS])
        unit = snapshot.get("unit") or {}
        key = (snapshot["panel"], unit.get("unit_type"), unit.get("player_relative"), tuple(snapshot["selected_tags"]),
               snapshot["build_queue_count"], snapshot["production_queue_count"], tuple(snapshot["abilities"]), self.phase)
        if key != self.last_ui_key:
            snapshots = self.report.setdefault("production_ui_observations", [])
            if len(snapshots) < 64:
                snapshots.append(snapshot)
            self.last_ui_key = key
        return snapshot

    async def begin_selection(self, name, sources, *, mode="point", group=None, ability=None, target=None):
        index = len(self.fairplay.audit)
        if await self.fairplay.issue(self, sources, ability, target, selection_mode=mode, control_group=group):
            self.operation = {"name": name, "selection_index": index, "issued": float(self.time),
                              "visible_tags": [int(unit.tag) for unit in screen_entities(self)[0]],
                              "ability": ability.value if ability is not None else None}
            self.fairplay.audit[index]["diagnostic_case"] = name
            if name == "offscreen_production":
                self.fairplay.audit[index]["diagnostic_visible_nexus_tags"] = [int(unit.tag)
                    for unit in screen_entities(self)[0] if unit.type_id == U.NEXUS]
            return True
        return False

    def finish_selection(self, own):
        if self.operation is None or self.fairplay.pending:
            return False
        op, self.operation = self.operation, None
        leaf = selection_leaf(self.fairplay.audit, op["selection_index"])
        selection = self.fairplay.audit[leaf]
        expected = "accepted" if op["ability"] is not None else "selection_only"
        if selection.get("command_confirmation") != expected:
            self.report.setdefault("selection_retries", []).append({**op,
                "confirmation": selection.get("command_confirmation")})
            return True  # Retry only after the controller's normal source cooldown.
        receipt = self.fairplay.confirmed_selection
        require(receipt is not None, "Selection completed without a native receipt")
        name = op["name"]
        evidence = {"selection_index": op["selection_index"], "observation_loop": int(self.state.game_loop),
                    "selected_tags": receipt["tags"], "types": {str(row["tag"]): row["type_id"]
                    for row in receipt["members"]}, "current_visible_tags": [int(unit.tag) for unit in own]}
        if name in {"offscreen_production", "army_ground"}:
            commands = [i for i, event in enumerate(self.fairplay.audit) if event.get("kind") == "command"
                        and event.get("selection_audit_index") == leaf]
            require(len(commands) == 1, "Selection did not produce exactly one native command")
            if name == "army_ground":
                self.report["cases"][name].update(command_index=commands[0], selection_index=leaf)
                self.phase_to("observe_army")
            else:
                self.report["cases"][name]["command_indices"].append(commands[0])
                if len(self.report["cases"][name]["command_indices"]) == 2:
                    self.phase_to("observe_production")
                else:
                    self.phase_to("observe_first_queue")
            return True
        if name == "army_f2":
            evidence["previously_seen_offscreen_tags"] = sorted(set(receipt["tags"]) - set(evidence["current_visible_tags"]))
        self.report["cases"][name] = evidence
        following = {"nexus_first": "nexus_set", "nexus_second": "nexus_append",
                     "mixed_rectangle": "separate_army", "army_f2": "army_set",
                     "army_deselect": "army_recall", "army_recall": "army_ground"}
        self.phase_to(following[name])
        return True

    async def store_group(self, name, index, next_phase, *, append=False):
        audit_index = len(self.fairplay.audit)
        if await self.fairplay.set_control_group(self, index, append=append):
            self.report["cases"][name] = {"assignment_index": audit_index,
                                          "receipt": self.fairplay.control_group_receipt(index)}
            self.phase_to(next_phase)

    async def setup(self, own):
        if self.time - self.last_setup_check < .6:
            return
        self.last_setup_check = float(self.time)
        self.report["setup_status"] = {"minerals": int(self.minerals), "vespene": int(self.vespene),
            "workers": int(self.supply_workers), "camera": point_values(self.fairplay.camera_center),
            "next_action": next((name for name, _ in SETUP if name not in self.setup_done), None),
            "pending": self.setup_pending, "nexus_task": getattr(self, "nexus_task", None)}
        pending = self.setup_pending
        if pending is not None:
            source = next((unit for unit in own if unit.tag == pending["source_tag"]), None)
            product = next((unit for unit in own if unit.type_id.value == pending["type_id"]
                            and unit.tag not in pending["prior_tags"]), None)
            queued = source is not None and bool(set(orders(source)).intersection(pending["ability_ids"]))
            confirmation = self.fairplay.audit[pending["audit_index"]].get("command_confirmation")
            if product is not None or (pending["name"].startswith("train_") and queued):
                self.setup_done.add(pending["name"])
                self.report.setdefault("setup_events", []).append({**pending, "time": float(self.time),
                    "event": "observed_product" if product is not None else "observed_queue",
                    "produced_tag": int(product.tag) if product is not None else None})
                self.setup_pending = None
            elif confirmation is not None and confirmation != "accepted":
                self.setup_pending = None
            elif self.time - pending["issued"] > 20 and source is not None and source.is_idle:
                require(self.setup_attempts[pending["name"]] < 4, "Repeated fixture setup failed without product")
                self.setup_pending = None
            else:
                require(self.time - pending["issued"] <= 70, "Fixture construction/queue was not observed in time")
        nexuses = [unit for unit in own if unit.type_id == U.NEXUS and unit.is_ready]
        if self.supply_workers == 12 and any(unit.tag == self.initial_nexus and unit.is_idle for unit in nexuses):
            # No further setup Probe inputs occur after the HUD reaches12.
            # The second Nexus is never given a setup train order.
            self.report["setup_probe_queues_empty"] = True
        if (all(name in self.setup_done for name, _ in SETUP)
                and {row["type_id"] for row in self.army_seen.values()} == {kind.value for kind in ARMY_TYPES}
                and any(unit.tag != self.initial_nexus and unit.is_idle for unit in nexuses)
                and self.supply_workers == 12 and self.report.get("setup_probe_queues_empty") is True
                and self.minerals >= 100 and self.setup_pending is None):
            self.report["setup_ready_loop"] = int(self.state.game_loop)
            self.phase_to("nexus_first")
            return
        if getattr(self, "nexus_task", None) is not None and self.setup_pending is None:
            await self.nexus_fixture_step(own)
            return
        mask = await legal_action_mask(self)
        reserved = self.setup_pending["source_tag"] if self.setup_pending is not None else None
        idle_gather = ACTION_TO_INDEX["harvest_minerals"]
        if mask[idle_gather]:
            intent = self._pluto_action_context[idle_gather]
            if all(unit.is_idle and unit.tag != reserved for unit in intent.sources):
                await execute_action(self, idle_gather)
                return
        if self.setup_pending is not None:
            return  # Never interrupt a pending builder with another order.
        gas = [unit for unit in own if unit.type_id == U.ASSIMILATOR and unit.is_ready]
        gas_index = ACTION_TO_INDEX["harvest_gas"]
        if self.vespene < 60 and gas and gas[0].assigned_harvesters < 2 and mask[gas_index]:
            await execute_action(self, gas_index)
            return
        probe_index = ACTION_TO_INDEX["train_probe"]
        choice = ("train_probe", U.PROBE) if self.supply_workers < 12 and mask[probe_index] else None
        if choice is None:
            choice = next(((name, kind) for name, kind in SETUP if name not in self.setup_done), None)
        if choice is not None and choice[0] == "build_nexus" and self.minerals >= 400:
            await self.nexus_fixture_step(own)
            return
        if choice is None or not mask[ACTION_TO_INDEX[choice[0]]]:
            return
        name, kind = choice
        index = ACTION_TO_INDEX[name]
        intent, audit_index = self._pluto_action_context[index], len(self.fairplay.audit)
        if await execute_action(self, index):
            public = self.game_data.abilities.get(intent.ability.value)
            self.setup_attempts[name] = self.setup_attempts.get(name, 0) + 1
            self.setup_pending = {"name": name, "type_id": kind.value, "audit_index": audit_index,
                "source_tag": int(intent.sources[0].tag), "issued": float(self.time),
                "target": point_values(intent.target), "prior_tags": [int(unit.tag) for unit in own if unit.type_id == kind],
                "ability_ids": sorted({intent.ability.value, public.id.value if public is not None else intent.ability.value})}

    async def nexus_fixture_step(self, own):
        """Travel to prior map geometry, then place only within fresh camera vision."""
        task = self.nexus_task
        if task is None:
            # Observe both actual army units before leaving their production
            # camera; their remembered locations guide a later paid return.
            if {row["type_id"] for row in self.army_seen.values()} != {kind.value for kind in ARMY_TYPES}:
                return
            require(self.report.get("setup_probe_queues_empty") is True,
                    "Initial Nexus queue must be observed empty before leaving setup")
            point = fixture_expansion_site(self.public_sites, self.home)
            workers = [unit for unit in own if unit.type_id == U.PROBE and unit.is_ready
                       and self.fairplay.source_available(unit, float(self.time))]
            require(bool(workers), "No current-screen Probe can travel to the fixture expansion")
            worker = min(workers, key=lambda unit: (unit.distance_to(point), unit.tag))
            index = len(self.fairplay.audit)
            if await self.fairplay.issue(self, [worker], A.MOVE_MOVE, point, minimap=True):
                self.nexus_task = {"position": point_values(point), "source_tag": int(worker.tag),
                    "started": float(self.time), "move_selection_index": index, "wait_reason": "move_confirmation"}
                self.report["fixture_expansion"] = self.nexus_task
            return
        point = Point2(task["position"])
        elapsed = self.time - task["started"]
        require(elapsed <= 130, "Second Nexus fixture exceeded its bounded travel/construction wait")
        nexus = next((unit for unit in own if unit.type_id == U.NEXUS and unit.distance_to(point) < 3), None)
        if nexus is not None:
            self.setup_done.add("build_nexus")
            task.update(wait_reason="nexus_observed_ready" if nexus.is_ready else "nexus_observed_constructing",
                        observed_nexus_tag=int(nexus.tag), observed_nexus_loop=int(self.state.game_loop))
            return
        confirmation = self.fairplay.audit[task["move_selection_index"]].get("command_confirmation")
        if confirmation is None:
            require(elapsed <= 15, "Fixture worker travel input was not confirmed")
            return
        require(confirmation == "accepted", f"Fixture worker travel failed: {confirmation}")
        if not self.fairplay.on_screen(point):
            task["wait_reason"] = "paid_site_camera"
            await self.fairplay.move_camera(self, point)
            return
        worker = next((unit for unit in own if unit.tag == task["source_tag"]), None)
        if worker is None:
            task["wait_reason"] = "builder_not_currently_visible"
            require(elapsed <= 45, "Fixture builder did not enter the site camera within45 seconds")
            return
        ability = A.PROTOSSBUILD_NEXUS
        visible = _visible_footprint(self, point, _placement_width(self, U.NEXUS))
        task.update(footprint_visible=visible, wait_reason="footprint_not_visible")
        if not visible:
            require(elapsed <= 45, "Fixture Nexus footprint did not become fully visible within45 seconds")
            return
        available = await self.get_available_abilities([worker], ignore_resource_requirements=False)
        public = self.game_data.abilities.get(ability.value)
        if ability not in available[0] and (public is None or public.id not in available[0]):
            task["wait_reason"] = "build_ability_unavailable"
            require(elapsed <= 55, "Fixture builder lacks a legal Nexus ability after travel")
            return
        legal = await self.can_place_single(ability, point)
        task.update(placement_legal=bool(legal), wait_reason="placement_rejected")
        require(legal, "Visible public expansion coordinate rejected native Nexus placement")
        index = len(self.fairplay.audit)
        if await self.fairplay.issue(self, [worker], ability, point):
            self.setup_attempts["build_nexus"] = self.setup_attempts.get("build_nexus", 0) + 1
            self.setup_pending = {"name": "build_nexus", "type_id": U.NEXUS.value, "audit_index": index,
                "source_tag": int(worker.tag), "issued": float(self.time), "target": point_values(point),
                "prior_tags": list(self.nexuses_seen),
                "ability_ids": sorted({ability.value, public.id.value if public is not None else ability.value})}
            task["wait_reason"] = "build_selection_pending"

    async def move_army_member(self, unit, destination):
        """Current-screen source and production guarded ground Attack; no raw Move."""
        previous = self.move_receipts.get(unit.tag)
        if previous is not None:
            selection = self.fairplay.audit[previous["selection_index"]]
            commands = [event for event in self.fairplay.audit if event.get("kind") == "command"
                        and event.get("selection_audit_index") == previous["selection_index"]]
            if commands and commands[0].get("result") == [1]:
                target = commands[0].get("effective_target")
                if target is not None and unit.distance_to(Point2(target)) > 1.5 and not unit.is_idle:
                    return False
                if self.time - previous["issued"] < 1:
                    return False
            elif selection.get("command_confirmation") is None:
                return False
        index = len(self.fairplay.audit)
        if await self.fairplay.issue(self, [unit], A.ATTACK, destination, minimap=True):
            self.move_receipts[unit.tag] = {"selection_index": index, "issued": float(self.time)}
            return True
        return False

    async def mechanics(self, own):
        army = sorted((unit for unit in own if unit.type_id in ARMY_TYPES), key=lambda unit: unit.tag)
        nexuses = sorted((unit for unit in own if unit.type_id == U.NEXUS and unit.is_ready), key=lambda unit: unit.tag)
        cases = self.report["cases"]
        if self.phase in {"nexus_first", "nexus_second"}:
            tag = self.initial_nexus if self.phase == "nexus_first" else next(tag for tag in self.nexuses_seen if tag != self.initial_nexus)
            source = next((unit for unit in nexuses if unit.tag == tag), None)
            if source is None:
                await self.fairplay.move_camera(self, Point2(self.nexuses_seen[tag]["position"]))
            else:
                await self.begin_selection(self.phase, [source])
        elif self.phase == "nexus_set":
            await self.store_group("nexus_set", 2, "nexus_second")
        elif self.phase == "nexus_append":
            await self.store_group("nexus_append", 2, "stage_army", append=True)
        elif self.phase == "stage_army":
            if len(army) != 2:
                target = next((row["position"] for tag, row in self.army_seen.items()
                               if tag not in {unit.tag for unit in army}), point_values(self.home))
                await self.fairplay.move_camera(self, Point2(target))
                return
            if self.stage_goal is None:
                self.stage_goal = self.home.towards(self.game_info.map_center, 7)
            if all(unit.distance_to(self.stage_goal) <= 3 for unit in army):
                self.phase_to("mixed_rectangle")
            else:
                member = max(army, key=lambda unit: unit.distance_to(self.stage_goal))
                await self.move_army_member(member, self.stage_goal)
        elif self.phase == "mixed_rectangle":
            require(len(army) == 2, "Mixed army left screen before rectangle test")
            await self.begin_selection("mixed_rectangle", army, mode="rectangle")
        elif self.phase == "separate_army":
            stalker = next((unit for unit in army if unit.type_id == U.STALKER), None)
            if stalker is None:
                target = next(row["position"] for row in self.army_seen.values() if row["type_id"] == U.STALKER.value)
                await self.fairplay.move_camera(self, Point2(target))
                return
            # Recenter a currently seen unit; no hidden positions are queried.
            if stalker.distance_to(self.fairplay.camera_center) > 2:
                await self.fairplay.move_camera(self, stalker.position)
                return
            if len(army) == 1 and not nexuses:
                self.phase_to("army_f2")
                return
            if self.travel_goal is None:
                self.travel_goal = self.home.towards(self.game_info.map_center, 30)
            await self.move_army_member(stalker, self.travel_goal)
        elif self.phase == "army_f2":
            require(bool(army), "No currently visible army anchor for F2")
            await self.begin_selection("army_f2", [army[0]], mode="army")
        elif self.phase == "army_set":
            await self.store_group("army_set", 1, "army_deselect")
        elif self.phase == "army_deselect":
            require(bool(army), "No currently visible army member for deselection")
            await self.begin_selection("army_deselect", [army[0]])
        elif self.phase == "army_recall":
            await self.begin_selection("army_recall", [], mode="control_group", group=1)
        elif self.phase == "army_ground":
            require(bool(army), "Group ground test requires a visible terrain anchor")
            tag = next((tag for tag in self.army_seen if tag not in {unit.tag for unit in army}), None)
            require(tag is not None, "Group ground test lost its offscreen member")
            seen = self.army_seen[tag]
            cases["army_ground"] = {"previously_offscreen_tag": tag, "last_seen_loop": seen["loop"],
                "last_seen_position": list(seen["position"]), "friendly_order_seen": False}
            target = self.fairplay.camera_center.towards(self.game_info.map_center, 3)
            await self.begin_selection("army_ground", [], mode="control_group", group=1,
                                       ability=A.ATTACK_ATTACK, target=target)
        elif self.phase == "offscreen_production":
            require(not nexuses, "Production test requires both Nexuses outside the current camera")
            if "offscreen_production" not in cases:
                cases["offscreen_production"] = {"workers_before": int(self.supply_workers),
                    "baseline_loop": int(self.state.game_loop), "command_indices": [],
                    "no_other_probe_orders_during_measurement": True}
            await self.begin_selection("offscreen_production", [], mode="control_group", group=2,
                                       ability=A.NEXUSTRAIN_PROBE)

    async def on_step(self, iteration):
        try:
            if self.leaving:
                return
            self.fairplay.sync_camera(self)
            own, _ = screen_entities(self)
            self.remember(own)
            if (self.output / "STOP").exists():
                await self.concede("stop_marker")
                return
            if self.time >= self.seconds - 2:
                await self.concede("verification_timeout")
                return
            if self.time - self.last_save >= 5:
                self.save()
            require(self.phase == "setup" or self.time - self.phase_started <= 65,
                    f"Mechanics phase {self.phase} exceeded its 65 second bound")
            before = len(self.fairplay.audit)
            ui_before = (self.record_production_ui(own) if self.phase in {
                "offscreen_production", "observe_first_queue", "observe_production"} else None)
            advanced = await self.fairplay.advance(self)
            for event in self.fairplay.audit[before:]:
                if self.operation is not None and self.operation["name"] == "offscreen_production":
                    event["diagnostic_visible_nexus_tags"] = [int(unit.tag) for unit in own if unit.type_id == U.NEXUS]
                    event["diagnostic_ui_before"] = ui_before
            if self.finish_selection(own):
                return
            if advanced or not self.fairplay.can_issue(float(self.time)):
                return
            if self.phase == "setup":
                await self.setup(own)
            elif self.phase == "observe_army":
                proof = self.report["cases"]["army_ground"]
                member = next((unit for unit in own if unit.tag == proof["previously_offscreen_tag"]), None)
                if member is not None:
                    command = self.fairplay.audit[proof["command_index"]]
                    for order in member._proto.orders:
                        require(not order.target_unit_tag, "Guarded group movement became a unit target")
                        if order.ability_id in {23, 3674} and order.HasField("target_world_space_pos"):
                            proof.update(native_order={"ability_id": int(order.ability_id), "target_unit_tag": None,
                                "target_world_position": [float(order.target_world_space_pos.x), float(order.target_world_space_pos.y)]},
                                native_order_loop=int(self.state.game_loop))
                    proof.update(distance_moved=float(member.distance_to(Point2(proof["last_seen_position"]))),
                        distance_to_command=float(member.distance_to(Point2(command["effective_target"]))),
                        arrival_loop=int(self.state.game_loop))
                    if ("native_order" in proof and proof["distance_moved"] >= 2 and proof["distance_to_command"] <= 6):
                        self.phase_to("offscreen_production")
            elif self.phase == "observe_first_queue":
                require(self.time - self.phase_started <= 5, "Accepted first Probe order never exposed a production queue")
                proof = self.report["cases"]["offscreen_production"]
                command = self.fairplay.audit[proof["command_indices"][0]]
                if observed_probe_queue(ui_before) and ui_before["selected_tags"] == command["source_tags"]:
                    proof["first_observed_queue"] = ui_before
                    self.phase_to("offscreen_production")
            elif self.phase == "observe_production":
                require(not any(unit.type_id == U.NEXUS for unit in own), "Camera returned to a Nexus during production proof")
                proof = self.report["cases"]["offscreen_production"]
                proof.update(workers_after=int(self.supply_workers), worker_observation_loop=int(self.state.game_loop))
                if proof["workers_after"] - proof["workers_before"] >= 2:
                    await self.concede("verification_complete")
            else:
                await self.mechanics(own)
        except Exception as error:
            self.report["bot_error"] = f"{type(error).__name__}: {error}"
            self.save()
            try:
                await asyncio.wait_for(self.concede("diagnostic_error"), timeout=5)
            except Exception as leave_error:
                self.report["error_concession_failure"] = f"{type(leave_error).__name__}: {leave_error}"
                self.save()
            raise

    async def on_end(self, result):
        self.result = result


def source_hashes():
    root = Path(__file__).resolve().parents[1]
    paths = [Path(__file__), *(root / "src/pluto_sc2" / name for name in
             ("fairplay.py", "target_geometry.py", "sc2_adapter.py", "league_client.py", "runner.py"))]
    return [{"path": str(path.resolve()), "sha256": hashlib.sha256(path.read_bytes()).hexdigest()} for path in paths]


def verify(output, map_name, seconds=450):
    require(type(seconds) in (float, int) and math.isfinite(seconds) and 120 <= seconds <= 550,
            "Verification must be bounded to 120..550 game seconds")
    require(not any((process.info["name"] or "").lower() == "sc2_x64.exe"
                    for process in psutil.process_iter(["name"])), "An SC2 client is already active")
    output = Path(output).resolve()
    require(not (output / "STOP").exists(), "Diagnostic STOP marker exists")
    output.mkdir(parents=True, exist_ok=False)
    process = psutil.Process()
    report = {"purpose": PURPOSE, "started_at": datetime.now(timezone.utc).isoformat(), "passed": False,
              "starting_workers": [None, None], "map": map_name, "max_game_seconds": seconds, "cases": {},
              "debug_used": False, "learned_policy_used": False, "ppo_updates": 0, "corpus_writes": False,
              "controller": "production FairPlayController", "sources": source_hashes(),
              "supervisor_pid": process.pid, "supervisor_created_at": process.create_time(),
              "placement_scope": "Second Nexus uses a public resource-site coordinate after a paid Probe/camera visit; controls fixture only"}
    probe, peer = GroupControlsProbe(report, output, seconds), PassivePeer(report)
    write_json(output / "verification.json", report)
    try:
        with league_clients():
            result = run_game(resolve_map(map_name), [Bot(Race.Protoss, probe, name="UI group verification"),
                Bot(Race.Protoss, peer, name="Passive UI group verification peer")], realtime=False,
                random_seed=98243, disable_fog=False, game_time_limit=seconds,
                save_replay_as=str(output / "game.SC2Replay"))
        report["engine_results"] = [item.name for item in result]
        require(probe.result == Result.Defeat and peer.result == Result.Victory, "Both native peers must finish")
        verify_evidence(report, {"summary": probe.fairplay.summary(), "actions": probe.fairplay.audit})
        replay = output / "game.SC2Replay"
        require(replay.is_file(), "Missing native verification replay")
        report["replay"] = {"path": str(replay), "sha256": hashlib.sha256(replay.read_bytes()).hexdigest()}
        report["passed"] = True
    except BaseException as error:
        report["error"] = f"{type(error).__name__}: {error}"
        raise
    finally:
        report["engine_lifecycle"] = list(ManagedSC2Process._lifecycle_events)
        report["finished_at"] = datetime.now(timezone.utc).isoformat()
        probe.save()
    return report


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--output", required=True)
    parser.add_argument("--map", required=True)
    parser.add_argument("--seconds", type=float, default=450)
    args = parser.parse_args()
    print(json.dumps(verify(args.output, args.map, args.seconds), indent=2))


if __name__ == "__main__":
    main()
