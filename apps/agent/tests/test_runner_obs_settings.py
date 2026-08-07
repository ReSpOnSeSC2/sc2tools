"""Tests for the OBS settings save path and the GUI's two OBS helpers.

The Qt window itself can't be instantiated under pytest (see the note
at the top of ``test_gui.py``), so this covers everything on the other
side of the widget boundary: what a Save click persists, what it
hot-applies to a running switcher, and what the Test-connection /
Build-scenes round-trips return to the GUI.
"""

from __future__ import annotations

import logging
from pathlib import Path
from types import SimpleNamespace
from typing import Any, Dict, List, Optional

import pytest

from sc2tools_agent import runner
from sc2tools_agent.config import AgentConfig
from sc2tools_agent.live.obs_client import ObsAuthFailed
from sc2tools_agent.live.obs_scene import SCENE_BETWEEN_GAMES, SCENE_IN_GAME
from sc2tools_agent.runner import (
    _apply_obs_settings,
    _handle_obs_build,
    _handle_obs_probe,
)
from sc2tools_agent.state import AgentState
from sc2tools_agent.ui import SettingsPayload

_LOG = logging.getLogger("test_runner_obs_settings")


class FakeController:
    def __init__(self) -> None:
        self.configs: List[Dict[str, Any]] = []

    def set_config(self, **kw: Any) -> None:
        self.configs.append(kw)


class FakeClient:
    def __init__(self) -> None:
        self.reconfigures: List[Dict[str, Any]] = []

    def reconfigure(self, **kw: Any) -> None:
        self.reconfigures.append(kw)


def _cell(controller=None, client=None):
    return SimpleNamespace(obs_scene=controller, obs_client=client)


# ---------------- SettingsPayload ----------------


def test_payload_obs_fields_default_to_no_change() -> None:
    p = SettingsPayload()
    assert p.obs_scene_switch_enabled is None
    assert p.obs_host is None
    assert p.obs_port is None
    assert p.obs_password is None
    assert p.obs_scene_map is None
    assert p.obs_switch_debounce_sec is None
    assert p.obs_switch_on_replays is None


# ---------------- persistence ----------------


def test_save_persists_every_obs_field() -> None:
    state = AgentState()
    payload = SettingsPayload(
        obs_scene_switch_enabled=True,
        obs_host="192.168.1.20",
        obs_port=4460,
        obs_password="pw",
        obs_scene_map={"menu": SCENE_BETWEEN_GAMES, "idle": ""},
        obs_switch_debounce_sec=1.5,
        obs_switch_on_replays=True,
    )
    _apply_obs_settings(state, payload, _cell(), _LOG)

    assert state.obs_scene_switch_enabled is True
    assert state.obs_host == "192.168.1.20"
    assert state.obs_port == 4460
    assert state.obs_password == "pw"
    assert state.obs_scene_map == {"menu": SCENE_BETWEEN_GAMES, "idle": ""}
    assert state.obs_switch_debounce_sec == 1.5
    assert state.obs_switch_on_replays is True


def test_none_fields_leave_state_alone() -> None:
    """Every other Save path in the GUI uses None for "no change"; the
    OBS fields must not be the exception that wipes a config."""
    state = AgentState(
        obs_host="10.0.0.5", obs_port=4499, obs_password="keep",
        obs_scene_map={"menu": "X"},
    )
    _apply_obs_settings(state, SettingsPayload(), _cell(), _LOG)
    assert state.obs_host == "10.0.0.5"
    assert state.obs_port == 4499
    assert state.obs_password == "keep"
    assert state.obs_scene_map == {"menu": "X"}


def test_empty_password_clears_it() -> None:
    """Otherwise there is no way to remove a saved password short of
    hand-editing agent.json."""
    state = AgentState(obs_password="old")
    _apply_obs_settings(state, SettingsPayload(obs_password=""), _cell(), _LOG)
    assert state.obs_password is None


def test_negative_debounce_is_clamped() -> None:
    state = AgentState()
    _apply_obs_settings(
        state, SettingsPayload(obs_switch_debounce_sec=-5), _cell(), _LOG,
    )
    assert state.obs_switch_debounce_sec == 0.0


