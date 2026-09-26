"""Local matches, PPO training, evaluation, and durable run artifacts."""

from __future__ import annotations

import asyncio
import hashlib
import json
import math
import numbers
import os
import random
import signal
import sys
import tempfile
import time
from collections import Counter, deque
from contextlib import contextmanager
from dataclasses import asdict, replace
from pathlib import Path
from typing import Iterator

import numpy as np
import aiohttp
import torch
from filelock import FileLock
from loguru import logger
from sc2.sc2process import SC2Process

from pluto_sc2.contract import model_metadata, validate_metadata
from pluto_sc2.fairplay import ActionBudget, CAMERA_HEIGHT, CAMERA_WIDTH, FAIRPLAY_VERSION, HumanClient, SCREEN_SIZE
from pluto_sc2.learning import Policy, PPOConfig, PPOTrainer, load_checkpoint, save_checkpoint
from pluto_sc2.schema import ACTION_NAMES, OBSERVATION_SIZE


class DiagnosticSC2WebSocket(aiohttp.ClientWebSocketResponse):
    """Retain frame failure metadata before higher layers discard its cause.

    Binary game observations are neither copied nor logged. Normal aiohttp
    framing, timeout and message-size behavior is unchanged.
    """

    async def receive(self, *args, **kwargs):
        try:
            message = await super().receive(*args, **kwargs)
        except Exception as error:
            if getattr(self, "_first_receive_failure", None) is None:
                self._first_receive_failure = {
                    "type": "raised", "error": f"{type(error).__name__}: {error}",
                    "recorded_at": time.time(),
                }
            raise
        if message.type == aiohttp.WSMsgType.BINARY:
            self._last_binary_size = len(message.data)
        elif getattr(self, "_first_receive_failure", None) is None:
            self._first_receive_failure = {
                "type": message.type.name,
                "error": f"{type(message.data).__name__}: {message.data}" if isinstance(message.data, BaseException) else None,
                "close_code": message.data if message.type == aiohttp.WSMsgType.CLOSE else None,
                "recorded_at": time.time(),
            }
        return message


class ManagedSC2Process(SC2Process):
    """Bound startup and API reads, detecting a dead child during connection.

    The context manager closes sessions and cleans up the child when
    this method raises. Successful connections keep their session for gameplay.
    """

    startup_timeout_seconds = 75.0
    connect_timeout_seconds = 2.0
    websocket_receive_timeout_seconds = 90.0
    websocket_close_timeout_seconds = 5.0
    poll_interval_seconds = .25
    _active: set = set()
    _previous_sigint = None
    _lifecycle_events = deque(maxlen=64)

    def diagnostic_snapshot(self) -> dict:
        """Inspect only this wrapper's child and transport, without changing either."""
        process = getattr(self, "_process", None)
        poll = getattr(process, "poll", None)
        diagnostic_errors = []
        try:
            code = poll() if callable(poll) else None
        except Exception as error:
            code = None
            diagnostic_errors.append(f"process poll: {type(error).__name__}: {error}")
        websocket = getattr(self, "_ws", None)
        exception = getattr(websocket, "exception", None)
        try:
            transport_error = exception() if callable(exception) else None
        except Exception as error:
            transport_error = None
            diagnostic_errors.append(f"websocket exception: {type(error).__name__}: {error}")
        reader_exception = getattr(getattr(websocket, "_reader", None), "exception", None)
        try:
            reader_error = reader_exception() if callable(reader_exception) else None
        except Exception as error:
            reader_error = None
            diagnostic_errors.append(f"websocket reader: {type(error).__name__}: {error}")
        return {
            "pid": getattr(process, "pid", None),
            "process_created_at": getattr(self, "_managed_created_at", None),
            "port": getattr(self, "_port", None),
            "process_running": (code is None) if callable(poll) and not any(
                error.startswith("process poll:") for error in diagnostic_errors) else None,
            "exit_code": code,
            "exit_code_hex": f"0x{code & 0xffffffff:08X}" if isinstance(code, int) else None,
            "websocket_closed": getattr(websocket, "closed", None),
            "websocket_close_code": getattr(websocket, "close_code", None),
            "websocket_error": f"{type(transport_error).__name__}: {transport_error}" if transport_error else None,
            "websocket_reader_error": f"{type(reader_error).__name__}: {reader_error}" if reader_error else None,
            "first_receive_failure": getattr(websocket, "_first_receive_failure", None),
            "last_binary_frame_bytes": getattr(websocket, "_last_binary_size", None),
            "diagnostic_errors": diagnostic_errors,
        }

    @classmethod
    def diagnostic_for_websocket(cls, websocket) -> dict | None:
        if websocket is not None:
            for process in tuple(cls._active):
                if getattr(process, "_ws", None) is websocket:
                    return process.diagnostic_snapshot()
        return None

    def _record_lifecycle(self, phase: str, error=None) -> dict:
        evidence = self.diagnostic_snapshot()
        evidence.update(phase=phase, recorded_at=time.time(),
                        context_error=f"{type(error).__name__}: {error}" if error else None)
        ManagedSC2Process._lifecycle_events.append(evidence)
        logger.info("Managed SC2 process lifecycle: {}", evidence)
        return evidence

    @staticmethod
    def _interrupt_active(signum, frame):
        # Only children created by this wrapper belong to this training job.
        for process in tuple(ManagedSC2Process._active):
            process._clean(verbose=False)
        raise KeyboardInterrupt

    async def __aenter__(self):
        from sc2.controller import Controller

        cls = ManagedSC2Process
        if not cls._active:
            cls._previous_sigint = signal.getsignal(signal.SIGINT)
            signal.signal(signal.SIGINT, cls._interrupt_active)
        cls._active.add(self)
        try:
            self._process = self._launch()
            self._managed_created_at = None
            pid = getattr(self._process, "pid", None)
            if isinstance(pid, int) and pid > 0:
                import psutil
                try:
                    self._managed_created_at = psutil.Process(pid).create_time()
                except psutil.Error:
                    pass  # A child that immediately exits is diagnosed by _connect.
            self._record_lifecycle("launched")
            self._ws = await self._connect()
            self._record_lifecycle("connected")
            return Controller(self._ws, self)
        except BaseException as error:
            await self.__aexit__(type(error), error, error.__traceback__)
            raise

    async def __aexit__(self, *args):
        # Burnysc2's global KillSwitch closes every peer when the first context
        # exits. Each self-play peer must finish saving/leaving independently.
        error = args[1] if len(args) > 1 else None
        # Capture before closing the socket or terminating our child. An exit
        # code obtained only after cleanup cannot prove an engine crash.
        self._record_lifecycle("before_connection_close", error)
        try:
            await self._close_connection()
        finally:
            try:
                evidence = self._record_lifecycle("before_owned_cleanup", error)
                logger.info("Managed SC2 owned cleanup: pid={}, child_still_running={}",
                            evidence["pid"], evidence["process_running"])
                self._clean(verbose=False)
            finally:
                cls = ManagedSC2Process
                cls._active.discard(self)
                if not cls._active and cls._previous_sigint is not None:
                    signal.signal(signal.SIGINT, cls._previous_sigint)
                    cls._previous_sigint = None

    async def _connect(self):
        import aiohttp

        deadline = time.monotonic() + self.startup_timeout_seconds
        self._session = aiohttp.ClientSession(timeout=aiohttp.ClientTimeout(
            total=self.connect_timeout_seconds, connect=self.connect_timeout_seconds,
            sock_connect=self.connect_timeout_seconds), ws_response_class=DiagnosticSC2WebSocket)
        # Bound reads inside aiohttp: cancelling Protocol._execute externally
        # makes burnysc2 drain another response and can hang indefinitely.
        # ClientWSTimeout exists in burnysc2's minimum aiohttp version (3.11.10).
        websocket_timeout = aiohttp.ClientWSTimeout(
            ws_receive=self.websocket_receive_timeout_seconds,
            ws_close=self.websocket_close_timeout_seconds,
        )
        connected = False
        last_error = None
        try:
            while True:
                if self._process is None:
                    raise RuntimeError("StarCraft II startup was cancelled before connection")
                exit_code = self._process.poll()
                if exit_code is not None:
                    raise RuntimeError(
                        f"StarCraft II exited before its API became available: exit code {exit_code} "
                        f"(0x{exit_code & 0xffffffff:08X}). Check the game installation and launcher logs."
                    )
                remaining = deadline - time.monotonic()
                if remaining <= 0:
                    raise TimeoutError(
                        f"StarCraft II API startup exceeded {self.startup_timeout_seconds:g} seconds "
                        f"at {self.ws_url}; last connection error: {last_error}"
                    )
                try:
                    websocket = await asyncio.wait_for(
                        self._session.ws_connect(self.ws_url, timeout=websocket_timeout),
                        timeout=min(self.connect_timeout_seconds, remaining),
                    )
                    connected = True
                    return websocket
                except (aiohttp.ClientError, OSError, asyncio.TimeoutError) as error:
                    last_error = str(error) or type(error).__name__
                await asyncio.sleep(min(self.poll_interval_seconds, max(0, deadline - time.monotonic())))
        finally:
            if not connected:
                await self._session.close()
                self._session = None


