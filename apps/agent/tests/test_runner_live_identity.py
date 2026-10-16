"""Live identity follows replay cache repairs and Settings changes."""

from __future__ import annotations

import logging
from pathlib import Path
from types import SimpleNamespace

import pytest

from sc2tools_agent import runner
from sc2tools_agent.config import AgentConfig
from sc2tools_agent.live.types import (
    LiveGameState,
    LiveLifecycleEvent,
    LiveLifecyclePhase,
    LivePlayer,
)
from sc2tools_agent.player_handle import read_cache, write_cache
from sc2tools_agent.state import AgentState
from sc2tools_agent.ui import SettingsPayload


_LOG = logging.getLogger("test_runner_live_identity")


class _NoPulse:
    def resolve(self, **_hints):
        return None


@pytest.fixture
def build_live_stack(monkeypatch, tmp_path):
    monkeypatch.delenv("SC2TOOLS_PLAYER_CONFIG", raising=False)
    monkeypatch.delenv("SC2TOOLS_PLAYER_HANDLE", raising=False)
    monkeypatch.delenv("SC2TOOLS_LOCAL_OVERLAY_URL", raising=False)
    monkeypatch.setattr(runner, "PulseClient", _NoPulse)
    stacks = []

    def build(initial_hint=None, replay_folders=None):
        bus, poller, bridge, transport, metrics = runner._build_live_bridge(
            user_name_hint=initial_hint,
            state_dir=tmp_path,
            replay_folders=replay_folders,
            log=_LOG,
        )
        assert transport is None
        seen = []
        bridge.bus.subscribe(seen.append)
        bridge.start()
        stacks.append((poller, bridge, metrics))
        return bus, poller, bridge, seen

    yield build
    for poller, bridge, metrics in stacks:
        poller.stop()
        bridge.stop()
        metrics.stop()


def _active_event(
    display_time=1.0, *,
    opponent_name="ActualOpponent", user_name="karpidis",
):
    return LiveLifecycleEvent(
        phase=LiveLifecyclePhase.MATCH_IN_PROGRESS,
        game_key="ActualOpponent|karpidis|1717000000000",
        game_state=LiveGameState(
            display_time=display_time,
            players=[
                LivePlayer(opponent_name, "user", "Zerg", "Undecided"),
                LivePlayer(user_name, "user", "Protoss", "Undecided"),
            ],
        ),
    )


def test_replay_cache_repair_precedes_bridge_handling_next_event(
    build_live_stack, tmp_path: Path,
):
    write_cache(tmp_path, "StaleAccountName")
    bus, poller, bridge, seen = build_live_stack()
    bus.publish(_active_event())

    # The post-game replay parser repairs this same cache after resolving
    # the replay owner's toon. The running Live stack must pick it up.
    write_cache(tmp_path, "karpidis")
    seen.clear()
    bus.publish(_active_event(2.0))

    assert poller._user_name_hint == "karpidis"
    assert bridge._user_name_hint == "karpidis"
    assert seen[0]["user"] == {"name": "karpidis", "race": "Protoss"}
    assert seen[0]["opponent"]["name"] == "ActualOpponent"


@pytest.mark.parametrize("fallback", [None, "ActualOpponent"])
def test_settings_clear_refreshes_live_hint_and_honors_env_fallback(
    build_live_stack, tmp_path: Path, monkeypatch, fallback,
):
    write_cache(tmp_path, "karpidis")
    if fallback is not None:
        monkeypatch.setenv("SC2TOOLS_PLAYER_HANDLE", fallback)
    bus, poller, bridge, seen = build_live_stack()
    bus.publish(_active_event())

    cfg = AgentConfig(
        api_base="http://localhost:0",
        state_dir=tmp_path,
        replay_folder=None,
        poll_interval_sec=10,
        parse_concurrency=1,
    )
    runner._handle_save_settings(
        cfg, AgentState(), SettingsPayload(player_handle=""),
        SimpleNamespace(upload=None, watcher=None, tray=None, gui=None), _LOG,
    )
    seen.clear()
    bus.publish(_active_event(2.0))

    assert poller._user_name_hint == fallback
    assert bridge._user_name_hint == fallback
    if fallback is not None:
        assert seen[0]["user"]["name"] == fallback
        assert seen[0]["opponent"]["name"] == "karpidis"
    else:
        assert not seen[0].get("opponent", {}).get("name")
        assert "user" not in seen[0]


def test_env_identity_is_available_before_first_live_event(
    build_live_stack, monkeypatch,
):
    monkeypatch.setenv("SC2TOOLS_PLAYER_HANDLE", "karpidis")
    bus, poller, _bridge, seen = build_live_stack(initial_hint="OldStartupName")
    assert poller._user_name_hint == "karpidis"

    bus.publish(_active_event())

    assert seen[0]["user"]["name"] == "karpidis"
    assert seen[0]["opponent"]["name"] == "ActualOpponent"


def test_replay_identity_resolves_first_game_when_cloud_name_does_not_match(
    build_live_stack, tmp_path: Path, monkeypatch,
):
    write_cache(tmp_path, "CloudAccountName")
    folders = [tmp_path / "Replays"]
    scans = []

    def detect(replay_folders):
        scans.append(replay_folders)
        return "karpidis"

    monkeypatch.setattr(runner, "auto_detect_from_replays", detect)
    bus, poller, _bridge, seen = build_live_stack(replay_folders=folders)
    bus.publish(_active_event())
    bus.publish(_active_event(2.0))

    assert seen[0]["user"] == {"name": "karpidis", "race": "Protoss"}
    assert seen[0]["opponent"]["name"] == "ActualOpponent"
    assert poller._user_name_hint == "karpidis"
    assert scans == [folders]
    assert read_cache(tmp_path) == "CloudAccountName"


def test_matching_primary_name_takes_precedence_over_replay_identity(
    build_live_stack, tmp_path: Path, monkeypatch,
):
    write_cache(tmp_path, "karpidis")
    monkeypatch.setattr(
        runner, "auto_detect_from_replays", lambda _folders: "ActualOpponent",
    )
    bus, _poller, _bridge, seen = build_live_stack(
        replay_folders=[tmp_path / "Replays"],
    )

    bus.publish(_active_event())

    assert seen[0]["user"]["name"] == "karpidis"
    assert seen[0]["opponent"]["name"] == "ActualOpponent"


def test_ambiguous_replay_name_does_not_pick_a_live_player(
    build_live_stack, tmp_path: Path, monkeypatch,
):
    write_cache(tmp_path, "CloudAccountName")
    monkeypatch.setattr(
        runner, "auto_detect_from_replays", lambda _folders: "karpidis",
    )
    bus, _poller, _bridge, seen = build_live_stack(
        replay_folders=[tmp_path / "Replays"],
    )

    bus.publish(_active_event(
        opponent_name="[One] karpidis", user_name="[Two] karpidis",
    ))

    assert not seen[0].get("opponent", {}).get("name")
    assert "user" not in seen[0]


def test_replay_detection_failure_keeps_live_identity_unresolved(
    build_live_stack, tmp_path: Path, monkeypatch,
):
    write_cache(tmp_path, "CloudAccountName")

    def detect(_folders):
        raise OSError("Replay folder unavailable")

    monkeypatch.setattr(runner, "auto_detect_from_replays", detect)
    bus, _poller, _bridge, seen = build_live_stack(
        replay_folders=[tmp_path / "Replays"],
    )

    bus.publish(_active_event())

    assert not seen[0].get("opponent", {}).get("name")
    assert "user" not in seen[0]
