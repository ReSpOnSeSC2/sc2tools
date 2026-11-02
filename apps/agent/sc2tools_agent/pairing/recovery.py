"""Replace runtime credentials after confirmed unlinking, retaining work and settings."""
import logging
import threading
import time

from ..api_client import ApiClient
from ..auth_watchdog import AuthWatchdog
from ..state import _STATE_SAVE_LOCK, save_state
from ..sync_retry import replay_ticket, publish_owned_toons, current_identity_source
from .flow import PairingControls, ensure_paired

log = logging.getLogger(__name__)


class RuntimeRecovery:
    def __init__(self, *, cell, cfg, state, ui, stop_event, controls=None):
        self.cell, self.cfg, self.state, self.ui = cell, cfg, state, ui
        self.stop_event = stop_event
        self.controls = controls or PairingControls()
        self._link_lock = threading.Lock()
        self._identity_lock = threading.Lock()
        self._identity_retry_at = 0.0
        self.watchdog = AuthWatchdog(get_api=lambda: cell.api, on_unlinked=self.unlinked)

    def connected(self):
        self.watchdog.success()
        if self.cell.upload:
            self.cell.upload.retry_now()
        self.refresh_unknown_identity()

    def refresh_unknown_identity(self, *, force=False):
        """An offline boot stays fail-closed, then learns this owner's profile
        after contact returns. One bounded background fetch, at most every30s.
        """
        if self.stop_event.is_set() or (not force and time.monotonic() < self._identity_retry_at):
            return
        with _STATE_SAVE_LOCK:
            ticket, api = replay_ticket(self.state), self.cell.api
            if ticket.toons != () or not ticket.token:
                return
        if not self._identity_lock.acquire(blocking=False):
            return
        self._identity_retry_at = time.monotonic() + 30
        started = threading.Event()
        def run():
            started.set()
            try:
                from ..player_handle import refresh_from_cloud
                refresh_from_cloud(api, self.cfg.state_dir, interactive=True,
                    owner=ticket.owner,
                    current_guard=lambda: ticket.current(self.state) and self.cell.api is api and not self.stop_event.is_set(),
                    on_profile=lambda profile: publish_owned_toons(self.state, profile, ticket))
                if ticket.current(self.state) and not self.stop_event.is_set() and replay_ticket(self.state).toons != ():
                    health = getattr(getattr(self.cell, "ui", None), "health", None)
                    if health:
                        health.set_identity(current_identity_source(self.state, self.cfg.state_dir))
                    watcher = getattr(self.cell, "watcher", None)
                    if watcher:
                        watcher.request_immediate_sweep()
            finally:
                self._identity_lock.release()
        try:
            threading.Thread(target=run, name="sc2tools-identity-refresh", daemon=True).start()
        except Exception:
            if not started.is_set():
                self._identity_lock.release()
            # Scheduling is advisory; retain the bounded retry timestamp.

    def unlinked(self):
        socket_client = self.cell.socket_client
        if socket_client and callable(getattr(socket_client, "retire_sync_requests", None)):
            socket_client.retire_sync_requests()
        if self.cell.upload:
            self.cell.upload.hold_auth(True)
        with _STATE_SAVE_LOCK:
            self.state._owner_epoch = object()
            self.state._owned_toons = None
            self.state.device_token = None
            try:
                save_state(self.cfg.state_dir, self.state)
            except OSError:
                log.exception("unlinked_state_save_failed")
        if self.cell.socket_client:
            self.cell.socket_client.stop()
        controller = self.cell.build_checkin
        if controller is not None and callable(getattr(controller, "on_connection_changed", None)):
            controller.on_connection_changed()
        self.ui.on_unlinked()
        if not self.cell.gui:
            self.link_again()

    def link_again(self):
        if not self._link_lock.acquire(blocking=False):
            return
        def run():
            try:
                if self.cell.upload:
                    self.cell.upload.hold_auth(True)
                if self.cell.socket_client:
                    self.cell.socket_client.stop()
                paired = ensure_paired(
                    cfg=self.cfg, state=self.state, api=ApiClient(self.cfg.api_base),
                    stop_event=self.stop_event, on_code=self.ui.show_pairing_code,
                    on_state=self.ui.on_pairing_state, controls=self.controls,
                )
                if not paired or self.stop_event.is_set():
                    return
                with _STATE_SAVE_LOCK:
                    if not self.state.device_token:
                        return
                    api = ApiClient(self.cfg.api_base, self.state.device_token)
                    ticket = replay_ticket(self.state)
                    self.cell.api = api
                    for service in (self.cell.heartbeat, self.cell.import_ctl, self.cell.build_checkin):
                        if service:
                            service._api = api
                    self._replace_transport(self.cell.live_transport, api)
                    socket_client = self.cell.socket_client
                    if socket_client:
                        socket_client = socket_client.with_device_token(self.state.device_token)
                        self.cell.socket_client = socket_client
                    session_enabled = self.state.companion_session_enabled
                if self.cell.upload:
                    self.cell.upload.replace_api(api)
                from ..player_handle import refresh_from_cloud
                refresh_from_cloud(api, self.cfg.state_dir,
                    interactive=True,
                    owner=ticket.owner,
                    current_guard=lambda: ticket.current(self.state) and not self.stop_event.is_set(),
                    on_profile=lambda profile: publish_owned_toons(self.state, profile, ticket))
                if not ticket.current(self.state) or self.stop_event.is_set():
                    return
                if socket_client:
                    socket_client.set_session_enabled(session_enabled)
                    socket_client.start()
                controller = self.cell.build_checkin
                if controller is not None and callable(getattr(controller, "on_connection_changed", None)):
                    controller.on_connection_changed()
                self.watchdog.reset()
                if self.cell.upload:
                    self.cell.upload.hold_auth(False)
                self.ui.on_paired(self.state.user_id or "")
            except Exception:
                # Retain the held queue and let Link again retry recovery.
                log.exception("device_relink_failed")
                self.ui.on_unlinked()
            finally:
                self._link_lock.release()
        threading.Thread(target=run, name="sc2tools-relink", daemon=True).start()

    @staticmethod
    def _replace_transport(transport, api):
        if transport is None:
            return
        if hasattr(transport, "_api"):
            transport._api = api
        if hasattr(transport, "_token"):
            transport._token = api.device_token
        for child in getattr(transport, "_transports", ()):
            RuntimeRecovery._replace_transport(child, api)
