"""Heartbeat facts are bounded, current and private; no real network or agent starts."""
import asyncio
from concurrent.futures import ThreadPoolExecutor
from dataclasses import replace
import inspect
import json
import logging
from pathlib import Path
import threading
from types import SimpleNamespace
from unittest.mock import Mock

import pytest

from sc2tools_agent import replay_pipeline, runner, watcher
from sc2tools_agent.health import HealthFacts, HealthMonitor
from sc2tools_agent.heartbeat import Heartbeat
from sc2tools_agent.sync_report import MAX_UNRESOLVED_PATHS, SKIP_REASONS, SyncReportTracker, report_size


def facts(**changes):
    return replace(HealthFacts(folders=("folder",)), **changes)


def test_current_markers_closed_reasons_and_optional_error_clear_after_success():
    tracker = SyncReportTracker()
    tracker.pending(2)
    markers = {str(i): f"skipped:{reason}" for i, reason in enumerate(SKIP_REASONS)}
    markers.update({"r": "rejected", "f": "filtered", "old": "2026-01-01T00:00:00Z", "unknown": "skipped:private_name", "legacy": "skipped"})
    tracker.upload_failed("offline")
    report = tracker.report(facts(pending=2, archive_pending=3, paused=True, missing_folders=("missing",)), markers)
    assert report["skipped"] == {reason: 1 for reason in SKIP_REASONS}
    assert report["lastErrorCode"] == "offline"
    assert (report["pending"], report["archivePending"], report["missingFolders"], report["filtered"], report["rejected"]) == (2, 3, 1, 1, 1)
    assert report["paused"] is True
    tracker.upload_succeeded()
    assert "lastErrorCode" not in tracker.report(facts(pending=2), markers)
    tracker.upload_failed("offline")
    assert "lastErrorCode" not in tracker.report(facts(pending=0), {})
    cleared = tracker.report(facts(), {})
    assert "skipped" not in cleared and cleared["rejected"] == cleared["filtered"] == 0


def test_legacy_filtered_markers_count_as_range_not_skip():
    report = SyncReportTracker().report(facts(), {"new": "filtered", "old": "skipped:filtered"})
    assert report["filtered"] == 2
    assert "skipped" not in report


def test_names_count_distinct_current_paths_not_retry_events():
    tracker = SyncReportTracker()
    entries = [("  Player  ", "1-S2-1-42"), ("Player", "1-S2-1-42")]
    for _ in range(8):
        tracker.unresolved("one", entries)
    assert "unresolvedNames" not in tracker.report(facts(), {"one": "skipped:player_unresolved"})
    for path in ("two", "three", "retired"):
        tracker.unresolved(path, entries)
    current = {path: "skipped:player_unresolved" for path in ("one", "two", "three")}
    assert tracker.report(facts(), current)["unresolvedNames"] == [{"name": "Player", "toonHandle": "1-S2-1-42", "count": 3}]
    current["three"] = "2026-01-01T00:00:00Z"
    assert "unresolvedNames" not in tracker.report(facts(), current)
    assert "unresolvedNames" not in tracker.report(facts(), {})


def test_top_ten_sort_and_diagnostics_drop_before_any_count():
    tracker = SyncReportTracker()
    markers = {}
    for person in range(12):
        for replay in range(person + 3):
            path = f"{person}:{replay}"
            markers[path] = "skipped:player_unresolved"
            tracker.unresolved(path, [(f"P{person}", f"1-S2-1-{person}")])
    report = tracker.report(facts(pending=999_999), markers)
    assert len(report["unresolvedNames"]) == 10
    assert [row["count"] for row in report["unresolvedNames"]] == list(range(14, 4, -1))
    assert report["skipped"]["player_unresolved"] == len(markers)
    assert report["pending"] == 999_999


def test_multibyte_long_handles_fit_default_requests_and_compact_utf8():
    tracker = SyncReportTracker()
    markers = {}
    for person in range(10):
        for replay in range(3):
            path = f"{person}:{replay}"
            markers[path] = "skipped:player_unresolved"
            tracker.unresolved(path, [("  " + "\U0001f680" * 40 + "  ", f"12345678-S2-123456789-{person:010}")])
    report = tracker.report(facts(pending=999_999, archive_pending=999_999), markers)
    # Long escaped Unicode exceeds the cap with10 rows; the report drops optional rows first.
    assert 0 < len(report["unresolvedNames"]) < 10
    assert report["unresolvedNames"][0]["name"] == "\U0001f680" * 16
    assert len(json.dumps(report).encode("utf-8")) == report_size(report) < 2048
    assert len(json.dumps(report, ensure_ascii=False, separators=(",", ":")).encode("utf-8")) < 2048
    assert report["pending"] == report["archivePending"] == 999_999
    assert report["skipped"]["player_unresolved"] == 30


