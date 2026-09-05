"""Tests for the socket-driven recompute callbacks.

The actual ``SocketClient`` class is wired against ``python-socketio``
which we don't import here (no need for a live server in unit tests).
What we DO test is ``make_recompute_handlers`` — the pure function that
returns the three callables hooked up to the Socket.io events. Those
callables embed the policy decisions:

  * Targeted single-game recompute → re-parse just that file when known.
  * Bulk recompute (>= 5 gameIds) with no local matches → fall back to
    a full resync. This is the rescue path for users on agent state
    files that pre-date ``path_by_game_id``.
  * Explicit ``resync:request`` → run the full resync directly.
"""

from __future__ import annotations

import json
import threading
from pathlib import Path
from typing import List

import pytest

from sc2tools_agent.socket_client import make_recompute_handlers
from sc2tools_agent.state import save_state, AgentState


def _write_state(state_dir: Path, *, path_by_game_id: dict, capture_enabled: bool = False) -> None:
    """Persist a minimal state file with a path_by_game_id index."""
    save_state(state_dir, AgentState(path_by_game_id=path_by_game_id, replay_capture_enabled=capture_enabled))


def test_on_macro_resolves_paths_from_state(tmp_path: Path) -> None:
    """Happy path: gameIds mapped via path_by_game_id route to queue_resync."""
    replay = tmp_path / "g1.SC2Replay"
    replay.write_text("not really an sc2 replay")
    _write_state(tmp_path, path_by_game_id={"g1": str(replay)})

    queued: List[List[Path]] = []
    full_resync_calls: List[None] = []
    on_macro, _on_opp, _on_full = make_recompute_handlers(
        state_dir=tmp_path,
        queue_resync_for_paths=queued.append,
        full_resync=lambda: full_resync_calls.append(None),
    )

    on_macro(["g1"])
    assert queued == [[replay]]
    assert full_resync_calls == []


def test_on_macro_skips_when_single_unknown_game(tmp_path: Path) -> None:
    """One missing gameId is NOT a bulk-backfill signal; don't full-resync."""
    _write_state(tmp_path, path_by_game_id={})

    queued: List[List[Path]] = []
    full_resync_calls: List[None] = []
    on_macro, _on_opp, _on_full = make_recompute_handlers(
        state_dir=tmp_path,
        queue_resync_for_paths=queued.append,
        full_resync=lambda: full_resync_calls.append(None),
    )

    on_macro(["unknown_game"])
    # Neither path queued nor full-resync triggered — exactly the
    # behaviour we want for a stale single-game request.
    assert queued == []
    assert full_resync_calls == []


def test_on_macro_falls_back_to_full_resync_for_bulk_request(
    tmp_path: Path,
) -> None:
    """Bulk request (>=5 gameIds) with zero local matches → full resync.

    Reproduces the bug the v0.4 user-with-old-state hit: cloud emits
    `macro:recompute_request` with all 200+ gameIds, agent's
    path_by_game_id is empty (predates the index), and the request
    used to silently no-op. The new behaviour is to fall back to a
    full resync so the agent re-walks every replay folder.
    """
    _write_state(tmp_path, path_by_game_id={})

    queued: List[List[Path]] = []
    full_resync_calls: List[None] = []
    on_macro, _on_opp, _on_full = make_recompute_handlers(
        state_dir=tmp_path,
        queue_resync_for_paths=queued.append,
        full_resync=lambda: full_resync_calls.append(None),
    )

    on_macro([f"g{i}" for i in range(50)])
    assert queued == []
    assert full_resync_calls == [None]


def test_on_macro_no_fallback_when_full_resync_is_none(tmp_path: Path) -> None:
    """If no fallback was wired, on_macro stays silent — no crash."""
    _write_state(tmp_path, path_by_game_id={})

    queued: List[List[Path]] = []
    on_macro, _on_opp, on_full = make_recompute_handlers(
        state_dir=tmp_path,
        queue_resync_for_paths=queued.append,
        full_resync=None,
    )

    # Should not raise.
    on_macro([f"g{i}" for i in range(10)])
    assert queued == []
    # And on_full_resync is still callable but no-ops with the missing
    # callable — used to log a "dropped" line.
    on_full("test_reason")  # no exception expected


def test_on_full_resync_invokes_callable(tmp_path: Path) -> None:
    """`resync:request` event handler runs full_resync regardless of state."""
    # Even with a populated index, a full-resync request should run a
    # full sweep — that's the explicit user intent.
    _write_state(
        tmp_path,
        path_by_game_id={"g1": str(tmp_path / "g1.SC2Replay")},
    )

    captured: List[str | None] = []
    full_resync_calls: List[None] = []
    queued: List[List[Path]] = []
    _on_macro, _on_opp, on_full = make_recompute_handlers(
        state_dir=tmp_path,
        queue_resync_for_paths=queued.append,
        full_resync=lambda: full_resync_calls.append(None),
    )

    on_full("map_intel_request_resync")
    assert full_resync_calls == [None]
    assert queued == []


def test_on_macro_full_resync_swallows_exceptions(tmp_path: Path) -> None:
    """A throwing full_resync callable doesn't break the socket loop."""
    _write_state(tmp_path, path_by_game_id={})

    def _boom() -> None:
        raise RuntimeError("simulated failure")

    on_macro, _on_opp, on_full = make_recompute_handlers(
        state_dir=tmp_path,
        queue_resync_for_paths=lambda paths: None,
        full_resync=_boom,
    )

    # Both entry points must catch the exception so the python-socketio
    # event loop isn't left in a broken state.
    on_macro([f"g{i}" for i in range(20)])
    on_full("explicit")  # should not raise either