# ---------------- hot apply ----------------


def test_save_hot_applies_to_a_running_switcher() -> None:
    controller, client = FakeController(), FakeClient()
    state = AgentState(obs_scene_switch_enabled=True)
    _apply_obs_settings(
        state,
        SettingsPayload(
            obs_scene_map={"menu": "Chill"},
            obs_switch_debounce_sec=2.0,
            obs_switch_on_replays=True,
        ),
        _cell(controller, client),
        _LOG,
    )
    assert len(controller.configs) == 1
    cfg = controller.configs[0]
    assert cfg["scene_map"] == {"menu": "Chill"}
    assert cfg["debounce_sec"] == 2.0
    assert cfg["switch_on_replays"] is True


def test_all_blank_scene_map_falls_back_to_the_defaults() -> None:
    """The GUI's Save writes all six phase keys, so "enabled the
    checkbox, never touched the dropdowns" used to persist six blanks
    — which the controller read as "never switch anything". A map with
    no real value in it means unconfigured, not opted out."""
    from sc2tools_agent.live.obs_scene import DEFAULT_SCENE_MAP

    controller = FakeController()
    state = AgentState(obs_scene_switch_enabled=True)
    _apply_obs_settings(
        state,
        SettingsPayload(
            obs_scene_map={
                "menu": "", "idle": "", "match_loading": "",
                "match_started": "", "match_in_progress": "",
                "match_ended": "",
            },
        ),
        _cell(controller, FakeClient()),
        _LOG,
    )
    assert controller.configs[0]["scene_map"] == DEFAULT_SCENE_MAP


def test_partially_configured_map_keeps_explicit_blanks() -> None:
    """One real value makes the map deliberate — its blanks are
    per-phase "don't switch" choices and must survive verbatim."""
    controller = FakeController()
    state = AgentState(obs_scene_switch_enabled=True)
    _apply_obs_settings(
        state,
        SettingsPayload(obs_scene_map={"menu": "Chill", "idle": ""}),
        _cell(controller, FakeClient()),
        _LOG,
    )
    assert controller.configs[0]["scene_map"] == {"menu": "Chill", "idle": ""}


def test_boot_builder_treats_all_blank_map_as_unconfigured() -> None:
    """Same rule at boot: an agent restarted with six persisted blanks
    must come up running the default map, not a dead one."""
    from sc2tools_agent.live.obs_scene import DEFAULT_SCENE_MAP
    from sc2tools_agent.runner import _build_obs_switcher

    class _Bus:
        def subscribe(self, cb: Any) -> None:
            pass

    state = AgentState(
        obs_scene_switch_enabled=True,
        obs_scene_map={
            "menu": "", "idle": "", "match_loading": "",
            "match_started": "", "match_in_progress": "", "match_ended": "",
        },
    )
    _, ctrl = _build_obs_switcher(
        state=state, bridge=SimpleNamespace(bus=_Bus()), log=_LOG,
    )
    try:
        assert ctrl is not None
        assert ctrl._scene_map == DEFAULT_SCENE_MAP
    finally:
        if ctrl:
            ctrl.shutdown()


def test_scene_map_change_alone_does_not_drop_the_connection() -> None:
    """Reconnecting mid-stream because someone re-mapped a dropdown
    would be a needless blip."""
    controller, client = FakeController(), FakeClient()
    state = AgentState(
        obs_scene_switch_enabled=True, obs_host="127.0.0.1", obs_port=4455,
    )
    _apply_obs_settings(
        state,
        SettingsPayload(
            obs_host="127.0.0.1",
            obs_port=4455,
            obs_scene_map={"menu": "Chill"},
        ),
        _cell(controller, client),
        _LOG,
    )
    assert client.reconfigures == []


def test_changing_the_host_triggers_a_reconnect() -> None:
    controller, client = FakeController(), FakeClient()
    state = AgentState(obs_scene_switch_enabled=True, obs_host="127.0.0.1")
    _apply_obs_settings(
        state,
        SettingsPayload(obs_host="192.168.0.4"),
        _cell(controller, client),
        _LOG,
    )
    assert client.reconfigures == [
        {"host": "192.168.0.4", "port": 4455, "password": None},
    ]


