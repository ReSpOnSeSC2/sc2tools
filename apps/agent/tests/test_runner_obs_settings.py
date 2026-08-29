"""Tests for the OBS settings save path and the GUI's two OBS helpers.

The Qt window itself can't be instantiated under pytest (see the note
at the top of ``test_gui.py``), so this covers everything on the other
side of the widget boundary: what a Save click persists, what it
hot-applies to a running switcher, and what the Test-connection /
Build-scenes round-trips return to the GUI.
"""

from __future__ import annotations

import logging
import threading
from pathlib import Path
from types import SimpleNamespace
from typing import Any, Dict, List, Optional

import pytest

from sc2tools_agent import runner
from sc2tools_agent.config import AgentConfig
from sc2tools_agent.live.obs_client import ObsAuthFailed
from sc2tools_agent.live.obs_layout import CHAT_ALERTS_INPUT_NAME
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


def test_disabling_hot_applies_false_to_a_running_switcher() -> None:
    controller, client = FakeController(), FakeClient()
    state = AgentState(obs_scene_switch_enabled=True)

    _apply_obs_settings(
        state,
        SettingsPayload(obs_scene_switch_enabled=False),
        _cell(controller, client),
        _LOG,
    )

    assert state.obs_scene_switch_enabled is False
    assert controller.configs[-1]["enabled"] is False


def test_no_obs_flag_rejects_a_later_gui_enable() -> None:
    """The command-line safety gate remains authoritative after boot."""
    cell = runner._RuntimeCell()
    cell.no_obs = True
    cell.live_bridge = SimpleNamespace(
        bus=SimpleNamespace(subscribe=lambda _cb: None),
    )
    state = AgentState(obs_scene_switch_enabled=False)

    with pytest.raises(RuntimeError, match="--no-obs is active"):
        _apply_obs_settings(
            state,
            SettingsPayload(obs_scene_switch_enabled=True),
            cell,
            _LOG,
        )

    assert state.obs_scene_switch_enabled is False
    assert cell.obs_scene is None
    assert cell.obs_client is None


def test_concurrent_startup_enable_builds_only_one_subscribed_controller(
    monkeypatch,
) -> None:
    """GUI hot-enable racing boot must not leave an orphan switcher alive."""
    build_calls: List[int] = []

    class _Client:
        def start(self) -> None:
            pass

    class _Controller(FakeController):
        listener = object()

        def start(self) -> None:
            pass

    controller = _Controller()

    def build(**_kwargs: Any):
        build_calls.append(1)
        return _Client(), controller

    monkeypatch.setattr(runner, "_build_obs_switcher", build)
    cell = runner._RuntimeCell()
    cell.live_bridge = SimpleNamespace(bus=SimpleNamespace(subscribe=lambda _cb: None))
    state = AgentState()
    barrier = threading.Barrier(3)

    def enable() -> None:
        barrier.wait()
        _apply_obs_settings(
            state,
            SettingsPayload(obs_scene_switch_enabled=True),
            cell,
            _LOG,
        )

    threads = [threading.Thread(target=enable) for _ in range(2)]
    for thread in threads:
        thread.start()
    barrier.wait()
    for thread in threads:
        thread.join(timeout=2.0)

    assert all(not thread.is_alive() for thread in threads)
    assert len(build_calls) == 1
    assert cell.obs_scene is controller


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


