"""Game-start scheduling through the existing title worker; no providers."""
from dataclasses import replace
import threading

import pytest

from sc2tools_agent.live.types import LiveGameState, LiveLifecycleEvent, LiveLifecyclePhase, LivePlayer
from sc2tools_agent.streaming.title_automation import GameTitleAutomation
from sc2tools_agent.streaming.title_match import START_DELAY_SECONDS, START_WINDOW_SECONDS


KEY = "Me|Opponent|1790000000000"
OTHER_KEY = "Me|Other|1790000010000"
PLAYERS = [LivePlayer("Me", "user", "Protoss", "Undecided"),
           LivePlayer("Opponent", "user", "Terran", "Undecided")]


@pytest.fixture(autouse=True)
def no_network(monkeypatch):
    def forbidden(*_args, **_kwargs):
        raise AssertionError("Game-start scheduler tests must never use a network or provider")
    monkeypatch.setattr("socket.socket.connect", forbidden)
    monkeypatch.setattr("requests.request", forbidden)


def live(at=1000, *, key=KEY, phase=LiveLifecyclePhase.MATCH_LOADING,
         display_time=0, replay=False, observer=False, players=None):
    return LiveLifecycleEvent(phase=phase, captured_at=at, game_key=key,
        game_state=LiveGameState(display_time=display_time, is_replay=replay,
            is_observer=observer, players=PLAYERS if players is None else players, captured_at=at))


def make_worker(*, enabled=True, consume=True, last_attempt=0):
    now, calls, post_sync = [1000.0], [], []
    def refresh_match(key, generation, final):
        calls.append((key, generation, final))
        return consume
    worker = GameTitleAutomation(post_sync.append, clock=lambda: now[0],
        last_attempt=last_attempt, refresh_match=refresh_match)
    worker.preview_pending = False
    worker.match.configure(enabled)
    return worker, now, calls, post_sync


def test_loading_start_and_progress_publish_once_for_each_game_key():
    worker, now, calls, post_sync = make_worker()
    worker.on_event(live())
    now[0] = 1001
    worker.on_event(live(now[0], phase=LiveLifecyclePhase.MATCH_STARTED, display_time=1))
    assert not worker.run_once()
    now[0] = 1000 + START_DELAY_SECONDS
    assert worker.run_once()
    assert [call[0] for call in calls] == [KEY]
    for second in (4, 10, 30):
        now[0] = 1000 + second
        worker.on_event(live(now[0], phase=LiveLifecyclePhase.MATCH_IN_PROGRESS, display_time=second))
        assert not worker.run_once()
    assert len(calls) == 1 and post_sync == []
    now[0] = 1040
    worker.on_event(live(now[0], key=OTHER_KEY))
    now[0] += START_DELAY_SECONDS
    assert worker.run_once()
    assert [call[0] for call in calls] == [KEY, OTHER_KEY]


def test_start_refresh_is_independent_of_post_sync_ten_minute_cooldown():
    worker, now, calls, post_sync = make_worker(last_attempt=999)
    worker.ready = True
    worker.on_event(live())
    now[0] += START_DELAY_SECONDS
    assert worker.run_once()
    assert len(calls) == 1 and post_sync == []
    assert worker.ready and worker.last_attempt == 999


def test_missing_enrichment_retries_until_one_final_attempt_at_deadline():
    worker, now, calls, _ = make_worker(consume=False)
    worker.on_event(live())
    assert not worker.run_once()
    now[0] += START_DELAY_SECONDS
    assert worker.run_once()
    assert calls[0][2] is False
    now[0] += 4.99
    assert not worker.run_once()
    while worker.match.pending is not None:
        now[0] = worker.match.pending["due"]
        assert worker.run_once()
    assert calls[-1][2] is True
    assert now[0] == 1000 + START_WINDOW_SECONDS
    assert len(calls) <= 13
    now[0] += 1
    assert not worker.run_once()
    worker.on_event(live(now[0], display_time=59))
    assert not worker.run_once()  # the same episode never re-arms


@pytest.mark.parametrize("cancel", ["replay", "observer", "menu", "idle", "end", "new_key"])
def test_lifecycle_cancellation_drops_pending_start_and_invalidates_claim(cancel):
    worker, now, calls, _ = make_worker()
    worker.on_event(live())
    generation = worker.match.generation
    now[0] = 1001
    if cancel in {"replay", "observer"}:
        changed = live(now[0], replay=cancel == "replay", observer=cancel == "observer")
    elif cancel == "new_key":
        changed = live(now[0], key=OTHER_KEY, display_time=80)
    else:
        phase = {"menu": LiveLifecyclePhase.MENU, "idle": LiveLifecyclePhase.IDLE,
                 "end": LiveLifecyclePhase.MATCH_ENDED}[cancel]
        changed = live(now[0], phase=phase, key=KEY if cancel == "end" else None)
    worker.on_event(changed)
    assert not worker.match.is_current(KEY, generation)
    now[0] = 1004
    assert not worker.run_once()
    assert calls == []


