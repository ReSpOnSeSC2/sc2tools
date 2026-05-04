"""Pairing-flow state machine.

Stages:
  1. NEW       — agent has never paired. Call /start to get a code.
  2. SHOWING   — show the code to the user; poll /poll until it's claimed.
  3. PAIRED    — token persisted to state.json; everything else uses it.
  4. REVOKED   — server says the token is gone. Wipe and restart.
"""

from __future__ import annotations

import logging
import threading
import time
from dataclasses import dataclass
from datetime import datetime, timezone
from enum import Enum
from typing import Callable, Optional

from ..api_client import ApiClient
from ..state import AgentState, save_state
from ..config import AgentConfig

log = logging.getLogger(__name__)


POLL_INTERVAL_SEC = 3.0
POLL_TIMEOUT_SEC = 600.0


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


def ensure_paired(
    *,
    cfg: AgentConfig,
    state: AgentState,
    api: ApiClient,
    on_code: Callable[[str], None],
    stop_event: threading.Event,
) -> bool:
    """Block until the agent is paired or the user cancels.

    Returns True if pairing completed and the agent state was mutated
    in place. Returns False if the user closed the agent before pairing
    completed.
    """
    if state.is_paired:
        return True
    code, expires_at = _request_code(api)
    if code is None:
        return False
    on_code(code)
    deadline = time.monotonic() + POLL_TIMEOUT_SEC
    while not stop_event.is_set() and time.monotonic() < deadline:
        try:
            result = api.poll_pairing(code)
        except Exception as exc:  # noqa: BLE001
            log.warning("pairing_poll_failed: %s", exc)
            time.sleep(POLL_INTERVAL_SEC)
            continue
        status = result.get("status")
        if status == "ready":
            token = result.get("deviceToken")
            user_id = result.get("userId")
            if not token or not user_id:
                log.error("pairing_ready_but_payload_invalid: %r", result)
                return False
            state.device_token = str(token)
            state.user_id = str(user_id)
            state.paired_at = datetime.now(timezone.utc).isoformat()
            save_state(cfg.state_dir, state)
            log.info("paired userId=%s", user_id)
            return True
        if status == "expired":
            log.info("pairing_code_expired; restarting")
            code, expires_at = _request_code(api)
            if code is None:
                return False
            on_code(code)
            continue
        time.sleep(POLL_INTERVAL_SEC)
    return False


def _request_code(api: ApiClient) -> tuple[Optional[str], Optional[datetime]]:
    try:
        result = api.start_pairing()
    except Exception as exc:  # noqa: BLE001
        log.error("pairing_start_failed: %s", exc)
        return None, None
    code = result.get("code")
    expires_raw = result.get("expiresAt")
    expires_at = _parse_iso(expires_raw) if isinstance(expires_raw, str) else None
    if not isinstance(code, str) or not code:
        log.error("pairing_start_returned_no_code: %r", result)
        return None, None
    log.info("pairing_code_issued len=%d", len(code))
    return code, expires_at


def _parse_iso(s: str) -> Optional[datetime]:
    try:
        if s.endswith("Z"):
            s = s[:-1] + "+00:00"
        return datetime.fromisoformat(s)
    except ValueError:
        return None
