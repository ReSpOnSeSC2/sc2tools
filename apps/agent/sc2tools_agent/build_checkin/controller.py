"""``BuildCheckinController`` — decides when the build check-in cards
appear, what they show, and what reaches the cloud.

Actor design
------------

Inputs arrive on five threads: live envelopes on the bridge thread,
upload acceptances on upload workers, socket pings on the Socket.io
loop, player actions on the Qt thread and HTTP results on the executor.
Every public method only appends ``(handler, args)`` to one inbox and
returns. A single state thread owns every record and never does I/O;
HTTP runs on a small executor whose results come back through the same
inbox tagged with the record and a generation, so an answer that a
newer request or a newer game has overtaken is dropped. Before each
``View.show_*`` / ``update_*`` the controller checks the card is still
current (same live game, still in the window).

Tests drive it deterministically: inject a synchronous executor and a
fake clock, never call :meth:`start`, and pump with :meth:`run_pending`.

Card policy (contract §1.2, §1.3)
---------------------------------

* Loading card: first envelope of a 1v1-vs-human ``gameKey`` in
  ``match_loading`` (or ``match_started`` before 30 s of game time),
  when ``enabled && askAtLoading``. Never for Random; "Waiting for
  matchup…" until both races are concrete. Hidden at 30 s, on
  menu/idle/match_ended and when another game starts.
* End card: at ``match_ended`` for a game not declared at loading (a
  shell that fills in when the replay is accepted); for a declared game
  only when the replay disagrees (``notes_first``). **Later**, 120 s
  without interaction and the next game's start set it aside with its
  draft; a pre-empted card the player touched comes back once.
* Once the replay is in, the end card also offers the opponent's build
  (sent as ``opponentBuildKey`` only when the player changed it) and
  **Add new build…**, which opens the game on sc2tools.com and steps
  aside for the browser.
"""

from __future__ import annotations

import itertools
import logging
import queue
import threading
import time
import webbrowser
from collections import OrderedDict
from concurrent.futures import ThreadPoolExecutor
from dataclasses import replace
from typing import Any, Callable, Dict, Optional, Protocol, Set, Tuple

from ..api_client import ApiError
from ..session_stats import session_account_key
from ..state import _STATE_SAVE_LOCK
from .matching import (
    accepted_ineligibility,
    closest_by_key_ms,
    game_started_ms,
    opponent_name_of,
    players_one_v_one,
    roster_complete,
    user_result,
    within_match_window,
)
from .links import DEFAULT_DASHBOARD_URL, new_build_url, web_queue_url
from .models import (
    BUILD_SIDES,
    CHECKING_REPLAY,
    STATUS_DECLARE_OFFLINE,
    STATUS_DECLARE_UNAVAILABLE,
    STATUS_RANDOMIZER_REQUEST_FAILED,
    STATUS_REPLAY_UNAVAILABLE,
    STATUS_SAVE_FAILED,
    STATUS_SAVE_UNKNOWN_BUILD,
    STATUS_SAVE_UNKNOWN_OPPONENT_BUILD,
    BuildOptions,
    BuildRef,
    CheckinPrefs,
    GameIntentState,
    LiveState,
    canonical_race,
    game_key_ms,
    is_concrete_race,
    matchups_for_race,
    normalize_player_name,
    opponent_change,
    parse_build_options,
    parse_game_intent,
    parse_live_state,
    parse_prefs,
    sanitize_notes,
)
from .scouting_controller import ScoutingControllerMixin
from .records import (
    ACTIVE_PHASES,
    CARD_DONE,
    CARD_HIDDEN,
    CARD_VISIBLE,
    FULL,
    NOTES_FIRST,
    CardOp,
    LiveGame,
    LiveOp,
    LoadingCard,
    PostgameCard,
)
from .render import loading_model, opponent_write, postgame_model, preselection
from .view import (
    HIDE_CONFIRMED,
    HIDE_DECIDED,
    HIDE_DISABLED,
    HIDE_DISMISSED,
    HIDE_IN_GAME,
    HIDE_LATER,
    HIDE_MATCH_ENDED,
    HIDE_MENU,
    HIDE_NEW_GAME,
    HIDE_NOT_1V1,
    HIDE_NOT_ELIGIBLE,
    HIDE_OPENED_WEB,
    HIDE_PREEMPTED,
    HIDE_RANDOM,
    HIDE_REPLACED,
    HIDE_SKIPPED,
    HIDE_TIMEOUT,
    BuildCheckinView,
    NullView,
)

_log = logging.getLogger("sc2tools_agent.build_checkin")

DEFAULT_WEB_QUEUE_URL = web_queue_url(DEFAULT_DASHBOARD_URL)

LOADING_CUTOFF_SEC = 30.0
"""Game seconds after which the loading card is in the way."""
LOADING_CARD_MAX_SEC = 180.0
"""Wall-clock cap on a loading card that never got a hide signal."""
POSTGAME_IDLE_HIDE_SEC = 120.0
PENDING_CARD_MAX_AGE_SEC = 30 * 60.0
"""A card still waiting for the window after this long is left to the web."""
RESHOW_MAX_WAIT_SEC = 90 * 60.0
"""A pre-empted card the player touched comes back after the next match,
however long it ran, unless that took longer than this."""
LIVE_PING_MAX_AGE_SEC = 30 * 60.0
OPTIONS_TTL_SEC = 600.0
PREFS_REFRESH_MIN_SEC = 30.0
PREFS_RETRY_SEC = (5.0, 15.0, 60.0)
"""Backoff for a preference read that failed before any answer (offline
at login); the last step repeats until the server answers."""
TRACKED_GAMES = 5
MAX_CARDS = 10
SEEN_GAME_IDS = 200
HTTP_WORKERS = 2
DECLARE_ATTEMPTS = 2
MAX_REGISTERS = 2
# The poller re-keys a match it briefly lost track of. A loading screen back
# this soon against the same opponent, or a match first seen already running
# this soon after, is that match: its loading-screen pick carries over. The
# loading gap covers a client-API outage (a few missed polls, then the idle
# backoff) and is shorter than a re-queue into a rematch.
REKEY_LOADING_GAP_SEC = 30.0
REKEY_MATCH_GAP_SEC = 120.0

_LOADING_WHICH = "loading"
_POSTGAME_WHICH = "postgame"

_KEEP: Any = object()
"""Default of an action's ``opponent`` argument: the view did not touch
the opponent row, so the card keeps its own opponent draft."""

_SAVE_ERRORS = {
    "unknown_build": STATUS_SAVE_UNKNOWN_BUILD,
    "unknown_opponent_build": STATUS_SAVE_UNKNOWN_OPPONENT_BUILD,
}


class Executor(Protocol):
    def submit(self, fn: Callable[..., Any], /, *args: Any, **kwargs: Any) -> Any:
        ...


class _Failure:
    """What went wrong with one request, without leaking its body."""

    __slots__ = ("status", "code", "game_id")

    def __init__(self, exc: BaseException) -> None:
        self.status: Optional[int] = None
        self.code: Optional[str] = None
        self.game_id: Optional[str] = None
        if isinstance(exc, ApiError):
            self.status = exc.status
            self.code = exc.code
            game_id = exc.error.get("gameId")
            if isinstance(game_id, str) and game_id:
                self.game_id = game_id


