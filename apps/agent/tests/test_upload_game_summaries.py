from dataclasses import replace

import pytest

from sc2tools_agent.state import AgentState
from sc2tools_agent.uploader.queue import UploadQueue
from tests.test_upload_queue import _cfg, _game, _StubApi


@pytest.mark.parametrize("single", [False, True], ids=["batch", "single"])
def test_summary_hook_covers_both_lanes_after_durable_acceptance_without_expanding_live_checkin(tmp_path, single):
    state = AgentState(device_token="fixture-device")
    summaries, live, callbacks_locked = [], [], []
    def synced(path, summary):
        assert str(path) in state.uploaded
        assert state.path_by_game_id[summary["gameId"]] == str(path)
        acquired = queue._lock.acquire(blocking=False)
        callbacks_locked.append(not acquired)
        if acquired:
            queue._lock.release()
        summaries.append((path, summary))
    queue = UploadQueue(cfg=_cfg(tmp_path), state=state, api=_StubApi(), on_game_synced=synced,
                        on_game_accepted=lambda path, *_args: live.append(path))
    history = _game(tmp_path, "history.SC2Replay")
    playing = replace(_game(tmp_path, "playing.SC2Replay"), priority=True)
    if single:
        queue._upload_one(history)
        queue._upload_one(playing)
    else:
        queue._upload_batch([history, playing])
    assert len(summaries) == 2
    assert summaries[0][1]["isHistory"] is True
    assert summaries[1][1]["isHistory"] is False
    assert live == [playing.file_path]
    assert callbacks_locked == [False, False]
    assert all("replayArchive" not in summary for _, summary in summaries)


def test_summary_sink_failure_cannot_repeat_or_reject_accepted_games(tmp_path):
    def broken(*_args):
        raise OSError("fixture local history unavailable")
    state = AgentState(device_token="fixture-device")
    successes = []
    queue = UploadQueue(cfg=_cfg(tmp_path), state=state, api=_StubApi(), on_game_synced=broken,
                        on_success=successes.append)
    job = _game(tmp_path, "accepted.SC2Replay")
    queue._upload_batch([job])
    assert str(job.file_path) in state.uploaded
    assert successes == [job.file_path]


@pytest.mark.parametrize("single", [False, True])
def test_relink_during_request_cannot_label_old_account_metadata_as_new_account(tmp_path, single):
    state = AgentState(device_token="fixture-device", user_id="old")
    class RelinkingAPI(_StubApi):
        def upload_game(self, payload):
            state.user_id = "new"
            return super().upload_game(payload)
        def upload_games_batch(self, payload):
            state.user_id = "new"
            return super().upload_games_batch(payload)
    summaries = []
    queue = UploadQueue(cfg=_cfg(tmp_path), state=state, api=RelinkingAPI(), on_game_synced=lambda *args: summaries.append(args))
    job = _game(tmp_path, "old-account.SC2Replay")
    (queue._upload_one(job) if single else queue._upload_batch([job]))
    assert summaries == []
