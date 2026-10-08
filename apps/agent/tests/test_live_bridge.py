"""Unit tests for ``sc2tools_agent.live.bridge.LiveBridge``.

The bridge subscribes to a lifecycle ``EventBus`` (the poller's output)
and emits enriched envelopes on its own ``bus`` (the transport input).
We test by:

* Constructing a stub ``PulseClient`` whose ``resolve`` returns a
  preset profile (or blocks on an ``Event`` so we can test the
  late-arrival re-emit).
* Driving the lifecycle bus directly with synthetic events.
* Asserting on the dicts the bridge publishes.
"""

from __future__ import annotations

import threading
import time
from concurrent.futures import Future
from typing import Any, Dict, List, Optional

import pytest

from sc2tools_agent.live.bridge import LiveBridge
from sc2tools_agent.live.event_bus import EventBus
from sc2tools_agent.live.types import (
    LiveGameState,
    LiveLifecycleEvent,
    LiveLifecyclePhase,
    LivePlayer,
    LiveUIState,
    OpponentProfile,
)


class _StubPulseClient:
    """Minimal stand-in for ``PulseClient``. Exposes ``resolve`` only —
    the bridge doesn't touch any other method."""

    def __init__(
        self,
        *,
        profile: Optional[OpponentProfile] = None,
        delay_event: Optional[threading.Event] = None,
    ) -> None:
        self.profile = profile
        self.delay_event = delay_event
        self.calls: list[dict[str, Any]] = []

    def resolve(
        self,
        *,
        name: str,
        region: Optional[str] = None,
        race: Optional[str] = None,
    ) -> Optional[OpponentProfile]:
        self.calls.append({"name": name, "region": region, "race": race})
        if self.delay_event is not None:
            # Wait until the test releases us so we can simulate
            # late-arriving Pulse responses.
            self.delay_event.wait(timeout=2.0)
        return self.profile


def _build_loading_event(
    opp_name: str = "OppPlayer",
    user_name: str = "Streamer",
    game_key: str = "OppPlayer|Streamer|1717000000000",
    user_race: str = "Zerg",
    opp_race: str = "Protoss",
) -> LiveLifecycleEvent:
    return LiveLifecycleEvent(
        phase=LiveLifecyclePhase.MATCH_LOADING,
        ui_state=LiveUIState(active_screens=["ScreenLoading"]),
        game_state=LiveGameState(
            display_time=0.0,
            players=[
                LivePlayer(name=user_name, type="user", race=user_race,
                           result="Undecided"),
                LivePlayer(name=opp_name, type="user", race=opp_race,
                           result="Undecided"),
            ],
        ),
        game_key=game_key,
    )


def _build_in_progress_event(
    *,
    opp_name: str = "OppPlayer",
    user_name: str = "Streamer",
    game_key: str = "OppPlayer|Streamer|1717000000000",
    display_time: float = 30.0,
    user_race: str = "Zerg",
    opp_race: str = "Protoss",
) -> LiveLifecycleEvent:
    return LiveLifecycleEvent(
        phase=LiveLifecyclePhase.MATCH_IN_PROGRESS,
        ui_state=LiveUIState(active_screens=[]),
        game_state=LiveGameState(
            display_time=display_time,
            players=[
                LivePlayer(name=user_name, type="user", race=user_race,
                           result="Undecided"),
                LivePlayer(name=opp_name, type="user", race=opp_race,
                           result="Undecided"),
            ],
        ),
        game_key=game_key,
    )


def _build_ended_event(
    *,
    opp_name: str = "OppPlayer",
    user_name: str = "Streamer",
    game_key: str = "OppPlayer|Streamer|1717000000000",
) -> LiveLifecycleEvent:
    return LiveLifecycleEvent(
        phase=LiveLifecyclePhase.MATCH_ENDED,
        ui_state=LiveUIState(active_screens=["ScreenScore"]),
        game_state=LiveGameState(
            display_time=600.0,
            players=[
                LivePlayer(name=user_name, type="user", race="Zerg",
                           result="Victory"),
                LivePlayer(name=opp_name, type="user", race="Protoss",
                           result="Defeat"),
            ],
        ),
        game_key=game_key,
    )


def _wait_for(predicate, timeout: float = 1.0, step: float = 0.01) -> bool:
    """Spin-wait helper for the async Pulse path."""
    end = time.time() + timeout
    while time.time() < end:
        if predicate():
            return True
        time.sleep(step)
    return False