class BuildCheckinController(ScoutingControllerMixin):
    """Single-threaded actor behind the build check-in cards."""

    def __init__(
        self,
        *,
        api: Any,
        view: Optional[BuildCheckinView] = None,
        executor: Optional[Executor] = None,
        clock: Callable[[], float] = time.monotonic,
        wall_clock: Callable[[], float] = time.time,
        intro_seen: bool = False,
        on_intro_dismissed: Optional[Callable[[], None]] = None,
        web_queue_url: str = DEFAULT_WEB_QUEUE_URL,
        dashboard_url: str = DEFAULT_DASHBOARD_URL,
        open_url: Callable[[str], Any] = webbrowser.open,
        prefs: Optional[CheckinPrefs] = None,
        on_prefs_changed: Optional[Callable[[CheckinPrefs], None]] = None,
        show_scouting_at_loading: bool = False,
        on_scouting_changed: Optional[Callable[[bool], None]] = None,
        connection_provider: Optional[Callable[[], tuple]] = None,
        identity_provider: Optional[Callable[[], tuple]] = None,
    ) -> None:
        """``prefs`` is the last preference the server confirmed (kept in
        ``AgentState``): the cards follow it until this session's first
        read answers, so a player who turned them off is not shown one
        just because the agent started offline. ``on_prefs_changed``
        persists each newly confirmed value (called off the state
        thread)."""
        self._api = api
        self._connection_provider = connection_provider
        self._identity_provider = identity_provider
        self._request_api = None
        self._request_epoch = 0
        self._pending_requests = {}
        self._view: Any = view if view is not None else NullView()
        self._owns_executor = executor is None
        self._executor: Executor = executor or ThreadPoolExecutor(
            max_workers=HTTP_WORKERS,
            thread_name_prefix="sc2tools-checkin-http",
        )
        self._clock = clock
        self._wall_clock = wall_clock
        self._on_intro_dismissed = on_intro_dismissed
        self._web_queue_url = web_queue_url
        self._dashboard_url = dashboard_url
        self._open_url = open_url
        self._on_prefs_changed = on_prefs_changed
        self._show_scouting = bool(show_scouting_at_loading)
        self._on_scouting_changed = on_scouting_changed

        self._inbox: "queue.Queue[Optional[Tuple[Callable[..., None], tuple]]]" = (
            queue.Queue()
        )
        self._stopped = threading.Event()
        self._lifecycle_lock = threading.Lock()
        self._thread: Optional[threading.Thread] = None
        self._unsubscribe: Optional[Callable[[], None]] = None

        # ---- state below is touched only by the state thread ----
        self._prefs = prefs or CheckinPrefs()
        self._prefs_confirmed: Optional[CheckinPrefs] = prefs
        self._prefs_remembered: Optional[CheckinPrefs] = prefs
        self._supported: Optional[bool] = None
        self._prefs_read_inflight = False
        self._prefs_reread = False
        self._prefs_read_during_write = False
        self._prefs_read_at: Optional[float] = None
        self._prefs_retry_at: Optional[float] = None
        self._prefs_failures = 0
        self._prefs_write_inflight = False
        self._prefs_write_pending: Optional[CheckinPrefs] = None

        self._games: "OrderedDict[str, LiveGame]" = OrderedDict()
        self._current_key: Optional[str] = None
        self._prefetched_race: Optional[str] = None

        self._cards: Dict[str, PostgameCard] = {}
        self._card_seq = itertools.count(1)
        self._visible_card_id: Optional[str] = None
        self._pending_show: Set[str] = set()
        self._state_gens: Dict[str, int] = {}
        self._seen_game_ids: "OrderedDict[str, None]" = OrderedDict()

        self._options: Dict[str, Tuple[float, BuildOptions]] = {}
        self._options_inflight: Set[str] = set()
        self._options_failed: Set[str] = set()

        self._intro_seen = bool(intro_seen)
        self._connection_snapshot = self._identity_snapshot()
        self._connection_api = api

    # ================================================================
    # Lifecycle (any thread)
    # ================================================================

    def start(self) -> None:
        """Start the state thread and fetch the cloud preference."""
        with self._lifecycle_lock:
            if self._stopped.is_set():
                return
            if self._thread is not None and self._thread.is_alive():
                return
            self._thread = threading.Thread(
                target=self._run,
                name="sc2tools-build-checkin",
                daemon=True,
            )
            self._thread.start()
        self.refresh_prefs()
        _log.info("build_checkin_started")

    def stop(self) -> None:
        """Detach from the bus and stop; queued work is discarded."""
        with self._lifecycle_lock:
            unsubscribe, self._unsubscribe = self._unsubscribe, None
            self._stopped.set()
            thread = self._thread
        if unsubscribe is not None:
            unsubscribe()
        self._inbox.put(None)
        if thread is not None and thread is not threading.current_thread():
            thread.join(timeout=2.0)
        if self._owns_executor:
            shutdown = getattr(self._executor, "shutdown", None)
            if callable(shutdown):
                shutdown(wait=False, cancel_futures=True)

    def attach(self, bus: Any) -> None:
        """Subscribe to the live bridge's output bus."""
        unsubscribe = bus.subscribe(self.on_envelope)
        with self._lifecycle_lock:
            previous, self._unsubscribe = self._unsubscribe, unsubscribe
        if previous is not None:
            previous()

    def run_pending(self) -> int:
        """Process every queued event and due timer on the calling thread.

        For tests and diagnostics; production uses :meth:`start`. Returns
        how many events were handled.
        """
        handled = 0
        while True:
            while True:
                try:
                    item = self._inbox.get_nowait()
                except queue.Empty:
                    break
                if item is not None:
                    self._dispatch(item)
                    handled += 1
            self._run_timers()
            if self._inbox.empty():
                return handled

    @property
    def prefs(self) -> CheckinPrefs:
        """The current preference (an immutable snapshot)."""
        return self._prefs

    @property
    def available(self) -> Optional[bool]:
        """``False`` when the API predates build check-in, ``None`` until
        the first preference read answers."""
        return self._supported

    # ================================================================
    # Inputs (any thread; each only enqueues)
    # ================================================================

    def set_view(self, view: Optional[BuildCheckinView]) -> None:
        self._post(self._handle_set_view, view)

    def on_envelope(self, envelope: Dict[str, Any]) -> None:
        """``bridge.bus`` subscriber. Never blocks the publisher."""
        self._post(self._handle_envelope, envelope)

    def on_connection_changed(self) -> None:
        self._post(lambda: None)

    def on_game_accepted(
        self,
        path: Any,
        game: Any,
        game_id: str,
        accepted_row: Dict[str, Any],
    ) -> None:
        """``UploadQueue`` callback for a live-lane upload the API took."""
        del path  # the replay file is irrelevant to the card
        self._post(self._handle_accepted, game, game_id, dict(accepted_row or {}))

    def on_intent_changed(self, ping: Dict[str, Any]) -> None:
        """``build-intent:changed`` socket ping: ``{gameKey}``, ``{gameId}``
        or ``{prefs: true}`` (the check-in preference changed)."""
        self._post(self._handle_ping, dict(ping or {}))

    def declare(self, game_key: str, build_key: str) -> None:
        self._post(self._handle_declare, game_key, build_key)

    def undeclare(self, game_key: str) -> None:
        self._post(self._handle_undeclare, game_key)

    def roll_now(self, game_key: str) -> None:
        self._post(self._handle_roll_now, game_key)

    def not_now(self, game_key: str) -> None:
        self._post(self._handle_not_now, game_key)

    def confirm(
        self,
        card_id: str,
        build_key: str,
        notes: str = "",
        opponent: Any = _KEEP,
    ) -> None:
        """Answer the end card. ``opponent`` (the opponent row's key,
        ``None`` for the replay's label) is passed once the player
        changed that row; it reaches the server only when it differs
        from what the game counts."""
        self._post(self._handle_confirm, card_id, build_key, notes, opponent)

    def no_set_build(self, card_id: str, notes: str = "", opponent: Any = _KEEP) -> None:
        self._post(self._handle_no_set_build, card_id, notes, opponent)

    def later(self, card_id: str, notes: str = "") -> None:
        self._post(self._handle_later, card_id, notes)

    def interacted(self, card_id: str) -> None:
        self._post(self._handle_interacted, card_id)

    def update_draft(
        self,
        card_id: str,
        build_key: Optional[str],
        notes: str,
        opponent: Any = _KEEP,
    ) -> None:
        """The player changed the end card's selection, notes or opponent
        row; keeps the draft current so pre-emption and auto-hide never
        lose it."""
        self._post(self._handle_update_draft, card_id, build_key, notes, opponent)

    def add_build(self, card_id: str, side: str) -> None:
        """**Add new build…** (``side``: ``you`` | ``opponent``): open the
        game on sc2tools.com with the build editor and step aside."""
        self._post(self._handle_add_build, card_id, side)

    def disable(self, which: str) -> None:
        """``loading`` | ``postgame``: the cards' "don't ask" links."""
        self._post(self._handle_disable, which)

    def dismiss_intro(self) -> None:
        self._post(self._handle_dismiss_intro)

    def reopen(self) -> None:
        """Tray "Build check-in…": the newest undecided card, else the web."""
        self._post(self._handle_reopen)

    def refresh_prefs(self) -> None:
        self._post(self._handle_refresh_prefs, True)

    def set_prefs(
        self,
        *,
        enabled: Optional[bool] = None,
        ask_at_loading: Optional[bool] = None,
        ask_after_game: Optional[bool] = None,
    ) -> None:
        """Write the cloud preference (Settings checkboxes)."""
        changes = {
            name: bool(value)
            for name, value in (
                ("enabled", enabled),
                ("ask_at_loading", ask_at_loading),
                ("ask_after_game", ask_after_game),
            )
            if value is not None
        }
        if changes:
            self._post(self._handle_set_prefs, changes)

    # ================================================================
    # Actor plumbing
    # ================================================================

    def _post(self, handler: Callable[..., None], *args: Any) -> None:
        if not self._stopped.is_set():
            identity = self._identity_snapshot()
            if identity is None:
                self._inbox.put((handler, args))
            else:
                self._inbox.put((self._handle_linked_input, (identity, handler, args)))

    def _handle_linked_input(self, connection, handler, args):
        with _STATE_SAVE_LOCK:
            api, current = self._api, self._identity_snapshot()
            if current is None or current != connection or not current[1]:
                return
        previous = self._request_api
        self._request_api = api
        try:
            handler(*args)
        finally:
            self._request_api = previous

    def _run(self) -> None:
        while True:
            try:
                item = self._inbox.get(timeout=self._timer_wait())
            except queue.Empty:
                item = ()
            if item is None or self._stopped.is_set():
                return
            if item:
                self._dispatch(item)
            self._run_timers()

    def _dispatch(self, item: Tuple[Callable[..., None], tuple]) -> None:
        handler, args = item
        try:
            self._sync_connection()
            handler(*args)
        except Exception:  # noqa: BLE001
            _log.exception(
                "build_checkin_event_failed handler=%s",
                getattr(handler, "__name__", "?"),
            )

    def _call(
        self,
        on_done: Callable[[Any, Any, Optional[BaseException]], None],
        tag: Any,
        fn: Callable[..., Any],
        *args: Any,
        **kwargs: Any,
    ) -> None:
        """Run ``fn`` on the executor; deliver ``on_done(tag, value, error)``
        back on the state thread."""

        api = self._request_api or self._api
        epoch = self._request_epoch
        bound_api = getattr(fn, "__self__", api)
        if bound_api is not api:
            return
        ticket = object()
        self._pending_requests[ticket] = on_done, tag

        def job() -> None:
            if epoch != self._request_epoch or not self._api_current(api):
                self.on_connection_changed()
                return
            try:
                value = fn(*args, **kwargs)
            except Exception as exc:  # noqa: BLE001
                self._post(self._handle_api_result, api, epoch, ticket, on_done, tag, None, exc)
            else:
                self._post(self._handle_api_result, api, epoch, ticket, on_done, tag, value, None)

        try:
            self._executor.submit(job)
        except RuntimeError:
            # Executor already shut down: the controller is stopping.
            pass

    def _handle_api_result(self, api, epoch, ticket, on_done, tag, value, error):
        if epoch != self._request_epoch or not self._api_current(api):
            return
        self._pending_requests.pop(ticket, None)
        previous = self._request_api
        self._request_api = api
        try:
            on_done(tag, value, error)
        finally:
            self._request_api = previous

    def _api_current(self, api):
        with _STATE_SAVE_LOCK:
            if api is not self._api:
                return False
            identity = self._identity_snapshot()
            if identity is None:
                return True
            base, token = identity[:2]
            api_base = getattr(api, "base_url", None)
            return (isinstance(base, str) and isinstance(api_base, str) and bool(token)
                    and api_base.rstrip("/") == base.rstrip("/")
                    and getattr(api, "device_token", None) == token)

    def _identity_snapshot(self):
        with _STATE_SAVE_LOCK:
            try:
                if self._identity_provider is not None:
                    base, token, owner = self._identity_provider()
                    return base, token, owner
                if self._connection_provider is not None:
                    base, token = self._connection_provider()
                    return base, token, None
            except Exception:
                return None, None, None
        return None

    def _sync_connection(self):
        with _STATE_SAVE_LOCK:
            identity, api = self._identity_snapshot(), self._api
            if identity is None or (identity == self._connection_snapshot and api is self._connection_api):
                return
        previous = self._connection_snapshot
        same_owner = (previous is not None and bool(identity[2])
                      and (previous[0], previous[2]) == (identity[0], identity[2]))
        pending_prefs = self._prefs_write_pending
        if same_owner and pending_prefs is None:
            pending_prefs = next((tag for callback, tag in self._pending_requests.values()
                                  if callback == self._on_prefs_written), None)
        self._connection_snapshot, self._connection_api = identity, api
        self._request_epoch += 1
        self._pending_requests.clear()
        self._prefs_read_inflight = self._prefs_reread = self._prefs_read_during_write = False
        self._prefs_write_inflight = False
        self._prefs_write_pending = pending_prefs if same_owner else None
        self._prefs_read_at = self._prefs_retry_at = None
        self._options_inflight.clear()
        self._options_failed.clear()
        for game in self._games.values():
            self._hide_loading(game, HIDE_DISABLED)
            game.live_read_inflight = game.live_refetch = game.resend_inflight = game.scouting_fetching = False
            if same_owner and game.op_inflight is not None:
                game.ops.appendleft(game.op_inflight)
            game.op_inflight = None
        for card in self._cards.values():
            done = not card.undecided
            self._hide_card(card, HIDE_DISABLED, done=done)
            card.busy = card.state_fetching = card.opponent_note_busy = False
            if same_owner and not done and card.op_inflight is not None:
                card.ops.appendleft(card.op_inflight)
            if done:
                card.ops.clear()
            card.op_inflight = None
        if not same_owner:
            self._games.clear()
            self._cards.clear()
            self._options.clear()
            self._state_gens.clear()
            self._seen_game_ids.clear()
            self._pending_show.clear()
            self._current_key = self._prefetched_race = self._visible_card_id = None
            self._prefs_confirmed = None
            self._supported = None
        if self._api_current(api):
            previous_api = self._request_api
            self._request_api = api
            try:
                self._handle_refresh_prefs(True)
                if same_owner:
                    self._run_prefs_write()
                    for game in self._games.values():
                        self._run_live_ops(game)
                    for card in self._cards.values():
                        if card.undecided:
                            self._run_card_ops(card)
            finally:
                self._request_api = previous_api

    def _background(self, fn: Callable[..., Any], *args: Any) -> None:
        """Fire-and-forget side effect off the state thread."""

        def job() -> None:
            try:
                fn(*args)
            except Exception:  # noqa: BLE001
                _log.exception("build_checkin_background_failed")

        try:
            self._executor.submit(job)
        except RuntimeError:
            pass

    def _view_call(self, method: str, *args: Any) -> None:
        fn = getattr(self._view, method, None)
        if not callable(fn):
            return
        try:
            fn(*args)
        except Exception:  # noqa: BLE001
            _log.exception("build_checkin_view_failed method=%s", method)

    def _timer_wait(self) -> Optional[float]:
        deadline = self._next_deadline()
        if deadline is None:
            return None
        return max(0.05, deadline - self._clock())

    def _next_deadline(self) -> Optional[float]:
        deadlines = []
        card = self._visible_card()
        if card is not None and not card.busy:
            deadlines.append(card.last_activity + POSTGAME_IDLE_HIDE_SEC)
        game = self._current_game()
        if game is not None and game.loading is not None and game.loading.visible:
            deadlines.append(game.loading.shown_at + LOADING_CARD_MAX_SEC)
        if self._prefs_retry_at is not None:
            deadlines.append(self._prefs_retry_at)
        return min(deadlines) if deadlines else None

    def _run_timers(self) -> None:
        now = self._clock()
        card = self._visible_card()
        if (
            card is not None
            and not card.busy
            and now - card.last_activity >= POSTGAME_IDLE_HIDE_SEC
        ):
            # The player walked away: keep the draft, leave the game
            # pending, and do not chain another card in front of them.
            self._set_aside(card, HIDE_TIMEOUT)
        game = self._current_game()
        if (
            game is not None
            and game.loading is not None
            and game.loading.visible
            and now - game.loading.shown_at >= LOADING_CARD_MAX_SEC
        ):
            self._hide_loading(game, HIDE_TIMEOUT)
        if self._prefs_retry_at is not None and now >= self._prefs_retry_at:
            self._prefs_retry_at = None
            self._handle_refresh_prefs(True)

    # ================================================================
    # Shared predicates
    # ================================================================

    def _loading_allowed(self) -> bool:
        game = self._current_game()
        scouting_ready = self._show_scouting and game is not None and game.scouting is not None
        return self._supported is not False and self._prefs.enabled and (self._prefs.ask_at_loading or scouting_ready)

    def _postgame_allowed(self) -> bool:
        return self._supported is not False and self._prefs.postgame_cards

    def _current_game(self) -> Optional[LiveGame]:
        return self._games.get(self._current_key) if self._current_key else None

    def _game_in_progress(self) -> bool:
        game = self._current_game()
        return game is not None and game.in_progress

    def _visible_card(self) -> Optional[PostgameCard]:
        if self._visible_card_id is None:
            return None
        return self._cards.get(self._visible_card_id)

    def _game_for_card(self, card: PostgameCard) -> Optional[LiveGame]:
        return self._games.get(card.game_key) if card.game_key else None

    def _game_by_id(self, game_id: str) -> Optional[LiveGame]:
        return next(
            (game for game in self._games.values() if game.game_id == game_id),
            None,
        )

    def _card_by_game_id(self, game_id: str) -> Optional[PostgameCard]:
        return next(
            (card for card in self._cards.values() if card.game_id == game_id),
            None,
        )

    def _cached_options(self, matchup: Optional[str]) -> Optional[BuildOptions]:
        entry = self._options.get(matchup) if matchup else None
        return entry[1] if entry is not None else None

    def _declared_elsewhere(self, game: LiveGame) -> Optional[BuildRef]:
        """A server declaration this agent did not make (the web)."""
        live = game.live
        if live is None or live.declared is None or game.writing:
            return None
        if game.declared is not None and game.declared.key == live.declared.key:
            return None
        return live.declared

    def _declared_at_loading(self, game: LiveGame) -> bool:
        if game.declared_synced:
            return True
        if game.declared is not None and game.writing and not game.declare_failed:
            return True
        return self._declared_elsewhere(game) is not None

    # ================================================================
    # Live envelopes
    # ================================================================

    def _handle_envelope(self, envelope: Any) -> None:
        if not isinstance(envelope, dict):
            return
        phase = envelope.get("phase")
        raw_key = envelope.get("gameKey")
        key = raw_key if isinstance(raw_key, str) and raw_key else None
        if phase in ("menu", "idle"):
            self._handle_leave(phase, key)
            return
        if key is None or (phase not in ACTIVE_PHASES and phase != "match_ended"):
            return
        game = self._games.get(key)
        new = game is None
        if game is None:
            game = self._track(key)
        elif key != self._current_key or game.closed:
            return  # a late envelope of a previous game
        if phase == "match_loading":
            game.loading_seen = True
        self._update_game(game, envelope, phase)
        self._maybe_carry_pick(game)
        if phase == "match_ended":
            self._handle_match_ended(game)
        else:
            self._handle_active(game)
        if new and self._supported is None:
            # Still no answer from the server (offline at login): a game
            # start is a good moment to try again.
            self._handle_refresh_prefs(False)

    def _track(self, key: str) -> LiveGame:
        previous = self._current_game()
        if previous is not None:
            self._hide_loading(previous, HIDE_NEW_GAME)
        game = LiveGame(
            game_key=key,
            key_ms=game_key_ms(key),
            seen_at=self._clock(),
            prev_key=previous.game_key if previous is not None else None,
        )
        self._games[key] = game
        self._current_key = key
        while len(self._games) > TRACKED_GAMES:
            self._games.popitem(last=False)
        # The next match is starting: an open end card would sit over it.
        self._preempt_visible_card()
        return game

    def _update_game(self, game: LiveGame, envelope: Dict[str, Any], phase: str) -> None:
        players = envelope.get("players")
        if isinstance(players, list):
            # Pulse re-emits carry no ``players``; only real snapshots
            # may change what we know about the roster.
            one_v_one = players_one_v_one(players)
            if one_v_one is not None:
                game.one_v_one = one_v_one
            game.roster_complete = roster_complete(players)
        opponent = envelope.get("opponent")
        if isinstance(opponent, dict):
            name = opponent.get("name")
            if isinstance(name, str) and name.strip():
                norm = normalize_player_name(name)
                if game.opp_norm and norm != game.opp_norm:
                    game.opp_race = None
                game.opp_name = name.strip()
                game.opp_norm = norm
            race = canonical_race(opponent.get("race"))
            if race:
                game.opp_race = race
        user = envelope.get("user")
        if isinstance(user, dict):
            name = user.get("name")
            if isinstance(name, str) and name.strip():
                game.user_name = name.strip()
            race = canonical_race(user.get("race"))
            if race:
                game.my_race = race
        display_time = envelope.get("displayTime")
        if isinstance(display_time, (int, float)) and not isinstance(display_time, bool):
            game.display_time = float(display_time)
        game.phase = phase
        if phase == "match_ended" and isinstance(players, list):
            result = user_result(
                players, user_name=game.user_name, opponent_name=game.opp_name,
            )
            if result:
                game.result = result

    def _handle_leave(self, phase: str, key: Optional[str]) -> None:
        game = self._current_game()
        if game is not None and not game.closed and key in (None, game.game_key):
            game.closed = True
            game.left_at = self._clock()
            if game.phase in ACTIVE_PHASES:
                game.phase = phase
            self._hide_loading(game, HIDE_MENU)
        self._pump_cards()

    def _maybe_carry_pick(self, game: LiveGame) -> None:
        """A re-key of a match the poller briefly lost track of keeps the
        loading-screen pick: the cloud binds the replay to the newest
        record of its own loading screen, so the pick must be on it."""
        if game.carry_checked or not game.opp_norm or game.matchup is None:
            return
        game.carry_checked = True
        prev = self._games.get(game.prev_key) if game.prev_key else None
        if (
            prev is None
            or prev.left_at is None
            or prev.ended_at is not None
            or prev.game_id is not None
            or prev.opp_norm != game.opp_norm
            or prev.matchup != game.matchup
            or game.declared is not None
        ):
            return
        pick = prev.declared or self._declared_elsewhere(prev)
        if pick is None:
            return
        gap = game.seen_at - prev.left_at
        if gap > (REKEY_LOADING_GAP_SEC if game.loading_seen else REKEY_MATCH_GAP_SEC):
            return
        game.declared = pick
        game.declared_synced = False
        game.declare_failed = False
        # Register first: its answer may predate the declare and must never
        # be the newest live state the card sees.
        self._ensure_registered(game)
        self._enqueue_live_op(game, LiveOp("declare", pick.key))
        _log.info("build_checkin_pick_carried loading=%s", game.loading_seen)

    def _handle_active(self, game: LiveGame) -> None:
        card = game.loading
        if card is not None:
            if card.visible:
                blocker = self._loading_blocker(game)
                if blocker is not None:
                    self._hide_loading(game, blocker)
                else:
                    self._sync_loading(game)
        elif self._loading_may_show(game):
            self._show_loading(game)
        self._ensure_scouting(game)
        # After the card's register (its answer carries the current
        # prefs), so three list fetches never queue in front of it.
        self._maybe_prefetch(game.my_race)

    def _loading_blocker(self, game: LiveGame) -> Optional[str]:
        """Why a loading card must not be up right now, if it must not."""
        if not self._loading_allowed():
            return HIDE_DISABLED
        if game.has_random:
            return HIDE_RANDOM
        if game.one_v_one is False or game.identity_unresolvable():
            return HIDE_NOT_1V1
        if game.display_time >= LOADING_CUTOFF_SEC:
            return HIDE_IN_GAME
        return None

    def _loading_may_show(self, game: LiveGame) -> bool:
        if self._loading_blocker(game) is not None or game.human_1v1() is not True:
            return False
        return game.phase == "match_loading" or (
            game.phase == "match_started"
            and game.display_time < LOADING_CUTOFF_SEC
        )

    def _show_loading(self, game: LiveGame) -> None:
        self._preempt_visible_card()
        game.loading = LoadingCard(shown_at=self._clock())
        self._sync_loading(game, show=True)

    def _sync_loading(self, game: LiveGame, *, show: bool = False) -> None:
        if self._prefs.loading_cards:
            self._ensure_registered(game)
            self._ensure_options(game.matchup)
        self._ensure_scouting(game)
        self._render_loading(game, show=show)

    def _render_loading(self, game: LiveGame, *, show: bool = False) -> None:
        card = game.loading
        if (
            card is None
            or not card.visible
            or game.game_key != self._current_key
            or not game.in_progress
        ):
            return
        matchup = game.matchup
        model = loading_model(
            game,
            card,
            options=self._cached_options(matchup),
            options_loading=matchup in self._options_inflight,
            options_failed=matchup in self._options_failed,
            declared_elsewhere=self._declared_elsewhere(game),
            show_intro=not self._intro_seen,
        )
        model = self._with_scouting(model, game)
        if show:
            card.model = model
            self._view_call("show_loading", model)
            _log.info("build_checkin_loading_shown matchup=%s", matchup or "pending")
        elif model != card.model:
            card.model = model
            self._view_call("update_loading", model)

    def _hide_loading(self, game: LiveGame, reason: str) -> None:
        card = game.loading
        if card is None or not card.visible:
            return
        card.visible = False
        card.hidden_reason = reason
        card.model = None
        self._view_call("hide_loading", game.game_key, reason)
        _log.info("build_checkin_loading_hidden reason=%s", reason)

    def _ensure_registered(self, game: LiveGame) -> None:
        """Upsert the live record (and with it the randomizer hold) as soon
        as the card is up, again once the matchup becomes concrete."""
        if self._supported is False or not self._prefs.enabled:
            return
        concrete = game.matchup is not None
        if game.register_count == 0 or (
            concrete
            and not game.registered_with_matchup
            and game.register_count < MAX_REGISTERS
        ):
            game.register_count += 1
            game.registered_with_matchup = concrete
            # Idempotent, so it runs beside the player's writes instead of
            # in front of them; a declare never waits on it.
            self._send_live_op(game, LiveOp("register"))

    def _handle_match_ended(self, game: LiveGame) -> None:
        first = game.ended_at is None
        if first:
            game.ended_at = self._clock()
        self._hide_loading(game, HIDE_MATCH_ENDED)
        self._maybe_open_shell(game)
        if first:
            self._maybe_resend_declaration(game)
        self._pump_cards()
        if first:
            self._handle_refresh_prefs(False)

    def _maybe_open_shell(self, game: LiveGame) -> None:
        """At match end, open the end card for a game not declared at
        loading; it fills in when the replay is accepted."""
        if (
            game.card_id is not None
            or not self._postgame_allowed()
            or game.human_1v1() is not True
            or not game.opp_name
            or self._declared_at_loading(game)
        ):
            return
        card = self._new_card(game)
        card.status = CHECKING_REPLAY
        card.awaiting_replay = True
        self._ensure_options(card.matchup)
        self._refresh_preselection(card)
        self._fetch_live(game)
        self._request_show(card)

    # ================================================================
    # Loading-card actions
    # ================================================================

    def _live_game_for_action(self, game_key: Any) -> Optional[LiveGame]:
        game = self._games.get(game_key) if isinstance(game_key, str) else None
        if game is None or game.game_key != self._current_key or not game.in_progress:
            return None
        return game

    def _handle_declare(self, game_key: Any, build_key: Any) -> None:
        game = self._live_game_for_action(game_key)
        if game is None or not isinstance(build_key, str):
            return
        option = None
        if game.loading is not None:
            option = game.loading.rows.find(build_key)
        if option is None:
            cached = self._cached_options(game.matchup)
            option = cached.find(build_key) if cached is not None else None
        if option is None:
            return
        repick = game.loading is not None and game.loading.changing
        if game.loading is not None:
            game.loading.changing = False
            game.loading.status = ""
        if (
            repick
            and game.declared is not None
            and game.declared.key == option.key
            and not game.declare_failed
        ):
            # Re-picked the standing pick: nothing to write.
            self._render_loading(game)
            return
        game.declared = option.ref
        game.declared_synced = False
        game.declare_failed = False
        self._enqueue_live_op(game, LiveOp("declare", option.key))
        self._render_loading(game)

    def _locked(self, game: LiveGame) -> bool:
        return game.declared is not None or self._declared_elsewhere(game) is not None

    def _handle_undeclare(self, game_key: Any) -> None:
        game = self._live_game_for_action(game_key)
        if game is None:
            return
        card = game.loading
        if card is not None and card.visible:
            # **Change**: reopen the list but keep the pick on the server.
            # Withdrawing it now would let the overlay randomizer spin on
            # stream while the player re-picks; the next row (or Not now)
            # replaces it.
            if self._locked(game):
                card.changing = True
                card.status = ""
                self._render_loading(game)
            return
        self._withdraw_declaration(game)
        self._render_loading(game)

    def _withdraw_declaration(self, game: LiveGame) -> None:
        game.declared = None
        game.declared_synced = False
        game.declare_failed = False
        if game.loading is not None:
            game.loading.changing = False
            game.loading.status = ""
        self._enqueue_live_op(game, LiveOp("undeclare"))

    def _handle_roll_now(self, game_key: Any) -> None:
        game = self._live_game_for_action(game_key)
        if (game is None or game.randomizer_request_inflight or not game.matchup or self._locked(game)
                or (game.live is not None and game.live.randomizer is not None)):
            return
        game.randomizer_request_inflight = True
        if game.loading is not None:
            game.loading.status = ""
        self._enqueue_live_op(game, LiveOp("randomize"))
        self._render_loading(game)

    def _handle_not_now(self, game_key: Any) -> None:
        game = self._live_game_for_action(game_key)
        if game is None:
            return
        if game.loading is not None and game.loading.changing and self._locked(game):
            # Not now over a standing pick withdraws it. The pick already
            # released the hold, so there is nothing else to release.
            game.released = True
            self._withdraw_declaration(game)
        self._release_hold(game)
        self._hide_loading(game, HIDE_DISMISSED)

    def _release_hold(self, game: LiveGame) -> None:
        """Let the overlay randomizer spin now instead of at hold expiry."""
        if game.released or game.declared is not None:
            return
        game.released = True
        self._enqueue_live_op(game, LiveOp("release"))

    # ================================================================
    # Live record I/O
    # ================================================================

    def _enqueue_live_op(self, game: LiveGame, op: LiveOp) -> None:
        # Writes to one record go out one at a time, in order. Successive
        # declare/undeclare clicks collapse to the last one.
        if (
            op.action in ("declare", "undeclare")
            and game.ops
            and game.ops[-1].action in ("declare", "undeclare")
        ):
            game.ops[-1] = op
        else:
            game.ops.append(op)
        self._run_live_ops(game)

    def _run_live_ops(self, game: LiveGame) -> None:
        if game.op_inflight is not None or not game.ops:
            return
        op = game.ops.popleft()
        game.op_inflight = op
        self._send_live_op(game, op)

    def _send_live_op(self, game: LiveGame, op: LiveOp) -> None:
        if op.action == "randomize":
            self._call(self._on_live_write, (game.game_key, game.next_gen(), op),
                       self._api.roll_live_randomizer, game.game_key, game.matchup)
            return
        body: Dict[str, Any] = {"action": op.action}
        if op.action == "declare":
            body["buildKey"] = op.build_key
        if op.action == "register":
            # The cloud tells this match's own loading-screen record from a
            # re-key by it.
            body["phase"] = "match_loading" if game.loading_seen else "match_started"
        if op.action in ("register", "declare"):
            # Every declare carries the races so it never depends on the
            # register write having landed first.
            if game.my_race:
                body["myRace"] = game.my_race
            if game.opp_race:
                body["oppRace"] = game.opp_race
            if game.opp_name:
                body["oppName"] = game.opp_name
        self._call(
            self._on_live_write,
            (game.game_key, game.next_gen(), op),
            self._api.put_live_intent,
            game.game_key,
            body,
            attempts=DECLARE_ATTEMPTS if op.action == "declare" else 1,
        )

    def _on_live_write(
        self,
        tag: Tuple[str, int, LiveOp],
        value: Any,
        error: Optional[BaseException],
    ) -> None:
        key, gen, op = tag
        game = self._games.get(key)
        if game is None:
            return
        if game.op_inflight is op:
            game.op_inflight = None
        if op.action == "randomize":
            game.randomizer_request_inflight = False
        mine = (
            op.action == "declare"
            and game.declared is not None
            and game.declared.key == op.build_key
        )
        if error is not None:
            failure = _Failure(error)
            _log.warning(
                "build_checkin_live_write_failed action=%s status=%s code=%s",
                op.action, failure.status, failure.code,
            )
            if failure.code == "already_bound" and failure.game_id:
                self._bind_game(game, failure.game_id)
            if op.action in {"release", "randomize"} and game.game_id is None and not self._locked(game):
                if game.loading is not None and not (game.live and game.live.randomizer):
                    game.loading.status = {
                        "randomizer_disabled": "Randomizer is off for this matchup. Enable it in Randomizer settings.",
                        "unknown_build": "No available builds remain in this pool. Update Randomizer settings and try again.",
                        "pool_changed": "The pool changed while choosing. Try Randomize again.",
                        "stale_game": "This match is no longer current. Wait for the next match.",
                    }.get(failure.code, STATUS_RANDOMIZER_REQUEST_FAILED)
            if mine:
                if failure.code == "unknown_build":
                    game.declared = None
                    status = STATUS_DECLARE_UNAVAILABLE
                else:
                    # Keep the pick locally: the end card offers it again.
                    game.declare_failed = True
                    status = STATUS_DECLARE_OFFLINE
                if game.loading is not None:
                    game.loading.status = status
                if game.phase == "match_ended":
                    self._maybe_open_shell(game)
                    self._maybe_resend_declaration(game)
        else:
            if op.action in {"release", "randomize"} and game.loading is not None and game.loading.status == STATUS_RANDOMIZER_REQUEST_FAILED:
                game.loading.status = ""
            if mine:
                game.declared_synced = True
                game.declare_failed = False
                _log.info("build_checkin_declared")
            state = parse_live_state(value, key)
            if op.action == "randomize":
                if state is not None and state.randomizer is not None:
                    game.released = True
                elif game.loading is not None:
                    game.loading.status = STATUS_RANDOMIZER_REQUEST_FAILED
            if state is not None:
                self._apply_live_state(game, state, gen)
        self._run_live_ops(game)
        self._render_loading(game)

    def _fetch_live(self, game: LiveGame) -> None:
        if self._supported is False:
            return
        if game.live_read_inflight:
            game.live_refetch = True
            return
        game.live_read_inflight = True
        self._call(
            self._on_live_read,
            (game.game_key, game.next_gen()),
            self._api.get_live_intent,
            game.game_key,
        )

    def _on_live_read(
        self,
        tag: Tuple[str, int],
        value: Any,
        error: Optional[BaseException],
    ) -> None:
        key, gen = tag
        game = self._games.get(key)
        if game is None:
            return
        game.live_read_inflight = False
        if error is None:
            state = parse_live_state(value, key)
            if state is not None:
                self._apply_live_state(game, state, gen)
        elif _Failure(error).status != 404:
            _log.debug("build_checkin_live_read_failed")
        if game.live_refetch:
            game.live_refetch = False
            self._fetch_live(game)

    def _apply_live_state(self, game: LiveGame, state: LiveState, gen: int) -> None:
        if gen < game.live_applied_gen:
            return  # an older request answered after a newer one
        game.live_applied_gen = gen
        game.live = state
        if state.randomizer is not None and game.loading is not None and game.loading.status == STATUS_RANDOMIZER_REQUEST_FAILED:
            game.loading.status = ""
        if state.prefs is not None:
            self._apply_state_prefs(state.prefs)
        if state.game_id:
            self._bind_game(game, state.game_id)
        if not game.writing:
            server = state.declared
            if server is None:
                if game.declared_synced:
                    # Undeclared elsewhere since our pick landed.
                    game.declared = None
                    game.declared_synced = False
            elif game.declared is None or game.declared.key != server.key:
                if game.declared is not None:
                    # A newer pick from the web replaces ours.
                    game.declared = None
                    game.declared_synced = False
                    game.declare_failed = False
            else:
                game.declared_synced = True
                game.declare_failed = False
        self._render_loading(game)
        card = self._cards.get(game.card_id) if game.card_id else None
        if card is not None and card.undecided:
            card.local_declared = game.declared
            self._refresh_preselection(card)
            self._render_card(card)

    def _bind_game(self, game: LiveGame, game_id: str) -> None:
        game.game_id = game.game_id or game_id
        card = self._cards.get(game.card_id) if game.card_id else None
        if card is not None:
            self._bind_card(card, game.game_id)

    def _bind_card(self, card: PostgameCard, game_id: str) -> None:
        if card.game_id is None:
            card.game_id = game_id
        if card.flush_pending:
            card.flush_pending = False
            self._flush_notes(card)

    def _maybe_resend_declaration(self, game: LiveGame) -> None:
        """Deliver a loading-screen pick the declare never got through.

        The end card normally carries it (it pre-selects the pick). With
        after-game cards off nothing would, although the loading card
        promised to confirm the pick after the game: send it as the
        game's answer instead, on the live record until the replay is
        bound and on the game after.
        """
        declared = game.declared
        if (
            declared is None
            or not game.declare_failed
            or game.resend_inflight
            or game.ended_at is None
            or game.card_id is not None
            or self._postgame_allowed()
            or self._supported is False
            or not self._prefs.enabled
        ):
            return
        game.resend_inflight = True
        tag = (game.game_key, declared.key)
        if game.game_id is not None:
            self._call(
                self._on_declaration_resent, tag,
                self._api.put_game_intent, game.game_id,
                {"action": "confirm", "buildKey": declared.key},
            )
        else:
            # ``postgame``, not ``declare``: the declare window closed
            # with the match.
            self._call(
                self._on_declaration_resent, tag,
                self._api.put_live_intent, game.game_key,
                {"action": "postgame", "buildKey": declared.key},
            )

    def _on_declaration_resent(
        self,
        tag: Tuple[str, str],
        value: Any,
        error: Optional[BaseException],
    ) -> None:
        del value
        key, build_key = tag
        game = self._games.get(key)
        if game is None:
            return
        game.resend_inflight = False
        if game.declared is None or game.declared.key != build_key:
            return
        if error is None:
            game.declare_failed = False
            _log.info("build_checkin_declaration_resent")
            return
        failure = _Failure(error)
        if failure.code == "already_bound" and failure.game_id:
            # The replay got there first: answer on the game itself.
            if game.game_id is None:
                self._bind_game(game, failure.game_id)
            self._maybe_resend_declaration(game)
            return
        _log.warning(
            "build_checkin_declaration_resend_failed status=%s code=%s",
            failure.status, failure.code,
        )
        if failure.code in ("unknown_build", "not_eligible"):
            game.declare_failed = False  # the server will never take it

    # ================================================================
    # Upload accepted → end card
    # ================================================================

    def _handle_accepted(self, game_obj: Any, game_id: Any, row: Dict[str, Any]) -> None:
        with _STATE_SAVE_LOCK:
            api = self._api
            if not self._api_current(api):
                return
            owner_key = row.get("_uploadAccountKey")
            if owner_key is not None:
                base, token = getattr(api, "base_url", None), getattr(api, "device_token", None)
                if (not isinstance(base, str) or not token
                        or owner_key != session_account_key(base.rstrip("/"), token)):
                    return
        previous = self._request_api
        self._request_api = api
        try:
            self._handle_owned_accepted(game_obj, game_id, row)
        finally:
            self._request_api = previous

    def _handle_owned_accepted(self, game_obj, game_id, row):
        if not isinstance(game_id, str) or not game_id or game_id in self._seen_game_ids:
            return
        self._seen_game_ids[game_id] = None
        while len(self._seen_game_ids) > SEEN_GAME_IDS:
            self._seen_game_ids.popitem(last=False)
        fresh = self._check_accepted(game_obj, game_id, row)
        # Records changed: refresh prefs and the matchup lists after the
        # card's own request so the card is never queued behind them.
        # Only a freshly played game forces the lists: re-sync, restores
        # and sweeps ride the same lane in bursts and would otherwise
        # spend the read limit the real game's card needs.
        self._handle_refresh_prefs(False)
        race = canonical_race(getattr(game_obj, "my_race", None))
        if is_concrete_race(race):
            self._prefetched_race = race
            for matchup in matchups_for_race(race):
                self._ensure_options(matchup, force=fresh)

    def _check_accepted(self, game_obj: Any, game_id: str, row: Dict[str, Any]) -> bool:
        """Bind the replay to its live game and fetch the card's state.
        ``True`` when the upload is a game just played (it may change the
        player's records)."""
        reason = accepted_ineligibility(
            game_obj, row, now_ms=int(self._wall_clock() * 1000),
        )
        if reason is not None:
            _log.debug("build_checkin_accept_skipped reason=%s", reason)
            return False
        game = self._match_live_game(game_obj, game_id)
        if game is None:
            _log.debug("build_checkin_accept_skipped reason=no_live_match")
            return True
        self._bind_game(game, game_id)
        card = self._cards.get(game.card_id) if game.card_id else None
        self._bind_scouting_identity(game, card, game_obj)
        if self._supported is False or not self._prefs.enabled:
            return True
        if card is None:
            self._maybe_resend_declaration(game)
            if not self._prefs.ask_after_game:
                return True
        if card is not None and not card.undecided:
            return True  # already answered from the card
        self._fetch_game_state(game_id, include_options=True)
        return True

    def _match_live_game(self, game_obj: Any, game_id: str) -> Optional[LiveGame]:
        opponent = opponent_name_of(game_obj)
        started = game_started_ms(game_obj)
        if not opponent or started is None:
            return None
        candidates = [
            game for game in self._games.values()
            if game.opp_norm == opponent
            and game.key_ms is not None
            and game.game_id in (None, game_id)
            and within_match_window(started, game.key_ms)
        ]
        return closest_by_key_ms(candidates, started) if candidates else None

    def _fetch_game_state(self, game_id: str, *, include_options: bool) -> None:
        gen = self._state_gens.get(game_id, 0) + 1
        self._state_gens[game_id] = gen
        card = self._card_by_game_id(game_id)
        if card is not None:
            card.state_fetching = True
        self._call(
            self._on_game_state,
            (game_id, gen, include_options),
            self._api.get_game_intent,
            game_id,
            include_options=include_options,
        )

    def _on_game_state(
        self,
        tag: Tuple[str, int, bool],
        value: Any,
        error: Optional[BaseException],
    ) -> None:
        game_id, gen, with_lists = tag
        if self._state_gens.get(game_id) != gen:
            return
        game = self._game_by_id(game_id)
        card = self._card_by_game_id(game_id)
        if card is not None:
            card.state_fetching = False
        state = parse_game_intent(value, game_id) if error is None else None
        if card is not None and state is not None and with_lists:
            card.options_stale = False
        if state is None:
            if error is not None:
                _log.info(
                    "build_checkin_game_read_failed status=%s",
                    _Failure(error).status,
                )
            if card is not None and card.undecided and card.awaiting_replay:
                card.awaiting_replay = False
                card.status = STATUS_REPLAY_UNAVAILABLE
                self._render_card(card)
            return
        if state.prefs is not None:
            self._apply_state_prefs(state.prefs)
        self._apply_game_state(game, card, state)

    def _apply_game_state(
        self,
        game: Optional[LiveGame],
        card: Optional[PostgameCard],
        state: GameIntentState,
    ) -> None:
        if card is not None and not card.undecided:
            return
        if not state.eligible or state.status == "none":
            if card is not None:
                self._retire(card, HIDE_NOT_ELIGIBLE, state)
            return
        if state.status == "skipped":
            if card is not None:
                self._retire(card, HIDE_DECIDED, state)
            return
        if state.status == "confirmed":
            planned_at_loading = state.origin == "pregame" or (
                game is not None and self._declared_at_loading(game)
            )
            if not planned_at_loading or state.executed or state.build is None:
                if card is not None:
                    self._retire(card, HIDE_DECIDED, state)
                return
            self._show_state(game, card, state, NOTES_FIRST)
            return
        self._show_state(game, card, state, FULL)

    def _show_state(
        self,
        game: Optional[LiveGame],
        card: Optional[PostgameCard],
        state: GameIntentState,
        variant: str,
    ) -> None:
        created = card is None
        if card is None:
            if game is None or not self._postgame_allowed():
                return
            card = self._new_card(game)
        card.server = self._with_known_lists(card.server, state)
        card.variant = variant
        card.awaiting_replay = False
        if card.status in (CHECKING_REPLAY, STATUS_REPLAY_UNAVAILABLE):
            card.status = ""
        if not card.touched and not card.notes:
            card.notes = state.notes
        card.notes_synced = state.notes
        self._refresh_preselection(card)
        if created:
            self._request_show(card)
        else:
            self._render_card(card)

    def _with_known_lists(
        self,
        previous: Optional[GameIntentState],
        state: GameIntentState,
    ) -> GameIntentState:
        """``state``, keeping the build lists of ``previous`` when this
        read did not ask for them (a ping refresh)."""
        if previous is None:
            return state
        options = state.options if state.options is not None else previous.options
        opponent = state.opponent
        if (
            opponent is not None
            and opponent.options is None
            and previous.opponent is not None
            and previous.opponent.options is not None
        ):
            opponent = replace(opponent, options=previous.opponent.options)
        return replace(state, options=options, opponent=opponent)

    # ================================================================
    # End cards
    # ================================================================

    def _new_card(self, game: LiveGame) -> PostgameCard:
        seq = next(self._card_seq)
        pulse_id = game.opponent_pulse_id or (game.scouting.pulse_id if game.scouting is not None else None)
        private_note = game.scouting.note if game.scouting is not None and game.scouting.pulse_id == pulse_id else ""
        card = PostgameCard(
            card_id=f"checkin-{seq}",
            seq=seq,
            created_at=self._clock(),
            game_key=game.game_key,
            opp_name=game.opp_name,
            my_race=game.my_race,
            opp_race=game.opp_race,
            result=game.result,
            local_declared=game.declared,
            game_id=game.game_id,
            opponent_note=private_note,
            opponent_pulse_id=pulse_id,
        )
        game.card_id = card.card_id
        self._cards[card.card_id] = card
        self._trim_cards()
        return card

    def _trim_cards(self) -> None:
        if len(self._cards) <= MAX_CARDS:
            return
        removable = sorted(
            (
                card for card in self._cards.values()
                if card.card_id != self._visible_card_id
            ),
            key=lambda card: (card.undecided, card.seq),
        )
        for card in removable[: len(self._cards) - MAX_CARDS]:
            del self._cards[card.card_id]
            self._pending_show.discard(card.card_id)
            if card.game_id is not None:
                self._state_gens.pop(card.game_id, None)

    def _card_options(self, card: PostgameCard) -> Optional[BuildOptions]:
        return card.server_options or self._cached_options(card.matchup)

    def _card_roll(self, card: PostgameCard) -> Optional[BuildRef]:
        game = self._game_for_card(card)
        return game.live.randomizer if game is not None and game.live is not None else None

    def _refresh_preselection(self, card: PostgameCard) -> None:
        if card.touched:
            return
        choice = preselection(
            card, roll=self._card_roll(card), options=self._card_options(card),
        )
        card.selection = choice.key
        card.reason = choice.reason
        card.passed_rules = choice.passed_rules
        card.rule_count = choice.rule_count

    def _postgame_model(self, card: PostgameCard) -> Any:
        matchup = card.matchup
        return postgame_model(
            card,
            roll=self._card_roll(card),
            options=self._card_options(card),
            options_loading=card.state_fetching or matchup in self._options_inflight,
            show_intro=not self._intro_seen,
        )

    def _render_card(self, card: PostgameCard) -> None:
        if card.state != CARD_VISIBLE or card.card_id != self._visible_card_id:
            return
        model = self._postgame_model(card)
        if model != card.model:
            card.model = model
            self._view_call("update_postgame", model)

    def _request_show(self, card: PostgameCard) -> None:
        """Show now, or wait for the window and for the game to end."""
        if not card.undecided or not self._postgame_allowed():
            return
        visible = self._visible_card_id
        if self._game_in_progress() or (visible is not None and visible != card.card_id):
            self._pending_show.add(card.card_id)
            return
        self._show_card(card)

    def _show_card(self, card: PostgameCard) -> None:
        card.state = CARD_VISIBLE
        card.reshow_pending = False
        card.last_activity = self._clock()
        self._visible_card_id = card.card_id
        self._pending_show.discard(card.card_id)
        model = self._postgame_model(card)
        card.model = model
        self._view_call("show_postgame", model)
        _log.info(
            "build_checkin_postgame_shown variant=%s matchup=%s",
            card.variant, card.matchup or "pending",
        )

    def _hide_card(self, card: PostgameCard, reason: str, *, done: bool) -> None:
        if self._visible_card_id == card.card_id:
            self._visible_card_id = None
            self._view_call("hide_postgame", card.card_id, reason)
            _log.info("build_checkin_postgame_hidden reason=%s", reason)
        card.model = None
        card.state = CARD_DONE if done else CARD_HIDDEN
        if done:
            self._pending_show.discard(card.card_id)
            card.reshow_pending = False

    def _set_aside(self, card: PostgameCard, reason: str) -> None:
        """Hide undecided with the draft kept; notes go to the server as
        soon as the game is known."""
        self._hide_card(card, reason, done=False)
        if (
            card.opp_saved is not None
            and card.opp_touched
            and (card.opp_selection,) == card.opp_saved
        ):
            self._release_opponent_draft(card)
        self._flush_notes(card)

    def _retire(
        self,
        card: PostgameCard,
        reason: str,
        state: Optional[GameIntentState] = None,
    ) -> None:
        """The game no longer needs this card (decided or ineligible).

        A draft is still saved, but never over notes the server already
        holds (typed on the website, say), nor over an opponent's build
        the server changed since the card's was picked.
        """
        if state is not None:
            card.notes_synced = state.notes
            if state.notes:
                card.notes = state.notes
            if reason == HIDE_DECIDED:
                self._flush_opponent_draft(card, state)
        self._flush_notes(card)
        self._hide_card(card, reason, done=True)
        self._pump_cards()

    def _preempt_visible_card(self) -> None:
        card = self._visible_card()
        if card is None:
            return
        self._set_aside(card, HIDE_PREEMPTED)
        if card.touched and card.reshows == 0:
            # Once more after the next match; then the web queue has it.
            card.reshow_pending = True
            card.preempted_at = self._clock()
            self._pending_show.add(card.card_id)

    def _waited_too_long(self, card: PostgameCard, now: float) -> bool:
        if card.reshow_pending:
            # Due once the next match ends, however long that match ran.
            return (
                card.preempted_at is not None
                and now - card.preempted_at > RESHOW_MAX_WAIT_SEC
            )
        return now - card.created_at > PENDING_CARD_MAX_AGE_SEC

    def _pump_cards(self) -> None:
        """Fill a free window with the newest card that is waiting."""
        if (
            self._visible_card_id is not None
            or self._game_in_progress()
            or not self._postgame_allowed()
        ):
            return
        now = self._clock()
        waiting = sorted(
            (self._cards[card_id] for card_id in self._pending_show if card_id in self._cards),
            key=lambda card: card.seq,
            reverse=True,
        )
        self._pending_show.intersection_update(self._cards)
        for card in waiting:
            if not card.undecided or self._waited_too_long(card, now):
                self._pending_show.discard(card.card_id)
                card.reshow_pending = False
                continue
            if card.reshow_pending:
                card.reshow_pending = False
                card.reshows += 1
            self._show_card(card)
            return

    def _card_for_action(self, card_id: Any) -> Optional[PostgameCard]:
        card = self._cards.get(card_id) if isinstance(card_id, str) else None
        return card if card is not None and card.undecided else None

    def _handle_interacted(self, card_id: Any) -> None:
        card = self._card_for_action(card_id)
        if card is None:
            return
        card.touched = True
        card.last_activity = self._clock()

    def _note_opponent(self, card: PostgameCard, opponent: Any) -> bool:
        """Take the view's opponent row; ``True`` when it changed."""
        if opponent is _KEEP:
            return False
        key = opponent if isinstance(opponent, str) and opponent else None
        if card.opp_touched and card.opp_selection == key:
            return False
        if not card.opp_touched:
            opp = card.server.opponent if card.server is not None else None
            card.opp_base = (opp.effective_key if opp is not None else None,)
        card.opp_touched = True
        card.opp_selection = key
        card.opp_saved = None
        return True

    def _release_opponent_draft(self, card: PostgameCard) -> None:
        """The server holds the card's opponent pick: the row follows the
        server again (and a later correction on the website)."""
        card.opp_touched = False
        card.opp_selection = None
        card.opp_base = None
        card.opp_saved = None
        if card.undecided and card.game_id is not None:
            self._fetch_game_state(card.game_id, include_options=card.options_stale)

    def _flush_opponent_draft(self, card: PostgameCard, state: GameIntentState) -> None:
        opp = state.opponent
        if opp is None or not card.opp_touched or card.opp_base != (opp.effective_key,):
            return
        change = opponent_change(
            card.opp_selection,
            server_key=opp.effective_key,
            corrected=opp.corrected,
            replay_key=opp.detected_key,
        )
        if change is not None:
            self._queue_opponent_write(card, change[0])

    def _queue_opponent_write(self, card: PostgameCard, key: Optional[str]) -> None:
        card.ops.append(CardOp(
            "opponent",
            send_opponent=True,
            opponent_key=key,
            opponent_draft=(card.opp_selection,),
        ))
        self._run_card_ops(card)

    def _handle_update_draft(
        self,
        card_id: Any,
        build_key: Any,
        notes: Any,
        opponent: Any = _KEEP,
    ) -> None:
        card = self._card_for_action(card_id)
        if card is None:
            return
        card.touched = True
        card.last_activity = self._clock()
        card.selection = build_key if isinstance(build_key, str) and build_key else None
        card.notes = sanitize_notes(notes)
        if self._note_opponent(card, opponent):
            self._render_card(card)  # the row's label and "changed" mark

    def _handle_confirm(
        self,
        card_id: Any,
        build_key: Any,
        notes: Any,
        opponent: Any = _KEEP,
    ) -> None:
        card = self._card_for_action(card_id)
        if card is None or card.busy or not isinstance(build_key, str) or not build_key:
            return
        card.touched = True
        card.last_activity = self._clock()
        card.selection = build_key
        card.notes = sanitize_notes(notes)
        self._note_opponent(card, opponent)
        change = opponent_write(card)
        server = card.server
        if (
            card.variant == NOTES_FIRST
            and server is not None
            and server.build is not None
            and build_key == server.build.key
        ):
            # "Done": the declaration stands; the notes and the opponent's
            # build may be new.
            new_notes = card.notes != (card.notes_synced or "")
            if change is not None:
                self._start_write(card, CardOp(
                    "opponent",
                    notes=card.notes if new_notes else None,
                    final=True,
                    send_opponent=True,
                    opponent_key=change[0],
                ))
            elif new_notes:
                self._start_write(card, CardOp("notes", notes=card.notes, final=True))
            else:
                self._hide_card(card, HIDE_CONFIRMED, done=True)
                self._pump_cards()
            return
        self._start_write(card, CardOp(
            "confirm",
            build_key=build_key,
            notes=self._notes_for_write(card),
            final=True,
            send_opponent=change is not None,
            opponent_key=change[0] if change is not None else None,
        ))

    def _handle_no_set_build(self, card_id: Any, notes: Any, opponent: Any = _KEEP) -> None:
        card = self._card_for_action(card_id)
        if card is None or card.busy:
            return
        card.touched = True
        card.last_activity = self._clock()
        card.notes = sanitize_notes(notes)
        self._note_opponent(card, opponent)
        change = opponent_write(card)
        self._start_write(card, CardOp(
            "skip",
            notes=self._notes_for_write(card),
            final=True,
            send_opponent=change is not None,
            opponent_key=change[0] if change is not None else None,
        ))

    def _handle_add_build(self, card_id: Any, side: Any) -> None:
        card = self._card_for_action(card_id)
        if (
            card is None
            or card.busy
            or not isinstance(side, str)
            or side not in BUILD_SIDES
            or card.game_id is None
            or card.card_id != self._visible_card_id
            or self._game_in_progress()
        ):
            # A click that raced the next match's loading screen must
            # never put a browser over the game.
            return
        self._background(
            self._open_url, new_build_url(self._dashboard_url, card.game_id, side),
        )
        _log.info("build_checkin_add_build side=%s", side)
        # The player is about to save a build: every list that could
        # show it is out of date, the agent's own cache included.
        card.options_stale = True
        if card.matchup:
            self._options.pop(card.matchup, None)
        if side == "opponent":
            # The web owns the opponent's build now: the row follows
            # what it saves, never an older pick from this card.
            card.opp_touched = False
            card.opp_selection = None
            card.opp_base = None
            card.opp_saved = None
        else:
            # A confirm on the web leaves the opponent's build alone and
            # retires this card, so a corrected one is saved first.
            change = opponent_write(card)
            if change is not None:
                self._queue_opponent_write(card, change[0])
        # Out of the browser's way. The draft stays; a confirm on the web
        # retires the card through its ping, and the tray brings it back.
        card.reshow_pending = False
        self._pending_show.discard(card.card_id)
        self._set_aside(card, HIDE_OPENED_WEB)

    def _handle_later(self, card_id: Any, notes: Any) -> None:
        card = self._card_for_action(card_id)
        if card is None:
            return
        card.notes = sanitize_notes(notes)
        card.reshow_pending = False
        self._pending_show.discard(card.card_id)
        self._set_aside(card, HIDE_LATER)
        self._pump_cards()

    def _notes_for_write(self, card: PostgameCard) -> Optional[str]:
        """Send notes when there are some, or when clearing known ones."""
        if card.notes or card.notes_synced:
            return card.notes
        return None

    def _start_write(self, card: PostgameCard, op: CardOp) -> None:
        card.busy = True
        card.status = ""
        self._render_card(card)
        card.ops.append(op)
        self._run_card_ops(card)

    def _flush_notes(self, card: PostgameCard) -> None:
        on_the_way = [
            op.notes for op in (card.op_inflight, *card.ops)
            if op is not None and op.notes is not None
        ]
        latest = on_the_way[-1] if on_the_way else (card.notes_synced or "")
        if card.notes == latest:
            return
        if card.game_id is None:
            card.flush_pending = True
            return
        card.ops.append(CardOp("notes", notes=card.notes))
        self._run_card_ops(card)

    def _run_card_ops(self, card: PostgameCard) -> None:
        while card.op_inflight is None and card.ops:
            op = card.ops.popleft()
            if card.game_id is not None:
                body: Dict[str, Any] = {"action": op.action}
                if op.build_key:
                    body["buildKey"] = op.build_key
                if op.notes is not None:
                    body["notes"] = op.notes
                if op.send_opponent:
                    body["opponentBuildKey"] = op.opponent_key
                card.op_inflight = op
                self._call(
                    self._on_card_write, (card.card_id, op),
                    self._api.put_game_intent, card.game_id, body,
                )
            elif op.action in ("confirm", "skip") and card.game_key:
                # Before ingest the answer waits on the live record and
                # the server applies it when it binds the replay.
                body = {"action": "postgame"}
                if op.action == "confirm":
                    body["buildKey"] = op.build_key
                else:
                    body["skip"] = True
                if op.notes:
                    body["notes"] = op.notes
                card.op_inflight = op
                self._call(
                    self._on_card_write, (card.card_id, op),
                    self._api.put_live_intent, card.game_key, body,
                )
            elif op.final:
                card.busy = False
                card.status = STATUS_SAVE_FAILED
                self._render_card(card)
            else:
                # Notes need the game; they go out once it is known.
                card.flush_pending = True

    def _on_card_write(
        self,
        tag: Tuple[str, CardOp],
        value: Any,
        error: Optional[BaseException],
    ) -> None:
        del value
        card_id, op = tag
        card = self._cards.get(card_id)
        if card is None:
            return
        if card.op_inflight is op:
            card.op_inflight = None
        if error is not None:
            failure = _Failure(error)
            _log.warning(
                "build_checkin_save_failed action=%s status=%s code=%s",
                op.action, failure.status, failure.code,
            )
            if failure.code == "already_bound" and failure.game_id:
                # The replay was bound while the card was open: same
                # answer, game route. The upload's acceptance may already
                # have bound the card while this write was out.
                if card.game_id is None:
                    game = self._game_for_card(card)
                    if game is not None:
                        self._bind_game(game, failure.game_id)
                    self._bind_card(card, failure.game_id)
                card.ops.appendleft(op)
            elif op.final:
                card.busy = False
                if failure.code == "not_eligible":
                    self._retire(card, HIDE_NOT_ELIGIBLE)
                    return
                card.status = _SAVE_ERRORS.get(failure.code or "", STATUS_SAVE_FAILED)
                self._render_card(card)
            self._run_card_ops(card)
            return
        if op.notes is not None:
            card.notes_synced = op.notes
        if (
            op.opponent_draft is not None
            and card.opp_touched
            and (card.opp_selection,) == op.opponent_draft
        ):
            # Saved, and not re-picked meanwhile: follow the server from
            # here so a later correction on the web is never undone. A card
            # on screen keeps showing the pick until it steps aside.
            if card.state == CARD_VISIBLE:
                card.opp_saved = op.opponent_draft
            else:
                self._release_opponent_draft(card)
        if op.opponent_draft is not None and card.opp_touched:
            # The server holds the hand-off pick now: a later change on the
            # card is judged against it, not against what the card first saw.
            opp = card.server.opponent if card.server is not None else None
            held = op.opponent_key
            if held is None and opp is not None:
                held = opp.detected_key
            card.opp_base = (held,)
            if card.undecided and card.game_id is not None and not card.busy:
                self._fetch_game_state(card.game_id, include_options=card.options_stale)
        if op.final:
            card.busy = False
            if op.action in ("confirm", "skip"):
                # The matchup's W-L just changed.
                matchup = card.matchup
                if matchup:
                    self._options.pop(matchup, None)
                _log.info("build_checkin_saved action=%s", op.action)
            self._hide_card(
                card,
                HIDE_SKIPPED if op.action == "skip" else HIDE_CONFIRMED,
                done=True,
            )
            self._pump_cards()
        self._run_card_ops(card)

    # ================================================================
    # Socket pings
    # ================================================================

    def _handle_ping(self, ping: Dict[str, Any]) -> None:
        if ping.get("prefs") is True:
            # Changed on the website (or another device): follow it now,
            # not at the next match end.
            self._handle_refresh_prefs(True)
        key = ping.get("gameKey")
        if isinstance(key, str):
            game = self._games.get(key)
            if game is not None and (
                game.game_key == self._current_key
                or (
                    game.ended_at is not None
                    and self._clock() - game.ended_at < LIVE_PING_MAX_AGE_SEC
                )
            ):
                self._fetch_live(game)
        game_id = ping.get("gameId")
        if isinstance(game_id, str):
            card = self._card_by_game_id(game_id)
            if (
                card is not None
                and card.undecided
                and not card.busy
                and card.op_inflight is None
            ):
                self._fetch_game_state(
                    game_id,
                    include_options=card.server_options is None or card.options_stale,
                )

    # ================================================================
    # Options
    # ================================================================

    def _ensure_options(self, matchup: Optional[str], *, force: bool = False) -> None:
        if (
            not matchup
            or self._supported is False
            or not self._prefs.enabled
            or matchup in self._options_inflight
        ):
            return
        entry = self._options.get(matchup)
        if entry is not None and not force and self._clock() - entry[0] < OPTIONS_TTL_SEC:
            return
        self._options_inflight.add(matchup)
        self._call(
            self._on_options, matchup, self._api.get_build_options, matchup,
        )

    def _on_options(self, matchup: str, value: Any, error: Optional[BaseException]) -> None:
        self._options_inflight.discard(matchup)
        options = parse_build_options(value) if error is None else None
        if options is None:
            _log.debug("build_checkin_options_failed matchup=%s", matchup)
            self._options_failed.add(matchup)
        else:
            self._options_failed.discard(matchup)
            self._options[matchup] = (self._clock(), replace(options, matchup=matchup))
        game = self._current_game()
        if game is not None and game.matchup == matchup:
            self._render_loading(game)
        for card in self._cards.values():
            if card.undecided and card.matchup == matchup and card.server_options is None:
                self._refresh_preselection(card)
                self._render_card(card)

    def _maybe_prefetch(self, race: Optional[str]) -> None:
        if (
            not is_concrete_race(race)
            or race == self._prefetched_race
            or self._supported is False
            or not self._prefs.enabled
        ):
            return
        self._prefetched_race = race
        for matchup in matchups_for_race(race):
            self._ensure_options(matchup)

    # ================================================================
    # Preferences
    # ================================================================

    def _handle_refresh_prefs(self, force: bool) -> None:
        now = self._clock()
        if self._prefs_read_inflight:
            if force:
                # The read on its way may predate the change (a ping from
                # the website): read once more when it lands.
                self._prefs_reread = True
            return
        if (
            not force
            and self._prefs_read_at is not None
            and now - self._prefs_read_at < PREFS_REFRESH_MIN_SEC
        ):
            return
        self._prefs_read_inflight = True
        self._prefs_read_at = now
        self._call(self._on_prefs_read, None, self._api.get_checkin_prefs)

    def _on_prefs_read(self, _tag: Any, value: Any, error: Optional[BaseException]) -> None:
        self._prefs_read_inflight = False
        if self._prefs_reread and not (error is not None and _Failure(error).status == 404):
            # Superseded: its answer may be older than the change.
            self._prefs_reread = False
            self._handle_refresh_prefs(True)
            return
        self._prefs_reread = False
        if error is not None:
            if _Failure(error).status == 404:
                # This API predates build check-in: stay dormant.
                self._set_supported(False)
            elif self._supported is None:
                self._schedule_prefs_retry()
            return
        prefs = parse_prefs(value)
        if prefs is None:
            return
        self._prefs_failures = 0
        self._prefs_retry_at = None
        previous_prefs = self._prefs
        self._apply_server_prefs(prefs)
        self._set_supported(True, notify_prefs=self._prefs == previous_prefs)

    def _schedule_prefs_retry(self) -> None:
        """No answer yet this session (offline at login): try again soon,
        then less often. Meanwhile the cards follow the last preference
        the server confirmed in an earlier session."""
        delay = PREFS_RETRY_SEC[min(self._prefs_failures, len(PREFS_RETRY_SEC) - 1)]
        self._prefs_failures += 1
        self._prefs_retry_at = self._clock() + delay
        # Once at INFO; an agent left offline would repeat it every minute.
        _log.log(
            logging.INFO if self._prefs_failures == 1 else logging.DEBUG,
            "build_checkin_prefs_read_retry in_sec=%d", int(delay),
        )

    def _set_supported(self, supported: bool, *, notify_prefs: bool = True) -> None:
        self._prefs_retry_at = None  # the server answered
        if self._supported == supported:
            return
        self._supported = supported
        _log.info("build_checkin_available=%s", supported)
        if supported and notify_prefs:
            # The view learns the loaded value even when it equals the
            # defaults it started with.
            self._view_call("update_prefs", self._prefs)
        self._enforce_prefs()

    def _apply_state_prefs(self, prefs: CheckinPrefs) -> None:
        """Preferences riding on a live or game state. The request may have
        left before a save landed, so a value that differs from the last
        confirmed one is read again instead of applied."""
        if prefs == self._prefs_confirmed:
            return
        if self._prefs_confirmed is None:
            self._apply_server_prefs(prefs)
        else:
            self._handle_refresh_prefs(True)

    def _apply_server_prefs(self, prefs: CheckinPrefs) -> None:
        self._prefs_confirmed = prefs
        self._remember_prefs(prefs)
        if self._prefs_write_inflight or self._prefs_write_pending is not None:
            # The player's newer choice is on its way to the server; this
            # answer may still hold a change from elsewhere: read again
            # once the saves are done.
            self._prefs_read_during_write = True
            return
        self._apply_prefs(prefs)

    def _remember_prefs(self, prefs: CheckinPrefs) -> None:
        """Persist a newly confirmed preference for the next start."""
        if self._on_prefs_changed is None or prefs == self._prefs_remembered:
            return
        self._prefs_remembered = prefs
        self._background(self._on_prefs_changed, prefs)

    def _apply_prefs(self, prefs: CheckinPrefs) -> None:
        if prefs == self._prefs:
            return
        self._prefs = prefs
        self._view_call("update_prefs", prefs)
        self._enforce_prefs()

    def _enforce_prefs(self) -> None:
        game = self._current_game()
        if game is not None and not self._loading_allowed():
            self._hide_loading(game, HIDE_DISABLED)
        elif game is not None:
            if game.loading is None and self._loading_may_show(game):
                self._handle_active(game)
            else:
                self._render_loading(game)
        if not self._postgame_allowed():
            card = self._visible_card()
            if card is not None:
                self._set_aside(card, HIDE_DISABLED)
            self._pending_show.clear()

    def _handle_set_prefs(self, changes: Dict[str, bool]) -> None:
        target = replace(self._prefs, **changes)
        self._prefs_write_pending = target
        self._apply_prefs(target)
        self._run_prefs_write()

    def _run_prefs_write(self) -> None:
        if self._prefs_write_inflight or self._prefs_write_pending is None:
            return
        target, self._prefs_write_pending = self._prefs_write_pending, None
        self._prefs_write_inflight = True
        self._call(
            self._on_prefs_written, target,
            self._api.put_checkin_prefs, target.to_json(),
        )

    def _on_prefs_written(
        self,
        target: CheckinPrefs,
        value: Any,
        error: Optional[BaseException],
    ) -> None:
        self._prefs_write_inflight = False
        if error is not None:
            _log.warning(
                "build_checkin_prefs_save_failed status=%s",
                _Failure(error).status,
            )
            if self._prefs_write_pending is None:
                # Show the player what the server still has.
                self._apply_prefs(self._prefs_confirmed or CheckinPrefs())
        else:
            saved = parse_prefs(value) or target
            if self._prefs_read_inflight:
                # Its answer may predate this save: read once more.
                self._prefs_reread = True
            self._prefs_confirmed = saved
            self._remember_prefs(saved)
            self._set_supported(True)
            if self._prefs_write_pending is None:
                self._apply_prefs(saved)
        self._run_prefs_write()
        if (
            self._prefs_read_during_write
            and not self._prefs_write_inflight
            and self._prefs_write_pending is None
        ):
            self._prefs_read_during_write = False
            self._handle_refresh_prefs(True)

    def _handle_disable(self, which: Any) -> None:
        if which == _LOADING_WHICH:
            game = self._current_game()
            if game is not None and game.loading is not None and game.loading.visible:
                self._release_hold(game)
            self._handle_set_prefs({"ask_at_loading": False})
        elif which == _POSTGAME_WHICH:
            self._handle_set_prefs({"ask_after_game": False})

    # ================================================================
    # Misc actions
    # ================================================================

    def _handle_dismiss_intro(self) -> None:
        if self._intro_seen:
            return
        self._intro_seen = True
        if self._on_intro_dismissed is not None:
            self._background(self._on_intro_dismissed)
        game = self._current_game()
        if game is not None:
            self._render_loading(game)
        card = self._visible_card()
        if card is not None:
            self._render_card(card)

    def _handle_reopen(self) -> None:
        undecided = [card for card in self._cards.values() if card.undecided]
        if self._supported is False or not self._prefs.enabled or not undecided:
            self._background(self._open_url, self._web_queue_url)
            return
        card = max(undecided, key=lambda candidate: candidate.seq)
        visible = self._visible_card()
        if visible is card:
            card.last_activity = self._clock()
            model = self._postgame_model(card)
            card.model = model
            self._view_call("show_postgame", model)
            return
        if visible is not None:
            self._set_aside(visible, HIDE_REPLACED)
        if card.options_stale and card.game_id is not None and not card.busy:
            # Back from the website, maybe with a new build: list it.
            self._fetch_game_state(card.game_id, include_options=True)
        self._show_card(card)

    def _handle_set_view(self, view: Optional[BuildCheckinView]) -> None:
        self._view = view if view is not None else NullView()
        game = self._current_game()
        if game is not None and game.loading is not None and game.loading.visible:
            self._render_loading(game, show=True)
        card = self._visible_card()
        if card is not None:
            self._show_card(card)
        if self._supported:
            self._view_call("update_prefs", self._prefs)


__all__ = [
    "BuildCheckinController",
    "DEFAULT_WEB_QUEUE_URL",
    "Executor",
    "LOADING_CARD_MAX_SEC",
    "LOADING_CUTOFF_SEC",
    "OPTIONS_TTL_SEC",
    "PENDING_CARD_MAX_AGE_SEC",
    "POSTGAME_IDLE_HIDE_SEC",
    "PREFS_RETRY_SEC",
    "RESHOW_MAX_WAIT_SEC",
]
