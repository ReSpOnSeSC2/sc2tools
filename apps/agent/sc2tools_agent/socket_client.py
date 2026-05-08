"""Long-lived Socket.io client.

Lets the cloud push live recompute requests to the agent without the
agent having to poll. Three events the cloud emits today:

  - ``macro:recompute_request``        {gameIds: string[]}
  - ``opp_build_order:recompute_request``  {gameId: string}
  - ``resync:request``                  {reason?: string}

For the per-game events we look the .SC2Replay up by gameId in the
upload state, re-parse it, and push the new payload up — same code
path Resync uses but scoped to one (or a handful of) games.

``resync:request`` is the explicit "rebuild EVERYTHING" signal the
cloud emits when the web app's Map Intel surfaces a "Request resync"
on a user whose existing uploads predate the spatial-extract feature.
We can't infer that from a per-game event because pre-v0.4.x state
files lack the ``path_by_game_id`` reverse index, so any list of
gameIds resolves to zero local files; the dedicated event sidesteps
that by triggering a full upload-queue resync directly.

Auth is the existing device token (the agent's REST bearer). The
cloud joins the socket into the user's room so the events fan-out
to every paired device.

The class is intentionally synchronous-from-outside: callers (the
runner) call ``start()`` once and ``stop()`` on shutdown. Internally
it owns its own asyncio loop on a background thread because
python-socketio's async client is the only one that supports the
``socketio.AsyncClient.connect(retry=True)`` reconnect loop that
keeps us connected through API restarts and dropouts.
"""

from __future__ import annotations

import asyncio
import logging
import threading
from pathlib import Path
from typing import Any, Callable, Dict, List, Optional  # noqa: F401

log = logging.getLogger(__name__)


