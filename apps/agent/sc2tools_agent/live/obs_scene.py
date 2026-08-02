"""Automatic OBS scene switching driven by the Live Game Bridge.

Subscribes to ``LiveBridge.bus`` and, on a phase change that maps to a
different scene, calls ``SetCurrentProgramScene`` on OBS. That is the
entire contract: this module never creates, edits, renames, or deletes
anything in the user's OBS. Building scenes is ``live/obs_layout.py``,
and it only ever runs when the user clicks a button.

Design notes worth knowing before editing
-----------------------------------------

**Never block the publisher.** ``EventBus`` calls subscribers inline on
the publisher's thread (see the module docstring in ``event_bus.py``:
"the bus is for fan-out, not work"). ``listener`` therefore does
nothing but stash the envelope and set an ``Event``; a dedicated
daemon thread does the actual OBS request.

**Edge-triggered, on the mapped scene rather than the phase.**
``MATCH_STARTED`` and ``MATCH_IN_PROGRESS`` both map to the in-game
scene, and the bridge re-emits an enriched envelope whenever a Pulse
lookup lands. Comparing the *resolved scene* rather than the phase
collapses all of that into one switch per real transition — a
five-minute game issues one request, not three hundred.

**The leave-debounce is a deadline, not a counter.** The poller
de-duplicates ``IDLE`` and ``MENU`` (``client_api.py`` only emits them
when ``_last_phase`` differs), so "wait for N consecutive observations"
would wait forever — there is only ever one. Instead, a leaving phase
arms a deadline and any active phase arriving before it disarms it.

Why debounce leaving at all: a single dropped ``localhost:6119`` poll,
an alt-tab, or the in-game options menu must never yank the layout
mid-game on a live stream. Entering a match is *not* debounced —
the cut needs to land before the map fades in.
"""

from __future__ import annotations

import logging
import threading
import time
from typing import Any, Callable, Dict, Optional, Set

from .metrics import METRICS
from .obs_client import ObsUnavailable
from .types import LiveLifecyclePhase

_log = logging.getLogger("sc2tools_agent.live.obs_scene")

# Scene names the builder (``obs_layout.py``) creates. The switcher has
# no special knowledge of them beyond supplying a sane default map —
# a user who hand-builds their own scenes just points the map at those.
SCENE_IN_GAME = "SC2 Tools — In Game"
SCENE_BETWEEN_GAMES = "SC2 Tools — Between Games"

# Phases whose switch is delayed. Everything else applies immediately.
LEAVING_PHASES: Set[str] = {
    LiveLifecyclePhase.IDLE.value,
    LiveLifecyclePhase.MENU.value,
}

DEFAULT_DEBOUNCE_SEC = 3.0

#: Default phase → scene mapping.
#:
#: ``MATCH_ENDED`` deliberately stays on the in-game scene: the score
#: screen is worth showing. The cut to the downtime layout happens when
#: the phase drops to ``MENU``, which is where the streamer actually
#: leaves the match.
DEFAULT_SCENE_MAP: Dict[str, str] = {
    LiveLifecyclePhase.IDLE.value: SCENE_BETWEEN_GAMES,
    LiveLifecyclePhase.MENU.value: SCENE_BETWEEN_GAMES,
    LiveLifecyclePhase.MATCH_LOADING.value: SCENE_IN_GAME,
    LiveLifecyclePhase.MATCH_STARTED.value: SCENE_IN_GAME,
    LiveLifecyclePhase.MATCH_IN_PROGRESS.value: SCENE_IN_GAME,
    LiveLifecyclePhase.MATCH_ENDED.value: SCENE_IN_GAME,
}

# How long the worker parks when there is no armed deadline. Short
# enough that a shutdown is responsive, long enough to be free.
_IDLE_WAIT_SEC = 1.0


