"""Managed re-analysis: strict batches, local-first originals, bounded
downloads with cleanup, and settlement through the normal upload queue."""
from __future__ import annotations

import hashlib
import io
import threading
from dataclasses import replace
from pathlib import Path
from types import SimpleNamespace

import pytest

from sc2tools_agent import reanalysis
from sc2tools_agent.analysis_provenance import AnalysisProvenance, ParsedGame
from sc2tools_agent.reanalysis import ItemFailure, ReanalysisController, ack, parse_batch
from sc2tools_agent.state import AgentState
from sc2tools_agent.sync_filter import SyncFilter
from sc2tools_agent.uploader.queue import ReanalysisUpload, UploadQueue
from .test_upload_queue import _cfg, _game, _StubApi, _wait_for

JOB, DEVICE = "c" * 24, "a" * 24
MPQ = b"MPQ\x1b" + b"\x00" * 60
ORIGINAL = {"sizeBytes": len(MPQ), "sha256": hashlib.sha256(MPQ).hexdigest()}


def batch(*games, seq=1, generation=1, **changes):
    return {"version": 1, "jobId": JOB, "generation": generation, "seq": seq, "deviceId": DEVICE,
            "sessionId": "namespace-session", "games": [{"gameId": game_id, "original": original} for game_id, original in games],
            **changes}


@pytest.mark.parametrize("raw", [
    None, [], {}, batch(("g1", None), version=2), batch(("g1", None), jobId="C" * 24), batch(("g1", None), seq=0),
    batch(("g1", None), generation=True), batch(("g1", None), extra=1), batch(), batch(*[(f"g{i}", None) for i in range(101)]),
    batch(("g1", None), ("g1", None)), batch((" g1", None)), batch(("g\n1", None)), batch(("x" * 201, None)),
    batch(("g1", {"sizeBytes": 3, "sha256": "0" * 64})), batch(("g1", {"sizeBytes": 10, "sha256": "Z" * 64})),
    batch(("g1", {"sizeBytes": 10, "sha256": "0" * 64, "url": "https://x"})),
], ids=["none", "list", "empty", "version", "job", "seq", "bool-generation", "extra-key", "no-games", "too-many",
        "duplicate", "padded-id", "control-char", "long-id", "tiny-original", "bad-digest", "extra-original-key"])
def test_strict_batches_only(raw):
    assert parse_batch(raw) is None


def test_ack_never_reflects_unchecked_fields():
    assert ack({"jobId": "PrivateDisplay", "seq": "1", "generation": 2}, "invalid_request") == {
        "jobId": None, "seq": None, "generation": 2, "code": "invalid_request"}


class _Queue:
    """Upload queue double: records jobs and settles them on demand."""

    def __init__(self, outcome="uploaded"):
        self.jobs, self.outcome, self.pending = [], outcome, set()
        self.temp_existed = []

    def submit(self, job, **_kwargs):
        self.jobs.append(job)
        self.temp_existed.append(job.file_path.exists())
        self.pending.add(str(job.file_path))
        threading.Timer(0.01, self._settle, args=(job,)).start()
        return True

    def _settle(self, job):
        self.pending.discard(str(job.file_path))
        if self.outcome:
            job.reanalysis.settle(self.outcome)

    def is_pending(self, path):
        return str(path) in self.pending


def controller(tmp_path, *, queue=None, parse=None, fetch=None, index=None, game_id=None):
    state = AgentState(device_token="synthetic", user_id="owner")
    state.path_by_game_id = dict(index or {})
    state._owned_toons = (("owner", "synthetic", None), ("1-S2-1-1",), None)
    from sc2tools_agent.sync_retry import replay_ticket
    replay_ticket(state)  # Seeds the owner epoch.
    state._owned_toons = (("owner", "synthetic", state._owner_epoch), ("1-S2-1-1",), None)
    parsed_paths, fetched = [], []

    def default_parse(path, _ticket, _state_dir):
        parsed_paths.append(path)
        name = game_id or path.stem.replace(reanalysis.TEMP_PREFIX, "")
        return ParsedGame(SimpleNamespace(game_id=name, is_resumed_from_replay=False), AnalysisProvenance("1.6.12", "0.25.0"))

    def default_fetch(_base, _token, gid, _original, directory):
        fetched.append(gid)
        directory.mkdir(parents=True, exist_ok=True)
        path = directory / f"{reanalysis.TEMP_PREFIX}{gid}.SC2Replay"
        path.write_bytes(MPQ)
        return path

    cfg = SimpleNamespace(state_dir=tmp_path, api_base="https://api.example")
    cell = SimpleNamespace(upload=queue or _Queue())
    worker = ReanalysisController(cfg=cfg, state=state, cell=cell, stop_event=threading.Event(),
                                  parse=parse or default_parse, fetch=fetch or default_fetch,
                                  settle_seconds=3, identity_wait=0)
    events = []
    return SimpleNamespace(worker=worker, cell=cell, state=state, parsed=parsed_paths, fetched=fetched,
                           events=events, emit=events.append)


