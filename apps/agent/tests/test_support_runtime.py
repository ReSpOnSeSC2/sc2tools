"""Synthetic runtime admission/ownership; no real probes, agent or credentials."""
from dataclasses import asdict
import json
import os
import threading
from types import SimpleNamespace

import pytest

from sc2tools_agent.api_client import ApiClient
from sc2tools_agent.health import HealthFacts
from sc2tools_agent.state import AgentState, _STATE_SAVE_LOCK
from sc2tools_agent.support_diagnostics import DiagnosticRow, diagnostic_bytes
from sc2tools_agent.support_probes import ProbeResult
from sc2tools_agent.support_runtime import SupportService
from sc2tools_agent import support_runtime
from sc2tools_agent.support_export import LogSelection
from sc2tools_agent.support_redaction import redact_log
from sc2tools_agent.sync_retry_socket import SyncRetrySocket


def service(tmp_path, **changes):
    state = AgentState(user_id="synthetic-owner", device_token="synthetic-token")
    cfg = SimpleNamespace(api_base="https://api.example.test", state_dir=tmp_path, parse_concurrency=2)
    cell = SimpleNamespace(api=ApiClient(cfg.api_base, state.device_token), socket_client=None, no_obs=True,
        updater=None, watcher=None, ui=None, upload=None, live_metrics_logger=None)
    threads = []

    def factory(**kwargs):
        thread = threading.Thread(**kwargs)
        threads.append(thread)
        return thread

    subject = SupportService(cfg=cfg, state=state, cell=cell, stop_event=threading.Event(), log_dir=tmp_path,
        discover_folders=lambda: (), obs_connection=lambda: ("localhost", 4455, "synthetic-obs-password"), worker_factory=factory)
    subject._probe = lambda row_id, *_args: ProbeResult(DiagnosticRow(row_id, "pass", "ok"))
    for name, value in changes.items():
        setattr(subject, name, value)
    return subject, state, cell, threads


def joined(threads):
    for thread in threads:
        thread.join(timeout=3)
        assert not thread.is_alive()


def test_successful_copy_is_current_primitive_and_never_runs_probes(tmp_path):
    subject, state, cell, threads = service(tmp_path)
    subject._probe = lambda *_args: (_ for _ in ()).throw(AssertionError("copy ran probe"))
    results = []
    nonce = subject.copy_info(results.append)
    joined(threads)
    assert len(results) == 1 and results[0].run_nonce == nonce and subject.is_current(nonce)
    output = diagnostic_bytes(results[0].snapshot)
    assert b"synthetic-owner" not in output and b"synthetic-token" not in output and b"synthetic-obs-password" not in output
    assert all(row.status == "unavailable" for row in results[0].snapshot.rows)
    serialized = json.dumps(asdict(results[0]))
    assert "callback" not in serialized and "synthetic-token" not in serialized and str(tmp_path) not in serialized
    subject.close()


@pytest.mark.parametrize("change", ["cancel", "owner_aba", "api", "config", "socket"])
def test_held_actual_worker_stays_busy_and_cannot_publish_old_result(tmp_path, change):
    subject, state, cell, threads = service(tmp_path)
    entered, release = threading.Event(), threading.Event()

    def held():
        assert not _STATE_SAVE_LOCK._is_owned() and not subject._lock.locked()
        entered.set()
        assert release.wait(3)
        return ()

    subject.discover_folders = held
    results = []
    nonce = subject.run_check(results.append)
    try:
        assert entered.wait(3)
        if change == "cancel":
            subject.cancel()
        elif change == "owner_aba":
            with _STATE_SAVE_LOCK:
                state.user_id, state._owner_epoch = "owner-B", object()
                state.user_id, state._owner_epoch = "synthetic-owner", object()
        elif change == "api":
            cell.api = ApiClient(subject.cfg.api_base, state.device_token)
        elif change == "config":
            state.sync_filter_preset = "current_season"
        else:
            cell.socket_client = SimpleNamespace(support_scope=lambda _token: (object(), None, None, None))
        assert subject.copy_info(results.append) is None
        assert subject.run_check(results.append) is None
        assert subject.busy
    finally:
        release.set()
        joined(threads)
    assert results == [] and not subject.busy
    assert not subject.is_current(nonce)
    subject.close()


