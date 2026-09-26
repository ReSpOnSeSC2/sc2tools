"""Execute normalized intentions through the existing paid spatial controller.

This is an adapter, not a raw-action executor or a learned-policy update. Its
receipts distinguish accepted inputs from observed construction or game success.
"""

from __future__ import annotations

from copy import deepcopy
import math

from sc2.ids.ability_id import AbilityId
from sc2.position import Point2

from .fairplay import FairPlayController, _ability_ids
from .intent_decoder import identity_fields, intent_identity, plan_next
from .policy_intents import canonical_sha256, prediction_integrity_valid
from .rich_actions import _world_pixel
from .rich_intents import visible_point
from .sc2_adapter import screen_entities


class IntentRuntime:
    """One intent at a time; call step once with each current permitted frame.

    ``await step(bot, intent, frame)`` uses bot.fairplay, existing SC2 unit
    queries only for current on-screen actors, and actual controller receipts.
    The host must reserve ``protected_tags`` from economy/scout controllers
    while this adapter owns the pending intent. Archived replay tags must never
    be transplanted into a different game. Policy predictions must pass through
    policy_intents.prediction_to_intent using a live observation binding, and
    this runtime must be configured with that game's session_id. This adapter
    does not run model inference. First admission requires the intent's causal
    frame to be current.
    Omitting session_id retains the legacy observed-wire diagnostic interface;
    it must not be used to replay archived tags into a different live game.
    A policy-configured runtime rejects observed-wire intents altogether.
    No outside controller may
    advance or replace this adapter's pending command.
    """

    def __init__(self, *, max_game_seconds=60, max_camera_inputs=12, session_id=None):
        self.max_game_seconds = float(max_game_seconds)
        self.max_camera_inputs = int(max_camera_inputs)
        if session_id is not None and (not isinstance(session_id, str) or not session_id.strip()):
            raise ValueError("A nonempty live session_id is required")
        self.session_id = session_id
        if (
            not math.isfinite(self.max_game_seconds)
            or self.max_game_seconds <= 0
            or self.max_camera_inputs < 1
        ):
            raise ValueError("Finite positive runtime bounds required")
        self.intent = None
        self.confirmations = {}
        self.pending = None
        self.route_check = None
        self.started = None
        self.last_loop = None
        self.camera_inputs = 0
        self.events = []
        self.terminal = None

    @property
    def protected_tags(self):
        return set(self.intent.get("source_tags", [])) if self.intent and not self.terminal else set()

    def _record(self, bot, stage, **details):
        row = {"game_loop": int(bot.state.game_loop), "stage": stage, **details}
        self.events.append(row)
        return row

    def _cancel(self, bot, reason):
        if self.pending is not None:
            bot.fairplay.cancel_pending(reason)
            self.pending = None
        self.terminal = reason
        return self._record(bot, "deferred", reason=reason)

    async def _camera(self, bot, destination, *, purpose):
        if not bot.fairplay.camera_would_move(bot, Point2(destination)):
            return self._cancel(bot, "camera_already_at_requested_minimap_pixel")
        if self.camera_inputs >= self.max_camera_inputs:
            return self._cancel(bot, "intent_camera_limit")
        before = len(bot.fairplay.audit)
        accepted = await bot.fairplay.move_camera(bot, Point2(destination))
        if accepted:
            self.camera_inputs += 1
            key = "camera" if self.intent["kind"] == "camera_move" else "route_visit"
            self.confirmations[key] = {
                **identity_fields(self.intent),
                "confirmed_loop": int(bot.state.game_loop),
                "paid": True,
                "audit_index": before,
            }
        return self._record(
            bot, "camera_issued" if accepted else "wait", purpose=purpose, destination=list(destination)
        )

    @staticmethod
    def _units(bot):
        own, enemies = screen_entities(bot)
        resources = [
            u
            for u in (*getattr(bot, "mineral_field", ()), *getattr(bot, "vespene_geyser", ()))
            if bot.fairplay.on_screen(u) and not getattr(u, "is_snapshot", False)
        ]
        return {u.tag: u for u in own}, {u.tag: u for u in (*own, *enemies, *resources)}

    def _resolve(self, bot, frame, *, route=False):
        own, all_current = self._units(bot)
        tags = self.intent["source_tags"]
        if not tags or any(t not in own for t in tags):
            return None, None, "source_not_currently_visible"
        sources = [own[t] for t in tags]
        expected = {r["tag"]: r for r in self.intent.get("evidence", {}).get("source_evidence", [])}
        for source in sources:
            if (
                source.tag not in expected
                or expected[source.tag].get("type_name")
                != getattr(getattr(source, "type_id", None), "name", "").upper()
            ):
                return None, None, "source_type_no_longer_matches_bound_intent"
        label = self.intent.get("target")
        if label is None:
            return sources, None, None
        if route:
            value = label.get("point")
            if value is None:
                return None, None, "route_target_position_unavailable"
            return sources, Point2(value), None
        if label["kind"] == "unit":
            target = all_current.get(label["tag"])
            if target is None:
                return None, None, "target_not_currently_visible"
            expected = self.intent.get("evidence", {}).get("target_evidence") or {}
            if getattr(getattr(target, "_proto", None), "alliance", None) != expected.get("owner"):
                return None, None, "target_ownership_no_longer_matches_bound_intent"
            return sources, target, None
        if not visible_point(frame, label["point"]):
            return None, None, "ground_target_not_currently_visible"
        return sources, Point2(label["point"]), None

    async def _preflight(self, bot, frame, sources, target, ability, *, route=False):
        queried = await bot.get_available_abilities(sources, ignore_resource_requirements=False)
        ids = _ability_ids(bot, ability)
        if len(queried) != len(sources) or any(
            not ids.intersection({int(getattr(a, "value", a)) for a in values}) for values in queried
        ):
            return "ability_not_available_for_current_sources"
        ability_data = bot.game_data.abilities.get(ability)
        is_building = getattr(getattr(ability_data, "_proto", None), "is_building", False)
        if not route and ("fresh_placement_query" in self.intent["decoder_requirements"] or is_building):
            position = target.position if hasattr(target, "position") else target
            data = bot.game_data.abilities.get(ability)
            radius = getattr(getattr(data, "_proto", None), "footprint_radius", 0)
            if not isinstance(radius, (int, float)) or not math.isfinite(radius) or radius <= 0:
                return "public_footprint_unavailable"
            bounds = [
                _world_pixel(frame, [position.x + dx, position.y + dy])
                for dx in (-radius, radius)
                for dy in (-radius, radius)
            ]
            spatial = frame.get("spatial", {})
            size = spatial.get("screen_size", [])
            if len(size) != 2 or any(
                p is None or not all(0 <= x < s for x, s in zip(p, size)) for p in bounds
            ):
                return "construction_footprint_not_currently_visible"
            try:
                if any(
                    spatial["screen_visibility"][y][x] != 2
                    for y in range(
                        math.floor(min(p[1] for p in bounds)), math.ceil(max(p[1] for p in bounds)) + 1
                    )
                    for x in range(
                        math.floor(min(p[0] for p in bounds)), math.ceil(max(p[0] for p in bounds)) + 1
                    )
                ):
                    return "construction_footprint_not_currently_visible"
            except (KeyError, IndexError, TypeError):
                return "construction_footprint_not_currently_visible"
            if not await bot.can_place_single(AbilityId(ability), position):
                return "placement_not_currently_legal"
            self.confirmations["placement"] = {
                **identity_fields(self.intent),
                "checked_loop": frame["game_loop"],
                "target": deepcopy(self.intent["target"]),
                "valid": True,
            }
        return None

    def _check_route_order(self, bot):
        check = self.route_check
        if check is None:
            return None
        own, _ = self._units(bot)
        source = own.get(check["source_tags"][0])
        if source is not None:
            for order in getattr(getattr(source, "_proto", None), "orders", ()):
                if order.ability_id in _ability_ids(bot, 16) and order.HasField("target_world_space_pos"):
                    point = order.target_world_space_pos
                    if Point2((point.x, point.y)).distance_to(Point2(check["destination"])) <= 4:
                        self.confirmations["route"] = {**check, "point_order_confirmed": True}
                        self.route_check = None
                        return self._record(bot, "route_confirmed", source_tag=source.tag)
        if int(bot.state.game_loop) - check["confirmed_loop"] > 22:
            self.route_check = None
            return self._cancel(bot, "route_order_not_observed_as_ground_move")
        return self._record(bot, "wait", reason="awaiting_visible_route_point_order")

    async def step(self, bot, intent, frame):
        """Advance one bounded stage; returns an audit/status dictionary."""
        if not isinstance(bot.fairplay, FairPlayController) or bot.fairplay.budget.max_apm > 200:
            raise ValueError("Intent runtime requires the constrained 200 APM FairPlayController")
        bot.fairplay.sync_camera(bot)
        loop = int(bot.state.game_loop)
        if (
            frame.get("game_loop") != loop
            or not isinstance(frame.get("camera"), (list, tuple))
            or Point2(frame["camera"]).distance_to(bot.fairplay.camera_center) > 1e-4
        ):
            return self._cancel(bot, "runtime_frame_not_current")
        if intent_identity(intent) is None:
            return self._cancel(bot, "runtime_intent_identity_missing")
        if self.session_id is not None and intent.get("provenance") != "policy_prediction":
            return self._cancel(bot, "observed_wire_not_allowed_in_policy_session")
        is_new = self.intent is None or intent_identity(self.intent) != intent_identity(intent)
        if intent.get("provenance") == "policy_prediction":
            bound = intent.get("evidence", {}).get("observation_binding", {})
            if (not prediction_integrity_valid(intent) or self.session_id is None
                    or bound.get("session_id") != self.session_id
                    or intent.get("evidence", {}).get("session_id") != self.session_id
                    or bound.get("player_id") != frame.get("hud", {}).get("player_id")
                    or getattr(bot, "player_id", bound.get("player_id")) != bound.get("player_id")):
                return self._cancel(bot, "runtime_prediction_binding_invalid")
            if is_new and (bound.get("game_loop") != loop
                           or bound.get("frame_sha256") != canonical_sha256(frame)):
                return self._cancel(bot, "runtime_prediction_frame_changed")
        if self.last_loop == loop:
            return {"game_loop": loop, "stage": "wait", "reason": "already_processed_observation"}
        self.last_loop = loop
        if is_new:
            if self.pending is not None:
                return self._cancel(bot, "cannot_replace_pending_intent")
            if intent.get("evidence", {}).get("preceding_loop") != loop:
                return self._cancel(bot, "new_intent_not_bound_to_current_observation")
            self.intent, self.confirmations = deepcopy(intent), {}
            self.started, self.camera_inputs, self.terminal, self.route_check = float(bot.time), 0, None, None
        if self.terminal:
            return self._record(
                bot, "complete" if self.terminal == "accepted" else "deferred", reason=self.terminal
            )
        if intent.get("admitted") is not True or intent.get("queued"):
            return self._cancel(bot, "queued_or_unadmitted_intent_not_executable")
        if float(bot.time) - self.started > self.max_game_seconds:
            return self._cancel(bot, "intent_runtime_deadline")
        route_state = self._check_route_order(bot)
        if route_state is not None:
            return route_state
        if self.pending is not None:
            pending = self.pending
            sources, target, failure = self._resolve(bot, frame, route=pending["route"])
            if failure is None:
                failure = await self._preflight(
                    bot, frame, sources, target, pending["ability"], route=pending["route"]
                )
            if failure:
                return self._cancel(bot, failure)
            await bot.fairplay.advance(bot)
            entry = bot.fairplay.audit[pending["audit_index"]]
            confirmation = entry.get("command_confirmation")
            if confirmation is None:
                return self._record(bot, "wait", reason="controller_selection_or_pacing")
            self.pending = None
            if confirmation != "accepted":
                return self._cancel(bot, "controller_" + confirmation)
            actual = entry.get("command_source_tags", [])
            if set(actual) != set(self.intent["source_tags"]):
                return self._cancel(bot, "controller_command_sources_differ")
            receipt = {
                **identity_fields(self.intent),
                "confirmed_loop": loop,
                "source_tags": list(actual),
                "accepted": True,
                "selection_audit_index": pending["audit_index"],
            }
            if pending["route"]:
                self.route_check = {**receipt, "destination": list(target)}
                return self._record(bot, "route_input_accepted", receipt=deepcopy(receipt))
            self.confirmations["command"] = receipt
            self.terminal = "accepted"
            return self._record(bot, "complete", receipt=deepcopy(receipt), construction_observed=False)
        if bot.fairplay.pending:
            return self._record(bot, "wait", reason="controller_owned_by_other_task")
        decision = plan_next(self.intent, frame, confirmations=self.confirmations)
        stage, operation = decision["stage"], decision["operation"]
        if stage == "camera":
            return await self._camera(
                bot, operation["point"], purpose=operation.get("purpose", "intent_camera")
            )
        if stage in {"select", "placement_query", "command", "route_move"}:
            route = stage == "route_move" or operation.get("purpose") == "construction_worker_route"
            sources, target, failure = self._resolve(bot, frame, route=route)
            ability = 16 if route else self.intent["ability_id"]
            if failure is None:
                failure = await self._preflight(bot, frame, sources, target, ability, route=route)
            if failure == "construction_footprint_not_currently_visible" and sources:
                site = target.position if hasattr(target, "position") else target
                positions = [u.position for u in sources] + [site]
                center = [sum(p[i] for p in positions) / len(positions) for i in (0, 1)]
                return await self._camera(bot, center, purpose="construction_footprint_reframe")
            if failure:
                return self._cancel(bot, failure)
            before = len(bot.fairplay.audit)
            # issue already stages the paid selection and later command. Do not
            # select once here and accidentally pay/select a second time later.
            accepted = await bot.fairplay.issue(
                bot,
                sources,
                ability,
                target,
                minimap=route,
                selection_mode="point" if len(sources) == 1 else "rectangle",
            )
            if accepted:
                self.pending = {"audit_index": before, "ability": ability, "route": route}
            return self._record(
                bot, "selection_issued" if accepted else "wait", route=route, audit_index=before
            )
        if stage == "complete":
            self.terminal = "accepted"
        elif stage in {"deferred", "rejected"}:
            self.terminal = decision["reason"]
        return self._record(bot, stage, decision=decision)
