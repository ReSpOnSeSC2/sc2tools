"""Focused tests for the one-time original-replay backfill prompt."""

from __future__ import annotations

import logging
from types import SimpleNamespace
from typing import Any, Optional

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
