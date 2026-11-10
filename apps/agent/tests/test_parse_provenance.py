"""Native producer handoff uses synthetic parsers and existing owned watcher fixtures."""
from concurrent.futures import Future

import pytest

from sc2tools_agent import replay_pipeline, watcher
from sc2tools_agent.analysis_provenance import AnalysisProvenance, ParsedGame, UNKNOWN_PROVENANCE
from sc2tools_agent.sync_retry import replay_ticket
from .test_watcher_pool import watcher_factory, _make_cloud_game


@pytest.mark.parametrize("mode", ["worker", "sync"])
def test_each_native_producer_captures_before_parse_and_never_retags_parent_handoff(monkeypatch, watcher_factory, mode):
    monkeypatch.setenv("SC2TOOLS_PARSE_USE_PROCESSES", "0")
    instance = watcher_factory()
    path = instance._cfg.state_dir / "synthetic.SC2Replay"
    path.write_bytes(b"synthetic, never parsed")
    original = AnalysisProvenance("1.6.12", "0.24.9")
    current = [original]
    game = _make_cloud_game()
    monkeypatch.setattr(watcher, "capture_provenance", lambda: current[0])
    monkeypatch.setattr(watcher, "_wait_for_file_ready", lambda *_: True)
    monkeypatch.setattr(watcher, "_install_worker_log_handler", lambda *_: None)

    def parse(*_args, **_kwargs):
        current[0] = AnalysisProvenance("9.9.9", "9.9.9")
        return game, None

    ticket = replay_ticket(instance._state)
    if mode == "worker":
        monkeypatch.setattr(replay_pipeline, "parse_replay_for_cloud_ex", parse)
        result = watcher._parse_in_worker(str(path), "", ticket.toons, ticket.hint)
        assert isinstance(result[2], ParsedGame) and result[2].provenance is original
        future = Future(); future.set_result(result)
        instance._on_worker_done(future, str(path), ticket)
    else:
        monkeypatch.setattr(watcher, "parse_replay_for_cloud_ex", parse)
        instance._handle_replay(path, ticket=ticket)
    job, = instance._test_upload.submitted
    assert job.game is game and job.provenance is original
    assert job.provenance.payload_fields() == {"engineVersion": "1.6.12", "agentVersion": "0.24.9"}


def test_legacy_worker_game_is_unknown_instead_of_stamped_by_receiving_parent(monkeypatch, watcher_factory):
    monkeypatch.setenv("SC2TOOLS_PARSE_USE_PROCESSES", "0")
    instance = watcher_factory()
    game = _make_cloud_game()
    path = instance._cfg.state_dir / "old-worker.SC2Replay"
    def forbidden():
        raise AssertionError("The receiving parent must never capture current versions.")
    monkeypatch.setattr(watcher, "capture_provenance", forbidden)
    result = Future(); result.set_result(("game", str(path), game))
    instance._on_worker_done(result, str(path))
    job, = instance._test_upload.submitted
    assert job.game is game and job.provenance == UNKNOWN_PROVENANCE
