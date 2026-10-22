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

from sc2tools_agent.api_client import (
    ApiClient,
    ApiError,
    REPLAY_FILE_MAX_BYTES,
    ReplayArchiveSourceUnavailable,
    ReplayIngestBusy,
    replay_file_matches_archive_marker,
)


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


def test_patch_last_mmr_identifies_source_game() -> None:
    api = ApiClient(base_url="http://x", device_token="tok")
    with patch(
        "requests.request",
        return_value=_mock_response(200, {"ok": True, "wrote": True}),
    ) as request_mock:
        api.patch_last_mmr(
            mmr=4730,
            captured_at="2026-05-07T10:00:00Z",
            region="NA",
            game_id="2026-05-07T10:00:00|Opponent|Map|600",
        )

    args, kwargs = request_mock.call_args
    assert args[:2] == ("POST", "http://x/v1/me/last-mmr")
    assert kwargs["json"] == {
        "mmr": 4730,
        "capturedAt": "2026-05-07T10:00:00Z",
        "region": "NA",
        "gameId": "2026-05-07T10:00:00|Opponent|Map|600",
    }
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


def test_archive_marker_requires_exact_local_size_and_sha256(
    tmp_path: Path,
) -> None:
    replay = tmp_path / "identity.SC2Replay"
    payload = b"MPQ\x1bidentity"
    replay.write_bytes(payload)
    marker = {
        "available": True,
        "sizeBytes": len(payload),
        "sha256": hashlib.sha256(payload).hexdigest().upper(),
    }

    assert replay_file_matches_archive_marker(replay, marker)
    assert not replay_file_matches_archive_marker(
        replay,
        {**marker, "sizeBytes": len(payload) + 1},
    )
    assert not replay_file_matches_archive_marker(
        replay,
        {**marker, "sizeBytes": REPLAY_FILE_MAX_BYTES + 1},
    )
    assert not replay_file_matches_archive_marker(
        replay,
        {**marker, "sha256": "0" * 64},
    )
    assert not replay_file_matches_archive_marker(
        replay,
        {"available": True},
    )


@pytest.mark.parametrize("status", [404, 503])
def test_durable_archive_keeps_rollout_failures_retryable(
    tmp_path: Path,
    status: int,
) -> None:
    replay = tmp_path / "retry.SC2Replay"
    replay.write_bytes(b"MPQ\x1bdata")
    unavailable = _mock_response(status, {"error": {"code": "unavailable"}})
    api = ApiClient(base_url="http://x", device_token="tok")
    with patch("requests.request", return_value=unavailable), patch(
        "requests.put",
    ), patch("time.sleep"):
        with pytest.raises(Exception, match=f"http_{status}"):
            api.upload_replay_file_durable("g1", replay)


def test_durable_archive_treats_owned_game_deletion_as_terminal(
    tmp_path: Path,
) -> None:
    replay = tmp_path / "deleted-game.SC2Replay"
    replay.write_bytes(b"MPQ\x1bdata")
    missing = _mock_response(
        404,
        {"error": {"code": "game_not_found"}},
    )
    api = ApiClient(base_url="http://x", device_token="tok")

    with patch("requests.request", return_value=missing), patch(
        "requests.put",
    ) as put:
        assert api.upload_replay_file_durable("gone", replay) is False

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


def test_durable_archive_retries_missing_cloud_backed_local_file(
    tmp_path: Path,
) -> None:
    replay = tmp_path / "gone.SC2Replay"
    api = ApiClient(base_url="http://x", device_token="tok")

    with patch("requests.request") as request_mock:
        with pytest.raises(
            ReplayArchiveSourceUnavailable,
            match="replay_source_missing",
        ):
            api.upload_replay_file_durable("g-gone", replay)

    request_mock.assert_not_called()


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