def test_engine_rebuild_reports_missing_replay_without_queueing(tmp_path: Path) -> None:
    _write_state(tmp_path, path_by_game_id={})
    queued = []
    on_macro, _, _ = make_recompute_handlers(state_dir=tmp_path, queue_resync_for_paths=queued.append)
    assert on_macro(["missing"], replay_fidelity="engine") == {"ok": False, "code": "replay_not_found"}
    assert queued == []


def test_engine_rebuild_captures_before_queueing_and_reports_upload(tmp_path: Path) -> None:
    replay = tmp_path / "engine.SC2Replay"
    replay.write_text("test replay")
    _write_state(tmp_path, path_by_game_id={"engine": str(replay)}, capture_enabled=True)
    order = []
    done = threading.Event()

    def status(update):
        order.append(update["status"])
        if update["status"] == "complete":
            done.set()

    on_macro, _, _ = make_recompute_handlers(
        state_dir=tmp_path, engine_capture=lambda path: order.append(("capture", path)),
        queue_resync_for_paths=lambda paths: order.append(("queue", paths)),
        upload_monitor=lambda _path, _previous: None,
    )
    assert on_macro(["engine"], replay_fidelity="engine", report_status=status)["ok"]
    assert done.wait(2)
    assert order == ["processing", ("capture", replay), ("queue", [replay]), "uploading", "complete"]


def test_engine_capture_failure_does_not_upload_tracker_fallback_as_success(tmp_path: Path) -> None:
    replay = tmp_path / "bad.SC2Replay"
    replay.write_text("test replay")
    _write_state(tmp_path, path_by_game_id={"bad": str(replay)}, capture_enabled=True)
    failed = threading.Event()
    updates, queued = [], []

    def capture(_path):
        raise RuntimeError("Required StarCraft build is unavailable")

    def status(update):
        updates.append(update)
        if update["status"] == "failed":
            failed.set()

    on_macro, _, _ = make_recompute_handlers(state_dir=tmp_path, engine_capture=capture, queue_resync_for_paths=queued.append)
    assert on_macro(["bad"], replay_fidelity="engine", report_status=status)["ok"]
    assert failed.wait(2)
    assert queued == []
    assert updates[-1]["code"] == "engine_capture_failed"
    assert "StarCraft build" in updates[-1]["message"]


def test_disabled_capture_is_rejected_before_dispatch_but_normal_recompute_works(tmp_path, monkeypatch):
    from unittest.mock import Mock
    from sc2tools_agent import replay_capture
    replay = tmp_path / "game.SC2Replay"
    replay.write_bytes(b"replay")
    _write_state(tmp_path, path_by_game_id={"game": str(replay)})
    monkeypatch.setattr(replay_capture, "_prepare_capture", Mock(side_effect=ValueError("no saved recording")))
    capture, queued = Mock(), []
    on_macro, _, _ = make_recompute_handlers(state_dir=tmp_path, engine_capture=capture,
        queue_resync_for_paths=queued.append)
    result = on_macro(["game"], replay_fidelity="engine")
    assert result["ok"] is False and result["code"] == "replay_capture_disabled"
    assert "Settings > Map replay" in result["message"]
    capture.assert_not_called()
    assert queued == []
    on_macro(["game"])
    assert queued == [[replay]]
    capture.assert_not_called()


def test_setting_changed_after_dispatch_prevents_capture(tmp_path, monkeypatch):
    from unittest.mock import Mock
    from sc2tools_agent import socket_client
    replay = tmp_path / "game.SC2Replay"
    replay.write_bytes(b"replay")
    _write_state(tmp_path, path_by_game_id={"game": str(replay)}, capture_enabled=True)
    capture, updates = Mock(), []
    class PausedThread:
        def __init__(self, target, **_kwargs):
            self.target = target
        def start(self):
            _write_state(tmp_path, path_by_game_id={"game": str(replay)}, capture_enabled=False)
            self.target()
    monkeypatch.setattr(socket_client.threading, "Thread", PausedThread)
    on_macro, _, _ = make_recompute_handlers(state_dir=tmp_path, engine_capture=capture,
        queue_resync_for_paths=lambda _: pytest.fail("disabled capture queued an upload"))
    assert on_macro(["game"], replay_fidelity="engine", report_status=updates.append)["ok"]
    capture.assert_not_called()
    assert updates[-1]["status"] == "failed" and updates[-1]["code"] == "replay_capture_disabled"


def test_dedicated_capture_event_forces_opt_in_handler_and_keeps_legacy_guard():
    import asyncio
    from unittest.mock import Mock
    from sc2tools_agent.socket_client import SocketClient
    class Sio:
        def __init__(self):
            self.handlers = {}
        def event(self, fn):
            return fn
        def on(self, name):
            def decorate(fn):
                self.handlers[name] = fn
                return fn
            return decorate
    callback = Mock(return_value={"ok": False, "code": "replay_capture_disabled"})
    client = SocketClient(base_url="https://example.test", device_token="test",
        on_recompute_games=callback, on_recompute_opp_build=lambda _: None)
    client._sio = Sio()
    client._wire_handlers()
    payload = {"gameIds": ["game"], "requestId": "request", "replayFidelity": "tracker"}
    result = asyncio.run(client._sio.handlers["map-playback:recompute_request"](payload))
    assert result["code"] == "replay_capture_disabled"
    assert callback.call_args.kwargs["replay_fidelity"] == "engine"
    result = asyncio.run(client._sio.handlers["macro:recompute_request"]({**payload, "replayFidelity": "engine"}))
    assert result["code"] == "replay_capture_disabled"
    assert callback.call_count == 2