@pytest.mark.parametrize("name,handle", [("bad\nname", "1-S2-1-42"), ("bad\u202ename", "1-S2-1-42"), ("\ud800", "1-S2-1-42"), ("ok", "not-toon"), (" ", "1-S2-1-42")])
def test_unsafe_names_never_reach_report(name, handle):
    tracker = SyncReportTracker()
    for path in ("a", "b", "c"):
        tracker.unresolved(path, [(name, handle)])
    assert "unresolvedNames" not in tracker.report(facts(), {path: "skipped:player_unresolved" for path in ("a", "b", "c")})


def test_capture_context_is_nested_thread_isolated_and_parser_signature_unchanged():
    signature = inspect.signature(replay_pipeline.parse_replay_for_cloud_ex)
    assert "on_unresolved" not in signature.parameters
    barrier = threading.Barrier(2)
    def capture(person):
        with replay_pipeline.capture_unresolved_candidates() as outer:
            barrier.wait(timeout=5)
            replay_pipeline._report_unresolved_candidates([SimpleNamespace(name=person, handle="1-S2-1-42")])
            with replay_pipeline.capture_unresolved_candidates() as inner:
                replay_pipeline._report_unresolved_candidates([SimpleNamespace(name="nested", handle="1-S2-1-43")])
            assert inner == [("nested", "1-S2-1-43")]
        return outer
    with ThreadPoolExecutor(max_workers=2) as pool:
        results = list(pool.map(capture, ("one", "two")))
    assert results == [[("one", "1-S2-1-42")], [("two", "1-S2-1-42")]]
    assert replay_pipeline._UNRESOLVED_SINK.get() is None
    with pytest.raises(ValueError), replay_pipeline.capture_unresolved_candidates():
        raise ValueError("synthetic")
    assert replay_pipeline._UNRESOLVED_SINK.get() is None


def test_worker_keeps_three_tuple_and_forwards_candidates(monkeypatch, tmp_path):
    monkeypatch.setattr(replay_pipeline, "bootstrap_analyzer_path", lambda: None)
    monkeypatch.setattr(watcher, "_wait_for_file_ready", lambda *_: True)
    monkeypatch.setattr(watcher, "_install_worker_log_handler", lambda *_: None)
    def parse(*_args, **_kwargs):
        replay_pipeline._report_unresolved_candidates([SimpleNamespace(name="Synthetic", handle="1-S2-1-42")])
        return None, "player_unresolved"
    monkeypatch.setattr(replay_pipeline, "parse_replay_for_cloud_ex", parse)
    result = watcher._parse_in_worker(str(tmp_path / "r.SC2Replay"), str(tmp_path))
    assert len(result) == 3 and result[0] == "skipped"
    assert result[2] == {"reason": "player_unresolved", "unresolved": [("Synthetic", "1-S2-1-42")]}
    assert replay_pipeline._UNRESOLVED_SINK.get() is None


def test_thread_parser_helper_does_not_change_parser_result_or_leak_scope():
    def parse():
        replay_pipeline._report_unresolved_candidates([SimpleNamespace(name="Synthetic", handle="1-S2-1-42")])
        return None, "player_unresolved"
    game, reason, candidates = watcher._parse_with_candidates(parse)
    assert (game, reason) == (None, "player_unresolved")
    assert candidates == [("Synthetic", "1-S2-1-42")]
    assert replay_pipeline._UNRESOLVED_SINK.get() is None


@pytest.mark.parametrize("mode", ["thread", "process"])
def test_both_watcher_modes_deliver_candidates_after_current_skip_marker(mode, monkeypatch, tmp_path):
    from concurrent.futures import Future
    tracker = SyncReportTracker()
    instance = watcher.ReplayWatcher.__new__(watcher.ReplayWatcher)
    instance._cfg = SimpleNamespace(state_dir=tmp_path)
    instance._state = SimpleNamespace(uploaded={})
    instance._analyzer_unavailable = False
    instance._process_crash_strikes = 0
    instance._clear_settle_failure = Mock()
    instance._finish_replay = Mock()
    instance._notify_skipped = Mock()
    def capture(path, entries):
        assert instance._state.uploaded[str(path)] == "skipped:player_unresolved"
        tracker.unresolved(path, entries)
    instance._on_unresolved = capture
    monkeypatch.setattr(watcher, "_wait_for_file_ready", lambda *_: True)
    def parse(*_args, **_kwargs):
        replay_pipeline._report_unresolved_candidates([SimpleNamespace(name="Synthetic", handle="1-S2-1-42")])
        return None, "player_unresolved"
    monkeypatch.setattr(watcher, "parse_replay_for_cloud_ex", parse)
    for number in range(3):
        path = tmp_path / f"{number}.SC2Replay"
        if mode == "thread":
            instance._handle_replay(path)
        else:
            future = Future()
            future.set_result(("skipped", str(path), {"reason": "player_unresolved", "unresolved": [("Synthetic", "1-S2-1-42")]}))
            instance._on_worker_done(future, str(path))
    assert tracker.report(facts(), instance._state.uploaded)["unresolvedNames"][0]["count"] == 3
    assert instance._finish_replay.call_count == 3