def seed_everything(seed: int) -> None:
    if isinstance(seed, bool) or not isinstance(seed, int) or not 0 <= seed < 2**32:
        raise ValueError("seed must be an integer in 0..4294967295")
    random.seed(seed)
    np.random.seed(seed)
    torch.manual_seed(seed)
    if torch.cuda.is_available():
        torch.cuda.manual_seed_all(seed)


def device_name(device: str) -> str:
    if device not in ("auto", "cpu", "cuda"):
        raise ValueError("device must be cpu, cuda, or auto")
    if device == "auto":
        return "cuda" if torch.cuda.is_available() else "cpu"
    if device == "cuda" and not torch.cuda.is_available():
        raise ValueError("CUDA is unavailable in this PyTorch installation; use --device cpu")
    return device


def append_json(path: Path, record: dict) -> None:
    serialized = json.dumps(record, allow_nan=False) + "\n"
    path.parent.mkdir(parents=True, exist_ok=True)
    with path.open("a", encoding="utf-8") as stream:
        stream.write(serialized)
        stream.flush()
        os.fsync(stream.fileno())


def write_json(path: Path, record: dict) -> None:
    serialized = json.dumps(record, indent=2, allow_nan=False)
    path.parent.mkdir(parents=True, exist_ok=True)
    temporary = None
    try:
        with tempfile.NamedTemporaryFile(mode="w", encoding="utf-8", prefix=f".{path.name}.",
                                         suffix=".tmp", dir=path.parent, delete=False) as stream:
            temporary = Path(stream.name)
            stream.write(serialized)
            stream.flush()
            os.fsync(stream.fileno())
        # Windows readers/virus scanners can briefly deny a rename even when
        # both paths are writable. Preserve the old complete document and retry
        # the atomic replacement; never fall back to a partial in-place write.
        for attempt in range(21):
            try:
                temporary.replace(path)
                break
            except PermissionError:
                if attempt == 20:
                    raise
                time.sleep(.025 if attempt < 4 else .05)
    finally:
        if temporary is not None and temporary.exists():
            temporary.unlink()


