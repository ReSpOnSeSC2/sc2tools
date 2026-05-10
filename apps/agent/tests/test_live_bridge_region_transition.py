"""Coverage for the live bridge's server / region transition handling.

Real-stream repro: a streamer switches SC2 servers (NA → EU) mid-
session. The local SC2 client's ``/game`` endpoint never exposes the
streamer's toon handle, so the bridge has to be told externally —
``runner.py`` calls ``set_user_toon_handle`` with the most recent
parsed ``myToonHandle`` from the upload pipeline.

The bridge must:

  1. Track the leading region byte across handle updates.
  2. On a real region transition (not the first observation), flag
     ``_pending_server_transition`` and clear ``_current`` so any
     in-flight Pulse callback for the prior server's match can't
     merge into a fresh context.
  3. On the next active-phase event, prepend a synthetic ``MENU`` +
     ``MATCH_LOADING`` pair so overlay clients clear stale state
     instead of jumping straight from a frozen previous game to a
     fresh ``MATCH_IN_PROGRESS``.

Without this, the Opponent / Scouting widgets keep the prior server's
opponent on the OBS scene until the streamer manually refreshes the
Browser Source.
"""

from __future__ import annotations

import threading
from typing import Any, Dict, List, Optional

from sc2tools_agent.live.bridge import LiveBridge
from sc2tools_agent.live.event_bus import EventBus
from sc2tools_agent.live.region import region_from_toon_handle
from sc2tools_agent.live.types import (
    LiveGameState,
    LiveLifecycleEvent,
    LiveLifecyclePhase,
    LivePlayer,
    LiveUIState,
    OpponentProfile,
)


class _StubPulseClient:
    def __init__(self, profile: Optional[OpponentProfile] = None) -> None:
        self.profile = profile

    def resolve(
        self,
        *,
        name: str,
        region: Optional[str] = None,
        race: Optional[str] = None,
    ) -> Optional[OpponentProfile]:
        return self.profile


def _loading_event(opp: str, game_key: str) -> LiveLifecycleEvent:
    return LiveLifecycleEvent(
        phase=LiveLifecyclePhase.MATCH_LOADING,
        ui_state=LiveUIState(active_screens=["ScreenLoading"]),
        game_state=LiveGameState(
            display_time=0.0,
            players=[
                LivePlayer(name="Streamer", type="user", race="Zerg",
                           result="Undecided"),
                LivePlayer(name=opp, type="user", race="Protoss",
                           result="Undecided"),
            ],
        ),
        game_key=game_key,
    )


def _in_progress_event(opp: str, game_key: str) -> LiveLifecycleEvent:
    return LiveLifecycleEvent(
        phase=LiveLifecyclePhase.MATCH_IN_PROGRESS,
        ui_state=LiveUIState(active_screens=[]),
        game_state=LiveGameState(
            display_time=10.0,
            players=[
                LivePlayer(name="Streamer", type="user", race="Zerg",
                           result="Undecided"),
                LivePlayer(name=opp, type="user", race="Protoss",
                           result="Undecided"),
            ],
        ),
        game_key=game_key,
    )


def test_region_helper_maps_leading_byte_to_label() -> None:
    """Sanity-check the helper since the bridge depends on it."""
    assert region_from_toon_handle("1-S2-1-12345") == "NA"
    assert region_from_toon_handle("2-S2-1-12345") == "EU"
    assert region_from_toon_handle("3-S2-1-12345") == "KR"
    assert region_from_toon_handle("5-S2-1-12345") == "CN"
    assert region_from_toon_handle("6-S2-1-12345") == "SEA"
    assert region_from_toon_handle("9-S2-1-12345") is None
    assert region_from_toon_handle(None) is None
    assert region_from_toon_handle("") is None


