"""obs-websocket v5 connection wrapper for the Live Game Bridge.

The agent already knows, at 1 Hz, whether the user is in a StarCraft II
match (``live/client_api.py`` → ``LiveLifecyclePhase``). This module is
the other half of the loop: the outbound connection to OBS Studio that
lets ``live/obs_scene.py`` act on that knowledge by switching scenes,
and lets ``live/obs_layout.py`` build the scenes in the first place.

Why a wrapper rather than using ``obsws_python`` directly
---------------------------------------------------------

Three reasons, in order of how much they matter:

1. **Testability.** Every request goes through a named method here, so
   the unit tests inject a fake via ``connect_factory`` and assert on
   *our* vocabulary. No test in this repo needs a running OBS — which
   matters because the agent suite runs on ``windows-latest`` in CI
   with no OBS installed.
2. **Optional dependency.** ``obsws_python`` is imported lazily inside
   ``_connect``. A source install without it degrades to "OBS features
   unavailable" instead of failing at import time and taking the whole
   agent down with it. Same posture the GUI takes with PySide6.
3. **Reconnection.** OBS not being open is the *normal* state, not an
   error. The reconnect loop and its quiet-logging policy live here so
   neither the switcher nor the builder has to think about it.

Threading
---------

One daemon thread owns the connection: it connects, and on failure
sleeps out a backoff and tries again. Callers touch ``_raw`` only
through the request methods, which take ``_lock``. The obsws event
callbacks fire on the library's own thread and are handed straight to
the caller-supplied callback — those callbacks must not block.
"""

from __future__ import annotations

import logging
import threading
import time
from typing import Any, Callable, Dict, List, Optional

from .metrics import METRICS

_log = logging.getLogger("sc2tools_agent.live.obs_client")

DEFAULT_HOST = "127.0.0.1"
# obs-websocket v5's default port. v4 used 4444; we do not support v4 —
# it was removed from OBS in 28.0 (2022) and its auth handshake is
# different enough that supporting both would double this module.
DEFAULT_PORT = 4455
DEFAULT_TIMEOUT_SEC = 5.0

# Reconnect backoff. Starts fast (the user probably just hadn't opened
# OBS yet when the agent booted) and settles at 30 s so a machine that
# never runs OBS costs us one connect attempt every half minute.
BACKOFF_START_SEC = 1.0
BACKOFF_MAX_SEC = 30.0
BACKOFF_FACTOR = 2.0

# Failures before we say anything at INFO. OBS being closed is the
# common case and must not fill agent.log. Matches the posture of
# ``OverlayBackendTransport._record_failure`` in transport.py.
QUIET_FAILURES = 10
LOG_MUTE_SEC = 60.0


class ObsUnavailable(RuntimeError):
    """Raised by request methods when OBS is not currently connected.

    Callers that can meaningfully continue (the switcher, which will
    just try again on the next phase change) catch this. Callers that
    can't (the scene builder, which is a user-initiated one-shot) let
    it propagate so the GUI can show a real error.
    """


class ObsAuthFailed(RuntimeError):
    """Wrong password, or OBS requires one and we sent none.

    Split out from the generic failure path because it is the one
    connection error that will never fix itself by retrying — the
    connection thread stops backing off and waits to be reconfigured.
    """


def _default_connect_factory(
    *, host: str, port: int, password: Optional[str], timeout: float,
) -> Any:
    """Import ``obsws_python`` and open a request client.

    Imported here rather than at module scope so the agent starts
    normally on an install that never added the dependency.
    """
    import obsws_python  # noqa: PLC0415 — deliberate lazy import

    return obsws_python.ReqClient(
        host=host,
        port=port,
        password=password or "",
        timeout=timeout,
    )


def _default_event_factory(
    *, host: str, port: int, password: Optional[str], timeout: float,
) -> Any:
    import obsws_python  # noqa: PLC0415 — deliberate lazy import

    return obsws_python.EventClient(
        host=host,
        port=port,
        password=password or "",
        timeout=timeout,
    )


