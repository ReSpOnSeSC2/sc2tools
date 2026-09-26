"""Camera-bound spatial input and a hard, game-time action budget.

The game receives real feature-layer selections/commands, never raw unit-tag
commands. This is a structured interface, not pixel recognition or a claim of
identical human perception. Every attempted selection, command and camera move
is charged, including attempts rejected by SC2. One command is emitted at a time.
"""

from __future__ import annotations

import math
import numbers
from collections import deque
from dataclasses import dataclass
from typing import Any

from s2clientprotocol import common_pb2 as common
from s2clientprotocol import sc2api_pb2 as api
from s2clientprotocol import spatial_pb2 as spatial
from s2clientprotocol import ui_pb2 as ui
from sc2.client import Client
from sc2.ids.ability_id import AbilityId
from sc2.ids.unit_typeid import UnitTypeId
from sc2.position import Point2

from .target_geometry import clear_enemy_target_pixel, clear_ground_pixel, resolve_ground_attack, screen_pixel, visible_screen_units

MAX_APM = 200
CAMERA_WIDTH = 24.0
SCREEN_SIZE = (128, 72)
MINIMAP_SIZE = (64, 64)
SELECTION_RETRY_SECONDS = 8.0
MAX_SELECTION_FAILURES = 256
CAMERA_HEIGHT = CAMERA_WIDTH * SCREEN_SIZE[1] / SCREEN_SIZE[0]
FEATURE_CAMERA_SIZE = min(CAMERA_WIDTH, CAMERA_HEIGHT)
FAIRPLAY_VERSION = "spatial-200apm-v1"
_SPATIAL_GATE = object()
_ATTACK_IDS = {AbilityId.ATTACK.value, AbilityId.ATTACK_ATTACK.value,
               AbilityId.ATTACK_ATTACKTOWARDS.value, AbilityId.ATTACK_ATTACKBARRAGE.value}
_MOVE_IDS = {AbilityId.MOVE.value, AbilityId.MOVE_MOVE.value}
_WORKER_TYPES = {UnitTypeId.PROBE.value, UnitTypeId.SCV.value, UnitTypeId.DRONE.value, UnitTypeId.MULE.value}
_PROTOSS_ARMY_TYPES = {getattr(UnitTypeId, name).value for name in (
    "ZEALOT", "STALKER", "SENTRY", "ADEPT", "HIGHTEMPLAR", "DARKTEMPLAR", "ARCHON", "IMMORTAL",
    "COLOSSUS", "DISRUPTOR", "OBSERVER", "OBSERVERSIEGEMODE", "WARPPRISM", "WARPPRISMPHASING",
    "PHOENIX", "ORACLE", "VOIDRAY", "TEMPEST", "CARRIER", "MOTHERSHIP")}


def _ability_ids(bot, ability):
    data = getattr(getattr(bot, "game_data", None), "abilities", {}).get(ability)
    canonical = getattr(getattr(data, "id", None), "value", None)
    return {ability, canonical}


def _minimap_ground_allowed(bot, ability):
    if not _ability_ids(bot, ability).intersection(_ATTACK_IDS | _MOVE_IDS):
        return False
    data = getattr(getattr(bot, "game_data", None), "abilities", {}).get(ability)
    proto = getattr(data, "_proto", None)
    if proto is not None:
        present = (proto.HasField("allow_minimap") if hasattr(proto, "HasField")
                   else hasattr(proto, "allow_minimap"))
        if present:
            return bool(proto.allow_minimap)
    # Public normal Move/Attack commands support both screen and minimap.
    return True


def configure_interface(options: Any) -> None:
    options.raw = True
    options.score = True
    options.show_cloaked = False
    options.show_burrowed_shadows = False
    options.show_placeholders = False
    options.raw_affects_selection = False
    options.raw_crop_to_playable_area = False
    options.feature_layer.crop_to_playable_area = False
    options.feature_layer.allow_cheating_layers = False
    # Blizzard's ConvertWorldToCamera uses width / min(image_width,image_height)
    # as pixel size, despite the protocol field name. The short side must be
    # 13.5 to obtain a 24 by 13.5 world-unit viewport at 128 by 72 pixels.
    # https://github.com/Blizzard/s2client-api/blob/master/tests/feature_layers_shared.cc
    options.feature_layer.width = FEATURE_CAMERA_SIZE
    options.feature_layer.resolution.x, options.feature_layer.resolution.y = SCREEN_SIZE
    options.feature_layer.minimap_resolution.x, options.feature_layer.minimap_resolution.y = MINIMAP_SIZE