def test_obs_connect_auto_repairs_legacy_generated_scene_covers() -> None:
    """An auto-started agent must migrate old layouts without a Settings trip."""
    from sc2tools_agent.runner import _build_obs_switcher

    class _Bus:
        def subscribe(self, cb: Any) -> None:
            pass

    ProbeClient.scenes = [SCENE_BETWEEN_GAMES, SCENE_IN_GAME]
    ProbeClient.inputs = [
        {"name": "SC2 Tools Backdrop", "kind": "browser_source"},
        {"name": "SC2 Tools Session Stats", "kind": "browser_source"},
        {"name": "SC2 Tools Chat", "kind": "browser_source"},
        {"name": "Cam", "kind": "dshow_input"},
        {"name": "SC2", "kind": "game_capture"},
    ]
    ProbeClient.input_settings = {
        "SC2 Tools Backdrop": {
            "url": "https://sc2tools.com/overlay/tok/scene/between-games",
        },
        "SC2 Tools Session Stats": {
            "url": "https://sc2tools.com/overlay/tok/widget/session",
        },
        "SC2 Tools Chat": {
            "url": "https://sc2tools.com/overlay/tok/widget/multichat",
        },
    }
    ProbeClient.scene_items = {
        SCENE_BETWEEN_GAMES: [
            {
                "source_name": "SC2 Tools Backdrop",
                "item_id": 1,
                "index": 0,
                "input_kind": "browser_source",
                "enabled": True,
                "transform": {},
            },
            {
                "source_name": "Cam",
                "item_id": 2,
                "index": 1,
                "input_kind": "dshow_input",
                "enabled": True,
                "transform": {"custom": "preserve"},
            },
            {
                "source_name": "SC2 Tools Session Stats",
                "item_id": 4,
                "index": 2,
                "input_kind": "browser_source",
                "enabled": True,
                "transform": {},
            },
            {
                "source_name": "SC2 Tools Chat",
                "item_id": 5,
                "index": 3,
                "input_kind": "browser_source",
                "enabled": True,
                "transform": {},
            },
        ],
        SCENE_IN_GAME: [
            {
                "source_name": "SC2",
                "item_id": 3,
                "index": 0,
                "input_kind": "game_capture",
                "enabled": True,
                "transform": {"custom": "preserve"},
            },
        ],
    }
    state = AgentState(obs_scene_switch_enabled=True)
    client, ctrl = _build_obs_switcher(
        state=state,
        bridge=SimpleNamespace(bus=_Bus()),
        log=_LOG,
    )
    assert client is not None
    try:
        on_connected = client.kwargs["on_connected"]
        on_connected()
        assert len(ProbeClient.instances) == 2
        assert ProbeClient.instances[0] is client
        assert ProbeClient.instances[0].shutdown_called is False
        assert ProbeClient.instances[1].shutdown_called is True
        assert ProbeClient.instances[1].kwargs["subscribe_events"] is False

        manual_inputs = [
            row for row in ProbeClient.inputs
            if row["name"].startswith("SC2 Tools Manual Override")
        ]
        assert len(manual_inputs) == 1
        manual_name = manual_inputs[0]["name"]
        assert ProbeClient.input_settings[manual_name]["url"] == (
            "https://sc2tools.com/overlay/tok/scene/manual?audio=1"
        )
        alert_inputs = [
            row for row in ProbeClient.inputs
            if row["name"].startswith(CHAT_ALERTS_INPUT_NAME)
        ]
        assert len(alert_inputs) == 1
        alert_name = alert_inputs[0]["name"]
        assert ProbeClient.input_settings[alert_name]["url"] == (
            "https://sc2tools.com/overlay/tok/widget/chat-alerts?audio=1"
        )
        for scene_name in (SCENE_BETWEEN_GAMES, SCENE_IN_GAME):
            assert ProbeClient.scene_items[scene_name][-2]["source_name"] == (
                manual_name
            )
            assert ProbeClient.scene_items[scene_name][-1]["source_name"] == (
                alert_name
            )
        assert ProbeClient.scene_items[SCENE_BETWEEN_GAMES][1]["transform"] == {
            "custom": "preserve",
        }
        assert ProbeClient.scene_items[SCENE_IN_GAME][0]["transform"] == {
            "custom": "preserve",
        }

        counts = (
            len(ProbeClient.inputs),
            sum(len(items) for items in ProbeClient.scene_items.values()),
        )
        on_connected()
        assert (
            len(ProbeClient.inputs),
            sum(len(items) for items in ProbeClient.scene_items.values()),
        ) == counts
    finally:
        if ctrl:
            ctrl.shutdown()