def run(c, raw):
    reply = c.worker.handle_batch(raw, "synthetic", c.emit)
    expected = len(raw["games"])
    assert _wait_for(lambda: len(c.events) >= expected, timeout=5)
    return reply


def test_local_replay_first_then_archived_original_with_temp_deleted_before_upload(tmp_path):
    local = tmp_path / "local.SC2Replay"
    local.write_bytes(MPQ)
    c = controller(tmp_path, index={"local": str(local)})
    reply = run(c, batch(("local", ORIGINAL), ("archived", ORIGINAL), ("missing", None)))
    assert reply == {"jobId": JOB, "seq": 1, "generation": 1, "code": "accepted"}
    assert c.fetched == ["archived"]  # The local file was used even though an original exists.
    assert c.parsed[0] == local
    by_game = {event["gameId"]: event for event in c.events}
    assert by_game["local"] == {"version": 1, "jobId": JOB, "seq": 1, "generation": 1, "gameId": "local",
                                "outcome": "uploaded", "engineVersion": "1.6.12"}
    assert by_game["archived"]["outcome"] == "uploaded"
    assert by_game["missing"]["outcome"] == "not_found"
    local_job, archived_job = c.cell.upload.jobs
    assert local_job.reanalysis.transient is False and archived_job.reanalysis.transient is True
    assert c.cell.upload.temp_existed == [True, False]  # Deleted right after parsing.
    assert not list((tmp_path / "reanalysis-tmp").glob("*"))
    assert archived_job.provenance.engine_version == "1.6.12"


def test_a_different_game_from_the_replay_is_never_uploaded(tmp_path):
    c = controller(tmp_path, game_id="someone-else")
    run(c, batch(("archived", ORIGINAL)))
    assert c.events[0]["outcome"] == "game_mismatch"
    assert c.cell.upload.jobs == []
    assert not list((tmp_path / "reanalysis-tmp").glob("*"))


def test_download_failures_settle_as_outcomes_and_clean_up(tmp_path):
    def failing(_base, _token, _gid, _original, directory):
        directory.mkdir(parents=True, exist_ok=True)
        raise ItemFailure("invalid_original")
    c = controller(tmp_path, fetch=failing)
    run(c, batch(("archived", ORIGINAL)))
    assert c.events[0]["outcome"] == "invalid_original" and c.cell.upload.jobs == []


def test_redelivery_reports_settled_games_and_cancel_stops_new_work(tmp_path):
    gates = {name: threading.Event() for name in ("a", "b", "c")}
    gates["a"].set()
    entered = []

    def gated_parse(path, _ticket, _state_dir):
        name = path.stem.replace(reanalysis.TEMP_PREFIX, "")
        entered.append(name)
        assert gates[name].wait(5)
        return ParsedGame(SimpleNamespace(game_id=name, is_resumed_from_replay=False), AnalysisProvenance("1.6.12", "0.25.0"))
    c = controller(tmp_path, parse=gated_parse)
    games = [("a", ORIGINAL), ("b", ORIGINAL), ("c", ORIGINAL)]
    c.worker.handle_batch(batch(*games), "synthetic", c.emit)
    assert _wait_for(lambda: len(c.events) == 1 and entered == ["a", "b"], timeout=5)
    c.worker.handle_cancel({"jobId": JOB, "generation": 2})  # Pause: finish b, start nothing new.
    gates["b"].set()
    assert _wait_for(lambda: len(c.events) == 2 and c.worker._batch.active is None, timeout=5)
    assert entered == ["a", "b"]
    gates["c"].set()
    again = c.worker.handle_batch(batch(*games, generation=3), "synthetic", c.emit)
    assert again["generation"] == 3 and [o["gameId"] for o in again["outcomes"]] == ["a", "b"]
    assert _wait_for(lambda: len(c.events) == 3, timeout=5)
    assert [e["gameId"] for e in c.events] == ["a", "b", "c"] and c.events[2]["generation"] == 3
    assert len(c.cell.upload.jobs) == 3  # Nothing settled was processed twice.


