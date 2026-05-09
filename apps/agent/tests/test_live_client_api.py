"""Unit tests for ``sc2tools_agent.live.client_api``.

These tests stub ``requests.Session.get`` so we never hit a real
``localhost:6119`` endpoint. We drive ``_tick_once`` directly so each
test asserts on a single state-machine step — the background-thread
``start()/stop()`` path is covered by a separate smoke test that runs
the full loop with a stubbed session.
"""

from __future__ import annotations

import json
from typing import Any, List, Optional
from unittest.mock import MagicMock

import pytest
import requests

from sc2tools_agent.live.client_api import (
    DEFAULT_FAST_INTERVAL_SEC,
    DEFAULT_IDLE_BACKOFF_SEC,
    LiveClientPoller,
    PollerConfig,
)
from sc2tools_agent.live.event_bus import EventBus
from sc2tools_agent.live.types import (
    LiveLifecycleEvent,
    LiveLifecyclePhase,
)


def _ok(body: Any) -> MagicMock:
    """Build a 200-OK MagicMock response with the given JSON body."""
    m = MagicMock()
    m.status_code = 200
    m.text = json.dumps(body)
    m.json.return_value = body
    return m


def _bad_status(status: int) -> MagicMock:
    m = MagicMock()
    m.status_code = status
    m.text = ""
    m.json.side_effect = ValueError("no body")
    return m


class _StubSession:
    """Minimal stand-in for ``requests.Session`` whose ``.get`` returns
    queued responses or raises a queued exception per URL.

    Each URL accumulates a queue of responses; calling ``.get`` pops
    the next one. This lets a test drive multiple poll iterations
    against the same session with deterministic per-URL state.
    """

    def __init__(self) -> None:
        self._responses: dict[str, list[Any]] = {}

    def queue(self, url: str, response_or_exc: Any) -> None:
        self._responses.setdefault(url, []).append(response_or_exc)

    def get(self, url: str, *, timeout: float) -> Any:
        queue = self._responses.get(url) or []
        if not queue:
            raise AssertionError(f"no stubbed response for {url}")
        item = queue.pop(0)
        if isinstance(item, Exception):
            raise item
        return item


def _make_poller(
    session: _StubSession,
    *,
    user_name_hint: Optional[str] = None,
) -> tuple[LiveClientPoller, List[LiveLifecycleEvent]]:
    bus: EventBus[LiveLifecycleEvent] = EventBus()
    seen: List[LiveLifecycleEvent] = []
    bus.subscribe(seen.append)
    poller = LiveClientPoller(
        bus=bus,
        config=PollerConfig(
            base_url="http://localhost:6119",
            interval_sec=0.01,
            fast_interval_sec=0.005,
            idle_backoff_sec=0.05,
        ),
        session=session,  # type: ignore[arg-type]
        user_name_hint=user_name_hint,
    )
    return poller, seen


# ---------------------------------------------------------------- happy path


def test_match_loading_then_started_then_ended() -> None:
    """End-to-end state machine: a typical 1v1 ladder match.

    1. Loading screen, both players present.
    2. In-game, displayTime > 0.
    3. Match decided.

    Each of those should produce exactly ONE event on transition into
    that phase. No spurious duplicates."""
    session = _StubSession()

    # Tick 1: MATCH_LOADING
    session.queue(
        "http://localhost:6119/ui",
        _ok({"activeScreens": ["ScreenLoading"]}),
    )
    session.queue(
        "http://localhost:6119/game",
        _ok({
            "isReplay": False,
            "displayTime": 0.0,
            "players": [
                {"id": 1, "name": "Streamer#42", "type": "user",
                 "race": "Zerg", "result": "Undecided"},
                {"id": 2, "name": "OppPlayer", "type": "user",
                 "race": "Protoss", "result": "Undecided"},
            ],
        }),
    )

    # Tick 2: MATCH_STARTED (in-game, displayTime > 0)
    session.queue(
        "http://localhost:6119/ui",
        _ok({"activeScreens": []}),
    )
    session.queue(
        "http://localhost:6119/game",
        _ok({
            "isReplay": False,
            "displayTime": 2.5,
            "players": [
                {"id": 1, "name": "Streamer#42", "type": "user",
                 "race": "Zerg", "result": "Undecided"},
                {"id": 2, "name": "OppPlayer", "type": "user",
                 "race": "Protoss", "result": "Undecided"},
            ],
        }),
    )

    # Tick 3: MATCH_ENDED
    session.queue(
        "http://localhost:6119/ui",
        _ok({"activeScreens": ["ScreenScore"]}),
    )
    session.queue(
        "http://localhost:6119/game",
        _ok({
            "isReplay": False,
            "displayTime": 600.0,
            "players": [
                {"id": 1, "name": "Streamer#42", "type": "user",
                 "race": "Zerg", "result": "Victory"},
                {"id": 2, "name": "OppPlayer", "type": "user",
                 "race": "Protoss", "result": "Defeat"},
            ],
        }),
    )

    poller, seen = _make_poller(session)

    poller._tick_once()
    poller._last_phase = LiveLifecyclePhase.MATCH_LOADING
    poller._tick_once()
    poller._last_phase = LiveLifecyclePhase.MATCH_STARTED
    poller._tick_once()

    phases = [e.phase for e in seen]
    assert phases == [
        LiveLifecyclePhase.MATCH_LOADING,
        LiveLifecyclePhase.MATCH_STARTED,
        LiveLifecyclePhase.MATCH_ENDED,
    ]
    # game_key persists across the three events for the same match.
    keys = {e.game_key for e in seen}
    assert len(keys) == 1
    only_key = next(iter(keys))
    assert only_key is not None
    # Sorted player names are part of the key so the cloud can
    # reconcile against the post-game replay record.
    assert "OppPlayer" in only_key
    assert "Streamer#42" in only_key

    # MATCH_LOADING returns the fast interval.
    assert seen[0].game_state is not None
    assert seen[0].ui_state is not None
    assert seen[0].ui_state.is_loading