def test_obs_connect_references_live_alert_input_in_owned_vertical_layout() -> None:
    """The portrait migration runs even without generated builder scenes."""
    from sc2tools_agent.runner import _build_obs_switcher

    class _Bus:
        def subscribe(self, cb: Any) -> None:
            pass

    token_root = "https://sc2tools.com/overlay/tok"
    ProbeClient.scenes = ["Live Scene", "Vertical Scene"]
    ProbeClient.inputs = [
        {"name": "Alert Box", "kind": "browser_source"},
        {"name": "Chat", "kind": "browser_source"},
        {"name": "BRB/Starting Soon - Vertical", "kind": "browser_source"},
        {"name": "Camera", "kind": "dshow_input"},
    ]
    ProbeClient.input_settings = {
        "Alert Box": {"url": f"{token_root}/widget/chat-alerts"},
        "Chat": {"url": f"{token_root}/widget/multichat"},
        "BRB/Starting Soon - Vertical": {
            "url": f"{token_root}/widget/stream-scene",
            "width": 1080,
            "height": 1920,
        },
    }
    ProbeClient.scene_items = {
        "Live Scene": [
            {
                "source_name": "Alert Box", "item_id": 1, "index": 0,
                "input_kind": "browser_source", "enabled": False,
                "transform": {"live_geometry": "preserve"},
            },
            {
                "source_name": "Camera", "item_id": 5, "index": 1,
                "input_kind": "dshow_input", "enabled": True,
                "transform": {"custom": "also preserve"},
            },
        ],
        "Vertical Scene": [
            {
                "source_name": "Camera", "item_id": 2, "index": 0,
                "input_kind": "dshow_input", "enabled": True,
                "transform": {"custom": "preserve"},
            },
            {
                "source_name": "Chat", "item_id": 3, "index": 1,
                "input_kind": "browser_source", "enabled": True,
                "transform": {},
            },
            {
                "source_name": "BRB/Starting Soon - Vertical",
                "item_id": 4, "index": 2, "input_kind": "browser_source",
                "enabled": True, "transform": {},
            },
        ],
    }
    client, ctrl = _build_obs_switcher(
        state=AgentState(obs_scene_switch_enabled=True),
        bridge=SimpleNamespace(bus=_Bus()),
        log=_LOG,
    )
    assert client is not None
    try:
        on_connected = client.kwargs["on_connected"]
        on_connected()
        assert ProbeClient.scene_items["Vertical Scene"][-1]["source_name"] == (
            "Alert Box"
        )
        assert ProbeClient.scene_items["Live Scene"][-1]["source_name"] == (
            "Alert Box"
        )
        assert ProbeClient.scene_items["Live Scene"][-1]["enabled"] is True
        assert ProbeClient.scene_items["Live Scene"][-1]["transform"] == {
            "live_geometry": "preserve",
        }
        assert ProbeClient.scene_items["Vertical Scene"][0]["transform"] == {
            "custom": "preserve",
        }
        assert [row["name"] for row in ProbeClient.inputs].count("Alert Box") == 1

        counts = (
            len(ProbeClient.inputs),
            len(ProbeClient.scene_items["Vertical Scene"]),
        )
        on_connected()
        assert (
            len(ProbeClient.inputs),
            len(ProbeClient.scene_items["Vertical Scene"]),
        ) == counts
    finally:
        if ctrl:
            ctrl.shutdown()


