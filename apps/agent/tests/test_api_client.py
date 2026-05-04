"""Tests for the API client. Uses requests' built-in mock via responses-like
patching. We intentionally don't pull in another lib — patching `requests.request`
directly is cleaner for the small surface area we test."""

from __future__ import annotations

from typing import Any
from unittest.mock import patch, MagicMock

import pytest

from sc2tools_agent.api_client import ApiClient


def _mock_response(status: int, body: Any) -> MagicMock:
    m = MagicMock()
    m.status_code = status
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