class HumanClient(Client):
    """Enable spatial observations and reject accidental raw-command bypasses."""

    async def _execute(self, *, _fairplay_token=None, **kwargs):
        if any(kind in kwargs for kind in ("debug", "map_command", "quick_load")):
            raise RuntimeError("Game-state debug and map-command bypasses are disabled")
        for kind in ("create_game", "start_replay", "observation"):
            if kind in kwargs and kwargs[kind].disable_fog:
                raise RuntimeError("Disabling fog of war is forbidden")
        for kind in ("join_game", "start_replay"):
            if kind in kwargs:
                configure_interface(kwargs[kind].options)
        request = kwargs.get("action")
        if request is not None and request.actions:
            for action in request.actions:
                if action.HasField("action_raw"):
                    raise RuntimeError("Raw actions are disabled; use the spatial fair-play controller")
            if _fairplay_token is not _SPATIAL_GATE:
                raise RuntimeError("Actions must pass through the paced spatial fair-play controller")
            if len(request.actions) != 1:
                raise RuntimeError("Only one spatial input is permitted per request")
            action = request.actions[0]
            fields = {field.name for field, _ in action.ListFields()}
            if fields == {"action_ui"}:
                selected = action.action_ui.WhichOneof("action")
                if selected == "select_army" and not action.action_ui.select_army.selection_add:
                    pass
                elif (selected == "control_group"
                      and action.action_ui.control_group.action in {ui.ActionControlGroup.Recall,
                          ui.ActionControlGroup.Set, ui.ActionControlGroup.Append}
                      and 0 <= action.action_ui.control_group.control_group_index <= 9):
                    pass
                elif (selected == "multi_panel"
                      and action.action_ui.multi_panel.type == ui.ActionMultiPanel.SingleSelect
                      and action.action_ui.multi_panel.unit_index >= 0):
                    pass
                else:
                    raise RuntimeError("Only paced army/control-group/producer UI selections are permitted")
            elif fields != {"action_feature_layer"}:
                raise RuntimeError("Only feature-layer spatial or approved selection inputs are permitted")
            elif action.action_feature_layer.WhichOneof("action") is None:
                raise RuntimeError("An empty spatial action is not permitted")
        return await super()._execute(**kwargs)


class ActionBudget:
    """At most 200 events in (t-60,t], with at least 0.3 seconds between events.

    Budget is measured in SC2 game seconds (22.4 loops per second), including
    non-realtime training. No accumulated credits or opening bursts are allowed.
    """

    def __init__(self, max_apm: int = MAX_APM):
        if isinstance(max_apm, bool) or not isinstance(max_apm, numbers.Integral) or not 1 <= max_apm <= MAX_APM:
            raise ValueError("max_apm must be an integer between 1 and 200")
        self.max_apm = int(max_apm)
        self.interval = 60.0 / self.max_apm
        self.events: deque[float] = deque()
        self.last = -math.inf
        self.last_observed = -math.inf
        self.peak = 0
        self.total = 0

    def available(self, now: float) -> bool:
        if isinstance(now, bool) or not isinstance(now, numbers.Real) or not math.isfinite(now) or now < 0:
            raise ValueError("Action timestamp must be finite and nonnegative")
        if now < self.last_observed - 1e-9:
            raise ValueError("Game time moved backwards")
        self.last_observed = now
        while self.events and self.events[0] <= now - 60.0:
            self.events.popleft()
        return len(self.events) < self.max_apm and now - self.last >= self.interval - 1e-9

    def consume(self, now: float) -> bool:
        if not self.available(now):
            return False
        self.events.append(now)
        self.last = now
        self.total += 1
        self.peak = max(self.peak, len(self.events))
        return True


def _point(value: Any) -> Point2:
    if hasattr(value, "position"):
        return value.position.to2
    if hasattr(value, "x"):
        return Point2((value.x, value.y))
    return Point2(value)


@dataclass
class PendingCommand:
    tags: tuple[int, ...]
    ability: int | None
    target: Point2 | None
    target_tag: int | None
    minimap: bool
    selection_loop: int
    audit_index: int
    selection_mode: str = "point"
    control_group: int | None = None
    permitted_tags: tuple[int, ...] = ()


