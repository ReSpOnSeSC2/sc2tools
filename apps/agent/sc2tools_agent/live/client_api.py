"""``LiveClientPoller`` — talks to Blizzard's local SC2 client API.

Blizzard's SC2 client exposes an undocumented but stable HTTP server
on ``http://localhost:6119`` whenever the game is running. Two
endpoints we care about:

* ``GET /game`` → ``{"isReplay": bool, "displayTime": float,
  "players": [{"id": int, "name": str, "type": "user"|"computer",
  "race": str, "result": "Undecided"|"Victory"|"Defeat"|"Tie"}, ...]}``
* ``GET /ui`` → ``{"activeScreens": ["ScreenLoading", ...]}``

Both endpoints are unauthenticated and localhost-only by design. They
have been used by community OBS overlays for years (e.g. SC2-OBS-Player-
Names, NS Stats Overlay) without breakage. Documented at
``https://us.forums.blizzard.com/en/sc2/`` only as community knowledge,
which is why the prompt is the canonical-spec for our use of them.

This module:

* Polls both endpoints on a 1 Hz interval (default; configurable).
* Quietly back-offs when the SC2 client isn't running (connection
  refused → 5 s back-off so we don't spam ``ConnectionRefusedError``
  retries during the typical "user has SC2 closed for hours" case).
* Coalesces transitions into typed ``LiveLifecycleEvent`` records via
  a small state machine and emits them onto the event bus.
* Synthesises a stable ``game_key`` from sorted player names + the
  match-start timestamp so the cloud can stitch live updates to the
  post-game replay record.

It does NOT do enrichment — that's the bridge's job (Phase 2+).
"""

from __future__ import annotations

import logging
import threading
import time
from dataclasses import dataclass
from typing import Any, Dict, Iterable, List, Optional

import requests

from .event_bus import EventBus
from .metrics import METRICS
from .types import (
    LiveGameState,
    LiveLifecycleEvent,
    LiveLifecyclePhase,
    LivePlayer,
    LiveUIState,
)

_log = logging.getLogger("sc2tools_agent.live.client_api")

DEFAULT_BASE_URL = "http://localhost:6119"
DEFAULT_INTERVAL_SEC = 1.0
# Mid-transition we briefly speed up so the loading-screen → in-game
# flip isn't quantised by a 1 Hz poll. Once the bridge has emitted
# MATCH_STARTED we drop back to the default interval.
DEFAULT_FAST_INTERVAL_SEC = 0.25
# When the SC2 client is unreachable (connection refused), back off so
# the agent doesn't burn CPU on retry storms while the user is away
# from the game. The reachable-then-unreachable case (e.g. SC2 crashed
# mid-match) is covered by the same back-off because the next poll
# also raises ConnectionError.
DEFAULT_IDLE_BACKOFF_SEC = 5.0
# Per-request HTTP timeout. The local API responds in under 5 ms when
# healthy; 2 s leaves headroom for a hung client without blocking the
# poll loop indefinitely.
REQUEST_TIMEOUT_SEC = 2.0


@dataclass(frozen=True)
class PollerConfig:
    """Tunables for the poller. Defaults are production-ready; tests
    pass tighter values to keep iterations fast."""

    base_url: str = DEFAULT_BASE_URL
    interval_sec: float = DEFAULT_INTERVAL_SEC
    fast_interval_sec: float = DEFAULT_FAST_INTERVAL_SEC
    idle_backoff_sec: float = DEFAULT_IDLE_BACKOFF_SEC
    request_timeout_sec: float = REQUEST_TIMEOUT_SEC