def test_match_loading_emits_partial_payload_immediately() -> None:
    """The first MATCH_LOADING event must produce an envelope on the
    output bus before Pulse finishes — that's the whole point of the
    "render skeleton at T+0" requirement."""
    lifecycle: EventBus[LiveLifecycleEvent] = EventBus()
    profile = OpponentProfile(name="OppPlayer", mmr=4000)
    pulse = _StubPulseClient(profile=profile)
    bridge = LiveBridge(
        lifecycle_bus=lifecycle, pulse=pulse, user_name_hint="Streamer",
    )
    seen: List[Dict[str, Any]] = []
    bridge.bus.subscribe(seen.append)
    bridge.start()
    try:
        lifecycle.publish(_build_loading_event())
        # First emit happens synchronously on the publisher's thread.
        assert len(seen) >= 1
        first = seen[0]
        assert first["phase"] == "match_loading"
        assert first["opponent"]["name"] == "OppPlayer"
        assert first["opponent"]["race"] == "Protoss"
        assert first["user"] == {"name": "Streamer", "race": "Zerg"}
        # The Pulse lookup was dispatched async — wait for the
        # second envelope to arrive.
        assert _wait_for(lambda: len(seen) >= 2)
        enriched = next((e for e in seen if "profile" in e.get("opponent", {})), None)
        assert enriched is not None
        assert enriched["opponent"]["profile"]["mmr"] == 4000
    finally:
        bridge.stop()


def test_random_races_survive_later_concrete_values_for_same_game() -> None:
    """Selected Random must survive the API revealing spawned races."""
    lifecycle: EventBus[LiveLifecycleEvent] = EventBus()
    bridge = LiveBridge(
        lifecycle_bus=lifecycle,
        pulse=_StubPulseClient(profile=None),
        user_name_hint="Streamer",
    )
    seen: List[Dict[str, Any]] = []
    bridge.bus.subscribe(seen.append)
    bridge.start()
    try:
        lifecycle.publish(_build_loading_event(
            game_key="game-random",
            user_race="Rand",
            opp_race="rAnD",
        ))
        assert seen[-1]["user"]["race"] == "Random"
        assert seen[-1]["opponent"]["race"] == "Random"

        lifecycle.publish(_build_in_progress_event(
            game_key="game-random",
            user_race="Terran",
            opp_race="Zerg",
        ))
        assert seen[-1]["user"]["race"] == "Random"
        assert seen[-1]["opponent"]["race"] == "Random"
    finally:
        bridge.stop()


def test_truncated_concrete_races_are_canonicalized() -> None:
    lifecycle: EventBus[LiveLifecycleEvent] = EventBus()
    bridge = LiveBridge(
        lifecycle_bus=lifecycle,
        pulse=_StubPulseClient(profile=None),
        user_name_hint="Streamer",
    )
    seen: List[Dict[str, Any]] = []
    bridge.bus.subscribe(seen.append)
    bridge.start()
    try:
        lifecycle.publish(_build_loading_event(
            game_key="game-truncated",
            user_race="Prot",
            opp_race="tErR",
        ))
        assert seen[-1]["user"]["race"] == "Protoss"
        assert seen[-1]["opponent"]["race"] == "Terran"
    finally:
        bridge.stop()


def test_late_random_observation_latches_for_remainder_of_same_game() -> None:
    """A concrete-to-Random correction upgrades both race latches."""
    lifecycle: EventBus[LiveLifecycleEvent] = EventBus()
    bridge = LiveBridge(
        lifecycle_bus=lifecycle,
        pulse=_StubPulseClient(profile=None),
        user_name_hint="Streamer",
    )
    seen: List[Dict[str, Any]] = []
    bridge.bus.subscribe(seen.append)
    bridge.start()
    try:
        lifecycle.publish(_build_loading_event(
            game_key="game-corrected-random",
            user_race="Protoss",
            opp_race="Terran",
        ))
        lifecycle.publish(_build_in_progress_event(
            game_key="game-corrected-random",
            user_race="Random",
            opp_race="random",
        ))
        lifecycle.publish(_build_in_progress_event(
            game_key="game-corrected-random",
            display_time=60.0,
            user_race="?",
            opp_race="",
        ))
        assert seen[-1]["user"]["race"] == "Random"
        assert seen[-1]["opponent"]["race"] == "Random"
    finally:
        bridge.stop()


