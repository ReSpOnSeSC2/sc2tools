"""Engine-update retries of skipped replays, and replays that can't be read right now."""
from concurrent.futures import Future
import inspect
import logging
import os
from pathlib import Path
from types import SimpleNamespace

import pytest

from sc2tools_agent import replay_files, runner, watcher as watcher_module
from sc2tools_agent.replay_files import TRANSIENT_WINERRORS, temporarily_unreadable, transient_os_error
from sc2tools_agent.skip_retry import ENGINE_RETRY_REASONS, release_engine_skips
from sc2tools_agent.state import AgentState, load_state
from tests.test_build_checkin_wiring import boot  # noqa: F401 - fixture
from tests.test_watcher_pool import watcher_factory  # noqa: F401 - fixture


def replay(tmp_path, name, *, age_days=3):
    path = tmp_path / name
    path.write_bytes(b"MPQ\x1a synthetic")
    stamp = path.stat().st_mtime - age_days * 86400
    os.utime(path, (stamp, stamp))
    return str(path)


class Busy(OSError):
    winerror = 32


class CloudOffline(OSError):
    winerror = 388


class Denied(OSError):
    winerror = 5


# ---------------- once per engine version ----------------


def test_each_version_releases_engine_skips_once_without_touching_files(tmp_path):
    parse, analysis, unsupported = (replay(tmp_path, f"{name}.SC2Replay") for name in ("parse", "analysis", "fmt"))
    gone = str(tmp_path / "offline-share" / "gone.SC2Replay")  # never checked: boot must not wait on it
    kept = {
        replay(tmp_path, "ai.SC2Replay"): "skipped:ai_game",
        replay(tmp_path, "who.SC2Replay"): "skipped:player_unresolved",
        replay(tmp_path, "old.SC2Replay"): "filtered",
        replay(tmp_path, "done.SC2Replay"): "2026-11-20T10:00:00Z",
        replay(tmp_path, "bad.SC2Replay"): "rejected",
    }
    state = AgentState(device_token="t", uploaded={parse: "skipped:parse_failed", analysis: "skipped:analysis_failed",
                                                    unsupported: "skipped:unsupported_replay",
                                                    gone: "skipped:parse_failed", **kept})
    assert set(ENGINE_RETRY_REASONS) == {"parse_failed", "analysis_failed", "unsupported_replay"}
    assert release_engine_skips(state, tmp_path, version="0.25.6") == 4
    assert state.uploaded == kept and state.skip_retry_version == "0.25.6"
    reloaded = load_state(tmp_path)
    assert reloaded.uploaded == kept and reloaded.skip_retry_version == "0.25.6"
    # The new engine still can't read one: it waits for the next version.
    state.uploaded[parse] = "skipped:parse_failed"
    assert release_engine_skips(state, tmp_path, version="0.25.6",
                                save=lambda *_: pytest.fail("Nothing to save twice")) == 0
    assert release_engine_skips(state, tmp_path, version="0.25.7") == 1 and parse not in state.uploaded


def test_a_failed_save_keeps_every_skip_and_retries_next_start(tmp_path):
    path = replay(tmp_path, "parse.SC2Replay")
    state = AgentState(uploaded={path: "skipped:parse_failed"}, skip_retry_version="0.25.5")

    def fail(*_args):
        raise OSError("disk full")

    with pytest.raises(OSError):
        release_engine_skips(state, tmp_path, version="0.25.6", save=fail)
    assert state.uploaded == {path: "skipped:parse_failed"} and state.skip_retry_version == "0.25.5"


def test_a_first_start_with_nothing_skipped_only_records_the_version(tmp_path):
    state = AgentState(uploaded={"done.SC2Replay": "2026-11-20T10:00:00Z"})
    saves = []
    assert release_engine_skips(state, tmp_path, version="0.25.6", save=lambda *_: saves.append(True)) == 0
    assert saves == [True] and state.skip_retry_version == "0.25.6"
    assert state.uploaded == {"done.SC2Replay": "2026-11-20T10:00:00Z"}


def test_runner_release_logs_and_never_blocks_boot(tmp_path, monkeypatch, caplog):
    path = replay(tmp_path, "parse.SC2Replay")
    state = AgentState(uploaded={path: "skipped:analysis_failed"})
    cfg = SimpleNamespace(state_dir=tmp_path)
    with caplog.at_level(logging.INFO):
        assert runner._release_engine_skips(cfg, state, logging.getLogger("test")) == 1
    assert f"engine_skip_retry released=1 version={runner.__version__}" in caplog.text
    monkeypatch.setattr(runner, "release_engine_skips", lambda *_a, **_k: 1 / 0)
    assert runner._release_engine_skips(cfg, state, logging.getLogger("test")) == 0
    assert "engine_skip_retry_failed" in caplog.text


