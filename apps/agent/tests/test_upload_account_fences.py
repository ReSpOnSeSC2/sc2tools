from dataclasses import replace
import hashlib
import threading
import time
from unittest.mock import Mock

import pytest

from sc2tools_agent.state import AgentState, _STATE_SAVE_LOCK
from sc2tools_agent.uploader.archive_journal import ReplayArchiveJournal, ReplayArchiveTask
from sc2tools_agent.uploader.queue import UploadQueue, _UploadSessionChanged
from tests.test_upload_queue import _cfg, _game, _StubApi, _wait_for


def accepted(job):
    return {"gameId": job.game.game_id, "replayArchive": {
        "available": True, "sizeBytes": 1, "sha256": hashlib.sha256(b"x").hexdigest()}}


def switch(upload_queue, state, api, owner="owner-b", token="token-b"):
    with _STATE_SAVE_LOCK:
        state.user_id, state.device_token = owner, token
        upload_queue.replace_api(api)


@pytest.mark.parametrize("mode", ["single", "batch"])
@pytest.mark.parametrize("response", ["accepted", "failed"])
def test_inflight_old_owner_response_cannot_advance_cursor_or_new_account(tmp_path, mode, response):
    state = AgentState(user_id="owner-a", device_token="token-a")
    new_api = _StubApi()
    checkin, summaries, success = Mock(), Mock(), Mock()
    job = replace(_game(tmp_path, "private.SC2Replay", my_mmr=5161), priority=True)
    job.file_path.write_bytes(b"x")

    class OldApi(_StubApi):
        def upload_game(self, payload):
            switch(upload_queue, state, new_api)
            if response == "failed":
                raise ConnectionError("fixture old connection")
            return {"accepted": [accepted(job)]}

        def upload_games_batch(self, payloads):
            return self.upload_game(payloads[0])

    upload_queue = UploadQueue(cfg=_cfg(tmp_path), state=state, api=OldApi(),
        on_game_accepted=checkin, on_game_synced=summaries, on_success=success)
    with pytest.raises(_UploadSessionChanged):
        (upload_queue._upload_one(job) if mode == "single" else upload_queue._upload_batch([job]))
    assert state.uploaded == {} and state.path_by_game_id == {}
    assert state.last_known_mmr is None
    assert upload_queue._archive_journal.pending_count() == 0
    assert not new_api.calls and not new_api.mmr_calls
    checkin.assert_not_called()
    summaries.assert_not_called()
    success.assert_not_called()
    assert job.file_path.read_bytes() == b"x"


@pytest.mark.parametrize("same_owner", [False, True])
def test_worker_retries_only_same_owner_after_api_replacement(tmp_path, same_owner):
    entered, release = threading.Event(), threading.Event()
    state = AgentState(user_id="owner-a", device_token="token-a")
    new_api = _StubApi()
    job = _game(tmp_path, "pending.SC2Replay")
    job.file_path.write_bytes(b"x")

    class OldApi(_StubApi):
        def upload_games_batch(self, payloads):
            entered.set()
            assert release.wait(3)
            return {"accepted": [accepted(job)]}

    upload_queue = UploadQueue(cfg=_cfg(tmp_path), state=state, api=OldApi())
    upload_queue.submit(job)
    upload_queue.start()
    try:
        assert entered.wait(2)
        switch(upload_queue, state, new_api, owner="owner-a" if same_owner else "owner-b")
        release.set()
        assert _wait_for(lambda: not upload_queue.is_pending(job.file_path))
        assert bool(new_api.calls) is same_owner
        assert (str(job.file_path) in state.uploaded) is same_owner
    finally:
        release.set()
        upload_queue.stop()


def test_queued_private_work_is_not_retargeted_to_another_owner(tmp_path):
    state = AgentState(user_id="owner-a", device_token="token-a")
    upload_queue = UploadQueue(cfg=_cfg(tmp_path), state=state, api=_StubApi())
    job = _game(tmp_path, "queued.SC2Replay")
    upload_queue.submit(job)
    new_api = _StubApi()
    switch(upload_queue, state, new_api)
    upload_queue.start()
    try:
        assert _wait_for(lambda: not upload_queue.is_pending(job.file_path))
        assert not new_api.calls and state.uploaded == {}
    finally:
        upload_queue.stop()


def test_queued_work_is_not_retargeted_to_another_api_base(tmp_path):
    state = AgentState(user_id="owner-a", device_token="token-a")
    first_api = _StubApi()
    first_api.base_url = "https://first.example.test"
    upload_queue = UploadQueue(cfg=_cfg(tmp_path), state=state, api=first_api)
    job = _game(tmp_path, "queued-base.SC2Replay")
    upload_queue.submit(job)
    new_api = _StubApi()
    new_api.base_url = "https://second.example.test"
    upload_queue.replace_api(new_api)
    upload_queue.start()
    try:
        assert _wait_for(lambda: not upload_queue.is_pending(job.file_path))
        assert not new_api.calls and state.uploaded == {}
    finally:
        upload_queue.stop()


