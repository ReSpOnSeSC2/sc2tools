"""Focused tests for the one-time original-replay backfill prompt."""

from __future__ import annotations

import logging
import threading
from types import SimpleNamespace
from typing import Any, Optional
from unittest.mock import Mock

import pytest

from sc2tools_agent import runner
from sc2tools_agent.health import HealthMonitor
from sc2tools_agent.runner import (
    _handle_replay_archive_resync,
    _replay_archive_ack_allowed,
    _surface_replay_archive_prompt,
)
from sc2tools_agent.state import AgentState


class _Api:
    def __init__(self, payload: Optional[dict[str, Any]]) -> None:
        self.payload = payload

    def get_replay_archive_status(self) -> Optional[dict[str, Any]]:
        return self.payload


class _Ui:
    def __init__(self) -> None:
        self.calls: list[tuple[int, int]] = []

    def on_replay_archive_status(
        self,
        missing_games: int,
        total_games: int,
    ) -> None:
        self.calls.append((missing_games, total_games))


def test_surface_replay_archive_prompt_for_unacknowledged_history() -> None:
    ui = _Ui()
    _surface_replay_archive_prompt(
        _Api(
            {
                "enabled": True,
                "requiresResync": True,
                "missingGames": 7,
                "totalGames": 12,
            },
        ),
        ui,
        logging.getLogger("test"),
    )
    assert ui.calls == [(7, 12)]


def test_surface_replay_archive_prompt_ignores_disabled_or_acknowledged() -> None:
    for payload in (
        {
            "enabled": False,
            "requiresResync": False,
            "missingGames": 7,
            "totalGames": 12,
        },
        {
            "enabled": True,
            "requiresResync": False,
            # Missing can remain nonzero after a valid scan when the local
            # replay file was deleted. This must not become a permanent nag.
            "missingGames": 2,
            "totalGames": 12,
        },
        {
            "enabled": True,
            "requiresResync": True,
            "missingGames": 0,
            "totalGames": 0,
        },
    ):
        ui = _Ui()
        _surface_replay_archive_prompt(
            _Api(payload),
            ui,
            logging.getLogger("test"),
        )
        assert ui.calls == []


def test_archive_ack_requires_persisted_all_time_filter() -> None:
    assert _replay_archive_ack_allowed(AgentState()) is True
    assert _replay_archive_ack_allowed(AgentState(paused=True)) is False
    assert _replay_archive_ack_allowed(
        AgentState(sync_filter_preset="season:67"),
    ) is False
    assert _replay_archive_ack_allowed(
        AgentState(
            sync_filter_preset="custom",
            sync_filter_since="2026-08-01",
        ),
    ) is False


def test_archive_resync_without_live_queue_does_not_ack(
    tmp_path,
    monkeypatch,
) -> None:
    def unexpected_client(*_args, **_kwargs):
        raise AssertionError("archive acknowledgement must wait for a queue")

    monkeypatch.setattr("sc2tools_agent.runner.ApiClient", unexpected_client)
    state = AgentState(
        device_token="device-token",
        uploaded={"old.SC2Replay": "game-1"},
    )
    cfg = SimpleNamespace(state_dir=tmp_path, api_base="https://api.test")

    _handle_replay_archive_resync(cfg, state, None)

    assert state.uploaded == {}


def _cell_asking_for_resync(sink: Mock) -> Any:
    cell = runner._RuntimeCell()
    cell.ui = runner._Multiplexer(
        sink, health=HealthMonitor(schedule=lambda _delay, callback: callback()),
    )
    cell.ui.on_replay_archive_status(12, 300)
    return cell


def _archive_rows(cell: Any) -> list:
    return [row for row in cell.ui.health.snapshot().rows if row.id == "archive"]


def test_starting_the_full_resync_clears_the_health_archive_row(
    tmp_path,
    monkeypatch,
) -> None:
    cfg = SimpleNamespace(state_dir=tmp_path, api_base="https://api.test")
    started = threading.Event()
    cell = _cell_asking_for_resync(Mock())
    cell.upload = Mock()
    assert _archive_rows(cell)[0].sentence.startswith("12 of your 300 saved games")
    cell.import_ctl = SimpleNamespace(
        maybe_start_auto_backfill=lambda **_kwargs: started.set(),
    )
    runner._request_desktop_resync(cfg, AgentState(), cell)
    assert started.wait(2)
    facts = cell.ui.health.facts()
    assert (facts.archive_missing, facts.archive_total) == (0, 0)
    assert _archive_rows(cell) == []

    # A Re-sync that never started keeps asking for one.
    failed, sink = threading.Event(), Mock()
    sink.show_notice.side_effect = lambda _message: failed.set()
    cell = _cell_asking_for_resync(sink)
    monkeypatch.setattr(
        runner, "_handle_replay_archive_resync", Mock(side_effect=OSError("disk full")),
    )
    runner._request_desktop_resync(cfg, AgentState(), cell)
    assert failed.wait(2)
    assert cell.ui.health.facts().archive_missing == 12 and _archive_rows(cell)


@pytest.mark.parametrize("state,has_queue", [
    (AgentState(), False),
    (AgentState(sync_filter_preset="current_season"), True),
    (AgentState(sync_filter_preset="custom", sync_filter_since="2026-08-01"), True),
    (AgentState(paused=True), True),
])
def test_incomplete_resync_keeps_the_health_archive_row(tmp_path, state, has_queue) -> None:
    cfg = SimpleNamespace(state_dir=tmp_path, api_base="https://api.test")
    cell = _cell_asking_for_resync(Mock())
    cell.upload = Mock() if has_queue else None
    finished = threading.Event()
    cell.import_ctl = SimpleNamespace(
        maybe_start_auto_backfill=lambda **_kwargs: finished.set(),
    )

    runner._request_desktop_resync(cfg, state, cell)

    assert finished.wait(2)
    assert cell.ui.health.facts().archive_missing == 12 and _archive_rows(cell)