def test_obs_connect_assigns_roles_to_native_chat_alert_copies_once() -> None:
    """Startup keeps native viewports while Live/Aitum owns all sound."""
    from sc2tools_agent.runner import _build_obs_switcher

    class _Bus:
        def subscribe(self, cb: Any) -> None:
            pass

    root = "https://sc2tools.com/overlay/tok"
    ProbeClient.scenes = [
        SCENE_BETWEEN_GAMES,
        SCENE_IN_GAME,
        "Live Scene",
        "Vertical Scene",
    ]
    ProbeClient.inputs = [
        {"name": "SC2 Tools Backdrop", "kind": "browser_source"},
        {"name": "SC2 Tools Session Stats", "kind": "browser_source"},
        {"name": "SC2 Tools Chat", "kind": "browser_source"},
        {"name": "Old Generated Alerts", "kind": "browser_source"},
        {"name": "Chat", "kind": "browser_source"},
        {"name": "Alert Box", "kind": "browser_source"},
        {"name": "BRB/Starting Soon - Vertical", "kind": "browser_source"},
        {"name": "SC2", "kind": "game_capture"},
    ]
    ProbeClient.input_settings = {
        "SC2 Tools Backdrop": {"url": f"{root}/scene/between-games"},
        "SC2 Tools Session Stats": {"url": f"{root}/widget/session"},
        "SC2 Tools Chat": {"url": f"{root}/widget/multichat"},
        # Legacy builds could already have the correct generated viewport but
        # predate explicit audio roles. Startup must role-correct and reuse
        # this source before manual repair adds the In Game reference; creating
        # a second 1792x360 input here would leave two possible sound owners.
        "Old Generated Alerts": {
            "url": f"{root}/widget/chat-alerts",
            "width": 1792,
            "height": 360,
        },
        "Chat": {
            "url": f"{root}/widget/multichat",
            "height": 1400,
            "custom": "preserve chat settings",
        },
        "Alert Box": {
            "url": f"{root}/widget/chat-alerts",
            "width": 800,
            "height": 600,
            "custom": "preserve alert settings",
        },
        "BRB/Starting Soon - Vertical": {
            "url": f"{root}/widget/stream-scene?audio=0",
            "width": 1080,
            "height": 1920,
            "shutdown": False,
            "reroute_audio": False,
        },
    }

    def _item(
        source: str,
        item_id: int,
        index: int,
        *,
        kind: str = "browser_source",
        enabled: bool = True,
        transform: Optional[Dict[str, Any]] = None,
    ) -> Dict[str, Any]:
        return {
            "source_name": source,
            "item_id": item_id,
            "index": index,
            "input_kind": kind,
            "enabled": enabled,
            "transform": dict(transform or {}),
        }

    ProbeClient.scene_items = {
        SCENE_BETWEEN_GAMES: [
            _item("SC2 Tools Backdrop", 1, 0),
            _item("SC2 Tools Session Stats", 2, 1),
            _item("SC2 Tools Chat", 3, 2, enabled=False),
            _item("Old Generated Alerts", 4, 3),
        ],
        SCENE_IN_GAME: [
            _item("SC2", 5, 0, kind="game_capture"),
            _item("Old Generated Alerts", 6, 1, enabled=False),
        ],
        "Live Scene": [
            _item("Chat", 7, 0),
            _item("Alert Box", 8, 1, transform={"live": "preserve"}),
        ],
        "Vertical Scene": [
            _item("Chat", 9, 0),
            _item("BRB/Starting Soon - Vertical", 10, 1),
        ],
    }
    chat_settings = dict(ProbeClient.input_settings["Chat"])
    alert_settings = dict(ProbeClient.input_settings["Alert Box"])
    client, ctrl = _build_obs_switcher(
        state=AgentState(obs_scene_switch_enabled=True),
        bridge=SimpleNamespace(bus=_Bus()),
        log=_LOG,
    )
    assert client is not None
    try:
        on_connected = client.kwargs["on_connected"]
        on_connected()

        between_sources = [
            item["source_name"]
            for item in ProbeClient.scene_items[SCENE_BETWEEN_GAMES]
        ]
        in_game_sources = [
            item["source_name"]
            for item in ProbeClient.scene_items[SCENE_IN_GAME]
        ]
        native_chat = next(
            name for name in between_sources
            if ProbeClient.input_settings.get(name, {}).get("url", "").endswith(
                "/widget/multichat?audio=0",
            )
        )
        native_alert = next(
            name for name in between_sources
            if ProbeClient.input_settings.get(name, {}).get("url", "").endswith(
                "/widget/chat-alerts?audio=0",
            )
        )
        assert native_chat != "Chat"
        assert native_alert != "Alert Box"
        assert native_alert == "Old Generated Alerts"
        assert native_alert in in_game_sources
        assert "Chat" not in between_sources
        assert "Alert Box" not in between_sources + in_game_sources
        assert "Old Generated Alerts" in between_sources + in_game_sources
        same_token_alert_inputs = {
            name
            for name, settings in ProbeClient.input_settings.items()
            if str(settings.get("url") or "").startswith(
                f"{root}/widget/chat-alerts",
            )
        }
        assert same_token_alert_inputs == {"Alert Box", "Old Generated Alerts"}
        assert ProbeClient.input_settings["Chat"] == {
            **chat_settings,
            "url": f"{root}/widget/multichat?audio=1",
            "shutdown": False,
        }
        assert ProbeClient.input_settings["Alert Box"] == {
            **alert_settings,
            "url": f"{root}/widget/chat-alerts?audio=1",
            "shutdown": False,
        }
        assert (
            ProbeClient.input_settings[native_chat]["width"],
            ProbeClient.input_settings[native_chat]["height"],
        ) == (552, 984)
        assert (
            ProbeClient.input_settings[native_alert]["width"],
            ProbeClient.input_settings[native_alert]["height"],
        ) == (1792, 360)
        assert ProbeClient.refreshed_browser_inputs == []

        counts = {
            scene_name: len(ProbeClient.scene_items[scene_name])
            for scene_name in ProbeClient.scenes
        }
        settings = {
            name: dict(value)
            for name, value in ProbeClient.input_settings.items()
        }
        on_connected()
        assert {
            scene_name: len(ProbeClient.scene_items[scene_name])
            for scene_name in ProbeClient.scenes
        } == counts
        assert ProbeClient.input_settings == settings
        assert ProbeClient.refreshed_browser_inputs == []
    finally:
        if ctrl:
            ctrl.shutdown()