def test_mmr_response_does_not_mutate_new_owner_state(tmp_path):
    state = AgentState(user_id="owner-a", device_token="token-a")
    new_api = _StubApi()
    class OldApi(_StubApi):
        def patch_last_mmr(self, **kwargs):
            switch(upload_queue, state, new_api)
            return {"ok": True}
    upload_queue = UploadQueue(cfg=_cfg(tmp_path), state=state, api=OldApi())
    upload_queue._maybe_push_last_mmr(_game(tmp_path, "mmr.SC2Replay", my_mmr=5161))
    assert state.last_known_mmr is None and not new_api.mmr_calls


def test_archive_owner_key_survives_restart_and_ack_is_owner_specific(tmp_path):
    path = tmp_path / "private.SC2Replay"
    first = ReplayArchiveTask(path, "same-game", "owner-a")
    second = ReplayArchiveTask(path, "same-game", "owner-b")
    journal = ReplayArchiveJournal(tmp_path)
    journal.enqueue_many([first, second])
    restarted = ReplayArchiveJournal(tmp_path)
    assert restarted.next_tasks(excluded=set(), limit=10, owner="owner-a") == [first]
    assert restarted.next_tasks(excluded=set(), limit=10, owner="owner-b") == [second]
    restarted.acknowledge_many([second], durable=True)
    final = ReplayArchiveJournal(tmp_path)
    assert final.contains(first) and not final.contains(second)
    final._compact_locked()
    assert ReplayArchiveJournal(tmp_path).contains(first)


@pytest.mark.parametrize("proof", [None, "different-game", "legacy-game"])
def test_legacy_archive_requires_exact_owned_game_before_upload(tmp_path, monkeypatch, proof):
    monkeypatch.setattr("sc2tools_agent.uploader.queue._ARCHIVE_IDLE_GRACE_SEC", 0)
    task = ReplayArchiveTask(tmp_path / "legacy.SC2Replay", "legacy-game")
    task.file_path.write_bytes(b"x")
    ReplayArchiveJournal(tmp_path).enqueue_many([task])
    looked_up, archived = threading.Event(), []
    class Api(_StubApi):
        def get_game_summary(self, game_id):
            looked_up.set()
            return {"gameId": proof} if proof is not None else {}
        def upload_replay_file_durable(self, game_id, file_path):
            archived.append(game_id)
            return True
    upload_queue = UploadQueue(cfg=_cfg(tmp_path), state=AgentState(user_id="owner-a", device_token="a"), api=Api())
    upload_queue.start()
    try:
        assert looked_up.wait(2)
        if proof == "legacy-game":
            assert _wait_for(lambda: archived == ["legacy-game"])
        else:
            time.sleep(.1)
            assert archived == [] and upload_queue._archive_journal.contains(task)
    finally:
        upload_queue.stop()


def test_foreign_archive_is_retained_across_restart_and_finishes_for_its_owner(tmp_path, monkeypatch):
    monkeypatch.setattr("sc2tools_agent.uploader.queue._ARCHIVE_IDLE_GRACE_SEC", 0)
    class Api(_StubApi):
        def __init__(self):
            super().__init__()
            self.archived = []
        def upload_replay_file_durable(self, game_id, path):
            self.archived.append(game_id)
            return True
    first_api = Api()
    first = UploadQueue(cfg=_cfg(tmp_path), state=AgentState(user_id="owner-a", device_token="a"), api=first_api)
    task = ReplayArchiveTask(tmp_path / "owned.SC2Replay", "game-a", first._archive_owner(first._upload_context()))
    task.file_path.write_bytes(b"x")
    first._archive_journal.enqueue_many([task])
    second_api = Api()
    second = UploadQueue(cfg=_cfg(tmp_path), state=AgentState(user_id="owner-b", device_token="b"), api=second_api)
    second.start()
    try:
        time.sleep(.15)
        assert not second_api.archived
        assert second._archive_journal.contains(task)
    finally:
        second.stop()
    first.start()
    try:
        assert _wait_for(lambda: first_api.archived == ["game-a"])
        assert _wait_for(lambda: not first._archive_journal.contains(task))
    finally:
        first.stop()


def test_running_archive_response_after_owner_change_is_not_acknowledged(tmp_path, monkeypatch):
    monkeypatch.setattr("sc2tools_agent.uploader.queue._ARCHIVE_IDLE_GRACE_SEC", 0)
    entered, release = threading.Event(), threading.Event()
    state = AgentState(user_id="owner-a", device_token="a")
    class Api(_StubApi):
        def upload_replay_file_durable(self, game_id, path):
            entered.set()
            assert release.wait(3)
            return True
    upload_queue = UploadQueue(cfg=_cfg(tmp_path), state=state, api=Api())
    task = ReplayArchiveTask(tmp_path / "inflight.SC2Replay", "game-a", upload_queue._archive_owner(upload_queue._upload_context()))
    task.file_path.write_bytes(b"x")
    upload_queue._archive_journal.enqueue_many([task])
    new_api = _StubApi()
    upload_queue.start()
    try:
        assert entered.wait(2)
        switch(upload_queue, state, new_api)
        release.set()
        time.sleep(.1)
        assert upload_queue._archive_journal.contains(task)
    finally:
        release.set()
        upload_queue.stop()
    assert ReplayArchiveJournal(tmp_path).contains(task)


