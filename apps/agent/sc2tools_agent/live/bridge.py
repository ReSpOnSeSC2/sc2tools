"""``LiveBridge`` — fuses ``LiveClientPoller`` (Source A) with
``PulseClient`` (Source B) into a stream of ``LiveGameState`` deltas
the transports broadcast.

Bridge contract:

* Subscribes to the lifecycle bus from ``LiveClientPoller``.
* On ``MATCH_LOADING`` / ``MATCH_STARTED``: emit IMMEDIATELY with the
  partial payload (name + race from /game), then kick a Pulse lookup
  in a worker thread. The Pulse lookup completes in ~150–500 ms cold
  / <10 ms warm; when it returns, we emit a second delta carrying
  the enriched profile. Each emit is a delta with the same
  ``game_key`` so the receiver can merge.
* On ``MATCH_IN_PROGRESS``: re-emit (lightweight — no Pulse refetch)
  so widgets that show in-game time tick.
* On ``MATCH_ENDED``: emit terminal state. Cloud reconciles with the
  replay-derived game on the same ``game_key``.

The bridge is the thing transports ultimately listen to. Phase 3
adds the transport layer (Socket.io to the local overlay backend +
HTTPS POST to the cloud) as additional subscribers on the bridge's
output bus — it does NOT touch the lifecycle bus directly.
"""

from __future__ import annotations

import dataclasses
import logging
import threading
import time
from concurrent.futures import Future, ThreadPoolExecutor
from typing import Any, Callable, Dict, List, Optional

from .event_bus import EventBus
from .metrics import METRICS
from .pulse_lookup import PulseClient
from .types import (
    LiveLifecycleEvent,
    LiveLifecyclePhase,
    OpponentProfile,
    envelope_for,
    to_jsonable,
)

_log = logging.getLogger("sc2tools_agent.live.bridge")


@dataclasses.dataclass
class _GameContext:
    """Mutable per-match state the bridge accumulates and re-emits.

    Kept off the public surface — callers consume the typed envelopes
    the bridge publishes, not this dict-of-loose-fields. We use a
    mutable dataclass so the Pulse-completion callback can patch in
    the profile without rebuilding the whole structure.
    """

    game_key: str
    started_at_ms: int
    opponent_name: Optional[str] = None
    opponent_race: Optional[str] = None
    user_name: Optional[str] = None
    user_race: Optional[str] = None
    profile: Optional[OpponentProfile] = None
    last_lifecycle_phase: LiveLifecyclePhase = LiveLifecyclePhase.MATCH_LOADING
    last_emitted_at: float = 0.0


# Type alias for the bridge's output bus.
BridgeListener = Callable[[Dict[str, Any]], None]