class ObsClient:
    """Managed obs-websocket v5 connection.

    ``connect_factory`` / ``event_factory`` are the injection seams.
    Production leaves them at the defaults above; tests pass callables
    returning a ``MagicMock``.
    """

    def __init__(
        self,
        *,
        host: str = DEFAULT_HOST,
        port: int = DEFAULT_PORT,
        password: Optional[str] = None,
        connect_factory: Optional[Callable[..., Any]] = None,
        event_factory: Optional[Callable[..., Any]] = None,
        on_connected: Optional[Callable[[], None]] = None,
        on_program_scene_changed: Optional[Callable[[str], None]] = None,
        timeout_sec: float = DEFAULT_TIMEOUT_SEC,
        subscribe_events: bool = True,
    ) -> None:
        self._host = host
        self._port = port
        self._password = password
        self._timeout = timeout_sec
        self._connect_factory = connect_factory or _default_connect_factory
        self._event_factory = event_factory or _default_event_factory
        self._on_connected = on_connected
        self._on_program_scene_changed = on_program_scene_changed
        self._subscribe_events = subscribe_events

        self._raw: Any = None
        self._events: Any = None
        self._lock = threading.RLock()
        self._stop = threading.Event()
        self._thread: Optional[threading.Thread] = None

        self._consecutive_failures = 0
        self._mute_log_until = 0.0
        self._auth_failed = False
        self._last_error: Optional[str] = None

        # Cached on connect so the GUI can populate dropdowns without a
        # round-trip per keystroke. Refreshed by ``refresh_scenes()``.
        self._scene_names: List[str] = []

    # ------------------------------------------------------------------
    # Lifecycle
    # ------------------------------------------------------------------

    def start(self) -> None:
        if self._thread is not None and self._thread.is_alive():
            return
        self._stop.clear()
        self._auth_failed = False
        self._thread = threading.Thread(
            target=self._connect_loop,
            name="sc2tools-obs-client",
            daemon=True,
        )
        self._thread.start()

    def shutdown(self) -> None:
        self._stop.set()
        with self._lock:
            for handle in (self._events, self._raw):
                if handle is None:
                    continue
                try:
                    handle.disconnect()
                except Exception:  # noqa: BLE001 — teardown is best-effort
                    pass
            self._raw = None
            self._events = None
        if self._thread is not None:
            self._thread.join(timeout=2.0)
            self._thread = None

    @property
    def is_connected(self) -> bool:
        with self._lock:
            return self._raw is not None

    @property
    def auth_failed(self) -> bool:
        """True when the last attempt failed on credentials.

        The connection thread parks in this state rather than
        hammering OBS with a password it already knows is wrong.
        """
        return self._auth_failed

    @property
    def last_error(self) -> Optional[str]:
        return self._last_error

    @property
    def scene_names(self) -> List[str]:
        with self._lock:
            return list(self._scene_names)

    def connect_now(self) -> bool:
        """Synchronous single attempt — the GUI's "Test connection".

        Bypasses the backoff loop entirely so a user clicking the
        button gets an answer immediately rather than waiting out
        whatever sleep the background thread happens to be in.
        """
        return self._attempt_connect(raise_on_error=True)

    # ------------------------------------------------------------------
    # Connection thread
    # ------------------------------------------------------------------

    def _connect_loop(self) -> None:
        backoff = BACKOFF_START_SEC
        while not self._stop.is_set():
            if self.is_connected:
                # Nothing to do while healthy. A dropped connection is
                # noticed by a request failing, which clears ``_raw``
                # and lands us back here.
                if self._stop.wait(1.0):
                    return
                continue
            if self._auth_failed:
                # Never retry a known-bad password on a timer. The GUI
                # calls ``reconfigure()`` when the user fixes it, which
                # clears the flag.
                if self._stop.wait(5.0):
                    return
                continue
            ok = self._attempt_connect(raise_on_error=False)
            if ok:
                backoff = BACKOFF_START_SEC
                continue
            if self._stop.wait(backoff):
                return
            backoff = min(BACKOFF_MAX_SEC, backoff * BACKOFF_FACTOR)

    def _attempt_connect(self, *, raise_on_error: bool) -> bool:
        started = time.monotonic()
        try:
            raw = self._connect_factory(
                host=self._host,
                port=self._port,
                password=self._password,
                timeout=self._timeout,
            )
        except Exception as exc:  # noqa: BLE001
            self._record_connect_failure(exc)
            if raise_on_error:
                raise self._classify(exc) from exc
            return False

        with self._lock:
            self._raw = raw
        METRICS.observe_ms(
            "obs.connect.latency", (time.monotonic() - started) * 1000.0,
        )
        METRICS.incr("obs.connect.ok")
        self._consecutive_failures = 0
        self._auth_failed = False
        self._last_error = None
        _log.info(
            "obs_connected host=%s port=%s", self._host, self._port,
        )

        try:
            self.refresh_scenes()
        except Exception:  # noqa: BLE001
            _log.debug("obs_scene_list_refresh_failed", exc_info=True)

        if self._subscribe_events:
            self._attach_events()

        if self._on_connected is not None:
            try:
                self._on_connected()
            except Exception:  # noqa: BLE001
                _log.debug("obs_on_connected_callback_failed", exc_info=True)
        return True

    def _attach_events(self) -> None:
        """Open the event socket for manual-override detection.

        Strictly best-effort. Losing it costs us the ability to notice
        the streamer switching scenes by hand; it does not affect
        auto-switching, so a failure here must never fail the connect.
        """
        if self._on_program_scene_changed is None:
            return
        try:
            events = self._event_factory(
                host=self._host,
                port=self._port,
                password=self._password,
                timeout=self._timeout,
            )
        except Exception:  # noqa: BLE001
            _log.debug("obs_event_client_unavailable", exc_info=True)
            return

        def _on_current_program_scene_changed(data: Any) -> None:
            name = getattr(data, "scene_name", None) or getattr(
                data, "sceneName", None,
            )
            if not name or self._on_program_scene_changed is None:
                return
            try:
                self._on_program_scene_changed(str(name))
            except Exception:  # noqa: BLE001
                _log.debug("obs_scene_changed_callback_failed", exc_info=True)

        try:
            events.callback.register(_on_current_program_scene_changed)
        except Exception:  # noqa: BLE001
            _log.debug("obs_event_register_failed", exc_info=True)
            return
        with self._lock:
            self._events = events

    def _record_connect_failure(self, exc: BaseException) -> None:
        classified = self._classify(exc)
        self._last_error = str(exc) or type(exc).__name__
        with self._lock:
            self._raw = None
        if isinstance(classified, ObsAuthFailed):
            self._auth_failed = True
            METRICS.incr("obs.connect.auth_failed")
            _log.warning(
                "obs_connect_failed host=%s port=%s reason=auth_failed",
                self._host,
                self._port,
            )
            return

        METRICS.incr("obs.connect.refused")
        self._consecutive_failures += 1
        # Quiet until it looks like a real problem rather than "OBS
        # simply isn't open", then at most one line a minute.
        if self._consecutive_failures <= QUIET_FAILURES:
            _log.debug(
                "obs_connect_failed host=%s port=%s attempt=%d err=%s",
                self._host,
                self._port,
                self._consecutive_failures,
                self._last_error,
            )
            return
        now = time.time()
        if now > self._mute_log_until:
            _log.info(
                "obs_connect_failed host=%s port=%s consecutive=%d err=%s "
                "(OBS may not be running, or the WebSocket server is off)",
                self._host,
                self._port,
                self._consecutive_failures,
                self._last_error,
            )
            self._mute_log_until = now + LOG_MUTE_SEC

    @staticmethod
    def _classify(exc: BaseException) -> BaseException:
        """Map a library/transport error onto our two-error vocabulary.

        ``obsws_python`` raises its own exception types, and which one
        signals bad credentials has moved between releases. Matching on
        the message is unlovely but stable across versions, and the
        fallback (treat it as a retryable connection error) is safe.
        """
        text = f"{type(exc).__name__}: {exc}".lower()
        if "auth" in text or "password" in text or "denied" in text:
            return ObsAuthFailed(str(exc))
        return exc

    def reconfigure(
        self,
        *,
        host: Optional[str] = None,
        port: Optional[int] = None,
        password: Optional[str] = None,
    ) -> None:
        """Apply new connection settings and force a reconnect.

        Called from the GUI's Save handler so a corrected password
        takes effect without restarting the agent.
        """
        with self._lock:
            if host is not None:
                self._host = host
            if port is not None:
                self._port = port
            if password is not None:
                self._password = password
            raw, self._raw = self._raw, None
            events, self._events = self._events, None
        for handle in (events, raw):
            if handle is None:
                continue
            try:
                handle.disconnect()
            except Exception:  # noqa: BLE001
                pass
        self._auth_failed = False
        self._consecutive_failures = 0

    # ------------------------------------------------------------------
    # Requests
    #
    # Every one funnels through ``_call`` so a dropped connection is
    # detected in exactly one place.
    # ------------------------------------------------------------------

    def _call(self, method: str, *args: Any, **kwargs: Any) -> Any:
        with self._lock:
            raw = self._raw
        if raw is None:
            raise ObsUnavailable("OBS is not connected")
        fn = getattr(raw, method, None)
        if fn is None:
            raise ObsUnavailable(
                f"obs-websocket client has no request '{method}' — "
                "the installed obsws-python is too old",
            )
        try:
            return fn(*args, **kwargs)
        except Exception as exc:  # noqa: BLE001
            # Any request failure is treated as a lost connection. The
            # connect loop will re-establish it; the alternative
            # (distinguishing "bad request" from "socket died") needs
            # library-specific error types that shift between releases.
            with self._lock:
                # A reconfigure/reconnect may have installed a newer handle
                # while this request was in flight. Only clear and close the
                # connection that actually failed.
                failed_current_connection = self._raw is raw
                if failed_current_connection:
                    self._raw = None
            if failed_current_connection:
                try:
                    raw.disconnect()
                except Exception:  # noqa: BLE001 — teardown is best-effort
                    pass
            METRICS.incr("obs.request.error")
            _log.debug("obs_request_failed method=%s", method, exc_info=True)
            raise ObsUnavailable(f"{method} failed: {exc}") from exc

    def get_version(self) -> Dict[str, Any]:
        resp = self._call("get_version")
        return {
            "obs_version": getattr(resp, "obs_version", None),
            "websocket_version": getattr(resp, "obs_web_socket_version", None),
        }

    def refresh_scenes(self) -> List[str]:
        """Re-read the scene list and cache it.

        OBS returns scenes in reverse display order; we keep its order
        rather than sorting, so a GUI dropdown reads the same way the
        user's Scenes panel does.
        """
        resp = self._call("get_scene_list")
        raw_scenes = getattr(resp, "scenes", None) or []
        names: List[str] = []
        for scene in raw_scenes:
            name = None
            if isinstance(scene, dict):
                name = scene.get("sceneName") or scene.get("scene_name")
            else:
                name = getattr(scene, "sceneName", None) or getattr(
                    scene, "scene_name", None,
                )
            if name:
                names.append(str(name))
        with self._lock:
            self._scene_names = names
        return list(names)

    def current_program_scene(self) -> Optional[str]:
        resp = self._call("get_current_program_scene")
        name = getattr(resp, "current_program_scene_name", None) or getattr(
            resp, "scene_name", None,
        )
        return str(name) if name else None

    def set_current_program_scene(self, name: str) -> None:
        self._call("set_current_program_scene", name)

    def get_video_settings(self) -> Dict[str, Any]:
        resp = self._call("get_video_settings")
        return {
            "base_width": int(getattr(resp, "base_width", 0) or 0),
            "base_height": int(getattr(resp, "base_height", 0) or 0),
        }

    def get_input_list(self, kind: Optional[str] = None) -> List[Dict[str, Any]]:
        resp = self._call("get_input_list", kind) if kind else self._call(
            "get_input_list",
        )
        out: List[Dict[str, Any]] = []
        for item in getattr(resp, "inputs", None) or []:
            if isinstance(item, dict):
                out.append(
                    {
                        "name": item.get("inputName"),
                        "kind": item.get("inputKind"),
                    },
                )
        return [row for row in out if row["name"]]

    def get_input_settings(self, name: str) -> Dict[str, Any]:
        """Return one input's settings as a plain dictionary.

        The scene-upgrade path uses this to identify the manual cover by
        its overlay URL, never by a display name that could collide with a
        source the streamer created themselves.
        """
        resp = self._call("get_input_settings", name)
        settings = getattr(resp, "input_settings", None) or {}
        return dict(settings) if isinstance(settings, dict) else {}

    def get_scene_item_list(self, scene_name: str) -> List[Dict[str, Any]]:
        """Return the scene stack in OBS layer order (bottom to top).

        obs-websocket exposes camelCase dictionaries inside the response;
        normalising them here keeps the layout/repair code independent of
        the client library's response representation.
        """
        resp = self._call("get_scene_item_list", scene_name)
        raw_items = getattr(resp, "scene_items", None) or []
        out: List[Dict[str, Any]] = []
        for raw in raw_items:
            if isinstance(raw, dict):
                source_name = raw.get("sourceName") or raw.get("source_name")
                item_id = raw.get("sceneItemId")
                if item_id is None:
                    item_id = raw.get("scene_item_id")
                index = raw.get("sceneItemIndex")
                if index is None:
                    index = raw.get("scene_item_index")
                input_kind = raw.get("inputKind") or raw.get("input_kind")
                enabled = raw.get("sceneItemEnabled")
                if enabled is None:
                    enabled = raw.get("scene_item_enabled")
                transform = raw.get("sceneItemTransform") or raw.get(
                    "scene_item_transform",
                )
            else:
                source_name = getattr(raw, "source_name", None) or getattr(
                    raw, "sourceName", None,
                )
                item_id = getattr(raw, "scene_item_id", None)
                if item_id is None:
                    item_id = getattr(raw, "sceneItemId", None)
                index = getattr(raw, "scene_item_index", None)
                if index is None:
                    index = getattr(raw, "sceneItemIndex", None)
                input_kind = getattr(raw, "input_kind", None) or getattr(
                    raw, "inputKind", None,
                )
                enabled = getattr(raw, "scene_item_enabled", None)
                if enabled is None:
                    enabled = getattr(raw, "sceneItemEnabled", None)
                transform = getattr(raw, "scene_item_transform", None) or getattr(
                    raw, "sceneItemTransform", None,
                )
            if not source_name or item_id is None:
                continue
            out.append(
                {
                    "source_name": str(source_name),
                    "item_id": int(item_id),
                    "index": int(index or 0),
                    "input_kind": str(input_kind or ""),
                    # Older test doubles and unexpected clients may omit the
                    # field. OBS itself always returns it, and treating an
                    # omission as enabled preserves backward compatibility.
                    "enabled": True if enabled is None else bool(enabled),
                    "transform": (
                        dict(transform) if isinstance(transform, dict) else {}
                    ),
                },
            )
        return sorted(out, key=lambda item: item["index"])

    def create_scene(self, name: str) -> None:
        self._call("create_scene", name)

    def remove_scene(self, name: str) -> None:
        self._call("remove_scene", name)

    def create_scene_item(
        self, *, scene_name: str, source_name: str, enabled: bool = True,
    ) -> int:
        """Add an existing source to a scene. Returns the item id.

        This is what makes the two-scene design free: the same webcam
        or game capture referenced from a second scene is one more
        scene item, not a second capture.
        """
        resp = self._call("create_scene_item", scene_name, source_name, enabled)
        item_id = getattr(resp, "scene_item_id", None)
        return int(item_id) if item_id is not None else 0

    def create_input(
        self,
        *,
        scene_name: str,
        input_name: str,
        input_kind: str,
        settings: Dict[str, Any],
        enabled: bool = True,
    ) -> int:
        resp = self._call(
            "create_input",
            scene_name,
            input_name,
            input_kind,
            settings,
            enabled,
        )
        item_id = getattr(resp, "scene_item_id", None)
        return int(item_id) if item_id is not None else 0

    def set_scene_item_transform(
        self, *, scene_name: str, item_id: int, transform: Dict[str, Any],
    ) -> None:
        self._call("set_scene_item_transform", scene_name, item_id, transform)

    def set_scene_item_index(
        self, *, scene_name: str, item_id: int, index: int,
    ) -> None:
        self._call("set_scene_item_index", scene_name, item_id, index)

    def set_scene_item_enabled(
        self, *, scene_name: str, item_id: int, enabled: bool,
    ) -> None:
        self._call("set_scene_item_enabled", scene_name, item_id, enabled)

    def set_current_scene_transition(self, name: str) -> None:
        self._call("set_current_scene_transition", name)

    def set_current_scene_transition_duration(self, duration_ms: int) -> None:
        self._call("set_current_scene_transition_duration", duration_ms)


__all__ = [
    "DEFAULT_HOST",
    "DEFAULT_PORT",
    "ObsAuthFailed",
    "ObsClient",
    "ObsUnavailable",
]