def test_new_key_replaces_old_pending_with_its_own_start_delay():
    worker, now, calls, _ = make_worker()
    worker.on_event(live())
    now[0] = 1002
    worker.on_event(live(now[0], key=OTHER_KEY))
    now[0] = 1003
    assert not worker.run_once()
    now[0] = 1005
    assert worker.run_once()
    assert [call[0] for call in calls] == [OTHER_KEY]


def test_old_and_out_of_order_events_cannot_restore_a_previous_match():
    worker, now, calls, _ = make_worker()
    worker.on_event(live())
    now[0] = 1002
    worker.on_event(live(now[0], key=OTHER_KEY))
    generation = worker.match.generation
    worker.on_event(live(1001, phase=LiveLifecyclePhase.MATCH_IN_PROGRESS))
    worker.on_event(live(1003, phase=LiveLifecyclePhase.MATCH_ENDED))
    worker.on_event(live(700, phase=LiveLifecyclePhase.MENU, key=None))
    assert worker.match.is_current(OTHER_KEY, generation)
    now[0] = 1005
    assert worker.run_once()
    assert [call[0] for call in calls] == [OTHER_KEY]


@pytest.mark.parametrize("bad_time", [True, None, float("nan"), float("inf"), 800, 1201])
def test_invalid_or_out_of_window_lifecycle_timestamp_does_not_arm_start(bad_time):
    worker, now, calls, _ = make_worker()
    worker.on_event(replace(live(), captured_at=bad_time))
    now[0] = 1010
    assert not worker.run_once()
    assert calls == []


def test_loading_roster_correction_keeps_pending_deadline_and_cannot_publish_twice():
    worker, now, calls, _ = make_worker(consume=False)
    worker.on_event(live())
    now[0] = 1003
    assert worker.run_once()
    corrected = "Me|CorrectedOpponent|1790000000000"
    now[0] = 1004
    worker.on_event(live(now[0], key=corrected))
    assert worker.match.pending["deadline"] == 1060
    assert worker.match.pending["due"] == 1008
    worker.match.refresh = lambda key, generation, final: calls.append((key, generation, final)) or True
    now[0] = 1008
    assert worker.run_once()
    assert [call[0] for call in calls] == [KEY, corrected]
    now[0] = 1009
    worker.on_event(live(now[0], key="Me|FinalOpponent|1790000000000"))
    now[0] = 1012
    assert not worker.run_once()
    assert len(calls) == 2  # one unpublished read and one consumed update


def test_correction_after_publication_is_not_a_second_game_start():
    worker, now, calls, _ = make_worker()
    worker.on_event(live())
    now[0] = 1003
    worker.run_once()
    now[0] = 1004
    worker.on_event(live(now[0], key="Me|Corrected|1790000000000"))
    now[0] = 1007
    assert not worker.run_once()
    assert len(calls) == 1


@pytest.mark.parametrize("cancel", ["menu", "disable", "shutdown", "replacement"])
def test_lifecycle_handoff_does_not_block_on_slow_read_and_cancels_its_claim(cancel):
    worker, now, calls, _ = make_worker(consume=False)
    entered, finish, handed_off = threading.Event(), threading.Event(), threading.Event()
    writes = []
    def held_read(key, generation, final):
        entered.set()
        assert finish.wait(3)
        if worker.match.is_current(key, generation):
            writes.append(key)
        return False
    worker.match.refresh = held_read
    worker.on_event(live())
    now[0] = 1003
    reading = threading.Thread(target=worker.run_once)
    reading.start()
    try:
        assert entered.wait(1)
        def handoff():
            if cancel == "disable":
                worker.match.configure(False)
            elif cancel == "shutdown":
                worker.close()
            else:
                worker.on_event(live(1004, key=OTHER_KEY if cancel == "replacement" else None,
                    phase=LiveLifecyclePhase.MATCH_LOADING if cancel == "replacement" else LiveLifecyclePhase.MENU))
            handed_off.set()
        lifecycle = threading.Thread(target=handoff)
        lifecycle.start()
        assert handed_off.wait(1), "The live event waited on a title read"
        lifecycle.join(1)
    finally:
        finish.set()
        reading.join(3)
    assert not reading.is_alive()
    assert writes == []
    if cancel != "replacement":
        assert worker.match.pending is None


def test_off_partial_roster_ai_team_and_midgame_events_do_not_authorize_start():
    worker, now, calls, _ = make_worker(enabled=False)
    worker.on_event(live())
    now[0] = 1004
    assert not worker.run_once()
    worker.match.configure(True)
    for players in ([], PLAYERS[:1], [PLAYERS[0], replace(PLAYERS[1], type="computer")], PLAYERS + [PLAYERS[0]]):
        worker.on_event(live(now[0], players=players))
        assert worker.match.pending is None
    worker.on_event(live(now[0], display_time=61))
    assert not worker.run_once()
    assert calls == []


def test_disable_reset_and_shutdown_discard_start_work():
    worker, now, calls, _ = make_worker()
    worker.on_event(live())
    worker.match.configure(False)
    now[0] = 1004
    assert not worker.run_once()
    worker.reset()
    assert not worker.match.enabled and worker.match.current_key() is None
    worker.preview_pending = False
    worker.match.configure(True)
    worker.on_event(live(now[0], key=OTHER_KEY))
    worker.close()
    now[0] = 1008
    assert not worker.run_once()
    assert calls == []