def test_an_unsettled_upload_reports_upload_failed_not_uploaded(tmp_path):
    c = controller(tmp_path, queue=_Queue(outcome=None))
    run(c, batch(("archived", ORIGINAL)))
    assert c.events[0]["outcome"] == "upload_failed"


class _Response:
    def __init__(self, status=200, body=MPQ, headers=None, chunks=None):
        self.status_code, self.headers = status, headers or {}
        self._chunks = chunks if chunks is not None else [body]

    def __enter__(self):
        return self

    def __exit__(self, *_exc):
        return False

    def iter_content(self, chunk_size):
        yield from self._chunks


@pytest.mark.parametrize("response,original,outcome", [
    (_Response(status=302, headers={"location": "https://elsewhere"}), ORIGINAL, "download_failed"),
    (_Response(status=403), ORIGINAL, "download_failed"),
    (_Response(headers={"content-length": str(reanalysis.MAX_ORIGINAL_BYTES + 1)}), ORIGINAL, "invalid_original"),
    (_Response(chunks=[b"MPQ\x1b", b"\x00" * reanalysis.MAX_ORIGINAL_BYTES]), None, "invalid_original"),
    (_Response(body=b"PK\x03\x04" + b"\x00" * 60), None, "invalid_original"),
    (_Response(body=MPQ + b"x"), ORIGINAL, "invalid_original"),
], ids=["redirect", "forbidden", "declared-oversize", "streamed-oversize", "not-mpq", "digest-mismatch"])
def test_stream_bounds(response, original, outcome):
    calls = []

    def get(url, **kwargs):
        calls.append(kwargs)
        return response
    with pytest.raises(ItemFailure) as failure:
        reanalysis.stream_original("https://bucket.example/signed?X-Amz-Signature=secret", io.BytesIO(), original, get=get)
    assert failure.value.outcome == outcome
    assert calls[0]["allow_redirects"] is False and calls[0]["stream"] is True and calls[0]["timeout"] == reanalysis.DOWNLOAD_TIMEOUT


def test_transport_errors_never_carry_the_signed_url():
    def get(url, **_kwargs):
        raise RuntimeError(f"connection reset for {url}")
    with pytest.raises(ItemFailure) as failure:
        reanalysis.stream_original("https://bucket.example/signed?X-Amz-Signature=secret", io.BytesIO(), None, get=get)
    assert failure.value.outcome == "download_failed" and "secret" not in repr(failure.value)
    assert failure.value.__cause__ is None


@pytest.mark.parametrize("url", ["http://bucket.example/x", "https://user:pw@bucket.example/x", "file:///C:/x", "https:///x"])
def test_fetch_requires_a_plain_https_url_and_leaves_no_file(tmp_path, monkeypatch, url):
    from sc2tools_agent import api_client
    monkeypatch.setattr(api_client.ApiClient, "get_replay_download", lambda self, game_id: {"url": url, "expiresIn": 60})
    with pytest.raises(ItemFailure) as failure:
        reanalysis.fetch_original("https://api.example", "synthetic", "g1", ORIGINAL, tmp_path / "tmp",
                                  get=lambda *_a, **_k: _Response())
    assert failure.value.outcome == "download_failed"
    assert not (tmp_path / "tmp").exists() or not list((tmp_path / "tmp").iterdir())


def test_fetch_writes_an_exclusive_verified_temp_file(tmp_path, monkeypatch):
    from sc2tools_agent import api_client
    monkeypatch.setattr(api_client.ApiClient, "get_replay_download", lambda self, game_id: {"url": "https://bucket.example/x", "expiresIn": 60})
    path = reanalysis.fetch_original("https://api.example", "synthetic", "g1", ORIGINAL, tmp_path / "tmp", get=lambda *_a, **_k: _Response())
    assert path.read_bytes() == MPQ and path.name.startswith(reanalysis.TEMP_PREFIX)
    monkeypatch.setattr(api_client.ApiClient, "get_replay_download", lambda self, game_id: None)
    with pytest.raises(ItemFailure) as failure:
        reanalysis.fetch_original("https://api.example", "synthetic", "g2", ORIGINAL, tmp_path / "tmp")
    assert failure.value.outcome == "not_found"