def test_provider_copies_state_under_lock_and_old_history_does_not_clear_error(tmp_path):
    class LockedMarkers(dict):
        def keys(self):
            assert runner._STATE_SAVE_LOCK._is_owned()
            return super().keys()
        def __iter__(self):
            assert runner._STATE_SAVE_LOCK._is_owned()
            return super().__iter__()
    monitor = HealthMonitor()
    ui = runner._Multiplexer(Mock(), health=monitor)
    ui.on_pending(3)
    ui.on_upload_failed("synthetic", SimpleNamespace(kind="offline", title="Offline", counts_as_error=True, transient=True))
    ui._push_recent({"facts": {"lastUploadAt": "2026-01-01T00:00:00Z"}})
    state = SimpleNamespace(uploaded=LockedMarkers({"x": "skipped:unsupported_replay"}), replay_folders_override=[str(tmp_path / "missing")])
    provider = runner._sync_report_provider(ui, state, SimpleNamespace(state_dir=tmp_path, replay_folder=None))
    first = provider()
    assert first["lastErrorCode"] == "offline" and first["missingFolders"] == 1
    assert first["skipped"] == {"unsupported_replay": 1}
    with runner._STATE_SAVE_LOCK:
        state.uploaded.clear()
    ui.on_upload_success("synthetic")
    second = provider()
    assert "lastErrorCode" not in second and "skipped" not in second
    assert first["skipped"] == {"unsupported_replay": 1}


def test_missing_explicit_root_does_not_count_as_watched(tmp_path):
    missing = tmp_path / "configured"
    ui = runner._Multiplexer(Mock(), health=HealthMonitor())
    ui.on_folders([missing])
    state = SimpleNamespace(uploaded={}, replay_folders_override=[])
    provider = runner._sync_report_provider(ui, state, SimpleNamespace(state_dir=tmp_path, replay_folder=missing))
    report = provider()
    assert (report["foldersWatched"], report["missingFolders"]) == (0, 1)
    assert ui.health.facts().folders == (str(missing),)
    missing.mkdir()
    report = provider()
    assert (report["foldersWatched"], report["missingFolders"]) == (1, 0)


def test_concurrent_candidate_updates_and_reports_are_consistent():
    tracker = SyncReportTracker()
    markers = {str(path): "skipped:player_unresolved" for path in range(100)}
    def write():
        for path in markers:
            tracker.unresolved(path, [("Synthetic", "1-S2-1-42")])
    with ThreadPoolExecutor(max_workers=2) as pool:
        running = pool.submit(write)
        for _ in range(100):
            report = tracker.report(facts(), markers)
            assert report_size(report) < 2048
            for name in report.get("unresolvedNames", ()):
                assert 3 <= name["count"] <= 100
        running.result(timeout=5)
    assert tracker.report(facts(), markers)["unresolvedNames"][0]["count"] == 100


def test_candidate_memory_is_capped_and_retirement_does_not_drop_new_capture():
    tracker = SyncReportTracker()
    for i in range(MAX_UNRESOLVED_PATHS + 20):
        tracker.unresolved(str(i), [("Synthetic", "1-S2-1-42")])
    assert len(tracker._unresolved) == MAX_UNRESOLVED_PATHS
    assert "0" not in tracker._unresolved
    generation = tracker.generation()
    tracker.unresolved("new", [("New", "1-S2-1-43")])
    tracker.report(facts(), {}, generation=generation)
    assert list(tracker._unresolved) == ["new"]
    tracker.report(facts(), {})
    assert not tracker._unresolved


def test_drained_queue_does_not_revive_old_error():
    ui = runner._Multiplexer(Mock(), health=HealthMonitor())
    ui.on_pending(2)
    ui.on_upload_failed("synthetic", SimpleNamespace(kind="file", title="File", counts_as_error=True, transient=True))
    assert ui.sync_report.report(ui.health.facts(), {})["lastErrorCode"] == "file"
    ui.on_pending(0)
    ui.on_pending(3)
    assert "lastErrorCode" not in ui.sync_report.report(ui.health.facts(), {})


