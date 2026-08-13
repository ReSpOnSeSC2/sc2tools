"""Thin wrapper around the cloud REST API.

All network code goes through this module so retries, timeouts, and
auth-header handling are in one place.
"""

from __future__ import annotations

import base64
import hashlib
import hmac
import re
import time
from dataclasses import dataclass
from pathlib import Path
from typing import Any, Dict, Optional
from urllib.parse import quote

import requests

CONNECT_TIMEOUT_SEC = 5.0
READ_TIMEOUT_SEC = 30.0
DEFAULT_RETRIES = 3
RETRY_BACKOFF_BASE_SEC = 0.5

# Per-game read-timeout budget for batch uploads. The flat 30 s
# READ_TIMEOUT_SEC was sized for single-game posts; a 50-game batch
# routinely needs longer than that server-side (observed 2026-06-10:
# every size=50 batch against the production API hit the 30 s read
# timeout, the queue backed up, and the agent wedged). Scale the
# budget with the batch so big batches get a proportionally longer
# leash while single games keep the snappy default.
BATCH_READ_TIMEOUT_PER_GAME_SEC = 3.0

# Replay binaries upload directly to the private object-store URL the
# API signs for this device.  The control-plane requests still use the
# ordinary API timeout; the R2 PUT gets a longer leash because slower
# home connections can take more than 30 seconds for a large replay.
REPLAY_PUT_READ_TIMEOUT_SEC = 120.0
# Must stay aligned with API ``LIMITS.REPLAY_FILE_MAX_BYTES``. Replays over
# this ceiling still sync their parsed stats; only the original download is
# unavailable. Rejecting locally avoids an unrecoverable 413 retry loop.
REPLAY_FILE_MAX_BYTES = 5 * 1024 * 1024
_SHA256_RE = re.compile(r"^[0-9a-f]{64}$")

_USER_AGENT = "sc2tools-agent/0.1"


class ReplayArchiveSourceUnavailable(RuntimeError):
    """The accepted replay's local source may become readable later."""