def test_new_game_key_resets_random_race_latches() -> None:
    lifecycle: EventBus[LiveLifecycleEvent] = EventBus()
    bridge = LiveBridge(
        lifecycle_bus=lifecycle,
        pulse=_StubPulseClient(profile=None),
        user_name_hint="Streamer",
    )
    seen: List[Dict[str, Any]] = []
    bridge.bus.subscribe(seen.append)
    bridge.start()
    try:
        lifecycle.publish(_build_loading_event(
            game_key="game-one",
            user_race="Random",
            opp_race="Random",
        ))
        lifecycle.publish(_build_loading_event(
            game_key="game-two",
            user_race="Terran",
            opp_race="Zerg",
        ))
        assert seen[-1]["gameKey"] == "game-two"
        assert seen[-1]["user"]["race"] == "Terran"
        assert seen[-1]["opponent"]["race"] == "Zerg"
    finally:
        bridge.stop()


def test_unknown_races_do_not_create_random_latches() -> None:
    lifecycle: EventBus[LiveLifecycleEvent] = EventBus()
    bridge = LiveBridge(
        lifecycle_bus=lifecycle,
        pulse=_StubPulseClient(profile=None),
        user_name_hint="Streamer",
    )
    seen: List[Dict[str, Any]] = []
    bridge.bus.subscribe(seen.append)
    bridge.start()
    try:
        lifecycle.publish(_build_loading_event(
            game_key="game-unknown",
            user_race="?",
            opp_race="",
        ))
        assert seen[-1]["user"]["race"] is None
        assert seen[-1]["opponent"]["race"] is None

        lifecycle.publish(_build_in_progress_event(
            game_key="game-unknown",
            user_race="Protoss",
            opp_race="Terran",
        ))
        assert seen[-1]["user"]["race"] == "Protoss"
        assert seen[-1]["opponent"]["race"] == "Terran"
    finally:
        bridge.stop()


def test_pulse_lookup_is_called_with_opponent_hints() -> None:
    """The bridge passes opponent name AND race to PulseClient so
    Pulse can disambiguate against the in-game race."""
    lifecycle: EventBus[LiveLifecycleEvent] = EventBus()
    pulse = _StubPulseClient(
        profile=OpponentProfile(name="OppPlayer", mmr=3500),
    )
    bridge = LiveBridge(
        lifecycle_bus=lifecycle, pulse=pulse, user_name_hint="Streamer",
    )
    bridge.start()
    try:
        lifecycle.publish(_build_loading_event())
        assert _wait_for(lambda: len(pulse.calls) >= 1)
        call = pulse.calls[0]
        assert call["name"] == "OppPlayer"
        assert call["race"] == "Protoss"
    finally:
        bridge.stop()


def test_pulse_lookup_passes_streamer_region_as_hint() -> None:
    """In 1v1 the opponent shares the streamer's server. The bridge
    forwards the streamer's region (derived from their toon handle) to
    PulseClient so same-name accounts across regions disambiguate."""
    lifecycle: EventBus[LiveLifecycleEvent] = EventBus()
    pulse = _StubPulseClient(
        profile=OpponentProfile(name="OppPlayer", mmr=3500),
    )
    bridge = LiveBridge(
        lifecycle_bus=lifecycle,
        pulse=pulse,
        user_name_hint="Streamer",
        user_toon_handle="1-S2-1-9999",  # region byte 1 → NA
    )
    bridge.start()
    try:
        lifecycle.publish(_build_loading_event())
        assert _wait_for(lambda: len(pulse.calls) >= 1)
        assert pulse.calls[0]["region"] == "NA"
    finally:
        bridge.stop()


def test_pulse_lookup_region_hint_absent_without_handle() -> None:
    """No streamer toon handle yet → region hint is None, not a wrong
    guess. (Regression guard for the default arg.)"""
    lifecycle: EventBus[LiveLifecycleEvent] = EventBus()
    pulse = _StubPulseClient(
        profile=OpponentProfile(name="OppPlayer", mmr=3500),
    )
    bridge = LiveBridge(
        lifecycle_bus=lifecycle, pulse=pulse, user_name_hint="Streamer",
    )
    bridge.start()
    try:
        lifecycle.publish(_build_loading_event())
        assert _wait_for(lambda: len(pulse.calls) >= 1)
        assert pulse.calls[0]["region"] is None
    finally:
        bridge.stop()