@pytest.mark.parametrize("mode", ["single", "batch"])
def test_playback_response_after_api_base_switch_cannot_advance_cursor(tmp_path, mode):
    state = AgentState(user_id="owner-a", device_token="a")
    job = _game(tmp_path, "playback.SC2Replay")
    job.game.playback_artifact_path = str(tmp_path / "manifest.json")
    replacement = _StubApi()
    replacement.base_url = "https://replacement.example.test"

    class Api(_StubApi):
        base_url = "https://original.example.test"

        def upload_playback_artifact(self, game_id, artifact):
            upload_queue.replace_api(replacement)

    upload_queue = UploadQueue(cfg=_cfg(tmp_path), state=state, api=Api())
    with pytest.raises(_UploadSessionChanged):
        (upload_queue._upload_one(job) if mode == "single" else upload_queue._upload_batch([job]))
    assert not state.uploaded and not state.path_by_game_id
    assert upload_queue._archive_journal.pending_count() == 0
    assert not replacement.calls


def test_legacy_ownership_response_after_owner_switch_cannot_reassociate_or_upload(tmp_path, monkeypatch):
    monkeypatch.setattr("sc2tools_agent.uploader.queue._ARCHIVE_IDLE_GRACE_SEC", 0)
    state = AgentState(user_id="owner-a", device_token="a")
    task = ReplayArchiveTask(tmp_path / "unowned.SC2Replay", "game-a")
    task.file_path.write_bytes(b"x")
    ReplayArchiveJournal(tmp_path).enqueue_many([task])
    verified = threading.Event()
    replacement = _StubApi()
    replacement.get_game_summary = lambda game_id: {}
    archived = Mock()

    class Api(_StubApi):
        def get_game_summary(self, game_id):
            switch(upload_queue, state, replacement)
            verified.set()
            return {"gameId": game_id}

        upload_replay_file_durable = archived

    upload_queue = UploadQueue(cfg=_cfg(tmp_path), state=state, api=Api())
    upload_queue.start()
    try:
        assert verified.wait(2)
        time.sleep(.1)
        archived.assert_not_called()
        assert upload_queue._archive_journal.contains(task)
        assert upload_queue._archive_journal.pending_count() == 1
    finally:
        upload_queue.stop()
    assert ReplayArchiveJournal(tmp_path).contains(task)


@pytest.mark.parametrize("mode", ["single", "batch"])
def test_ingest_playback_mmr_and_callbacks_never_run_under_state_lock(tmp_path, mode):
    job = replace(_game(tmp_path, "unlocked.SC2Replay", my_mmr=5161), priority=True)
    job.file_path.write_bytes(b"x")
    job.game.playback_artifact_path = str(tmp_path / "manifest.json")
    calls = []

    def unlocked(name):
        assert not _STATE_SAVE_LOCK._is_owned()
        calls.append(name)

    class Api(_StubApi):
        def upload_game(self, payload):
            unlocked("ingest")
            return {"accepted": [accepted(job)]}

        def upload_games_batch(self, payloads):
            return self.upload_game(payloads[0])

        def upload_playback_artifact(self, game_id, artifact):
            unlocked("playback")

        def patch_last_mmr(self, **kwargs):
            unlocked("mmr")
            return {"ok": True}

    upload_queue = UploadQueue(cfg=_cfg(tmp_path), state=AgentState(user_id="owner-a", device_token="a"),
        api=Api(), on_game_accepted=lambda *args: unlocked("checkin"))
    (upload_queue._upload_one(job) if mode == "single" else upload_queue._upload_batch([job]))
    assert calls == ["ingest", "playback", "checkin", "mmr"]


def test_legacy_verification_and_archive_upload_never_run_under_state_lock(tmp_path, monkeypatch):
    monkeypatch.setattr("sc2tools_agent.uploader.queue._ARCHIVE_IDLE_GRACE_SEC", 0)
    task = ReplayArchiveTask(tmp_path / "legacy-unlocked.SC2Replay", "game-a")
    task.file_path.write_bytes(b"x")
    ReplayArchiveJournal(tmp_path).enqueue_many([task])
    calls = []

    class Api(_StubApi):
        def get_game_summary(self, game_id):
            assert not _STATE_SAVE_LOCK._is_owned()
            calls.append("verify")
            return {"gameId": game_id}

        def upload_replay_file_durable(self, game_id, path):
            assert not _STATE_SAVE_LOCK._is_owned()
            calls.append("archive")
            return True

    upload_queue = UploadQueue(cfg=_cfg(tmp_path), state=AgentState(user_id="owner-a", device_token="a"), api=Api())
    upload_queue.start()
    try:
        assert _wait_for(lambda: upload_queue._archive_journal.pending_count() == 0)
        assert calls == ["verify", "archive"]
    finally:
        upload_queue.stop()
