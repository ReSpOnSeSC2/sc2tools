"""Thin wrapper around the cloud REST API.

All network code goes through this module so retries, timeouts, and
auth-header handling are in one place.
"""

from __future__ import annotations

import time
from dataclasses import dataclass
from typing import Any, Dict, Optional

import requests

CONNECT_TIMEOUT_SEC = 5.0
READ_TIMEOUT_SEC = 30.0
DEFAULT_RETRIES = 3
RETRY_BACKOFF_BASE_SEC = 0.5

_USER_AGENT = "sc2tools-agent/0.1"


@dataclass(frozen=True)
class ApiClient:
    """Stateless HTTP client. Pass the device token explicitly so test
    code can swap it without env-var gymnastics."""

    base_url: str
    device_token: Optional[str] = None

    # ---------------- Pairing flow ----------------
    def start_pairing(self) -> Dict[str, Any]:
        return self._post("/v1/device-pairings/start", auth=False)

    def poll_pairing(self, code: str) -> Dict[str, Any]:
        url = f"/v1/device-pairings/{code}"
        return self._get(url, auth=False, allow_202=True)

    # ---------------- Profile (player handle, etc.) ----------------
    def get_profile(self) -> Dict[str, Any]:
        """Fetch the per-user profile (battleTag, pulseId, region, …).

        The web settings page persists these via PUT /v1/me/profile;
        the agent reads them so it can resolve the player handle from
        the cloud instead of an env var. Returns ``{}`` if the user
        hasn't filled anything in yet — never raises on a 404 since
        the endpoint always responds with ``{}`` for a fresh account.
        """
        if not self.device_token:
            raise PermissionError("agent_not_paired")
        return self._get("/v1/me/profile", auth=True)

    # ---------------- Game ingest ----------------
    def upload_game(self, game: Dict[str, Any]) -> Dict[str, Any]:
        if not self.device_token:
            raise PermissionError("agent_not_paired")
        return self._post("/v1/games", auth=True, body=game)

    def upload_games_batch(self, games: list[Dict[str, Any]]) -> Dict[str, Any]:
        if not self.device_token:
            raise PermissionError("agent_not_paired")
        return self._post("/v1/games", auth=True, body={"games": games})

    # ---------------- Live overlay events ----------------
    def push_overlay_live(
        self, *, token: str, payload: Dict[str, Any],
    ) -> Dict[str, Any]:
        """Push a pre/post-game payload to one specific overlay token.

        The cloud broadcasts to ``overlay:<token>`` and the OBS overlay
        receives it over Socket.io. Auth is the agent's device token —
        the cloud verifies the overlay token belongs to the same user.
        """
        if not self.device_token:
            raise PermissionError("agent_not_paired")
        return self._post(
            "/v1/overlay-events/live",
            auth=True,
            body={"token": token, "payload": payload},
        )

    # ---------------- internals ----------------
    def _get(
        self,
        path: str,
        *,
        auth: bool,
        allow_202: bool = False,
    ) -> Dict[str, Any]:
        return self._request("GET", path, auth=auth, allow_202=allow_202)

    def _post(
        self,
        path: str,
        *,
        auth: bool,
        body: Optional[Dict[str, Any]] = None,
    ) -> Dict[str, Any]:
        return self._request("POST", path, auth=auth, body=body)

    def _request(
        self,
        method: str,
        path: str,
        *,
        auth: bool,
        body: Optional[Dict[str, Any]] = None,
        allow_202: bool = False,
    ) -> Dict[str, Any]:
        url = f"{self.base_url}{path}"
        headers = {"user-agent": _USER_AGENT, "accept": "application/json"}
        if auth:
            if not self.device_token:
                raise PermissionError("agent_not_paired")
            headers["authorization"] = f"Bearer {self.device_token}"

        last_exc: Optional[Exception] = None
        for attempt in range(DEFAULT_RETRIES):
            try:
                response = requests.request(
                    method,
                    url,
                    json=body if body is not None else None,
                    headers=headers,
                    timeout=(CONNECT_TIMEOUT_SEC, READ_TIMEOUT_SEC),
                )
            except requests.RequestException as exc:
                last_exc = exc
                _backoff(attempt)
                continue

            if response.status_code == 202 and allow_202:
                return _safe_json(response)
            if 200 <= response.status_code < 300:
                return _safe_json(response)
            if response.status_code in (408, 429) or response.status_code >= 500:
                last_exc = _ApiError(response.status_code, response.text)
                _backoff(attempt)
                continue
            # 4xx — retrying won't help.
            raise _ApiError(response.status_code, response.text)
        raise last_exc or RuntimeError("unreachable")


class _ApiError(Exception):
    def __init__(self, status: int, body: str):
        super().__init__(f"http_{status}: {body[:300]}")
        self.status = status
        self.body = body


def _safe_json(response: requests.Response) -> Dict[str, Any]:
    if not response.text:
        return {}
    try:
        out = response.json()
    except ValueError:
        return {}
    if not isinstance(out, dict):
        return {"_raw": out}
    return out


def _backoff(attempt: int) -> None:
    time.sleep(RETRY_BACKOFF_BASE_SEC * (2**attempt))