def test_idle_emitted_only_once_when_client_unreachable() -> None:
    """SC2 closed → connection refused → IDLE on the first tick, then
    silent on subsequent ticks until something changes."""
    session = _StubSession()
    # Three consecutive ticks of "client refuses connection".
    for _ in range(3):
        session.queue(
            "http://localhost:6119/ui",
            requests.ConnectionError("refused"),
        )
        # /game is never reached on those ticks because /ui short-
        # circuits the loop, but the stub queue is per-URL so we
        # don't need to enqueue /game responses here.

    poller, seen = _make_poller(session)
    phase, sleep_for = poller._tick_once()
    assert phase == LiveLifecyclePhase.IDLE
    # Sleep duration matches the configured idle back-off — for the
    # production default see ``DEFAULT_IDLE_BACKOFF_SEC`` (5 s, the
    # value the prompt calls for).
    assert sleep_for == pytest.approx(0.05, abs=1e-3)
    assert DEFAULT_IDLE_BACKOFF_SEC == pytest.approx(5.0)
    poller._last_phase = LiveLifecyclePhase.IDLE
    poller._tick_once()
    poller._tick_once()
    # Exactly ONE IDLE event despite three ticks — the rest were
    # suppressed because we were already in IDLE.
    assert [e.phase for e in seen] == [LiveLifecyclePhase.IDLE]


def test_in_progress_ticks_emitted_only_when_displaytime_advances() -> None:
    """The state machine emits IN_PROGRESS on every full-second
    advancement, not on every poll. Two consecutive polls at the same
    displayTime should produce a single IN_PROGRESS."""
    session = _StubSession()

    # Seed a MATCH_STARTED so subsequent ticks land on the
    # MATCH_IN_PROGRESS branch.
    session.queue(
        "http://localhost:6119/ui",
        _ok({"activeScreens": []}),
    )
    session.queue(
        "http://localhost:6119/game",
        _ok({
            "isReplay": False,
            "displayTime": 1.0,
            "players": [
                {"id": 1, "name": "Me", "type": "user", "race": "Zerg",
                 "result": "Undecided"},
                {"id": 2, "name": "Opp", "type": "user",
                 "race": "Terran", "result": "Undecided"},
            ],
        }),
    )

    # Tick 2: same displayTime → no IN_PROGRESS.
    session.queue(
        "http://localhost:6119/ui",
        _ok({"activeScreens": []}),
    )
    session.queue(
        "http://localhost:6119/game",
        _ok({
            "isReplay": False,
            "displayTime": 1.4,
            "players": [
                {"id": 1, "name": "Me", "type": "user", "race": "Zerg",
                 "result": "Undecided"},
                {"id": 2, "name": "Opp", "type": "user",
                 "race": "Terran", "result": "Undecided"},
            ],
        }),
    )

    # Tick 3: advanced > 1s → IN_PROGRESS emits.
    session.queue(
        "http://localhost:6119/ui",
        _ok({"activeScreens": []}),
    )
    session.queue(
        "http://localhost:6119/game",
        _ok({
            "isReplay": False,
            "displayTime": 5.0,
            "players": [
                {"id": 1, "name": "Me", "type": "user", "race": "Zerg",
                 "result": "Undecided"},
                {"id": 2, "name": "Opp", "type": "user",
                 "race": "Terran", "result": "Undecided"},
            ],
        }),
    )

    poller, seen = _make_poller(session)
    poller._tick_once()
    poller._last_phase = LiveLifecyclePhase.MATCH_STARTED
    poller._tick_once()
    poller._last_phase = LiveLifecyclePhase.MATCH_IN_PROGRESS
    poller._tick_once()

    phases = [e.phase for e in seen]
    assert phases == [
        LiveLifecyclePhase.MATCH_STARTED,
        LiveLifecyclePhase.MATCH_IN_PROGRESS,
    ]


