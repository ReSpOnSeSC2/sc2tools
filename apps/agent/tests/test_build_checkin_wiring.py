"""Runner glue for build check-in: the start helper, the view lookup and
the GUI boot worker's wiring (UploadQueue / SocketClient callbacks,
live bridge subscription, ``_RuntimeCell`` slot)."""

from __future__ import annotations

import logging
import threading
import time
from pathlib import Path
from unittest.mock import Mock

import pytest

from sc2tools_agent import runner
from sc2tools_agent.build_checkin import BuildCheckinController, wiring
from sc2tools_agent.build_checkin.models import CheckinPrefs
from sc2tools_agent.build_checkin.wiring import (
    build_checkin_view_for,
    new_build_url,
    start_build_checkin,
    web_queue_url,
)
from sc2tools_agent.config import AgentConfig
from sc2tools_agent.live.event_bus import EventBus
from sc2tools_agent.state import AgentState, load_state
from tests.build_checkin_fakes import FakeCheckinApi, FakeView


def _wait(predicate, timeout: float = 3.0) -> bool:
    deadline = time.monotonic() + timeout
    while time.monotonic() < deadline:
        if predicate():
            return True
        time.sleep(0.01)
    return predicate()


class _BindingView(FakeView):
    def __init__(self) -> None:
        super().__init__()
        self.bound = []

    def bind_controller(self, controller) -> None:
        self.bound.append(controller)


def test_start_helper_binds_attaches_and_starts(tmp_path: Path) -> None:
    api = FakeCheckinApi()
    bus: EventBus = EventBus()
    view = _BindingView()
    controller = start_build_checkin(
        api=api, bus=bus, state=AgentState(), state_dir=tmp_path,
        dashboard_url="https://sc2tools.com/", view=view,
    )
    try:
        assert isinstance(controller, BuildCheckinController)
        assert view.bound == [controller]
        assert bus.subscriber_count == 1
        assert _wait(lambda: api.calls_to("get_checkin_prefs"))
    finally:
        controller.stop()
    assert bus.subscriber_count == 0


def test_dismissed_intro_is_saved_to_agent_state(tmp_path: Path) -> None:
    state = AgentState(device_token="t")
    controller = start_build_checkin(
        api=FakeCheckinApi(), bus=EventBus(), state=state, state_dir=tmp_path,
        dashboard_url="https://sc2tools.com",
    )
    try:
        controller.dismiss_intro()
        assert _wait(lambda: load_state(tmp_path).build_checkin_intro_seen)
    finally:
        controller.stop()
    assert state.build_checkin_intro_seen is True
    assert load_state(tmp_path).device_token == "t"


def test_start_helper_failure_never_breaks_boot(tmp_path: Path, caplog) -> None:
    bus = Mock()
    bus.subscribe.side_effect = RuntimeError("bus closed")
    with caplog.at_level(logging.ERROR, logger="sc2tools_agent.build_checkin"):
        controller = start_build_checkin(
            api=FakeCheckinApi(), bus=bus, state=AgentState(), state_dir=tmp_path,
            dashboard_url="https://sc2tools.com",
        )
    assert controller is None
    assert "build_checkin_start_failed" in caplog.text


def test_view_lookup() -> None:
    view = FakeView()
    assert build_checkin_view_for(object()) is None
    assert build_checkin_view_for(None) is None
    assert build_checkin_view_for(Mock(build_checkin_view=lambda: view)) is view

    def broken():
        raise RuntimeError("no qt")

    assert build_checkin_view_for(Mock(build_checkin_view=broken)) is None


def test_web_queue_url() -> None:
    assert web_queue_url("https://sc2tools.com/") == "https://sc2tools.com/app"
    assert web_queue_url("http://localhost:3000") == "http://localhost:3000/app"
    assert new_build_url("https://sc2tools.com/", "g|1", "you") == (
        "https://sc2tools.com/app/game/g%7C1?newBuild=you"
    )


def test_start_helper_passes_the_dashboard_and_the_cached_prefs(tmp_path: Path, monkeypatch) -> None:
    captured = {}
    monkeypatch.setattr(
        wiring, "BuildCheckinController", lambda **kwargs: captured.update(kwargs) or Mock(),
    )
    state = AgentState(
        device_token="t",
        build_checkin_prefs={"enabled": True, "askAtLoading": False, "askAfterGame": True},
    )
    start_build_checkin(
        api=FakeCheckinApi(), bus=EventBus(), state=state, state_dir=tmp_path,
        dashboard_url="http://localhost:3000",
    )
    assert captured["dashboard_url"] == "http://localhost:3000"
    assert captured["web_queue_url"] == "http://localhost:3000/app"
    assert captured["prefs"] == CheckinPrefs(ask_at_loading=False)

    captured["on_prefs_changed"](CheckinPrefs(enabled=False))
    assert state.build_checkin_prefs == {
        "enabled": False, "askAtLoading": True, "askAfterGame": True,
    }
    saved = load_state(tmp_path)
    assert saved.build_checkin_prefs == state.build_checkin_prefs
    assert saved.device_token == "t"


