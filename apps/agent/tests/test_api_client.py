"""Tests for the API client. Uses requests' built-in mock via responses-like
patching. We intentionally don't pull in another lib — patching `requests.request`
directly is cleaner for the small surface area we test."""

from __future__ import annotations

import base64
import hashlib
from pathlib import Path
from typing import Any
from unittest.mock import patch, MagicMock

import pytest

from sc2tools_agent.api_client import ApiClient


def _mock_response(
    status: int,
    body: Any,
    *,
    headers: dict | None = None,
) -> MagicMock:
    m = MagicMock()
    m.status_code = status
    m.headers = headers or {}
    if body is None:
        m.text = ""
        m.json.side_effect = ValueError("no body")
    else:
        import json
        m.text = json.dumps(body)
        m.json.return_value = body
    return m


def test_start_pairing_returns_code() -> None:
    api = ApiClient(base_url="http://x")
    payload = {"code": "123456", "expiresAt": "2026-05-04T00:00:00+00:00"}
    with patch("requests.request", return_value=_mock_response(200, payload)) as m:
        result = api.start_pairing()
    assert result["code"] == "123456"
    args, kwargs = m.call_args
    assert kwargs["headers"].get("authorization") is None  # unauth


def test_upload_game_requires_pairing() -> None:
    api = ApiClient(base_url="http://x", device_token=None)
    with pytest.raises(PermissionError):
        api.upload_game({"gameId": "x"})


def test_upload_game_sends_bearer() -> None:
    api = ApiClient(base_url="http://x", device_token="tok")
    with patch(
        "requests.request",
        return_value=_mock_response(202, {"accepted": [{"gameId": "x"}]}),
    ) as m:
        api.upload_game({"gameId": "x"})
    args, kwargs = m.call_args
    assert kwargs["headers"]["authorization"] == "Bearer tok"


def test_upload_replay_file_uses_signed_put_and_completes(
    tmp_path: Path,
) -> None:
    replay = tmp_path / "Ladder Game.SC2Replay"
    payload = b"MPQ\x1b" + (b"replay-bytes" * 32)
    replay.write_bytes(payload)
    signed_url = "https://example.r2.cloudflarestorage.com/signed"
    prepared = _mock_response(
        200,
        {
            "url": signed_url,
            "uploadId": "upload-123",
            "headers": {
                "content-type": "application/octet-stream",
                "content-length": str(len(payload)),
                "cache-control": "private, no-store",
                "content-md5": base64.b64encode(
                    hashlib.md5(payload, usedforsecurity=False).digest(),
                ).decode("ascii"),
                "x-amz-meta-sha256": hashlib.sha256(payload).hexdigest(),
            },
            "expiresIn": 600,
        },
    )
    completed = _mock_response(200, {"replayAvailable": True})
    uploaded: list[bytes] = []

    def _put(_url: str, **kwargs: Any) -> MagicMock:
        uploaded.append(kwargs["data"].read())
        return _mock_response(200, None)

    api = ApiClient(base_url="http://x", device_token="tok")
    with patch(
        "requests.request",
        side_effect=[prepared, completed],
    ) as control, patch("requests.put", side_effect=_put) as put:
        assert api.upload_replay_file("date|opp/map", replay) is True

    assert uploaded == [payload]
    assert put.call_args.args[0] == signed_url
    assert put.call_args.kwargs["headers"] == {
        "content-type": "application/octet-stream",
        "content-length": str(len(payload)),
        "cache-control": "private, no-store",
        "content-md5": base64.b64encode(
            hashlib.md5(payload, usedforsecurity=False).digest(),
        ).decode("ascii"),
        "x-amz-meta-sha256": hashlib.sha256(payload).hexdigest(),
    }
    assert control.call_args_list[0].args[:2] == (
        "POST",
        "http://x/v1/games/date%7Copp%2Fmap/replay-upload",
    )
    complete_kwargs = control.call_args_list[1].kwargs
    assert control.call_args_list[1].args[1].endswith(
        "/replay-upload/complete",
    )
    assert complete_kwargs["json"] == {
        "uploadId": "upload-123",
    }
    assert control.call_args_list[0].kwargs["json"] == {
        "filename": replay.name,
        "sizeBytes": len(payload),
        "sha256": hashlib.sha256(payload).hexdigest(),
        "md5": base64.b64encode(
            hashlib.md5(payload, usedforsecurity=False).digest(),
        ).decode("ascii"),
    }