def replay_file_matches_archive_marker(
    file_path: Path,
    marker: object,
) -> bool:
    """Verify that an accepted server marker describes this exact file.

    The marker is ownership-scoped by ``POST /v1/games``, but it is still
    network input. Never skip a backup merely because ``available`` is true:
    require a valid size/SHA-256 identity and compare it with local bytes.
    """
    if not isinstance(marker, dict) or marker.get("available") is not True:
        return False
    raw_size = marker.get("sizeBytes")
    raw_sha = marker.get("sha256")
    if isinstance(raw_size, bool) or not isinstance(raw_size, int):
        return False
    if (
        raw_size <= 0
        or raw_size > REPLAY_FILE_MAX_BYTES
        or not isinstance(raw_sha, str)
    ):
        return False
    expected_sha = raw_sha.strip().lower()
    if not _SHA256_RE.fullmatch(expected_sha):
        return False
    path = Path(file_path)
    try:
        if not path.is_file() or path.stat().st_size != raw_size:
            return False
        digest = hashlib.sha256()
        with path.open("rb") as fh:
            for chunk in iter(lambda: fh.read(1024 * 1024), b""):
                digest.update(chunk)
    except OSError:
        return False
    return hmac.compare_digest(digest.hexdigest(), expected_sha)


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
        # Read timeout scales with batch size (floor: the single-game
        # default). A size-50 batch gets 150 s instead of timing out
        # at 30 s while the server is still happily processing it —
        # which both wasted the server's work AND re-enqueued 50 jobs
        # into an already-congested queue.
        read_timeout = max(
            READ_TIMEOUT_SEC,
            BATCH_READ_TIMEOUT_PER_GAME_SEC * len(games),
        )
        return self._post(
            "/v1/games",
            auth=True,
            body={"games": games},
            read_timeout=read_timeout,
        )

    def upload_replay_file(self, game_id: str, file_path: Path) -> bool:
        """Compatibility archive path for optional/rolling deployments."""
        return self._upload_replay_file(
            game_id,
            file_path,
            retry_optional_unavailable=False,
        )

    def upload_replay_file_durable(
        self,
        game_id: str,
        file_path: Path,
    ) -> bool:
        """Archive a replay while preserving temporary failures for retry.

        The durable background queue calls this variant. ``False`` means a
        terminal local/per-file outcome; transport errors plus rolling-deploy
        404/503 responses raise so the on-disk task remains pending.
        """
        return self._upload_replay_file(
            game_id,
            file_path,
            retry_optional_unavailable=True,
        )

    def _upload_replay_file(
        self,
        game_id: str,
        file_path: Path,
        *,
        retry_optional_unavailable: bool,
    ) -> bool:
        """Archive the original ``.SC2Replay`` for an accepted game.

        The API first verifies that the paired device owns ``game_id``
        and returns a short-lived, single-object PUT URL.  Bytes then go
        straight from the player's machine to the private R2 bucket;
        permanent R2 credentials stay server-side and the bulk file transfer
        bypasses the Render API. A final authenticated call asks the API
        to confirm R2's Content-MD5 check, the declared SHA-256 metadata,
        size, and MPQ magic before exposing the download action.

        ``False`` means this file cannot be archived (oversized or permanently
        rejected) or the deployed API has not enabled archival.
        Parsed-stat syncing must continue in those cases. Transport and
        retryable object-store failures raise so the queue tries again.
        """
        if not self.device_token:
            raise PermissionError("agent_not_paired")
        path = Path(file_path)
        try:
            if not path.is_file():
                if retry_optional_unavailable:
                    raise ReplayArchiveSourceUnavailable(
                        f"replay_source_missing: {path}",
                    )
                return False
            size_bytes = path.stat().st_size
            if size_bytes <= 0 or size_bytes > REPLAY_FILE_MAX_BYTES:
                return False
            digest = hashlib.sha256()
            md5 = hashlib.md5(usedforsecurity=False)
            with path.open("rb") as fh:
                for chunk in iter(lambda: fh.read(1024 * 1024), b""):
                    digest.update(chunk)
                    md5.update(chunk)
        except OSError as exc:
            if retry_optional_unavailable:
                raise ReplayArchiveSourceUnavailable(
                    f"replay_source_inaccessible: {path}",
                ) from exc
            return False
        metadata = {
            "filename": path.name,
            "sizeBytes": size_bytes,
            "sha256": digest.hexdigest(),
            "md5": base64.b64encode(md5.digest()).decode("ascii"),
        }
        encoded_id = quote(str(game_id), safe="")
        prepare_path = f"/v1/games/{encoded_id}/replay-upload"
        try:
            prepared = self._post(
                prepare_path,
                auth=True,
                body=metadata,
            )
        except _ApiError as exc:
            if exc.status in (400, 413):
                return False
            if (
                exc.status == 404
                and retry_optional_unavailable
                and "game_not_found" in exc.body
            ):
                return False
            if exc.status in (404, 503) and not retry_optional_unavailable:
                return False
            raise

        # A retry or full-history Re-sync commonly encounters an object the
        # server already verified. In that case the API deliberately skips a
        # new signed PUT and returns this terminal success shape.
        if (
            prepared.get("alreadyStored") is True
            and prepared.get("replayAvailable") is True
        ):
            return True

        upload_url = prepared.get("url")
        upload_id = prepared.get("uploadId")
        if not isinstance(upload_url, str) or not upload_url.startswith(
            ("https://", "http://"),
        ):
            raise RuntimeError("replay_upload_url_missing")
        if not isinstance(upload_id, str) or not upload_id:
            raise RuntimeError("replay_upload_id_missing")
        raw_headers = prepared.get("headers") or {}
        if not isinstance(raw_headers, dict):
            raise RuntimeError("replay_upload_headers_invalid")
        put_headers = {
            str(key): str(value)
            for key, value in raw_headers.items()
            if isinstance(key, str) and isinstance(value, (str, int))
        }

        last_exc: Optional[Exception] = None
        for attempt in range(DEFAULT_RETRIES):
            try:
                # Re-open on every attempt.  Retrying a consumed file
                # handle would silently PUT a zero-byte object.
                with path.open("rb") as fh:
                    response = requests.put(
                        upload_url,
                        data=fh,
                        headers=put_headers,
                        timeout=(
                            CONNECT_TIMEOUT_SEC,
                            REPLAY_PUT_READ_TIMEOUT_SEC,
                        ),
                    )
            except OSError as exc:
                # Cloud-backed files can be evicted between prepare and PUT.
                # Keep durable work queued so a later hydration can succeed.
                if retry_optional_unavailable:
                    raise ReplayArchiveSourceUnavailable(
                        f"replay_source_inaccessible: {path}",
                    ) from exc
                return False
            except requests.RequestException as exc:
                last_exc = exc
                _backoff(attempt)
                continue

            if 200 <= response.status_code < 300:
                break
            if response.status_code in (408, 429) or response.status_code >= 500:
                last_exc = _ApiError(response.status_code, response.text)
                retry_after = _retry_after_seconds(response)
                if retry_after is not None:
                    time.sleep(retry_after)
                else:
                    _backoff(attempt)
                continue
            if response.status_code in (400, 413):
                return False
            raise _ApiError(response.status_code, response.text)
        else:
            raise last_exc or RuntimeError("replay_upload_failed")

        try:
            complete = self._post(
                f"{prepare_path}/complete",
                auth=True,
                body={"uploadId": upload_id},
            )
        except _ApiError as exc:
            if exc.status in (400, 413):
                return False
            if (
                exc.status == 404
                and retry_optional_unavailable
                and "game_not_found" in exc.body
            ):
                return False
            if exc.status in (404, 503) and not retry_optional_unavailable:
                return False
            raise
        stored = complete.get("replayAvailable") is True
        if not stored and retry_optional_unavailable:
            raise RuntimeError("replay_archive_not_confirmed")
        return stored

    def get_replay_archive_status(self) -> Optional[Dict[str, Any]]:
        """Return progress for the one-time original-replay backfill.

        The current agent uses this only to decide whether to show its
        Re-sync prompt. A 404 means the control-plane endpoint has not
        reached this environment yet, so a rolling deployment stays quiet
        instead of turning an optional prompt into a startup failure.
        """
        if not self.device_token:
            raise PermissionError("agent_not_paired")
        try:
            payload = self._get(
                "/v1/me/replay-archive-status",
                auth=True,
            )
        except _ApiError as exc:
            if exc.status in (404, 503):
                return None
            raise
        return payload

    def mark_replay_archive_resync_started(
        self,
        *,
        agent_version: str,
    ) -> bool:
        """Acknowledge that this current build started one full local scan.

        The cloud uses this marker to avoid permanently nagging someone whose
        oldest replay file was already deleted and therefore cannot ever be
        archived. The call happens only after the local upload cursor has been
        cleared and the full-sweep request has been accepted.
        """
        if not self.device_token:
            raise PermissionError("agent_not_paired")
        try:
            payload = self._post(
                "/v1/me/replay-archive-resync",
                auth=True,
                body={"agentVersion": str(agent_version)},
            )
        except _ApiError as exc:
            if exc.status in (404, 503):
                return False
            raise
        return payload.get("ok") is True

    # ---------------- Live game bridge ----------------
    def push_agent_live(self, *, envelope: Dict[str, Any]) -> Dict[str, Any]:
        """Push a single ``LiveGameState`` envelope to the cloud.

        The cloud relays each envelope to the user's web tabs via
        Server-Sent Events on ``GET /v1/me/live``. Auth is the same
        device token as ``/v1/games``; the cloud derives the user
        from the token, so the body never needs to carry user IDs.

        Body shape (kept flat for SSE-friendly serialisation; see
        ``sc2tools_agent.live.types.envelope_for``)::

            { "type": "liveGameState", "phase": "match_loading",
              "gameKey": "Opp|Me|1717000000000", "displayTime": 12.5,
              "isReplay": false, "players": [...],
              "opponent": {"name": ..., "race": ..., "profile": {...}},
              "user": {"name": ...} }

        Returns the cloud's response — usually ``{ok: true}``.
        """
        if not self.device_token:
            raise PermissionError("agent_not_paired")
        return self._post("/v1/agent/live", auth=True, body=envelope)

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

    def get_overlay_token(self) -> Optional[str]:
        """Return the user's active overlay token, or ``None``.

        Used by the OBS scene builder: the backdrop, chat and session
        panels it creates are Browser Sources pointed at
        ``/overlay/<token>/…``, so there is nothing meaningful to build
        without one.

        ``GET /v1/overlay-tokens`` is served by the shared auth
        middleware, which accepts a device-token Bearer as well as a
        Clerk JWT — so the agent can call it directly. Revoked tokens
        are filtered out; the first live one wins, matching how the
        website presents "your overlay URL".
        """
        if not self.device_token:
            raise PermissionError("agent_not_paired")
        body = self._get("/v1/overlay-tokens", auth=True)
        for item in body.get("items") or []:
            if not isinstance(item, dict):
                continue
            token = item.get("token")
            if token and not item.get("revokedAt"):
                return str(token)
        return None

    # ---------------- Sticky MMR ping ----------------
    def patch_last_mmr(
        self,
        *,
        mmr: int,
        captured_at: Optional[str] = None,
        region: Optional[str] = None,
        game_id: Optional[str] = None,
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
        ``_MIN_PLAUSIBLE_MMR`` in replay_pipeline.py. ``game_id`` ties
        the sticky value to the accepted replay that supplied it, allowing
        the cloud to clear a legacy value later if that exact row is
        quarantined as a Resume-from-Replay artifact.
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
        if game_id:
            body["gameId"] = game_id
        return self._post("/v1/me/last-mmr", auth=True, body=body)

    # ---------------- bulk import (job visibility) ----------------
    def import_progress(self, body: Dict[str, Any]) -> Dict[str, Any]:
        """Report import-job progress (counters, breakdown, samples).

        The cloud $sets the fields onto the ``import_jobs`` doc and
        re-emits them to the user's sockets as ``import:progress`` so
        the dashboard card updates live.
        """
        return self._post("/v1/import/progress", auth=True, body=body)

    def import_agent_start(self, body: Dict[str, Any]) -> Dict[str, Any]:
        """Register an agent-initiated backfill as a visible job.

        Used by the startup sweep when it finds a large un-uploaded
        backlog: the cloud mints a job doc and returns ``{jobId}`` the
        progress reports then reference.
        """
        return self._post("/v1/import/agent-start", auth=True, body=body)

    def import_host_info(self, body: Dict[str, Any]) -> Dict[str, Any]:
        """Report host facts (cores, watched replay folders)."""
        return self._post("/v1/import/host-info", auth=True, body=body)

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
        read_timeout: Optional[float] = None,
    ) -> Dict[str, Any]:
        return self._request(
            "POST", path, auth=auth, body=body, read_timeout=read_timeout,
        )

    def _request(
        self,
        method: str,
        path: str,
        *,
        auth: bool,
        body: Optional[Dict[str, Any]] = None,
        allow_202: bool = False,
        read_timeout: Optional[float] = None,
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
                    timeout=(
                        CONNECT_TIMEOUT_SEC,
                        read_timeout if read_timeout else READ_TIMEOUT_SEC,
                    ),
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