def test_pulse_lookup_region_hint_absent_on_ptr() -> None:
    """SC2Pulse has no PTR ladder, so a PTR streamer sends no region
    hint and Pulse searches every region, exactly as with no handle."""
    lifecycle: EventBus[LiveLifecycleEvent] = EventBus()
    pulse = _StubPulseClient(
        profile=OpponentProfile(name="OppPlayer", mmr=3500),
    )
    bridge = LiveBridge(
        lifecycle_bus=lifecycle,
        pulse=pulse,
        user_name_hint="Streamer",
        user_toon_handle="98-S2-1-30230",  # region byte 98 → PTR
    )
    bridge.start()
    try:
        lifecycle.publish(_build_loading_event())
        assert _wait_for(lambda: len(pulse.calls) >= 1)
        assert pulse.calls[0]["region"] is None
    finally:
        bridge.stop()


def test_in_progress_does_not_refetch_pulse() -> None:
    """A periodic MATCH_IN_PROGRESS tick re-emits opponent state from
    the cached context — it must NOT spam Pulse with one lookup per
    second."""
    lifecycle: EventBus[LiveLifecycleEvent] = EventBus()
    pulse = _StubPulseClient(
        profile=OpponentProfile(name="OppPlayer", mmr=4000),
    )
    bridge = LiveBridge(
        lifecycle_bus=lifecycle, pulse=pulse, user_name_hint="Streamer",
    )
    bridge.start()
    try:
        lifecycle.publish(_build_loading_event())
        assert _wait_for(lambda: len(pulse.calls) >= 1)
        # Now fire 5 in-progress ticks — pulse should NOT be called
        # again for any of them.
        for t in (10.0, 20.0, 30.0, 40.0, 50.0):
            lifecycle.publish(_build_in_progress_event(display_time=t))
        # Brief sleep to let any (incorrectly-spawned) async work run.
        time.sleep(0.05)
        assert len(pulse.calls) == 1
    finally:
        bridge.stop()


def test_match_ended_emits_terminal_envelope() -> None:
    """End-of-match envelope must include the player results so the
    post-game widget can paint Victory/Defeat without waiting on the
    replay parse."""
    lifecycle: EventBus[LiveLifecycleEvent] = EventBus()
    pulse = _StubPulseClient(
        profile=OpponentProfile(name="OppPlayer", mmr=3500),
    )
    bridge = LiveBridge(
        lifecycle_bus=lifecycle, pulse=pulse, user_name_hint="Streamer",
    )
    seen: List[Dict[str, Any]] = []
    bridge.bus.subscribe(seen.append)
    bridge.start()
    try:
        lifecycle.publish(_build_loading_event())
        # Drain the loading + Pulse-enriched emits.
        assert _wait_for(lambda: len(seen) >= 2)
        seen.clear()
        lifecycle.publish(_build_ended_event())
        assert seen, "MATCH_ENDED produced no envelope"
        ended = seen[-1]
        assert ended["phase"] == "match_ended"
        # Player results survive into the envelope.
        results = [p["result"] for p in ended["players"]]
        assert "Victory" in results
        assert "Defeat" in results
    finally:
        bridge.stop()