def test_obs_connect_does_not_force_refresh_explicit_broll_sources() -> None:
    """Already-migrated sources defer deploy reloads until the break is safe."""
    from sc2tools_agent.runner import _build_obs_switcher

    class _Bus:
        def subscribe(self, cb: Any) -> None:
            pass

    route = "https://sc2tools.com/overlay/tok/widget/stream-scene"
    ProbeClient.scenes = ["Horizontal", "Portrait"]
    ProbeClient.inputs = [
        {"name": "Horizontal B-roll", "kind": "browser_source"},
        {"name": "Portrait B-roll", "kind": "browser_source"},
        {"name": "Foreign B-roll", "kind": "browser_source"},
    ]
    ProbeClient.input_settings = {
        "Horizontal B-roll": {
            "url": route + "?audio=1",
            "width": 1920,
            "height": 1080,
            "reroute_audio": False,
        },
        "Portrait B-roll": {
            "url": route + "?audio=0",
            "width": 1080,
            "height": 1920,
            "reroute_audio": False,
        },
        "Foreign B-roll": {
            "url": "https://example.com/overlay/other/widget/stream-scene",
            "width": 1920,
            "height": 1080,
            "reroute_audio": False,
        },
    }
    ProbeClient.scene_items = {"Horizontal": [], "Portrait": []}

    client, ctrl = _build_obs_switcher(
        state=AgentState(obs_scene_switch_enabled=True),
        bridge=SimpleNamespace(bus=_Bus()),
        log=_LOG,
    )
    assert client is not None
    try:
        on_connected = client.kwargs["on_connected"]
        on_connected()
        assert ProbeClient.refreshed_browser_inputs == []
        assert ProbeClient.input_settings["Horizontal B-roll"]["url"] == (
            route + "?audio=1"
        )
        assert ProbeClient.input_settings["Portrait B-roll"]["url"] == (
            route + "?audio=0"
        )

        on_connected()
        assert ProbeClient.refreshed_browser_inputs == []
    finally:
        if ctrl:
            ctrl.shutdown()