def test_503_ingest_backpressure_yields_complete_batch_to_queue() -> None:
    """A full-sync batch rejected before parsing must remain retryable.

    The API's replay admission guard uses 503 + Retry-After instead of
    accepting work it cannot safely hold in memory. The client must return
    control after one response so the queue can retain the whole batch without
    posting the same large JSON three times or shrinking its adaptive ceiling.
    """
    api = ApiClient(base_url="http://x", device_token="tok")
    games = [{"gameId": "g1"}, {"gameId": "g2"}]
    busy = _mock_response(
        503,
        {"error": {"code": "replay_ingest_busy", "retryable": True}},
        headers={"Retry-After": "1"},
    )
    request_mock = MagicMock(return_value=busy)

    with patch("requests.request", request_mock):
        with pytest.raises(ReplayIngestBusy) as raised:
            api.upload_games_batch(games)

    assert raised.value.retry_after_seconds == 1.0
    assert request_mock.call_count == 1
    assert __import__("json").loads(request_mock.call_args_list[0].kwargs["data"]) == {"games": games}


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


# ---------------- Build check-in ----------------


def test_build_checkin_calls_require_pairing() -> None:
    api = ApiClient(base_url="http://x", device_token=None)
    with pytest.raises(PermissionError):
        api.get_build_options("PvZ")
    with pytest.raises(PermissionError):
        api.put_live_intent("A|B|1", {"action": "register"})
    with pytest.raises(PermissionError):
        api.get_checkin_prefs()


def test_build_options_is_interactive_and_encodes_matchup() -> None:
    api = ApiClient(base_url="http://x", device_token="tok")
    body = {"matchup": "PvZ", "builds": []}
    with patch("requests.request", return_value=_mock_response(200, body)) as m:
        assert api.get_build_options("PvZ") == body
    args, kwargs = m.call_args
    assert args == ("GET", "http://x/v1/build-intents/options?matchup=PvZ")
    assert kwargs["headers"]["authorization"] == "Bearer tok"
    assert kwargs["timeout"] == (5.0, 5.0)


def test_live_intent_path_encodes_the_whole_game_key() -> None:
    """Names with clan tags, spaces, slashes or accents stay one segment."""
    api = ApiClient(base_url="http://x", device_token="tok")
    key = "[TAG] Opp/1|Zoë#123|1717000000000"
    with patch("requests.request", return_value=_mock_response(200, {"gameKey": key})) as m:
        api.put_live_intent(key, {"action": "register", "myRace": "Protoss"})
        api.get_live_intent(key)
    put_args, put_kwargs = m.call_args_list[0]
    get_args, _ = m.call_args_list[1]
    expected = (
        "http://x/v1/build-intents/live/"
        "%5BTAG%5D%20Opp%2F1%7CZo%C3%AB%23123%7C1717000000000"
    )
    assert put_args == ("PUT", expected)
    assert put_kwargs["json"] == {"action": "register", "myRace": "Protoss"}
    assert get_args == ("GET", expected)


def test_game_intent_paths_and_include_options() -> None:
    api = ApiClient(base_url="http://x", device_token="tok")
    game_id = "2026-10-22T18:00:00|Opp|Map/One|842"
    with patch("requests.request", return_value=_mock_response(200, {"status": "pending"})) as m:
        api.get_game_intent(game_id)
        api.get_game_intent(game_id, include_options=True)
        api.put_game_intent(game_id, {"action": "notes", "notes": "x"})
    encoded = "2026-10-22T18%3A00%3A00%7COpp%7CMap%2FOne%7C842"
    calls = [call.args for call in m.call_args_list]
    assert calls == [
        ("GET", f"http://x/v1/games/{encoded}/build-intent"),
        ("GET", f"http://x/v1/games/{encoded}/build-intent?include=options"),
        ("PUT", f"http://x/v1/games/{encoded}/build-intent"),
    ]
    assert m.call_args_list[2].kwargs["json"] == {"action": "notes", "notes": "x"}


