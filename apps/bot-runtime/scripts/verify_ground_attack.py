"""Isolated native minimap versus guarded screen attack diagnostic; no learning.

Build exactly one Zealot with normal eight-worker resources, then compare a
legacy minimap Attack(23) at our Nexus with production-guarded screen Attack(23),
four footprint-corner requests at distinct camera offsets, and forward movement. The
legacy case intentionally bypasses production target rewriting, but all inputs
still use real spatial selection, HumanClient, and FairPlayController's 200 APM
budget. A current-screen friendly attack is immediately stopped. This test-only
controller must never be installed in a learned or coached training game.
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
from google.protobuf.json_format import MessageToDict
from s2clientprotocol import spatial_pb2 as spatial
from sc2.bot_ai import BotAI
from sc2.data import Race, Result
from sc2.ids.ability_id import AbilityId as A
from sc2.ids.unit_typeid import UnitTypeId as U
from sc2.main import run_game
from sc2.player import Bot
from sc2.position import Point2

from pluto_sc2.fairplay import FairPlayController, MINIMAP_SIZE, SCREEN_SIZE
from pluto_sc2.league_client import league_clients
from pluto_sc2.runner import ManagedSC2Process, resolve_map, validate_action_audit, write_json
from pluto_sc2.sc2_adapter import execute_action, legal_action_mask, screen_entities
from pluto_sc2.schema import ACTION_TO_INDEX
from pluto_sc2.target_geometry import screen_pixel


PURPOSE = "Native isolated ground-attack semantics diagnostic; no learning or strength claim"
CORNER_DIRECTIONS = {"guarded_corner_ne": (1, 1), "guarded_corner_nw": (-1, 1),
                     "guarded_corner_se": (1, -1), "guarded_corner_sw": (-1, -1)}
CASES = {"legacy_nexus": 23, "guarded_nexus": 23,
         **{case: 23 for case in CORNER_DIRECTIONS}, "guarded_offscreen": 23}
PRIOR_LEGACY_REPORT = Path(__file__).resolve().parents[1] / "runs/ground-attack-verification-20260925-v4/verification.json"
ATTACK_IDS = {23, 24, 25, 3674}
SETUP_UNITS = {"build_pylon": U.PYLON, "build_gateway": U.GATEWAY, "train_zealot": U.ZEALOT}


def require(condition, message):
    if not condition:
        raise RuntimeError(message)


def case_sequence(guarded_only=False):
    return [case for case in CASES if not guarded_only or case != "legacy_nexus"]


def corner_geometry(case, nexus_position, half_width):
    """Request square-footprint corners that the old circular guard missed."""
    sx, sy = CORNER_DIRECTIONS[case]
    return (Point2(nexus_position).offset((sx * half_width * .9, sy * half_width * .9)),
            Point2(nexus_position).offset((sx * 3, sy * 2)))


def verify_evidence(report, audit):
    """Require native orders/movement, not just accepted input or guessed geometry."""
    require(report.get("starting_workers") == [8, 8], "Both starts must have eight workers")
    require(report.get("engine_results") == ["Defeat", "Victory"], "Missing native paired concession")
    require(report.get("concession_reason") == "verification_complete", "Diagnostic did not finish")
    require(not report.get("bot_error"), "Diagnostic bot reported an error")
    require(report.get("debug_used") is False and report.get("learned_policy_used") is False
            and report.get("ppo_updates") == 0 and report.get("corpus_writes") is False,
            "Diagnostic isolation contract missing")
    require(report.get("nexus_alive_at_end") is True, "Own Nexus did not survive")
    require(report.get("max_owned_zealots") == 1, "Expected exactly one ordinary-resource Zealot")
    public = report.get("public_abilities", {})
    require(public.get("23", {}).get("target") == "PointOrUnit", "Missing legacy PointOrUnit metadata")
    half_width, nexus_position = report.get("nexus_footprint_radius"), report.get("nexus_position")
    require(isinstance(half_width, (int, float)) and math.isfinite(half_width) and half_width > 0
            and isinstance(nexus_position, list) and len(nexus_position) == 2,
            "Missing observed/public Nexus footprint geometry")
    mode = report.get("mode", "full")
    require(mode in {"full", "guarded_only"}, "Unknown diagnostic verification mode")
    selected_cases = {case: ability for case, ability in CASES.items()
                      if mode == "full" or case != "legacy_nexus"}
    if mode == "guarded_only":
        require(report.get("legacy_reproduction_in_this_game") is False,
                "Guarded-only diagnostic cannot claim current-game legacy reproduction")
        require("legacy_nexus" not in report.get("cases", {}), "Unexpected legacy case in guarded-only diagnostic")
    commands = [row for row in audit["actions"] if row.get("kind") == "command"
                and row.get("diagnostic_case") in CASES]
    require(len(commands) == len(selected_cases), "Unexpected diagnostic command count for verification mode")
    cases = report.get("cases", {})
    for case, ability in selected_cases.items():
        events = [row for row in commands if row["diagnostic_case"] == case]
        require(len(events) == 1 and events[0].get("ability") == ability
                and events[0].get("result") == [1]
                and events[0].get("minimap") is (case == "legacy_nexus"),
                f"Missing accepted exact diagnostic command: {case}")
        command, evidence = events[0], cases.get(case, {})
        require(evidence.get("source_tag") in command.get("source_tags", [])
                and evidence.get("observation_loop", -1) > command.get("game_loop", math.inf),
                f"Missing subsequent source observation: {case}")
        stop_index = evidence.get("stop_selection_audit_index")
        stops = [row for row in audit["actions"] if row.get("kind") == "command"
                 and row.get("selection_audit_index") == stop_index
                 and row.get("ability") in {4, 3665} and row.get("result") == [1]
                 and row.get("source_tags") == command.get("source_tags")]
        require(type(stop_index) is int and len(stops) == 1
                and stops[0].get("game_loop", -1) > command.get("game_loop", math.inf)
                and evidence.get("stop_observation_loop", -1) > stops[0].get("game_loop", math.inf),
                f"Missing accepted STOP and subsequent order confirmation: {case}")
        order = evidence.get("order", {})
        if case == "legacy_nexus":
            require(order.get("target_unit_tag") == report.get("nexus_tag")
                    and order.get("ability_id") in ATTACK_IDS,
                    "Legacy friendly target was not reproduced; inspect evidence before changing conclusions")
            require(evidence.get("stop_confirmed") is True, "Legacy friendly attack was not stopped")
        else:
            require(not order.get("target_unit_tag") and order.get("target_world_position") is not None
                    and order.get("ability_id") in ATTACK_IDS,
                    f"Guarded command became a unit target or has no observed point order: {case}")
            point, emitted = order["target_world_position"], command.get("effective_target")
            require(isinstance(emitted, list) and len(emitted) == 2 and math.dist(point, emitted) <= .5,
                    f"Observed point order differs from emitted screen point: {case}")
            require(abs(emitted[0] - nexus_position[0]) > half_width
                    or abs(emitted[1] - nexus_position[1]) > half_width,
                    f"Guarded point remains inside own Nexus square footprint: {case}")
            require(command.get("ground_target_safety") == "current_visible_empty_screen"
                    and command.get("diagnostic_only_exact_ability") is False,
                    f"Guarded case did not use the production empty-screen guard: {case}")
            pixels = command.get("diagnostic_screen_evidence", {})
            require(all(pixels.get(layer) == value for layer, value in {
                "player_relative": 0, "unit_type": 0, "unit_density": 0,
                "visibility_map": 2, "pathable": 1}.items()),
                f"Missing current visible empty pathable screen pixel evidence: {case}")
            require(evidence.get("friendly_order_seen") is False, f"Friendly attack in guarded case: {case}")
            require(evidence.get("stop_confirmed") is True, f"Point case did not finish safely: {case}")
            if case in CORNER_DIRECTIONS:
                intended, camera_target = corner_geometry(case, nexus_position, half_width)
                require(evidence.get("target_was_offscreen") is False
                        and evidence.get("target") is not None
                        and math.dist(evidence["target"], intended) < .01
                        and command.get("intended_target") is not None
                        and math.dist(command["intended_target"], intended) < .01,
                        f"Corner case did not request the specified footprint corner: {case}")
                camera = evidence.get("prepared_camera", {})
                camera_index = camera.get("audit_index")
                require(camera.get("target") is not None and math.dist(camera["target"], camera_target) < .01,
                        f"Corner camera offset was not recorded: {case}")
                require(type(camera_index) is int and 0 <= camera_index < len(audit["actions"])
                        and audit["actions"][camera_index].get("kind") == "camera"
                        and audit["actions"][camera_index].get("result") == [1]
                        and audit["actions"][camera_index].get("destination") == camera["target"]
                        and audit["actions"][camera_index]["time"] < command["time"],
                        f"Corner camera offset lacks a preceding paid input: {case}")
    require(cases["guarded_offscreen"].get("target_was_offscreen") is True,
            "Off-screen point case did not exercise minimap advancement")
    require(cases["guarded_offscreen"].get("distance_advanced", 0) >= 2,
            "Guarded off-screen attack did not move the Zealot")
    require(cases["guarded_offscreen"].get("goal_distance_before", 0)
            - cases["guarded_offscreen"].get("goal_distance_after", math.inf) >= 1,
            "Guarded waypoint movement did not advance toward the intended destination")
    forward = next(row for row in commands if row["diagnostic_case"] == "guarded_offscreen")
    require(forward.get("ground_redirect_reason") == "offscreen_forward_waypoint",
            "Off-screen request did not become a production forward waypoint")
    require(len({tuple(next(row for row in commands if row["diagnostic_case"] == case)["camera"])
                 for case in CORNER_DIRECTIONS}) == 4,
            "Four corner cases did not exercise distinct observed camera positions")
    require(report.get("post_stop_stable_seconds", 0) >= 2, "No post-stop stability observation")
    validate_action_audit(audit)


class ProbeController(FairPlayController):
    """Explicit test-only emission of the requested historical ability ID.

    Ordinary setup, STOP, and both guarded cases use production fairplay. Only
    the legacy reproduction uses the deliberately unsafe historical minimap
    emission. No unsupported alternative attack abilities are attempted.
    """

    def __init__(self):
        super().__init__()
        self.diagnostic = None
        self.guarded_case = None
        self.used_cases = set()

    async def issue_probe(self, bot, source, case, target):
        require(case in CASES and case not in self.used_cases, "Unknown/repeated native diagnostic case")
        require(source.type_id == U.ZEALOT and source.is_mine and self.on_screen(source),
                "Diagnostic source must be our current-screen Zealot")
        selection_index = len(self.audit)
        # Legacy: select normally but preserve historical minimap emission.
        # Guarded cases: real production issue + advance including target guard.
        if not await self.issue(bot, [source], A(CASES[case]),
                                None if case == "legacy_nexus" else target,
                                minimap=case != "legacy_nexus"):
            return False
        if case == "legacy_nexus":
            self.diagnostic = dict(case=case, target=Point2(target))
        else:
            self.guarded_case = dict(case=case, selection_index=selection_index)
        self.used_cases.add(case)
        return True

    async def advance(self, bot):
        if self.diagnostic is None:
            result = await super().advance(bot)
            if self.guarded_case is not None and self._pending is None:
                case, index = self.guarded_case["case"], self.guarded_case["selection_index"]
                commands = [row for row in self.audit if row.get("kind") == "command"
                            and row.get("selection_audit_index") == index]
                require(len(commands) == 1, f"Production guarded command did not emit: {case}; "
                        f"{self.audit[index].get('command_confirmation')}")
                record = commands[0]
                require(record.get("result") == [1], f"Native engine rejected production guarded Attack: {case}")
                pixel = record.get("target_pixel")
                require(record.get("minimap") is False and isinstance(pixel, list) and len(pixel) == 2,
                        "Production guarded attack did not use a screen pixel")
                from s2clientprotocol.common_pb2 import PointI
                point = PointI(x=pixel[0], y=pixel[1])
                annotation = dict(diagnostic_case=case, diagnostic_only_exact_ability=False,
                    diagnostic_screen_evidence={layer: screen_pixel(bot, layer, point, SCREEN_SIZE)
                        for layer in ("player_relative", "unit_type", "unit_density", "visibility_map", "pathable")})
                record.update(annotation)
                self.audit[index].update(annotation)
                self.guarded_case = None
            return result
        self.sync_camera(bot)
        pending = self._pending
        require(pending is not None, "Diagnostic lost pending selection")
        if bot.state.game_loop <= pending.selection_loop or not self.budget.available(bot.time):
            return True
        own, _ = screen_entities(bot)
        selected = {unit.tag for unit in own if unit.is_selected}
        require(selected == set(pending.tags), "Diagnostic selection did not select only its requested Zealot")
        record = self.audit[pending.audit_index]
        record.update(selected_tags=sorted(selected), selection_confirmation="confirmed")
        target, case = self.diagnostic["target"], self.diagnostic["case"]
        pixel = self.minimap_point(bot, target)
        scale = MINIMAP_SIZE[0] / max(bot.game_info.map_size)
        effective = [(.5 + pixel.x) / scale, bot.game_info.map_size.y - (.5 + pixel.y) / scale]
        command = spatial.ActionSpatialUnitCommand(ability_id=CASES[case], queue_command=False,
                                                   target_minimap_coord=pixel)
        geometry = dict(target_kind="ground", intended_target=list(target), effective_target=effective,
                        unit_target_tag=None, requested_minimap=True, minimap=True,
                        ground_target_redirected=False, target_pixel=[pixel.x, pixel.y],
                        diagnostic_case=case, diagnostic_only_exact_ability=True)
        record.update(geometry)
        self._pending, self.diagnostic = None, None
        accepted = await self._send(bot, spatial.ActionSpatial(unit_command=command), "command",
                                   ability=CASES[case], target=list(target), **geometry,
                                   source_tags=list(pending.tags), selection_audit_index=pending.audit_index,
                                   game_loop=int(bot.state.game_loop))
        record.update(command_confirmation="accepted" if accepted else "engine_rejected",
                      command_loop=int(bot.state.game_loop))
        require(accepted, f"Native engine rejected diagnostic ability {CASES[case]} ({case})")
        return True


class PassivePeer(BotAI):
    def __init__(self, report):
        super().__init__()
        self.report, self.result = report, None

    async def on_start(self):
        require(self.race == Race.Protoss and len(self.workers) == 8, "Invalid passive eight-worker start")
        self.report["starting_workers"][1] = len(self.workers)
        self.client.game_step = 2

    async def on_step(self, iteration):
        pass

    async def on_end(self, result):
        self.result = result


def observed_orders(unit):
    """Current observed orders only; do not resolve unobserved target identities."""
    result = []
    for order in unit._proto.orders:
        point = ([order.target_world_space_pos.x, order.target_world_space_pos.y]
                 if order.HasField("target_world_space_pos") else None)
        result.append(dict(ability_id=int(order.ability_id), target_unit_tag=int(order.target_unit_tag) or None,
                           target_world_position=point))
    return result


class GroundAttackProbe(BotAI):
    def __init__(self, report, output, seconds, *, guarded_only=False):
        super().__init__()
        self.report, self.output, self.seconds = report, output, seconds
        self.guarded_only = guarded_only
        self.fairplay = ProbeController()
        self.phase = "setup"
        self.setup_submitted = None
        self.setup_done = set()
        self.setup_attempts = {}
        self.zealot_queue_seen_at = None
        self.case = None
        self.case_started = 0.0
        self.stop_index = None
        self.stop_started = None
        self.stable_start = None
        self.last_save = -100.0
        self.result = self.error = None
        self.zealot_tag = self.nexus_tag = None
        self.nexus_position = None
        self.case_origin = None
        self.leaving = False
        self.corner_cameras = {}

    async def on_start(self):
        require(self.race == Race.Protoss and len(self.workers) == 8, "Invalid diagnostic eight-worker start")
        self.client.game_step = 2
        self.fairplay.reset(self.start_location)
        self.fairplay.sync_camera(self)
        self._pluto_last_army_position = self.start_location
        own, _ = screen_entities(self)
        nexus = next((unit for unit in own if unit.type_id == U.NEXUS), None)
        require(nexus is not None, "Initial Nexus is not currently visible")
        self.nexus_tag, self.nexus_position = nexus.tag, nexus.position
        unit_data = self.game_data.units.get(U.NEXUS.value)
        footprint = getattr(unit_data, "footprint_radius", None)
        source = "public_creation_ability_footprint_radius"
        if not isinstance(footprint, (float, int)) or not math.isfinite(footprint) or footprint <= 0:
            footprint, source = nexus.radius, "currently_observed_nexus_radius_fallback"
        require(math.isfinite(footprint) and footprint > 0, "Missing positive Nexus footprint radius")
        self.report.update(starting_workers=[8, self.report["starting_workers"][1]],
                           nexus_tag=nexus.tag, nexus_position=list(nexus.position),
                           nexus_footprint_radius=float(footprint), nexus_footprint_source=source,
                           required_cases=case_sequence(self.guarded_only))
        for ability in (23, 24, 25, 3674):
            public = self.game_data.abilities.get(ability)
            if public is not None:
                self.report["public_abilities"][str(ability)] = MessageToDict(public._proto)
        require("23" in self.report["public_abilities"], "Current game lacks public normal Attack metadata")
        self.save()

    def save(self):
        self.report.update(phase=self.phase, game_seconds=float(self.time) if getattr(self, "state", None) else 0)
        write_json(self.output / "verification.json", self.report)
        write_json(self.output / "audit.json", dict(summary=self.fairplay.summary(), actions=self.fairplay.audit))
        self.last_save = self.report["game_seconds"]

    async def concede(self, reason):
        if self.leaving:
            return
        self.leaving = True
        self.report["concession_reason"] = reason
        self.save()
        await self.client.leave()

    async def setup(self, own):
        zealot = next((unit for unit in own if unit.type_id == U.ZEALOT and unit.is_ready), None)
        if zealot is not None:
            self.zealot_tag = zealot.tag
            self.phase = "start_guarded_nexus" if self.guarded_only else "start_legacy_nexus"
            return
        # An accepted spatial input can still be a worker walking toward its
        # construction site. Until the actual structure appears, never give
        # that builder a new gather/build order or call the construction done.
        for action, kind in SETUP_UNITS.items():
            if action.startswith("build_") and any(unit.type_id == kind for unit in own):
                self.setup_done.add(action)
        if self.setup_submitted is not None:
            pending = self.setup_submitted
            action, index, issued = pending["action"], pending["audit_index"], pending["issued"]
            confirmation = self.fairplay.audit[index].get("command_confirmation")
            source = next((unit for unit in own if unit.tag == pending["source_tag"]), None)
            orders = observed_orders(source) if source is not None else []
            produced = next((unit for unit in own if unit.type_id == SETUP_UNITS[action]
                             and (pending["target"] is None or unit.position.distance_to(
                                 Point2(pending["target"])) < 2)), None)
            queue_seen = (action == "train_zealot" and source is not None
                          and source.type_id == U.GATEWAY
                          and any(order["ability_id"] in pending["ability_ids"] for order in orders))
            self.report["setup_pending"] = {**pending, "confirmation": confirmation,
                                            "source_orders": orders, "queue_seen": queue_seen}
            if produced is not None or queue_seen:
                self.setup_done.add(action)
                self.report.setdefault("setup_events", []).append(dict(
                    action=action, event="observed_structure" if produced is not None else "observed_queue",
                    time=float(self.time), source_tag=pending["source_tag"],
                    produced_tag=produced.tag if produced is not None else None))
                if action == "train_zealot":
                    self.zealot_queue_seen_at = float(self.time)
                self.setup_submitted = None
            elif confirmation is not None and confirmation != "accepted":
                self.setup_submitted = None
                self.report.setdefault("setup_events", []).append(dict(
                    action=action, event="input_rejected", time=float(self.time), confirmation=confirmation))
            else:
                elapsed = self.time - issued
                if confirmation is None:
                    require(elapsed <= 15, "Setup selection/command was not confirmed")
                else:
                    # Retry only after observing that the original source has
                    # no order and the build location is currently visible.
                    # A travelling/busy builder remains reserved, with a hard
                    # timeout instead of an unbounded silently stuck game.
                    delay = 5 if action == "train_zealot" else 20
                    visible_target = pending["target"] is None or self.is_visible(Point2(pending["target"]))
                    if elapsed >= delay and source is not None and not orders and source.is_idle and visible_target:
                        require(self.setup_attempts.get(action, 0) < 3,
                                f"Setup {action} failed to create an observed structure/queue after three attempts")
                        self.report.setdefault("setup_events", []).append(dict(
                            action=action, event="retry_idle_source_without_product", time=float(self.time)))
                        self.setup_submitted = None
                    else:
                        require(elapsed <= 60, f"Setup {action} did not produce observed construction/queue within 60 seconds")
                if self.setup_submitted is not None:
                    return  # Includes gather: never interrupt the pending builder.
            if self.setup_submitted is None:
                self.report["setup_pending"] = None
        if self.zealot_queue_seen_at is not None:
            require(self.time - self.zealot_queue_seen_at <= 90,
                    "Observed Zealot queue produced no current-screen Zealot within 90 seconds")
        mask = await legal_action_mask(self)
        # Setup decisions use only current-screen entities and prior own inputs.
        for name in ("build_pylon", "build_gateway", "train_zealot"):
            if name in self.setup_done:
                continue
            index = ACTION_TO_INDEX[name]
            if mask[index]:
                audit_index = len(self.fairplay.audit)
                intent = self._pluto_action_context[index]
                if await execute_action(self, index):
                    ability = intent.ability.value
                    public = self.game_data.abilities.get(ability)
                    self.setup_attempts[name] = self.setup_attempts.get(name, 0) + 1
                    self.setup_submitted = dict(action=name, audit_index=audit_index, issued=float(self.time),
                        source_tag=int(intent.sources[0].tag),
                        target=[float(value) for value in intent.target] if intent.target is not None else None,
                        ability_ids=sorted({ability, public.id.value if public is not None else ability}))
                    self.report["setup_pending"] = dict(self.setup_submitted)
                    self.report.setdefault("setup_events", []).append(dict(
                        action=name, event="selection_submitted", time=float(self.time),
                        source_tag=int(intent.sources[0].tag), attempt=self.setup_attempts[name]))
                return
            break
        gather = ACTION_TO_INDEX["harvest_minerals"]
        if mask[gather] and all(unit.is_idle for unit in self._pluto_action_context[gather].sources):
            await execute_action(self, gather)

    async def start_case(self, own):
        case = self.phase.removeprefix("start_")
        zealot = next((unit for unit in own if unit.tag == self.zealot_tag), None)
        require(zealot is not None, "Diagnostic Zealot left current camera before selection")
        if case == "guarded_offscreen" and not getattr(self, "forward_camera_prepared", False):
            # Give the movement test enough visible ground for its >=2-tile
            # assertion. A source at the old camera edge legitimately receives
            # a shorter waypoint; that is not a failure to execute Attack.
            if self.fairplay.camera_would_move(self, zealot.position):
                if await self.fairplay.move_camera(self, zealot.position):
                    self.forward_camera_prepared = True
                    self.report["forward_test_camera"] = {"observed_source_tag": zealot.tag,
                        "position": list(zealot.position), "issued_game_seconds": float(self.time)}
                return
            self.forward_camera_prepared = True
        nexus = next((unit for unit in own if unit.tag == self.nexus_tag), None)
        require(nexus is not None, "Diagnostic Nexus is not currently visible")
        if case in CORNER_DIRECTIONS and case not in self.corner_cameras:
            _, camera_target = corner_geometry(case, nexus.position, self.report["nexus_footprint_radius"])
            require(self.fairplay.camera_would_move(self, camera_target),
                    f"Corner camera must exercise a distinct paid offset: {case}")
            index = len(self.fairplay.audit)
            if await self.fairplay.move_camera(self, camera_target):
                self.corner_cameras[case] = {"target": list(camera_target), "audit_index": index,
                    "issued_game_seconds": float(self.time), "observed_nexus_tag": nexus.tag}
            return  # Confirm the actual camera on the next ordinary observation.
        abilities = (await self.get_available_abilities([zealot], ignore_resource_requirements=False))[0]
        require(any(ability.value in {23, 3674} for ability in abilities),
                "Current Zealot does not advertise normal Attack")
        target = (self.start_location.towards(self.game_info.map_center, 20)
                  if case == "guarded_offscreen" else nexus.position)
        if case in CORNER_DIRECTIONS:
            target, _ = corner_geometry(case, nexus.position, self.report["nexus_footprint_radius"])
        self.report["cases"][case] = dict(source_tag=zealot.tag, source_position=list(zealot.position),
            target=list(target), target_was_offscreen=not self.fairplay.on_screen(target),
            available_ability_ids=[ability.value for ability in abilities], friendly_order_seen=False,
            stop_confirmed=False, nexus_health_before=nexus.health, nexus_shields_before=nexus.shield,
            goal_distance_before=float(zealot.distance_to(target)))
        if case in CORNER_DIRECTIONS:
            require(self.fairplay.on_screen(target), "Corner target left the current camera")
            self.report["cases"][case]["prepared_camera"] = self.corner_cameras[case]
        if await self.fairplay.issue_probe(self, zealot, case, target):
            self.case, self.case_started, self.case_origin = case, float(self.time), zealot.position
            self.stop_index, self.stop_started = None, None
            self.phase = "observe_case"

    async def stop_source(self, source):
        if self.stop_started is None:
            self.stop_started = float(self.time)
            self.report["cases"][self.case]["stop_started_game_seconds"] = self.stop_started
        self.phase = "stopping"
        require(self.time - self.stop_started < 10, "STOP could not be confirmed within 10 game seconds")
        if (self.fairplay.pending or not self.fairplay.can_issue(float(self.time))
                or not self.fairplay.source_available(source, float(self.time))):
            return False
        abilities = (await self.get_available_abilities([source], ignore_resource_requirements=False))[0]
        ability = next((value for value in (A.STOP_STOP, A.STOP) if value in abilities), None)
        require(ability is not None, "STOP unavailable for diagnostic Zealot")
        index = len(self.fairplay.audit)
        if await self.fairplay.issue(self, [source], ability, None):
            self.stop_index = index
            self.report["cases"][self.case]["stop_selection_audit_index"] = index
            self.report["cases"][self.case].setdefault("stop_attempts", []).append(dict(
                selection_audit_index=index, issued_game_seconds=float(self.time)))
            return True
        return False

    async def confirm_stop(self, own):
        """Retry a failed spatial selection within a strict, paced deadline."""
        require(self.stop_started is not None and self.time - self.stop_started < 10,
                "STOP could not be confirmed within 10 game seconds")
        case = self.report["cases"][self.case]
        source = next((unit for unit in own if unit.tag == self.zealot_tag), None)
        if source is None:
            case["stop_status"] = "waiting_for_current_screen_source"
            return False
        if self.stop_index is not None:
            record = self.fairplay.audit[self.stop_index]
            confirmation = record.get("command_confirmation")
            if confirmation is None:
                return False
            if confirmation == "accepted" and not any(
                    order["ability_id"] in ATTACK_IDS for order in observed_orders(source)):
                case["stop_status"] = "confirmed"
                return True
            case.setdefault("stop_retries", []).append(dict(
                selection_audit_index=self.stop_index, confirmation=confirmation,
                game_seconds=float(self.time), source_orders=observed_orders(source)))
            self.stop_index = None
        case["stop_status"] = "waiting_for_budget_or_source_cooldown"
        if await self.stop_source(source):
            case["stop_status"] = "retry_selection_pending"
        return False

    async def observe_case(self, own):
        source = next((unit for unit in own if unit.tag == self.zealot_tag), None)
        require(source is not None, "Diagnostic Zealot left camera before evidence was recorded")
        case = self.report["cases"][self.case]
        commands = [row for row in self.fairplay.audit if row.get("kind") == "command"
                    and row.get("diagnostic_case") == self.case]
        if not commands or self.state.game_loop <= commands[-1]["game_loop"]:
            return
        orders = observed_orders(source)
        attacks = [order for order in orders if order["ability_id"] in ATTACK_IDS]
        friendly_tags = {unit.tag for unit in own}
        friendly = [order for order in attacks if order["target_unit_tag"] in friendly_tags]
        case["distance_advanced"] = source.distance_to(self.case_origin)
        case["goal_distance_after"] = float(source.distance_to(Point2(case["target"])))
        if friendly:
            case.update(order=friendly[0], observation_loop=int(self.state.game_loop),
                        friendly_order_seen=True, observation_game_seconds=float(self.time))
            await self.stop_source(source)
            return
        if attacks and "order" not in case:
            case.update(order=attacks[0], observation_loop=int(self.state.game_loop),
                        observation_game_seconds=float(self.time))
        forward_progress = case["goal_distance_before"] - case["goal_distance_after"]
        if "order" in case and (self.case != "guarded_offscreen"
                                or (case["distance_advanced"] >= 2 and forward_progress >= 1)):
            await self.stop_source(source)
        elif self.time - self.case_started > 15:
            raise RuntimeError(f"No required observed order/movement within 15 seconds: {self.case}")

    async def on_step(self, iteration):
        try:
            if self.leaving:
                return
            self.fairplay.sync_camera(self)
            own, _ = screen_entities(self)
            # Global own counts are segregated validation evidence only. They
            # never select sources, destinations or production actions.
            self.report["max_owned_zealots"] = max(self.report["max_owned_zealots"],
                                                   len(self.units.of_type(U.ZEALOT)))
            self.report["nexus_alive_at_end"] = any(unit.tag == self.nexus_tag for unit in self.townhalls)
            if (self.output / "STOP").exists():
                await self.concede("stop_marker")
                return
            if self.time >= self.seconds - 2:
                await self.concede("verification_timeout")
                return
            if self.time - self.last_save >= 5:
                self.save()
            if self.phase == "stopping":
                require(self.stop_started is not None and self.time - self.stop_started < 10,
                        "STOP could not be confirmed within 10 game seconds")
            if await self.fairplay.advance(self):
                return
            if self.phase == "observe_case":
                await self.observe_case(own)
                return
            if self.phase == "stopping":
                if not await self.confirm_stop(own):
                    return
                self.report["cases"][self.case]["stop_confirmed"] = True
                self.report["cases"][self.case]["stop_observation_loop"] = int(self.state.game_loop)
                sequence = case_sequence(self.guarded_only)
                position = sequence.index(self.case)
                if position == len(sequence) - 1:
                    self.phase, self.stable_start = "stable", float(self.time)
                else:
                    self.phase = "start_" + sequence[position + 1]
                self.save()
                return
            if self.phase == "stable":
                source = next((unit for unit in own if unit.tag == self.zealot_tag), None)
                require(source is not None and not observed_orders(source), "Post-test Zealot is not safely stopped")
                self.report["post_stop_stable_seconds"] = float(self.time) - self.stable_start
                if self.report["post_stop_stable_seconds"] >= 2:
                    await self.concede("verification_complete")
                return
            if not self.fairplay.can_issue(float(self.time)):
                return
            if self.phase == "setup":
                await self.setup(own)
            elif self.phase.startswith("start_"):
                await self.start_case(own)
        except Exception as error:
            self.error = f"{type(error).__name__}: {error}"
            self.report["bot_error"] = self.error
            self.save()
            # A Python setup/verification failure otherwise strands the passive
            # participant at the shared step barrier until its socket timeout.
            # Concede normally when the transport still works, then preserve
            # the original exception and keep the diagnostic failed.
            try:
                await asyncio.wait_for(self.concede("diagnostic_error"), timeout=5)
            except Exception as leave_error:
                self.report["error_concession_failure"] = f"{type(leave_error).__name__}: {leave_error}"
                self.save()
            raise

    async def on_end(self, result):
        self.result = result


def prior_legacy_reference(path=PRIOR_LEGACY_REPORT):
    """Reference an earlier observed legacy case without claiming a passing run."""
    path = Path(path).resolve()
    if not path.is_file():
        return None
    raw = path.read_bytes()
    document = json.loads(raw.decode("utf-8"))
    case = document.get("cases", {}).get("legacy_nexus", {})
    require(case.get("friendly_order_seen") is True and case.get("stop_confirmed") is True
            and case.get("order", {}).get("target_unit_tag") == document.get("nexus_tag")
            and case.get("order", {}).get("ability_id") in ATTACK_IDS,
            "Earlier diagnostic does not report the expected legacy target and confirmed STOP")
    return dict(path=str(path), sha256=hashlib.sha256(raw).hexdigest(),
                legacy_case_observed=True, legacy_stop_confirmed=True,
                whole_prior_diagnostic_passed=document.get("passed") is True,
                prior_error=document.get("error"),
                scope="Separate historical evidence only; no legacy reproduction occurs in this guarded-only game")


def verify(output, map_name, seconds=540, *, guarded_only=False):
    require(type(seconds) in (int, float) and math.isfinite(seconds) and 120 <= seconds < 600,
            "Verification must be bounded to 120..<600 game seconds")
    require(not any((process.info["name"] or "").lower() == "sc2_x64.exe"
                    for process in psutil.process_iter(["name"])), "An SC2 client is already active")
    output = Path(output).resolve()
    require(not (output / "STOP").exists(), "Diagnostic STOP marker exists")
    output.mkdir(parents=True, exist_ok=False)
    report = dict(purpose=PURPOSE, started_at=datetime.now(timezone.utc).isoformat(), passed=False,
                  mode="guarded_only" if guarded_only else "full",
                  pass_scope="Six production guarded attacks including four footprint corners; legacy excluded" if guarded_only
                      else "Legacy reproduction plus six guarded attacks including four footprint corners",
                  legacy_reproduction_in_this_game=not guarded_only,
                  starting_workers=[None, None], max_game_seconds=seconds, map=map_name,
                  public_abilities={}, cases={}, max_owned_zealots=0, post_stop_stable_seconds=0,
                  debug_used=False, learned_policy_used=False, ppo_updates=0, corpus_writes=False,
                  diagnostic_legacy_target_override=not guarded_only)
    if guarded_only:
        report["prior_legacy_reference"] = prior_legacy_reference()
    probe, passive = GroundAttackProbe(report, output, seconds, guarded_only=guarded_only), PassivePeer(report)
    write_json(output / "verification.json", report)
    try:
        # Both explicit Protoss participants are constrained to HumanClient.
        with league_clients():
            result = run_game(resolve_map(map_name), [Bot(Race.Protoss, probe, name="Ground target verification"),
                Bot(Race.Protoss, passive, name="Passive target verification peer")], realtime=False,
                random_seed=98243, disable_fog=False, game_time_limit=seconds,
                save_replay_as=str(output / "game.SC2Replay"))
        report["engine_results"] = [item.name for item in result]
        require(probe.result == Result.Defeat and passive.result == Result.Victory,
                "Diagnostic peers did not both finish with native concession results")
        verify_evidence(report, dict(summary=probe.fairplay.summary(), actions=probe.fairplay.audit))
        require((output / "game.SC2Replay").is_file(), "Missing verification replay")
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
    parser.add_argument("--seconds", type=float, default=540)
    parser.add_argument("--guarded-only", action="store_true",
                        help="Run six production-guarded cases including four corners; omit the unsafe legacy attack")
    args = parser.parse_args()
    verify(args.output, args.map, args.seconds, guarded_only=args.guarded_only)


if __name__ == "__main__":
    main()