def test_first_set_user_toon_handle_does_not_flag_transition() -> None:
    """The first observed handle is the baseline — there's nothing to
    transition from. The flag must remain False so the next match
    isn't surprised by a synthetic prelude."""
    lifecycle: EventBus[LiveLifecycleEvent] = EventBus()
    bridge = LiveBridge(
        lifecycle_bus=lifecycle, pulse=_StubPulseClient(),
    )
    bridge.set_user_toon_handle("1-S2-1-11111")
    assert bridge.current_user_region() == "NA"
    assert bridge._pending_server_transition is False


def test_same_region_handle_change_does_not_flag_transition() -> None:
    """Two NA toon handles for the same streamer (e.g. multi-account)
    must NOT flag a transition. Only the region byte matters."""
    lifecycle: EventBus[LiveLifecycleEvent] = EventBus()
    bridge = LiveBridge(
        lifecycle_bus=lifecycle, pulse=_StubPulseClient(),
    )
    bridge.set_user_toon_handle("1-S2-1-11111")
    bridge.set_user_toon_handle("1-S2-2-22222")
    assert bridge.current_user_region() == "NA"
    assert bridge._pending_server_transition is False


def test_region_change_clears_current_and_flags_transition() -> None:
    """NA → EU. The bridge must drop _current AND flag the pending
    transition for the next active-phase event."""
    lifecycle: EventBus[LiveLifecycleEvent] = EventBus()
    bridge = LiveBridge(
        lifecycle_bus=lifecycle, pulse=_StubPulseClient(),
    )
    bridge.start()
    try:
        bridge.set_user_toon_handle("1-S2-1-11111")
        # Seed a match so _current is non-None.
        lifecycle.publish(_loading_event("PriorOpp", "na-game"))
        assert bridge.current_game_key() == "na-game"
        # Server switch.
        bridge.set_user_toon_handle("2-S2-1-22222")
        assert bridge.current_user_region() == "EU"
        assert bridge._pending_server_transition is True
        # _current must be reset so the prior NA match can't bleed
        # into anything.
        assert bridge._current is None
    finally:
        bridge.stop()


def test_synthetic_menu_and_match_loading_prelude_emitted_after_region_change() -> None:
    """After a region switch, the next active-phase event must be
    preceded by a synthetic MENU + MATCH_LOADING pair so the overlay
    clients drop stale state and the gameKey-change effect fires."""
    lifecycle: EventBus[LiveLifecycleEvent] = EventBus()
    bridge = LiveBridge(
        lifecycle_bus=lifecycle, pulse=_StubPulseClient(),
    )
    seen: List[Dict[str, Any]] = []
    bridge.bus.subscribe(seen.append)
    bridge.start()
    try:
        bridge.set_user_toon_handle("1-S2-1-11111")
        lifecycle.publish(_loading_event("NA-Opp", "na-game"))
        # Drop the NA-game emit + any in-flight Pulse re-emit so the
        # transition-related events can be inspected in isolation.
        seen.clear()
        # Server transition.
        bridge.set_user_toon_handle("2-S2-1-22222")
        # New EU match — first event the bridge sees is
        # MATCH_IN_PROGRESS (e.g. a fast loading screen we missed).
        lifecycle.publish(_in_progress_event("EU-Opp", "eu-game"))
        # Expect: synthetic MENU, synthetic MATCH_LOADING,
        # then the original MATCH_IN_PROGRESS.
        phases = [env.get("phase") for env in seen]
        assert "menu" in phases
        assert "match_loading" in phases
        assert "match_in_progress" in phases
        # Order matters: MENU comes first, then MATCH_LOADING, then
        # the inbound MATCH_IN_PROGRESS.
        menu_idx = phases.index("menu")
        loading_idx = phases.index("match_loading")
        in_progress_idx = phases.index("match_in_progress")
        assert menu_idx < loading_idx < in_progress_idx
        # Both prelude envelopes carry synthetic=True.
        synthetic_phases = {
            env.get("phase") for env in seen if env.get("synthetic")
        }
        assert synthetic_phases == {"menu", "match_loading"}
        # The synthetic MATCH_LOADING carries the new game's key so
        # the overlay client's gameKey-change effect fires correctly.
        loading_env = next(
            e for e in seen if e.get("phase") == "match_loading"
        )
        assert loading_env.get("gameKey") == "eu-game"
        # After the prelude fires, the flag clears so a subsequent
        # tick of the same match doesn't re-emit it.
        assert bridge._pending_server_transition is False
    finally:
        bridge.stop()


