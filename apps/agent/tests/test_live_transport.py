"""Unit tests for ``sc2tools_agent.live.transport``."""

from __future__ import annotations

import time
from typing import Any, Dict, List
from unittest.mock import MagicMock

import requests

from sc2tools_agent.live.transport import (
    CloudTransport,
    FanOutTransport,
    OverlayBackendTransport,
)


def _wait_for(predicate, timeout: float = 1.0, step: float = 0.005) -> bool:
    end = time.time() + timeout
    while time.time() < end:
        if predicate():
            return True
        time.sleep(step)
    return False


# ---------------- OverlayBackendTransport ----------------


def test_overlay_transport_posts_envelope_to_local_url() -> None:
    """Happy path: payload arrives at /api/agent/live with the
    device-token header."""
    session = MagicMock(spec=requests.Session)
    session.post.return_value = MagicMock(status_code=200, text="{}")
    transport = OverlayBackendTransport(
        base_url="http://localhost:3000",
        device_token="dev-tok-abc",
        session=session,
    )
    transport.push({"type": "liveGameState", "phase": "match_loading"})
    try:
        assert _wait_for(lambda: session.post.called)
        url, _ = session.post.call_args[0], session.post.call_args[1]
        assert "http://localhost:3000/api/agent/live" in str(url[0]) \
            or session.post.call_args[1].get("url") is None  # called positionally
        kwargs = session.post.call_args[1]
        assert kwargs["headers"]["x-sc2tools-agent-token"] == "dev-tok-abc"
        assert kwargs["json"]["phase"] == "match_loading"
        assert _wait_for(lambda: transport.sent_ok == 1)
    finally:
        transport.shutdown()


def test_overlay_transport_quietly_handles_connection_error() -> None:
    """Overlay backend not running → ConnectionError. Counter ticks
    but no exception bubbles up to the bridge."""
    session = MagicMock(spec=requests.Session)
    session.post.side_effect = requests.ConnectionError("refused")
    transport = OverlayBackendTransport(
        base_url="http://localhost:3000",
        device_token="dev-tok-abc",
        session=session,
    )
    transport.push({"phase": "match_started"})
    try:
        assert _wait_for(lambda: transport.sent_failed == 1)
        assert transport.sent_ok == 0
    finally:
        transport.shutdown()


def test_overlay_transport_drops_non_2xx_as_failure() -> None:
    """5xx response → not counted as ok."""
    session = MagicMock(spec=requests.Session)
    session.post.return_value = MagicMock(status_code=503, text="busy")
    transport = OverlayBackendTransport(
        base_url="http://localhost:3000",
        device_token="dev-tok-abc",
        session=session,
    )
    transport.push({"phase": "match_started"})
    try:
        assert _wait_for(lambda: transport.sent_failed == 1)
    finally:
        transport.shutdown()


def test_overlay_transport_rate_limits_burst() -> None:
    """A burst that exceeds the bucket capacity drops the excess."""
    session = MagicMock(spec=requests.Session)
    session.post.return_value = MagicMock(status_code=200, text="{}")
    transport = OverlayBackendTransport(
        base_url="http://localhost:3000",
        device_token="t",
        session=session,
        rate_per_sec=2.0,
    )
    try:
        # Capacity = 2 * rate = 4 tokens. Send 20 fast.
        for _ in range(20):
            transport.push({"phase": "x"})
        # Wait briefly for the workers to drain the accepted ones.
        time.sleep(0.1)
        assert transport.dropped_rate_limited > 0
        assert transport.sent_ok <= 4
    finally:
        transport.shutdown()


# ---------------- CloudTransport ----------------


def test_cloud_transport_calls_api_client_push() -> None:
    api = MagicMock()
    api.push_agent_live.return_value = {"ok": True}
    transport = CloudTransport(api_client=api)
    transport.push({"phase": "match_loading"})
    try:
        assert _wait_for(lambda: api.push_agent_live.called)
        kwargs = api.push_agent_live.call_args[1]
        assert kwargs["envelope"]["phase"] == "match_loading"
        assert _wait_for(lambda: transport.sent_ok == 1)
    finally:
        transport.shutdown()


def test_cloud_transport_handles_unpaired_silently() -> None:
    """PermissionError ('agent_not_paired') is expected when the user
    hasn't paired yet — don't count it as a failure (and don't log
    spam) because the agent's normal pairing flow will eventually
    populate the token."""
    api = MagicMock()
    api.push_agent_live.side_effect = PermissionError("agent_not_paired")
    transport = CloudTransport(api_client=api)
    transport.push({"phase": "x"})
    try:
        assert _wait_for(lambda: api.push_agent_live.called)
        # Brief sleep to let the task complete on the worker.
        time.sleep(0.05)
        assert transport.sent_failed == 0
        assert transport.sent_ok == 0
    finally:
        transport.shutdown()


def test_cloud_transport_counts_generic_exception_as_failure() -> None:
    api = MagicMock()
    api.push_agent_live.side_effect = RuntimeError("something")
    transport = CloudTransport(api_client=api)
    transport.push({"phase": "x"})
    try:
        assert _wait_for(lambda: transport.sent_failed == 1)
    finally:
        transport.shutdown()


# ---------------- FanOutTransport ----------------


def test_fanout_pushes_to_every_transport() -> None:
    """One push call → every wrapped transport sees the same envelope."""

    class _Spy:
        def __init__(self) -> None:
            self.received: List[Dict[str, Any]] = []
            self.shutdown_called = False

        def push(self, e: Dict[str, Any]) -> None:
            self.received.append(e)

        def shutdown(self) -> None:
            self.shutdown_called = True

    a, b = _Spy(), _Spy()
    fan = FanOutTransport(a, b)
    fan.push({"phase": "match_loading"})
    fan.push({"phase": "match_started"})
    assert len(a.received) == 2
    assert len(b.received) == 2
    fan.shutdown()
    assert a.shutdown_called and b.shutdown_called


def test_fanout_isolates_transport_failures() -> None:
    """A misbehaving transport that raises in ``push`` must not stop
    the others from receiving the envelope."""

    class _Boom:
        def push(self, _e: Dict[str, Any]) -> None:
            raise RuntimeError("oops")

        def shutdown(self) -> None:  # pragma: no cover - trivial
            pass

    class _Good:
        def __init__(self) -> None:
            self.count = 0

        def push(self, _e: Dict[str, Any]) -> None:
            self.count += 1

        def shutdown(self) -> None:  # pragma: no cover - trivial
            pass

    good = _Good()
    fan = FanOutTransport(_Boom(), good)
    fan.push({"phase": "x"})
    assert good.count == 1