def validate_action_audit(data: dict) -> dict:
    """Verify pacing, screen bounds, and recorded UI selection provenance.

    This checks the recorded inputs. It cannot independently reconstruct fog,
    selection state, or prove that a file describes every engine input.
    """
    if not isinstance(data, dict) or not isinstance(data.get("actions"), list):
        raise ValueError("Audit must contain an actions list")
    summary = data.get("summary")
    if not isinstance(summary, dict) or summary.get("version") != FAIRPLAY_VERSION:
        raise ValueError("Audit summary has a missing or incompatible fairplay version")
    budget = ActionBudget(summary.get("max_apm"))
    actions = data["actions"]
    groups: dict[int, tuple[set[int], int]] = {}
    latest_selection = None
    modes = {"point", "rectangle", "army", "control_group", "control_group_set", "control_group_append",
             "control_group_producer"}

    def coordinates(value, field, index):
        if not isinstance(value, (list, tuple)) or len(value) != 2 or any(
            isinstance(component, bool) or not isinstance(component, numbers.Real)
            or not math.isfinite(component) for component in value
        ):
            raise ValueError(f"Invalid {field} coordinates at event {index}")
        return value

    def tags(value, field, index, *, empty=False):
        if (not isinstance(value, list) or not empty and not value
                or any(type(tag) is not int or tag <= 0 for tag in value)
                or len(set(value)) != len(value)):
            raise ValueError(f"Invalid {field} tags at event {index}")
        return set(value)

    def group_index(value, index):
        if type(value) is not int or not 0 <= value <= 9:
            raise ValueError(f"Invalid control group at event {index}")
        return value

    def reference(value, index):
        if type(value) is not int or not 0 <= value < index:
            raise ValueError(f"Invalid selection provenance at event {index}")
        prior = actions[value]
        if (value != latest_selection or prior.get("kind") != "selection"
                or prior.get("selection_mode", "point") in {"control_group_set", "control_group_append"}
                or prior.get("result") != [1] or prior.get("selection_confirmation") != "confirmed"):
            raise ValueError(f"Unconfirmed or stale selection provenance at event {index}")
        return prior

    def ui_result(action, index):
        result = action.get("result")
        if (action.get("transport_error") or not isinstance(result, list) or not result
                or any(type(code) is not int or code <= 0 for code in result)):
            raise ValueError(f"Missing UI input result at event {index}")

    for index, action in enumerate(data["actions"]):
        if not isinstance(action, dict) or action.get("kind") not in ("selection", "command", "camera"):
            raise ValueError(f"Unknown input kind at event {index}")
        if not budget.consume(action.get("time")):
            raise ValueError(f"APM or minimum input spacing violation at event {index}")
        camera = coordinates(action.get("camera"), "camera", index)

        def on_screen(position, field):
            position = coordinates(position, field, index)
            if (abs(position[0] - camera[0]) >= CAMERA_WIDTH / 2 - .2
                    or abs(position[1] - camera[1]) >= CAMERA_HEIGHT / 2 - .2):
                raise ValueError(f"Off-screen {field} at event {index}")

        if action["kind"] == "selection":
            mode = action.get("selection_mode", "point")
            if mode not in modes:
                raise ValueError(f"Unknown selection mode at event {index}")
            sources = action.get("source_positions")
            source_tags = tags(action.get("source_tags"), "selection source", index,
                               empty=mode not in {"point", "rectangle"})
            if not isinstance(sources, list) or len(sources) != len(source_tags):
                raise ValueError(f"Invalid selection sources at event {index}")
            for position in sources:
                on_screen(position, "selection")
            if mode == "rectangle":
                bounds = action.get("selection_rectangle")
                if (not isinstance(bounds, list) or len(bounds) != 2
                        or any(not isinstance(point, list) or len(point) != 2 for point in bounds)
                        or any(type(point[axis]) is not int or not 0 <= point[axis] < SCREEN_SIZE[axis]
                               for point in bounds for axis in (0, 1))
                        or any(bounds[0][axis] > bounds[1][axis] for axis in (0, 1))):
                    raise ValueError(f"Invalid selection rectangle at event {index}")
                scale = SCREEN_SIZE[0] / CAMERA_WIDTH
                pixels = [(int(SCREEN_SIZE[0] / 2 + (p[0] - camera[0]) * scale),
                           int(SCREEN_SIZE[1] / 2 - (p[1] - camera[1]) * scale)) for p in sources]
                if any(not bounds[0][axis] <= point[axis] <= bounds[1][axis]
                       for point in pixels for axis in (0, 1)):
                    raise ValueError(f"Selection rectangle excludes its sources at event {index}")
            if mode in {"army", "control_group", "control_group_set", "control_group_append", "control_group_producer"}:
                ui_result(action, index)
            if mode in {"control_group_set", "control_group_append"}:
                group = group_index(action.get("control_group"), index)
                prior = reference(action.get("selection_provenance_audit_index"), index)
                selected = tags(action.get("selected_tags"), "assigned selection", index)
                if (selected != tags(prior.get("selected_tags"), "confirmed selection", index)
                        or not source_tags.issubset(selected)):
                    raise ValueError(f"Group assignment differs from confirmed selection at event {index}")
                old = groups.get(group)
                if mode == "control_group_append" and old is None:
                    raise ValueError(f"Group append has no prior assignment at event {index}")
                previous_tags = old[0] if mode == "control_group_append" else set()
                if tags(action.get("prior_group_tags"), "prior group", index, empty=True) != previous_tags:
                    raise ValueError(f"Group append has stale prior members at event {index}")
                registered = tags(action.get("registered_tags"), "registered group", index)
                if registered != previous_tags | selected:
                    raise ValueError(f"Group assignment invents or drops members at event {index}")
                if action["result"] == [1]:
                    groups[group] = (registered, index)
            else:
                parent_selected = None
                if mode == "control_group_producer":
                    parent = reference(action.get("parent_selection_audit_index"), index)
                    parent_selected = tags(action.get("parent_selected_tags"), "producer parent selection", index)
                    if (parent.get("selection_mode") != "control_group"
                            or parent.get("command_confirmation") != (
                                "production_subselection" if action["result"] == [1] else "production_subselection_rejected")
                            or parent_selected != tags(parent.get("selected_tags"), "recalled parent selection", index)
                            or parent.get("control_group") != action.get("control_group")
                            or not source_tags.issubset(parent_selected)
                            or type(action.get("production_ui_index")) is not int
                            or not 0 <= action["production_ui_index"] < len(parent_selected)
                            or type(action.get("production_ui_unit_type")) is not int
                            or action["production_ui_unit_type"] <= 0):
                        raise ValueError(f"Producer portrait has no matching recalled selection at event {index}")
                # Every fresh selection attempt invalidates the old receipt,
                # even if the engine rejects the new click.
                latest_selection = None
                registered = None
                if mode in {"control_group", "control_group_producer"}:
                    group = group_index(action.get("control_group"), index)
                    registered = tags(action.get("registered_tags"), "recalled group", index)
                    old = groups.get(group)
                    if (old is None or registered != old[0]
                            or action.get("group_assignment_audit_index") != old[1]
                            or type(action.get("group_assignment_audit_index")) is not int
                            or not source_tags.issubset(registered)):
                        raise ValueError(f"Group recall has no matching assignment at event {index}")
                if action.get("selection_confirmation") == "confirmed":
                    selected = tags(action.get("selected_tags"), "confirmed selection", index)
                    if (action.get("result") != [1]
                            or mode in {"point", "rectangle"} and not selected.issubset(source_tags)
                            or registered is not None and not selected.issubset(registered)):
                        raise ValueError(f"Selection confirmation contradicts its input at event {index}")
                    if parent_selected is not None and (len(selected) != 1 or not selected.issubset(parent_selected)):
                        raise ValueError(f"Producer portrait did not select one recalled member at event {index}")
                    # A screen/production check can still abandon a confirmed
                    # selection before the controller creates a usable receipt.
                    command_sources = action.get("command_source_tags")
                    if command_sources is not None:
                        if tags(command_sources, "confirmed command source", index) != selected:
                            raise ValueError(f"Confirmed command sources disagree at event {index}")
                        latest_selection = index
        elif action["kind"] == "command":
            if type(action.get("ability")) is not int or action["ability"] <= 0:
                raise ValueError(f"Invalid command ability at event {index}")
            if type(action.get("minimap")) is not bool:
                raise ValueError(f"Invalid minimap flag at event {index}")
            target = action.get("target")
            if target is not None:
                if action["minimap"]:
                    coordinates(target, "minimap target", index)
                else:
                    on_screen(target, "tactical target")
            mode = action.get("selection_mode")
            global_fields = {"visible_command_source_tags", "offscreen_selected_count", "group_production",
                             "selection_provenance_audit_index", "source_free_ground_command"}
            if mode is not None or global_fields.intersection(action):
                if mode not in {"army", "control_group", "control_group_producer"}:
                    raise ValueError(f"Global command lacks explicit UI selection mode at event {index}")
                ui_result(action, index)
                prior = reference(action.get("selection_provenance_audit_index"), index)
                if (action.get("selection_audit_index") != action["selection_provenance_audit_index"]
                        or type(action.get("selection_audit_index")) is not int
                        or prior.get("selection_mode") != mode):
                    raise ValueError(f"Global command selection provenance disagrees at event {index}")
                selected = tags(action.get("source_tags"), "global command source", index)
                visible = tags(action.get("visible_command_source_tags"), "visible command source", index, empty=True)
                if (selected != tags(prior.get("selected_tags"), "prior selected", index)
                        or not visible.issubset(selected)
                        or type(action.get("offscreen_selected_count")) is not int
                        or action["offscreen_selected_count"] != len(selected - visible)):
                    raise ValueError(f"Global command members disagree with selection at event {index}")
                if mode in {"control_group", "control_group_producer"}:
                    group = group_index(action.get("control_group"), index)
                    if group != prior.get("control_group"):
                        raise ValueError(f"Global command uses a different control group at event {index}")
                elif action.get("control_group") is not None:
                    raise ValueError(f"Army selection cannot name a control group at event {index}")
                production = action.get("group_production")
                if mode == "control_group_producer" and production is None:
                    raise ValueError(f"Producer portrait command lacks verified production at event {index}")
                if production is not None:
                    if (mode not in {"control_group", "control_group_producer"} or not isinstance(production, dict)
                            or production.get("kind") not in {"train", "research"}
                            or target is not None or action.get("target_kind") != "none"
                            or production.get("group") != group or type(production.get("group")) is not int
                            or production.get("group_assignment_audit_index") != groups[group][1]
                            or type(production.get("group_assignment_audit_index")) is not int):
                        raise ValueError(f"Invalid offscreen group production evidence at event {index}")
                    tags(production.get("selection_ui_abilities"), "selected UI ability", index)
                    for field in ("mineral_cost", "vespene_cost", "supply_cost"):
                        value = production.get(field)
                        if (isinstance(value, bool) or not isinstance(value, numbers.Real)
                                or not math.isfinite(value) or value < 0):
                            raise ValueError(f"Invalid group production cost at event {index}")
                    queue = production.get("queue_evidence")
                    queue_fields = ("build_queue_count", "production_queue_count", "queue_item_count")
                    if (not isinstance(queue, dict) or queue.get("source") not in {
                            "selected_production_panel", "selected_idle_single_panel"}
                            or type(queue.get("producer_count")) is not int or queue["producer_count"] != 1
                            or len(selected) != 1 or type(queue.get("producer_type")) is not int
                            or queue["producer_type"] <= 0
                            or any(type(queue.get(field)) is not int or queue[field] < 0 for field in queue_fields)
                            or queue["queue_item_count"] != max(queue["build_queue_count"], queue["production_queue_count"])
                            or queue["queue_item_count"] > (1 if production["kind"] == "train" else 0)
                            or mode == "control_group_producer" and queue["producer_type"] != prior["production_ui_unit_type"]):
                        raise ValueError(f"Invalid selected production queue evidence at event {index}")
                    idle_single = queue["source"] == "selected_idle_single_panel"
                    panel_kind = "single" if idle_single else "production"
                    if (idle_single and (queue.get("panel_kind") != "single" or queue.get("player_relative") != 1
                                        or any(queue[field] != 0 for field in queue_fields))
                            or "panel_kind" in queue and queue["panel_kind"] != panel_kind
                            or "player_relative" in queue and (type(queue["player_relative"]) is not int
                                                             or queue["player_relative"] != 1)):
                        raise ValueError(f"Invalid selected producer panel variant at event {index}")
                    panel = production.get("ui_panel")
                    # Older production-panel audits predate this explicit UI
                    # snapshot. New idle-single evidence must always contain it.
                    if idle_single or panel is not None:
                        if (not isinstance(panel, dict) or panel.get("panel_kind") != panel_kind
                                or type(panel.get("unit_type")) is not int or panel["unit_type"] != queue["producer_type"]
                                or type(panel.get("player_relative")) is not int or panel["player_relative"] != 1
                                or any(panel.get(field) != (None if idle_single else queue[field])
                                       for field in ("build_queue_count", "production_queue_count"))):
                            raise ValueError(f"Invalid current selected producer UI snapshot at event {index}")
                source_free = action.get("source_free_ground_command", False)
                if type(source_free) is not bool:
                    raise ValueError(f"Invalid source-free command evidence at event {index}")
                if source_free and (visible or target is None or action["minimap"]
                                    or action.get("target_kind") != "ground"
                                    or action.get("ground_target_safety") != "current_visible_empty_screen"):
                    raise ValueError(f"Source-free command lacks visible ground evidence at event {index}")
                if not visible and production is None and not source_free:
                    raise ValueError(f"Global command has neither visible sources nor approved exception at event {index}")
        else:
            coordinates(action.get("destination"), "camera destination", index)
    for name, expected in (("total_actions", budget.total), ("peak_rolling_60s_actions", budget.peak),
                           ("raw_unit_commands", 0)):
        if type(summary.get(name)) is not int or summary[name] != expected:
            raise ValueError(f"Audit summary mismatch for {name}")
    interval = summary.get("minimum_input_interval_seconds")
    if isinstance(interval, bool) or not isinstance(interval, numbers.Real) or not math.isclose(
        interval, budget.interval, rel_tol=1e-9, abs_tol=1e-12
    ):
        raise ValueError("Audit summary mismatch for minimum input interval")
    return {"valid": True, "events": budget.total, "peak_rolling_60s_actions": budget.peak,
            "scope": "Recorded timing, screen bounds and UI group provenance; fog and actual selection require live-engine evidence"}