def test_changing_the_password_triggers_a_reconnect() -> None:
    controller, client = FakeController(), FakeClient()
    state = AgentState(obs_scene_switch_enabled=True, obs_password="old")
    _apply_obs_settings(
        state, SettingsPayload(obs_password="new"), _cell(controller, client),
        _LOG,
    )
    assert len(client.reconfigures) == 1


def test_save_without_a_bridge_persists_and_waits_for_restart() -> None:
    """With no live bridge in the cell (--no-live) there are no phase
    events to react to — enabling saves and waits for a restart rather
    than exploding on a missing controller."""
    state = AgentState()
    cell = _cell()
    _apply_obs_settings(
        state, SettingsPayload(obs_scene_switch_enabled=True), cell, _LOG,
    )
    assert state.obs_scene_switch_enabled is True
    assert cell.obs_scene is None


def test_enabling_from_settings_starts_the_switcher_live() -> None:
    """Ticking the checkbox and clicking Save must produce a running
    switcher, not a silent restart requirement — "save, queue a game,
    nothing happens" was indistinguishable from the feature being
    broken."""

    class _Bus:
        def __init__(self) -> None:
            self.subscribed: List[Any] = []

        def subscribe(self, cb: Any) -> None:
            self.subscribed.append(cb)

    bus = _Bus()
    cell = SimpleNamespace(
        obs_scene=None,
        obs_client=None,
        live_bridge=SimpleNamespace(bus=bus),
    )
    state = AgentState()
    _apply_obs_settings(
        state,
        SettingsPayload(obs_scene_switch_enabled=True),
        cell,
        _LOG,
    )
    try:
        assert cell.obs_scene is not None, "switcher must start on enable"
        assert cell.obs_client is not None
        assert cell.obs_client.started is True
        assert bus.subscribed == [cell.obs_scene.listener]
    finally:
        if cell.obs_scene is not None:
            cell.obs_scene.shutdown()


def test_controller_failure_does_not_break_the_save() -> None:
    class Boom:
        def set_config(self, **kw: Any) -> None:
            raise RuntimeError("nope")

    state = AgentState(obs_scene_switch_enabled=True)
    _apply_obs_settings(
        state, SettingsPayload(obs_switch_debounce_sec=1.0),
        _cell(Boom(), FakeClient()), _LOG,
    )
    # The value is still persisted — the user's other settings on the
    # same Save click must not be lost to an OBS hiccup.
    assert state.obs_switch_debounce_sec == 1.0


# ---------------- Test connection ----------------