def test_no_prelude_when_no_region_change() -> None:
    """The prelude path must be inert when the streamer stays on the
    same server. A normal MATCH_LOADING → MATCH_IN_PROGRESS sequence
    inside one match must not emit synthetic envelopes."""
    lifecycle: EventBus[LiveLifecycleEvent] = EventBus()
    bridge = LiveBridge(
        lifecycle_bus=lifecycle, pulse=_StubPulseClient(),
    )
    seen: List[Dict[str, Any]] = []
    bridge.bus.subscribe(seen.append)
    bridge.start()
    try:
        bridge.set_user_toon_handle("1-S2-1-11111")
        lifecycle.publish(_loading_event("Opp", "g1"))
        lifecycle.publish(_in_progress_event("Opp", "g1"))
        synthetic = [env for env in seen if env.get("synthetic")]
        assert synthetic == []
    finally:
        bridge.stop()


def test_inbound_match_loading_after_region_change_does_not_double_loading() -> None:
    """If the inbound event is ALREADY MATCH_LOADING, the prelude
    must skip the duplicate MATCH_LOADING — only the MENU prelude
    fires."""
    lifecycle: EventBus[LiveLifecycleEvent] = EventBus()
    bridge = LiveBridge(
        lifecycle_bus=lifecycle, pulse=_StubPulseClient(),
    )
    seen: List[Dict[str, Any]] = []
    bridge.bus.subscribe(seen.append)
    bridge.start()
    try:
        bridge.set_user_toon_handle("1-S2-1-11111")
        lifecycle.publish(_loading_event("NAOpp", "na-game"))
        seen.clear()
        bridge.set_user_toon_handle("2-S2-1-22222")
        lifecycle.publish(_loading_event("EUOpp", "eu-game"))
        phases = [env.get("phase") for env in seen]
        # Synthetic MENU + the inbound MATCH_LOADING (NOT a synthetic
        # second MATCH_LOADING).
        assert phases.count("match_loading") == 1
        # The MENU is synthetic.
        menu_envs = [e for e in seen if e.get("phase") == "menu"]
        assert menu_envs and menu_envs[0].get("synthetic") is True
    finally:
        bridge.stop()


def test_idle_or_menu_clears_pending_transition_flag() -> None:
    """A real MENU envelope (the streamer reached the main menu
    naturally) is the cleanest server-switch boundary. The bridge
    should drop the pending-transition flag so the next match isn't
    surprised by a redundant prelude on top of a real MENU."""
    lifecycle: EventBus[LiveLifecycleEvent] = EventBus()
    bridge = LiveBridge(
        lifecycle_bus=lifecycle, pulse=_StubPulseClient(),
    )
    bridge.start()
    try:
        bridge.set_user_toon_handle("1-S2-1-11111")
        bridge.set_user_toon_handle("2-S2-1-22222")
        assert bridge._pending_server_transition is True
        lifecycle.publish(LiveLifecycleEvent(phase=LiveLifecyclePhase.MENU))
        assert bridge._pending_server_transition is False
    finally:
        bridge.stop()


def test_clearing_handle_to_none_does_not_flag_transition() -> None:
    """A logout / replay-folder reset that clears the cached handle
    (handle=None) is NOT a server switch. The flag must stay False."""
    lifecycle: EventBus[LiveLifecycleEvent] = EventBus()
    bridge = LiveBridge(
        lifecycle_bus=lifecycle, pulse=_StubPulseClient(),
    )
    bridge.set_user_toon_handle("1-S2-1-11111")
    bridge.set_user_toon_handle(None)
    assert bridge._pending_server_transition is False