@contextmanager
def spatial_client() -> Iterator[None]:
    # burnysc2 does not expose a Client factory. Pin its version and restore this
    # narrow injection after each synchronous match; no parallel match threads.
    import sc2.main
    previous = sc2.main.Client
    previous_process = sc2.main.SC2Process
    sc2.main.Client = HumanClient
    sc2.main.SC2Process = ManagedSC2Process
    try:
        yield
    finally:
        sc2.main.Client = previous
        sc2.main.SC2Process = previous_process


def resolve_map(name: str):
    from sc2 import maps
    from sc2.maps import Map
    path = Path(name).expanduser()
    if path.is_file():
        if path.suffix.lower() == ".s2ma":
            raise ValueError("StarCraft II does not accept a .s2ma cache path as a local map. "
                             "Copy the cached file to a .SC2Map filename and pass that path.")
        if path.suffix.lower() != ".sc2map":
            raise ValueError("Map must be a .SC2Map file")
        return Map(path.resolve())
    if path.is_absolute() or path.suffix:
        raise ValueError(f"Map does not exist: {path}")
    try:
        return maps.get(name)
    except (KeyError, FileNotFoundError) as error:
        raise ValueError(f"Map {name!r} not installed. Pass an installed melee map path for the "
                         "eight-worker start in SC2 5.0.16 or a compatible newer version.") from error


