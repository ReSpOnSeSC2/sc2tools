import pytest

from sc2tools_agent.state import AgentState, load_state
from sc2tools_agent.uploader.queue import UploadQueue
from tests.test_upload_queue import _cfg, _game, _StubApi


def test_retry_one_reason_preserves_unrelated_outcomes_and_missing_pending_files(tmp_path):
    files = {name: _game(tmp_path, name + ".SC2Replay") for name in ("retry", "filtered", "uploaded", "other", "pending")}
    markers = {str(files[name].file_path): value for name, value in {
        "retry": "skipped:player_unresolved", "filtered": "filtered", "uploaded": "2026-10-23T00:00:00Z",
        "other": "skipped:parse_failed", "pending": "skipped:player_unresolved"}.items()}
    markers[str(tmp_path / "missing")] = "skipped:player_unresolved"
    state = AgentState(uploaded=markers.copy())
    queue = UploadQueue(cfg=_cfg(tmp_path), state=state, api=_StubApi())
    queue._pending_paths.add(str(files["pending"].file_path))
    assert queue.retry_selected(reason="player_unresolved") == [str(files["retry"].file_path)]
    expected = {key: value for key, value in markers.items() if key != str(files["retry"].file_path)}
    assert state.uploaded == expected == load_state(tmp_path).uploaded
    assert queue._retry_wake.is_set()
    with pytest.raises(ValueError):
        queue.retry_selected(reason="ai_game")
    assert state.uploaded == expected


def test_reanalyze_selection_keeps_active_filter_and_does_not_send_outside_window(tmp_path):
    job = _game(tmp_path, "old.SC2Replay", date_iso="2020-01-01T00:00:00Z")
    other = _game(tmp_path, "other.SC2Replay")
    state = AgentState(sync_filter_preset="custom", sync_filter_since="2026-01-01", uploaded={str(job.file_path): "rejected", str(other.file_path): "2026-10-23T00:00:00Z"})
    api = _StubApi()
    queue = UploadQueue(cfg=_cfg(tmp_path), state=state, api=api)
    assert queue.retry_selected([job.file_path]) == [str(job.file_path)]
    queue._upload_one(job)
    assert state.uploaded[str(job.file_path)] == "filtered"
    assert state.uploaded[str(other.file_path)] == "2026-10-23T00:00:00Z"
    assert not api.calls


def test_failed_retry_write_restores_exact_cursor(tmp_path, monkeypatch):
    job = _game(tmp_path, "failed.SC2Replay")
    state = AgentState(uploaded={str(job.file_path): "skipped:parse_failed", "other": "filtered"})
    queue = UploadQueue(cfg=_cfg(tmp_path), state=state, api=_StubApi())
    before = state.uploaded.copy()
    def fail(*_args):
        raise OSError("read-only fixture")
    monkeypatch.setattr("sc2tools_agent.uploader.queue.save_state", fail)
    with pytest.raises(OSError):
        queue.retry_selected(reason="parse_failed")
    assert state.uploaded == before


@pytest.mark.parametrize("marker", ["filtered", "skipped:filtered"])
def test_date_filter_retry_recognizes_both_stored_marker_formats(tmp_path, marker):
    job = _game(tmp_path, "filtered.SC2Replay")
    state = AgentState(uploaded={str(job.file_path): marker, "unrelated": "skipped:parse_failed"})
    queue = UploadQueue(cfg=_cfg(tmp_path), state=state, api=_StubApi())
    assert queue.retry_selected(reason="filtered") == [str(job.file_path)]
    assert state.uploaded == {"unrelated": "skipped:parse_failed"}
