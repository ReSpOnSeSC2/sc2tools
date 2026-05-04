"""Tests for sc2tools_agent.uploader.queue (pause + resync additions)."""

from __future__ import annotations

import time
from pathlib import Path
from typing import Any, Dict, List

from sc2tools_agent.config import AgentConfig
from sc2tools_agent.replay_pipeline import CloudGame
from sc2tools_agent.state import AgentState
from sc2tools_agent.uploader.queue import UploadJob, UploadQueue


class _StubApi:
    def __init__(self) -> None:
        self.calls: List[Dict[str, Any]] = []

    def upload_game(self, payload: Dict[str, Any]) -> Dict[str, Any]:
        self.calls.append(payload)
        return {"accepted": [{"gameId": payload["gameId"], "created": True}]}


def _cfg(tmp_path: Path) -> AgentConfig:
    return AgentConfig(
        api_base="http://localhost:0",
        state_dir=tmp_path,
        replay_folder=None,
        poll_interval_sec=10,
        parse_concurrency=1,
    )


def _game(tmp_path: Path, name: str) -> UploadJob:
    fp = tmp_path / name
    fp.write_bytes(b"")
    cloud = CloudGame(
        game_id=f"id-{name}",
        date_iso="2026-04-01T00:00:00Z",
        result="Victory",
        my_race="Protoss",
        my_build="P - Stargate",
        map_name="Goldenaura",
        duration_sec=600,
        macro_score=80.0,
        apm=140.0,
        spq=10.0,
        opponent={"displayName": "Foo", "race": "Z"},
        build_log=[],
        early_build_log=[],
        opp_early_build_log=[],
        opp_build_log=[],
    )
    return UploadJob(file_path=fp, game=cloud)


def test_set_paused_persists_state_and_skips_uploads(tmp_path: Path) -> None:
    state = AgentState(device_token="t")
    api = _StubApi()
    q = UploadQueue(cfg=_cfg(tmp_path), state=state, api=api)
    q.set_paused(True)
    assert q.is_paused()
    q.start()
    try:
        q.submit(_game(tmp_path, "a.SC2Replay"))
        # Give the worker thread a few ticks to (not) process the job.
        time.sleep(0.5)
        assert api.calls == []
        # Resume + the job should drain.
        q.set_paused(False)
        time.sleep(1.0)
        assert len(api.calls) == 1
    finally:
        q.stop()


def test_resync_event_can_be_acknowledged(tmp_path: Path) -> None:
    state = AgentState(device_token="t")
    q = UploadQueue(cfg=_cfg(tmp_path), state=state, api=_StubApi())
    assert not q.is_resync_requested()
    q.request_full_resync()
    assert q.is_resync_requested()
    q.acknowledge_resync()
    assert not q.is_resync_requested()


def test_default_paused_picks_up_state(tmp_path: Path) -> None:
    state = AgentState(device_token="t", paused=True)
    q = UploadQueue(cfg=_cfg(tmp_path), state=state, api=_StubApi())
    assert q.is_paused()