def load_policy(path: str | Path, device: str = "cpu") -> tuple[Policy, dict]:
    loaded = load_checkpoint(path, expected_input_dim=OBSERVATION_SIZE,
                             expected_action_dim=len(ACTION_NAMES))
    validate_metadata(loaded["metadata"])
    policy = loaded["policy"].to(device_name(device))
    return policy, loaded


def _normalize_time_limit(bots: list, result_names: list[str], max_game_seconds: float,
                          step_mul: int) -> tuple[list[str], bool]:
    """Remove an artificial loss when the first timed-out self-play peer leaves.

    Burnysc2 tests the cap before preparing the new bot observation, so its last
    state may trail the cap by one step. A Tie near that cap identifies this
    boundary; earlier engine ties and ordinary completed wins remain unchanged.
    """
    at_cap = any(float(bot.time) >= max_game_seconds - step_mul / 22.4 - 1e-6 for bot in bots)
    if "Tie" not in result_names or not at_cap:
        return result_names, False
    from sc2.data import Result

    for index, bot in enumerate(bots):
        if bot.transitions:
            transition = bot.transitions[-1]
            if transition.terminated:
                observation = getattr(bot, "_last_observation", None)
                if observation is None:
                    raise RuntimeError("Time-limit correction has no final observation for value bootstrap")
                original_result = getattr(getattr(bot, "result", None), "name", result_names[index])
                outcome = 1.0 if original_result == "Victory" else -1.0 if original_result == "Defeat" else 0.0
                # A terminal reward is outcome - shaping*old_potential. Restore
                # its omitted next-state potential and remove only the outcome.
                if getattr(bot, "reward_config", None) is not None:
                    corrected_reward = transition.reward + bot.correct_reward_timeout()
                else:
                    corrected_reward = (transition.reward - outcome
                                        + bot.reward_shaping * bot.gamma * bot._potential())
                bot.transitions[-1] = replace(
                    transition, reward=float(corrected_reward), next_value=bot.policy.value(observation),
                    terminated=False, truncated=True,
                )
        bot._time_limited = True
        bot.result = Result.Tie
    return ["Tie"] * len(result_names), True