class SocketClient:
    """Background-thread Socket.io client owning its own asyncio loop."""

    def __init__(
        self,
        *,
        base_url: str,
        device_token: str,
        on_recompute_games: Callable[[List[str]], None],
        on_recompute_opp_build: Callable[[str], None],
        on_full_resync: Optional[Callable[[Optional[str]], None]] = None,
    ) -> None:
        self._base_url = base_url.rstrip("/")
        self._device_token = device_token
        self._on_recompute_games = on_recompute_games
        self._on_recompute_opp_build = on_recompute_opp_build
        # Optional — older callers that pre-date the resync:request event
        # can omit it; the handler is just skipped if not supplied.
        self._on_full_resync = on_full_resync
        self._thread: Optional[threading.Thread] = None
        self._stop = threading.Event()
        # Lazily imported in start() so test environments that don't
        # have python-socketio installed can still load the package.
        self._sio: Any = None
        self._loop: Optional[asyncio.AbstractEventLoop] = None

    def start(self) -> None:
        if self._thread is not None and self._thread.is_alive():
            return
        if not self._device_token:
            log.info("socket_client_skipped reason=no_device_token")
            return
        try:
            import socketio  # type: ignore
        except Exception as exc:  # noqa: BLE001
            log.warning(
                "socket_client_unavailable reason=%s: install python-socketio "
                "to enable live recompute (the agent still works without it; "
                "the user just has to click Resync to apply changes).",
                exc,
            )
            return
        self._stop.clear()
        self._sio = socketio.AsyncClient(reconnection=True, logger=False)
        self._wire_handlers()
        self._thread = threading.Thread(
            target=self._run_forever,
            name="sc2tools-socketio",
            daemon=True,
        )
        self._thread.start()

    def stop(self) -> None:
        self._stop.set()
        sio = self._sio
        loop = self._loop
        if sio is not None and loop is not None:
            try:
                fut = asyncio.run_coroutine_threadsafe(sio.disconnect(), loop)
                fut.result(timeout=2.0)
            except Exception as exc:  # noqa: BLE001
                log.debug("socket_client_disconnect_failed: %s", exc)
        thr = self._thread
        if thr is not None:
            thr.join(timeout=3.0)

    def _wire_handlers(self) -> None:
        sio = self._sio
        assert sio is not None

        @sio.event
        async def connect() -> None:  # noqa: ARG001
            log.info("socket_client_connected base=%s", self._base_url)

        @sio.event
        async def disconnect() -> None:  # noqa: ARG001
            log.info("socket_client_disconnected")

        @sio.on("macro:recompute_request")
        async def _on_macro(payload: Optional[Dict[str, Any]]) -> None:  # noqa: ARG001
            game_ids: List[str] = []
            if isinstance(payload, dict):
                raw = payload.get("gameIds")
                if isinstance(raw, list):
                    game_ids = [str(g) for g in raw if isinstance(g, (str, int))]
            if not game_ids:
                return
            log.info("socket_client_macro_recompute count=%d", len(game_ids))
            try:
                self._on_recompute_games(game_ids)
            except Exception:  # noqa: BLE001
                log.exception("recompute_callback_failed")

        @sio.on("opp_build_order:recompute_request")
        async def _on_opp(payload: Optional[Dict[str, Any]]) -> None:  # noqa: ARG001
            if not isinstance(payload, dict):
                return
            game_id = payload.get("gameId")
            if not isinstance(game_id, str) or not game_id:
                return
            log.info("socket_client_opp_recompute gameId=%s", game_id)
            try:
                self._on_recompute_opp_build(game_id)
            except Exception:  # noqa: BLE001
                log.exception("opp_recompute_callback_failed")

        @sio.on("resync:request")
        async def _on_resync(payload: Optional[Dict[str, Any]]) -> None:  # noqa: ARG001
            # The cloud emits this whenever the user clicks "Request
            # resync" on a Map Intel surface (and any future "rebuild
            # everything" UX). A free-form ``reason`` string may ride
            # along for diagnostics; we log it so the agent log makes
            # the trigger visible without flipping log_level=DEBUG.
            reason: Optional[str] = None
            if isinstance(payload, dict):
                raw = payload.get("reason")
                if isinstance(raw, str) and raw:
                    reason = raw
            log.info(
                "socket_client_full_resync reason=%s",
                reason or "unspecified",
            )
            cb = self._on_full_resync
            if cb is None:
                # Agent boot hasn't wired the callable (older runner).
                # The user-visible button stays in its "requested"
                # state but the agent log shows the event arrived; no
                # crash, no silent error.
                return
            try:
                cb(reason)
            except Exception:  # noqa: BLE001
                log.exception("full_resync_callback_failed")

    def _run_forever(self) -> None:
        """Drive the asyncio client on this thread.

        Owns its own event loop because ``socketio.AsyncClient`` is
        loop-bound — sharing one with the rest of the agent (which is
        synchronous) would force every other subsystem to become
        async-aware.
        """
        loop = asyncio.new_event_loop()
        self._loop = loop
        asyncio.set_event_loop(loop)
        try:
            loop.run_until_complete(self._connect_and_wait())
        except Exception:  # noqa: BLE001
            log.exception("socket_client_loop_failed")
        finally:
            try:
                loop.close()
            except Exception:  # noqa: BLE001
                pass
            self._loop = None

    async def _connect_and_wait(self) -> None:
        sio = self._sio
        assert sio is not None
        # python-socketio's reconnection logic kicks in automatically on
        # disconnect. We loop here mainly to retry the very first
        # connection — if the API is offline at agent startup the
        # auto-reconnect path doesn't engage until the first connect
        # succeeds at least once.
        backoff = 1.0
        while not self._stop.is_set():
            try:
                await sio.connect(
                    self._base_url,
                    auth={"deviceToken": self._device_token},
                    transports=["websocket", "polling"],
                    wait_timeout=10,
                )
                # ``wait()`` returns when the server disconnects us OR
                # when ``disconnect()`` is called from another thread.
                await sio.wait()
                # If we end up here it's because the connection was
                # closed cleanly. Reset backoff so the next disconnect
                # retries quickly.
                backoff = 1.0
            except Exception as exc:  # noqa: BLE001
                log.debug("socket_client_connect_failed attempt: %s", exc)
                if self._stop.is_set():
                    break
                await asyncio.sleep(min(backoff, 30.0))
                backoff = min(backoff * 2.0, 30.0)