class ProbeClient:
    """Stand-in for ObsClient in the probe/build handlers."""

    instances: List["ProbeClient"] = []

    connect_error: Optional[BaseException] = None
    scenes: List[str] = ["Gameplay", "BRB"]
    inputs: List[Dict[str, Any]] = [
        {"name": "Cam", "kind": "dshow_input"},
        {"name": "SC2", "kind": "game_capture"},
    ]
    scene_items: Dict[str, List[Dict[str, Any]]] = {}
    input_settings: Dict[str, Dict[str, Any]] = {}
    next_item_id: int = 100
    inventory_error: Optional[BaseException] = None

    def __init__(self, **kw: Any) -> None:
        self.kwargs = kw
        self.shutdown_called = False
        self.started = False
        ProbeClient.instances.append(self)

    def start(self) -> None:
        # The late-build path in _apply_obs_settings starts the client
        # it constructs; the probe/build handlers never call this.
        self.started = True

    def connect_now(self) -> bool:
        if ProbeClient.connect_error:
            raise ProbeClient.connect_error
        return True

    def get_version(self) -> Dict[str, Any]:
        return {"obs_version": "30.1.2", "websocket_version": "5.4.2"}

    def refresh_scenes(self) -> List[str]:
        return list(ProbeClient.scenes)

    @property
    def scene_names(self) -> List[str]:
        return list(ProbeClient.scenes)

    def get_input_list(self, kind: Optional[str] = None) -> List[Dict[str, Any]]:
        return list(ProbeClient.inputs)

    def get_video_settings(self) -> Dict[str, Any]:
        return {"base_width": 1920, "base_height": 1080}

    def get_input_settings(self, name: str) -> Dict[str, Any]:
        return dict(ProbeClient.input_settings.get(name, {}))

    def get_scene_item_list(self, scene_name: str) -> List[Dict[str, Any]]:
        if ProbeClient.inventory_error is not None:
            raise ProbeClient.inventory_error
        return [
            {**item, "transform": dict(item.get("transform") or {})}
            for item in ProbeClient.scene_items.get(scene_name, [])
        ]

    def create_scene(self, name: str) -> None:
        ProbeClient.scenes.append(name)
        ProbeClient.scene_items[name] = []

    def remove_scene(self, name: str) -> None:
        if name in ProbeClient.scenes:
            ProbeClient.scenes.remove(name)
        ProbeClient.scene_items.pop(name, None)

    def create_scene_item(self, **kw: Any) -> int:
        ProbeClient.next_item_id += 1
        source_name = str(kw["source_name"])
        kind = next(
            (row["kind"] for row in ProbeClient.inputs if row["name"] == source_name),
            "",
        )
        items = ProbeClient.scene_items.setdefault(kw["scene_name"], [])
        items.append(
            {
                "source_name": source_name,
                "item_id": ProbeClient.next_item_id,
                "index": len(items),
                "input_kind": kind,
                "enabled": True,
                "transform": {},
            },
        )
        return ProbeClient.next_item_id

    def create_input(self, **kw: Any) -> int:
        ProbeClient.next_item_id += 1
        name = str(kw["input_name"])
        ProbeClient.inputs.append({"name": name, "kind": kw["input_kind"]})
        ProbeClient.input_settings[name] = dict(kw["settings"])
        items = ProbeClient.scene_items.setdefault(kw["scene_name"], [])
        items.append(
            {
                "source_name": name,
                "item_id": ProbeClient.next_item_id,
                "index": len(items),
                "input_kind": kw["input_kind"],
                "enabled": bool(kw.get("enabled", True)),
                "transform": {},
            },
        )
        return ProbeClient.next_item_id

    def set_scene_item_transform(self, **kw: Any) -> None:
        item = next(
            row for row in ProbeClient.scene_items[kw["scene_name"]]
            if row["item_id"] == kw["item_id"]
        )
        item["transform"] = dict(kw["transform"])

    def set_scene_item_index(self, **kw: Any) -> None:
        items = sorted(
            ProbeClient.scene_items[kw["scene_name"]],
            key=lambda row: row["index"],
        )
        moving = next(row for row in items if row["item_id"] == kw["item_id"])
        items.remove(moving)
        items.insert(max(0, min(int(kw["index"]), len(items))), moving)
        for index, item in enumerate(items):
            item["index"] = index
        ProbeClient.scene_items[kw["scene_name"]] = items

    def set_scene_item_enabled(self, **kw: Any) -> None:
        item = next(
            row for row in ProbeClient.scene_items[kw["scene_name"]]
            if row["item_id"] == kw["item_id"]
        )
        item["enabled"] = bool(kw["enabled"])

    def shutdown(self) -> None:
        self.shutdown_called = True


@pytest.fixture(autouse=True)
def _patch_client(monkeypatch):
    ProbeClient.instances = []
    ProbeClient.connect_error = None
    ProbeClient.scenes = ["Gameplay", "BRB"]
    ProbeClient.inputs = [
        {"name": "Cam", "kind": "dshow_input"},
        {"name": "SC2", "kind": "game_capture"},
    ]
    ProbeClient.scene_items = {}
    ProbeClient.input_settings = {}
    ProbeClient.next_item_id = 100
    ProbeClient.inventory_error = None
    monkeypatch.setattr(runner, "ObsClient", ProbeClient)
    yield


def test_probe_reports_version_scenes_and_sources() -> None:
    result = _handle_obs_probe(
        host="127.0.0.1", port=4455, password="pw", log=_LOG,
    )
    assert result["ok"] is True
    assert "30.1.2" in result["message"]
    assert result["scenes"] == ["Gameplay", "BRB"]
    assert result["webcams"] == ["Cam"]
    assert result["games"] == ["SC2"]


