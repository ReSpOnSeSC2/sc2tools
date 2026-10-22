"""A match the poller briefly lost track of comes back under a new key: the
register says whether the key saw its own loading screen, and the
loading-screen pick carries over to the new key (only for that match, never
to a rematch against the same opponent)."""

from __future__ import annotations

from typing import Any, Dict, List

import pytest

from sc2tools_agent.build_checkin.controller import (
    REKEY_LOADING_GAP_SEC,
    REKEY_MATCH_GAP_SEC,
)
from sc2tools_agent.build_checkin.models import LOCKED_IN
from tests.build_checkin_fakes import Harness, envelope

DT = "custom:dt-3-gate"
MENU = {"type": "liveGameState", "phase": "menu"}


@pytest.fixture
def h() -> Harness:
    return Harness().boot()


def _bodies(h: Harness, key: str) -> List[Dict[str, Any]]:
    return [args[1] for args, _ in h.api.calls_to("put_live_intent") if args[0] == key]


def _declares(h: Harness, key: str) -> List[str]:
    return [body["buildKey"] for body in _bodies(h, key) if body["action"] == "declare"]


def _declared_then_lost(h: Harness) -> str:
    key = h.new_key()
    h.send(envelope("match_loading", key))
    h.ctl.declare(key, DT)
    h.pump()
    h.send(MENU)
    return key


def test_register_says_the_card_saw_the_loading_screen(h: Harness) -> None:
    key = h.new_key()
    h.send(envelope("match_loading", key))
    h.send(envelope("match_started", key, display_time=1.0))
    assert [body.get("phase") for body in _bodies(h, key)] == ["match_loading"]


def test_register_of_a_match_first_seen_running(h: Harness) -> None:
    key = h.new_key()
    h.send(envelope("match_started", key, display_time=5.0))
    assert _bodies(h, key)[0]["phase"] == "match_started"


def test_a_loading_screen_back_within_seconds_keeps_the_pick(h: Harness) -> None:
    _declared_then_lost(h)
    h.advance(REKEY_LOADING_GAP_SEC - 1)
    key = h.new_key()
    h.send(envelope("match_loading", key))
    assert _declares(h, key) == [DT]
    model = h.view.last("show_loading", "update_loading")
    assert model.game_key == key
    assert model.locked_label == LOCKED_IN.format(name="DT into 3 Gate")


def test_the_card_registers_before_the_carried_declare(h: Harness) -> None:
    _declared_then_lost(h)
    key = h.new_key()
    h.send(envelope("match_loading", key))
    # A register answer can predate the declare: it must never be newer.
    assert [body["action"] for body in _bodies(h, key)] == ["register", "declare"]


def test_a_match_first_seen_running_keeps_the_pick(h: Harness) -> None:
    _declared_then_lost(h)
    h.advance(REKEY_MATCH_GAP_SEC - 1)
    key = h.new_key()
    h.send(envelope("match_started", key, display_time=60.0))
    assert _declares(h, key) == [DT]


def test_a_rematch_against_the_same_opponent_starts_clean(h: Harness) -> None:
    _declared_then_lost(h)
    h.advance(REKEY_LOADING_GAP_SEC + 1)
    key = h.new_key()
    h.send(envelope("match_loading", key))
    assert _declares(h, key) == []
    assert h.view.last("show_loading", "update_loading").locked_label is None


@pytest.mark.parametrize("arrange", [
    pytest.param(lambda h, key: h.end(key), id="the match ended"),
    pytest.param(lambda h, key: None, id="the poller never left it"),
])
def test_no_carry_after_a_finished_or_open_match(h: Harness, arrange) -> None:
    first = h.new_key()
    h.send(envelope("match_loading", first))
    h.ctl.declare(first, DT)
    h.pump()
    arrange(h, first)
    key = h.new_key()
    h.send(envelope("match_loading", key))
    assert _declares(h, key) == []


def test_no_carry_to_another_opponent(h: Harness) -> None:
    _declared_then_lost(h)
    key = h.new_key(names="Bar|Me#123")
    h.send(envelope("match_loading", key, opponent=("Bar", "Zerg")))
    assert _declares(h, key) == []


def test_waits_for_the_matchup_before_carrying(h: Harness) -> None:
    _declared_then_lost(h)
    key = h.new_key()
    h.send(envelope("match_loading", key, opponent=("Foo", None)))
    assert _declares(h, key) == []
    h.send(envelope("match_loading", key))
    assert _declares(h, key) == [DT]