class LiveBridge:
    """Fuses lifecycle events + Pulse profiles into outbound payloads.

    Wiring:

    * Hand the bridge a reference to the lifecycle bus from
      ``LiveClientPoller``.
    * Hand it a ``PulseClient`` (constructed once, shared across runs).
    * Subscribe transports to ``bridge.bus`` — they receive ready-to-
      emit JSON-friendly dicts on the same channel the overlay
      Socket.io and the cloud HTTP POST consume.

    Threading: lifecycle events arrive on the poller's thread. The
    bridge does its lightweight fusion inline (it's all dict mutation
    + cache lookups) and dispatches the heavy Pulse lookup to a
    bounded thread pool so the poll loop never blocks on Pulse
    latency.
    """

    def __init__(
        self,
        *,
        lifecycle_bus: EventBus[LiveLifecycleEvent],
        pulse: PulseClient,
        user_name_hint: Optional[str] = None,
        max_worker_threads: int = 2,
    ) -> None:
        self._lifecycle_bus = lifecycle_bus
        self._pulse = pulse
        self._user_name_hint = user_name_hint
        self._executor = ThreadPoolExecutor(
            max_workers=max_worker_threads,
            thread_name_prefix="sc2tools-bridge",
        )
        self._lock = threading.RLock()
        self._current: Optional[_GameContext] = None
        # Output bus: transports subscribe here.
        self.bus: EventBus[Dict[str, Any]] = EventBus()
        self._unsubscribe_lifecycle: Optional[Callable[[], None]] = None

    # ------------------------------------------------------------------
    # Lifecycle wiring
    # ------------------------------------------------------------------

    def start(self) -> None:
        if self._unsubscribe_lifecycle is not None:
            return
        self._unsubscribe_lifecycle = self._lifecycle_bus.subscribe(
            self._on_lifecycle_event,
        )

    def stop(self) -> None:
        if self._unsubscribe_lifecycle is not None:
            self._unsubscribe_lifecycle()
            self._unsubscribe_lifecycle = None
        self._executor.shutdown(wait=False, cancel_futures=True)

    def set_user_name_hint(self, name: Optional[str]) -> None:
        with self._lock:
            self._user_name_hint = name
            if self._current is not None:
                self._current.user_name = name

    # ------------------------------------------------------------------
    # Lifecycle handler — runs on the poller's thread
    # ------------------------------------------------------------------

    def _on_lifecycle_event(self, event: LiveLifecycleEvent) -> None:
        try:
            self._handle(event)
        except Exception:  # noqa: BLE001
            _log.exception(
                "live_bridge_handler_failed phase=%s",
                event.phase.value,
            )

    def _handle(self, event: LiveLifecycleEvent) -> None:
        phase = event.phase

        # IDLE / MENU clear the per-match state and emit a "no game"
        # envelope so widgets can hide.
        if phase in (LiveLifecyclePhase.IDLE, LiveLifecyclePhase.MENU):
            with self._lock:
                self._current = None
            self._publish(envelope_for(event))
            return

        # MATCH_LOADING / MATCH_STARTED / MATCH_IN_PROGRESS share the
        # same fusion path: snapshot the current opponent and re-emit
        # with whatever profile we have so far. Phase distinguishes
        # what widgets should *do* (skeleton vs. full vs. tick).
        if phase in (
            LiveLifecyclePhase.MATCH_LOADING,
            LiveLifecyclePhase.MATCH_STARTED,
            LiveLifecyclePhase.MATCH_IN_PROGRESS,
        ):
            self._on_match_active(event)
            return

        if phase == LiveLifecyclePhase.MATCH_ENDED:
            self._on_match_ended(event)
            return

    def _on_match_active(self, event: LiveLifecycleEvent) -> None:
        if event.game_state is None or not event.game_key:
            return
        opp = event.game_state.opponent_for(self._user_name_hint)
        with self._lock:
            ctx = self._current
            if ctx is None or ctx.game_key != event.game_key:
                # New match (or first event of a recovered run). Build
                # a fresh context and kick the Pulse lookup async so
                # the FIRST emit lands within ~50 ms (poll latency)
                # instead of waiting for Pulse.
                ctx = _GameContext(
                    game_key=event.game_key,
                    started_at_ms=int(event.captured_at * 1000),
                    opponent_name=opp.name if opp else None,
                    opponent_race=opp.race if opp else None,
                    user_name=self._user_name_hint,
                    last_lifecycle_phase=event.phase,
                )
                self._current = ctx
                if opp and opp.name:
                    self._dispatch_pulse_lookup(
                        game_key=event.game_key,
                        name=opp.name,
                        race=opp.race,
                    )
            else:
                # Same match — just refresh per-event fields.
                ctx.last_lifecycle_phase = event.phase
                if opp:
                    ctx.opponent_name = opp.name or ctx.opponent_name
                    ctx.opponent_race = opp.race or ctx.opponent_race
            ctx.last_emitted_at = time.time()
            payload = self._envelope_with_profile(event, ctx)
        self._publish(payload)

    def _on_match_ended(self, event: LiveLifecycleEvent) -> None:
        with self._lock:
            ctx = self._current
            if ctx is not None and event.game_state is not None:
                # Stamp the result for transports so the post-game
                # widget knows whether to render Victory / Defeat
                # without waiting for the replay parse.
                ctx.last_lifecycle_phase = event.phase
            payload = self._envelope_with_profile(event, ctx)
        # Don't clear `_current` here — we may still need to fold in a
        # late Pulse response (e.g. if the lookup's still in flight at
        # game-end, the result envelope it produces is useful).
        # The next IDLE/MENU event will clear state.
        self._publish(payload)

    # ------------------------------------------------------------------
    # Pulse async lookup
    # ------------------------------------------------------------------

    def _dispatch_pulse_lookup(
        self,
        *,
        game_key: str,
        name: str,
        race: Optional[str],
    ) -> Future:
        future = self._executor.submit(
            self._pulse.resolve, name=name, race=race,
        )
        future.add_done_callback(
            lambda f: self._on_pulse_done(game_key=game_key, future=f),
        )
        return future

    def _on_pulse_done(
        self,
        *,
        game_key: str,
        future: Future,
    ) -> None:
        try:
            profile = future.result()
        except Exception:  # noqa: BLE001
            _log.exception(
                "live_bridge_pulse_callback_failed game_key=%s", game_key,
            )
            return
        if profile is None:
            return
        with self._lock:
            ctx = self._current
            if ctx is None or ctx.game_key != game_key:
                # The match ended (and a new one started) while Pulse
                # was in flight. Drop the late result rather than
                # poisoning a different game's payload.
                return
            ctx.profile = profile
            payload = self._envelope_with_profile(
                _synthetic_event_for_phase(ctx),
                ctx,
            )
        self._publish(payload)

    # ------------------------------------------------------------------
    # Envelope assembly + publish
    # ------------------------------------------------------------------

    def _envelope_with_profile(
        self,
        event: LiveLifecycleEvent,
        ctx: Optional[_GameContext],
    ) -> Dict[str, Any]:
        env = envelope_for(event)
        if ctx is None:
            return env
        env["opponent"] = {
            "name": ctx.opponent_name,
            "race": ctx.opponent_race,
        }
        if ctx.profile is not None:
            env["opponent"]["profile"] = to_jsonable(ctx.profile)
        if ctx.user_name:
            env["user"] = {"name": ctx.user_name}
        return env

    def _publish(self, payload: Dict[str, Any]) -> None:
        phase = payload.get("phase") or "unknown"
        METRICS.incr(f"bridge.publish.{phase}")
        self.bus.publish(payload)

    # ------------------------------------------------------------------
    # Diagnostics
    # ------------------------------------------------------------------

    def current_game_key(self) -> Optional[str]:
        with self._lock:
            return self._current.game_key if self._current else None


def _synthetic_event_for_phase(ctx: _GameContext) -> LiveLifecycleEvent:
    """Reconstruct a thin lifecycle event for the late-Pulse re-emit.

    We don't have the real ``LiveGameState`` from the original event
    here (the poller has moved on), so we build a minimal envelope
    carrying the phase + game_key so widgets see "same match,
    enriched payload."
    """
    return LiveLifecycleEvent(
        phase=ctx.last_lifecycle_phase,
        game_key=ctx.game_key,
    )


__all__ = ["LiveBridge", "BridgeListener"]