def test_queue_reads_are_outside_both_locks_and_retirement_after_read_suppresses(tmp_path):
    subject, state, cell, threads = service(tmp_path)
    called = []

    def pending():
        assert not _STATE_SAVE_LOCK._is_owned() and not subject._lock.locked()
        called.append("pending")
        subject.cancel()
        return 999

    cell.upload = SimpleNamespace(pending_count=pending, archive_pending_count=lambda: 7, is_paused=lambda: False)
    results = []
    subject.copy_info(results.append)
    joined(threads)
    assert called == ["pending"] and results == []
    subject.close()


def test_close_waits_for_actual_held_worker_settlement(tmp_path):
    subject, _, _, threads = service(tmp_path)
    entered, release, closed = threading.Event(), threading.Event(), threading.Event()
    subject.discover_folders = lambda: (entered.set(), release.wait(3), ())[2]
    results = []
    subject.run_check(results.append)
    assert entered.wait(3)
    closer = threading.Thread(target=lambda: (subject.close(), closed.set()))
    closer.start()
    try:
        assert not closed.wait(0.03) and subject.busy
    finally:
        release.set()
    closer.join(3)
    joined(threads)
    assert closed.is_set() and results == [] and not subject.busy


def test_proven_unstarted_scheduling_failure_releases_slot(tmp_path):
    subject, _, _, _ = service(tmp_path)

    class FailedThread:
        ident = None

        def start(self):
            raise RuntimeError("synthetic scheduling failure")

    subject.worker_factory = lambda **_kwargs: FailedThread()
    assert subject.copy_info(lambda _result: None) is None
    assert not subject.busy
    subject.close()


def test_code_history_captured_before_request_rejects_held_owner_aba(tmp_path):
    subject, state, cell, threads = service(tmp_path)
    old = subject.capture_error(cell.api)
    with _STATE_SAVE_LOCK:
        state.user_id, state._owner_epoch = "owner-B", object()
        state.user_id, state._owner_epoch = "synthetic-owner", object()
    old("offline")
    current = subject.capture_error(cell.api)
    for _ in range(12):
        current("server_busy")
    current("private-free-form-error")
    results = []
    subject.copy_info(results.append)
    joined(threads)
    assert results[0].snapshot.support.errors == ("server_busy",) * 10
    assert "private" not in json.dumps(asdict(results[0]))
    subject.close()


def test_current_device_requires_canonical_binding_sid_epoch_and_token():
    sid = {"value": "namespace-sid"}
    client = SimpleNamespace(_sio=SimpleNamespace(get_sid=lambda **_kwargs: sid["value"]), _stop=threading.Event(),
        _device_connected=True, _device_token="synthetic-token")
    protocol = SyncRetrySocket(client, lambda *_args: None)
    initial = protocol.support_scope(client._device_token)
    assert initial[3] is None
    raw = {"version": 1, "deviceId": "0123456789abcdef01234567", "sessionId": "namespace-sid"}
    protocol.ready(raw)
    captured = protocol.support_scope(client._device_token)
    assert protocol.support_device_id(client._device_token, captured) == raw["deviceId"]
    assert protocol.support_device_id("wrong-token", captured) is None
    sid["value"] = "other-sid"
    assert protocol.support_device_id(client._device_token, captured) is None
    sid["value"] = "namespace-sid"
    protocol.retire()
    protocol.ready(raw)
    assert protocol.support_device_id(client._device_token, captured) is None
    assert protocol.support_scope(client._device_token)[0] is not initial[0]
    client._stop.set()
    assert protocol.support_scope(client._device_token)[3] is None


def test_review_and_save_hold_exact_private_plan_and_only_publish_public_nonce(tmp_path, monkeypatch):
    subject, _, _, threads = service(tmp_path)
    selected = LogSelection("parent", 0, redact_log((b"private-secret\nevent=sync\n",)))
    monkeypatch.setattr(support_runtime, "read_log_selections", lambda *_args, **_kwargs: (selected,))
    written = []

    def save(plan, destination, *, is_current, is_cancelled):
        assert is_current() and not is_cancelled()
        written.append(tuple((entry.alias, entry.data) for entry in plan.entries))

    monkeypatch.setattr(support_runtime, "write_reviewed_bundle", save)
    results = []
    nonce = subject.prepare_bundle(results.append)
    joined(threads)
    preview = results[-1]
    assert preview.run_nonce == nonce and preview.kind == "review"
    assert tuple(item.alias for item in preview.entries) == ("diagnostics.txt", "state-summary.json", "logs/agent-0.log")
    assert "synthetic-token" not in repr(preview) and "is_current" not in repr(preview)
    assert subject.save_reviewed(nonce, tmp_path / "safe.zip", results.append) == nonce
    joined(threads)
    assert written[0][2] == ("logs/agent-0.log", b"[omitted]\nevent=sync\n")
    assert results[-1].kind == "saved"
    subject.cancel()
    assert not subject.is_current(preview.run_nonce)
    assert subject.save_reviewed(nonce, tmp_path / "old.zip", results.append) is None
    assert len(written) == 1
    subject.close()