def test_upload_replay_file_is_optional_during_api_rollout(
    tmp_path: Path,
) -> None:
    replay = tmp_path / "game.SC2Replay"
    replay.write_bytes(b"MPQ\x1bdata")
    unavailable = _mock_response(503, {"error": {"code": "replay_storage_unavailable"}})
    api = ApiClient(base_url="http://x", device_token="tok")
    with patch("requests.request", return_value=unavailable), patch(
        "requests.put",
    ) as put, patch("time.sleep"):
        assert api.upload_replay_file("g1", replay) is False
    put.assert_not_called()


def test_upload_replay_file_accepts_already_verified_object(
    tmp_path: Path,
) -> None:
    replay = tmp_path / "already-stored.SC2Replay"
    replay.write_bytes(b"MPQ\x1balready-there")
    api = ApiClient(base_url="http://x", device_token="tok")
    with patch(
        "requests.request",
        return_value=_mock_response(
            200,
            {"alreadyStored": True, "replayAvailable": True},
        ),
    ), patch("requests.put") as put:
        assert api.upload_replay_file("g1", replay) is True

    put.assert_not_called()


def test_upload_replay_file_skips_oversized_original(
    tmp_path: Path,
) -> None:
    replay = tmp_path / "oversized.SC2Replay"
    # Sparse/truncated fixture mechanics are platform-dependent; a 5 MiB + 1
    # byte file is still small enough for this focused local-only test.
    replay.write_bytes(b"MPQ\x1b" + b"x" * (5 * 1024 * 1024 - 3))
    api = ApiClient(base_url="http://x", device_token="tok")
    with patch("requests.request") as request_mock, patch(
        "requests.put",
    ) as put:
        assert api.upload_replay_file("g1", replay) is False

    request_mock.assert_not_called()
    put.assert_not_called()


@pytest.mark.parametrize("status", [400, 413])
def test_upload_replay_file_treats_permanent_prepare_rejection_as_unavailable(
    tmp_path: Path,
    status: int,
) -> None:
    replay = tmp_path / "rejected.SC2Replay"
    replay.write_bytes(b"MPQ\x1bdata")
    api = ApiClient(base_url="http://x", device_token="tok")
    with patch(
        "requests.request",
        return_value=_mock_response(status, {"error": {"code": "invalid"}}),
    ), patch("requests.put") as put:
        assert api.upload_replay_file("g1", replay) is False

    put.assert_not_called()


def test_replay_archive_status_uses_device_auth() -> None:
    payload = {
        "totalGames": 12,
        "archivedGames": 5,
        "missingGames": 7,
        "requiresResync": True,
    }
    api = ApiClient(base_url="http://x", device_token="tok")
    with patch(
        "requests.request",
        return_value=_mock_response(200, payload),
    ) as request_mock:
        assert api.get_replay_archive_status() == payload

    args, kwargs = request_mock.call_args
    assert args[:2] == ("GET", "http://x/v1/me/replay-archive-status")
    assert kwargs["headers"]["authorization"] == "Bearer tok"


def test_replay_archive_status_is_optional_during_api_rollout() -> None:
    api = ApiClient(base_url="http://x", device_token="tok")
    with patch(
        "requests.request",
        return_value=_mock_response(404, {"error": {"code": "not_found"}}),
    ):
        assert api.get_replay_archive_status() is None


def test_replay_archive_status_is_quiet_while_storage_is_disabled() -> None:
    api = ApiClient(base_url="http://x", device_token="tok")
    with patch(
        "requests.request",
        return_value=_mock_response(
            503,
            {"error": {"code": "replay_storage_unavailable"}},
        ),
    ), patch("time.sleep"):
        assert api.get_replay_archive_status() is None


def test_mark_replay_archive_resync_started_sends_agent_version() -> None:
    api = ApiClient(base_url="http://x", device_token="tok")
    with patch(
        "requests.request",
        return_value=_mock_response(200, {"ok": True}),
    ) as request_mock:
        assert api.mark_replay_archive_resync_started(
            agent_version="0.15.0",
        ) is True

    args, kwargs = request_mock.call_args
    assert args[:2] == ("POST", "http://x/v1/me/replay-archive-resync")
    assert kwargs["json"] == {"agentVersion": "0.15.0"}
    assert kwargs["headers"]["authorization"] == "Bearer tok"


def test_mark_replay_archive_resync_is_optional_while_disabled() -> None:
    api = ApiClient(base_url="http://x", device_token="tok")
    with patch(
        "requests.request",
        return_value=_mock_response(
            503,
            {"error": {"code": "replay_storage_unavailable"}},
        ),
    ), patch("time.sleep"):
        assert api.mark_replay_archive_resync_started(
            agent_version="0.15.0",
        ) is False


