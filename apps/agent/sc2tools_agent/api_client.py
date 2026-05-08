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

    # ---------------- Sticky MMR ping ----------------
    def patch_last_mmr(
        self,
        *,
        mmr: int,
        captured_at: Optional[str] = None,
        region: Optional[str] = None,
    ) -> Dict[str, Any]:
        """Ping the cloud with the most-recently-extracted streamer MMR.

        Backs the session widget's ``profile_sticky`` fallback tier so
        the overlay paints a real number even when no game in the
        user's cloud history carries ``myMmr`` (e.g. all rows pre-date
        the v0.5.6 extraction fix). The server's ``patchLastKnownMmr``
        already deduplicates same-value writes, so calling this on
        every successful upload is cheap.

        ``mmr`` is bounds-checked here so we don't burn an HTTP
        round-trip on a clearly-bogus value (the server would 400 it
        anyway). The 500 floor matches the agent-side
        ``_MIN_PLAUSIBLE_MMR`` in replay_pipeline.py.
        """
        if not self.device_token:
            raise PermissionError("agent_not_paired")
        if not isinstance(mmr, int) or not (500 <= mmr <= 9999):
            raise ValueError(f"mmr out of range: {mmr!r}")
        body: Dict[str, Any] = {"mmr": mmr}
        if captured_at:
            body["capturedAt"] = captured_at
        if region:
            body["region"] = region
        return self._post("/v1/me/last-mmr", auth=True, body=body)

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
                # 429 specifically: the server (express-rate-limit
                # with ``standardHeaders: true``) sends a
                # ``Retry-After`` header carrying the seconds until
                # the rate-limit window resets. Honoring it skips
                # the exponential-backoff guess and waits exactly as
                # long as the server told us to. Critical for the
                # v0.5.8 batch-upload path: a burst of 25-game
                # batches can momentarily clip the 120 req/min ceiling
                # even with 1 worker, and naive 0.5/1/2-second
                # exponential backoff blows through the retry budget
                # before the rate-limit window has even reset.
                retry_after = _retry_after_seconds(response)
                if retry_after is not None:
                    time.sleep(retry_after)
                else:
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


# Cap the maximum honored ``Retry-After`` so a buggy / hostile server
# can't hang the agent indefinitely. A real rate-limit window is at
# most a few minutes; anything over 60 s here is suspicious and we
# clamp it. The exponential-backoff fallback covers anything beyond.
_MAX_HONORED_RETRY_AFTER_SEC = 60.0


def _retry_after_seconds(response: requests.Response) -> Optional[float]:
    """Parse the ``Retry-After`` response header into a sleep duration.

    RFC 7231 §7.1.3 allows two formats:
      1. an integer number of seconds (``Retry-After: 30``)
      2. an HTTP-date (``Retry-After: Wed, 21 Oct 2015 07:28:00 GMT``)

    Express-rate-limit (the cloud's middleware) emits the integer
    form, so that's the path we optimize for. The HTTP-date form is
    accepted but parsed defensively — any malformed value falls back
    to ``None`` so the caller drops to its exponential-backoff path.
    """
    raw = response.headers.get("Retry-After") if response is not None else None
    if not raw:
        return None
    try:
        seconds = float(raw.strip())
    except ValueError:
        # Could be an HTTP-date; sniff it.
        try:
            from email.utils import parsedate_to_datetime
            target = parsedate_to_datetime(raw)
        except (TypeError, ValueError):
            return None
        if target is None:
            return None
        from datetime import datetime, timezone
        delta = (target - datetime.now(timezone.utc)).total_seconds()
        seconds = max(0.0, delta)
    if seconds < 0:
        return None
    return min(seconds, _MAX_HONORED_RETRY_AFTER_SEC)
