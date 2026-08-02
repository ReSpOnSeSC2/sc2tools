"""Unit tests for ``sc2tools_agent.live.obs_scene``.

No test here needs a running OBS — the controller takes its client by
injection, exactly the way ``OverlayBackendTransport`` takes ``session=``
in ``test_live_transport.py``. That matters because the agent suite runs
on ``windows-latest`` in CI with no OBS installed.

The controller does its work on a background thread, so the assertions
go through ``_wait_for`` (same helper shape as the transport tests)
rather than sleeping a fixed amount.
"""

from __future__ import annotations

import threading
import time
from typing import Any, Dict, List, Optional
from unittest.mock import MagicMock

import pytest

from sc2tools_agent.live.obs_client import ObsUnavailable
from sc2tools_agent.live.obs_scene import (
    DEFAULT_SCENE_MAP,
    SCENE_BETWEEN_GAMES,
    SCENE_IN_GAME,
    ObsSceneController,
)


def _wait_for(predicate, timeout: float = 2.0, step: float = 0.005) -> bool:
    end = time.time() + timeout
    while time.time() < end:
        if predicate():
            return True
        time.sleep(step)
    return False


class FakeClock:
    """Manually advanced monotonic clock.

    The leave-debounce is a wall-clock deadline, so the tests drive it
    explicitly instead of sleeping out three real seconds each time.
    """

    def __init__(self) -> None:
        self._now = 1000.0
        self._lock = threading.Lock()

    def __call__(self) -> float:
        with self._lock:
            return self._now

    def advance(self, seconds: float) -> None:
        with self._lock:
            self._now += seconds


class FakeObs:
    """Minimal stand-in for ``ObsClient``."""

    def __init__(
        self,
        *,
        scenes: Optional[List[str]] = None,
        fail_with: Optional[BaseException] = None,
    ) -> None:
        self.scene_names = scenes if scenes is not None else [
            SCENE_IN_GAME,
            SCENE_BETWEEN_GAMES,
        ]
        self.calls: List[str] = []
        self.transitions: List[str] = []
        self.durations: List[int] = []
        self._fail_with = fail_with
        self._lock = threading.Lock()

    def set_current_program_scene(self, name: str) -> None:
        if self._fail_with is not None:
            raise self._fail_with
        with self._lock:
            self.calls.append(name)

    def set_current_scene_transition(self, name: str) -> None:
        self.transitions.append(name)

    def set_current_scene_transition_duration(self, ms: int) -> None:
        self.durations.append(ms)

    @property
    def call_count(self) -> int:
        with self._lock:
            return len(self.calls)


def _envelope(phase: str, **extra: Any) -> Dict[str, Any]:
    payload: Dict[str, Any] = {"type": "liveGameState", "phase": phase}
    payload.update(extra)
    return payload


@pytest.fixture()
def controller_factory():
    """Build a started controller and guarantee teardown."""
    made: List[ObsSceneController] = []

    def _make(**kwargs: Any) -> ObsSceneController:
        ctrl = ObsSceneController(**kwargs)
        ctrl.start()
        made.append(ctrl)
        return ctrl

    yield _make
    for ctrl in made:
        ctrl.shutdown()


# ---------------- edge triggering ----------------


def test_repeated_in_progress_ticks_switch_exactly_once(controller_factory):
    """The bridge fires at ~1 Hz for the whole match. A five-minute
    game must produce one SetCurrentProgramScene, not three hundred."""
    obs = FakeObs()
    ctrl = controller_factory(client=obs, clock=FakeClock())

    ctrl.listener(_envelope("match_loading"))
    assert _wait_for(lambda: obs.call_count == 1)

    for _ in range(10):
        ctrl.listener(_envelope("match_in_progress"))
        time.sleep(0.005)

    # Give the worker room to have gotten it wrong.
    time.sleep(0.1)
    assert obs.calls == [SCENE_IN_GAME]


