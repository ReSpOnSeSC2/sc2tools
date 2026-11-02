"""Stoppable device pairing, including code renewal and outage recovery."""
from __future__ import annotations

import logging
import platform
import random
import socket
import threading
import time
from dataclasses import dataclass, field
from datetime import datetime, timezone
from enum import Enum
from typing import Callable, Optional

from .. import __version__
from ..api_client import ApiClient
from ..config import AgentConfig
from ..state import AgentState, _STATE_SAVE_LOCK, commit_state_credentials, credential_revision
from ..agent_credentials import CredentialIntent, CredentialStorageError

log = logging.getLogger(__name__)
POLL_INTERVAL_SEC = 3.0


class PairingStatus(str, Enum):
    NEW = "new"
    SHOWING = "showing"
    PAIRED = "paired"
    EXPIRED = "expired"


@dataclass
class PairingState:
    status: PairingStatus = PairingStatus.NEW
    code: Optional[str] = None
    code_expires_at: Optional[datetime] = None


@dataclass(frozen=True)
class PairingUiState:
    kind: str
    code: str = ""
    expires_at: Optional[datetime] = None
    retry_in: float = 0
    owner_epoch: object = field(default=None, repr=False, compare=False)


@dataclass(frozen=True, repr=False)
class _PairingScope:
    epoch: object
    revision: int
    refresh: object


@dataclass(frozen=True, repr=False)
class _PairingCode:
    value: str
    expires_at: datetime
    scope: _PairingScope


@dataclass(frozen=True, repr=False)
class _ApprovedCandidate:
    token: str
    user_id: str
    paired_at: str
    scope: _PairingScope
    clear_cache: bool


class PairingControls:
    def __init__(self) -> None:
        self.retry_now = threading.Event()
        self.new_code = threading.Event()
        self._refresh_token = object()

    def request_new_code(self) -> None:
        self._refresh_token = object()
        self.new_code.set()
        self.retry_now.set()

    def wait(self, seconds: float, stop_event: threading.Event) -> None:
        deadline = time.monotonic() + seconds
        while not stop_event.is_set():
            remaining = deadline - time.monotonic()
            if remaining <= 0 or self.retry_now.wait(min(remaining, 0.1)):
                self.retry_now.clear()
                return


def _capture_scope(state, controls):
    with _STATE_SAVE_LOCK:
        if state.is_paired:
            return None
        if getattr(state, "_owner_epoch", None) is None:
            state._owner_epoch = object()
        return _PairingScope(state._owner_epoch, credential_revision(state, "device"), controls._refresh_token)


def _current(state, scope, controls, stop_event, *, paired=False):
    with _STATE_SAVE_LOCK:
        try:
            return (not stop_event.is_set() and not controls.new_code.is_set()
                and controls._refresh_token is scope.refresh and getattr(state, "_owner_epoch", None) is scope.epoch
                and credential_revision(state, "device") == scope.revision and state.is_paired is paired)
        except CredentialStorageError:
            return False


def _publish(callback, value, state, scope, controls, stop_event, *, paired=False):
    if not _current(state, scope, controls, stop_event, paired=paired):
        return False
    try:
        callback(value)
    except Exception:
        log.warning("pairing_ui_unavailable")
    return _current(state, scope, controls, stop_event, paired=paired)


def _response(value):
    if type(value) is not dict or any(type(key) is not str for key in value):
        raise ValueError("invalid_pairing_response")
    return value


def _approved(result, scope, state, controls, stop_event, paired_at):
    token, user_id = result.get("deviceToken"), result.get("userId")
    CredentialIntent("set", token)  # Exact bounded primitive validation, without string coercion.
    if (type(user_id) is not str or not user_id or len(user_id) > 512
        or any(ord(char) < 32 or 0xD800 <= ord(char) <= 0xDFFF for char in user_id)):
        raise ValueError("invalid_pairing_account")
    with _STATE_SAVE_LOCK:
        if not _current(state, scope, controls, stop_event):
            return None
        retirement = object()
        state._owner_epoch = retirement
        state._owned_toons = None
        return _ApprovedCandidate(token, user_id, paired_at,
            _PairingScope(retirement, scope.revision, scope.refresh), state.user_id != user_id)


def _delay(failures, jitter):
    return min(60.0, 2 ** min(failures, 6)) * jitter(0.8, 1.0)


