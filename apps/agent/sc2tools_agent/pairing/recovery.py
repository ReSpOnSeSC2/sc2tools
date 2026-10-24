"""Replace runtime credentials after confirmed unlinking, retaining work and settings."""
import logging
import threading

from ..api_client import ApiClient
from ..auth_watchdog import AuthWatchdog
from ..state import _STATE_SAVE_LOCK, save_state
from .flow import PairingControls, ensure_paired

log = logging.getLogger(__name__)


class RuntimeRecovery:
    def __init__(self, *, cell, cfg, state, ui, stop_event, controls=None):
        self.cell, self.cfg, self.state, self.ui = cell, cfg, state, ui
        self.stop_event = stop_event
        self.controls = controls or PairingControls()
        self._link_lock = threading.Lock()
        self.watchdog = AuthWatchdog(get_api=lambda: cell.api, on_unlinked=self.unlinked)

    def connected(self):
        self.watchdog.success()
        if self.cell.upload:
            self.cell.upload.retry_now()

    def unlinked(self):
        if self.cell.upload:
            self.cell.upload.hold_auth(True)
        with _STATE_SAVE_LOCK:
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
                    self.cell.api = api
                    if self.cell.upload:
                        self.cell.upload.replace_api(api)
                    for service in (self.cell.heartbeat, self.cell.import_ctl, self.cell.build_checkin):
                        if service:
                            service._api = api
                    self._replace_transport(self.cell.live_transport, api)
                    socket_client = self.cell.socket_client
                    if socket_client:
                        socket_client = socket_client.with_device_token(self.state.device_token)
                        self.cell.socket_client = socket_client
                    session_enabled = self.state.companion_session_enabled
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