def test_obs_connect_repair_failure_does_not_break_switcher() -> None:
    from sc2tools_agent.runner import _build_obs_switcher

    class _Bus:
        def subscribe(self, cb: Any) -> None:
            pass

    ProbeClient.scenes = [SCENE_BETWEEN_GAMES]
    ProbeClient.inventory_error = RuntimeError("inventory unavailable")
    client, ctrl = _build_obs_switcher(
        state=AgentState(obs_scene_switch_enabled=True),
        bridge=SimpleNamespace(bus=_Bus()),
        log=_LOG,
    )
    assert client is not None
    try:
        client.kwargs["on_connected"]()
        assert ProbeClient.instances[0].shutdown_called is False
        assert ProbeClient.instances[1].shutdown_called is True
    finally:
        if ctrl:
            ctrl.shutdown()


def test_obs_connect_isolates_independent_startup_repair_failures(
    monkeypatch,
    caplog,
) -> None:
    """Portrait/manual failures must not suppress chat or B-roll repair."""
    from sc2tools_agent.live import obs_layout
    from sc2tools_agent.runner import _build_obs_switcher

    class _Bus:
        def subscribe(self, cb: Any) -> None:
            pass

    manual_url = "https://sc2tools.com/overlay/tok/scene/manual"
    calls: List[str] = []

    def _fail_vertical(client: Any) -> bool:
        calls.append("vertical")
        raise RuntimeError("vertical unavailable")

    def _discover_manual(client: Any) -> str:
        calls.append("discover_manual")
        return manual_url

    def _fail_manual(client: Any, *, browser_url: str, **kw: Any) -> List[str]:
        assert browser_url == manual_url
        calls.append("manual")
        raise RuntimeError("manual unavailable")

    def _repair_chat(client: Any, *, browser_url: str):
        assert browser_url == manual_url
        calls.append("chat")
        return {}, [], []

    def _repair_broll(client: Any, *, browser_url: str):
        assert browser_url == manual_url
        calls.append("broll")
        return "owner", []

    monkeypatch.setattr(
        obs_layout,
        "repair_vertical_scene_chat_alerts",
        _fail_vertical,
    )
    monkeypatch.setattr(
        obs_layout,
        "discover_manual_override_url",
        _discover_manual,
    )
    monkeypatch.setattr(
        obs_layout,
        "discover_widget_only_broll_url",
        lambda client: pytest.fail("manual identity should already be known"),
    )
    monkeypatch.setattr(
        obs_layout,
        "repair_manual_scene_overrides",
        _fail_manual,
    )
    monkeypatch.setattr(
        obs_layout,
        "repair_chat_alert_audio_roles",
        _repair_chat,
    )
    monkeypatch.setattr(
        obs_layout,
        "repair_broll_audio_roles",
        _repair_broll,
    )

    client, ctrl = _build_obs_switcher(
        state=AgentState(obs_scene_switch_enabled=True),
        bridge=SimpleNamespace(bus=_Bus()),
        log=_LOG,
    )
    assert client is not None
    try:
        with caplog.at_level(logging.WARNING, logger=_LOG.name):
            client.kwargs["on_connected"]()

        assert calls == [
            "vertical",
            "discover_manual",
            "manual",
            "chat",
            "broll",
        ]
        assert "obs_vertical_chat_alert_auto_repair_failed" in caplog.text
        assert "obs_manual_override_auto_repair_failed" in caplog.text
        assert ProbeClient.instances[0].shutdown_called is False
        assert ProbeClient.instances[1].shutdown_called is True
    finally:
        if ctrl:
            ctrl.shutdown()


