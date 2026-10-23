"""Runner glue for the build check-in view: what ``_run_with_gui`` hands
the GUI and the tray, the tray item's action and the dragged-position
persistence."""

from __future__ import annotations

import time
from pathlib import Path
from unittest.mock import Mock

import pytest

from sc2tools_agent import runner
from sc2tools_agent.config import AgentConfig
from sc2tools_agent.state import AgentState, load_state, save_state


def _wait(predicate, timeout: float = 3.0) -> bool:
    deadline = time.monotonic() + timeout
    while time.monotonic() < deadline:
        if predicate():
            return True
        time.sleep(0.01)
    return predicate()


def test_tray_item_reopens_through_the_controller(monkeypatch) -> None:
    opened = []
    monkeypatch.setattr(runner.webbrowser, "open", lambda *a, **k: opened.append((a, k)))
    cell = runner._RuntimeCell()
    cell.build_checkin = Mock()
    runner._open_build_checkin(cell, "https://sc2tools.com")
    cell.build_checkin.reopen.assert_called_once_with()
    assert opened == []


def test_tray_item_opens_the_web_queue_without_a_controller(monkeypatch) -> None:
    opened = []
    monkeypatch.setattr(runner.webbrowser, "open", lambda *a, **k: opened.append((a, k)))
    runner._open_build_checkin(runner._RuntimeCell(), "https://sc2tools.com/")
    assert opened == [(("https://sc2tools.com/app",), {"new": 2})]


def test_dragged_position_is_saved_to_agent_state(tmp_path: Path) -> None:
    state = AgentState(device_token="t", build_checkin_card_positions={"postgame": [1, 2]})
    save_state(tmp_path, state)
    runner._remember_build_checkin_position(tmp_path, state, "loading", 1650.0, 120)
    assert state.build_checkin_card_positions == {"postgame": [1, 2], "loading": [1650, 120]}
    assert _wait(
        lambda: load_state(tmp_path).build_checkin_card_positions.get("loading") == [1650, 120]
    )
    loaded = load_state(tmp_path)
    assert loaded.build_checkin_card_positions["postgame"] == [1, 2]
    assert loaded.device_token == "t"


def test_position_save_failure_is_logged_not_raised(tmp_path: Path, monkeypatch, caplog) -> None:
    def broken(*_args) -> None:
        raise OSError("read-only")

    monkeypatch.setattr(runner, "save_state", broken)
    state = AgentState()
    with caplog.at_level("WARNING", logger="sc2tools_agent"):
        runner._remember_build_checkin_position(tmp_path, state, "postgame", 3, 4)
        assert _wait(lambda: "build_checkin_position_save_failed" in caplog.text)
    assert state.build_checkin_card_positions == {"postgame": [3, 4]}


@pytest.fixture
def gui_run(monkeypatch, tmp_path):
    """``_run_with_gui`` with the window, tray and boot worker mocked."""
    gui_cls = Mock(name="GuiUI")
    gui_cls.return_value.run.return_value = 0
    tray_cls = Mock(name="TrayUI")
    monkeypatch.setattr(runner, "GuiUI", gui_cls)
    monkeypatch.setattr(runner, "TrayUI", tray_cls)
    monkeypatch.setattr(runner, "can_use_tray", lambda: True)
    monkeypatch.setattr(runner, "ConsoleUI", Mock(name="ConsoleUI"))
    monkeypatch.setattr(runner, "_gui_boot_worker", lambda **_: None)
    monkeypatch.setattr(runner, "_build_stream_service", lambda *a, **k: None)
    monkeypatch.setattr(runner, "_discover_replay_folders", lambda *_: [])
    monkeypatch.setattr(runner.autostart, "is_enabled", lambda: False)
    save_state(tmp_path, AgentState(
        device_token="t", build_checkin_card_positions={"loading": [10, 20]},
    ))
    cfg = AgentConfig(
        api_base="https://api.sc2tools.com", state_dir=tmp_path, replay_folder=None,
        poll_interval_sec=10, parse_concurrency=1,
    )

    def run(*, no_live: bool):
        gui_cls.reset_mock()
        tray_cls.reset_mock()
        assert runner._run_with_gui(cfg, tmp_path, start_minimized=True, no_live=no_live) == 0
        return gui_cls.call_args.kwargs, tray_cls.call_args.kwargs

    return run