def test_gui_boot_releases_skips_before_the_first_sweep(boot, monkeypatch):  # noqa: F811
    run, mocks, _bridge = boot
    order = []
    monkeypatch.setattr(runner, "_release_engine_skips", lambda *_args: order.append("release"))
    mocks["UploadQueue"].return_value.start.side_effect = lambda: order.append("upload")
    mocks["ReplayWatcher"].return_value.start.side_effect = lambda: order.append("watcher")
    run(no_live=True)
    assert order == ["release", "upload", "watcher"]


def test_headless_boot_releases_skips_before_the_first_sweep():
    source = inspect.getsource(runner._run_headless_runtime)
    assert source.index("_release_engine_skips(cfg, state, log)") < source.index("upload.start()") \
        < source.index("watcher.start()")


# ---------------- can't be read right now ----------------


def test_placeholders_and_files_in_use_are_temporary(tmp_path, monkeypatch):
    path = replay(tmp_path, "local.SC2Replay")
    assert temporarily_unreadable(path) is False
    assert temporarily_unreadable(tmp_path / "missing.SC2Replay") is False
    real_stat = os.stat
    for attribute in (0x400000, 0x40000, 0x1000):  # recall on data access / on open, offline
        monkeypatch.setattr(replay_files.os, "stat",
                            lambda target, attribute=attribute: SimpleNamespace(st_file_attributes=attribute | 0x20))
        monkeypatch.setattr("builtins.open", lambda *_a, **_k: pytest.fail("A placeholder is never downloaded"))
        assert temporarily_unreadable(path) is True
    monkeypatch.undo()
    for error, expected in ((Busy(13, "in use"), True), (CloudOffline(5, "offline"), True),
                            (Denied(13, "denied"), False), (OSError(22, "bad"), False)):
        monkeypatch.setattr("builtins.open", lambda *_a, error=error, **_k: (_ for _ in ()).throw(error))
        assert temporarily_unreadable(path) is expected
        monkeypatch.undo()
    monkeypatch.setattr(replay_files.os, "stat", lambda _target: (_ for _ in ()).throw(CloudOffline(5, "x")))
    assert temporarily_unreadable(path) is True
    monkeypatch.setattr(replay_files.os, "stat", lambda _target: SimpleNamespace())  # no attributes off Windows
    assert temporarily_unreadable(path) is False
    monkeypatch.setattr(replay_files.os, "stat", real_stat)
    assert transient_os_error(Busy(13, "x")) and not transient_os_error(ValueError("x"))
    assert {32, 33, 362, 388, 391} <= TRANSIENT_WINERRORS and not {2, 3, 5} & TRANSIENT_WINERRORS


def test_worker_reports_unavailable_instead_of_a_permanent_skip(tmp_path, monkeypatch):
    from sc2tools_agent import replay_pipeline

    path = replay(tmp_path, "cloud.SC2Replay")
    unreadable = {"value": True}
    monkeypatch.setattr(watcher_module, "_wait_for_file_ready", lambda *_: True)
    monkeypatch.setattr(watcher_module, "temporarily_unreadable", lambda _path: unreadable["value"])
    monkeypatch.setattr(replay_pipeline, "parse_replay_for_cloud_ex", lambda *_a, **_k: (None, "parse_failed"))
    assert watcher_module._parse_in_worker(path, "") == ("file_unavailable", path, "parse_failed")
    unreadable["value"] = False
    assert watcher_module._parse_in_worker(path, "") == ("skipped", path, "parse_failed")

    def explode(*_a, **_k):
        raise Busy(13, "in use")

    monkeypatch.setattr(replay_pipeline, "parse_replay_for_cloud_ex", explode)
    unreadable["value"] = True
    assert watcher_module._parse_in_worker(path, "") == ("file_unavailable", path, "analysis_failed")
    unreadable["value"] = False
    kind, _path, detail = watcher_module._parse_in_worker(path, "")
    assert kind == "analysis_failed" and detail.startswith("Busy")
    # Real skips never ask: an AI game is not a file problem.
    monkeypatch.setattr(replay_pipeline, "parse_replay_for_cloud_ex", lambda *_a, **_k: (None, "ai_game"))
    monkeypatch.setattr(watcher_module, "temporarily_unreadable", lambda _path: pytest.fail("not a read failure"))
    assert watcher_module._parse_in_worker(path, "") == ("skipped", path, "ai_game")


def finish(watcher, path, result):
    with watcher._inflight_lock:
        watcher._inflight.add(path)
    future = Future()
    future.set_result(result)
    watcher._on_worker_done(future, path)
    assert path not in watcher._inflight