def test_obs_connect_repair_uses_the_reconfigured_endpoint() -> None:
    from sc2tools_agent.runner import _build_obs_switcher

    class _Bus:
        def subscribe(self, cb: Any) -> None:
            pass

    client, ctrl = _build_obs_switcher(
        state=AgentState(obs_scene_switch_enabled=True),
        bridge=SimpleNamespace(bus=_Bus()),
        log=_LOG,
    )
    assert client is not None
    try:
        client.reconfigure(host="10.0.0.8", port=4466, password="new")
        client.kwargs["on_connected"]()

        repair_client = ProbeClient.instances[1]
        assert repair_client.kwargs["host"] == "10.0.0.8"
        assert repair_client.kwargs["port"] == 4466
        assert repair_client.kwargs["password"] == "new"
        assert repair_client.shutdown_called is True
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
    refreshed_browser_inputs: List[str] = []

    def __init__(self, **kw: Any) -> None:
        self.kwargs = kw
        self.shutdown_called = False
        self.started = False
        ProbeClient.instances.append(self)

    @property
    def connection_settings(self):
        return (
            self.kwargs.get("host", "127.0.0.1"),
            int(self.kwargs.get("port", 4455)),
            self.kwargs.get("password"),
        )

    def reconfigure(self, **kw: Any) -> None:
        self.kwargs.update(
            {key: value for key, value in kw.items() if value is not None},
        )

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

    def set_input_settings(
        self, name: str, settings: Dict[str, Any],
    ) -> None:
        ProbeClient.input_settings[name].update(settings)

    def refresh_browser_input(self, name: str) -> None:
        ProbeClient.refreshed_browser_inputs.append(name)

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
                "enabled": bool(kw.get("enabled", True)),
                "transform": {},
            },
        )
        return ProbeClient.next_item_id

    def remove_scene_item(self, **kw: Any) -> None:
        scene_name = str(kw["scene_name"])
        item_id = int(kw["item_id"])
        ProbeClient.scene_items[scene_name] = [
            item for item in ProbeClient.scene_items[scene_name]
            if int(item["item_id"]) != item_id
        ]
        for index, item in enumerate(sorted(
            ProbeClient.scene_items[scene_name],
            key=lambda row: int(row["index"]),
        )):
            item["index"] = index

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
    ProbeClient.refreshed_browser_inputs = []
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
    # With no pre-existing Live/Vertical renderer, the generated native-size
    # sources become the owners immediately in this build transaction.  A
    # streamer must never need an OBS reconnect before chat/alert audio works.
    chat_sources = [
        settings
        for settings in ProbeClient.input_settings.values()
        if "/widget/multichat" in str(settings.get("url") or "")
    ]
    alert_sources = [
        settings
        for settings in ProbeClient.input_settings.values()
        if "/widget/chat-alerts" in str(settings.get("url") or "")
    ]
    assert len(chat_sources) == 1
    assert chat_sources[0]["url"].endswith("/widget/multichat?audio=1")
    assert (chat_sources[0]["width"], chat_sources[0]["height"]) == (552, 984)
    assert len(alert_sources) == 1
    assert alert_sources[0]["url"].endswith("/widget/chat-alerts?audio=1")
    assert (alert_sources[0]["width"], alert_sources[0]["height"]) == (
        1792,
        360,
    )


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
    assert ProbeClient.scene_items[SCENE_BETWEEN_GAMES][-2][
        "source_name"
    ].startswith("SC2 Tools Manual Override")
    assert ProbeClient.scene_items[SCENE_BETWEEN_GAMES][-1][
        "source_name"
    ].startswith(CHAT_ALERTS_INPUT_NAME)
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


