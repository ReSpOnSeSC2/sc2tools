"""Worker scheduling with local fakes only; no authenticated/provider wiring."""
from datetime import datetime, timezone
from types import SimpleNamespace
import threading

import pytest

from sc2tools_agent.live import EventBus
from sc2tools_agent.live.types import LiveLifecycleEvent, LiveLifecyclePhase, LiveGameState
from sc2tools_agent.streaming.title_automation import GameTitleAutomation


def ended(at=1000, *, key="game-one", replay=False):
    return LiveLifecycleEvent(phase=LiveLifecyclePhase.MATCH_ENDED, captured_at=at,
                              game_state=LiveGameState(is_replay=replay), game_key=key)


def accepted(at=1000, *, resumed=False):
    return SimpleNamespace(date_iso=datetime.fromtimestamp(at, timezone.utc).isoformat(),
                           is_resumed_from_replay=resumed)


@pytest.fixture(autouse=True)
def no_network(monkeypatch):
    def forbidden(*args, **kwargs):
        raise AssertionError("Worker tests must not use a network or provider.")
    monkeypatch.setattr("socket.socket.connect", forbidden)
    monkeypatch.setattr("requests.request", forbidden)


def test_actual_lifecycle_waits_for_synced_live_replay_and_ignores_history():
    calls = []
    worker = GameTitleAutomation(calls.append, clock=lambda: 1000)
    bus = EventBus()
    bus.subscribe(worker.on_event)
    assert worker.run_once() is True  # read-only local preview request
    assert calls == [False]
    bus.publish(ended())
    assert worker.run_once() is False
    worker.on_game_accepted(None, accepted(100))
    assert worker.run_once() is False
    worker.on_game_accepted(None, accepted(resumed=True))
    assert worker.run_once() is False
    worker.on_game_accepted(None, accepted())
    assert worker.run_once() is True
    assert calls == [False, True]
    bus.publish(ended())  # duplicate lifecycle/acceptance must not repeat
    worker.on_game_accepted(None, accepted())
    assert worker.run_once() is False


def test_burst_coalesces_to_latest_synced_game_and_obeys_exact_ten_minute_limit():
    now = [1000]
    calls = []
    worker = GameTitleAutomation(calls.append, clock=lambda: now[0])
    worker.run_once()
    for key, when in (("first", 1000), ("second", 1100)):
        now[0] = when
        worker.on_event(ended(when, key=key))
        worker.on_game_accepted(None, accepted(when))
        worker.run_once()
    assert calls == [False, True]
    now[0] = 1599.99
    assert worker.run_once() is False
    now[0] = 1600
    assert worker.run_once() is True
    assert calls == [False, True, True]
    assert worker.run_once() is False


def test_accepted_live_receipt_before_end_schedules_once_and_duplicates_cannot_rearm():
    calls = []
    worker = GameTitleAutomation(calls.append, clock=lambda: 1000)
    worker.run_once()
    worker.on_game_accepted(None, accepted())
    assert worker.run_once() is False
    worker.on_event(ended())
    assert worker.run_once() is True
    assert calls == [False, True]
    worker.on_game_accepted(None, accepted())
    worker.on_event(ended())
    assert worker.run_once() is False
    # A different event key still needs a new receipt; the consumed prior
    # upload cannot authorize a second nearby game during the cooldown.
    worker.on_event(ended(1050, key="different-game"))
    assert not worker.ready and not worker.accepted_receipts


def test_reverse_order_receipts_are_bounded_and_unrelated_expired_history_or_resumed_do_not_match():
    now = [1000]
    worker = GameTitleAutomation(lambda _automatic: None, clock=lambda: now[0])
    worker.run_once()
    worker.on_game_accepted(None, accepted(resumed=True))
    history = accepted()
    history.is_history = True
    worker.on_game_accepted(None, history)
    worker.on_game_accepted(None, accepted(), "fixture", {"isHistory": True})
    assert worker.accepted_receipts == []
    for end in range(990, 1000):
        worker.on_game_accepted(None, accepted(end))
    assert len(worker.accepted_receipts) == 4
    worker.on_event(ended(1200, key="unrelated"))
    assert worker.run_once() is False
    now[0] = 1201
    worker.on_event(ended(1000, key="stale-event"))
    assert not worker.ready and not worker.accepted_receipts


def test_restart_or_owner_reset_discards_reverse_order_receipts_without_replaying_game_end():
    calls = []
    worker = GameTitleAutomation(calls.append, clock=lambda: 1000)
    worker.run_once()
    worker.on_game_accepted(None, accepted())
    assert worker.accepted_receipts
    worker.reset()
    assert not worker.accepted_receipts and not worker.consumed_receipts
    worker.on_event(ended())
    assert worker.run_once() is True  # new-owner preview only
    assert calls == [False, False]
    restarted = GameTitleAutomation(calls.append, clock=lambda: 1000, last_attempt=900)
    restarted.run_once()
    restarted.on_event(ended())
    assert restarted.run_once() is False
    assert not restarted.ready


def test_replay_viewing_other_phases_and_unidentified_game_do_not_schedule():
    worker = GameTitleAutomation(lambda automatic: None, clock=lambda: 1000)
    worker.run_once()
    worker.on_event(ended(replay=True))
    worker.on_event(ended(key=None))
    worker.on_event(LiveLifecycleEvent(phase=LiveLifecyclePhase.MATCH_STARTED, game_key="start"))
    worker.on_game_accepted(None, accepted())
    assert worker.run_once() is False


def test_real_worker_never_blocks_lifecycle_or_the_upload_callback_while_read_is_slow():
    reading, finish, observed = threading.Event(), threading.Event(), []
    def refresh(automatic):
        observed.append((automatic, threading.current_thread().name))
        reading.set()
        assert finish.wait(5)
    worker = GameTitleAutomation(refresh, clock=lambda: 1000)
    worker.start()
    try:
        assert reading.wait(2)
        handed_off = threading.Event()
        def upload_handoff():
            worker.on_event(ended())
            worker.on_game_accepted(None, accepted())
            handed_off.set()
        uploader = threading.Thread(target=upload_handoff)
        uploader.start()
        assert handed_off.wait(1), "Title read held the lock needed by uploads"
        uploader.join(timeout=1)
        assert observed == [(False, "sc2tools-stream-titles")]
    finally:
        finish.set()
        worker.close()
    assert not worker.thread.is_alive()
    assert worker.run_once() is False


def test_restored_timestamp_preserves_cooldown_and_invalid_timestamp_is_safe():
    now = [1200]
    calls = []
    worker = GameTitleAutomation(calls.append, clock=lambda: now[0], last_attempt=1000)
    worker.run_once()
    worker.on_event(ended(1200))
    worker.on_game_accepted(None, accepted(1200))
    assert worker.run_once() is False
    now[0] = 1600
    assert worker.run_once() is True
    future = GameTitleAutomation(lambda _: None, clock=lambda: 1000, last_attempt=999999)
    assert future.last_attempt == 1000
    invalid = GameTitleAutomation(lambda _: None, clock=lambda: 1000, last_attempt=float("nan"))
    assert invalid.last_attempt == 0