def test_startup_purges_only_this_modules_leftovers(tmp_path):
    directory = tmp_path / "reanalysis-tmp"
    directory.mkdir()
    (directory / f"{reanalysis.TEMP_PREFIX}old.SC2Replay").write_bytes(MPQ)
    (directory / "keep.txt").write_text("x", encoding="utf-8")
    controller(tmp_path)
    assert [p.name for p in directory.iterdir()] == ["keep.txt"]


# ---------------- real upload queue ----------------

def _settled_job(tmp_path, name, *, transient):
    outcomes = []
    job = replace(_game(tmp_path, name), reanalysis=ReanalysisUpload(transient=transient, settle=outcomes.append))
    return job, outcomes


def test_queue_downloaded_original_leaves_no_cursor_index_or_backup_and_settles_once(tmp_path):
    state = AgentState(device_token="synthetic")
    queue = UploadQueue(cfg=_cfg(tmp_path), state=state, api=_StubApi())
    job, outcomes = _settled_job(tmp_path, "reanalyze-x.SC2Replay", transient=True)
    job.file_path.unlink()
    assert queue.submit(job)
    queue.start()
    try:
        assert _wait_for(lambda: outcomes == ["uploaded"])
        assert _wait_for(lambda: not queue.is_pending(job.file_path))
        assert state.uploaded == {} and state.path_by_game_id == {}
        assert queue.archive_pending_count() == 0
    finally:
        queue.stop()


def test_queue_local_reanalysis_bypasses_cursor_dedupe_and_date_filter(tmp_path):
    state = AgentState(device_token="synthetic")
    state.sync_filter_preset = "custom"
    state.sync_filter_since = "2030-01-01"
    assert SyncFilter.from_state(preset="custom", since_iso="2030-01-01", until_iso=None).is_active()
    queue = UploadQueue(cfg=_cfg(tmp_path), state=state, api=_StubApi())
    job, outcomes = _settled_job(tmp_path, "local.SC2Replay", transient=False)
    state.uploaded[str(job.file_path)] = "2026-01-01T00:00:00+00:00"
    plain = replace(job, reanalysis=None)
    assert queue.submit(plain) is False  # Ordinary work still dedupes.
    assert queue.submit(job)
    queue.start()
    try:
        assert _wait_for(lambda: outcomes == ["uploaded"])
        assert state.uploaded[str(job.file_path)] != "filtered"
        assert state.path_by_game_id[job.game.game_id] == str(job.file_path)
    finally:
        queue.stop()


def test_queue_rejection_settles_as_rejected(tmp_path):
    class Rejecting(_StubApi):
        def upload_games_batch(self, games):
            return {"accepted": [], "rejected": [{"gameId": g["gameId"], "errors": ["bad"]} for g in games]}
    state = AgentState(device_token="synthetic")
    queue = UploadQueue(cfg=_cfg(tmp_path), state=state, api=Rejecting())
    job, outcomes = _settled_job(tmp_path, "reanalyze-y.SC2Replay", transient=True)
    assert queue.submit(job)
    queue.start()
    try:
        assert _wait_for(lambda: outcomes == ["rejected"])
        assert str(job.file_path) not in state.uploaded
    finally:
        queue.stop()


# ---------------- socket wiring ----------------

def test_socket_accepts_batches_only_for_its_own_session_and_advertises_support():
    import asyncio
    from unittest.mock import Mock
    from sc2tools_agent.socket_client import SocketClient

    handled = Mock(return_value={"jobId": JOB, "seq": 1, "generation": 1, "code": "accepted"})
    client = SocketClient(base_url="https://api.example", device_token="synthetic", on_recompute_games=Mock(),
                          on_recompute_opp_build=Mock(), on_reanalyze=handled, on_reanalyze_cancel=Mock())
    client._sio = SimpleNamespace(get_sid=lambda **_: "namespace-session")
    client._device_connected = True
    assert asyncio.run(client._reanalyze_batch(batch(("g1", None))))["code"] == "accepted"
    assert handled.call_args.args[1] == "synthetic"
    foreign = asyncio.run(client._reanalyze_batch(batch(("g1", None), sessionId="other-session")))
    assert foreign == {"jobId": JOB, "seq": 1, "generation": 1, "code": "owner_changed"}
    assert handled.call_count == 1
    rebuilt = client.with_device_token("rotated")
    assert rebuilt._on_reanalyze is handled
    legacy = SocketClient(base_url="https://api.example", device_token="synthetic", on_recompute_games=Mock(),
                          on_recompute_opp_build=Mock())
    assert asyncio.run(legacy._reanalyze_batch(batch(("g1", None))))["code"] == "unsupported"