def test_poll_pairing_accepts_202() -> None:
    api = ApiClient(base_url="http://x")
    with patch(
        "requests.request",
        return_value=_mock_response(202, {"status": "pending"}),
    ):
        out = api.poll_pairing("123456")
    assert out["status"] == "pending"


def test_get_profile_requires_pairing() -> None:
    api = ApiClient(base_url="http://x", device_token=None)
    with pytest.raises(PermissionError):
        api.get_profile()


def test_get_profile_sends_bearer_and_returns_payload() -> None:
    api = ApiClient(base_url="http://x", device_token="tok")
    payload = {"battleTag": "Foo#1234", "pulseId": "9876"}
    with patch(
        "requests.request",
        return_value=_mock_response(200, payload),
    ) as m:
        out = api.get_profile()
    assert out == payload
    args, kwargs = m.call_args
    assert kwargs["headers"]["authorization"] == "Bearer tok"
    assert args[0] == "GET"
    assert args[1].endswith("/v1/me/profile")


def test_429_response_honors_retry_after_seconds() -> None:
    """The cloud's express-rate-limit middleware sends 429 with a
    ``Retry-After`` header in seconds. The API client must sleep that
    long instead of falling through to its 0.5/1/2-second exponential
    backoff — the latter blows through ``DEFAULT_RETRIES=3`` in 3.5
    seconds total, which isn't enough to clear a 60-second rate-limit
    window."""
    import time as _time
    from unittest.mock import patch as _patch

    api = ApiClient(base_url="http://x", device_token="tok")
    rate_limited = _mock_response(429, {"error": "too many"}, headers={"Retry-After": "2"})
    success = _mock_response(202, {"accepted": [{"gameId": "g1"}]})
    sleeps: list[float] = []

    def _fake_sleep(seconds: float) -> None:
        # Capture the sleep durations without actually sleeping —
        # the test asserts on the value, not on wall clock.
        sleeps.append(seconds)

    with _patch(
        "requests.request",
        side_effect=[rate_limited, success],
    ), _patch.object(_time, "sleep", _fake_sleep):
        result = api.upload_game({"gameId": "g1"})

    # Retry-After: 2 → exactly one 2.0-second sleep should occur,
    # not the exponential 0.5 the old _backoff would have used.
    assert sleeps == [2.0], (
        f"expected a single 2.0-second sleep from honoring Retry-After, "
        f"got {sleeps!r}"
    )
    assert result == {"accepted": [{"gameId": "g1"}]}


def test_429_without_retry_after_falls_back_to_exponential_backoff() -> None:
    """Defensive: if the 429 response is missing ``Retry-After`` (e.g.
    a self-hosted reverse proxy stripped it), the client must still
    back off — falls through to the exponential schedule."""
    import time as _time
    from unittest.mock import patch as _patch

    api = ApiClient(base_url="http://x", device_token="tok")
    no_header = _mock_response(429, {"error": "too many"})  # no headers
    success = _mock_response(202, {"accepted": [{"gameId": "g1"}]})
    sleeps: list[float] = []

    with _patch(
        "requests.request",
        side_effect=[no_header, success],
    ), _patch.object(_time, "sleep", lambda s: sleeps.append(s)):
        result = api.upload_game({"gameId": "g1"})

    # First retry: RETRY_BACKOFF_BASE_SEC * 2^0 = 0.5s.
    assert sleeps == [0.5]
    assert result == {"accepted": [{"gameId": "g1"}]}


def test_429_retry_after_caps_at_60_seconds() -> None:
    """A buggy/hostile server sending ``Retry-After: 9999`` must not
    hang the agent. The honored value is clamped at 60 seconds."""
    import time as _time
    from unittest.mock import patch as _patch

    api = ApiClient(base_url="http://x", device_token="tok")
    long_wait = _mock_response(
        429, {"error": "too many"}, headers={"Retry-After": "9999"},
    )
    success = _mock_response(202, {"accepted": [{"gameId": "g1"}]})
    sleeps: list[float] = []

    with _patch(
        "requests.request",
        side_effect=[long_wait, success],
    ), _patch.object(_time, "sleep", lambda s: sleeps.append(s)):
        result = api.upload_game({"gameId": "g1"})

    assert sleeps == [60.0], (
        f"expected 9999-second Retry-After to clamp to 60, got {sleeps!r}"
    )
    assert result == {"accepted": [{"gameId": "g1"}]}