def test_terminal_callback_after_drain_cannot_seed_new_queue_error():
    from sc2tools_agent.errors import UserError
    ui = runner._Multiplexer(Mock(), health=HealthMonitor())
    ui.on_pending(1)
    ui.on_pending(0)  # Actual terminal queue order publishes0 before failure.
    ui.on_upload_failed("old", UserError("rejected", "Rejected", "synthetic", "Review", False))
    ui.on_pending(3)
    assert "lastErrorCode" not in ui.sync_report.report(ui.health.facts(), {"old": "rejected"})
    # Even if unrelated work races in before that terminal callback, a
    # retired rejection is not an error of the new pending work.
    ui.on_upload_failed("old", UserError("rejected", "Rejected", "synthetic", "Review", False))
    assert "lastErrorCode" not in ui.sync_report.report(ui.health.facts(), {"old": "rejected"})
    ui.on_connection_state("offline", 1, 2, 3)
    assert ui.sync_report.report(ui.health.facts(), {})["lastErrorCode"] == "offline"
    ui.on_connection_state("online", 0, 0, 3)
    assert "lastErrorCode" not in ui.sync_report.report(ui.health.facts(), {})


def test_socket_health_survives_token_replacement_and_callback_failure():
    from sc2tools_agent.socket_client import SocketClient
    events = []
    class Sio:
        def __init__(self):
            self.handlers = {}
        def event(self, function):
            self.handlers[function.__name__] = function
            return function
        def on(self, name):
            def decorate(function):
                self.handlers[name] = function
                return function
            return decorate
    client = SocketClient(base_url="https://example.invalid", device_token="synthetic", on_recompute_games=lambda _: None,
        on_recompute_opp_build=lambda _: None, on_connection=events.append).with_device_token("replacement")
    client._sio = Sio()
    client._wire_handlers()
    asyncio.run(client._sio.handlers["connect"]())
    asyncio.run(client._sio.handlers["disconnect"]())
    assert events == [True, False]
    client._on_connection = Mock(side_effect=RuntimeError("synthetic"))
    asyncio.run(client._sio.handlers["connect"]())
    assert client._device_connected is True


def test_live_contact_repeats_on_valid_poll_without_phase_changes():
    from sc2tools_agent.live.client_api import LiveClientPoller
    from sc2tools_agent.live.event_bus import EventBus
    contact = Mock()
    response = Mock(status_code=200)
    response.json.return_value = {"activeScreens": []}
    poller = LiveClientPoller(EventBus(), session=SimpleNamespace(get=lambda *_args, **_kwargs: response), on_contact=contact)
    for _ in range(3):
        assert poller._fetch_ui() is not None
    assert contact.call_count == 3
    response.json.return_value = {"activeScreens": "bad"}
    assert poller._fetch_ui() is None and contact.call_count == 3
    response.json.return_value = {"activeScreens": []}
    contact.side_effect = RuntimeError("synthetic")
    assert poller._fetch_ui() is not None


def test_obs_health_follows_connect_auth_failure_recovery_and_disconnect():
    from sc2tools_agent.live.obs_client import ObsAuthFailed, ObsClient, ObsUnavailable
    raw = SimpleNamespace(get_scene_list=lambda: SimpleNamespace(scenes=[]), disconnect=Mock())
    states = []
    client = ObsClient(connect_factory=lambda **_: raw, subscribe_events=False, on_state=lambda connected, failed: states.append((connected, failed)))
    assert client._attempt_connect(raise_on_error=True) is True
    assert states[-1] == (True, False)
    client._record_connect_failure(ObsAuthFailed("synthetic"))
    assert states[-1] == (False, True)
    client.reconfigure(password="synthetic")
    assert states[-1] == (False, False)
    assert client._attempt_connect(raise_on_error=True) is True
    raw.get_scene_list = Mock(side_effect=RuntimeError("synthetic"))
    with pytest.raises(ObsUnavailable):
        client.refresh_scenes()
    assert states[-1] == (False, False)
    client._on_state = Mock(side_effect=RuntimeError("synthetic"))
    client.shutdown()