def test_probe_reports_legacy_scenes_that_need_the_priority_update() -> None:
    ProbeClient.scenes = [SCENE_BETWEEN_GAMES, SCENE_IN_GAME]
    ProbeClient.scene_items = {
        SCENE_BETWEEN_GAMES: [],
        SCENE_IN_GAME: [],
    }

    result = _handle_obs_probe(
        host="127.0.0.1", port=4455, password="pw", log=_LOG,
    )

    assert result["ok"] is True
    assert result["manual_override_update_scenes"] == [
        SCENE_BETWEEN_GAMES,
        SCENE_IN_GAME,
    ]
    assert "priority update" in result["message"]


def test_probe_inventory_failure_keeps_the_connection_result_useful() -> None:
    ProbeClient.scenes = [SCENE_BETWEEN_GAMES, SCENE_IN_GAME]
    ProbeClient.inventory_error = RuntimeError("inventory unavailable")

    result = _handle_obs_probe(
        host="127.0.0.1", port=4455, password="pw", log=_LOG,
    )

    assert result["ok"] is True
    assert "30.1.2" in result["message"]
    assert result["manual_override_update_scenes"] == []
    assert ProbeClient.instances[0].shutdown_called is True


def test_probe_closes_its_throwaway_client() -> None:
    """It must not leave a socket open, and must not disturb the
    long-running switcher's own connection."""
    _handle_obs_probe(host="127.0.0.1", port=4455, password="", log=_LOG)
    assert ProbeClient.instances[0].shutdown_called is True
    # No event subscription: this client is transient.
    assert ProbeClient.instances[0].kwargs["subscribe_events"] is False


def test_probe_reports_a_bad_password_actionably() -> None:
    ProbeClient.connect_error = ObsAuthFailed("denied")
    result = _handle_obs_probe(
        host="127.0.0.1", port=4455, password="wrong", log=_LOG,
    )
    assert result["ok"] is False
    assert "password" in result["message"].lower()


def test_probe_reports_obs_not_running() -> None:
    ProbeClient.connect_error = ConnectionRefusedError("refused")
    result = _handle_obs_probe(
        host="127.0.0.1", port=4455, password="", log=_LOG,
    )
    assert result["ok"] is False
    assert "WebSocket server is enabled" in result["message"]


# ---------------- Build scenes ----------------


def _cfg(tmp_path: Path) -> AgentConfig:
    return AgentConfig(
        api_base="https://api.sc2tools.com",
        state_dir=tmp_path,
        replay_folder=None,
        poll_interval_sec=10,
        parse_concurrency=1,
    )


def test_build_requires_an_overlay_token(tmp_path: Path, monkeypatch) -> None:
    state = AgentState(device_token=None)
    result = _handle_obs_build(
        cfg=_cfg(tmp_path), state=state, request={}, log=_LOG,
    )
    assert result["ok"] is False
    assert "pair" in result["message"].lower()
    # Nothing was written to OBS.
    assert ProbeClient.instances == []


def test_build_creates_both_scenes(tmp_path: Path, monkeypatch) -> None:
    monkeypatch.setattr(
        runner, "_overlay_token_for_build", lambda cfg, state, log: "tok",
    )
    result = _handle_obs_build(
        cfg=_cfg(tmp_path),
        state=AgentState(device_token="dev"),
        request={"webcam_source": "Cam", "game_source": "SC2"},
        log=_LOG,
    )
    assert result["ok"] is True, result["message"]
    assert SCENE_BETWEEN_GAMES in ProbeClient.scenes
    assert SCENE_IN_GAME in ProbeClient.scenes