def test_match_loading_switches_immediately(controller_factory):
    """Entering a match is never debounced — the cut has to land
    before the map fades in."""
    clock = FakeClock()
    obs = FakeObs()
    ctrl = controller_factory(client=obs, clock=clock, debounce_sec=3.0)

    ctrl.listener(_envelope("match_loading"))

    # No clock advance at all.
    assert _wait_for(lambda: obs.calls == [SCENE_IN_GAME])


def test_match_ended_holds_the_in_game_scene(controller_factory):
    """The score screen is worth showing — MATCH_ENDED stays put and
    the cut happens on the drop to MENU."""
    clock = FakeClock()
    obs = FakeObs()
    ctrl = controller_factory(client=obs, clock=clock, debounce_sec=3.0)

    ctrl.listener(_envelope("match_loading"))
    assert _wait_for(lambda: obs.calls == [SCENE_IN_GAME])

    ctrl.listener(_envelope("match_ended"))
    time.sleep(0.1)
    assert obs.calls == [SCENE_IN_GAME], "match_ended must not switch"

    # Let the worker arm the deadline before moving the clock, or the
    # advance lands before ``_pending_at`` is computed and the switch
    # ends up scheduled 3.5 s further out than the test expects.
    ctrl.listener(_envelope("menu"))
    time.sleep(0.05)
    clock.advance(3.5)
    assert _wait_for(
        lambda: obs.calls == [SCENE_IN_GAME, SCENE_BETWEEN_GAMES],
    )


# ---------------- leave debounce ----------------


def test_brief_menu_blip_mid_game_does_not_switch(controller_factory):
    """A dropped localhost:6119 poll or an alt-tab must never yank the
    layout on a live stream."""
    clock = FakeClock()
    obs = FakeObs()
    ctrl = controller_factory(client=obs, clock=clock, debounce_sec=3.0)

    ctrl.listener(_envelope("match_in_progress"))
    assert _wait_for(lambda: obs.calls == [SCENE_IN_GAME])

    # Blip to menu, then straight back before the deadline.
    ctrl.listener(_envelope("menu"))
    clock.advance(1.0)
    time.sleep(0.05)
    ctrl.listener(_envelope("match_in_progress"))
    clock.advance(5.0)
    time.sleep(0.15)

    assert obs.calls == [SCENE_IN_GAME], "blip must not trigger a switch"


def test_sustained_menu_switches_after_the_deadline(controller_factory):
    clock = FakeClock()
    obs = FakeObs()
    ctrl = controller_factory(client=obs, clock=clock, debounce_sec=3.0)

    ctrl.listener(_envelope("match_in_progress"))
    assert _wait_for(lambda: obs.calls == [SCENE_IN_GAME])

    # The poller de-duplicates MENU, so this arrives exactly once —
    # the deadline, not a repeat count, is what fires the switch.
    ctrl.listener(_envelope("menu"))
    time.sleep(0.05)
    assert obs.calls == [SCENE_IN_GAME], "must not fire before the deadline"

    clock.advance(3.5)
    assert _wait_for(
        lambda: obs.calls == [SCENE_IN_GAME, SCENE_BETWEEN_GAMES],
    )


def test_idle_is_debounced_like_menu(controller_factory):
    clock = FakeClock()
    obs = FakeObs()
    ctrl = controller_factory(client=obs, clock=clock, debounce_sec=3.0)

    ctrl.listener(_envelope("match_in_progress"))
    assert _wait_for(lambda: obs.calls == [SCENE_IN_GAME])

    ctrl.listener(_envelope("idle"))
    time.sleep(0.05)
    assert obs.calls == [SCENE_IN_GAME]

    clock.advance(3.5)
    assert _wait_for(lambda: obs.calls[-1] == SCENE_BETWEEN_GAMES)


def test_zero_debounce_switches_out_immediately(controller_factory):
    obs = FakeObs()
    ctrl = controller_factory(
        client=obs, clock=FakeClock(), debounce_sec=0.0,
    )

    ctrl.listener(_envelope("match_in_progress"))
    assert _wait_for(lambda: obs.calls == [SCENE_IN_GAME])
    ctrl.listener(_envelope("menu"))
    assert _wait_for(lambda: obs.calls[-1] == SCENE_BETWEEN_GAMES)


# ---------------- replay suppression ----------------