def test_upload_error_context_keeps_admission_epoch_across_owner_aba(tmp_path):
    from sc2tools_agent.uploader.queue import UploadQueue
    subject, state, cell, threads = service(tmp_path)
    subject.capture_error(cell.api)  # Establish the owner epoch before admission.
    queue = UploadQueue.__new__(UploadQueue)
    queue._state, queue._api, queue._api_generation = state, cell.api, 1
    queue._on_support_error = subject.record_upload_error
    old = queue._upload_context()
    with _STATE_SAVE_LOCK:
        state.user_id, state._owner_epoch = "owner-B", object()
        state.user_id, state._owner_epoch = "synthetic-owner", object()
    queue._report_support_error(old, ConnectionError("private-old-upload-error"))
    current = queue._upload_context()
    queue._report_support_error(current, ConnectionError("private-current-upload-error"))
    results = []
    subject.copy_info(results.append)
    joined(threads)
    assert results[0].snapshot.support.errors == ("offline",)
    assert b"private" not in diagnostic_bytes(results[0].snapshot)
    subject.close()


def test_heartbeat_captures_support_context_before_held_request(tmp_path, monkeypatch):
    from sc2tools_agent.heartbeat import Heartbeat
    from sc2tools_agent import heartbeat
    monkeypatch.setattr(heartbeat, "_local_hostname", lambda: None)
    subject, state, cell, threads = service(tmp_path)

    def failed(_path, **_options):
        with _STATE_SAVE_LOCK:
            state._owner_epoch = object()
        raise ConnectionError("private-old-heartbeat-error")

    api = SimpleNamespace(base_url=subject.cfg.api_base, device_token=state.device_token, _post=failed)
    cell.api = api
    beat = Heartbeat(api, support_error_context=subject.capture_error)
    beat._send_one()
    api._post = lambda *_args, **_kwargs: (_ for _ in ()).throw(ConnectionError("private-current-heartbeat-error"))
    beat._send_one()
    results = []
    subject.copy_info(results.append)
    joined(threads)
    assert results[0].snapshot.support.errors == ("offline",)
    assert b"private" not in diagnostic_bytes(results[0].snapshot)
    subject.close()


def test_service_identity_fence_never_invokes_runtime_object_equality(tmp_path):
    subject, _, cell, threads = service(tmp_path)
    invoked = []

    class Queue:
        def __eq__(self, other):
            invoked.append(other)
            raise AssertionError("runtime equality callback")

        def pending_count(self):
            return 0

        def archive_pending_count(self):
            return 0

        def is_paused(self):
            return False

    cell.upload = Queue()
    results = []
    nonce = subject.copy_info(results.append)
    joined(threads)
    assert results[0].snapshot.support.pending == 0 and subject.is_current(nonce)
    cell.upload = Queue()
    assert not subject.is_current(nonce) and invoked == []
    subject.close()


@pytest.mark.skipif(os.name != "nt", reason="Folder metadata scans require held Windows directory handles")
def test_runner_support_provider_preserves_missing_and_explicit_nested_roots(tmp_path, monkeypatch):
    from sc2tools_agent import runner
    from sc2tools_agent.support_probes import folders_probe
    existing = tmp_path / "private-existing"
    nested = existing / "private-nested"
    nested.mkdir(parents=True)
    (nested / "private.SC2Replay").write_bytes(b"synthetic")
    missing = tmp_path / "private-missing"
    state = AgentState(replay_folders_override=[str(existing), str(missing)])
    cfg = SimpleNamespace(replay_folder=None)
    called = []

    def facts():
        assert not _STATE_SAVE_LOCK._is_owned()
        called.append(True)
        return HealthFacts(folders=(str(existing),))

    cell = SimpleNamespace(ui=SimpleNamespace(health=SimpleNamespace(facts=facts)))
    monkeypatch.setattr(runner, "detected_replay_folders", lambda *_args: (_ for _ in ()).throw(AssertionError("legacy discovery ran")))
    roots = runner._support_folder_provider(cfg, state, cell)()
    assert roots.paths == (existing, missing) and roots.complete and called == [True]
    result = folders_probe(roots.paths, roots_complete=roots.complete, is_current=lambda: True,
        is_cancelled=lambda: False, deadline=__import__("time").monotonic() + 3)
    assert result.row.status == "warn" and result.row.count == 1
    assert tuple(item.index for item in result.folders) == (1, 2)
    assert tuple(item.replay_count for item in result.folders) == (1, None)
    assert "private" not in repr(result)
    state.replay_folders_override.append(str(nested))
    assert runner._support_folder_provider(cfg, state, cell)().paths == (existing, missing, nested)