def test_late_pulse_response_for_old_game_is_dropped() -> None:
    """If Pulse takes 2 seconds and the user starts a SECOND game in
    the meantime, the late response must NOT pollute the new game's
    payload."""
    lifecycle: EventBus[LiveLifecycleEvent] = EventBus()
    release = threading.Event()
    pulse = _StubPulseClient(
        profile=OpponentProfile(name="OppPlayer", mmr=4000),
        delay_event=release,
    )
    bridge = LiveBridge(
        lifecycle_bus=lifecycle, pulse=pulse, user_name_hint="Streamer",
    )
    seen: List[Dict[str, Any]] = []
    bridge.bus.subscribe(seen.append)
    bridge.start()
    try:
        # Game 1 starts loading → kicks off blocked Pulse lookup.
        lifecycle.publish(_build_loading_event(
            opp_name="FirstOpp",
            game_key="game-1",
        ))
        # Game 2 starts before Pulse returns.
        lifecycle.publish(LiveLifecycleEvent(
            phase=LiveLifecyclePhase.MENU,
        ))
        lifecycle.publish(_build_loading_event(
            opp_name="SecondOpp",
            game_key="game-2",
        ))
        # Now release the stale Pulse lookup. It will try to merge
        # against the bridge's _current ctx, see game_key mismatch,
        # and drop without emitting.
        release.set()
        # Give the worker a moment to run the callback.
        time.sleep(0.2)
        # The bridge has emitted at least 3 envelopes:
        #   game-1 loading, MENU, game-2 loading.
        # But there must NOT be any envelope where game-1's ctx got
        # the FirstOpp profile applied AFTER game-2 started.
        # Concretely: every envelope with profile.mmr=4000 must be
        # tagged with gameKey='game-1' AND not be after the game-2
        # event in publication order.
        publications_after_game2 = []
        seen_game2 = False
        for env in seen:
            if env.get("gameKey") == "game-2":
                seen_game2 = True
                continue
            if seen_game2 and "profile" in env.get("opponent", {}):
                publications_after_game2.append(env)
        # The whole point of the test: zero late-merge pollution.
        assert publications_after_game2 == []
    finally:
        bridge.stop()


@pytest.mark.parametrize("clear_phase", [
    LiveLifecyclePhase.MENU,
    LiveLifecyclePhase.IDLE,
])
@pytest.mark.parametrize("prior_phase", [
    LiveLifecyclePhase.MATCH_IN_PROGRESS,
    LiveLifecyclePhase.MATCH_ENDED,
])
def test_pulse_publication_started_before_clear_cannot_overwrite_clear(
    monkeypatch,
    clear_phase: LiveLifecyclePhase,
    prior_phase: LiveLifecyclePhase,
) -> None:
    """A validated Pulse response must stay before the later clear even
    if its delivery pauses while the poller observes MENU or IDLE."""
    lifecycle: EventBus[LiveLifecycleEvent] = EventBus()
    bridge = LiveBridge(
        lifecycle_bus=lifecycle, pulse=_StubPulseClient(profile=None),
    )
    seen: List[Dict[str, Any]] = []
    bridge.bus.subscribe(seen.append)
    bridge.start()
    publication_started = threading.Event()
    release_publication = threading.Event()
    transition_finished = threading.Event()
    errors: list[BaseException] = []
    original_publish = bridge.bus.publish

    def pause_enriched_publication(payload: Dict[str, Any]) -> None:
        if payload.get("opponent", {}).get("profile"):
            publication_started.set()
            if not release_publication.wait(timeout=2.0):
                raise AssertionError("Pulse publication was never released")
        original_publish(payload)

    monkeypatch.setattr(bridge.bus, "publish", pause_enriched_publication)
    lifecycle.publish(_build_loading_event(game_key="game-clearing"))
    if prior_phase == LiveLifecyclePhase.MATCH_ENDED:
        lifecycle.publish(_build_ended_event(game_key="game-clearing"))
    else:
        lifecycle.publish(_build_in_progress_event(game_key="game-clearing"))
    future: Future = Future()
    future.set_result(OpponentProfile(name="OppPlayer", mmr=4000))

    def publish_pulse() -> None:
        try:
            bridge._on_pulse_done(game_key="game-clearing", future=future)
        except BaseException as exc:
            errors.append(exc)

    def clear_match() -> None:
        try:
            lifecycle.publish(LiveLifecycleEvent(phase=clear_phase))
        except BaseException as exc:
            errors.append(exc)
        finally:
            transition_finished.set()

    callback = threading.Thread(target=publish_pulse, daemon=True)
    transition = threading.Thread(target=clear_match, daemon=True)
    try:
        callback.start()
        assert publication_started.wait(timeout=1.0)
        transition.start()
        # The poller must not wait for the callback's subscriber delivery.
        assert transition_finished.wait(timeout=1.0)
        assert bridge.current_game_key() is None
        release_publication.set()
        callback.join(timeout=1.0)
        transition.join(timeout=1.0)
        assert not callback.is_alive()
        assert not transition.is_alive()
        assert errors == []
        assert seen[-1]["phase"] == clear_phase.value
        clear_index = next(
            i for i, payload in enumerate(seen)
            if payload["phase"] == clear_phase.value
        )
        assert all(
            payload.get("gameKey") != "game-clearing"
            for payload in seen[clear_index + 1:]
        )
    finally:
        release_publication.set()
        if callback.ident is not None:
            callback.join(timeout=1.0)
        if transition.ident is not None:
            transition.join(timeout=1.0)
        bridge.stop()