def test_replay_session_emits_menu_not_match() -> None:
    """The streamer reviewing a vod must NOT trigger scouting widgets
    for the in-replay opponent."""
    session = _StubSession()
    session.queue(
        "http://localhost:6119/ui",
        _ok({"activeScreens": []}),
    )
    session.queue(
        "http://localhost:6119/game",
        _ok({
            "isReplay": True,
            "displayTime": 120.0,
            "players": [
                {"id": 1, "name": "PlayerA", "type": "user",
                 "race": "Zerg", "result": "Undecided"},
                {"id": 2, "name": "PlayerB", "type": "user",
                 "race": "Protoss", "result": "Undecided"},
            ],
        }),
    )
    poller, seen = _make_poller(session)
    poller._tick_once()
    assert [e.phase for e in seen] == [LiveLifecyclePhase.MENU]


def test_user_name_hint_picks_correct_opponent() -> None:
    """When the streamer's name is known, opponent_for picks the
    other ``user`` player instead of falling back to index ordering.

    The hint is the difference between the widget showing 'Streamer
    vs Streamer' (broken) and 'Streamer vs Opponent' (correct) when
    Blizzard happens to list the streamer second in /game."""
    from sc2tools_agent.live.types import LiveGameState, LivePlayer
    state = LiveGameState(
        players=[
            LivePlayer(name="OppPlayer", type="user", race="Zerg",
                       result="Undecided"),
            LivePlayer(name="Streamer", type="user", race="Protoss",
                       result="Undecided"),
        ],
    )
    opp = state.opponent_for("Streamer")
    assert opp is not None and opp.name == "OppPlayer"


def test_match_end_takes_priority_over_loading() -> None:
    """The match-end branch fires even if /ui still shows ScreenLoading
    — this is a paranoia case for a Blizzard schema oddity where the
    score screen briefly co-exists with leftover loading state."""
    session = _StubSession()
    session.queue(
        "http://localhost:6119/ui",
        _ok({"activeScreens": ["ScreenLoading", "ScreenScore"]}),
    )
    session.queue(
        "http://localhost:6119/game",
        _ok({
            "isReplay": False,
            "displayTime": 600.0,
            "players": [
                {"id": 1, "name": "Me", "type": "user", "race": "Zerg",
                 "result": "Victory"},
                {"id": 2, "name": "Opp", "type": "user",
                 "race": "Protoss", "result": "Defeat"},
            ],
        }),
    )
    poller, seen = _make_poller(session)
    poller._tick_once()
    assert [e.phase for e in seen] == [LiveLifecyclePhase.MATCH_ENDED]


def test_loading_phase_returns_fast_interval() -> None:
    """During MATCH_LOADING we want the next poll to fire ~250 ms later
    so we catch the loading→in-game transition quickly."""
    session = _StubSession()
    session.queue(
        "http://localhost:6119/ui",
        _ok({"activeScreens": ["ScreenLoading"]}),
    )
    session.queue(
        "http://localhost:6119/game",
        _ok({
            "isReplay": False,
            "displayTime": 0.0,
            "players": [
                {"id": 1, "name": "Me", "type": "user", "race": "Zerg",
                 "result": "Undecided"},
                {"id": 2, "name": "Opp", "type": "user",
                 "race": "Protoss", "result": "Undecided"},
            ],
        }),
    )
    poller, _seen = _make_poller(session)
    phase, sleep_for = poller._tick_once()
    assert phase == LiveLifecyclePhase.MATCH_LOADING
    # The configured fast interval in our test poller is 0.005;
    # we just check the value comes from the fast interval, not the
    # default.
    assert sleep_for == pytest.approx(0.005, abs=1e-4)
    # And the production default (in DEFAULT_FAST_INTERVAL_SEC) is the
    # 250 ms the prompt calls for.
    assert DEFAULT_FAST_INTERVAL_SEC == pytest.approx(0.25)


def test_malformed_json_treated_as_unreachable() -> None:
    """A garbled response from /ui should NOT crash the poller — it's
    indistinguishable from the client being mid-restart."""
    session = _StubSession()
    bad = MagicMock()
    bad.status_code = 200
    bad.text = "not json"
    bad.json.side_effect = ValueError("bad json")
    session.queue("http://localhost:6119/ui", bad)
    poller, seen = _make_poller(session)
    phase, _sleep = poller._tick_once()
    assert phase == LiveLifecyclePhase.IDLE
    assert [e.phase for e in seen] == [LiveLifecyclePhase.IDLE]


def test_set_user_name_hint_updates_field() -> None:
    """Public setter exists so ``runner.py`` can update the hint after
    the player_handle resolves."""
    poller, _seen = _make_poller(_StubSession())
    assert poller._user_name_hint is None
    poller.set_user_name_hint("MyHandle")
    assert poller._user_name_hint == "MyHandle"