class FairPlayController:
    def __init__(self, max_apm: int = MAX_APM, camera_center: Any = (0, 0)):
        self.budget = ActionBudget(max_apm)
        self.camera_center = _point(camera_center)
        self._pending: PendingCommand | None = None
        self.audit: list[dict] = []
        self.rejected = 0
        self._selection_failures: dict[int, float] = {}
        self.last_target_rejection = None
        self._confirmed_selection = None
        self._control_groups: dict[int, dict] = {}
        self._production_ui_cursor: dict[int, int] = {}

    @property
    def pending(self) -> bool:
        return self._pending is not None

    def reset(self, camera_center: Any) -> None:
        self.camera_center = _point(camera_center)
        self.budget = ActionBudget(self.budget.max_apm)
        self._pending = None
        self.audit.clear()
        self.rejected = 0
        self._selection_failures.clear()
        self.last_target_rejection = None
        self._confirmed_selection = None
        self._control_groups.clear()
        self._production_ui_cursor.clear()

    @property
    def confirmed_selection(self):
        from copy import deepcopy
        return deepcopy(self._confirmed_selection)

    def control_group_receipt(self, index):
        from copy import deepcopy
        return deepcopy(self._control_groups.get(index))

    @staticmethod
    def _group_index(index):
        if type(index) is not int or not 0 <= index <= 9:
            raise ValueError("Control group index must be an integer from 0 to 9")
        return index

    async def set_control_group(self, bot, index, *, append=False):
        """Set/append only the engine-confirmed selection established here."""
        self._group_index(index)
        if type(append) is not bool:
            raise ValueError("append must be boolean")
        if not self.can_issue(bot.time) or self._confirmed_selection is None:
            return False
        receipt = self._confirmed_selection
        selected_rows = [row for row in bot.state.observation_raw.units if row.is_selected]
        selected = {row.tag for row in selected_rows}
        if selected != set(receipt["tags"]) or any(row.alliance != 1 for row in selected_rows):
            return False
        previous = self._control_groups.get(index) if append else None
        if append and previous is None:
            return False  # An unknown engine group may already contain unregistered members.
        members = {row["tag"]: dict(row) for row in (previous or {}).get("members", [])}
        members.update({row["tag"]: dict(row) for row in receipt["members"]})
        visible = [unit for unit in visible_screen_units(bot, self) if unit.tag in selected and unit.is_mine]
        mode = "control_group_append" if append else "control_group_set"
        accepted = await self._send(bot, ui.ActionUI(control_group=ui.ActionControlGroup(
            action=ui.ActionControlGroup.Append if append else ui.ActionControlGroup.Set,
            control_group_index=index)), "selection", selection_mode=mode, control_group=index,
            source_tags=[unit.tag for unit in visible], source_positions=[list(unit.position) for unit in visible],
            registered_tags=sorted(members), selected_tags=sorted(selected),
            selection_provenance_audit_index=receipt["audit_index"],
            prior_group_tags=list((previous or {}).get("tags", [])))
        if accepted:
            self._control_groups[index] = {"tags": sorted(members), "members": list(members.values()),
                                            "assignment_audit_index": len(self.audit) - 1,
                                            "selection_audit_index": receipt["audit_index"]}
        return accepted

    def _group_production_allowed(self, bot, pending, selected, *, require_queue=True):
        """Selected UI + public prices, never off-screen producer properties."""
        group = self._control_groups.get(pending.control_group)
        members = {row["tag"]: row for row in (group or {}).get("members", [])}
        rows = [members.get(tag, {}) for tag in selected]
        if (not rows or not all(row.get("is_structure") for row in rows)
                or len({row.get("type_id") for row in rows}) != 1):
            return None
        observation = getattr(bot.state, "observation", None)
        available = {row.ability_id for row in getattr(observation, "abilities", ())}
        ids = _ability_ids(bot, pending.ability) - {None}
        if not ids.intersection(available):
            return None
        public = getattr(bot.game_data, "abilities", {}).get(pending.ability)
        if getattr(getattr(public, "_proto", None), "target", None) != 1:
            return None  # A targeted warp-in, spell or construction is not queue production.
        candidates = []
        for unit in getattr(bot.game_data, "units", {}).values():
            proto = getattr(unit, "_proto", None)
            if (proto is not None and 8 not in proto.attributes and proto.ability_id
                    and ids.intersection(_ability_ids(bot, proto.ability_id))):
                candidates.append(("train", proto.mineral_cost, proto.vespene_cost, proto.food_required))
        for upgrade in getattr(bot.game_data, "upgrades", {}).values():
            proto = getattr(upgrade, "_proto", None)
            if (proto is not None and proto.ability_id
                    and ids.intersection(_ability_ids(bot, proto.ability_id))):
                candidates.append(("research", proto.mineral_cost, proto.vespene_cost, 0))
        hud = getattr(observation, "player_common", None)
        if not candidates or hud is None:
            return None
        for kind, minerals, gas, supply in candidates:
            if hud.minerals >= minerals and hud.vespene >= gas and hud.food_cap - hud.food_used >= supply:
                queue = self._selected_production_queue(observation, rows[0]["type_id"], len(selected))
                if require_queue and (queue is None or queue["queue_item_count"] > (1 if kind == "train" else 0)):
                    return None
                return {"kind": kind, "group": pending.control_group,
                        "selection_ui_abilities": sorted(available), "mineral_cost": minerals,
                        "vespene_cost": gas, "supply_cost": supply,
                        "queue_evidence": queue,
                        "ui_panel": self._production_panel_observation(observation),
                        "group_assignment_audit_index": group["assignment_audit_index"]}
        return None

    @staticmethod
    def _production_panel_observation(observation):
        """Record the actual UI variant; absence is never encoded as an empty queue."""
        panel = getattr(observation, "ui_data", None)
        kind = panel.WhichOneof("panel") if panel is not None else None
        evidence = {"panel_kind": kind, "unit_type": None, "player_relative": None,
                    "build_progress": None, "build_queue_count": None, "production_queue_count": None}
        if kind in {"single", "production", "cargo"}:
            unit = getattr(panel, kind).unit
            evidence.update(unit_type=int(unit.unit_type), player_relative=int(unit.player_relative),
                            build_progress=float(unit.build_progress))
        if kind == "multi":
            evidence["unit_cards"] = [{"unit_type": int(unit.unit_type), "player_relative": int(unit.player_relative)}
                                      for unit in panel.multi.units]
        if kind == "production":
            evidence.update(build_queue_count=len(panel.production.build_queue),
                            production_queue_count=len(panel.production.production_queue))
        return evidence

    @staticmethod
    def _selected_production_queue(observation, producer_type, selected_count):
        # The multi-selection panel contains unit cards but no producer queues.
        # Both production lists can describe the same queue, so never sum them.
        panel = getattr(observation, "ui_data", None)
        kind = panel.WhichOneof("panel") if panel is not None else None
        if selected_count != 1 or kind not in {"single", "production"}:
            return None
        unit = getattr(panel, kind).unit
        if unit.player_relative != 1 or unit.unit_type != producer_type:
            return None
        # Explicit SinglePanel is the idle UI variant for a selected producer.
        # This is used only after registered-own-structure, available production
        # ability and public-cost checks. Missing/other panels are not idle.
        # Native validation separately proves this single -> production transition.
        build_count, production_count = ((len(panel.production.build_queue), len(panel.production.production_queue))
                                         if kind == "production" else (0, 0))
        return {"source": "selected_production_panel" if kind == "production" else "selected_idle_single_panel",
                "panel_kind": kind, "player_relative": int(unit.player_relative), "producer_count": 1,
                "producer_type": producer_type, "build_queue_count": build_count,
                "production_queue_count": production_count,
                "queue_item_count": max(build_count, production_count)}

    async def _select_group_producer(self, bot, pending, selected, current_sources):
        """Pay for a current UI portrait click to expose one real producer queue."""
        observation = getattr(bot.state, "observation", None)
        panel = getattr(observation, "ui_data", None)
        group = self._control_groups[pending.control_group]
        members = {row["tag"]: row for row in group["members"]}
        expected_type = members[next(iter(selected))]["type_id"]
        if (panel is None or panel.WhichOneof("panel") != "multi"
                or len(panel.multi.units) != len(selected)
                or any(card.player_relative != 1 or card.unit_type != expected_type for card in panel.multi.units)):
            return False
        index = self._production_ui_cursor.get(pending.control_group, 0) % len(panel.multi.units)
        accepted = await self._send(bot, ui.ActionUI(multi_panel=ui.ActionMultiPanel(
            type=ui.ActionMultiPanel.SingleSelect, unit_index=index)), "selection",
            selection_mode="control_group_producer", control_group=pending.control_group,
            registered_tags=group["tags"], group_assignment_audit_index=group["assignment_audit_index"],
            parent_selection_audit_index=pending.audit_index, parent_selected_tags=sorted(selected),
            production_ui_index=index, production_ui_unit_type=expected_type,
            source_tags=[unit.tag for unit in current_sources], source_positions=[list(unit.position) for unit in current_sources],
            ability=pending.ability, target_kind="none", intended_target=None, unit_target_tag=None,
            requested_minimap=False)
        record = self.audit[pending.audit_index]
        record.update(command_source_tags=sorted(selected), command_loop=int(bot.state.game_loop),
                      command_confirmation="production_subselection" if accepted else "production_subselection_rejected")
        self._confirmed_selection = None
        if accepted:
            self._production_ui_cursor[pending.control_group] = index + 1
            self._pending = PendingCommand(pending.tags, pending.ability, None, None, False,
                int(bot.state.game_loop), len(self.audit) - 1, "control_group_producer", pending.control_group,
                tuple(sorted(selected)))
        else:
            self.audit[-1].update(selection_confirmation="engine_rejected", command_confirmation="selection_rejected",
                                  command_loop=int(bot.state.game_loop))
            self._pending = None
        return True

    def source_available(self, unit: Any, game_seconds: float) -> bool:
        """Retry failed screen clicks after a short, bounded game-time cooldown.

        This remembers only outcomes of our own clicks, never hidden unit state.
        A failed source remains part of the observation and becomes selectable
        again automatically, even if no movement has been observed.
        """
        self._selection_failures = {
            tag: until for tag, until in self._selection_failures.items() if until > game_seconds
        }
        return unit.tag not in self._selection_failures

    def _remember_selection_failure(self, tag: int, game_seconds: float) -> None:
        self._selection_failures = {
            source: until for source, until in self._selection_failures.items() if until > game_seconds
        }
        # Refresh insertion order so a pathological scene cannot grow memory.
        self._selection_failures.pop(tag, None)
        self._selection_failures[tag] = game_seconds + SELECTION_RETRY_SECONDS
        while len(self._selection_failures) > MAX_SELECTION_FAILURES:
            del self._selection_failures[next(iter(self._selection_failures))]

    def sync_camera(self, bot: Any) -> None:
        camera = bot.state.observation_raw.player.camera
        if camera.HasField("x") and camera.HasField("y"):
            self.camera_center = Point2((camera.x, camera.y))

    def on_screen(self, value: Any) -> bool:
        # Camera geometry alone does not establish that a raw unit is visible.
        # Respect SC2's actual camera and visibility flags, including snapshots.
        if hasattr(value, "tag") and (
            not getattr(value, "is_on_screen", False) or not getattr(value, "is_visible", False)
        ):
            return False
        point = _point(value)
        if not all(math.isfinite(v) for v in point):
            return False
        # Retain a small edge margin so selection/target pixels cannot leave the image.
        return (abs(point.x - self.camera_center.x) < CAMERA_WIDTH / 2 - 0.2
                and abs(point.y - self.camera_center.y) < CAMERA_HEIGHT / 2 - 0.2)

    def screen_point(self, value: Any) -> common.PointI:
        if not self.on_screen(value):
            raise ValueError("Target is outside the current camera viewport")
        point = _point(value)
        scale = SCREEN_SIZE[0] / CAMERA_WIDTH
        return common.PointI(x=int(SCREEN_SIZE[0] / 2 + (point.x - self.camera_center.x) * scale),
                             y=int(SCREEN_SIZE[1] / 2 - (point.y - self.camera_center.y) * scale))

    @staticmethod
    def minimap_point(bot: Any, value: Any) -> common.PointI:
        point = _point(value)
        size = bot.game_info.map_size
        if not all(math.isfinite(v) for v in (*point, size.x, size.y)) or min(size.x, size.y) <= 0:
            raise ValueError("Minimap point and map dimensions must be finite and valid")
        if not 0 <= point.x <= size.x or not 0 <= point.y <= size.y:
            raise ValueError("Minimap destination lies outside the map")
        # SC2 fits a rectangular map into a square minimap using the LONG edge.
        scale = MINIMAP_SIZE[0] / max(size.x, size.y)
        return common.PointI(x=max(0, min(63, int(point.x * scale))),
                             y=max(0, min(63, int((size.y - point.y) * scale))))

    def can_issue(self, game_seconds: float) -> bool:
        return not self.pending and self.budget.available(game_seconds)

    def camera_would_move(self, bot: Any, point: Any) -> bool:
        """Compare the actual minimap pixels emitted by camera commands."""
        return self.minimap_point(bot, point) != self.minimap_point(bot, self.camera_center)

    async def _send(self, bot: Any, action: Any, kind: str, **detail: Any) -> bool:
        now = float(bot.time)
        if not self.budget.consume(now):
            return False
        record = {"time": now, "kind": kind, "camera": list(self.camera_center), **detail}
        self.audit.append(record)
        try:
            wrapped = api.Action(action_ui=action) if isinstance(action, ui.ActionUI) else api.Action(action_feature_layer=action)
            result = await bot.client._execute(_fairplay_token=_SPATIAL_GATE, action=api.RequestAction(actions=[wrapped]))
            codes = list(result.action.result)
            record["result"] = codes
            if codes != [1]:
                self.rejected += 1
                return False
            return True
        except Exception:
            record["transport_error"] = True
            raise

    async def move_camera(self, bot: Any, point: Any) -> bool:
        if self.pending or not self.camera_would_move(bot, point):
            return False
        return await self._send(bot, spatial.ActionSpatial(camera_move=spatial.ActionSpatialCameraMove(
            center_minimap=self.minimap_point(bot, point))), "camera", destination=list(_point(point)))

    async def issue(self, bot: Any, sources: list, ability: Any, target: Any = None,
                    *, minimap: bool = False, selection_mode: str = "point", control_group: int | None = None) -> bool:
        if selection_mode not in {"point", "rectangle", "army", "control_group"}:
            raise ValueError("Unknown selection mode")
        group = None
        if selection_mode == "control_group":
            group = self._control_groups.get(self._group_index(control_group))
            if group is None:
                return False
        elif control_group is not None:
            raise ValueError("A control-group index requires control_group selection mode")
        if (not sources and selection_mode not in {"army", "control_group"}) or self.pending or not self.can_issue(bot.time):
            return False
        if any(not self.on_screen(unit) for unit in sources):
            raise ValueError("Off-screen unit selection is forbidden")
        if any(not getattr(unit, "is_mine", False) for unit in sources):
            raise ValueError("Only the player's own units may issue commands")
        if sources and not self.source_available(sources[0], float(bot.time)):
            return False
        if target is not None and hasattr(target, "tag") and not self.on_screen(target):
            raise ValueError("Unit targets must be visible on the current screen")
        if target is not None and not minimap and not self.on_screen(target):
            raise ValueError("Off-screen tactical target is forbidden")
        if target is not None and getattr(target, "is_enemy", False) and not target.is_visible:
            raise ValueError("Target is hidden by fog of war")
        ability_id = int(getattr(ability, "value", ability)) if ability is not None else None
        if ability_id is None and target is not None:
            raise ValueError("Selection-only inputs cannot carry a tactical target")
        if (target is not None and hasattr(target, "tag")
                and _ability_ids(bot, ability_id).intersection(_ATTACK_IDS)
                and (getattr(target, "is_mine", False) or getattr(target, "is_ally", False))):
            self.last_target_rejection = {"reason": "friendly_attack_forbidden", "time": float(bot.time),
                                          "ability": ability_id, "unit_target_tag": int(target.tag)}
            self.rejected += 1
            return False
        # AllType is a control-click: SC2 itself selects same-type screen units.
        if selection_mode == "point" and len(sources) > 1 and len({unit.type_id for unit in sources}) != 1:
            raise ValueError("Group selection requires units of one type")
        source_pixel = self.screen_point(sources[0]) if sources else None
        extra = {"selection_mode": selection_mode}
        if selection_mode == "army":
            action = ui.ActionUI(select_army=ui.ActionSelectArmy(selection_add=False))
        elif selection_mode == "control_group":
            action = ui.ActionUI(control_group=ui.ActionControlGroup(action=ui.ActionControlGroup.Recall,
                                                                     control_group_index=control_group))
            extra.update(control_group=control_group, registered_tags=group["tags"],
                         group_assignment_audit_index=group["assignment_audit_index"])
        elif selection_mode == "rectangle":
            pixels = [self.screen_point(unit) for unit in sources]
            bounds = [[max(0, min(point.x for point in pixels) - 1), max(0, min(point.y for point in pixels) - 1)],
                      [min(SCREEN_SIZE[0] - 1, max(point.x for point in pixels) + 1),
                       min(SCREEN_SIZE[1] - 1, max(point.y for point in pixels) + 1)]]
            action = spatial.ActionSpatial(unit_selection_rect=spatial.ActionSpatialUnitSelectionRect(
                selection_screen_coord=[common.RectangleI(p0=common.PointI(x=bounds[0][0], y=bounds[0][1]),
                                                          p1=common.PointI(x=bounds[1][0], y=bounds[1][1]))],
                selection_add=False))
            extra["selection_rectangle"] = bounds
        else:
            action = spatial.ActionSpatial(unit_selection_point=spatial.ActionSpatialUnitSelectionPoint(
                type=spatial.ActionSpatialUnitSelectionPoint.AllType if len(sources) > 1 else
                     spatial.ActionSpatialUnitSelectionPoint.Select, selection_screen_coord=source_pixel))
        self._confirmed_selection = None
        accepted = await self._send(bot, action, "selection", **extra,
                                    source_tags=[unit.tag for unit in sources],
                                    source_positions=[list(unit.position) for unit in sources],
                                    source_pixel=[source_pixel.x, source_pixel.y] if source_pixel is not None else None,
                                    source_pixel_observation={layer: screen_pixel(bot, layer, source_pixel, SCREEN_SIZE)
                                                              for layer in ("player_relative", "unit_type", "unit_density")}
                                                              if source_pixel is not None else None,
                                    ability=ability_id, target_kind=("unit" if hasattr(target, "tag") else
                                             "ground" if target is not None else "none"),
                                    intended_target=list(_point(target)) if target is not None else None,
                                    unit_target_tag=getattr(target, "tag", None), requested_minimap=minimap)
        if accepted:
            self._pending = PendingCommand(tuple(unit.tag for unit in sources),
                                           ability_id,
                                           _point(target) if target is not None else None,
                                           getattr(target, "tag", None), minimap, int(bot.state.game_loop),
                                           len(self.audit) - 1, selection_mode, control_group,
                                           tuple(group["tags"]) if group else ())
        else:
            if sources:
                self._remember_selection_failure(sources[0].tag, float(bot.time))
            self.audit[-1]["selection_confirmation"] = "engine_rejected"
            self.audit[-1]["command_confirmation"] = "selection_rejected"
            self.audit[-1]["command_loop"] = int(bot.state.game_loop)
        return accepted

    def cancel_pending(self, reason: str) -> bool:
        """Abandon an unissued command after its observation prerequisites change.

        The already-paid selection stays in the audit. Cancellation emits no
        engine action and never refunds the input budget.
        """
        if not isinstance(reason, str) or not reason.strip():
            raise ValueError("A nonempty pending-command cancellation reason is required")
        pending = self._pending
        if pending is None:
            return False
        self.audit[pending.audit_index].update(command_abandoned=reason,
            command_confirmation=reason, cancelled_before_command=True)
        self._pending = None
        return True

    async def advance(self, bot: Any) -> bool:
        """Consume a pending tick, even when pacing delays the second input."""
        self.sync_camera(bot)
        pending = self._pending
        if pending is None:
            return False
        if int(bot.state.game_loop) <= pending.selection_loop:
            return True
        if not self.budget.available(bot.time):
            return True
        # Confirm the previous spatial click actually selected a requested source.
        selected_rows = [u for u in bot.state.observation_raw.units if u.is_selected]
        selected = {u.tag for u in selected_rows}
        selection_record = self.audit[pending.audit_index]
        selection_record["selected_tags"] = sorted(selected)
        group_selection = pending.selection_mode in {"control_group", "control_group_producer"}
        global_selection = pending.selection_mode == "army" or group_selection
        if pending.selection_mode == "army":
            selection_valid = bool(selected)
        elif group_selection:
            selection_valid = bool(selected and selected.issubset(pending.permitted_tags)
                                   and (pending.selection_mode != "control_group_producer" or len(selected) == 1))
        else:
            selection_valid = bool(selected.intersection(pending.tags) and selected.issubset(pending.tags))
        if global_selection and any(row.alliance != 1 for row in selected_rows):
            selection_valid = False
        if not selection_valid:
            selection_record["selection_confirmation"] = "source_not_selected"
            selection_record["command_confirmation"] = "source_not_selected"
            selection_record["command_loop"] = int(bot.state.game_loop)
            if pending.tags:
                self._remember_selection_failure(pending.tags[0], float(bot.time))
            self._pending = None
            self.rejected += 1
            return True
        selection_record["selection_confirmation"] = "confirmed"
        current_sources = [u for u in visible_screen_units(bot, self)
                           if u.tag in selected and getattr(u, "is_mine", False)
                           and (global_selection or u.tag in pending.tags)]
        if group_selection and pending.target is None and pending.ability is not None:
            selection_record["group_production_ui"] = self._production_panel_observation(
                getattr(bot.state, "observation", None))
        production_candidate = (self._group_production_allowed(bot, pending, selected, require_queue=False)
                                if group_selection and pending.target is None and pending.ability is not None else None)
        if (production_candidate and pending.selection_mode == "control_group" and len(selected) > 1
                and await self._select_group_producer(bot, pending, selected, current_sources)):
            return True
        group_production = (self._group_production_allowed(bot, pending, selected) if production_candidate else None)
        selection_only = pending.ability is None
        group_members = self._control_groups.get(pending.control_group, {}).get("members", [])
        visible_tags = {unit.tag for unit in current_sources}
        offscreen_buildings = (group_selection
                              and any(row.get("is_structure") and row["tag"] in selected - visible_tags
                                      for row in group_members))
        structure_group_without_target = (group_selection and pending.target is None
                                          and all(any(row["tag"] == tag and row.get("is_structure")
                                                      for row in group_members) for tag in selected))
        if (not selection_only and group_production is None
                and (offscreen_buildings or structure_group_without_target or production_candidate
                     or pending.selection_mode == "control_group_producer")):
            selection_record.update(command_abandoned="group_production_unavailable",
                                    command_confirmation="group_production_unavailable", command_loop=int(bot.state.game_loop))
            if production_candidate:
                selection_record["group_production_queue_rejection"] = (
                    "selected_production_queue_unavailable" if production_candidate["queue_evidence"] is None
                    else "selected_production_queue_full")
                selection_record["group_production_queue_evidence"] = production_candidate["queue_evidence"]
            self._pending = None
            self.rejected += 1
            return True
        member_by_tag = {row["tag"]: row for row in group_members}
        army_receipt = (pending.selection_mode == "army" or pending.selection_mode == "control_group"
                        and all(member_by_tag.get(tag, {}).get("is_army", False) for tag in selected))
        source_free_ground = bool(army_receipt and pending.target is not None and pending.target_tag is None
                                  and self.on_screen(pending.target)
                                  and _ability_ids(bot, pending.ability).intersection(_ATTACK_IDS))
        if (not global_selection and selected != {unit.tag for unit in current_sources}
                or not current_sources and not group_production and not source_free_ground
                and not (global_selection and selection_only)):
            selection_record.update(command_abandoned="source_not_on_screen", command_confirmation="source_not_on_screen",
                                    command_loop=int(bot.state.game_loop))
            self._pending = None
            self.rejected += 1
            return True
        command_tags = sorted(selected) if global_selection else [unit.tag for unit in current_sources]
        selection_record["command_source_tags"] = command_tags
        known = {row["tag"]: dict(row) for row in self._control_groups.get(pending.control_group, {}).get("members", [])}
        if pending.selection_mode == "army":
            known.update({tag: {"tag": tag, "type_id": None, "is_structure": False,
                               "is_army": True, "army_provenance": "select_army"} for tag in selected})
        for unit in current_sources:
            type_id = int(getattr(unit.type_id, "value", unit.type_id))
            structure = bool(getattr(unit, "is_structure", False))
            is_army = not structure and type_id not in _WORKER_TYPES and (
                pending.selection_mode == "army" or getattr(unit, "can_attack", False) or type_id in _PROTOSS_ARMY_TYPES)
            known[unit.tag] = {"tag": unit.tag, "type_id": type_id, "is_structure": structure, "is_army": is_army,
                               "army_provenance": "select_army" if pending.selection_mode == "army" else "visible_unit"}
        self._confirmed_selection = {"tags": sorted(selected), "mode": pending.selection_mode,
                                     "audit_index": pending.audit_index, "confirmed_loop": int(bot.state.game_loop),
                                     "members": [known.get(tag, {"tag": tag, "type_id": None, "is_structure": False})
                                                 for tag in sorted(selected)]}
        if selection_only:
            selection_record.update(command_confirmation="selection_only", command_loop=int(bot.state.game_loop))
            self._pending = None
            return True
        target = pending.target
        target_unit = None
        if pending.target_tag is not None:
            match = next((u for u in visible_screen_units(bot, self) if u.tag == pending.target_tag), None)
            if match is None or not self.on_screen(match):
                selection_record["command_abandoned"] = "target_not_visible"
                selection_record["command_confirmation"] = "target_not_visible"
                selection_record["command_loop"] = int(bot.state.game_loop)
                self._pending = None
                self.rejected += 1
                return True
            target = match.position
            target_unit = match
        attack = bool(_ability_ids(bot, pending.ability).intersection(_ATTACK_IDS))
        if (target is not None and not pending.minimap and not self.on_screen(target)
                and not (attack and target_unit is None)):
            selection_record["command_abandoned"] = "target_offscreen"
            selection_record["command_confirmation"] = "target_offscreen"
            selection_record["command_loop"] = int(bot.state.game_loop)
            self._pending = None
            self.rejected += 1
            return True
        point_command = bool(_ability_ids(bot, pending.ability).intersection(_ATTACK_IDS | _MOVE_IDS))
        minimap = pending.minimap if target_unit is None else False
        redirected = False
        redirect_reason = None
        safe_ground_pixel = None
        rejection = None
        emitted_ability = pending.ability
        if target_unit is not None and attack:
            if (getattr(target_unit, "is_mine", False) or getattr(target_unit, "is_ally", False)):
                rejection = "friendly_attack_forbidden"
            elif not clear_enemy_target_pixel(bot, self, self.screen_point(target_unit), target_unit, SCREEN_SIZE):
                rejection = "unit_target_pixel_ambiguous"
        elif target is not None and target_unit is None and point_command:
            # Re-check after selection: another unit can walk under a formerly
            # empty point. An attack/move screen click on it changes semantics.
            if attack:
                resolved = resolve_ground_attack(bot, self, target, current_sources, SCREEN_SIZE, CAMERA_WIDTH)
                if resolved is None:
                    rejection = "no_clear_visible_screen_ground"
                else:
                    target, safe_ground_pixel, redirect_reason = resolved
                    if pending.minimap and redirect_reason is None:
                        redirect_reason = "screen_target_requested_via_minimap"
                    minimap = False
                    redirected = redirect_reason is not None
                    emitted_ability = AbilityId.ATTACK_ATTACK.value
            else:
                # Movement semantics are unchanged here. Distant Move remains
                # a minimap command for scouting and worker-transfer leases.
                if not minimap and not clear_ground_pixel(bot, self, self.screen_point(target), SCREEN_SIZE):
                    minimap, redirected = True, True
                if minimap and not _minimap_ground_allowed(bot, pending.ability):
                    rejection = "ground_minimap_unavailable"
        if rejection:
            selection_record.update(command_abandoned=rejection, command_confirmation=rejection,
                                    command_loop=int(bot.state.game_loop))
            self.last_target_rejection = {"reason": rejection, "time": float(bot.time),
                                          "ability": pending.ability, "unit_target_tag": pending.target_tag}
            self._pending = None
            self.rejected += 1
            return True
        command = spatial.ActionSpatialUnitCommand(ability_id=emitted_ability, queue_command=False)
        pixel, effective = None, target
        if target is not None:
            if minimap:
                pixel = self.minimap_point(bot, target)
                command.target_minimap_coord.CopyFrom(pixel)
                scale = MINIMAP_SIZE[0] / max(bot.game_info.map_size)
                effective = Point2(((pixel.x + .5) / scale, bot.game_info.map_size.y - (pixel.y + .5) / scale))
            else:
                pixel = safe_ground_pixel if safe_ground_pixel is not None else self.screen_point(target)
                command.target_screen_coord.CopyFrom(pixel)
                if target_unit is None:
                    scale = SCREEN_SIZE[0] / CAMERA_WIDTH
                    effective = Point2((self.camera_center.x + (pixel.x + .5 - SCREEN_SIZE[0] / 2) / scale,
                                        self.camera_center.y - (pixel.y + .5 - SCREEN_SIZE[1] / 2) / scale))
        geometry = {"target_kind": "unit" if target_unit is not None else "ground" if target is not None else "none",
                    "requested_ability": pending.ability, "emitted_ability": emitted_ability,
                    "point_only_attack": False,
                    "ground_target_safety": ("current_visible_empty_screen" if safe_ground_pixel is not None else None),
                    "ground_redirect_reason": redirect_reason,
                    "intended_target": list(pending.target) if pending.target is not None else None,
                    "effective_target": list(effective) if effective is not None else None,
                    "unit_target_tag": pending.target_tag, "requested_minimap": pending.minimap,
                    "minimap": minimap, "ground_target_redirected": redirected,
                    "target_pixel": [pixel.x, pixel.y] if pixel is not None else None}
        if global_selection:
            geometry.update(selection_mode=pending.selection_mode, control_group=pending.control_group,
                            selection_provenance_audit_index=pending.audit_index,
                            visible_command_source_tags=[unit.tag for unit in current_sources],
                            offscreen_selected_count=len(selected) - len(current_sources),
                            source_free_ground_command=source_free_ground and not current_sources,
                            group_production=group_production)
        if safe_ground_pixel is not None:
            # Bounded evidence from this permitted command observation, so a
            # later pick failure can be checked without reconstructing a game.
            nearby = [unit for unit in visible_screen_units(bot, self)
                      if unit.position.distance_to(effective) <= 4]
            geometry["ground_click_evidence"] = {
                "layers": {name: screen_pixel(bot, name, safe_ground_pixel, SCREEN_SIZE)
                           for name in ("player_relative", "unit_type", "unit_density", "visibility_map", "pathable")},
                "nearby_visible_units": [{"tag": unit.tag, "position": list(unit.position),
                    "radius": float(getattr(unit, "radius", 1)),
                    "is_structure": bool(getattr(unit, "is_structure", False)),
                    "is_mine": bool(getattr(unit, "is_mine", False))} for unit in nearby[:32]],
                "nearby_unit_limit": 32, "nearby_units_truncated": len(nearby) > 32}
        selection_record.update(geometry)
        self._pending = None
        accepted = await self._send(bot, spatial.ActionSpatial(unit_command=command), "command",
                                    ability=emitted_ability, target=list(target) if target is not None else None,
                                    **geometry, source_tags=command_tags, requested_source_tags=list(pending.tags),
                                    selection_audit_index=pending.audit_index, game_loop=int(bot.state.game_loop))
        selection_record["command_confirmation"] = "accepted" if accepted else "engine_rejected"
        selection_record["command_loop"] = int(bot.state.game_loop)
        return True

    def summary(self) -> dict:
        return {"version": FAIRPLAY_VERSION, "max_apm": self.budget.max_apm,
                "peak_rolling_60s_actions": self.budget.peak, "total_actions": self.budget.total,
                "minimum_input_interval_seconds": self.budget.interval,
                "rejected_actions": self.rejected, "screen": list(SCREEN_SIZE),
                "camera_width": CAMERA_WIDTH, "raw_unit_commands": 0}