def test_first_start_has_no_cached_prefs(tmp_path: Path, monkeypatch) -> None:
    captured = {}
    monkeypatch.setattr(
        wiring, "BuildCheckinController", lambda **kwargs: captured.update(kwargs) or Mock(),
    )
    start_build_checkin(
        api=FakeCheckinApi(), bus=EventBus(), state=AgentState(), state_dir=tmp_path,
        dashboard_url="https://sc2tools.com",
    )
    assert captured["prefs"] is None


def test_loaded_prefs_reach_agent_state(tmp_path: Path) -> None:
    api = FakeCheckinApi()
    api.prefs["askAfterGame"] = False
    state = AgentState(device_token="t")
    controller = start_build_checkin(
        api=api, bus=EventBus(), state=state, state_dir=tmp_path,
        dashboard_url="https://sc2tools.com",
    )
    try:
        assert _wait(lambda: load_state(tmp_path).build_checkin_prefs == {
            "enabled": True, "askAtLoading": True, "askAfterGame": False,
        })
    finally:
        controller.stop()


def test_runtime_cell_has_a_build_checkin_slot() -> None:
    cell = runner._RuntimeCell()
    assert cell.build_checkin is None
    cell.build_checkin = object()


# ------------------------------------------------------------ boot worker


def _cfg(tmp_path: Path) -> AgentConfig:
    return AgentConfig(
        api_base="https://api.sc2tools.com",
        state_dir=tmp_path,
        replay_folder=None,
        poll_interval_sec=10,
        parse_concurrency=1,
    )


@pytest.fixture
def boot(monkeypatch, tmp_path):
    """Run the GUI boot worker with every subsystem mocked out."""
    mocks = {}
    for name in ("ApiClient", "UploadQueue", "ReplayWatcher", "ImportController",
                 "Updater", "Heartbeat", "SocketClient", "BotLabController",
                 "start_build_checkin"):
        mocks[name] = Mock(name=name)
        monkeypatch.setattr(runner, name, mocks[name])
    bridge = Mock(name="bridge")
    live_stack = (Mock(name="bus"), Mock(name="poller"), bridge, Mock(name="tx"), Mock(name="metrics"))
    mocks["_build_live_bridge"] = Mock(return_value=live_stack)
    monkeypatch.setattr(runner, "_build_live_bridge", mocks["_build_live_bridge"])
    monkeypatch.setattr(runner, "_build_obs_switcher", lambda **_: (None, None))
    monkeypatch.setattr(runner, "make_recompute_handlers", lambda **_: (Mock(), Mock(), Mock()))
    monkeypatch.setattr(runner, "probe_analyzer", lambda: (True, ""))
    monkeypatch.setattr(runner, "_discover_replay_folders", lambda *_: [])
    monkeypatch.setattr(runner, "_ensure_player_handle", lambda *_: None)
    monkeypatch.setattr(runner, "resolve_player_handle", lambda *_: None)
    monkeypatch.setattr(runner, "_surface_replay_archive_prompt", lambda *_: None)

    def run(*, no_live: bool):
        cell = runner._RuntimeCell()
        cell.gui = Mock(name="gui")
        runner._gui_boot_worker(
            cfg=_cfg(tmp_path), state=AgentState(device_token="t", user_id="u"),
            cell=cell, ui=Mock(), stop_event=threading.Event(),
            log=logging.getLogger("test"), no_live=no_live, no_obs=True,
        )
        return cell

    return run, mocks, bridge


def test_boot_worker_starts_the_controller_on_the_bridge_bus(boot) -> None:
    run, mocks, bridge = boot
    order = []
    mocks["start_build_checkin"].side_effect = lambda **_: order.append("checkin") or Mock()
    bridge.start.side_effect = lambda: order.append("bridge")
    cell = run(no_live=False)

    start = mocks["start_build_checkin"]
    start.assert_called_once()
    kwargs = start.call_args.kwargs
    assert kwargs["bus"] is bridge.bus
    assert kwargs["api"] is mocks["ApiClient"].return_value
    assert kwargs["dashboard_url"] == "https://sc2tools.com"
    assert kwargs["view"] is cell.gui.build_checkin_view.return_value
    assert cell.build_checkin is not None
    # Subscribed before the bridge starts delivering envelopes.
    assert order == ["checkin", "bridge"]


def test_boot_worker_late_binds_upload_and_socket_callbacks(boot) -> None:
    run, mocks, _bridge = boot
    cell = run(no_live=False)
    controller = cell.build_checkin

    on_accepted = mocks["UploadQueue"].call_args.kwargs["on_game_accepted"]
    on_accepted("path", "game", "gid", {"created": True})
    controller.on_game_accepted.assert_called_once_with(
        "path", "game", "gid", {"created": True},
    )
    on_ping = mocks["SocketClient"].call_args.kwargs["on_build_intent_changed"]
    on_ping({"gameKey": "k"})
    controller.on_intent_changed.assert_called_once_with({"gameKey": "k"})

    # Before (or without) a controller the callbacks are harmless no-ops.
    cell.build_checkin = None
    assert on_accepted("path", "game", "gid", {}) is None
    assert on_ping({"gameId": "g"}) is None


def test_no_live_means_no_controller(boot) -> None:
    run, mocks, _bridge = boot
    cell = run(no_live=True)
    mocks["start_build_checkin"].assert_not_called()
    assert cell.build_checkin is None
