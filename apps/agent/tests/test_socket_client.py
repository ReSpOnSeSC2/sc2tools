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
from pathlib import Path
from typing import List

import pytest

from sc2tools_agent.socket_client import make_recompute_handlers
from sc2tools_agent.state import save_state, AgentState


def _write_state(state_dir: Path, *, path_by_game_id: dict) -> None:
    """Persist a minimal state file with a path_by_game_id index."""
    save_state(state_dir, AgentState(path_by_game_id=path_by_game_id))


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