def test_build_updates_existing_generated_scenes_without_clobbering(
    tmp_path: Path, monkeypatch,
) -> None:
    monkeypatch.setattr(
        runner, "_overlay_token_for_build", lambda cfg, state, log: "tok",
    )
    ProbeClient.scenes = ["Gameplay", SCENE_BETWEEN_GAMES]
    ProbeClient.scene_items[SCENE_BETWEEN_GAMES] = [
        {
            "source_name": "Custom Stats Ticker",
            "item_id": 77,
            "index": 0,
            "input_kind": "browser_source",
            "transform": {},
        },
    ]
    ProbeClient.inputs.append(
        {"name": "Custom Stats Ticker", "kind": "browser_source"},
    )
    ProbeClient.input_settings["Custom Stats Ticker"] = {
        "url": "https://example.com/custom",
    }
    result = _handle_obs_build(
        cfg=_cfg(tmp_path),
        state=AgentState(device_token="dev"),
        request={
            "webcam_source": "Cam",
            "game_source": "SC2",
            "update_existing_scenes": [SCENE_BETWEEN_GAMES],
        },
        log=_LOG,
    )
    assert result["ok"] is True, result["message"]
    assert "without changing their layout" in result["message"]
    assert "left the missing generated scene(s) untouched" in result["message"]
    assert "Custom Stats Ticker" in [
        item["source_name"]
        for item in ProbeClient.scene_items[SCENE_BETWEEN_GAMES]
    ]
    assert ProbeClient.scene_items[SCENE_BETWEEN_GAMES][-1][
        "source_name"
    ].startswith("SC2 Tools Manual Override")
    assert SCENE_IN_GAME not in ProbeClient.scenes

    # A separate Build creates only the missing counterpart; it still has no
    # permission to rewrite the customized scene we just upgraded.
    between_after_update = [
        dict(item) for item in ProbeClient.scene_items[SCENE_BETWEEN_GAMES]
    ]
    build_missing = _handle_obs_build(
        cfg=_cfg(tmp_path),
        state=AgentState(device_token="dev"),
        request={"webcam_source": "Cam", "game_source": "SC2"},
        log=_LOG,
    )
    assert build_missing["ok"] is True, build_missing["message"]
    assert f"Created 1 missing scene(s): {SCENE_IN_GAME}" in (
        build_missing["message"]
    )
    assert SCENE_IN_GAME in ProbeClient.scenes
    assert ProbeClient.scene_items[SCENE_BETWEEN_GAMES] == between_after_update


def test_build_does_not_infer_permission_to_modify_existing_scenes(
    tmp_path: Path, monkeypatch,
) -> None:
    monkeypatch.setattr(
        runner, "_overlay_token_for_build", lambda cfg, state, log: "tok",
    )
    ProbeClient.scenes = [SCENE_BETWEEN_GAMES, SCENE_IN_GAME]
    ProbeClient.scene_items = {
        SCENE_BETWEEN_GAMES: [],
        SCENE_IN_GAME: [],
    }

    result = _handle_obs_build(
        cfg=_cfg(tmp_path),
        state=AgentState(device_token="dev"),
        request={"webcam_source": "Cam", "game_source": "SC2"},
        log=_LOG,
    )

    assert result["ok"] is False
    assert "use Update my scenes" in result["message"]
    assert ProbeClient.scene_items == {
        SCENE_BETWEEN_GAMES: [],
        SCENE_IN_GAME: [],
    }
    assert not any(
        row["name"].startswith("SC2 Tools Manual Override")
        for row in ProbeClient.inputs
    )


def test_build_rebuild_flag_replaces(tmp_path: Path, monkeypatch) -> None:
    monkeypatch.setattr(
        runner, "_overlay_token_for_build", lambda cfg, state, log: "tok",
    )
    ProbeClient.scenes = ["Gameplay", SCENE_BETWEEN_GAMES]
    result = _handle_obs_build(
        cfg=_cfg(tmp_path),
        state=AgentState(device_token="dev"),
        request={
            "webcam_source": "Cam", "game_source": "SC2", "rebuild": True,
        },
        log=_LOG,
    )
    assert result["ok"] is True, result["message"]
    assert "Gameplay" in ProbeClient.scenes


def test_build_closes_its_client(tmp_path: Path, monkeypatch) -> None:
    monkeypatch.setattr(
        runner, "_overlay_token_for_build", lambda cfg, state, log: "tok",
    )
    _handle_obs_build(
        cfg=_cfg(tmp_path),
        state=AgentState(device_token="dev"),
        request={"webcam_source": "Cam", "game_source": "SC2"},
        log=_LOG,
    )
    assert ProbeClient.instances[0].shutdown_called is True