def play_match(policy: Policy, map_name: str, *, opponent: str = "builtin", difficulty: str = "Easy",
               opponent_race: str = "Random", realtime: bool = False, record: bool = False,
               max_game_seconds: int = 1200, step_mul: int = 8, seed: int = 1,
               replay_path: Path | None = None, gamma: float = 1.0,
               reward_shaping: float = .1, deterministic: bool = False,
               reward_config=None, reward_reference=None) -> tuple[list, dict]:
    from sc2.data import Difficulty, Race
    from sc2.main import run_game
    from sc2.player import Bot, Computer, Human
    from pluto_sc2.sc2_adapter import NeuralBot

    if (isinstance(max_game_seconds, bool) or not isinstance(max_game_seconds, numbers.Real)
            or not math.isfinite(max_game_seconds) or max_game_seconds <= 0
            or type(step_mul) is not int or step_mul != 8):
        raise ValueError("Game duration must be positive and this observation schema requires step_mul=8")
    if isinstance(seed, bool) or not isinstance(seed, int) or not 0 <= seed < 2**32:
        raise ValueError("seed must be an integer in 0..4294967295")
    if opponent_race not in ("Protoss", "Terran", "Zerg", "Random"):
        raise ValueError("Opponent race must be Protoss, Terran, Zerg, or Random")
    if opponent == "human" and not realtime:
        raise ValueError("Human matches require realtime play")
    reward_options = ({"reward_config": reward_config, "reward_reference": reward_reference}
                      if reward_config is not None else {})
    bots = [NeuralBot(policy, record=record, deterministic=deterministic,
                      max_game_seconds=max_game_seconds, step_mul=step_mul,
                      gamma=gamma, reward_shaping=reward_shaping, expected_start_workers=8, **reward_options)]
    # The former "Pluto-inspired Protoss" label produced a toon handle rejected
    # by SC2's replay parser. This label is verified with a saved local replay.
    players = [Bot(Race.Protoss, bots[0], name="Protoss learner")]
    if opponent == "self":
        bots.append(NeuralBot(policy, record=record, deterministic=deterministic,
                              max_game_seconds=max_game_seconds, step_mul=step_mul,
                              gamma=gamma, reward_shaping=reward_shaping, expected_start_workers=8, **reward_options))
        players.append(Bot(Race.Protoss, bots[1], name="Protoss snapshot"))
    elif opponent == "builtin":
        if difficulty not in ("VeryEasy", "Easy", "Medium", "MediumHard", "Hard", "Harder", "VeryHard"):
            raise ValueError("Choose a non-cheating built-in difficulty (VeryEasy through VeryHard)")
        players.append(Computer(Race[opponent_race], Difficulty[difficulty]))
    elif opponent == "human":
        players.append(Human(Race[opponent_race]))
    else:
        raise ValueError(f"Unsupported opponent: {opponent}")
    if replay_path:
        replay_path.parent.mkdir(parents=True, exist_ok=True)
    started = time.monotonic()
    with spatial_client():
        results = run_game(resolve_map(map_name), players, realtime=realtime,
                           random_seed=seed, disable_fog=False,
                           game_time_limit=max_game_seconds,
                           save_replay_as=str(replay_path.resolve()) if replay_path else None)
    # The game library converts on_start errors into losses; never train on those.
    errors = [str(bot.error) for bot in bots if getattr(bot, "error", None)]
    if errors:
        raise RuntimeError("; ".join(errors))
    if any(not getattr(bot, "_episode_finished", False) for bot in bots):
        raise RuntimeError("SC2 did not complete every bot episode; refusing incomplete match data")
    result_items = results if isinstance(results, (list, tuple)) else [results]
    if any(getattr(result, "name", None) not in ("Victory", "Defeat", "Tie") for result in result_items):
        raise RuntimeError("SC2 returned an absent or invalid match result")
    result_names = [result.name for result in result_items]
    engine_results = result_names.copy()
    result_names, time_limit_reached = _normalize_time_limit(bots, result_names, max_game_seconds, step_mul)
    audit = []
    for bot in bots:
        controller = bot.fairplay
        summary = controller.summary()
        validate_action_audit({"summary": summary, "actions": controller.audit})
        audit.append(summary)
    return bots, {"results": result_names, "engine_results": engine_results,
                  "time_limit_reached": time_limit_reached, "wall_seconds": time.monotonic() - started,
                  "opponent": opponent, "opponent_race": opponent_race, "difficulty": difficulty, "seed": seed,
                  "action_selection": "greedy" if deterministic else "sampled",
                  "fairplay": audit, "game_seconds": [float(bot.time) for bot in bots],
                  "policy_actions": [dict(bot.action_counts) for bot in bots],
                  "rejected_policy_actions": [dict(bot.rejected_policy_actions) for bot in bots],
                  "forfeits": [getattr(bot, "forfeit_reason", None) for bot in bots],
                  "control_rules": [getattr(bot, "control_summary", None) for bot in bots],
                  "reward_breakdown": [getattr(bot, "reward_summary", None) for bot in bots]}