def test_replay_playback_never_switches(controller_factory):
    """Watching your own replay reports the same phases as a real
    game. It must not fire the in-game layout."""
    obs = FakeObs()
    ctrl = controller_factory(client=obs, clock=FakeClock())

    ctrl.listener(_envelope("match_loading", isReplay=True))
    ctrl.listener(_envelope("match_started", isReplay=True))
    ctrl.listener(_envelope("match_in_progress", isReplay=True))
    time.sleep(0.15)

    assert obs.calls == []


def test_replay_switching_can_be_opted_into(controller_factory):
    obs = FakeObs()
    ctrl = controller_factory(
        client=obs, clock=FakeClock(), switch_on_replays=True,
    )

    ctrl.listener(_envelope("match_loading", isReplay=True))
    assert _wait_for(lambda: obs.calls == [SCENE_IN_GAME])


# ---------------- configuration ----------------


def test_blank_mapping_means_do_not_switch(controller_factory):
    """Every slot is independently optional — a user who only wants
    two scenes leaves the rest empty."""
    obs = FakeObs()
    ctrl = controller_factory(
        client=obs,
        clock=FakeClock(),
        scene_map={
            "match_loading": SCENE_IN_GAME,
            "menu": "",
            "idle": "",
        },
    )

    ctrl.listener(_envelope("match_loading"))
    assert _wait_for(lambda: obs.calls == [SCENE_IN_GAME])

    ctrl.listener(_envelope("menu"))
    time.sleep(0.15)
    assert obs.calls == [SCENE_IN_GAME], "blank mapping must be a no-op"


def test_disabled_controller_never_touches_obs():
    obs = FakeObs()
    ctrl = ObsSceneController(client=obs, enabled=False, clock=FakeClock())
    ctrl.start()
    try:
        ctrl.listener(_envelope("match_loading"))
        time.sleep(0.1)
        assert obs.calls == []
    finally:
        ctrl.shutdown()


def test_set_config_reapplies_a_new_map(controller_factory):
    obs = FakeObs(scenes=[SCENE_IN_GAME, SCENE_BETWEEN_GAMES, "Custom"])
    ctrl = controller_factory(client=obs, clock=FakeClock())

    ctrl.listener(_envelope("match_loading"))
    assert _wait_for(lambda: obs.calls == [SCENE_IN_GAME])

    ctrl.set_config(scene_map={"match_loading": "Custom"})
    ctrl.listener(_envelope("match_loading"))
    assert _wait_for(lambda: obs.calls == [SCENE_IN_GAME, "Custom"])


# ---------------- missing scenes ----------------


def test_missing_scene_warns_once_and_does_not_throw(
    controller_factory, caplog,
):
    obs = FakeObs(scenes=["Only Scene"])
    ctrl = controller_factory(client=obs, clock=FakeClock())

    with caplog.at_level("WARNING"):
        for _ in range(5):
            ctrl.listener(_envelope("match_loading"))
            time.sleep(0.02)
        time.sleep(0.1)

    assert obs.calls == []
    missing = [r for r in caplog.records if "obs_scene_missing" in r.message]
    assert len(missing) == 1, "must warn once, not once per transition"


def test_empty_scene_list_does_not_block_switching(controller_factory):
    """A client that hasn't populated its scene cache yet (a
    reconnect in flight) must not cause every switch to be skipped."""
    obs = FakeObs(scenes=[])
    ctrl = controller_factory(client=obs, clock=FakeClock())

    ctrl.listener(_envelope("match_loading"))
    assert _wait_for(lambda: obs.calls == [SCENE_IN_GAME])


# ---------------- manual override ----------------