def test_runner_support_provider_excludes_removed_detected_roots_but_keeps_explicit_additions(tmp_path, monkeypatch):
    from sc2tools_agent import runner
    kept, excluded = tmp_path / "kept", tmp_path / "excluded"
    kept.mkdir(); excluded.mkdir()
    state = AgentState(replay_folders_excluded=[str(excluded)])
    cfg = SimpleNamespace(replay_folder=None)

    def facts():
        assert not _STATE_SAVE_LOCK._is_owned()
        return HealthFacts(folders=(str(kept), str(excluded)))

    cell = SimpleNamespace(ui=SimpleNamespace(health=SimpleNamespace(facts=facts)))
    monkeypatch.setattr(runner, "detected_replay_folders", lambda *_args: (_ for _ in ()).throw(AssertionError("legacy discovery ran")))
    roots = runner._support_folder_provider(cfg, state, cell)()
    assert roots.paths == (kept,) and roots.complete
    state.replay_folders_override.append(str(excluded))
    roots = runner._support_folder_provider(cfg, state, cell)()
    assert roots.paths == (excluded, kept) and roots.complete


def test_provider_unknown_automatic_facts_stay_unavailable_and_observed_empty_stays_zero(tmp_path, monkeypatch):
    from sc2tools_agent import runner
    from sc2tools_agent.support_probes import folders_probe
    state = AgentState()
    cfg = SimpleNamespace(replay_folder=None)
    reported = {"folders": None}

    def facts():
        assert not _STATE_SAVE_LOCK._is_owned()
        return HealthFacts(folders=reported["folders"])

    cell = SimpleNamespace(ui=SimpleNamespace(health=SimpleNamespace(facts=facts)))
    monkeypatch.setattr(runner, "detected_replay_folders", lambda *_args: (_ for _ in ()).throw(AssertionError("legacy discovery ran")))
    provider = runner._support_folder_provider(cfg, state, cell)
    unknown = provider()
    assert unknown.paths == () and not unknown.complete and unknown.automatic_available is False
    row = folders_probe(unknown.paths, roots_complete=unknown.complete, automatic_available=unknown.automatic_available,
        is_current=lambda: True, is_cancelled=lambda: False, deadline=99999999999).row
    assert row.status == "unavailable" and row.count is None
    reported["folders"] = ()
    empty = provider()
    assert empty.paths == () and empty.complete and empty.automatic_available is True
    row = folders_probe(empty.paths, roots_complete=empty.complete, automatic_available=empty.automatic_available,
        is_current=lambda: True, is_cancelled=lambda: False, deadline=99999999999).row
    assert row.count == 0


def test_provider_bounds_already_reported_roots_without_legacy_discovery(tmp_path, monkeypatch):
    from sc2tools_agent import runner
    state = AgentState(replay_folders_override=[str(tmp_path / "explicit-missing")])
    cfg = SimpleNamespace(replay_folder=tmp_path / "env-missing")
    facts = HealthFacts(folders=tuple(str(tmp_path / str(index)) for index in range(100)))
    cell = SimpleNamespace(ui=SimpleNamespace(health=SimpleNamespace(facts=lambda: facts)))
    monkeypatch.setattr(runner, "detected_replay_folders", lambda *_args: (_ for _ in ()).throw(AssertionError("legacy discovery ran")))
    roots = runner._support_folder_provider(cfg, state, cell)()
    assert len(roots.paths) == 64 and roots.automatic_available and not roots.complete
    assert roots.paths[:2] == (tmp_path / "explicit-missing", tmp_path / "env-missing")