def _training_transitions(bots: list, policy: Policy) -> list:
    transitions = []
    for bot in bots:
        if getattr(bot, "error", None) or not getattr(bot, "_episode_finished", False):
            raise RuntimeError("Refusing to train on a failed or incomplete bot episode")
        if bot.policy is not policy:
            raise RuntimeError("PPO rollout must come from the current training policy")
        if not bot.transitions:
            raise RuntimeError("Match produced no training transitions for a bot")
        if not (bot.transitions[-1].terminated or bot.transitions[-1].truncated):
            raise RuntimeError("Each player's rollout must end at an explicit episode boundary")
        if any(item.terminated or item.truncated for item in bot.transitions[:-1]):
            raise RuntimeError("A single-match rollout contains an unexpected internal episode boundary")
        validate_action_audit({"summary": bot.fairplay.summary(), "actions": bot.fairplay.audit})
        transitions.extend(bot.transitions)
    if not transitions:
        raise RuntimeError("Match produced no training transitions")
    return transitions


def train(*, map_name: str, output: str | Path, games: int = 100, resume: str | None = None,
          opponent: str = "self", difficulty: str = "Easy", opponent_race: str = "Random",
          max_game_seconds: int = 1200, step_mul: int = 8, seed: int = 1,
          hidden_dim: int = 256, device: str = "cpu", config: PPOConfig | None = None,
          reward_shaping: float = .1, save_replays_every: int = 1) -> dict:
    if type(games) is not int or games < 1 or type(save_replays_every) is not int or save_replays_every < 0:
        raise ValueError("games must be positive and save_replays_every nonnegative")
    if (isinstance(reward_shaping, bool) or not isinstance(reward_shaping, numbers.Real)
            or not math.isfinite(reward_shaping) or reward_shaping < 0):
        raise ValueError("reward_shaping must be finite and nonnegative")
    config = config or PPOConfig()
    output = Path(output).resolve()
    output.mkdir(parents=True, exist_ok=True)
    with FileLock(str(output / ".training.lock"), timeout=0):
        if (output / "latest.pt").exists() and not resume:
            raise ValueError("Output already contains a checkpoint; use --resume or choose a new output folder")
        if (output / "latest.pt").exists() and Path(resume).expanduser().resolve() != output / "latest.pt":
            raise ValueError("Existing output must resume its own latest.pt; use a new output folder "
                             "to start from a different or older checkpoint")
        seed_everything(seed)
        reference_source = None
        resume_digest = None
        training_ancestry = {"version": 1, "known_train_replay_ids": [], "complete": True}
        if resume:
            resume = str(Path(resume).expanduser().resolve())
            with Path(resume).open("rb") as source_stream:
                resume_digest = hashlib.file_digest(source_stream, "sha256").hexdigest()
            policy, loaded = load_policy(resume, device)
            from pluto_sc2.replays import _checkpoint_training_ancestry
            known_train_ids, history_complete = _checkpoint_training_ancestry(loaded["metadata"])
            training_ancestry = {"version": 1, "known_train_replay_ids": known_train_ids,
                                 "complete": history_complete}
            old_config = loaded.get("config")
            stage = loaded["metadata"].get("stage")
            if stage not in ("reinforcement", "imitation"):
                raise ValueError("Training resume requires an imitation or reinforcement checkpoint")
            if stage == "reinforcement" and old_config != config:
                raise ValueError("Resume requires the saved PPO configuration; use its original CLI settings")
            reference = policy if stage == "imitation" else loaded.get("reference_policy")
            reference_source = ({"checkpoint_sha256": resume_digest,
                                 "train_replay_ids": loaded["metadata"].get("train_replay_ids", []),
                                 "validation_replay_ids": loaded["metadata"].get("validation_replay_ids", [])}
                                if stage == "imitation" else loaded["metadata"].get("reference_source"))
            if loaded["metadata"].get("reference_enabled") and reference is None:
                raise ValueError("Reinforcement checkpoint is missing its original supervised reference policy")
            trainer = PPOTrainer(policy, config, reference_policy=reference)
            if stage == "reinforcement":
                if loaded.get("optimizer_state") is None:
                    raise ValueError("Reinforcement checkpoint has no resumable optimizer state")
                load_checkpoint(resume, policy=policy, optimizer=trainer.optimizer, restore_rng=True)
            completed = int(loaded.get("counters", {}).get("games", 0)) if stage == "reinforcement" else 0
        else:
            policy = Policy(OBSERVATION_SIZE, len(ACTION_NAMES), hidden_dim).to(device_name(device))
            trainer = PPOTrainer(policy, config)
            completed = 0
        if seed + completed + games >= 2**32:
            raise ValueError("seed plus total game count exceeds SC2's unsigned 32-bit seed range")
        write_json(output / "run.json", {**model_metadata(stage="reinforcement"),
                   "map": map_name, "opponent": opponent, "ppo": asdict(config),
                   "step_mul": step_mul, "seed": seed, "max_game_seconds": max_game_seconds,
                   "difficulty": difficulty, "opponent_race": opponent_race,
                   "reward_shaping": reward_shaping,
                   "reference_enabled": trainer.reference_policy is not None and config.reference_kl_coef > 0,
                   "reference_source": reference_source, "resume_sha256": resume_digest,
                   "training_ancestry": training_ancestry,
                   "device": str(next(policy.parameters()).device), "resume": resume})
        last_metrics = {}
        for _ in range(games):
            game = completed + 1
            replay = output / "replays" / f"game-{game:06d}.SC2Replay" if (
                save_replays_every and game % save_replays_every == 0) else None
            try:
                bots, match = play_match(policy, map_name, opponent=opponent, difficulty=difficulty,
                                         opponent_race=opponent_race, record=True,
                                         max_game_seconds=max_game_seconds, step_mul=step_mul,
                                         seed=seed + game, replay_path=replay, gamma=config.gamma,
                                         reward_shaping=reward_shaping)
                transitions = _training_transitions(bots, policy)
                last_metrics = trainer.update(transitions)
                completed = game
                for player, bot in enumerate(bots, 1):
                    write_json(output / "audits" / f"game-{game:06d}-p{player}.json",
                               {"summary": bot.fairplay.summary(), "actions": bot.fairplay.audit})
                record = {"game": game, **match, "ppo": last_metrics}
                append_json(output / "metrics.jsonl", record)
                save_checkpoint(output / "latest.pt", policy, optimizer=trainer.optimizer,
                                config=config, counters={"games": completed},
                                reference_policy=trainer.reference_policy,
                                metadata=model_metadata(stage="reinforcement", seed=seed,
                                                        source_checkpoint=resume,
                                                        source_checkpoint_sha256=resume_digest,
                                                        training_ancestry=training_ancestry,
                                                        reference_source=reference_source,
                                                        reference_enabled=trainer.reference_policy is not None
                                                        and config.reference_kl_coef > 0))
                print(json.dumps(record), flush=True)
            except BaseException as error:
                append_json(output / "failures.jsonl", {"game": game, "error": str(error),
                                                       "kind": type(error).__name__})
                # latest.pt represents the last fully completed update; do not
                # overwrite it with a partially failed optimizer update.
                raise
        return {"checkpoint": str(output / "latest.pt"), "completed_games": completed,
                "last_update": last_metrics}