def test_manual_switch_holds_until_the_next_phase_change(controller_factory):
    clock = FakeClock()
    obs = FakeObs(scenes=[SCENE_IN_GAME, SCENE_BETWEEN_GAMES, "Just Chatting"])
    ctrl = controller_factory(client=obs, clock=clock, debounce_sec=0.0)

    ctrl.listener(_envelope("match_in_progress"))
    assert _wait_for(lambda: obs.calls == [SCENE_IN_GAME])

    # Streamer switches by hand mid-game.
    ctrl.on_program_scene_changed("Just Chatting")

    # Further ticks of the SAME phase must not drag them back.
    for _ in range(3):
        ctrl.listener(_envelope("match_in_progress"))
        time.sleep(0.02)
    time.sleep(0.1)
    assert obs.calls == [SCENE_IN_GAME], "must not fight the streamer"

    # A real phase change lifts the hold.
    ctrl.listener(_envelope("menu"))
    assert _wait_for(lambda: obs.calls[-1] == SCENE_BETWEEN_GAMES)


def test_our_own_switch_does_not_trigger_the_manual_hold(controller_factory):
    """OBS echoes CurrentProgramSceneChanged for switches we made.
    Mistaking that for manual control would disable the feature after
    the very first switch."""
    obs = FakeObs()
    ctrl = controller_factory(client=obs, clock=FakeClock(), debounce_sec=0.0)

    ctrl.listener(_envelope("match_loading"))
    assert _wait_for(lambda: obs.calls == [SCENE_IN_GAME])

    # The echo.
    ctrl.on_program_scene_changed(SCENE_IN_GAME)

    ctrl.listener(_envelope("menu"))
    assert _wait_for(lambda: obs.calls[-1] == SCENE_BETWEEN_GAMES)


# ---------------- failure handling ----------------


def test_disconnected_obs_is_skipped_quietly(controller_factory):
    obs = FakeObs(fail_with=ObsUnavailable("not connected"))
    ctrl = controller_factory(client=obs, clock=FakeClock())

    ctrl.listener(_envelope("match_loading"))
    assert _wait_for(lambda: ctrl.switches_failed == 1)
    assert ctrl.switches_ok == 0


def test_unexpected_request_error_does_not_kill_the_worker(
    controller_factory,
):
    obs = FakeObs(fail_with=RuntimeError("boom"))
    ctrl = controller_factory(client=obs, clock=FakeClock())

    ctrl.listener(_envelope("match_loading"))
    assert _wait_for(lambda: ctrl.switches_failed == 1)

    # Worker survived: a subsequent healthy switch still lands.
    obs._fail_with = None
    ctrl.listener(_envelope("menu"))
    ctrl.listener(_envelope("match_loading"))
    assert _wait_for(lambda: ctrl.switches_ok >= 1)


def test_listener_never_raises_into_the_bridge():
    """``EventBus`` calls subscribers inline on the publisher's thread.
    An exception escaping here would break the poller."""
    ctrl = ObsSceneController(client=MagicMock(), clock=FakeClock())
    # Deliberately hostile payloads — the bus makes no shape promises
    # beyond what the bridge happens to publish today.
    for payload in ({}, {"phase": None}, {"phase": 42}, {"nope": True}):
        ctrl.listener(payload)  # type: ignore[arg-type]


# ---------------- transitions ----------------


def test_transition_is_left_alone_by_default(controller_factory):
    obs = FakeObs()
    ctrl = controller_factory(client=obs, clock=FakeClock())

    ctrl.listener(_envelope("match_loading"))
    assert _wait_for(lambda: obs.calls == [SCENE_IN_GAME])
    assert obs.transitions == [], "must not override the user's transition"
    assert obs.durations == []


def test_configured_transition_is_applied(controller_factory):
    obs = FakeObs()
    ctrl = controller_factory(
        client=obs,
        clock=FakeClock(),
        transition_name="Fade",
        transition_duration_ms=250,
    )

    ctrl.listener(_envelope("match_loading"))
    assert _wait_for(lambda: obs.calls == [SCENE_IN_GAME])
    assert obs.transitions == ["Fade"]
    assert obs.durations == [250]


# ---------------- default map ----------------


def test_default_map_covers_every_lifecycle_phase():
    from sc2tools_agent.live.types import LiveLifecyclePhase

    for phase in LiveLifecyclePhase:
        assert phase.value in DEFAULT_SCENE_MAP, (
            f"{phase.value} missing from DEFAULT_SCENE_MAP — a new phase "
            "was added without deciding what OBS should do about it"
        )
