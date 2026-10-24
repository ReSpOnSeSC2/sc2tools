"""Stoppable device pairing, including code renewal and outage recovery."""
from __future__ import annotations

import logging
import platform
import random
import socket
import threading
import time
from dataclasses import dataclass
from datetime import datetime, timezone
from enum import Enum
from typing import Callable, Optional

from .. import __version__
from ..api_client import ApiClient
from ..config import AgentConfig
from ..state import AgentState, _STATE_SAVE_LOCK, save_state

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


class PairingControls:
    def __init__(self) -> None:
        self.retry_now = threading.Event()
        self.new_code = threading.Event()

    def request_new_code(self) -> None:
        self.new_code.set()
        self.retry_now.set()

    def wait(self, seconds: float, stop_event: threading.Event) -> None:
        deadline = time.monotonic() + seconds
        while not stop_event.is_set():
            remaining = deadline - time.monotonic()
            if remaining <= 0 or self.retry_now.wait(min(remaining, 0.1)):
                self.retry_now.clear()
                return


def ensure_paired(*, cfg: AgentConfig, state: AgentState, api: ApiClient,
                  on_code: Callable[[str], None], stop_event: threading.Event,
                  on_state: Optional[Callable[[PairingUiState], None]] = None,
                  controls: Optional[PairingControls] = None,
                  now: Callable[[], datetime] = lambda: datetime.now(timezone.utc),
                  jitter: Callable[[float, float], float] = random.uniform) -> bool:
    """Wait until paired or stopped. Network failures never close the app."""
    if state.is_paired:
        return True
    controls = controls or PairingControls()
    emit = on_state or (lambda _state: None)
    code = ""
    expires_at = None
    failures = 0
    while not stop_event.is_set():
        refresh = controls.new_code.is_set()
        controls.new_code.clear()
        expiring = expires_at is not None and (expires_at - now()).total_seconds() < 60
        if not code or refresh or expiring:
            previous_expiry = expires_at
            code = ""
            emit(PairingUiState("requesting"))
            try:
                result = api.start_pairing()
                code = result.get("code")
                expires_at = _parse_iso(result.get("expiresAt"))
                if not isinstance(code, str) or not code or expires_at is None or expires_at <= now():
                    raise ValueError("pairing response has no current code")
                failures = 0
                on_code(code)
                emit(PairingUiState("showing", code, expires_at))
            except Exception as exc:
                log.warning("pairing_start_failed: %s", exc)
                code = ""
                failures += 1
                delay = min(60.0, 2 ** min(failures, 6)) * jitter(0.8, 1.0)
                kind = "expired" if previous_expiry is not None else "unreachable"
                emit(PairingUiState(kind, retry_in=delay))
                controls.wait(delay, stop_event)
                continue
        try:
            result = api.poll_pairing(code)
            if result.get("status") == "ready":
                token, user_id = result.get("deviceToken"), result.get("userId")
                if not token or not user_id:
                    raise ValueError("pairing ready response has no token or account")
                with _STATE_SAVE_LOCK:
                    previous = state.device_token, state.user_id, state.paired_at
                    state.device_token, state.user_id = str(token), str(user_id)
                    state.paired_at = now().isoformat()
                    try:
                        save_state(cfg.state_dir, state)
                    except OSError:
                        state.device_token, state.user_id, state.paired_at = previous
                        raise
                emit(PairingUiState("paired"))
                return True
            if result.get("status") == "expired":
                code = ""
                continue
            failures = 0
            emit(PairingUiState("showing", code, expires_at))
            delay = POLL_INTERVAL_SEC
        except Exception as exc:
            log.warning("pairing_poll_failed: %s", exc)
            failures += 1
            delay = min(60.0, 2 ** min(failures, 6)) * jitter(0.8, 1.0)
            emit(PairingUiState("unreachable", retry_in=delay))
        controls.wait(delay, stop_event)
    return False


def pairing_metadata() -> dict:
    try:
        hostname = socket.gethostname()
    except OSError:
        hostname = ""
    return {"hostname": hostname, "os": platform.system(), "version": __version__}


def _parse_iso(value: object) -> Optional[datetime]:
    if not isinstance(value, str):
        return None
    try:
        parsed = datetime.fromisoformat(value.replace("Z", "+00:00"))
        return parsed.replace(tzinfo=timezone.utc) if parsed.tzinfo is None else parsed
    except ValueError:
        return None