def make_recompute_handlers(
    *,
    state_dir: Optional[Path],
    queue_resync_for_paths: Callable[[List[Path]], None],
    full_resync: Optional[Callable[[], None]] = None,
) -> tuple[
    Callable[[List[str]], None],
    Callable[[str], None],
    Callable[[Optional[str]], None],
]:
    """Build the three callbacks SocketClient hands to its event handlers.

    The per-game callbacks translate a gameId-keyed request into a
    "re-parse this file" instruction the existing watcher already
    knows how to act on. Translation hits the agent's persisted
    ``path_by_game_id`` map — populated incrementally on every
    successful upload.

    The ``full_resync`` callable, when provided, runs the same flow
    the GUI's "Re-sync" button does (clear ``state.uploaded`` and
    request a watcher rediscovery). It's invoked directly by
    ``resync:request`` and also as a fallback when ``on_macro``
    resolves zero local files for a bulk request — the bulk-with-zero
    case is the canonical "old agent state, no path_by_game_id"
    signature, and silently skipping it is what made the Map Intel
    "Request resync" feel broken for users with pre-v0.4 uploads.
    """
    # Threshold for the on_macro fallback. The cloud emits a per-game
    # `macro:recompute_request` for single-button "Recompute this game"
    # clicks too — those should NEVER trigger a full resync just because
    # the one game is missing from path_by_game_id (the user may have
    # deleted the .SC2Replay file). 5+ gameIds in one event almost
    # always means the cloud's bulk backfill flow, where a full resync
    # is the right answer when nothing matches locally.
    BULK_THRESHOLD = 5

    def _resolve_paths(game_ids: List[str]) -> List[Path]:
        if not state_dir:
            return []
        try:
            from .state import load_state
            state = load_state(state_dir)
        except Exception as exc:  # noqa: BLE001
            log.debug("recompute_state_load_failed: %s", exc)
            return []
        index: Dict[str, str] = {}
        try:
            raw = getattr(state, "path_by_game_id", {}) or {}
            if isinstance(raw, dict):
                index = {str(k): str(v) for k, v in raw.items()}
        except Exception:  # noqa: BLE001
            index = {}
        out: List[Path] = []
        for gid in game_ids:
            path_str = index.get(gid)
            if not path_str:
                continue
            p = Path(path_str)
            if p.exists():
                out.append(p)
        return out

    def on_macro(game_ids: List[str]) -> None:
        paths = _resolve_paths(game_ids)
        if paths:
            try:
                queue_resync_for_paths(paths)
            except Exception:  # noqa: BLE001
                log.exception("macro_recompute_queue_failed")
            return
        # No local matches. Fall back to a full resync ONLY when the
        # request looks like a bulk backfill (>= BULK_THRESHOLD games
        # asked for) and we have a callable for it. This rescues users
        # whose state.path_by_game_id is empty (older agent versions)
        # without hijacking single-game recomputes.
        if (
            full_resync is not None
            and len(game_ids) >= BULK_THRESHOLD
        ):
            log.info(
                "macro_recompute_bulk_no_matches count=%d falling_back=full_resync",
                len(game_ids),
            )
            try:
                full_resync()
            except Exception:  # noqa: BLE001
                log.exception("macro_recompute_full_resync_failed")
            return
        log.info(
            "macro_recompute_no_local_replays count=%d", len(game_ids),
        )

    def on_opp_build(game_id: str) -> None:
        paths = _resolve_paths([game_id])
        if not paths:
            log.info("opp_recompute_no_local_replay gameId=%s", game_id)
            return
        try:
            queue_resync_for_paths(paths)
        except Exception:  # noqa: BLE001
            log.exception("opp_recompute_queue_failed")

    def on_full_resync(reason: Optional[str]) -> None:
        if full_resync is None:
            log.info(
                "full_resync_request_dropped reason=%s detail=no_callable",
                reason or "unspecified",
            )
            return
        log.info("full_resync_running reason=%s", reason or "unspecified")
        try:
            full_resync()
        except Exception:  # noqa: BLE001
            log.exception("full_resync_callback_failed")

    return on_macro, on_opp_build, on_full_resync