class LiveClientPoller:
    """Background thread that polls the SC2 client API and emits typed
    lifecycle events.

    Lifecycle:

    1. ``IDLE`` — SC2 not running / localhost:6119 refused. The bridge
       and downstream transports stay quiet; nothing is broadcast.
    2. ``MENU`` — SC2 running but the user is in a menu / browsing
       replays / on the home screen. Widgets clear.
    3. ``MATCH_LOADING`` — ``activeScreens`` includes ``ScreenLoading``
       AND ``/game`` already lists the opponent (Blizzard publishes
       both player names a few hundred ms before the loading screen
       finishes). Widgets render skeletons + opponent name + race.
    4. ``MATCH_STARTED`` — first poll where ``displayTime > 0`` and no
       result is decided. Widgets render full data.
    5. ``MATCH_IN_PROGRESS`` — periodic ticks while the game is live.
    6. ``MATCH_ENDED`` — first poll where any user player has a
       non-Undecided result. After this the poller drops to MENU as
       soon as ``activeScreens`` reports a non-game screen.
    """

    def __init__(
        self,
        bus: EventBus[LiveLifecycleEvent],
        *,
        config: Optional[PollerConfig] = None,
        session: Optional[requests.Session] = None,
        user_name_hint: Optional[str] = None,
    ) -> None:
        self._bus = bus
        self._cfg = config or PollerConfig()
        # Shared session so connection-pooling kicks in — the keep-alive
        # connection to localhost is essentially free.
        self._session = session or requests.Session()
        self._user_name_hint = user_name_hint
        self._stop = threading.Event()
        self._thread: Optional[threading.Thread] = None
        # State carried across polls so the state machine can detect
        # transitions instead of just emitting current state.
        # ``None`` means "never observed" — the first poll ALWAYS emits
        # so operators see "live bridge alive" in agent.log even when
        # the user boots the agent with SC2 closed.
        self._last_phase: Optional[LiveLifecyclePhase] = None
        self._current_game_key: Optional[str] = None
        self._match_started_at_ms: Optional[int] = None
        # The last MATCH_IN_PROGRESS displayTime we emitted, so we can
        # de-duplicate identical ticks (the client API sometimes
        # repeats the same value within sub-second polls).
        self._last_in_progress_display_time: float = -1.0

    # ------------------------------------------------------------ control
    def start(self) -> None:
        if self._thread is not None and self._thread.is_alive():
            return
        self._stop.clear()
        self._thread = threading.Thread(
            target=self._loop,
            name="sc2tools-live-poller",
            daemon=True,
        )
        self._thread.start()

    def stop(self) -> None:
        self._stop.set()
        thr = self._thread
        if thr is not None:
            thr.join(timeout=2.0)

    def set_user_name_hint(self, name: Optional[str]) -> None:
        """Update the streamer's display name so opponent picking is
        more reliable in 1v1 matches where both players are reported
        as ``user``. Called by the bridge once the player_handle is
        resolved (cloud profile / cache / auto-detect)."""
        self._user_name_hint = name

    # ------------------------------------------------------------ loop
    def _loop(self) -> None:
        log = _log
        while not self._stop.is_set():
            try:
                phase, sleep_for = self._tick_once()
            except Exception:  # noqa: BLE001
                # Defensive — anything raising past _tick_once means a
                # bug, not a transient network blip. Log and idle so
                # the agent doesn't spin in a tight error loop.
                log.exception("live_poller_tick_failed")
                phase, sleep_for = (
                    LiveLifecyclePhase.IDLE,
                    self._cfg.idle_backoff_sec,
                )
            # ``_tick_once`` returns the *desired* sleep based on the
            # phase it just observed (idle/menu use the default, mid-
            # transition uses fast_interval). Block on the stop event
            # so ``stop()`` is responsive within the sleep window.
            if self._stop.wait(sleep_for):
                return
            # Track last_phase for the next tick's transition detection.
            self._last_phase = phase

    def _tick_once(self) -> tuple[LiveLifecyclePhase, float]:
        """Single poll iteration. Returns (observed phase, sleep duration)."""
        ui = self._fetch_ui()
        if ui is None:
            # Client unreachable. Emit IDLE only on the transition
            # away from a previously-active phase so the bus doesn't
            # see a heartbeat-style flood while SC2 is closed.
            if self._last_phase != LiveLifecyclePhase.IDLE:
                self._emit_simple(LiveLifecyclePhase.IDLE)
                # Also clear per-game state so a relaunch starts clean.
                self._current_game_key = None
                self._match_started_at_ms = None
                self._last_in_progress_display_time = -1.0
            return LiveLifecyclePhase.IDLE, self._cfg.idle_backoff_sec

        game = self._fetch_game()
        if game is None:
            # /ui worked but /game didn't — extremely rare, treat as
            # menu so widgets clear and we keep polling at the slow
            # cadence (no "fast" mode — there's no transition in flight).
            if self._last_phase != LiveLifecyclePhase.MENU:
                self._emit(
                    LiveLifecyclePhase.MENU,
                    ui_state=ui,
                    game_state=None,
                )
            return LiveLifecyclePhase.MENU, self._cfg.interval_sec

        # Replay sessions: explicitly do NOT push to the bridge. The
        # streamer reviewing a vod doesn't want fake "scouting" widgets
        # appearing for the in-replay opponent.
        if game.is_replay:
            if self._last_phase != LiveLifecyclePhase.MENU:
                self._emit(
                    LiveLifecyclePhase.MENU,
                    ui_state=ui,
                    game_state=game,
                )
            return LiveLifecyclePhase.MENU, self._cfg.interval_sec

        # Match end takes priority over loading / in-progress: if any
        # user player has a decided result, that's the final state for
        # this match.
        if game.is_decided:
            if self._last_phase != LiveLifecyclePhase.MATCH_ENDED:
                self._emit(
                    LiveLifecyclePhase.MATCH_ENDED,
                    ui_state=ui,
                    game_state=game,
                )
            return LiveLifecyclePhase.MATCH_ENDED, self._cfg.interval_sec

        if ui.is_loading:
            # Loading screen with at least the opponent on /game. The
            # earliest moment widgets can pre-populate. Use the fast
            # interval so we catch the loading→in-game flip within
            # ~250 ms of it happening.
            if self._last_phase != LiveLifecyclePhase.MATCH_LOADING:
                # New game starting — synthesise its game_key now so
                # subsequent in-progress / ended events carry the same
                # identifier.
                self._match_started_at_ms = int(time.time() * 1000)
                self._current_game_key = _synthesise_game_key(
                    players=game.players,
                    started_at_ms=self._match_started_at_ms,
                )
                self._last_in_progress_display_time = -1.0
                self._emit(
                    LiveLifecyclePhase.MATCH_LOADING,
                    ui_state=ui,
                    game_state=game,
                )
            return LiveLifecyclePhase.MATCH_LOADING, self._cfg.fast_interval_sec

        if ui.is_in_match and game.display_time > 0:
            # First poll inside the match → MATCH_STARTED. Subsequent
            # polls → MATCH_IN_PROGRESS so consumers can distinguish
            # "just transitioned" from "still going".
            if self._last_phase != LiveLifecyclePhase.MATCH_STARTED \
                    and self._last_phase != LiveLifecyclePhase.MATCH_IN_PROGRESS:
                # We came from MENU/IDLE/LOADING — seed the game_key
                # if loading didn't already (rare race when the
                # poller starts mid-game).
                if self._current_game_key is None:
                    self._match_started_at_ms = int(time.time() * 1000)
                    self._current_game_key = _synthesise_game_key(
                        players=game.players,
                        started_at_ms=self._match_started_at_ms,
                    )
                self._emit(
                    LiveLifecyclePhase.MATCH_STARTED,
                    ui_state=ui,
                    game_state=game,
                )
                self._last_in_progress_display_time = game.display_time
                return (
                    LiveLifecyclePhase.MATCH_STARTED,
                    self._cfg.interval_sec,
                )
            # Still in the match — emit periodic IN_PROGRESS only when
            # displayTime advances by a full second so we don't flood
            # the bus with sub-second tick noise.
            if game.display_time - self._last_in_progress_display_time >= 1.0:
                self._emit(
                    LiveLifecyclePhase.MATCH_IN_PROGRESS,
                    ui_state=ui,
                    game_state=game,
                )
                self._last_in_progress_display_time = game.display_time
            return (
                LiveLifecyclePhase.MATCH_IN_PROGRESS,
                self._cfg.interval_sec,
            )

        # Fall-through: SC2 running, on a menu screen.
        if self._last_phase != LiveLifecyclePhase.MENU:
            self._emit(
                LiveLifecyclePhase.MENU,
                ui_state=ui,
                game_state=game,
            )
            # Clear per-game state so the next match starts fresh.
            self._current_game_key = None
            self._match_started_at_ms = None
            self._last_in_progress_display_time = -1.0
        return LiveLifecyclePhase.MENU, self._cfg.interval_sec

    # ------------------------------------------------------------ helpers
    def _fetch_ui(self) -> Optional[LiveUIState]:
        started = time.monotonic()
        try:
            r = self._session.get(
                f"{self._cfg.base_url}/ui",
                timeout=self._cfg.request_timeout_sec,
            )
        except (requests.ConnectionError, requests.Timeout):
            METRICS.incr("client_api.ui.unreachable")
            return None
        except requests.RequestException:
            METRICS.incr("client_api.ui.error")
            return None
        METRICS.observe_ms(
            "client_api.ui.latency", (time.monotonic() - started) * 1000.0,
        )
        if r.status_code != 200:
            METRICS.incr("client_api.ui.bad_status")
            return None
        try:
            data: Dict[str, Any] = r.json() or {}
        except ValueError:
            METRICS.incr("client_api.ui.bad_json")
            return None
        screens = data.get("activeScreens") or []
        if not isinstance(screens, list):
            METRICS.incr("client_api.ui.bad_shape")
            return None
        METRICS.incr("client_api.ui.ok")
        return LiveUIState(active_screens=[str(s) for s in screens])

    def _fetch_game(self) -> Optional[LiveGameState]:
        started = time.monotonic()
        try:
            r = self._session.get(
                f"{self._cfg.base_url}/game",
                timeout=self._cfg.request_timeout_sec,
            )
        except (requests.ConnectionError, requests.Timeout):
            METRICS.incr("client_api.game.unreachable")
            return None
        except requests.RequestException:
            METRICS.incr("client_api.game.error")
            return None
        METRICS.observe_ms(
            "client_api.game.latency", (time.monotonic() - started) * 1000.0,
        )
        if r.status_code != 200:
            METRICS.incr("client_api.game.bad_status")
            return None
        try:
            data: Dict[str, Any] = r.json() or {}
        except ValueError:
            METRICS.incr("client_api.game.bad_json")
            return None
        players_raw = data.get("players") or []
        if not isinstance(players_raw, list):
            METRICS.incr("client_api.game.bad_shape")
            return None
        players = [_player_from_dict(p) for p in players_raw if isinstance(p, dict)]
        try:
            display_time = float(data.get("displayTime") or 0.0)
        except (TypeError, ValueError):
            display_time = 0.0
        METRICS.incr("client_api.game.ok")
        return LiveGameState(
            display_time=display_time,
            is_replay=bool(data.get("isReplay")),
            players=players,
        )

    def _emit_simple(self, phase: LiveLifecyclePhase) -> None:
        self._bus.publish(LiveLifecycleEvent(phase=phase))

    def _emit(
        self,
        phase: LiveLifecyclePhase,
        *,
        ui_state: Optional[LiveUIState],
        game_state: Optional[LiveGameState],
    ) -> None:
        self._bus.publish(
            LiveLifecycleEvent(
                phase=phase,
                ui_state=ui_state,
                game_state=game_state,
                game_key=self._current_game_key,
            )
        )