def test_process_result_backs_off_then_records_the_skip_the_parse_produced(watcher_factory, monkeypatch):  # noqa: F811
    watcher = watcher_factory()
    path = str(watcher._cfg.state_dir / "cloud.SC2Replay")
    clock = {"now": 1000.0}
    monkeypatch.setattr(watcher_module.time, "monotonic", lambda: clock["now"])
    skipped = []
    watcher._notify_skipped = lambda replay_path, reason, ticket=None: skipped.append((str(replay_path), reason))
    delays = []
    for _attempt in range(3):
        finish(watcher, path, ("file_unavailable", path, "analysis_failed"))
        assert path not in watcher._test_state.uploaded and watcher._unavailable_waiting(path)
        delays.append(watcher._unavailable[path][1] - clock["now"])
        clock["now"] += delays[-1]
    assert delays == [60.0, 300.0, 900.0] and skipped == []
    finish(watcher, path, ("file_unavailable", path, "analysis_failed"))  # still unreadable after 21 min
    assert watcher._test_state.uploaded[path] == "skipped:analysis_failed" and path not in watcher._unavailable
    assert skipped == [(path, "analysis_failed")]
    other = str(watcher._cfg.state_dir / "broken.SC2Replay")
    finish(watcher, other, ("file_unavailable", other, "parse_failed"))
    finish(watcher, other, ("skipped", other, "parse_failed"))  # readable now, but genuinely broken
    assert watcher._test_state.uploaded[other] == "skipped:parse_failed" and other not in watcher._unavailable


def test_thread_path_leaves_unreadable_replays_unmarked(watcher_factory, monkeypatch, tmp_path):  # noqa: F811
    watcher = watcher_factory()
    path = Path(replay(tmp_path, "cloud.SC2Replay"))
    unreadable = {"value": True}
    outcome = {"value": (None, "parse_failed")}
    monkeypatch.setattr(watcher_module, "_wait_for_file_ready", lambda *_: True)
    monkeypatch.setattr(watcher_module, "temporarily_unreadable", lambda _path: unreadable["value"])

    def parse(*_a, **_k):
        if isinstance(outcome["value"], Exception):
            raise outcome["value"]
        return outcome["value"]

    monkeypatch.setattr(watcher_module, "parse_replay_for_cloud_ex", parse)
    watcher._handle_replay(path)
    assert str(path) not in watcher._test_state.uploaded and watcher._unavailable_waiting(str(path))
    outcome["value"] = CloudOffline(5, "offline")
    watcher._handle_replay(path)
    assert str(path) not in watcher._test_state.uploaded and watcher._unavailable[str(path)][0] == 2
    unreadable["value"] = False
    watcher._handle_replay(path)  # readable, still failing: a real analysis failure
    assert watcher._test_state.uploaded[str(path)] == "skipped:analysis_failed"
    assert str(path) not in watcher._unavailable
    locked = Path(replay(tmp_path, "locked.SC2Replay"))
    unreadable["value"], outcome["value"] = True, (None, "parse_failed")
    for _attempt in range(3):
        watcher._handle_replay(locked)
    assert str(locked) not in watcher._test_state.uploaded and watcher._unavailable[str(locked)][0] == 3
    watcher._handle_replay(locked)
    assert watcher._test_state.uploaded[str(locked)] == "skipped:parse_failed"


def test_inventory_waits_out_the_backoff_and_only_a_full_resync_clears_it(watcher_factory, monkeypatch, tmp_path):  # noqa: F811
    watcher = watcher_factory()
    root = tmp_path / "Multiplayer"
    root.mkdir()
    waiting, ready = Path(replay(root, "waiting.SC2Replay")), Path(replay(root, "ready.SC2Replay"))
    watcher._test_state.sync_filter_preset = "all"
    watcher._roots = [root]
    clock = {"now": 1000.0}
    monkeypatch.setattr(watcher_module.time, "monotonic", lambda: clock["now"])
    watcher._record_unavailable(waiting)

    def backlog():
        watcher._refresh_history_inventory()
        return sorted(path.name for path, _mtime in watcher._history_backlog)

    assert backlog() == ["ready.SC2Replay"]
    clock["now"] += 61
    assert backlog() == ["ready.SC2Replay", "waiting.SC2Replay"]
    watcher._record_unavailable(waiting)
    assert backlog() == ["ready.SC2Replay"]
    real_sweep, sweeps = watcher._sweep_once, []
    watcher._sweep_once = lambda: sweeps.append(True)  # never walk real folders here
    watcher.request_immediate_sweep()  # a filter save or one replay's Retry keeps the wait
    assert watcher._unavailable_waiting(str(waiting)) and backlog() == ["ready.SC2Replay"]
    watcher._sweep_once = real_sweep
    monkeypatch.setattr(watcher, "_background_held", lambda: False)
    monkeypatch.setattr(watcher, "_discover_roots", lambda: [root])
    monkeypatch.setattr(watcher, "_refresh_history_inventory", lambda: None)
    monkeypatch.setattr(watcher, "_drain_history_inventory", lambda: None)
    watcher._test_upload._resync = True  # a full Re-sync tries every file at once
    watcher._sweep_once()
    assert watcher._unavailable == {} and not watcher._test_upload._resync