def test_gui_gets_the_check_in_wiring(gui_run, tmp_path, monkeypatch) -> None:
    gui_kwargs, tray_kwargs = gui_run(no_live=False)
    assert gui_kwargs["build_checkin_available"] is True
    assert gui_kwargs["build_checkin_positions"] == {"loading": [10, 20]}
    saved = []
    monkeypatch.setattr(
        runner, "_remember_build_checkin_position",
        lambda state_dir, state, kind, x, y: saved.append((state_dir, kind, x, y)),
    )
    gui_kwargs["on_build_checkin_moved"]("postgame", 5, 6)
    assert saved == [(tmp_path, "postgame", 5, 6)]

    opened = []
    monkeypatch.setattr(
        runner, "_open_build_checkin", lambda cell, url: opened.append(url),
    )
    tray_kwargs["on_build_checkin"]()
    assert opened == ["https://sc2tools.com"]


def test_no_live_gui_marks_check_in_unavailable(gui_run) -> None:
    gui_kwargs, _tray_kwargs = gui_run(no_live=True)
    assert gui_kwargs["build_checkin_available"] is False


def test_reset_clears_all_card_kinds_and_persists_without_waiting_for_disk(tmp_path, monkeypatch):
    from threading import Event
    entered, release, finished = Event(), Event(), Event()
    state = AgentState(device_token="keep", build_checkin_card_positions={"loading": [1, 2], "future-hud": [3, 4]})
    save_state(tmp_path, state)
    def blocked_save(directory, current):
        entered.set()
        assert release.wait(5), "test never released the state writer"
        save_state(directory, current)
        finished.set()
    monkeypatch.setattr(runner, "save_state", blocked_save)
    runner._reset_build_checkin_positions(tmp_path, state)
    try:
        assert state.build_checkin_card_positions == {}
        assert entered.wait(3) and not finished.is_set()
    finally:
        release.set()
    assert finished.wait(3)
    loaded = load_state(tmp_path)
    assert loaded.build_checkin_card_positions == {} and loaded.device_token == "keep"


def test_latest_accepted_replay_race_is_persisted_and_history_cannot_replace_it(tmp_path):
    from tests.build_checkin_fakes import cloud_game
    state = AgentState(last_known_race_at="bad old state")
    cell = runner._RuntimeCell(); cell.build_checkin = Mock()
    newest = cloud_game("new", started=1790000000, my_race="Terran")
    runner._handle_checkin_game_accepted(tmp_path, state, cell, Path("new.SC2Replay"), newest, "new", {"accepted": True})
    cell.build_checkin.on_game_accepted.assert_called_once_with(Path("new.SC2Replay"), newest, "new", {"accepted": True})
    older = cloud_game("old", started=1780000000, my_race="Zerg")
    runner._handle_checkin_game_accepted(tmp_path, state, cell, Path("old.SC2Replay"), older, "old", {})
    random = cloud_game("random", started=1800000000, my_race="Random")
    runner._handle_checkin_game_accepted(tmp_path, state, cell, Path("random.SC2Replay"), random, "random", {})
    loaded = load_state(tmp_path)
    assert loaded.last_known_race == "Terran" and loaded.last_known_race_at == newest.date_iso
    assert cell.build_checkin.on_game_accepted.call_count == 3


def test_preview_race_save_failure_does_not_lose_checkin_callback(tmp_path, monkeypatch):
    from tests.build_checkin_fakes import cloud_game
    state = AgentState(); cell = runner._RuntimeCell(); cell.build_checkin = Mock()
    def fail(*_): raise OSError("disk full")
    monkeypatch.setattr(runner, "save_state", fail)
    game = cloud_game("new", started=1790000000, my_race="Protoss")
    runner._handle_checkin_game_accepted(tmp_path, state, cell, Path("new.SC2Replay"), game, "new", {})
    assert state.last_known_race == "Protoss"
    cell.build_checkin.on_game_accepted.assert_called_once()