@pytest.mark.parametrize("source", ["cloud", "cache", "auto_detect", "none"])
def test_identity_resolution_reports_source_without_changing_result(source, monkeypatch, tmp_path):
    monkeypatch.setattr(runner, "refresh_player_handle", lambda *_: "Synthetic" if source == "cloud" else None)
    monkeypatch.setattr(runner, "read_player_handle_cache", lambda *_: "Synthetic" if source == "cache" else None)
    monkeypatch.setattr(runner, "auto_detect_from_replays", lambda *_: "Synthetic" if source == "auto_detect" else None)
    monkeypatch.setattr(runner, "write_player_handle_cache", lambda *_: None)
    monkeypatch.setattr(runner, "resolve_player_handle", lambda *_: None)
    callback = Mock()
    result = runner._ensure_player_handle(None, SimpleNamespace(state_dir=tmp_path), None, [], logging.getLogger("test"), on_source=callback)
    assert result == (None if source == "none" else "Synthetic")
    callback.assert_called_once_with(source)


def test_first_replay_cache_repair_retires_unknown_identity_on_refresh(tmp_path, monkeypatch):
    from sc2tools_agent.player_handle import write_cache
    monkeypatch.delenv("SC2TOOLS_PLAYER_HANDLE", raising=False)
    monkeypatch.delenv("SC2TOOLS_PLAYER_CONFIG", raising=False)
    ui = runner._Multiplexer(Mock(), health=HealthMonitor())
    ui.health.set_identity("none")
    runner._sync_report_provider(ui, SimpleNamespace(uploaded={}, replay_folders_override=[]), SimpleNamespace(state_dir=tmp_path, replay_folder=None))
    write_cache(tmp_path, "Synthetic")  # Same atomic cache write as toon-path repair.
    ui.refresh_status()
    assert ui.health.facts().identity_source == "cache"


def test_existing_environment_identity_is_known_at_boot(tmp_path, monkeypatch):
    monkeypatch.delenv("SC2TOOLS_PLAYER_CONFIG", raising=False)
    monkeypatch.setenv("SC2TOOLS_PLAYER_HANDLE", "Synthetic")
    monkeypatch.setattr(runner, "refresh_player_handle", lambda *_: None)
    monkeypatch.setattr(runner, "auto_detect_from_replays", lambda *_: None)
    callback = Mock()
    result = runner._ensure_player_handle(None, SimpleNamespace(state_dir=tmp_path), None, [], logging.getLogger("test"), on_source=callback)
    assert result == "Synthetic"
    callback.assert_called_once_with("environment")


def test_headless_add_folder_updates_shared_health(tmp_path, monkeypatch):
    from sc2tools_agent.state import AgentState
    state, ui = AgentState(), Mock()
    folder = tmp_path / "replays"
    folder.mkdir()
    cfg = SimpleNamespace(state_dir=tmp_path, replay_folder=None)
    monkeypatch.setattr(runner, "save_state", lambda *_: None)
    monkeypatch.setattr(runner, "detected_replay_folders", lambda *_: [])
    monkeypatch.setattr(runner, "_discover_replay_folders", lambda *_: [folder])
    runner._handle_choose_folder(cfg, state, folder, None, logging.getLogger("test"), upload=Mock(), ui=ui)
    ui.on_folders.assert_called_once_with([folder])


class Api:
    def __init__(self, response=None):
        self.response, self.bodies = response, []
    def _post(self, _path, *, auth, body):
        assert auth is True
        self.bodies.append(body)
        return self.response


def test_heartbeat_provider_and_rejected_advisory_are_isolated_and_logged_once(caplog):
    api, success, failure = Api({"syncAccepted": False}), Mock(), Mock()
    beat = Heartbeat(api, sync_provider=lambda: {"pending": 2}, on_success=success, on_failure=failure)
    with caplog.at_level(logging.WARNING):
        beat._send_one(); beat._send_one()
    assert [body["sync"] for body in api.bodies] == [{"pending": 2}] * 2
    assert success.call_count == 2 and not failure.called
    assert caplog.text.count("heartbeat_sync_rejected") == 1
    beat._sync_provider = Mock(side_effect=RuntimeError("do not log private details"))
    beat._send_one()
    assert "sync" not in api.bodies[-1] and success.call_count == 3 and not failure.called
    assert "private details" not in caplog.text


def test_heartbeat_rejects_oversize_or_unserializable_provider_and_old_apis_work():
    api = Api({"receivedAt": "synthetic"})
    beat = Heartbeat(api, sync_provider=lambda: {"unresolvedNames": ["\U0001f680" * 200]})
    beat._send_one()
    assert "sync" not in api.bodies[-1]
    beat._sync_provider = lambda: {"pending": float("nan")}
    beat._send_one()
    assert "sync" not in api.bodies[-1]
    beat._sync_provider = lambda: {"pending": 0}
    beat._send_one()
    assert api.bodies[-1]["sync"] == {"pending": 0}