def test_partial_build_reuses_legacy_native_shared_inputs_before_creating_scene(
    tmp_path: Path, monkeypatch,
) -> None:
    """A direct Build must not mint second native shared renderers.

    Older generated scenes can already contain the correct 1792x360 source
    without an explicit audio role.  When only the counterpart is missing,
    preflight must treat bare/audio=1 as the same geometry-specific input,
    reference it in the new scene, then let role repair mute it behind Live's
    canonical owner. The same rule keeps the existing full-canvas manual cover
    connected across both generated scenes when only its audio marker differs.
    """
    monkeypatch.setattr(
        runner, "_overlay_token_for_build", lambda cfg, state, log: "tok",
    )
    root = "https://sc2tools.com/overlay/tok"
    ProbeClient.scenes = [SCENE_BETWEEN_GAMES, "Live Scene"]
    ProbeClient.inputs.extend([
        {"name": "Legacy Native Alerts", "kind": "browser_source"},
        {"name": "Alert Box", "kind": "browser_source"},
        {"name": "Legacy Manual Override", "kind": "browser_source"},
    ])
    ProbeClient.input_settings.update({
        "Legacy Native Alerts": {
            "url": f"{root}/widget/chat-alerts",
            "width": 1792,
            "height": 360,
        },
        "Alert Box": {
            "url": f"{root}/widget/chat-alerts?audio=1",
            "width": 800,
            "height": 600,
            "shutdown": False,
        },
        "Legacy Manual Override": {
            "url": f"{root}/scene/manual",
            "width": 1920,
            "height": 1080,
            "shutdown": False,
            "reroute_audio": False,
        },
    })
    ProbeClient.scene_items = {
        SCENE_BETWEEN_GAMES: [{
            "source_name": "Legacy Native Alerts",
            "item_id": 1,
            "index": 0,
            "input_kind": "browser_source",
            "enabled": True,
            "transform": {"legacy_geometry": "preserve"},
        }, {
            "source_name": "Legacy Manual Override",
            "item_id": 3,
            "index": 1,
            "input_kind": "browser_source",
            "enabled": True,
            "transform": {"manual_geometry": "preserve"},
        }],
        "Live Scene": [{
            "source_name": "Alert Box",
            "item_id": 2,
            "index": 0,
            "input_kind": "browser_source",
            "enabled": True,
            "transform": {"live_geometry": "preserve"},
        }],
    }

    result = _handle_obs_build(
        cfg=_cfg(tmp_path),
        state=AgentState(device_token="dev"),
        request={"game_source": "SC2"},
        log=_LOG,
    )

    assert result["ok"] is True, result["message"]
    assert f"Created 1 missing scene(s): {SCENE_IN_GAME}" in result["message"]
    in_game_sources = [
        item["source_name"]
        for item in ProbeClient.scene_items[SCENE_IN_GAME]
    ]
    assert "Legacy Native Alerts" in in_game_sources
    assert "Legacy Manual Override" in in_game_sources
    assert ProbeClient.input_settings["Legacy Native Alerts"] == {
        "url": f"{root}/widget/chat-alerts?audio=0",
        "width": 1792,
        "height": 360,
    }
    assert ProbeClient.input_settings["Alert Box"] == {
        "url": f"{root}/widget/chat-alerts?audio=1",
        "width": 800,
        "height": 600,
        "shutdown": False,
    }
    same_token_alert_inputs = {
        name
        for name, settings in ProbeClient.input_settings.items()
        if str(settings.get("url") or "").startswith(
            f"{root}/widget/chat-alerts",
        )
    }
    assert same_token_alert_inputs == {
        "Alert Box",
        "Legacy Native Alerts",
    }
    same_token_manual_inputs = {
        name
        for name, settings in ProbeClient.input_settings.items()
        if str(settings.get("url") or "").startswith(f"{root}/scene/manual")
    }
    assert same_token_manual_inputs == {"Legacy Manual Override"}
    assert ProbeClient.input_settings["Legacy Manual Override"] == {
        "url": f"{root}/scene/manual?audio=1",
        "width": 1920,
        "height": 1080,
        "shutdown": False,
        "reroute_audio": False,
    }
    # The pre-existing scene remains outside this Build's mutation authority.
    assert ProbeClient.scene_items[SCENE_BETWEEN_GAMES] == [{
        "source_name": "Legacy Native Alerts",
        "item_id": 1,
        "index": 0,
        "input_kind": "browser_source",
        "enabled": True,
        "transform": {"legacy_geometry": "preserve"},
    }, {
        "source_name": "Legacy Manual Override",
        "item_id": 3,
        "index": 1,
        "input_kind": "browser_source",
        "enabled": True,
        "transform": {"manual_geometry": "preserve"},
    }]


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