def test_reentrant_lifecycle_subscriber_preserves_publication_order() -> None:
    """A subscriber may trigger a clear without another subscriber
    receiving that clear before the active envelope being delivered."""
    lifecycle: EventBus[LiveLifecycleEvent] = EventBus()
    bridge = LiveBridge(
        lifecycle_bus=lifecycle, pulse=_StubPulseClient(profile=None),
    )

    def clear_on_loading(payload: Dict[str, Any]) -> None:
        if payload["phase"] == "match_loading":
            lifecycle.publish(LiveLifecycleEvent(phase=LiveLifecyclePhase.MENU))

    seen: List[Dict[str, Any]] = []
    bridge.bus.subscribe(clear_on_loading)
    bridge.bus.subscribe(seen.append)
    bridge.start()
    try:
        lifecycle.publish(_build_loading_event())
        assert [payload["phase"] for payload in seen] == ["match_loading", "menu"]
        assert bridge.current_game_key() is None
    finally:
        bridge.stop()


def test_completed_pulse_callback_delivers_without_context_lock(monkeypatch) -> None:
    """An inline Future callback cannot hold the game-state lock while
    subscribers wait for another thread to read bridge diagnostics."""
    lifecycle: EventBus[LiveLifecycleEvent] = EventBus()
    bridge = LiveBridge(lifecycle_bus=lifecycle, pulse=_StubPulseClient())
    future: Future = Future()
    future.set_result(OpponentProfile(name="OppPlayer", mmr=4000))
    monkeypatch.setattr(bridge._executor, "submit", lambda *args, **kwargs: future)
    accessible: list[bool] = []
    readers: list[threading.Thread] = []

    def read_context_from_another_thread(payload: Dict[str, Any]) -> None:
        read_finished = threading.Event()

        def read_context() -> None:
            bridge.current_game_key()
            read_finished.set()

        reader = threading.Thread(target=read_context, daemon=True)
        readers.append(reader)
        reader.start()
        accessible.append(read_finished.wait(timeout=0.5))

    bridge.bus.subscribe(read_context_from_another_thread)
    bridge.start()
    try:
        lifecycle.publish(_build_loading_event())
        assert accessible == [True, True]
    finally:
        for reader in readers:
            reader.join(timeout=1.0)
        bridge.stop()


def test_idle_event_emits_clear_envelope() -> None:
    """IDLE clears the per-game context AND publishes an envelope so
    transports can broadcast 'no live game'."""
    lifecycle: EventBus[LiveLifecycleEvent] = EventBus()
    pulse = _StubPulseClient(profile=None)
    bridge = LiveBridge(lifecycle_bus=lifecycle, pulse=pulse)
    seen: List[Dict[str, Any]] = []
    bridge.bus.subscribe(seen.append)
    bridge.start()
    try:
        lifecycle.publish(_build_loading_event())
        seen.clear()
        lifecycle.publish(LiveLifecycleEvent(phase=LiveLifecyclePhase.IDLE))
        assert seen, "IDLE produced no envelope"
        assert seen[-1]["phase"] == "idle"
        assert "opponent" not in seen[-1]
        assert bridge.current_game_key() is None
    finally:
        bridge.stop()


def test_set_user_name_hint_updates_active_context() -> None:
    """A late ``set_user_name_hint`` (called by runner.py after the
    player_handle resolves) updates the in-flight context so the
    next emit carries the right user name."""
    lifecycle: EventBus[LiveLifecycleEvent] = EventBus()
    pulse = _StubPulseClient(profile=OpponentProfile(name="Opp", mmr=3000))
    bridge = LiveBridge(lifecycle_bus=lifecycle, pulse=pulse)
    seen: List[Dict[str, Any]] = []
    bridge.bus.subscribe(seen.append)
    bridge.start()
    try:
        lifecycle.publish(_build_loading_event())
        assert _wait_for(lambda: len(seen) >= 1)
        bridge.set_user_name_hint("LateHandle")
        seen.clear()
        lifecycle.publish(_build_in_progress_event(display_time=15.0))
        assert seen
        assert seen[-1].get("user", {}).get("name") == "LateHandle"
    finally:
        bridge.stop()
