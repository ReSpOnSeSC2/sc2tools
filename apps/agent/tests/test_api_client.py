"""Tests for the API client. Uses requests' built-in mock via responses-like
patching. We intentionally don't pull in another lib — patching `requests.request`
directly is cleaner for the small surface area we test."""

from __future__ import annotations

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