class ObsSceneController:
    """Switches OBS scenes in response to live game phase changes.

    ``client`` is an :class:`~.obs_client.ObsClient` (or any object with
    the same ``scene_names`` / ``set_current_program_scene`` surface —
    the tests pass a ``MagicMock``).
    """

    def __init__(
        self,
        *,
        client: Any = None,
        scene_map: Optional[Dict[str, str]] = None,
        enabled: bool = True,
        debounce_sec: float = DEFAULT_DEBOUNCE_SEC,
        switch_on_replays: bool = False,
        transition_name: Optional[str] = None,
        transition_duration_ms: Optional[int] = None,
        clock: Callable[[], float] = time.monotonic,
    ) -> None:
        self._client = client
        self._scene_map = dict(scene_map or DEFAULT_SCENE_MAP)
        self._enabled = enabled
        self._debounce = max(0.0, float(debounce_sec))
        self._switch_on_replays = switch_on_replays
        self._transition_name = transition_name
        self._transition_duration_ms = transition_duration_ms
        self._clock = clock

        self._lock = threading.RLock()
        self._wake = threading.Event()
        self._stop = threading.Event()
        self._thread: Optional[threading.Thread] = None

        # Latest envelope handed over by the bus, awaiting processing.
        self._inbox: Optional[Dict[str, Any]] = None

        # What we last asked OBS for. Used both for edge-triggering and
        # for telling our own switches apart from the streamer's.
        self._last_applied_scene: Optional[str] = None
        self._last_phase: Optional[str] = None

        # Armed leave-switch: target scene + monotonic deadline.
        self._pending_scene: Optional[str] = None
        self._pending_at: float = 0.0

        # Set when the streamer switches scenes by hand. Cleared on the
        # next phase change rather than on a timer — a timer either
        # fights the streamer or gives up too early.
        self._manual_hold = False

        # Scene names we've already complained about, so a missing
        # scene logs once rather than on every transition.
        self._warned_missing: Set[str] = set()

        # Diagnostics, mirroring the transport classes.
        self.switches_ok = 0
        self.switches_failed = 0
        self.suppressed = 0

    # ------------------------------------------------------------------
    # Bus interface
    # ------------------------------------------------------------------

    def attach_client(self, client: Any) -> None:
        """Supply the OBS client after construction.

        The controller and the client are mutually referential — the
        controller needs the client to issue requests, and the client
        needs ``on_program_scene_changed`` to report manual overrides —
        so one of them has to be wired up second. Constructing the
        controller first and attaching here keeps that explicit
        instead of reaching into a private attribute from the runner.
        """
        with self._lock:
            self._client = client

    @property
    def listener(self) -> Callable[[Dict[str, Any]], None]:
        """The callable to hand to ``bridge.bus.subscribe``."""
        return self._on_envelope

    def _on_envelope(self, envelope: Dict[str, Any]) -> None:
        # Runs on the bridge's thread. Do the absolute minimum.
        if not self._enabled:
            return
        with self._lock:
            self._inbox = envelope
        self._wake.set()

    # ------------------------------------------------------------------
    # Lifecycle
    # ------------------------------------------------------------------

    def start(self) -> None:
        if not self._enabled:
            _log.info("obs_scene_controller_disabled")
            return
        if self._thread is not None and self._thread.is_alive():
            return
        self._stop.clear()
        self._thread = threading.Thread(
            target=self._loop,
            name="sc2tools-obs-scene",
            daemon=True,
        )
        self._thread.start()
        _log.info(
            "obs_scene_controller_started debounce_sec=%.1f map=%s",
            self._debounce,
            ",".join(
                f"{k}={v}" for k, v in sorted(self._scene_map.items()) if v
            ) or "(empty)",
        )

    def shutdown(self) -> None:
        self._stop.set()
        self._wake.set()
        if self._thread is not None:
            self._thread.join(timeout=2.0)
            self._thread = None

    def set_config(
        self,
        *,
        scene_map: Optional[Dict[str, str]] = None,
        enabled: Optional[bool] = None,
        debounce_sec: Optional[float] = None,
        switch_on_replays: Optional[bool] = None,
        transition_name: Optional[str] = None,
        transition_duration_ms: Optional[int] = None,
    ) -> None:
        """Apply Settings-tab edits without restarting the agent.

        Mirrors the ``upload.set_concurrency`` hot-swap precedent in
        ``runner._handle_save_settings``.
        """
        with self._lock:
            if scene_map is not None:
                self._scene_map = dict(scene_map)
                self._warned_missing.clear()
                # The new map may resolve the current phase to a
                # different scene; forget what we applied so the next
                # envelope re-evaluates from scratch.
                self._last_applied_scene = None
            if debounce_sec is not None:
                self._debounce = max(0.0, float(debounce_sec))
            if switch_on_replays is not None:
                self._switch_on_replays = switch_on_replays
            if transition_name is not None:
                self._transition_name = transition_name or None
            if transition_duration_ms is not None:
                self._transition_duration_ms = transition_duration_ms
            self._pending_scene = None
            self._manual_hold = False
        if enabled is not None and enabled != self._enabled:
            self._enabled = enabled
            if enabled:
                self.start()
            else:
                self.shutdown()

    # ------------------------------------------------------------------
    # Manual-override detection
    # ------------------------------------------------------------------

    def on_program_scene_changed(self, scene_name: str) -> None:
        """Hook for ``ObsClient(on_program_scene_changed=...)``.

        Fires on the obsws event thread for *every* program scene
        change, including our own. Anything we didn't initiate is
        treated as the streamer taking manual control.
        """
        with self._lock:
            if scene_name == self._last_applied_scene:
                return
            self._manual_hold = True
            self._pending_scene = None
            # Track reality so that when the hold lifts we correctly
            # detect whether a switch is still needed.
            self._last_applied_scene = scene_name
        METRICS.incr("obs.switch.suppressed_manual")
        self.suppressed += 1
        _log.info(
            "obs_switch_suppressed reason=manual_hold scene=%r "
            "(auto-switching resumes at the next phase change)",
            scene_name,
        )

    # ------------------------------------------------------------------
    # Worker
    # ------------------------------------------------------------------

    def _loop(self) -> None:
        while not self._stop.is_set():
            timeout = self._next_wait()
            self._wake.wait(timeout)
            self._wake.clear()
            if self._stop.is_set():
                return
            try:
                self._drain()
            except Exception:  # noqa: BLE001
                _log.debug("obs_scene_tick_failed", exc_info=True)

    def _next_wait(self) -> float:
        with self._lock:
            if self._pending_scene is None:
                return _IDLE_WAIT_SEC
            remaining = self._pending_at - self._clock()
        # Clamp: a non-positive remaining means the deadline already
        # passed and we should re-enter ``_drain`` immediately.
        return max(0.0, min(_IDLE_WAIT_SEC, remaining))

    def _drain(self) -> None:
        with self._lock:
            envelope, self._inbox = self._inbox, None
        if envelope is not None:
            self._consider(envelope)
        self._fire_due_pending()

    def _consider(self, envelope: Dict[str, Any]) -> None:
        phase = envelope.get("phase")
        if not isinstance(phase, str):
            return

        with self._lock:
            phase_changed = phase != self._last_phase
            self._last_phase = phase
            if phase_changed:
                # A real phase transition is the boundary at which we
                # stop deferring to a manual override.
                self._manual_hold = False
            manual_hold = self._manual_hold

        # Watching a replay must not fire the in-game layout.
        if envelope.get("isReplay") and not self._switch_on_replays:
            METRICS.incr("obs.switch.suppressed_replay")
            with self._lock:
                self._pending_scene = None
            return

        target = self._scene_map.get(phase) or None
        if target is None:
            # Explicitly mapped to "don't switch".
            return

        with self._lock:
            if target == self._last_applied_scene:
                # Already there — cancel any armed leave-switch that a
                # brief menu blip may have set up.
                self._pending_scene = None
                return
            if manual_hold:
                METRICS.incr("obs.switch.suppressed_manual")
                return

            if phase in LEAVING_PHASES and self._debounce > 0:
                if self._pending_scene != target:
                    self._pending_scene = target
                    self._pending_at = self._clock() + self._debounce
                    METRICS.incr("obs.switch.suppressed_debounce")
                return
            self._pending_scene = None

        self._apply(target, phase=phase, reason="phase_change")

    def _fire_due_pending(self) -> None:
        with self._lock:
            if self._pending_scene is None:
                return
            if self._clock() < self._pending_at:
                return
            target = self._pending_scene
            self._pending_scene = None
            phase = self._last_phase or "?"
        self._apply(target, phase=phase, reason="debounce_elapsed")

    # ------------------------------------------------------------------
    # The actual switch
    # ------------------------------------------------------------------

    def _apply(self, scene: str, *, phase: str, reason: str) -> None:
        with self._lock:
            client = self._client
        if client is None:
            # ``attach_client`` was never called. Treat it the same as a
            # disconnected OBS rather than raising into the worker.
            METRICS.incr("obs.switch.error")
            self.switches_failed += 1
            return

        known = client.scene_names
        if known and scene not in known:
            METRICS.incr("obs.switch.scene_missing")
            if scene not in self._warned_missing:
                self._warned_missing.add(scene)
                _log.warning(
                    "obs_scene_missing scene=%r phase=%s "
                    "(configured scene does not exist in OBS)",
                    scene,
                    phase,
                )
            return

        started = time.monotonic()
        try:
            self._maybe_set_transition(client)
            client.set_current_program_scene(scene)
        except ObsUnavailable:
            # OBS closed or the socket dropped. The client's connect
            # loop handles recovery; we just skip this transition
            # rather than queueing a stale one.
            METRICS.incr("obs.switch.error")
            self.switches_failed += 1
            _log.debug(
                "obs_scene_switch_skipped phase=%s scene=%r reason=disconnected",
                phase,
                scene,
            )
            return
        except Exception:  # noqa: BLE001
            METRICS.incr("obs.switch.error")
            self.switches_failed += 1
            _log.warning(
                "obs_scene_switch_failed phase=%s scene=%r",
                phase,
                scene,
                exc_info=True,
            )
            return

        latency_ms = (time.monotonic() - started) * 1000.0
        METRICS.observe_ms("obs.switch.latency", latency_ms)
        METRICS.incr("obs.switch.ok")
        self.switches_ok += 1
        with self._lock:
            self._last_applied_scene = scene
        _log.info(
            "obs_scene_switch phase=%s scene=%r reason=%s latency_ms=%.0f",
            phase,
            scene,
            reason,
            latency_ms,
        )

    def _maybe_set_transition(self, client: Any) -> None:
        """Apply the configured transition, if the user set one.

        Left unset by default — most streamers have already chosen a
        transition in OBS and would not thank us for overriding it.
        Failures here are non-fatal: a missing transition name must not
        stop the scene switch itself.
        """
        if self._transition_name:
            try:
                client.set_current_scene_transition(self._transition_name)
            except Exception:  # noqa: BLE001
                _log.debug(
                    "obs_transition_set_failed name=%r",
                    self._transition_name,
                    exc_info=True,
                )
        if self._transition_duration_ms:
            try:
                client.set_current_scene_transition_duration(
                    int(self._transition_duration_ms),
                )
            except Exception:  # noqa: BLE001
                _log.debug("obs_transition_duration_set_failed", exc_info=True)


__all__ = [
    "DEFAULT_DEBOUNCE_SEC",
    "DEFAULT_SCENE_MAP",
    "LEAVING_PHASES",
    "SCENE_BETWEEN_GAMES",
    "SCENE_IN_GAME",
    "ObsSceneController",
]