def test_checkin_prefs_round_trip() -> None:
    api = ApiClient(base_url="http://x", device_token="tok")
    prefs = {"enabled": True, "askAtLoading": False, "askAfterGame": True}
    with patch("requests.request", return_value=_mock_response(200, prefs)) as m:
        assert api.get_checkin_prefs() == prefs
        assert api.put_checkin_prefs(prefs) == prefs
    assert [call.args for call in m.call_args_list] == [
        ("GET", "http://x/v1/me/preferences/buildCheckin"),
        ("PUT", "http://x/v1/me/preferences/buildCheckin"),
    ]
    assert m.call_args_list[1].kwargs["json"] == prefs


def test_interactive_call_fails_fast_on_server_error() -> None:
    import time as _time

    api = ApiClient(base_url="http://x", device_token="tok")
    sleeps: list[float] = []
    failing = _mock_response(503, {"error": {"code": "unavailable"}})
    with patch("requests.request", return_value=failing) as m, \
            patch.object(_time, "sleep", sleeps.append):
        with pytest.raises(ApiError) as raised:
            api.get_live_intent("A|B|1")
    assert m.call_count == 1
    assert sleeps == []
    assert raised.value.status == 503


def test_interactive_declare_retries_once_with_short_backoff() -> None:
    import time as _time

    api = ApiClient(base_url="http://x", device_token="tok")
    sleeps: list[float] = []
    responses = [
        _mock_response(502, None),
        _mock_response(200, {"declared": {"key": "k"}}),
    ]
    with patch("requests.request", side_effect=responses) as m, \
            patch.object(_time, "sleep", sleeps.append):
        out = api.put_live_intent(
            "A|B|1", {"action": "declare", "buildKey": "k"}, attempts=2,
        )
    assert out == {"declared": {"key": "k"}}
    assert m.call_count == 2
    assert sleeps == [0.5]


def test_interactive_call_never_waits_out_a_rate_limit() -> None:
    import time as _time

    api = ApiClient(base_url="http://x", device_token="tok")
    sleeps: list[float] = []
    limited = _mock_response(
        429, {"error": {"code": "rate_limited"}}, headers={"Retry-After": "30"},
    )
    with patch("requests.request", return_value=limited) as m, \
            patch.object(_time, "sleep", sleeps.append):
        with pytest.raises(ApiError):
            api.put_live_intent("A|B|1", {"action": "declare"}, attempts=2)
    assert m.call_count == 1
    assert sleeps == []


def test_interactive_transport_error_does_not_sleep_after_last_attempt() -> None:
    import time as _time

    import requests as _requests

    api = ApiClient(base_url="http://x", device_token="tok")
    sleeps: list[float] = []
    with patch(
        "requests.request", side_effect=_requests.ConnectionError("offline"),
    ) as m, patch.object(_time, "sleep", sleeps.append):
        with pytest.raises(_requests.ConnectionError):
            api.get_checkin_prefs()
    assert m.call_count == 1
    assert sleeps == []


def test_api_error_exposes_structured_conflict_details() -> None:
    api = ApiClient(base_url="http://x", device_token="tok")
    conflict = _mock_response(409, {"error": {
        "code": "already_bound", "message": "bound", "gameId": "g-1",
    }})
    with patch("requests.request", return_value=conflict):
        with pytest.raises(ApiError) as raised:
            api.put_live_intent("A|B|1", {"action": "postgame", "skip": True})
    assert raised.value.status == 409
    assert raised.value.code == "already_bound"
    assert raised.value.error["gameId"] == "g-1"


def test_api_error_code_tolerates_unstructured_bodies() -> None:
    assert ApiError(500, "<html>").code is None
    assert ApiError(400, '{"error": "nope"}').error == {}
    assert ApiError(400, '[1, 2]').code is None


def test_default_requests_keep_three_attempts() -> None:
    """The new knobs leave every existing caller's retry budget alone."""
    import time as _time

    api = ApiClient(base_url="http://x", device_token="tok")
    with patch("requests.request", return_value=_mock_response(500, None)) as m, \
            patch.object(_time, "sleep", lambda _s: None):
        with pytest.raises(ApiError):
            api.get_profile()
    assert m.call_count == 3
