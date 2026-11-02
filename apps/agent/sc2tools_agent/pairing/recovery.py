"""Replace runtime credentials after confirmed unlinking, retaining work and settings."""
import logging
import threading
import time

from ..api_client import ApiClient
from ..auth_watchdog import AuthWatchdog
from ..state import (_STATE_SAVE_LOCK, commit_state_credentials, credential_revision,
                     mark_device_retired)
from ..agent_credentials import CredentialIntent, CredentialStorageError
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
        self.watchdog = AuthWatchdog(get_api=lambda: cell.api, get_epoch=self._current_epoch,
            on_unlinked=self.unlinked,
            on_unlinked_current=lambda api, epoch: self.unlinked(expected_api=api, expected_epoch=epoch))

    def _current_epoch(self):
        with _STATE_SAVE_LOCK:
            return replay_ticket(self.state).epoch

    def auth_context(self, api):
        with _STATE_SAVE_LOCK:
            ticket = replay_ticket(self.state)
            if (self.cell.api is api and ticket.token
                and getattr(api, "device_token", None) == ticket.token):
                return ticket.epoch
        return None

    def auth_outcome(self, api, epoch, exc):
        if self.auth_context(api) is not epoch or epoch is None:
            return False
        if exc is None:
            self.watchdog.success(api=api, epoch=epoch)
        else:
            self.watchdog.failure(exc, api=api, epoch=epoch)
        return self.auth_context(api) is epoch

    def queue_auth_outcome(self, context, exc):
        return self.auth_outcome(context.api, context.owner_epoch, exc)

    def connected(self, *, auth=True):
        if auth:
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

    def unlinked(self, *, expected_api=None, expected_epoch=None):
        with _STATE_SAVE_LOCK:
            if (expected_api is not None and self.cell.api is not expected_api
                or expected_epoch is not None and getattr(self.state, "_owner_epoch", None) is not expected_epoch
                or not self.state.device_token):
                return False
            try:
                revision = credential_revision(self.state, "device")
            except CredentialStorageError:
                revision = None
            self.state._owner_epoch = object()
            retirement_epoch = self.state._owner_epoch
            self.state._owned_toons = None
            mark_device_retired(self.state, durable=False)
            socket_client = self.cell.socket_client
            upload = self.cell.upload
            anonymous = ApiClient(self.cfg.api_base)
            previous = [self.cell.api]
            self.cell.api = anonymous
            for service in (self.cell.heartbeat, self.cell.import_ctl, self.cell.build_checkin):
                if service is not None:
                    previous.append(getattr(service, "_api", None))
                    if callable(getattr(type(service), "replace_api", None)):
                        service.replace_api(anonymous, owner_epoch=retirement_epoch)
                    else:
                        service._api = anonymous
            if upload is not None:
                previous.append(getattr(upload, "_api", None))
                upload.replace_api(anonymous)  # Reentrant STATE metadata only, before socket reconstruction.
            self._replace_transport(self.cell.live_transport, anonymous)
            for api in previous:
                if isinstance(api, ApiClient):
                    api.retire_authentication()
            socket_failed = False
            if socket_client is not None:
                self._socket_connection_template = getattr(socket_client, "_on_connection", None)
                if callable(getattr(socket_client, "retire_sync_requests", None)):
                    socket_client.retire_sync_requests()  # No IO, callbacks or locks.
                socket_client._device_token = None
                try:
                    self.cell.socket_client = socket_client.with_device_token(None)
                except Exception:
                    self.cell.socket_client = None
                    socket_failed = True
                self._socket_template = self.cell.socket_client or socket_client
                socket_client._on_connection = None
            failure = None
            try:
                commit_state_credentials(self.cfg.state_dir, self.state,
                    device=CredentialIntent("clear"), expected_device_revision=revision,
                    expected_owner_epoch=retirement_epoch)
                mark_device_retired(self.state, durable=True)
            except Exception as exc:
                failure = exc.code if type(exc) is CredentialStorageError else "unavailable"
                mark_device_retired(self.state, durable=False)
        if failure:
            log.warning("unlinked_state_save_failed code=%s", failure)
        if socket_failed:
            log.warning("unlinked_socket_rebuild_unavailable")
        if upload is not None:
            try:
                upload.hold_auth_if_current(True, api=anonymous, epoch=retirement_epoch)
            except Exception:
                log.warning("unlinked_queue_hold_unavailable")
        if socket_client is not None:
            try:
                socket_client.stop()
            except Exception:
                log.warning("unlinked_socket_stop_unavailable")
        with _STATE_SAVE_LOCK:
            current = (self.cell.api is anonymous
                and getattr(self.state, "_owner_epoch", None) is retirement_epoch)
        if not current:
            return True  # The admitted retirement must not change a newer link's UI.
        controller = self.cell.build_checkin
        if controller is not None and callable(getattr(controller, "on_connection_changed", None)):
            try:
                controller.on_connection_changed()
            except Exception:
                log.warning("unlinked_controller_notification_unavailable")
        guarded_ui = getattr(type(self.ui), "on_unlinked_current", None)
        try:
            if callable(guarded_ui):
                self.ui.on_unlinked_current(retirement_epoch)
            else:
                self.ui.on_unlinked()
        except Exception:
            log.warning("unlinked_ui_notification_unavailable")
        if not self.cell.gui:
            self.link_again(expected_api=anonymous, expected_epoch=retirement_epoch)
        return True

    def link_again(self, *, expected_api=None, expected_epoch=None):
        with _STATE_SAVE_LOCK:
            if (expected_api is not None and self.cell.api is not expected_api
                or expected_epoch is not None and getattr(self.state, "_owner_epoch", None) is not expected_epoch):
                return
        if not self._link_lock.acquire(blocking=False):
            return
        started = threading.Event()
        def run():
            started.set()
            socket_client, start_attempted = None, False
            try:
                with _STATE_SAVE_LOCK:
                    if (expected_api is not None and self.cell.api is not expected_api
                        or expected_epoch is not None and getattr(self.state, "_owner_epoch", None) is not expected_epoch):
                        return
                    admission_api, admission_ticket = self.cell.api, replay_ticket(self.state)
                    upload, previous_socket = self.cell.upload, self.cell.socket_client
                if upload is not None and not upload.hold_auth_if_current(True,
                    api=admission_api, epoch=admission_ticket.epoch):
                    return
                if previous_socket is not None:
                    previous_socket.stop()
                paired_ticket = None
                def pairing_state(value):
                    nonlocal paired_ticket
                    if value.kind == "paired":
                        with _STATE_SAVE_LOCK:
                            if getattr(self.state, "_owner_epoch", None) is value.owner_epoch:
                                paired_ticket = replay_ticket(self.state)
                    self.ui.on_pairing_state(value)
                paired = ensure_paired(
                    cfg=self.cfg, state=self.state, api=ApiClient(self.cfg.api_base),
                    stop_event=self.stop_event, on_code=self.ui.show_pairing_code,
                    on_state=pairing_state, controls=self.controls,
                )
                if not paired or self.stop_event.is_set():
                    return
                with _STATE_SAVE_LOCK:
                    # A ready notification carries the admitted commit's epoch.
                    # An already-paired entry may reuse only its original ticket.
                    ticket = paired_ticket or admission_ticket
                    if (not ticket.token or not ticket.current(self.state)
                        or self.cell.api is not admission_api):
                        return
                    api = ApiClient(self.cfg.api_base, ticket.token)
                    previous_apis = [self.cell.api]
                    self.cell.api = api
                    for service in (self.cell.heartbeat, self.cell.import_ctl, self.cell.build_checkin):
                        if service:
                            previous_apis.append(getattr(service, "_api", None))
                            if callable(getattr(type(service), "replace_api", None)):
                                service.replace_api(api, owner_epoch=ticket.epoch)
                            else:
                                service._api = api
                    if self.cell.upload:
                        previous_apis.append(getattr(self.cell.upload, "_api", None))
                        self.cell.upload.replace_api(api)
                    self._replace_transport(self.cell.live_transport, api)
                    for previous_api in previous_apis:
                        if isinstance(previous_api, ApiClient):
                            previous_api.retire_authentication()
                    socket_client = self.cell.socket_client or getattr(self, "_socket_template", None)
                    if socket_client:
                        socket_client = socket_client.with_device_token(ticket.token)
                        if (getattr(socket_client, "_on_connection", None) is None
                            and getattr(self, "_socket_connection_template", None) is not None):
                            socket_client._on_connection = self._socket_connection_template
                        self.cell.socket_client = socket_client
                    session_enabled = self.state.companion_session_enabled
                def current():
                    with _STATE_SAVE_LOCK:
                        return (ticket.current(self.state) and self.cell.api is api
                            and (socket_client is None or self.cell.socket_client is socket_client)
                            and not self.stop_event.is_set())
                from ..player_handle import refresh_from_cloud
                refresh_from_cloud(api, self.cfg.state_dir,
                    interactive=True,
                    owner=ticket.owner,
                    current_guard=current,
                    on_profile=lambda profile: publish_owned_toons(self.state, profile, ticket))
                if not current():
                    return
                if socket_client:
                    socket_client.set_session_enabled(session_enabled)
                    if not current():
                        return
                    start_attempted = True
                    socket_client.start()
                    if not current():
                        socket_client._on_connection = None
                        socket_client.stop()
                        start_attempted = False
                        return
                controller = self.cell.build_checkin
                if current() and controller is not None and callable(getattr(controller, "on_connection_changed", None)):
                    controller.on_connection_changed()
                if not current():
                    return
                if upload is not None and not upload.hold_auth_if_current(False, api=api, epoch=ticket.epoch):
                    return
                if not current():
                    return
                guarded_ui = getattr(type(self.ui), "on_paired_current", None)
                if callable(guarded_ui):
                    self.ui.on_paired_current(ticket.owner or "", ticket.epoch)
                else:
                    self.ui.on_paired(ticket.owner or "")
                start_attempted = False
            except Exception:
                # A committed selector remains authoritative if hot apply fails.
                # Raw transport/filesystem exceptions can contain private data.
                log.warning("device_relink_apply_unavailable")
            finally:
                if start_attempted and socket_client is not None:
                    try:
                        socket_client._on_connection = None
                        socket_client.stop()
                    except Exception:
                        log.warning("device_relink_socket_stop_unavailable")
                self._link_lock.release()
        try:
            threading.Thread(target=run, name="sc2tools-relink", daemon=True).start()
        except Exception:
            if not started.is_set():
                self._link_lock.release()
            log.warning("device_relink_schedule_unavailable")

    @staticmethod
    def _replace_transport(transport, api):
        if transport is None:
            return
        previous = getattr(transport, "_api", None)
        replace_auth = getattr(type(transport), "replace_auth", None)
        if callable(replace_auth):
            transport.replace_auth(api)
            if previous is not api and isinstance(previous, ApiClient):
                previous.retire_authentication()
            return
        if hasattr(transport, "_api"):
            previous = transport._api
            if previous is not api and isinstance(previous, ApiClient):
                previous.retire_authentication()
            transport._api = api
        if hasattr(transport, "_token"):
            transport._token = api.device_token
        for child in getattr(transport, "_transports", ()):
            RuntimeRecovery._replace_transport(child, api)
