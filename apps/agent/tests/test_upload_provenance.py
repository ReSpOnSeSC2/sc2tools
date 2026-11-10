"""Payload and actual queue retries keep the immutable parse snapshot."""
from dataclasses import replace
import json
import threading
from types import SimpleNamespace

from sc2tools_agent.analysis_provenance import AnalysisProvenance, UNKNOWN_PROVENANCE
from sc2tools_agent.api_client import ReplayIngestBusy
from sc2tools_agent.state import AgentState
from sc2tools_agent.uploader.queue import UploadJob, UploadQueue
from .test_upload_queue import _cfg, _game, _StubApi, _wait_for
from .test_analysis_provenance import parser_root


def test_wire_payload_emits_only_valid_captured_optional_strings_without_mutating_game(tmp_path):
    queue = UploadQueue(cfg=_cfg(tmp_path), state=AgentState(device_token="synthetic"), api=_StubApi())
    forged = {"gameId": "synthetic", "engineVersion": "9.9.9", "agentVersion": "9.9.9", "ingestSource": "agent"}
    game = SimpleNamespace(to_payload=lambda: forged)
    legacy = UploadJob(tmp_path / "synthetic.SC2Replay", game)
    assert legacy.provenance == UNKNOWN_PROVENANCE
    assert queue._payload_for_job(legacy) == {"gameId": "synthetic"}
    captured = replace(legacy, provenance=AnalysisProvenance("1.6.12", "0.24.9"))
    assert queue._payload_for_job(captured) == {"gameId": "synthetic", "engineVersion": "1.6.12", "agentVersion": "0.24.9"}
    assert json.loads(json.dumps(queue._payload_for_job(replace(legacy, provenance=AnalysisProvenance(None, "0.24.9"))))) == {"gameId": "synthetic", "agentVersion": "0.24.9"}
    assert queue._payload_for_job(replace(legacy, provenance=AnalysisProvenance("latest", "x"*41))) == {"gameId": "synthetic"}
    assert forged == {"gameId": "synthetic", "engineVersion": "9.9.9", "agentVersion": "9.9.9", "ingestSource": "agent"}


def test_resumed_marker_omits_even_captured_stamps(tmp_path):
    queue = UploadQueue(cfg=_cfg(tmp_path), state=AgentState(device_token="synthetic"), api=_StubApi())
    original = _game(tmp_path, "resumed.SC2Replay")
    original.game.is_resumed_from_replay = True
    job = replace(original, provenance=AnalysisProvenance("1.6.12", "0.24.9"))
    assert job.provenance == UNKNOWN_PROVENANCE
    payload = queue._payload_for_job(job)
    assert payload["isResumedFromReplay"] is True
    assert all(name not in payload for name in ("engineVersion", "agentVersion", "ingestSource"))


def test_actual_busy_retry_and_held_acceptance_keep_parse_versions_after_metadata_changes(tmp_path, monkeypatch):
    import sc2tools_agent
    from sc2tools_agent import analysis_provenance
    second_entered = threading.Event()
    release = threading.Event()
    sent = []
    engine_root, module = parser_root(tmp_path)
    (engine_root / "VERSION").write_text("1.6.11", encoding="utf-8")
    monkeypatch.setattr(sc2tools_agent, "__version__", "0.24.9")

    class Api(_StubApi):
        def upload_games_batch(self, games):
            sent.append([dict(game) for game in games])
            if len(sent) == 1:
                monkeypatch.setattr(sc2tools_agent, "__version__", "9.9.9")
                (engine_root / "VERSION").write_text("9.9.9", encoding="utf-8")
                raise ReplayIngestBusy(0.05)
            second_entered.set()
            assert release.wait(3)
            return super().upload_games_batch(games)

    snapshot = analysis_provenance.capture_provenance(parser_module=module)
    job = replace(_game(tmp_path, "held.SC2Replay"), provenance=snapshot)
    def forbidden(**_kwargs):
        raise AssertionError("Serialization must not look up current parse versions.")
    monkeypatch.setattr(analysis_provenance, "capture_provenance", forbidden)
    state = AgentState(device_token="synthetic")
    queue = UploadQueue(cfg=_cfg(tmp_path), state=state, api=Api())
    assert queue.submit(job)
    try:
        queue.start()
        assert second_entered.wait(3)
        assert queue.is_pending(job.file_path) and state.uploaded == {}
        assert job.provenance is snapshot and len(sent) == 2
        assert sent[0] == sent[1]
        assert sent[1][0]["engineVersion"] == "1.6.11" and sent[1][0]["agentVersion"] == "0.24.9"
        release.set()
        assert _wait_for(lambda: bool(state.uploaded))
    finally:
        release.set()
        queue.stop()
    assert not queue.is_pending(job.file_path)