def _player_from_dict(raw: Dict[str, Any]) -> LivePlayer:
    """Defensive parse — the localhost API is stable but we still
    coerce every field through ``str`` / ``int`` to immunise against
    a future Blizzard schema tweak that injects a non-string value."""
    pid: Optional[int]
    try:
        pid = int(raw.get("id")) if raw.get("id") is not None else None
    except (TypeError, ValueError):
        pid = None
    return LivePlayer(
        name=str(raw.get("name") or ""),
        type=str(raw.get("type") or ""),
        race=str(raw.get("race") or ""),
        result=str(raw.get("result") or "Undecided"),
        player_id=pid,
    )


def _synthesise_game_key(
    *,
    players: Iterable[LivePlayer],
    started_at_ms: int,
) -> str:
    """Produce a stable id derived from sorted player names + the
    match-start ms timestamp.

    Why not just timestamp: the post-game replay parser doesn't have
    access to our wall-clock match-start (it computes its own gameId
    from the replay header). Including the sorted player names makes
    it possible to reconcile the two — the cloud can match a live
    record against a freshly-uploaded replay by checking name overlap
    + timestamp proximity (within ~5 minutes).

    Why not pulseId: at MATCH_LOADING time we may not have resolved
    the opponent's pulse profile yet (Pulse lookup runs in parallel).
    The names are immediately available from /game.
    """
    names = sorted(
        (p.name for p in players if p.name),
        key=str.casefold,
    )
    name_part = "|".join(names) or "unknown"
    return f"{name_part}|{started_at_ms}"


__all__ = [
    "DEFAULT_BASE_URL",
    "DEFAULT_FAST_INTERVAL_SEC",
    "DEFAULT_IDLE_BACKOFF_SEC",
    "DEFAULT_INTERVAL_SEC",
    "LiveClientPoller",
    "PollerConfig",
    "REQUEST_TIMEOUT_SEC",
]