def ensure_paired(*, cfg: AgentConfig, state: AgentState, api: ApiClient,
                  on_code: Callable[[str], None], stop_event: threading.Event,
                  on_state: Optional[Callable[[PairingUiState], None]] = None,
                  controls: Optional[PairingControls] = None,
                  now: Callable[[], datetime] = lambda: datetime.now(timezone.utc),
                  jitter: Callable[[float, float], float] = random.uniform) -> bool:
    """Wait until paired or stopped. Network failures never close the app."""
    with _STATE_SAVE_LOCK:
        if state.is_paired:
            return True
    controls = controls or PairingControls()
    emit = on_state or (lambda _state: None)
    lease, candidate = None, None
    cache_cleared = False
    failures = 0
    while not stop_event.is_set():
        if controls.new_code.is_set():
            controls.new_code.clear()
            lease = candidate = None
            cache_cleared = False
        if candidate is not None:
            scope = candidate.scope
            if not _current(state, scope, controls, stop_event):
                lease = candidate = None
                cache_cleared = False
                continue
            try:
                with _STATE_SAVE_LOCK:
                    if not _current(state, scope, controls, stop_event):
                        continue
                    if candidate.clear_cache and not cache_cleared:
                        from ..player_handle import write_cache
                        write_cache(cfg.state_dir, None)
                        cache_cleared = True
                    if not _current(state, scope, controls, stop_event):
                        continue
                    commit_state_credentials(cfg.state_dir, state,
                        device=CredentialIntent("set", candidate.token), expected_device_revision=scope.revision,
                        expected_owner_epoch=scope.epoch, device_owner=(candidate.user_id, candidate.paired_at))
                committed = _PairingScope(scope.epoch, scope.revision + 1, scope.refresh)
                return _publish(emit, PairingUiState("paired", owner_epoch=scope.epoch), state,
                    committed, controls, stop_event, paired=True)
            except CredentialStorageError as exc:
                log.warning("pairing_credentials_save_failed code=%s", exc.code)
                if exc.code in ("indeterminate", "conflict", "invalid_pointer"):
                    return False
            except Exception:
                log.warning("pairing_credentials_save_failed code=unavailable")
            if _current(state, scope, controls, stop_event):
                failures += 1
                delay = _delay(failures, jitter)
                _publish(emit, PairingUiState("unreachable", retry_in=delay, owner_epoch=scope.epoch),
                    state, scope, controls, stop_event)
                controls.wait(delay, stop_event)
            continue
        if lease is not None and not _current(state, lease.scope, controls, stop_event):
            lease = None
        previous_expiry = lease.expires_at if lease is not None else None
        if lease is not None and (lease.expires_at - now()).total_seconds() < 60:
            lease = None
        if lease is None:
            try:
                scope = _capture_scope(state, controls)
            except CredentialStorageError:
                log.warning("pairing_credentials_unavailable")
                return False
            if scope is None:
                return False  # Another owner paired; this attempt cannot claim its activation.
            if not _publish(emit, PairingUiState("requesting", owner_epoch=scope.epoch), state, scope, controls, stop_event):
                continue
            try:
                result = api.start_pairing()
                if not _current(state, scope, controls, stop_event):
                    continue
                result = _response(result)
                code, expires_at = result.get("code"), _parse_iso(result.get("expiresAt"))
                if type(code) is not str or not 0 < len(code) <= 64 or expires_at is None or expires_at <= now():
                    raise ValueError("invalid_pairing_code")
                lease = _PairingCode(code, expires_at, scope)
                failures = 0
                if not _publish(on_code, code, state, scope, controls, stop_event):
                    lease = None
                    continue
                if not _publish(emit, PairingUiState("showing", code, expires_at, owner_epoch=scope.epoch),
                    state, scope, controls, stop_event):
                    lease = None
                    continue
            except Exception:
                log.warning("pairing_start_failed code=unavailable")
                lease = None
                if _current(state, scope, controls, stop_event):
                    failures += 1
                    delay = _delay(failures, jitter)
                    kind = "expired" if previous_expiry is not None else "unreachable"
                    _publish(emit, PairingUiState(kind, retry_in=delay, owner_epoch=scope.epoch),
                        state, scope, controls, stop_event)
                    controls.wait(delay, stop_event)
                continue
        scope = lease.scope
        try:
            if not _current(state, scope, controls, stop_event):
                lease = None
                continue
            result = api.poll_pairing(lease.value)
            if not _current(state, scope, controls, stop_event) or lease.expires_at <= now():
                lease = None
                continue
            result = _response(result)
            status = result.get("status")
            if type(status) is not str or status not in ("ready", "expired", "pending"):
                raise ValueError("invalid_pairing_status")
            if status == "ready":
                candidate = _approved(result, scope, state, controls, stop_event, now().isoformat())
                lease = None
                cache_cleared = False
                continue
            if status == "expired":
                lease = None
                continue
            failures = 0
            _publish(emit, PairingUiState("showing", lease.value, lease.expires_at, owner_epoch=scope.epoch),
                state, scope, controls, stop_event)
            delay = POLL_INTERVAL_SEC
        except Exception:
            log.warning("pairing_poll_failed code=unavailable")
            failures += 1
            delay = _delay(failures, jitter)
            _publish(emit, PairingUiState("unreachable", retry_in=delay, owner_epoch=scope.epoch),
                state, scope, controls, stop_event)
        if _current(state, scope, controls, stop_event):
            controls.wait(delay, stop_event)
    return False


def pairing_metadata() -> dict:
    try:
        hostname = socket.gethostname()
    except OSError:
        hostname = ""
    return {"hostname": hostname, "os": platform.system(), "version": __version__}


def _parse_iso(value: object) -> Optional[datetime]:
    if type(value) is not str or not 0 < len(value) <= 64:
        return None
    try:
        parsed = datetime.fromisoformat(value.replace("Z", "+00:00"))
        return parsed.replace(tzinfo=timezone.utc) if parsed.tzinfo is None else parsed
    except ValueError:
        return None