def evaluate(*, checkpoint: str, map_name: str, output: str, games: int = 10,
             difficulty: str = "Easy", opponent_race: str = "Random", max_game_seconds: int = 1200,
             step_mul: int = 8, seed: int = 10000, device: str = "cpu", deterministic: bool = False) -> dict:
    if type(games) is not int or games < 1:
        raise ValueError("games must be positive")
    output_path = Path(output).expanduser().resolve()
    output_path.mkdir(parents=True, exist_ok=True)
    with FileLock(str(output_path / ".evaluation.lock"), timeout=0):
        if any(path.name != ".evaluation.lock" for path in output_path.iterdir()):
            raise ValueError("Evaluation output is not empty; choose a new output folder to preserve prior results")
        return _evaluate_unlocked(checkpoint=checkpoint, map_name=map_name, output=str(output_path),
                                  games=games, difficulty=difficulty, opponent_race=opponent_race,
                                  max_game_seconds=max_game_seconds, step_mul=step_mul,
                                  seed=seed, device=device, deterministic=deterministic)


def _evaluate_unlocked(*, checkpoint: str, map_name: str, output: str, games: int,
                       difficulty: str, opponent_race: str, max_game_seconds: int,
                       step_mul: int, seed: int, device: str, deterministic: bool) -> dict:
    checkpoint_path = Path(checkpoint).expanduser().resolve()
    with checkpoint_path.open("rb") as stream:
        checkpoint_digest = hashlib.file_digest(stream, "sha256").hexdigest()
    policy, _ = load_policy(str(checkpoint_path), device)
    policy.eval()
    counts: Counter = Counter()
    output_path = Path(output)
    for index in range(games):
        seed_everything(seed + index)
        bots, match = play_match(policy, map_name, opponent="builtin", difficulty=difficulty,
                                opponent_race=opponent_race, deterministic=deterministic,
                                max_game_seconds=max_game_seconds, step_mul=step_mul,
                                seed=seed + index, replay_path=output_path / f"eval-{index:04d}.SC2Replay")
        counts.update(match["results"][:1])
        append_json(output_path / "matches.jsonl", match)
        write_json(output_path / f"audit-{index:04d}.json", {"summary": bots[0].fairplay.summary(),
                                                           "actions": bots[0].fairplay.audit})
    wins = counts["Victory"]
    p = wins / games
    z = 1.96
    denominator = 1 + z * z / games
    center = (p + z * z / (2 * games)) / denominator
    half = z * math.sqrt(p * (1 - p) / games + z * z / (4 * games * games)) / denominator
    summary = {"games": games, "results": dict(counts), "win_rate": p,
               "win_rate_95_percent_interval": [center - half, center + half],
               "checkpoint": str(checkpoint_path), "checkpoint_sha256": checkpoint_digest,
               "difficulty": difficulty, "opponent_race": opponent_race,
               "max_game_seconds": max_game_seconds, "step_mul": step_mul,
               "action_selection": "greedy" if deterministic else "sampled",
               "map": map_name, "seed": seed}
    write_json(output_path / "evaluation.json", summary)
    return summary


def doctor(sc2_path: str | None = None) -> dict:
    from importlib.metadata import version
    default = ("C:/Program Files (x86)/StarCraft II" if sys.platform == "win32" else
               "/Applications/StarCraft II" if sys.platform == "darwin" else "~/StarCraftII")
    root = Path(sc2_path or os.environ.get("SC2PATH", default)).expanduser()
    binary_name = "SC2_x64.exe" if sys.platform == "win32" else "SC2_x64"
    binaries = [path for path in (root / "Versions").glob(f"Base*/{binary_name}") if path.is_file()]
    if sys.platform == "darwin":
        binaries += [path for path in (root / "Versions").glob("Base*/SC2.app/Contents/MacOS/SC2") if path.is_file()]
    return {"python": sys.version.split()[0], "torch": torch.__version__,
            "burnysc2": version("burnysc2"), "cuda_available": torch.cuda.is_available(),
            "sc2_path": str(root), "sc2_binaries": len(binaries),
            "eight_worker_map": "Use a melee map with SC2 5.0.16 or a compatible newer version; "
                                "eight starting workers are verified at runtime",
            "constraints": model_metadata(),
            "sc2tools": str(Path("C:/SC2TOOLS")) if Path("C:/SC2TOOLS").is_dir() else None}
